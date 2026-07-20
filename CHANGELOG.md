# Changelog

이 프로젝트의 주요 변경 사항을 기록합니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)에 준합니다.

## [1.9.6] - 2026-07-20

### Added
- **수시 델타 적재** (`rag/parse_disclosure.js` + `rag/load_pg.js`): 수시 증분(채용 등)을 전체 재파싱 없이 **신규+변경분만** RAG에 편입.
  - `parse_disclosure.js`: `--under <substr[,substr]>`(부분 파싱 — 경로 토큰 매칭 + walk 가지치기로 대형 트리 전수 순회 방지), `--since <ISO|epoch_ms>`(mtime 기준 신규/재변환분만 — OCR 개선분도 포착), `--out <dir>`(별도 스테이징).
  - `load_pg.js --delta <corpus> [--staging <dir>]`: 스테이징에 있는 **doc_id만 정확히 삭제→재삽입**(접두 검증·BEGIN/COMMIT 원자적·`--dry-run`) + 신규 해시만 embed_queue. `--append`(코퍼스 전체 교체)와 달리 범위 한정이라 수시 증분에 적합.
- **`convert_ocr_needed.js --merge-ckpt <path>`**: 듀얼 OCR 워커 샤드(`--skip-main-merge`) 완료 후 각 체크포인트를 메인에 병합하는 standalone 모드.
- **n8n 증분 자동화 (`n8n/`)**: 감지→텔레그램 알림·버튼 승인→수집·적재→완료통지 워크플로 4종(정기감지·수시감지·증분승인·완료통지, **새니타이즈**=개인정보·크리덴셜ID·호스트명 플레이스홀더화) + `periodic_server.js`(HTTP 래퍼) + `README.md`(설정·크론 timezone·메시지 규칙).

## [1.9.5] - 2026-07-20

### Changed
- **기본 OCR 엔진 kordoc으로 전환** (⚠️ BREAKING): `OCR_ENGINE` 기본값을 `paddleocr`→`kordoc`(4.2 `--ocr`). `convert_ocr_needed.js`의 OCR URL 해석을 엔진 정합으로 변경 — `OCR_PARSE_URL`(명시)가 최우선, 없으면 엔진별 기본(`kordoc`→`KORDOC_PARSE_URL`/`KORDOC_URL`, `paddleocr`→`PADDLEOCR_PARSE_URL`). 기존 PaddleOCR 사용자는 `OCR_ENGINE=paddleocr`를 명시해야 한다.
- **PaddleOCR → legacy/optional 폴백 강등**: `deploy/docker-compose.yml`에서 paddleocr 서비스를 `profiles: ["legacy-ocr"]`로 이동(기본 `up`에서 제외, `docker compose --profile legacy-ocr up -d paddleocr`로만 기동). app 기본 `OCR_ENGINE=kordoc`, `depends_on`에서 paddleocr 제거. 참조 구현(`deploy/paddleocr-parser`)은 폴백용으로 **유지**.
- **문서·헬스체크**: `.env.example`(kordoc 기본·PaddleOCR 주석) / `docs/PARSERS.md`·`docs/INSTALL.md`·`README.md`(OCR 기본 kordoc·PaddleOCR legacy) / `check_services.js`(활성 OCR 엔진 기준으로 헬스체크).

### Note
- kordoc OCR은 별도 `--ocr` 활성 서버가 필요하다(in-process kordoc은 문서 변환 전용). crawl4alio deploy는 kordoc OCR 서버를 제공하지 않으므로 `KORDOC_PARSE_URL`(또는 `OCR_PARSE_URL`)로 외부 서버를 지정한다. 이 전환의 근거: kordoc 내부 OCR ↔ PaddleOCR 품질 A/B 동등(PP-OCRv5 공통) — 엔진 일원화 목적.

## [1.9.4] - 2026-07-20

### Added
- **표 인식 청킹 (`rag/parse_disclosure.js`)**: RAG 청킹이 표를 문자 단위로 잘라 구조를 파괴하던 문제 해결. **markdown `|`표 + HTML `<table>`**(kordoc 4.2가 직무기술서 등에서 출력) 모두 평탄화 전에 분리해 **행 경계로 분할하고, target 초과 시 헤더 행을 반복**한다. HTML은 `<tr>`=행·`<th>/<td>`=셀(이중공백 구분)·`<br>`→공백으로 파싱. `cleanLine`은 **ASCII HTML 태그만** 제거(`<\/?[a-zA-Z][^>]*>`)해 `<경영목표>` 등 한글 꺾쇠 마커는 보존. 긴 일반 문단도 char→단어 경계 분할. 헬퍼 `isHtmlTableStart`/`htmlTableRows`/`mdTableRows`/`chunkRows` 공용화.

### Changed
- **structured_data 심링크 은퇴 → `DATA_ROOT` env + `fromStructuredRoot()`**: 구조화 코퍼스 트리 기준을 심링크(structured_data)가 아니라 실경로로 직접 지정. `fromCatalogRoot("structured_data")` 11개 호출부를 `fromStructuredRoot()`로 중앙화(paths.js). 미지정 시 catalogRoot/structured_data 하위호환. 프로덕션: `DATA_ROOT=<...>/alio-md/자료/기관별공시`. alio측 체크포인트(conversion 135,503+ocr 18,371 경로)·코드 동반 치환, 심링크 2개 제거. 런타임·경로해석 검증 완료.
- **청크 크기 파라미터 (`rag/parse_disclosure.js`)**: `CHUNK_CAP` 40→120(표 많은 공고 등 정형 대형문서의 조기 truncate 방지) + 적응형 target 산정 분모를 `TARGET_DIV=40`으로 분리(cap 변경이 청크 크기에 영향 없음), 청크 상한 `TARGET_MAX` 4000→2500(과대 청크의 임베딩 의미 희석 완화·검색 정밀도↑). 비(非)표·소형 문서 출력 무변화(회귀 검증).

## [1.9.3] - 2026-07-18

### Changed
- **rag/embed_articles.js 임베딩 동시성(EMBED_CONCURRENCY, 기본 4) + DB insert 뮤텍스**: 배치 슬라이스를 동시 API 호출로 병렬화(단일 Client 동시 query 경고 방지 위해 insert만 직렬화). HNSW 인덱스 DROP 후 대량 적재와 결합 시 실측 18.8배 가속(428→8,832건/분). 대량 재적재 표준: 인덱스 DROP→벌크 적재→재생성.
- **내장 kordoc 4.0.8 → 4.2.0**: 변환 품질 개선분 수용 — HWP3 rhwp 업스트림 정합 3종(탭 8byte 구조·필드코드/책갈피 스트림 소비·사적 graphic char 매핑으로 로마숫자·원문자·글머리 복원, 업스트림 실측 77→1058 문단 복구), 수식 OCR 페이지 off-by-one, XLSX keepTrailingEmptyCols 배선 누락 수정 등. `callKordoc` 어댑터(parse→markdown/success/warnings 계약·stripDanglingImageRefs) 무변경으로 호환 확인(4.2.0 parse 계약·121만 규모 파이프라인 스모크 통과).
- **OCR 엔진 배선 일반화 — `OCR_ENGINE`·`OCR_PARSE_URL`**: convert_ocr_needed가 엔진 무관(HTTP 응답 계약 {result:{markdown}} 동일). paddleocr(기본)↔kordoc 서버를 env 두 개로 전환, 메타·체크포인트 parser 라벨 정확화. PaddleOCR 안 내리고 URL만 바꿔 A/B·롤백 가능.
- **kordoc 내장 텍스트 OCR(PP-OCRv5 korean, onnxruntime-node) — `KORDOC_OCR` env 스위치 추가**: 기본 off(현행 동작 불변, 저사양 안전). `1`/`on`=needsOcr 페이지만, `force`=전 페이지. `callKordoc` 어댑터가 `parse(...,{ocr})`로 전달, `kordocOcrMode()` 진단 export. **배포 프로파일**(올인원 kordoc vs 서버형 HTTP)을 README에 문서화 — 별도 브랜치 없이 env 조합으로 표현. PaddleOCR HTTP 경로는 하위호환 유지(택일). 성능: M-series 0.9s/page 실측, 저사양 상시 대량 OCR 부적합 → OCR 워커에만 스위치 on(OCR_SHARD 재사용).

## [1.9.2] - 2026-07-17

### Added
- **rag/validate_staging.js — 적재 전 스테이징 검증 게이트**: 라인 JSON 유효성·(doc_id, seq) 유일성·docs n_articles 합계 대조·NUL(0x00)/제어문자 검사를 한 번에. 같은 날 실사고 두 건(4GiB 절단+60.7만 줄 중복, NUL 1건으로 121만 청크 적재 중단)을 모두 적재 전에 잡을 수 있었던 검사들이다. 121만 청크 실데이터로 검증.
- **docs/PIPELINE_HARDENING.md** — 대용량 JSONL 쓰기 백프레셔, PG NUL, `| tee` rc 함정과 pipefail 게이트, 단일 파일 HTML 인덱스의 gzip 인라인+async 해제 패턴과 톱레벨 파생 계산 함정, 코드 라벨 추측 금지(카탈로그·실파일 대조) 등 하루치 운영 사고에서 굳힌 원칙 모음.

### Fixed
- **rag/parse_disclosure.js**: 청크 본문·제목에서 NUL(0x00) 제거 — PostgreSQL TEXT가 유일하게 거부하는 문자로, 변환 산출물 1건에 섞여 들어와 코퍼스 전체 적재를 중단시킨 실사고의 재발 방지.

## [1.9.1] - 2026-07-17

### Fixed
- **rag/parse_disclosure.js 쓰기 백프레셔** — 메인 루프가 완전 동기라 이벤트 루프가 돌지 않아 산출물 수 GB가 스트림 메모리 버퍼에 통째로 쌓였다가 종료 flush의 대형 writev에서 실패하는 사고(실운영에서 4GiB 절단+60.7만 줄 중복 기록). `write()` false 시 drain 대기, 스트림 error 핸들러, `end()` 완료 대기 후 리포트 작성으로 수정 — 실패 시 반드시 비정상 종료해 후속 적재 단계가 불완전 스테이징을 읽지 않게 한다. 155,113문서/1,208,291청크(2.85GB) 전량 재파싱으로 검증. 파이프라인 스크립트에서 `node parse | tee` 형태로 쓴다면 `set -o pipefail` + rc 게이트를 함께 둘 것(tee의 rc가 실패를 가리는 함정).

## [1.9.0] - 2026-07-17

### Added
- **`postprocess/` — OCR Markdown 후처리 5종**: 조문 경계 정리(clean)·조 제목 감사/승격(audit/fix_article_heading_gaps)·순번 표식 감사/복원(audit/fix_nested_marker_gaps). manifest 고정·candidate/applied/residual 로그·멱등성·기본 dry-run 원칙. 실감사 교훈 반영 — **조 제목 승격은 '제목만 있는 줄'만**(본문 붙은 줄은 분리 후보로 기록만; 과거 과다 승격 945건 전량이 새 게이트에서 차단됨을 실데이터로 검증). 문서: docs/POSTPROCESS.md.
- **`rag/` — RAG 확장 모듈**: 조항 파서→PostgreSQL 적재(감사컬럼·load_runs)→NVIDIA 임베딩(비대칭 task type)→검색(키워드 trgm·의미 pgvector·**RRF 하이브리드**·2단계 filtered semantic)→HTTP API(Pool·3중 캐시)→MCP 서버. 136만 조문 실운영 스택의 일반화판(`RAG_ROOT`로 데이터 워크스페이스 지정). 공유 분류 모듈 `collection/classify_usecase.js` 동봉.

## [1.8.1] - 2026-07-17

### Fixed
- **'OCR 결과 없음'을 재시도 리셋 목록에서 제거** — genuine 빈 문서는 재시도해도 0.6초 재실패라, 리셋에 있으면 재기동마다 부활→즉시실패→백오프 무한 churn이 되고 open/failed 플래핑으로 완주 판정까지 막는다(실운영 99% 꼬리에서 발생). 전이성 네트워크 오류만 리셋한다.

## [1.8.0] - 2026-07-16

### Added
- **`scripts/watch_final_merge.sh`** — 라운드 완주 감시 → 최종 병합 → 뒷정리 자동화. 이중 완주 판정(큐 전항목 success/failed + 전 인스턴스 로그 "처리할 파일 없음") 후 `merge_ocr_instance_ckpts.js`를 실행하고, **검증(exit 0)이 통과한 경우에만** 워치독·재배분 모니터를 정리. 실패 시 아무것도 죽이지 않고 수동 확인 요청. `OCR_INSTANCES` 콤마 목록으로 N대 지원. 이로써 scripts/가 수집→변환→회수→OCR→**완주 병합·정리**까지 전 구간 무인화.

## [1.7.2] - 2026-07-16

### Added
- **`scripts/merge_ocr_instance_ckpts.js`** — 멀티 PC 라운드 마감용 최종 병합. `--skip-main-merge`로 돈 인스턴스 성공을 메인 체크포인트에 반영(convert는 큐가 비면 병합 전에 종료하므로 빈 런으론 병합 불가 — 그 자리를 채움). 백업·원자 저장·검증(잔여=영구실패면 exit 0) 포함.

### Changed
- 내장 kordoc 4.0.7 → **4.0.8** (PDF·HWPX·HWP5·DOCX 이미지 무음 유실 수정판).
- **kordoc 어댑터에 미저장 이미지 참조 정리 추가**: 4.0.8이 markdown에 넣는 `![image](image_001.png)` 상대 참조는 이 파이프라인(텍스트 코퍼스, 이미지 미저장)에선 깨진 링크가 됨 → 스킴 없는 로컬 이미지 참조만 제거(http/https·data: URI는 보존). 실파일 검증: 참조 0개·외부 URL 보존.

## [1.7.1] - 2026-07-16

### Changed
- 내장 kordoc을 3.17.0 → **4.0.7**로 업데이트 — `parse()` API 호환 확인(실파일 PDF·XLSX 테스트 통과, 추출 결과 동일). HTTP 서버(4.x)와 내장의 버전 불일치 해소.
- README 프로젝트 구조에 누락 항목 반영: `scripts/`(무인 운영 3종)·`recover_ocr_text_pdfs.js`·CHANGELOG/NOTICE.

## [1.7.0] - 2026-07-16

### Added
- **`OCR_SHARD=i/n` — N대 확장 샤딩**: 문서 id 해시 모듈러로 같은 밴드를 다시 N분할. 기존 밴드(safe/risky 등)와 **조합 가능**해, 3~4대 구성(예: risky 1대 + safe×3샤드)이 밀도 안전축을 유지한 채 가능해짐. 실측(잔여 큐 829건): 겹침·누락 0, 분포 균등(±5%), 결정성 확인.

## [1.6.0] - 2026-07-16

### Added
- **무인 운영 스크립트 3종 (`scripts/`)** — 사이트 특화 없이 env만으로 구동:
  - `ocr_watchdog.sh`: OCR 인스턴스 감독 — 사망 재기동, 정체 감지(실행 로그 mtime 기준 — inflight 기준은 대형 다청크 문서를 오인 종료), 큐 소진 백오프, 재배분 config 자동 반영.
  - `ocr_rebalance.sh`: safe(저RAM) 인스턴스 소진 임박 시 `OCR_SPLIT_PAGES` 상향으로 저밀도 대형을 이관. 안정성 불변식 내장(밀도 임계 불변·SPLIT 상향만·양 서버 health 정상 시에만·recovery 진행 중 보류).
  - `recover_then_reprocess.sh`: 회수→재처리 체인 — cron의 변환 후·OCR 전 단계용.
- 위 스크립트들은 실운영(듀얼 PC, 32만+ 파일)에서 크래시·오인 종료·오발동을 겪고 고친 로직의 이식이다.

## [1.5.0] - 2026-07-16

**"kordoc이 읽을 수 있는 문서는 끝까지 kordoc이 처리한다"** — 변환→회수→OCR 순서를 코드로 강제하고, 실사고(NAS 다운·오회수·파서 race)에서 나온 결함을 수정한 안정화 릴리스.

### Added
- **kordoc 우선 강제**: 회수가 판정 전 대상을 `kordoc_pending.json`에 기록하면 OCR(`convert_ocr_needed`)이 해당 문서를 건너뜀. 판정 끝난 것(LOW/실패)만 OCR로 방출 — OCR이 kordoc 몫 텍스트 PDF를 선점하던 race(실측 711건) 차단. 비정상 종료 잔재는 `KORDOC_PENDING_TTL_H`(기본 12h)로 무시해 영구 제외 방지.
- **`--reprocess` 모드**: race 등으로 이미 OCR 처리된 텍스트 PDF를 kordoc으로 재추출, 품질 게이트 통과 시 `.md` 교체(사후 품질 업그레이드).
- OCR 큐 텍스트 PDF 회수 도구 `recover_ocr_text_pdfs.js` — 하이브리드 포함 넓게 시도하고 페이지당 글자 수 게이트로 판정(실측: 오이관 원인의 91%가 kordoc 타임아웃, 회수분의 58%가 이미지 다수 하이브리드).
- OCR 스케일아웃 밴드 확장: `safe`/`risky`(밀도+페이지 균형), `OCR_SPLIT_PAGES`(페이지 균형점), `OCR_QUARANTINE_PATH`/`OCR_INFLIGHT_PATH`(OOM 문서 자기치유 격리), `OCR_MAX_TIMEOUT`.
- PaddleOCR 서버 자가복구(opt-in): RSS 초과·요청 hang·EIO·연속 실패 시 자가종료 → 컨테이너 restart 정책으로 무인 재기동.

### Fixed
- **품질 게이트 페이지 수 오인**: 압축 오브젝트스트림(`/ObjStm`) PDF가 바이트 스캔에서 1페이지로 오인돼 부실 추출이 게이트를 통과(45p 스캔본이 1,278자로 "회수 성공"된 실사례). regex가 1p 이하 + `/ObjStm` 존재 시 pdf-lib로 정확 재계산, 끝내 불명이면 회수 포기(OCR 유지, 안전측).
- **체크포인트 I/O 폭주**: 회수가 건마다 67MB급 JSON을 통째로 rewrite — 다른 프로세스와 겹치자 NAS가 다운된 원인. `RECOVER_FLUSH_EVERY`(기본 20)건마다·종료 시 배치 저장으로 변경, SIGINT/SIGTERM에서도 flush.
- 초기 변환의 kordoc PDF 타임아웃을 300s로 상향(`KORDOC_PDF_TIMEOUT_MS`) — 대형 텍스트 PDF가 타임아웃으로 OCR에 오이관되던 근본 원인 예방.

## [1.4.0] - 2026-07-13

### Added
- ALIO 법령/지침 게시판 수집기(기재부 지침 개정 이력).
- 게시판 첨부 전용 변환 인덱서 + `convert --index`.
- OCR 하이브리드 모드(kordoc 변환과 OCR 소비 병행).

### Fixed
- **OCR 산출 misroute**: raw/md 트리 분리 후 OCR `.md`가 alio-raw에 기록되던 버그 — `toMdOutput()`으로 정정.
- 변환 대량 skip 사고 3중 수정(디스크 존재 판정·체크포인트 정합).

### Changed
- 수집·변환 스크립트 카탈로그화 전수 완료, README를 OSS 관례로 전면 개편(대규모 운영 교훈 문서화 포함).

## [1.3.1] - 2026-07-11

### Changed
- `CATALOG_ROOT` 단일화 — 코드/데이터 완전 분리, 모든 계층이 데이터 루트 하나를 공유.
- raw/md 트리 정합 정리 + report 체크포인트 시딩(`seed_download_ckpt.js`) — raw 오프사이트 이관 후에도 증분 수집.

### Fixed
- 내규 수집기 체크포인트 디렉토리 부재 시 ENOENT 크래시.

## [1.3.0] - 2026-07-11

### Added
- **report-level 체크포인트** — "디스크에 파일 있음" 대신 체크포인트를 진실로: 원본(raw)을 오프사이트로 옮겨 삭제한 뒤에도 증분 수집 가능.

## [1.2.0] - 2026-07-11

### Added
- 게시판형 공시 수집기: 국회 지적(B1210)·감사원 지적(B1220) 본문+첨부, 경영평가(B1230/B1250) 첨부.
- 항목별 첨부전용 모드(`--attach-only-items`) — 본문 없는 항목은 크롤러 생략으로 대폭 가속.

### Fixed
- 게시판형 목록이 기관당 1건으로 접히던 dedup 버그.
- 긴 한글 제목 ENAMETOOLONG로 런 전체가 중단되던 버그.
- 체크포인트 atomic write — 병렬 수집 race 방지.

### Changed
- 다운로드·채용 수집 대폭 병렬화(report당 네트워크 3콜 병렬, 게시글·파일 병렬, 전역 요청 세마포어, 스트림 다운로드).

## [1.1.0] - 2026-07-09

### Added
- ALIO 전체 공시항목(92종) 확대 — 스코프 모드·정기/수시 구분·기관 선택.
- 증분 동기화 `sync_alio.js`(fast/full × report/apply).
- law.go.kr 별표·서식 수집 + 법령 추가 CLI + 개정 감지.
- 채용공고 수집기(B1010/B1020) — fileNo 캐시·idate 변경 감지·파일명 충돌 처리.
- 설치 프로필 2종(kordoc npm 내장 최소 / docker compose 풀스택) + INSTALL 가이드.
- 파일 해시 캐시로 중복 파싱 방지.

## [1.0.0] - 2026-07-07

- 최초 공개 — ALIO 경영공시·법령·기관 내규 수집 및 HWP/PDF/XLSX/DOCX → Markdown 변환 툴킷 (MIT).

[1.9.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/bigone-kcrew/crawl4alio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/bigone-kcrew/crawl4alio/releases/tag/v1.0.0
