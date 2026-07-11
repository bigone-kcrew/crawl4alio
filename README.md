# crawl4alio

**GitHub**: https://github.com/bigone-kcrew/crawl4alio

공공기관 경영정보 공개시스템([ALIO](https://www.alio.go.kr))과 국가법령정보([law.go.kr](https://www.law.go.kr)), 기관 내부규정 게시판을 수집하고, 첨부파일(HWP/PDF/XLSX 등)을 Markdown으로 변환하는 Node.js 도구 모음입니다.

> 이 저장소는 **수집·변환 방법론(코드)만 배포**합니다. 실제로 수집된 데이터(경영공시 첨부파일, 법령 원문, 기관 내규 등)는 포함하지 않습니다. 각자 환경에서 직접 수집해서 사용하세요.

## 무엇을 할 수 있나요

1. **ALIO 경영공시 수집** — 355개 공공기관 × 전체 92개 공시항목(정기/수시 자동 구분). 공시항목(`--scope all|--categories|--items`)과 기관(`--ministry|--apba-ids|--inst-type`)을 자유롭게 선택. 본문 가치 없는 문서첨부형 항목은 `--attach-only-items`로 crawl4ai 스킵(첨부만 수집, 대량 항목 대폭 가속)
2. **게시판형 공시 수집** — 일반 다운로더가 스킵하는 게시판형(disclosureNo 없음) 항목 전담(`collect_board_disclosures.js`): **국회 지적사항(B1210)·감사원 등 지적(B1220)**은 본문(`내용.md`)+첨부, **경영평가결과(B1230/B1250)**는 첨부 수집
3. **증분 동기화** — 저장본과 웹 최신본을 대조해 신규·누락 공시만 수집 (`sync_alio.js`: 반자동 report / 자동 apply, `sync_legal.js`: 법령 개정 감지). 다운로더는 disclosureNo **report 체크포인트**로 raw를 오프사이트로 옮겨 삭제한 뒤에도 증분 수집 가능
4. **법령·행정규칙 수집** — law.go.kr Open API(DRF)로 본문+**별표·서식(붙임)** 구조화 수집, 검색 기반 법령 추가(`add_legal_source.js`), 그 외 부처 지침은 크롤링+변환
5. **기관 내부규정 수집** — ALIO `21110` 게시판에서 기관별 규정 수집 (최신본 또는 `--all-files`로 개정 이력 전체)
6. **Markdown 변환 파이프라인** — HWP/PDF/XLSX/DOCX 등을 kordoc → markitdown → PaddleOCR(스캔 문서) 순으로 폴백하며 변환. ZIP 자동 해제(`extract_zips.js`), raw/md 미러 출력(`--md-root`) 지원

## 아키텍처

```mermaid
flowchart LR
    A["ALIO 상세페이지"] --> B["Crawl4AI"]
    B --> C["원문·첨부파일"]
    C --> D["kordoc"]
    D -->|실패 시| E["markitdown"]
    E -->|OCR 필요 시| F["PaddleOCR"]
    D --> G["기관별 Markdown"]
    E --> G
    F --> G
```

수집은 **Crawl4AI**가 담당합니다. ALIO 상세페이지의 본문, 표, 첨부파일을 가져와 `content.json`, `content.md`, 원본 첨부파일 형태로 정리합니다.

문서 변환은 **kordoc → markitdown → PaddleOCR** 순서의 fallback 체인으로 처리합니다. `kordoc`은 HWP/HWPX/PDF/XLSX/DOCX 변환을 담당하며, `markitdown`은 kordoc 변환 실패 시 보조 변환을 수행하고, `PaddleOCR`은 스캔 PDF처럼 텍스트 추출이 어려운 문서를 OCR로 보정합니다.

최종 산출물은 기관별 Markdown 파일입니다. 이후 저장본 비교, 신규·누락 공시 탐지, 법령·행정규칙 동기화, 검색 기반 분석에 활용됩니다.

- **kordoc**(https://github.com/chrisryugj/kordoc)은 npm 의존성으로 **내장**되어 서버 없이 동작합니다 (HWP3/5·HWPX·PDF·XLS(X)·DOCX).
- **Crawl4AI**(ALIO 본문 표)와 **PaddleOCR**(스캔 PDF)은 외부 서비스로, 풀스택 프로필의 docker compose에 포함되어 있습니다.

## 성능·안정성 (v1.2~1.3)

대규모 수집(수만 report·수십만 첨부) 실전에서 다듬은 사항:

- **병렬화 + 전역 요청 상한**: 채용은 게시글/파일 병렬, 다운로더는 report당 호출·첨부 병렬. 실제 서버 요청은 전역 세마포어로 상한(중첩 곱셈 방지). 대량 수집은 기관 샤딩(`--apba-ids` 분할 다중 프로세스)으로 병렬, 이때 `SKIP_STRUCTURED_INDEX=1`로 공유 인덱스 race 회피.
- **첨부전용 모드**(`--attach-only-items`): 본문이 메타데이터뿐인 문서첨부형 항목(이사회·감사보고서 등)은 crawl4ai를 건너뛰고 첨부만 수집 → crawl4ai 병목 대폭 완화. 본문 유무는 항목별로 실측 판단 필요(재무제표처럼 본문 표가 있는 항목은 유지).
- **report 체크포인트**(`data/logs/download_ckpt.json`): disclosureNo 기준으로 이미 수집한 report를 raw 유무와 무관하게 스킵 → raw 오프사이트 아카이브 후 로컬 삭제해도 증분 수집. `--recheck`로 강제 재처리, `--ckpt`로 경로 지정. 채용/게시판은 이미 posting-level 체크포인트(`formNo:apbaId:idx`+idate).
- **안정성 수정**: 체크포인트 atomic write(tmp→rename) race 방지 / 게시판형(disclosureNo=0000) 목록이 기관당 1건으로 접히던 dedup 버그(→ `disclosureNo|idx` 키) / 긴 한글 파일명 ENAMETOOLONG(바이트 절단 + 단건 오류 격리) / alio keep-alive 종료 socket hang up 재시도(Connection: close).

> **참고**: ALIO 상세 데이터(감사·이사회·재무 등 대부분)는 여전히 crawl4ai로 수집합니다. `opendata.alio.go.kr` / data.go.kr 오픈API는 채용·시설·사업·기관 4종 정보만 제공하므로 전체 공시 대체가 되지 않습니다.

## 설치 프로필

| | 최소 프로필 | 풀스택 프로필 (권장, N100급 미니PC~) |
|---|---|---|
| 요구사항 | Node 18+ | Node 18+ + Docker |
| 설치 | `npm install` | `npm install` + `cd deploy && docker compose up -d` |
| 수집 (ALIO 첨부·법령·내규·통계·동기화) | ✅ | ✅ |
| HWP/PDF/DOCX/XLS(X) → MD 변환 | ✅ (kordoc 내장) | ✅ |
| 스캔 PDF OCR (~45% 분량) | ❌ `ocr_needed` 큐 대기 | ✅ PaddleOCR 컨테이너 |
| ALIO 공시 본문 표 수집 | ❌ 스킵 | ✅ Crawl4AI 컨테이너 |
| 파서 직접 연결 | [docs/PARSERS.md](docs/PARSERS.md)의 `/parse` 계약 | — |

풀스택 프로필은 **단일 머신 기준**이며 권장 최소 사양은 Intel N100급(4코어/8GB RAM) — 최근 보급형 PC·미니PC면 충분합니다. 초기 대량 스캔 PDF OCR만 CPU 모드 특성상 시간이 걸릴 수 있으나(백그라운드 배치로 처리), 이후 증분 운영에는 여유가 있습니다. Docker 설치부터 cron 자동화까지의 전체 절차는 **[docs/INSTALL.md](docs/INSTALL.md)** 를 따라가세요.

> **AI 지원 설치**: 이 저장소를 Claude Code 등 AI 코딩 에이전트에 열면 [CLAUDE.md](CLAUDE.md)의 가이드에 따라 환경 진단부터 설치·검증까지 도와줍니다.

## 빠른 시작

```bash
npm install
cp .env.example .env.api    # law.go.kr API 키 등 입력
source .env.api

node collection/check_services.js   # 환경 진단 — 활성 기능 확인

# (풀스택) 파서 스택 기동
cd deploy && docker compose up -d && cd ..

# 1. ALIO 경영공시 수집 — 항목·기관 선택 가능
node collection/download_documents_advanced.js --print-scope          # 수집 범위 미리보기
node collection/download_documents_advanced.js --categories 노동조합   # 예: 노동조합 관련 항목만
node collection/download_documents_advanced.js --items 43005,43006 --attach-only-items 43005,43006  # 이사회·감사(문서첨부형): crawl4ai 스킵
npm run collect:alio                                                  # yaml 설정 기준

# 1-2. 게시판형 공시(국회/감사원 지적·경영평가) — 일반 다운로더가 스킵하는 항목
node collection/collect_board_disclosures.js --forms B1210,B1220,B1230 --years 3

# 2. 파일 인덱스 → Markdown 변환 → (스캔 문서) OCR
npm run build:file-index
npm run convert:markdown
npm run convert:ocr

# 3. 이후 일상 운영: 증분 동기화
npm run sync:alio                    # 신규 공시 감지 (리포트)
node collection/sync_alio.js --mode=apply   # 감지 즉시 자동 수집
```

### 데이터 폴더 분리 운영 (v1.3.1)

```bash
# CATALOG_ROOT: 데이터 카탈로그 루트 지정 — 수집물·인덱스·로그·체크포인트가 전부 이 아래로.
# 심링크 없이 저장소(코드)와 데이터 폴더를 분리 운영. 미지정 시 저장소 내 data/ (기존 동작).
CATALOG_ROOT=/path/to/data node collection/download_documents_advanced.js ...

# raw/md 트리 분리 시(원본=alio-raw, 변환·메타=alio-md):
#  - structured_data가 alio-md를 가리키면 원본 경로는 자동으로 alio-raw 미러로 해석
#  - 명시 지정: ALIO_RAW_BASE(수집), --raw-root / --md-root(변환)

# 원본(raw) 오프사이트 보관 후 증분: report 체크포인트가 디스크 유무와 무관하게 기수집을 스킵.
node collection/seed_download_ckpt.js   # 기수집 manifest에서 체크포인트 백필(1회)
```

더 자세한 사용법은 [docs/COLLECTION.md](docs/COLLECTION.md), [docs/CONVERSION.md](docs/CONVERSION.md), [docs/PARSERS.md](docs/PARSERS.md)를 참고하세요.

## 폴더 구조

```
crawl4alio/
├── collection/                  # 수집·변환 스크립트
│   ├── download_documents_advanced.js   # ALIO 경영공시 메인 크롤러 (첨부전용·report 체크포인트)
│   ├── collect_board_disclosures.js     # 게시판형 공시 수집 (국회/감사원 지적·경영평가)
│   ├── collect_recruit_attachments.js   # 채용공고 첨부 수집 (게시글/파일 병렬)
│   ├── rebuild_recruit_checkpoint.js    # 파일시스템 기반 채용 체크포인트 복구
│   ├── download_statistics.js           # ALIO 통계 엑셀 다운로드
│   ├── check_disclosure_recency.js      # 신규 공시 모니터링
│   ├── download_susi_documents.js       # 수시공시 수집
│   ├── collect_legal_corpus.js          # 법령·지침 corpus 수집기
│   ├── enrich_legal_ministry.js         # law.go.kr DRF로 소관부처 보강
│   ├── collect_institution_bylaws.js    # 기관 내부규정 게시판 수집
│   ├── convert_to_markdown.js           # kordoc→markitdown 변환 (체크포인트/동시성)
│   ├── convert_ocr_needed.js            # PaddleOCR 변환 (스캔 문서)
│   ├── convert_reference_docs.js        # 범용 참고문서 변환 (법령/내규 공용)
│   ├── build_download_file_index.js     # manifest → 다운로드 파일 인덱스 안전 병합
│   ├── process_statistics.js / convert_statistics_to_md.js / build_statistics_index.js
│   └── project/crawler/
│       ├── config/crawl_targets.yaml    # 수집 대상 공시코드·연도 설정
│       └── utils/                       # 크롤러 공용 유틸(경로, 로깅, 첨부추출 등)
├── ocrtomarkdown/                # PaddleOCR 응답을 .md로 저장하는 독립 CLI
├── data/
│   ├── institutions.json        # ALIO 355개 공공기관 목록 (공개 정보, 시드 데이터)
│   └── disclosure_items.json    # ALIO 공시항목 코드 체계 (공개 정보, 시드 데이터)
├── docs/
├── .env.example
├── package.json
└── LICENSE
```

`data/` 하위의 수집 결과물(`structured_data/`, `legal-md/`, `institution-bylaws*/`, `logs/`)은 `.gitignore` 처리되어 있습니다 — 직접 실행해서 채우세요.

## 기수집 데이터 문의

이 저장소는 코드만 배포하며 실제 수집 결과물은 포함하지 않습니다(위 이유 참고).
2026-07-01 기준으로 수집·변환된 자료가 필요하신 분은 **bigone@k-union.kr** 로 문의해 주세요.
개인정보·기관 내부용 자료는 제외하고 필요 범위에 맞춰 안내드립니다.

## 법적/윤리적 참고사항

- ALIO·law.go.kr 데이터는 공공누리(공공저작물) 또는 공공데이터법에 따라 공개된 정보입니다. 각 사이트의 이용약관과 저작권 표시 규정을 확인하세요.
- law.go.kr Open API는 사전에 [이용자 등록](https://open.law.go.kr)이 필요하며, 발급받은 ID를 본인 명의로만 사용하세요.
- 과도한 동시 요청은 대상 서버에 부담을 줄 수 있습니다. 기본 동시성 설정(`CONCURRENT` 등)과 `random_delay` 설정을 참고해 매너 있게 수집하세요.
- 기관 내부규정 등 제3자 문서를 재배포할 때는 해당 기관의 공개 범위와 저작권을 확인하세요.

## 라이선스

MIT License. [LICENSE](LICENSE) 참고. 연동하는 제3자 오픈소스 도구(kordoc·PaddleOCR·Crawl4AI·MarkItDown)의 라이선스는 [NOTICE.md](NOTICE.md)를 참고하세요.
