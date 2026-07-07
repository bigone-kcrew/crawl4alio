# CLAUDE.md — AI 에이전트용 설치·운영 가이드

이 저장소는 한국 공공기관 경영공시(ALIO)·법령(law.go.kr)·기관내규 수집 및 HWP/PDF→Markdown 변환 도구입니다.
사용자가 "설치해줘/실행해줘"라고 하면 아래 순서를 따르세요.

## 1. 환경 진단 (항상 첫 단계)

```bash
npm install          # kordoc(HWP 파서)이 의존성으로 함께 설치됨
node collection/check_services.js
```

진단 출력의 ✅/❌로 활성 기능을 파악하고, 아래 프로필을 판정하세요:
- **Docker 사용 가능** → 풀스택 프로필 권장 (스캔 PDF OCR + ALIO 본문 표까지 전 기능)
- **Docker 없음** → 최소 프로필 (수집 전체 + HWP/PDF/DOCX/XLSX 변환은 즉시 동작.
  스캔 PDF OCR과 ALIO 본문 표 수집만 비활성 — 치명적이지 않음: OCR 대상은 큐에 대기, 본문 표는 스킵)

## 2. 사용자에게 확인할 것

1. **law.go.kr Open API 키** (법령 수집 시 필수): https://open.law.go.kr 에서 본인 명의로 발급받은
   이용자 ID(OC). `.env.api`의 `OPENAPILAWKEY`(및 `LAW_OC`)에 설정. AI가 대신 발급할 수 없음.
2. **수집 범위**: 전체 92개 공시항목 × 355기관 전량 수집은 수 일 소요.
   먼저 관심 항목/기관으로 좁혀 시작할 것을 권하세요 (`--categories 노동조합` 또는 `--apba-ids C0451` 등).

## 3. 설치 절차

### 공통
```bash
cp .env.example .env.api   # 값 채운 뒤 source .env.api (파일이 CRLF면 source가 실패하니 LF 유지)
```

### 풀스택 프로필 (Docker)
```bash
cd deploy
docker compose up -d crawl4ai paddleocr   # paddleocr 첫 기동은 모델 다운로드로 수 분 소요
docker compose run --rm app               # 컨테이너 안에서 check_services 실행됨
```
이후 모든 명령은 `docker compose run --rm app npm run <script>` 형태로 실행.

### 최소 프로필 (Node만)
npm install로 끝. 파서를 외부 서버로 연결하려면 [docs/PARSERS.md](docs/PARSERS.md)의 `/parse` 계약 참조.

## 4. 단계별 검증 (각 단계 후 반드시 실행)

| 단계 | 검증 명령 | 기대 결과 |
|---|---|---|
| 스코프 확인 | `node collection/download_documents_advanced.js --print-scope` | 항목 목록 출력 (기본 25개) |
| 소규모 수집 | `... --apba-ids C0451 --items 21026 --limit 1` | `data/structured_data/[부처]기관_코드/` 생성 |
| 동기화 감지 | `npm run sync:alio` | `data/logs/sync_alio_report_*.json` 생성 |
| 변환 | `node collection/build_download_file_index.js && npm run convert:markdown` | `OK(kordoc)` 로그, `.md` 생성 |
| 법령 1건 | `node collection/collect_legal_corpus.js --id labor_standards_act` | `data/legal-md/노동법령/*.md` + 별표 |

## 5. 흔한 문제와 해결

| 증상 | 원인·해결 |
|---|---|
| Crawl4AI 401 | 서버에 인증 설정됨 → `.env.api`에 `CRAWL4AI_API_TOKEN` 설정 |
| 정기공시(20501 등)가 최신 연도만 수집됨 | 정상 — ALIO가 정기공시는 최신본만 API 제공, 과거 수치는 보고서 표 안에 포함 |
| 21110(내부규정) 수집 안 됨 | 정상 — 게시판형이라 `npm run collect:bylaws`가 담당 |
| `source .env.api` 오류 (`$'\r'`) | 파일이 CRLF → `sed -i 's/\r$//' .env.api` |
| 스캔 PDF가 `ocr_needed`로 빠짐 | 정상 분류 — PaddleOCR 가동 후 `npm run convert:ocr` |
| ALIO API가 빈 결과/에러 | 정기공시 API에 빈 문자열 부가필드를 보내면 error — 코드가 이미 처리하므로 재시도만 |

## 6. 운영 루틴 (설치 후 제안)

```bash
npm run sync:alio                          # 매일: 신규 공시 감지 (리포트만)
node collection/sync_alio.js --full        # 주 1회: 전수 대조
node collection/sync_alio.js --mode=apply  # 검토 후: 자동 수집
npm run sync:legal                         # 월 1회: 법령 개정 감지
```

## 7. 주의사항 (반드시 준수)

- 공공 사이트 크롤링 예절: 딜레이 설정(`random_delay`, `--delay-ms`)을 줄이지 말 것. 동시성 기본값 유지.
- `data/` 하위 수집 결과물과 `.env.api`(API 키 포함)는 절대 커밋하지 말 것 (.gitignore 처리됨).
- 전량 수집·전량 OCR은 사용자에게 소요 시간을 먼저 알리고 동의받을 것.
