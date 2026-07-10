# 수집 방법 (Collection)

## 0. 저장 폴더·파일 명명규칙

모든 산출물은 `data/` 하위에 코퍼스별로 저장되며, 폴더·파일명 규칙은 다음과 같습니다.

| 코퍼스 | 경로 규칙 | 예시 |
|---|---|---|
| ALIO 공시 | `data/structured_data/[주무부처]기관명_기관코드/SCD_항목명/연도/` | `[중소벤처기업부]창업진흥원_C0451/21026_노동조합/2024/` |
| ALIO 공시 파일 | 위 연도 폴더에 `content.json`(메타)·`content.md`(본문)·`attachments.json`·`manifest.json` + 첨부 원본 파일명 | `이사회 회의록.hwp` |
| 기관 내규 | `data/institution-bylaws-raw/[주무부처]기관명_기관코드/규정명_제개정일.확장자` (md는 `-md` 미러) | `보수규정_20250110.hwp` |
| 법령 corpus | `data/legal-md/카테고리/법령명(시행일).md` (원본은 `legal-raw` 미러) | `노동법령/근로기준법(2025.10.23. 시행).md` |
| 통계 | `data/raw/statistics/`(엑셀 원본) → `data/processed/statistics/`(JSON·MD) | |

- 기관 폴더명은 `[부처]기관명_기관코드` — `institutions.json`의 `ministry`/`name`/`apba_id`를 조합 (`disclosure_scope.js`의 `buildStructuredPaths()`).
- SCD 폴더명은 `공시코드_중분류명` (예: `20801_복리후생`).
- 파일시스템 예약문자(`/ : * ? " < > |`)는 `_`로 치환됩니다(`sanitizeSegment`).
- 연도 판정 불가 시 `UnknownYear` 폴더에 저장됩니다.

## 1. ALIO 경영공시 수집 — `download_documents_advanced.js`

### 공시항목 스코프 지정 (전체 92항목 지원)

ALIO 전체 공시항목은 92개이며(`data/disclosure_items.json`, `fetch_disclosure_catalog.js`로 재생성), 수집 범위는 세 가지 모드로 지정합니다. CLI 플래그가 yaml 설정보다 우선합니다.

| 모드 | yaml | CLI | 설명 |
|---|---|---|---|
| `items` | `scope: items` + `target_items` | `--items 20501,21026` | 지정 공시코드만 (기본) |
| `categories` | `scope: categories` + `minor_categories` | `--categories 노동조합,보수관리` | 중분류 단위 |
| `all` | `scope: all` | `--scope all` | 전체 92항목 |

```yaml
# collection/project/crawler/config/crawl_targets.yaml
scope: items
target_items:
  - scd: '20801'
    report_nos: ['20801']
target_years: [2022, 2023, 2024, 2025, 2026]
random_delay: [2, 7]
```

`--print-scope`로 실제 수집될 항목 목록(정기/수시 구분 포함)을 실행 없이 확인할 수 있습니다.

### 정기공시 vs 수시공시

- **수시공시**(87항목): `itemReportListSusi.json`으로 연도·차수별 공시 이력을 전 페이지 조회합니다.
- **정기공시**(5항목: 임원연봉 20501, 직원 평균보수 20601, 기관장 업무추진비 20701, 복리후생비 20801, 징계현황 21201): 수시 API가 에러를 반환하며, `itemOrganListJung.json`이 기관별 **최신 공시 1건**을 반환합니다. 과거 연도 수치는 보고서 표 안에 포함되어 있습니다(연도별 별도 공시 이력을 API로 열거할 수 없음).
- 판정은 `disclosure_items.json`의 `disclosure_kind` 필드 기준이며, 판정이 어긋나면 런타임에 반대 API로 자동 폴백합니다. 수집 결과 manifest에도 `disclosure_kind`가 기록됩니다.

### 기관 범위 지정

```bash
node collection/download_documents_advanced.js --ministry 고용노동부     # 주무부처
node collection/download_documents_advanced.js --apba-ids C0451,C0847   # 기관코드 목록
node collection/download_documents_advanced.js --inst-type 기타공공기관   # 기관유형
node collection/download_documents_advanced.js --limit 5                # 앞 N개 기관만 (테스트)
```

### 동작 방식

1. `institutions.json` × `disclosure_items.json` × 스코프 설정을 조합해 (기관, 공시코드) 대상 목록을 만듭니다.
2. 기관·코드별 공시 목록은 `data/reports.json`(사전 캐시, 선택사항)이 있으면 사용하고, 없으면 ALIO 라이브 API로 직접 조회합니다(수시=Susi 전 페이지, 정기=Jung 최신본).
3. 상세페이지(`itemReportTerm.do`)를 **Crawl4AI**로 크롤링해 표를 구조화 JSON/Markdown으로 변환합니다. crawl4ai 서버에 인증이 있으면 `CRAWL4AI_API_TOKEN`을 설정하세요.
4. 보고서 HTML(`itemReport.do`)을 직접 파싱해 첨부파일(PDF/HWP/ZIP 등) 링크를 뽑아 스트림 다운로드합니다.
5. 결과를 `기관 → SCD(공시코드) → 연도` 계층으로 저장합니다(0장 명명규칙 참조).
6. 각 폴더에 `content.json`(원본 메타+섹션), `content.md`(본문 Markdown), `attachments.json`, `manifest.json`을 씁니다.

### 재시도·연도 필터

```bash
node collection/download_documents_advanced.js --retry-targets targets.json
node collection/download_documents_advanced.js --year 2024
```

`--retry-targets`는 `[{ "apba_id", "report_no", "disclosure_no"? }, ...]` 형식 JSON을 받습니다. `disclosure_no`가 있으면 해당 공시만, 없으면 그 (기관, 공시코드)의 전체 공시를 재시도합니다. `sync_alio.js`가 이 형식으로 누락 목록을 생성합니다.

### ZIP 첨부 처리

```bash
node collection/extract_zips.js            # data/structured_data 하위 .zip 일괄 해제 (한글 파일명 처리)
node collection/build_download_file_index.js  # 해제된 내부 파일을 인덱스에 반영
```

해제된 ZIP 내부의 hwp/pdf/xlsx 등은 인덱스에 `zip:` prefix ID로 포함되어 변환 파이프라인을 그대로 탑니다.

## 1-1. 증분 동기화 — `sync_alio.js`

저장본과 ALIO 웹 최신본을 대조해 신규·누락 공시만 수집합니다.

| | fast (기본) | full (`--full`) |
|---|---|---|
| 대조 방법 | 사이트 전역 최근공시 feed (`--end-num N`, 기본 100) | 스코프 내 (기관×공시코드) 전 조합 라이브 열거 |
| 용도 | 매일 cron | 주간/분기 전수 점검 |
| 재개 | — | 체크포인트 + `--resume` |
| 첨부 검사 | — | `--files` (보유 공시의 누락 첨부까지) |

| | report (기본, 반자동) | apply (`--mode=apply`, 자동) |
|---|---|---|
| 동작 | 리포트 + retry-targets 파일 생성 후 종료 | 생성 후 즉시 다운로드 실행 |
| 후속 | 사람이 검토 후 `--retry-targets`로 수집 | 변환·인덱스 명령 안내 출력 |

```bash
node collection/sync_alio.js                              # 매일: fast 감지 리포트
node collection/sync_alio.js --full --categories 노동조합  # 주간: 관심 분류 전수 대조
node collection/sync_alio.js --full --mode=apply          # 감지 즉시 자동 수집
# 반자동 흐름: 리포트 검토 후
node collection/download_documents_advanced.js --retry-targets data/logs/recency_retry_targets.json
```

산출물: `data/logs/sync_alio_report_<날짜>.json`(missing/unmatched/stats), `data/logs/recency_retry_targets.json`.

cron 예시: 매일 새벽 `sync:alio`(fast report), 주 1회 `--full` report, 검토 후 apply.

## 2. 법령·행정규칙 수집 — `collect_legal_corpus.js`

- law.go.kr 법령/행정규칙은 **DRF(Data Reference Framework) JSON API**로 직접 수집합니다. HTML 크롤링 없이 구조화된 본문을 그대로 받아오므로 노이즈가 없습니다. DRF 원본 JSON은 `legal-raw`에 함께 보존됩니다.
- **별표·서식(붙임)**: 법령 JSON의 `별표단위`를 파싱해 md에 `## 별표·서식` 섹션으로 본문 텍스트를 인라인 수록하고, 원본 파일(HWP 우선, 없으면 PDF)을 `legal-raw/<카테고리>/<id>_annex/`에 다운로드합니다. 별표 실패는 경고로만 기록되며 본문 수집은 성공 처리됩니다. `--no-annex`로 생략 가능.
- 그 외 출처(기재부·고용부 지침 등 HTML/PDF 공지)는 Crawl4AI → kordoc → PaddleOCR 순 폴백 파이프라인을 탑니다.
- 수집 대상은 `data/legal-md/source_manifest.json`(시드 107건: 노동법령 34·공무원규정 24·기재부지침 18 등)이 관리하며 `--category`, `--id`로 선택 실행합니다. 상태(`planned`/`collected`/`failed`) 기록으로 재실행 시 수집분은 건너뜁니다.

```bash
source .env.api
node collection/collect_legal_corpus.js --category labor_laws
node collection/collect_legal_corpus.js --retry-failed
node collection/collect_legal_corpus.js --dry-run
```

### 법령 추가 — `add_legal_source.js`

law.go.kr 검색으로 임의 법령·행정규칙을 manifest에 추가합니다.

```bash
node collection/add_legal_source.js --law "산업안전보건법" --category labor_laws --dry-run
node collection/add_legal_source.js --law "근로기준법" --pick 3        # 후보 중 선택 (시행규칙 등)
node collection/add_legal_source.js --admrul "행정규칙명" --category moel_guidelines
# 추가 후: node collection/collect_legal_corpus.js --id <생성된 id>
```

동일 일련번호(lsiSeq)·동일 제목이 이미 있으면 거부합니다. 카테고리→폴더 매핑: `labor_laws→노동법령`, `public_institution_laws→공공기관법령`, `moef_guidelines→기재부지침`, `moel_guidelines→고용부지침`, `labor_commission_reference→노동위원회`, `civil_service_reference→공무원규정`.

### 개정 감지 — `sync_legal.js`

manifest의 각 법령을 lawSearch.do로 재조회해 **법령일련번호+시행일자 변화**로 개정을 판정합니다.

```bash
node collection/sync_legal.js                # 전체 대조 → legal_revision_report_<날짜>.json
node collection/sync_legal.js --limit 5      # 테스트
node collection/sync_legal.js --apply        # 개정 항목 source_url 교체 + planned 리셋
node collection/collect_legal_corpus.js      # 리셋된 항목 재수집 (별표 포함)
```

법령명 비교는 가운뎃점(·ㆍ)·공백을 정규화합니다. 월 1회 report → 검토 → apply 흐름을 권장합니다.

### 소관부처 보강 — `enrich_legal_ministry.js`

law.go.kr DRF API로 각 법령/행정규칙의 소관부처·담당부서를 `source_manifest.json`에 채웁니다. `LAW_OC` 환경변수(law.go.kr 발급 이용자 ID)가 필요합니다. 이미 채워진 항목은 건너뛰므로 재실행해도 안전합니다(`--force`로 강제 재수집).

## 3. 기관 내부규정 수집 — `collect_institution_bylaws.js`

ALIO `21110`(내부규정) 게시판에서 기관별 현행 규정을 수집합니다. 기본은 게시글별 **최신 첨부 1건**(마지막 첨부 = 최신 개정본)이며, `--all-files`로 과거 개정 버전까지 전체 수집할 수 있습니다(과거본은 `_v01`부터 suffix).

```bash
node collection/collect_institution_bylaws.js --dry-run       # 목록만 확인
node collection/collect_institution_bylaws.js --apba-id C0847 # 단일 기관
node collection/collect_institution_bylaws.js --all-files     # 첨부 전체(개정 이력 포함)
node collection/collect_institution_bylaws.js --survey        # 전체 현황 분석만
```

## 4. 통계 데이터 — `download_statistics.js`

ALIO가 제공하는 통계 엑셀(임직원 수, 평균보수 등)을 다운로드합니다. 이후 `process_statistics.js`(JSON 변환) → `convert_statistics_to_md.js`(Markdown 표 변환) → `build_statistics_index.js`(통합 인덱스)로 이어집니다.

## 5. 신규 공시 모니터링 — `check_disclosure_recency.js`

이미 수집한 데이터 기준으로 ALIO에 새로 올라온 공시를 감지합니다. 정기 실행(cron 등)에 적합합니다.

## report 체크포인트 (raw 오프사이트 증분 수집)

`download_documents_advanced.js`는 report 처리 시 `data/logs/download_ckpt.json`에 disclosureNo를 기록한다. 이후 실행에서 이미 처리한 report는 **raw 파일이 로컬에 없어도**(오프사이트 아카이브로 옮겨 삭제한 경우) 건너뛴다 — 지난 수집 이후 신규만 다운로드.

- `--recheck`: 체크포인트 무시하고 전 report 재처리
- `--ckpt <path>`: 체크포인트 경로 지정(기본 `data/logs/download_ckpt.json`)
- `SKIP_DOWNLOAD_CKPT=1`: 체크포인트 비활성(기관 샤딩 병렬 시 공유파일 race 회피용)
- idate/critYyyy 변경 시 재처리(내용 갱신 반영)

채용/게시판 수집기는 이미 posting-level 체크포인트(`formNo:apbaId:idx`+idate)라 raw 삭제와 무관하게 증분 동작.
