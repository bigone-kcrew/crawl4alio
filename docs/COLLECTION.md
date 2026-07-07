# 수집 방법 (Collection)

## 1. ALIO 경영공시 수집 — `download_documents_advanced.js`

### 대상 지정

`collection/project/crawler/config/crawl_targets.yaml`에서 수집할 공시항목 코드(`report_form_root_no`)와 연도 범위를 지정합니다.

```yaml
target_items:
  - scd: '20801'
    report_nos: ['20801']   # 복리후생(정기)
target_years: [2022, 2023, 2024, 2025, 2026]
random_delay: [2, 7]        # 요청 간 랜덤 지연(초)
```

기관 목록은 `2_data/institutions.json`(공공기관 코드·부처·유형), 공시항목 메타는 `2_data/disclosure_items.json`(대분류/중분류 체계)을 사용합니다. 둘 다 ALIO가 공개하는 정적 메타데이터이며 이 저장소에 시드로 포함되어 있습니다.

### 동작 방식

1. `institutions.json` × `disclosure_items.json` × `crawl_targets.yaml`을 조합해 (기관, 공시코드) 대상 목록을 만듭니다.
2. 기관·코드별 공시 목록은 `2_data/reports.json`(사전 캐시, 선택사항)을 먼저 찾고, 없으면 ALIO 라이브 API(`itemOrganListSusi.json`, `itemReportListSusi.json`)로 직접 조회합니다. 즉 `reports.json` 없이도 동작하지만, 매 실행마다 라이브 조회가 필요해 느려집니다.
3. 상세페이지(`itemReportTerm.do?apbaId=...&reportFormRootNo=...&disclosureNo=...`)를 **Crawl4AI**로 크롤링해 표를 구조화 JSON/Markdown으로 변환합니다.
4. 보고서 HTML(`itemReport.do`)을 직접 파싱해 첨부파일(PDF/HWP/ZIP 등) 링크를 뽑아 스트림 다운로드합니다.
5. 결과를 `기관 → SCD(공시코드) → 연도` 계층으로 저장합니다. 성공한 결과가 있을 때만 디렉터리를 만들어 빈 폴더가 남지 않습니다.
6. 각 폴더에 `content.json`(원본 메타+섹션), `content.md`(본문 Markdown), `attachments.json`(첨부파일 목록), `manifest.json`(구조화 인덱스용 요약)을 씁니다.

### 옵션

```bash
node collection/download_documents_advanced.js --ministry 고용노동부
node collection/download_documents_advanced.js --retry-targets targets.json
```

`--retry-targets`는 `[{ "apba_id": "...", "report_no": "..." }, ...]` 형식 JSON을 받아 해당 (기관, 공시코드) 조합만 재시도합니다. 소켓 끊김 등으로 부분 실패했을 때 유용합니다.

## 2. 법령·행정규칙 수집 — `collect_legal_corpus.js`

- law.go.kr 법령/행정규칙은 **DRF(Data Reference Framework) JSON API**로 직접 수집합니다. HTML 크롤링 없이 구조화된 본문을 그대로 받아오므로 노이즈가 없습니다.
- 그 외 출처(기재부·고용부 지침 등 HTML/PDF 공지)는 Crawl4AI → kordoc → PaddleOCR 순 폴백 파이프라인을 탑니다.
- 수집 대상 목록은 스크립트 내부에 카테고리별로 정의되어 있으며 `--category`, `--id`로 선택 실행할 수 있습니다.
- `source_manifest.json`에 각 문서의 수집 상태(`planned`/`collected`/`failed`)와 출처 URL을 기록해 재실행 시 이미 수집된 항목은 건너뜁니다.

```bash
source .env.api
node collection/collect_legal_corpus.js --category labor_laws
node collection/collect_legal_corpus.js --retry-failed
node collection/collect_legal_corpus.js --dry-run
```

### 소관부처 보강 — `enrich_legal_ministry.js`

law.go.kr DRF API로 각 법령/행정규칙의 소관부처·담당부서를 `source_manifest.json`에 채웁니다. `LAW_OC` 환경변수(law.go.kr 발급 이용자 ID)가 필요합니다. 이미 채워진 항목은 건너뛰므로 재실행해도 안전합니다(`--force`로 강제 재수집).

## 3. 기관 내부규정 수집 — `collect_institution_bylaws.js`

ALIO `21110`(내부규정) 게시판에서 기관별 규정 유형(`bid_type`)별 최신 파일 1건을 수집합니다.

```bash
node collection/collect_institution_bylaws.js --dry-run      # 목록만 확인
node collection/collect_institution_bylaws.js --apba-id C0847 # 단일 기관
node collection/collect_institution_bylaws.js --survey        # 전체 현황 분석만
```

## 4. 통계 데이터 — `download_statistics.js`

ALIO가 제공하는 통계 엑셀(임직원 수, 평균보수 등)을 다운로드합니다. 이후 `process_statistics.js`(JSON 변환) → `convert_statistics_to_md.js`(Markdown 표 변환) → `build_statistics_index.js`(통합 인덱스)로 이어집니다.

## 5. 신규 공시 모니터링 — `check_disclosure_recency.js`

이미 수집한 데이터 기준으로 ALIO에 새로 올라온 공시를 감지합니다. 정기 실행(cron 등)에 적합합니다.
