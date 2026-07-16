# rag/ — 조항 검색·RAG 파이프라인 (확장 모듈)

> 수집·변환된 md 코퍼스를 PostgreSQL(pg_trgm+pgvector)로 적재해 조(條) 단위 검색을 제공하는 **선택 확장**입니다.
> 실운영 데이터 워크스페이스를 가리키려면 `RAG_ROOT=/path/to/workspace`를 지정하세요(기본: 저장소 루트).

`2_data`의 md corpus(법령·기관내규·단체협약)를 조(條) 단위로 분절해 PostgreSQL에 적재하고,
키워드(pg_trgm)·의미(pgvector) 검색을 제공한다. 목적: 조항비교, 유사조항 검색, 신규규정 참고.

## 진행 상황 (2026-07-07 기준)

| 단계 | 상태 |
|---|---|
| ① 조항 파서 (`parse_articles.js`) | ✅ 완료 — 조문 1,365,161건 (legal 10,133 / bylaws 1,185,623 / ca 169,405) |
| ② PG 적재 (`load_pg.js`) | ✅ 완료 — alio_rag DB 2GB, pg_trgm GIN 인덱스 |
| ③ 검색 도구 | ✅ 완료 — CLI(`search.js`) + n8n 챗봇 2종 (아래 참조) |
| ④ 임베딩 생성 (`embed_articles.js`) | ✅ 완료 (2026-07-08) — 1,108,255건 전량, 6.8시간, 재시도 1회(502) |
| ⑤ HNSW 인덱스 + `--semantic` 검색 | ✅ 완료 (2026-07-08) — 인덱스 8.7GB(직렬 빌드 18시간), DB 총 17GB |

### ⑤ 의미검색 검증 결과 (2026-07-08, 전량 기준)
- **속도**: 27.7초(무인덱스) → **80~390ms** (필터 조합 시 ~7초: iterative_scan 경유)
- **recall**: 정확검색(순차) top10 대비 평균 **95%** (6개 질의 중 5개 100%, 1개 70%)
- **품질**: 키워드 없는 일상어 질의 6/6 통과 — 예: "잘못을 저지른 직원에 대한 처벌의 종류"→징계의 종류와 효력
- CLI: `node rag/search.js "질의문" --semantic [--inst 기관 --corpus ...]`
- HNSW 빌드 주의(재빌드 시): Docker shm 64MB 제약으로 **병렬 워커 사용 불가** → `SET max_parallel_maintenance_workers=0`(직렬) 필수, J1900에서 18시간 소요. 필터 검색은 `SET hnsw.ef_search=200; SET hnsw.iterative_scan='relaxed_order'` 필요(search.js가 자동 설정)

### ④ 임베딩 상세
- 모델: **NVIDIA NIM API `nvidia/llama-nemotron-embed-1b-v2`**, 1024차원(dimensions 파라미터로 축소), `input_type: passage`(조문)/`query`(검색어) 구분 필수
- 대상: 고유 텍스트 1,108,255건 (전체 136.5만 중 중복 19%는 해시로 벡터 공유)
- 파일럿 검증(1만 건): 무결성 전수 통과, **키워드 없는 일상어 질의 6/6 정답** (예: "잘못을 저지른 직원에 대한 처벌의 종류" → 징계종류 및 기준), 속도 분당 ~2,200건, 오류 0
- 모델 선정 근거: 계정에서 호출 가능한 NIM 임베딩 모델 전수 테스트 결과 한국어 구분력이 있는 유일한 모델(패러프레이즈 갭 0.493). e5-v5는 한국어 무용지물(갭 0.008), bge-m3는 NIM에서 오류, 로컬 CPU(Celeron J1900)는 0.7건/초=455시간이라 배제
- **중단 시 재개**: `node rag/embed_articles.js` 재실행만 하면 됨 — article_embeddings에 있는 해시는 자동 스킵 (체크포인트=DB 자체)
- 완료 후 용량: 벡터 약 6.3GB + HNSW 인덱스 (DB 총 ~12GB 예상, NAS 여유 충분)

## 실행 방법

```bash
# ① 파싱 (md → JSONL, 2_data/_rag_staging/)
node rag/parse_articles.js legal|bylaws|ca

# ② 적재 (멱등 — TRUNCATE 후 재적재)
node rag/load_pg.js

# ③ CLI 검색
node rag/search.js "연차휴가"                        # 조제목 trgm
node rag/search.js "편차보정" --body                 # 본문 ILIKE (3자 이상 권장)
node rag/search.js "제60조" --corpus bylaws          # 조번호 직접
node rag/search.js "징계" --usecase audit,recruit    # 활용처 필터 (콤마=OR, 다중태그 문서 겹침 매칭)
# 옵션: --corpus bylaws|legal|ca|all --type --inst --ministry --usecase --limit --section --json --csv --full
# 활용처 태그·확대 절차: docs/ops/USECASE_GUIDE.md (backfill_usecase.js, documents.usecases text[])

# ④ 임베딩 (재개 가능)
node rag/embed_articles.js --pilot     # 인사·복무 관련 1만 건
node rag/embed_articles.js             # 전량 (미처리분만)
```

## DB 스키마 (alio_rag @ postgres:5432, ai-internal 네트워크)

접속정보: 리포 루트 `.env.api`의 `POSTGRES_USER`/`POSTGRES_PASSWORD`. NVIDIA 키는 `.env.aiapi`.

```
institutions(inst_code PK, inst_name, ministry)                 -- 355
documents(doc_id PK, corpus, inst_code, doc_title, doc_type...) -- 42,471
articles(id PK, doc_id, seq, section 본칙|부칙, art_no, art_sub, title, body) -- 1,365,161
article_hash(id PK → articles.id, text_hash)                    -- md5(title|body) 매핑
embed_queue(text_hash PK, id)                                   -- 고유텍스트 1,108,255 + 대표조문
article_embeddings(text_hash PK, embedding vector(1024), model) -- 생성 중
```

- articles에 해시 컬럼을 직접 추가하지 않은 이유: 2GB 테이블 재작성이 J1900에서 10분+ 타임아웃 → 별도 매핑 테이블로 우회 (articles 무변경 = 검색 무중단)
- pgvector 0.8.4 (2026-07-07 postgres:16-alpine → pgvector/pgvector:pg16 교체, 전 DB REINDEX 완료 — 상세·사고 이력은 request.md "pgvector 확장 설치 절차")

## 쿼리 요령 (성능 함정)

- **trgm**: 조제목(짧은 문자열)에 `%` 연산 → similarity 정렬. 긴 본문을 `%`에 직접 넣으면 GIN이어도 3분+ 타임아웃
- **본문 검색**: `body ILIKE '%키워드%'` — trgm GIN이 가속하지만 **2글자 키워드는 인덱스 못 타서 타임아웃** (3자 이상)
- **의미 검색**: `ORDER BY embedding <=> $1::vector(1024)` — 검색어는 반드시 `input_type:'query'`로 임베딩 (passage와 비대칭)
- 항상 `SET statement_timeout` 걸 것 (n8n 공용 서버)
- 조문 조인: `article_embeddings e JOIN embed_queue q USING(text_hash) JOIN articles a ON a.id=q.id`

## n8n 워크플로우 (172.18.0.1:5678)

| 이름 | ID | 상태 |
|---|---|---|
| ALIO 조항 검색 (DB전용) | `b71Xgd7b5Xw2DZ9c` | 활성 — 태그 `[기관:][유형:][법령][단협][본문]` |
| ALIO 조항 검색 챗봇 (LLM) | `MTe2XDmGnfuXxBXx` | 활성 — LLM 노드는 OpenRouter 크레딧 충전 후 검증 필요 |

DB전용 챗 URL: `http://<NAS>:5678/webhook/721c525f-6bee-4200-a776-7d0ae0f0814d/chat` (로그인 불필요)

## 웹 공개 (2026-07-07 구축)

노조 임원이 브라우저에서 조항 검색을 쓸 수 있도록 API+웹 UI로 공개.

```
Vercel(프론트, alio-rag-web) → Tailscale Funnel(공개 HTTPS) → 이 NAS의 rag-api 컨테이너 → postgres(alio_rag)
```

- **API 서버**: `rag/api_server.js` — `search.js`의 `buildQuery()`를 그대로 재사용(리팩터링: `search.js`에 `module.exports` 추가, `require.main` 가드로 CLI 동작은 그대로 유지). `GET /api/health`(무인증), `GET /api/search`(`X-Api-Key` 헤더 필요).
- **접근 통제**: `.env.api`의 `RAG_API_KEY`(이 세션에서 생성해 추가함)를 API 서버가 대조. 프론트엔드 게이트(최초 접속 시 키 입력, `localStorage` 저장)는 UX용일 뿐 실제 보안 경계는 API 서버 쪽 검사.
- **프론트엔드**: 별도 저장소 [bigone-kcrew/alio-rag-web](https://github.com/bigone-kcrew/alio-rag-web)(private) — 정적 HTML/CSS/vanilla JS, Vercel 배포. `/workspace/alio`가 git 저장소가 아니라 분리(crawl4alio와 동일 패턴).
- **배포 런북**: `docs/ops/RAG_WEB_DEPLOY.md` — Dockerfile 빌드, NAS `docker-compose.yml`에 `rag-api` 서비스 추가(수작업, 이 저장소엔 실제 compose 파일 없음), Tailscale Funnel 노출, 문제 해결 순서.
- **로컬 E2E 검증 완료**(이 세션): API 인증(401/200), `search.js`와 동일한 검색 결과, 프론트엔드가 기대하는 `{rows, count, elapsed_ms}` 응답 계약 확인. **NAS 컨테이너 배포·Tailscale Funnel 노출·Vercel 연동은 사용자가 직접 실행 필요**(이 세션 환경에서 실제 NAS docker/tailscale/Vercel 접근 불가).
- **의미검색 미포함**: 임베딩 전량 작업 진행 중이라 1차 공개는 키워드(pg_trgm) 검색만. 완료 후 `--semantic` 추가 시 `api_server.js`에도 동일 분기 추가 필요(아래 "다음 단계" 참고).

## 다음 단계 (선택)

1. `api_server.js`의 `/api/search`에 semantic 분기 추가 (search.js의 `embedQuery`/`buildSemanticQuery` export 재사용)
2. n8n 챗봇에 `[의미]` 태그 추가 검토
3. 원본(2_data) 재수집 시: `load_pg.js` 재적재 후 `embed_articles.js` 재실행 — 변경된 텍스트만 새 해시로 임베딩됨(기존 해시 스킵). article_hash/embed_queue 재생성 필요.
