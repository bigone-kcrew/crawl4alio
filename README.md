# crawl4alio

**GitHub**: https://github.com/bigone-kcrew/crawl4alio

공공기관 경영정보 공개시스템([ALIO](https://www.alio.go.kr))과 국가법령정보([law.go.kr](https://www.law.go.kr)), 기관 내부규정 게시판을 수집하고, 첨부파일(HWP/PDF/XLSX 등)을 Markdown으로 변환하는 Node.js 도구 모음입니다.

> 이 저장소는 **수집·변환 방법론(코드)만 배포**합니다. 실제로 수집된 데이터(경영공시 첨부파일, 법령 원문, 기관 내규 등)는 포함하지 않습니다. 각자 환경에서 직접 수집해서 사용하세요.

## 무엇을 할 수 있나요

1. **ALIO 경영공시 수집** — 355개 공공기관의 노동조합/인력관리/보수관리/복리후생 등 원하는 공시 항목을 대상 기관·연도 범위로 지정해 상세페이지와 첨부파일을 수집
2. **법령·행정규칙 수집** — law.go.kr Open API(DRF)로 법령 원문을 구조화 수집, 그 외 부처 지침은 크롤링+변환
3. **기관 내부규정 수집** — ALIO `21110` 내부규정 게시판에서 기관별 최신 규정 파일 수집
4. **Markdown 변환 파이프라인** — HWP/PDF/XLSX/DOCX 등을 kordoc → markitdown → PaddleOCR(스캔 문서) 순으로 폴백하며 변환

## 아키텍처

```
                         ┌───────────────────┐
  ALIO 상세페이지  ───▶  │     Crawl4AI       │  (Docker, 별도 배포 필요)
                         └────────┬──────────┘
                                  ▼
                     content.json / content.md / 첨부파일 다운로드
                                  ▼
              ┌───────────────────────────────────────┐
              │  변환 파이프라인 (fallback 체인)          │
              │  kordoc  ──(실패)──▶  markitdown         │
              │     │                                   │
              │  (스캔 PDF 등 텍스트 추출 실패)             │
              │     ▼                                   │
              │  PaddleOCR                              │
              └───────────────────────────────────────┘
                                  ▼
                         기관별 .md 산출물
```

`Crawl4AI`, `kordoc`, `markitdown`, `PaddleOCR`은 이 저장소에 포함되지 않은 **외부 서비스**입니다. 각자 Docker 등으로 띄우고 엔드포인트를 `.env.api`에 지정해야 합니다. 자세한 내용은 [docs/CONVERSION.md](docs/CONVERSION.md)를 참고하세요.

- Crawl4AI: https://github.com/unclecode/crawl4ai (LLM 친화적 웹 크롤러)
- MarkItDown: https://github.com/microsoft/markitdown (MS의 범용 문서→Markdown 변환기)
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR (OCR 엔진)
- kordoc: https://github.com/chrisryugj/kordoc (한글(HWP) 계열 문서를 Markdown으로 변환하는 파서 서버)

## 빠른 시작

```bash
npm install
cp .env.example .env.api
# .env.api에 Crawl4AI/kordoc/markitdown/PaddleOCR 엔드포인트, law.go.kr API 키 등을 채운 뒤
source .env.api

# 1. ALIO 경영공시 수집 (config/crawl_targets.yaml 기준 항목·연도만)
npm run collect:alio

# 2. 다운로드된 첨부파일 인덱스 생성
npm run build:file-index

# 3. Markdown 변환 (kordoc → markitdown)
npm run convert:markdown

# 4. 위에서 OCR 필요로 분류된 스캔 문서 처리
npm run convert:ocr
```

더 자세한 사용법과 각 스크립트의 역할은 [docs/COLLECTION.md](docs/COLLECTION.md), [docs/CONVERSION.md](docs/CONVERSION.md)를 참고하세요.

## 폴더 구조

```
crawl4alio/
├── collection/                  # 수집·변환 스크립트
│   ├── download_documents_advanced.js   # ALIO 경영공시 메인 크롤러
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

## 법적/윤리적 참고사항

- ALIO·law.go.kr 데이터는 공공누리(공공저작물) 또는 공공데이터법에 따라 공개된 정보입니다. 각 사이트의 이용약관과 저작권 표시 규정을 확인하세요.
- law.go.kr Open API는 사전에 [이용자 등록](https://open.law.go.kr)이 필요하며, 발급받은 ID를 본인 명의로만 사용하세요.
- 과도한 동시 요청은 대상 서버에 부담을 줄 수 있습니다. 기본 동시성 설정(`CONCURRENT` 등)과 `random_delay` 설정을 참고해 매너 있게 수집하세요.
- 기관 내부규정 등 제3자 문서를 재배포할 때는 해당 기관의 공개 범위와 저작권을 확인하세요.

## 라이선스

MIT License. [LICENSE](LICENSE) 참고.
