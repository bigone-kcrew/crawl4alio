# 변환 방법 (Conversion)

수집된 첨부파일(HWP/HWPX/PDF/XLSX/DOCX/XLS/PPTX)을 Markdown으로 바꾸는 3단계 폴백 파이프라인입니다.

```
확장자별 라우팅
  hwp/hwpx/hwpml/pdf/xlsx/docx  →  kordoc  →(실패)→  markitdown
  xls/pptx                      →  markitdown 전용

kordoc/markitdown 모두 실패 또는 "빈 내용"으로 판정
  →  ocr_needed로 분류  →  PaddleOCR로 재처리
```

## 1. 필요한 외부 서비스

이 저장소는 변환 로직(호출·폴백·재시도·체크포인트)만 제공하며, 실제 파서 서버는 별도로 준비해야 합니다.

| 서비스 | 역할 | 기본 포트(예시) | 대체 가능 오픈소스 |
|---|---|---|---|
| kordoc | HWP/HWPX/PDF/XLSX/DOCX → Markdown 1차 변환 | 3400 | [chrisryugj/kordoc](https://github.com/chrisryugj/kordoc) (`POST /parse`, multipart `file`, 응답 `{ result: { markdown } }`) |
| markitdown | kordoc 실패 시 2차 폴백 | 3410 | [microsoft/markitdown](https://github.com/microsoft/markitdown)을 같은 API 스펙으로 서버화 |
| PaddleOCR | 스캔 PDF/이미지 OCR 최종 폴백 | 13430 | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 서버, 응답에 `result.markdown` 포함 |
| Crawl4AI | ALIO 상세페이지 크롤링(수집 단계) | 11235 | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) Docker 이미지 그대로 사용 가능 |

파서 서버 응답 규격은 공통으로 `{ ok: boolean, result: { markdown: string }, error?: { code, message } }` 형태를 기대합니다. 직접 파서를 붙일 경우 이 규격에 맞추면 코드 수정 없이 연동됩니다.

## 1-1. raw/md 저장 규약

| 코퍼스 | raw(원본) | md(변환본) | 분리 방식 |
|---|---|---|---|
| ALIO 공시 | `data/structured_data/` | 기본: 원본 옆 `.md` / `--md-root` 지정 시 미러 트리 | 선택형 |
| 법령 | `data/legal-raw/` (DRF JSON·별표 파일 포함) | `data/legal-md/` | 수집 시 미러 |
| 기관 내규 | `data/institution-bylaws-raw/` | `data/institution-bylaws-md/` | 수집·변환 시 미러 |

ALIO 공시를 raw/md 분리 배포하려면:

```bash
node collection/convert_to_markdown.js --md-root data/alio-md
# 또는 MD_MIRROR_ROOT=data/alio-md node collection/convert_to_markdown.js
```

미러 모드는 `structured_data`와 동일한 `[부처]기관명_코드/SCD_항목명/연도/` 구조로 `.md`만 출력합니다. 미지정 시 기존 동작(원본 옆 저장)이며, 체크포인트에 출력 경로가 기록되므로 재실행해도 안전합니다.

## 2. 메인 변환 — `convert_to_markdown.js`

- 입력: `build_download_file_index.js`가 생성한 `data/structured_data/download_files_index.json`
- kordoc → markitdown 순으로 시도. 확장자별 라우팅은 스크립트 상단 `ROUTING` 상수 참고.
- 변환 성공 시 YAML frontmatter(기관명·부처·연도·출처URL·파서명 등)를 붙여 원본 파일 옆에 `.md`로 저장(`--md-root` 시 미러 트리).
- 스캔 PDF 등으로 텍스트 추출이 사실상 안 되는 경우(`IMAGE_BASED_PDF` 에러, 20자 미만 결과 등) `ocr_needed`로 분류해 `data/logs/ocr_needed.json`에 기록.
- 체크포인트(`data/logs/conversion_checkpoint.json`) 기반으로 재시작 가능. 파일 크기 기준으로 일반/대형 큐를 나눠 동시성을 다르게 적용.
- 단일 실행 보장을 위한 락 파일(`data/logs/convert_main.lock`), stale lock 자동 감지.

```bash
node collection/convert_to_markdown.js --dry-run       # 실제 변환 없이 라우팅만 확인
CONCURRENT=8 node collection/convert_to_markdown.js
node collection/convert_to_markdown.js --reset-checkpoint
```

## 3. OCR 폴백 — `convert_ocr_needed.js`

- 입력: `ocr_needed.json`
- **파일 크기/페이지 수 기준 내림차순 정렬**(`score = max(MB×60, pages×20)`)로 큰 파일부터 처리 — 오래 걸리는 작업을 먼저 큐에 넣어 전체 처리 시간을 줄이는 전략입니다.
- 소켓 끊김 등 재시도 가능한 실패는 재시작 시 자동으로 리셋됩니다.
- 배치 완료 후 결과를 메인 체크포인트(`conversion_checkpoint.json`)에 자동 병합합니다.
- `--refresh`: `conversion_checkpoint.json`에서 `ocr_needed.json`을 강제로 다시 생성합니다(메인 변환을 추가로 더 돌린 뒤 사용).

```bash
node collection/convert_ocr_needed.js
node collection/convert_ocr_needed.js --refresh
```

> **PDF는 kordoc 단독**(markitdown은 스캔에서 hang되어 pdf 미사용). 대형 텍스트PDF(감사보고서 등 100p+)는 추출에 수십초 걸리므로 `KORDOC_PDF_TIMEOUT_MS`(기본 300s)로 넉넉히 잡습니다 — 짧으면 타임아웃→OCR로 오이관됩니다.

## 3-1. OCR 큐 텍스트PDF 회수 — `recover_ocr_text_pdfs.js`

`ocr_needed`에 들어갔지만 실제로는 **텍스트 내장 PDF**(하이브리드 포함, 순수 스캔 아님)를 kordoc으로 재추출해 OCR 없이 복구합니다. kordoc은 OCR보다 품질↑·속도↑(대형 감사보고서: OCR 수십분 → kordoc 수십초). 초기 변환의 짧은 타임아웃 등으로 오이관된 문서를, **정기 증분 수집 후 OCR 돌리기 전에** 한 번 돌리면 OCR 부하를 크게 줄입니다.

- 대상: `reason`이 `timeout`/`aborted`/`low_quality`이고 텍스트연산(BT/Tj)이 있는 PDF, 미완료.
  - **하이브리드(텍스트+이미지)도 포함**한다. 실측(회수 542건 분석)상 **원인의 91%가 kordoc 타임아웃**이고, **회수분의 58%가 이미지 다수(img>2) 하이브리드**였다 — "이미지 적은 것만" 좁게 거르면 절반 이상을 놓친다.
  - `empty_content`(폰트/ToUnicode 부재)는 kordoc·OCR 모두 빈결과라 제외.
- **품질 게이트**: 하이브리드를 넓게 받으므로, kordoc이 부분추출한 진짜 스캔은 페이지당 글자수(다중 100자/p·1p 70자) 미만이면 OCR에 남긴다(품질 퇴행 방지). 실측 잔여의 low_quality는 대개 27~55자/p 스캔이라 게이트가 정확히 OCR로 유지.
  - 페이지 수는 `/Type /Page` 카운트가 기본이지만, **압축 오브젝트스트림(/ObjStm) PDF는 이 마커가 압축돼 1페이지로 오인**됩니다(45p 스캔본 1,278자가 게이트를 통과해버린 실사례). regex가 1p 이하 + /ObjStm 존재면 pdf-lib로 정확히 재계산하고, 끝내 불명이면 회수를 포기(OCR 유지, 안전측)합니다.
- 성공 시 `alio-md`에 `.md` 기록 + 체크포인트 `kordoc_recovery`로 success → OCR이 DEDUP 스킵(중복 처리 없음).
  - 체크포인트는 건마다 통째 저장하지 않고 `RECOVER_FLUSH_EVERY`(기본 20)건마다·종료 시 배치 저장합니다 — 67MB급 JSON을 수백 번 rewrite하는 I/O 부하(NAS 다운의 유력 원인이었음)를 없앤 것.
- **kordoc 우선 강제(`kordoc_pending.json`)**: 회수와 OCR을 병행하면 OCR이 kordoc 적격 문서를 먼저 잡아버리는 race가 생깁니다(실측 711건). 회수가 판정 전 대상 id를 `kordoc_pending.json`에 기록하면 `convert_ocr_needed.js`가 그 id를 큐에서 제외 — kordoc이 판정(성공/LOW/실패)한 것만 OCR로 방출됩니다. 파일의 `updated`가 12h(`KORDOC_PENDING_TTL_H`)보다 오래되면 비정상종료 잔재로 보고 무시합니다.
- **`--reprocess`**: race 등으로 이미 OCR 처리된 텍스트PDF를 kordoc으로 재추출해, 품질 게이트 통과 시 `.md`를 교체(업그레이드)합니다. 회수 패스가 끝난 뒤 단독으로 돌리세요.
- **타임아웃 예방과 병행**: 회수는 백스톱이고, 근본 예방은 초기 변환의 `KORDOC_PDF_TIMEOUT_MS`(기본 300s)다. 둘을 함께 두면 다음 증분엔 대형 텍스트/하이브리드 PDF가 애초에 OCR로 새지 않는다.

```bash
node collection/recover_ocr_text_pdfs.js --dry-run       # 대상 확인
node collection/recover_ocr_text_pdfs.js                 # 회수 실행
node collection/recover_ocr_text_pdfs.js --reprocess     # 이미 OCR된 텍스트PDF를 kordoc으로 교체
# env: KORDOC_PARSE_URL, RECOVER_TIMEOUT_MS(300000), RECOVER_REASON_RE,
#      RECOVER_MIN_CHARS_PER_PAGE(100), RECOVER_MIN_CHARS_1P(70), RECOVER_FLUSH_EVERY(20)
```

## 4. 범용 참고문서 변환 — `convert_reference_docs.js`

법령·기관내규처럼 "raw 폴더 → md 폴더"로 통째로 미러 변환할 때 쓰는 재사용 스크립트입니다. 체크포인트 없이 폴더를 순회하며 이미 변환된 파일은 건너뜁니다.

```bash
node collection/convert_reference_docs.js --src ./raw/법령자료 --dest ./md/법령자료
node collection/convert_reference_docs.js --dry
node collection/convert_reference_docs.js --force
```

## 5. 독립 CLI — `ocrtomarkdown/`

PaddleOCR 응답의 `result.markdown`만 뽑아 원본 파일 옆에 `.md`로 저장하는 범용 도구입니다. 이 프로젝트의 다른 스크립트와 무관하게 단일 파일/디렉터리에 바로 쓸 수 있습니다.

```bash
node ocrtomarkdown/ocr-to-markdown.js ./input.pdf
node ocrtomarkdown/ocr-to-markdown.js ./input_dir --no-frontmatter
```

## 6. 통계 데이터 변환

```
download_statistics.js(엑셀 다운로드) → process_statistics.js(JSON) → convert_statistics_to_md.js(Markdown 표) → build_statistics_index.js(통합 인덱스)
```
