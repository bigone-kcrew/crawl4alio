# 설치 가이드 (풀스택 프로필)

일반 PC/미니PC(Intel N100급 이상, 8GB RAM) 한 대에 전체 스택을 설치하는 절차입니다.
최소 프로필(Node만, Docker 없이)은 [README](../README.md#빠른-시작)의 빠른 시작을 따르세요.

## 0. 사전 준비물

| 항목 | 설치 방법 |
|---|---|
| Git | https://git-scm.com/downloads |
| Node.js 18+ | https://nodejs.org (LTS 권장) |
| Docker 엔진 (**이미 설치돼 있다면 생략**) | 컨테이너 실행 기반 자체 — 없을 때만: **Windows/Mac** [Docker Desktop](https://www.docker.com/products/docker-desktop/) · **Linux** `curl -fsSL https://get.docker.com \| sh` 후 `sudo usermod -aG docker $USER` (재로그인) |
| law.go.kr API 키 | https://open.law.go.kr 에서 회원가입 → Open API 신청 → 이용자 ID(OC) 확인 (법령 수집 시에만 필요) |

## 1. 저장소 설치

```bash
git clone https://github.com/bigone-kcrew/crawl4alio.git
cd crawl4alio
npm install                # kordoc(HWP 파서) 포함 — 별도 파서 설치 불필요
cp .env.example .env.api   # 편집: OPENAPILAWKEY(law.go.kr 키) 입력
```

## 2. 파서 컨테이너 기동

이 프로젝트가 쓰는 컨테이너(crawl4ai 공식 이미지, paddleocr 자체 이미지)는 **별도 설치 과정이 없습니다** —
아래 명령 한 번이면 이미지 다운로드부터 실행까지 자동으로 끝납니다(Docker 엔진만 있으면 됨).

```bash
cd deploy
docker compose up -d crawl4ai paddleocr   # 이미지 자동 pull/build + 컨테이너 기동
docker compose ps          # 두 서비스 Up 확인
```

- **paddleocr 최초 기동**: PP-StructureV3 모델 다운로드(수백 MB)로 첫 요청까지 수 분 걸립니다.
  모델은 `paddlex-models` 볼륨에 저장되어 재기동 시 즉시 사용됩니다.
  로딩 상태 확인: `curl http://localhost:13430/health` → `"ready": true`
- **crawl4ai 확인**: `curl http://localhost:11235/health`

## 3. 앱 실행 방식 선택

**방법 A — 호스트 Node로 실행 (권장, 간단)**
파서만 컨테이너로 두고 수집·변환 명령은 호스트에서 직접 실행합니다.

```bash
cd ..                      # 저장소 루트로
source .env.api
node collection/check_services.js   # 전부 ✅ 인지 확인
```

**방법 B — 앱까지 컨테이너로 실행**
호스트에 Node를 설치하고 싶지 않을 때. 수집 데이터는 호스트의 `data/` 폴더에 저장됩니다(볼륨 마운트).

```bash
cd deploy
docker compose run --rm app                            # check_services 진단
docker compose run --rm app npm run sync:alio          # 이후 모든 명령은 이 형태
```

## 4. 첫 수집 검증 (소규모)

```bash
# 수집 범위 미리보기 (기본 25개 항목)
node collection/download_documents_advanced.js --print-scope

# 기관 1곳 × 항목 1개만 시험 수집
node collection/download_documents_advanced.js --apba-ids C0451 --items 21026 --limit 1

# 변환 파이프라인 확인
node collection/build_download_file_index.js
npm run convert:markdown        # OK(kordoc) 로그 확인
npm run convert:ocr             # 스캔 PDF가 있었다면 PaddleOCR 처리
```

`data/structured_data/[부처]기관명_코드/` 아래에 파일이 생기면 성공입니다.
이후 본 수집은 `--categories`/`--scope all` 등으로 범위를 넓혀 실행하세요 ([COLLECTION.md](COLLECTION.md)).

## 5. 자동화 (cron)

```cron
# 매일 06:00 신규 공시 감지 (리포트만 — 반자동)
0 6 * * * cd /path/to/crawl4alio && node collection/sync_alio.js >> data/logs/cron_sync.log 2>&1

# 매주 일요일 03:00 전수 대조 + 자동 수집·변환
0 3 * * 0 cd /path/to/crawl4alio && node collection/sync_alio.js --full --mode=apply && npm run convert:markdown >> data/logs/cron_full.log 2>&1

# 매월 1일 법령 개정 감지 (리포트 검토 후 수동 --apply 권장)
0 9 1 * * cd /path/to/crawl4alio && node collection/sync_legal.js >> data/logs/cron_legal.log 2>&1
```

## 6. 업데이트·유지보수

```bash
git pull && npm install                      # 코드·kordoc 업데이트
cd deploy && docker compose build paddleocr && docker compose up -d   # 래퍼 변경 시 재빌드
docker compose logs -f paddleocr             # OCR 서버 로그
```

- 수집 데이터(`data/`)와 `.env.api`는 git 관리 밖이므로 업데이트에 영향받지 않습니다.
- 문제 발생 시: `node collection/check_services.js`로 진단 → [CLAUDE.md](../CLAUDE.md)의 트러블슈팅 표 참조.
