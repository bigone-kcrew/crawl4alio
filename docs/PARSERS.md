# 파서 규격 (최소 프로필용)

파서를 직접 운영하거나 원격 서버로 연결하는 **최소 프로필** 사용자를 위한 기술 명세입니다.
풀스택 프로필(docker compose)을 쓰면 이 문서 없이도 동작합니다 — [deploy/docker-compose.yml](../deploy/docker-compose.yml) 참조.

## 파서 개요와 연결 방법

| 파서 | 역할 | 기본 연결 | 환경변수 |
|---|---|---|---|
| **kordoc** | HWP3/5·HWPX·HWPML·PDF·XLS(X)·DOCX → MD (1차) | **내장 npm (서버 불필요)** | `KORDOC_PARSE_URL` 설정 시 HTTP 모드 |
| **kordoc (OCR)** | 스캔 PDF/이미지 OCR (**기본 엔진**, kordoc 4.2 `--ocr`) | `--ocr` 활성 HTTP 서버 필요 | `OCR_ENGINE=kordoc`(기본) · `KORDOC_PARSE_URL`/`OCR_PARSE_URL` |
| PaddleOCR | 스캔 PDF/이미지 OCR (**legacy/optional** 폴백) | HTTP 서버 필수 | `OCR_ENGINE=paddleocr` · `PADDLEOCR_PARSE_URL` |
| **Crawl4AI** | ALIO 상세페이지(JS 렌더링) 크롤 | HTTP 서버 필수 | `CRAWL4AI_URL`, `CRAWL4AI_HOST`, `CRAWL4AI_API_TOKEN` |
| markitdown | 선택 폴백 (pptx 등) | 미설정 시 건너뜀 | `MARKITDOWN_PARSE_URL` |

연결 상태는 `node collection/check_services.js`로 언제든 확인할 수 있습니다.

## /parse 공통 API 계약

kordoc(HTTP 모드)·PaddleOCR·markitdown 파서는 동일한 계약을 따릅니다.
자체 파서를 붙일 때 이 계약만 맞추면 코드 수정 없이 연동됩니다.

**요청**
```
POST /parse
Content-Type: multipart/form-data
필드: file (파일 바이너리, 파일명 포함)
```

**응답 (성공)**
```json
{ "ok": true, "result": { "markdown": "변환된 마크다운" } }
```

**응답 (실패)** — HTTP 상태와 무관하게 본문 JSON의 `ok`로 판정 (500이어도 본문 파싱)
```json
{ "ok": false, "error": { "code": "PARSE_FAILED", "message": "..." } }
```

**OCR 분기 에러코드** — `convert_to_markdown.js`는 아래 코드/메시지 패턴을 보면
markitdown 폴백을 건너뛰고 해당 파일을 `ocr_needed`로 분류합니다:
```
IMAGE_BASED_PDF · Jbig2Error · JBig2 · 이미지 기반 PDF
```
또한 변환 결과가 20자 미만이면 `empty_content`로 간주해 역시 OCR 대상으로 분류합니다
(스캔 PDF에서 kordoc이 빈 markdown을 반환하는 경우가 여기에 해당).

**PaddleOCR 추가 관례** — PDF 페이지 경계에 `<!-- page: N -->` 마커 삽입
(기존 corpus의 페이지 검증 도구와 호환). 참조 구현: [deploy/paddleocr-parser/main.py](../deploy/paddleocr-parser/main.py)

## 하드웨어·운영 사양

| 파서 | CPU/RAM | 비고 |
|---|---|---|
| kordoc (내장) | 미미 (순수 JS) | 문서당 수 초, N100급이면 충분 |
| Crawl4AI | 1~2GB RAM | 헤드리스 크로미움. 수집 파이프라인이 순차(2~7s 딜레이)라 부하 낮음 |
| PaddleOCR (CPU) | 2~4GB RAM | 페이지당 수 초~수십 초. 증분 운영엔 N100 충분, 초기 대량(수천 건)은 장시간 배치 |
| PaddleOCR (GPU) | VRAM 4GB+ | 대량 초기 처리 시 권장 |

## 파서별 구축 방법

### kordoc — 기본은 아무것도 안 해도 됨
`npm install` 시 [kordoc](https://github.com/chrisryugj/kordoc)이 의존성으로 설치되어 in-process로 동작합니다.
별도 서버(예: 사내 공용 파서)를 쓰려면 위 `/parse` 계약을 구현한 엔드포인트를 `KORDOC_PARSE_URL`에 지정하세요.

### OCR 엔진 — 기본 kordoc
스캔 PDF/이미지 OCR의 **기본 엔진은 kordoc**입니다(`OCR_ENGINE=kordoc`, 기본값). in-process kordoc은
문서 변환 전용이라 **OCR은 kordoc 4.2 `--ocr`가 활성화된 별도 서버가 필요**합니다 —
그 엔드포인트를 `KORDOC_PARSE_URL`(또는 `OCR_PARSE_URL`)에 지정하세요.
```bash
# kordoc --ocr 서버 예시(외부 호스트/워커에서 기동)
OCR_ENGINE=kordoc  KORDOC_PARSE_URL=http://<host>:3400/parse  node collection/convert_ocr_needed.js
```

### PaddleOCR — (legacy/optional) 폴백 참조 구현
kordoc OCR을 못 쓰는 환경의 폴백. `OCR_ENGINE=paddleocr` 로 전환해 사용합니다.
```bash
cd deploy && docker compose --profile legacy-ocr up -d paddleocr
# 또는 직접: cd deploy/paddleocr-parser && pip install -r requirements.txt && uvicorn main:app --port 13430
```
- 버전 고정: `paddleocr==3.6.0` (최신의 직전 버전 — 안정성 우선)
- 최초 기동 시 PP-StructureV3 모델 다운로드(수백 MB)로 첫 요청이 수 분 소요.
  compose는 모델을 `paddlex-models` 볼륨에 영속화합니다.
- `GET /health`의 `ready` 필드로 모델 로딩 완료 여부 확인 가능.

### Crawl4AI — 공식 이미지
```bash
docker run -d --name crawl4ai -p 11235:11235 --shm-size=1g unclecode/crawl4ai
```
서버에 인증을 걸었다면 `CRAWL4AI_API_TOKEN`에 Bearer 토큰을 설정하세요
(요청 시 `Authorization: Bearer <token>` 헤더로 전송됨).
`collect_legal_corpus.js`는 `CRAWL4AI_HOST`(host:port 형식)를 사용합니다.

## 환경변수 전체 매핑

`.env.example`을 `.env.api`로 복사해 채우고 `source .env.api` 후 실행합니다.

| 변수 | 사용 스크립트 | 미설정 시 동작 |
|---|---|---|
| `KORDOC_PARSE_URL` / `KORDOC_URL` | 변환·수집 전체 | 내장 kordoc npm 사용 (정상) |
| `MARKITDOWN_PARSE_URL` | convert_to_markdown, collect_institution_bylaws | 폴백 건너뜀 (정상) |
| `PADDLEOCR_PARSE_URL` / `PADDLEOCR_URL` | convert_ocr_needed, convert_reference_docs, collect_legal_corpus, ocrtomarkdown | 스캔 PDF는 ocr_needed 큐에 대기 |
| `CRAWL4AI_URL` | download_documents_advanced | 본문 표 수집 불가 → 해당 공시 스킵 |
| `CRAWL4AI_HOST` + `CRAWL4AI_API_TOKEN` | collect_legal_corpus (비DRF 출처) | law.go.kr(DRF) 소스는 영향 없음 |
| `OPENAPILAWKEY` / `LAW_OC` | collect_legal_corpus, sync_legal, add_legal_source, enrich_legal_ministry | 법령 수집·개정감지 불가 |
