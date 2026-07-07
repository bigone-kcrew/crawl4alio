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
| kordoc | HWP/HWPX/PDF/XLSX/DOCX → Markdown 1차 변환 | 3400 | 자체 HWP 파서(`pyhwp`, `hwp5html` 등) 위에 이 API 스펙(`POST /parse`, multipart `file`, 응답 `{ result: { markdown } }`)으로 래핑 |
| markitdown | kordoc 실패 시 2차 폴백 | 3410 | [microsoft/markitdown](https://github.com/microsoft/markitdown)을 같은 API 스펙으로 서버화 |
| PaddleOCR | 스캔 PDF/이미지 OCR 최종 폴백 | 13430 | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 서버, 응답에 `result.markdown` 포함 |
| Crawl4AI | ALIO 상세페이지 크롤링(수집 단계) | 11235 | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) Docker 이미지 그대로 사용 가능 |

파서 서버 응답 규격은 공통으로 `{ ok: boolean, result: { markdown: string }, error?: { code, message } }` 형태를 기대합니다. 직접 파서를 붙일 경우 이 규격에 맞추면 코드 수정 없이 연동됩니다.

## 2. 메인 변환 — `convert_to_markdown.js`

- 입력: `build_download_file_index.js`가 생성한 `2_data/structured_data/download_files_index.json`
- kordoc → markitdown 순으로 시도. 확장자별 라우팅은 스크립트 상단 `ROUTING` 상수 참고.
- 변환 성공 시 YAML frontmatter(기관명·부처·연도·출처URL·파서명 등)를 붙여 원본 파일 옆에 `.md`로 저장.
- 스캔 PDF 등으로 텍스트 추출이 사실상 안 되는 경우(`IMAGE_BASED_PDF` 에러, 20자 미만 결과 등) `ocr_needed`로 분류해 `2_data/logs/ocr_needed.json`에 기록.
- 체크포인트(`2_data/logs/conversion_checkpoint.json`) 기반으로 재시작 가능. 파일 크기 기준으로 일반/대형 큐를 나눠 동시성을 다르게 적용.
- 단일 실행 보장을 위한 락 파일(`2_data/logs/convert_main.lock`), stale lock 자동 감지.

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
