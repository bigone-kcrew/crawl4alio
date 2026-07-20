# OCR 스케일아웃 (여러 CPU에 분산)

> `convert_ocr_needed.js` 환경변수로 스캔 문서 OCR을 여러 대에 나눠 처리. 정적 분할이라 인스턴스 간 겹침·누락 0. (README 설정 섹션에서 분리)


| 변수 | 용도 |
|------|------|
| `OCR_ORDER` | `asc`(소형 먼저) / `desc`(대형 먼저) |
| `OCR_BAND` | 담당 밴드(상보 분할). **`safe`↔`risky` 권장**(메모리+속도 균형, 아래) · `light`/`heavy`(크기) · `small`/`big`(크기+페이지) · 미지정 시 페이지 밴드 |
| `OCR_PAGE_MIN` / `OCR_PAGE_MAX` | (레거시) 페이지 밴드로 담당 구간 제한 |
| `OCR_BAND_SIZE_MAX_MB` | 메모리 안전 경계(기본 0.9). 초과=고해상도 위험 → `risky`(고RAM PC)로 |
| `OCR_BAND_DENSITY_MAX` / `OCR_BAND_MIN_PAGES` | 대용량이라도 **저밀도(MB/page↓)·다페이지**면 저RAM PC가 소청크로 안전 처리(기본 0.5 / 3p) |
| `OCR_SPLIT_PAGES` | **페이지 균형점**. 이 페이지수 이상 문서는 빠른 PC로 강제(느린 PC 과부하 방지) |
| `OCR_CHUNK_PAGES` | 요청당 페이지(저RAM PC는 6~8로 낮춰 요청당 메모리 상한, 기본 50) |
| `OCR_MAX_TIMEOUT` | 요청 타임아웃 상한(ms). 스토리지 스래시 fail-fast |
| `OCR_QUARANTINE_PATH` | OOM 유발 문서 목록(`safe`서 제외/`risky`서 포함) — 자기치유 격리 |
| `OCR_INFLIGHT_PATH` | 처리 중 문서 경로 기록(외부 워치독이 hang 시 격리 대상 식별) |
| `OCR_CKPT_PATH` / `OCR_LOCK_PATH` | 인스턴스별 체크포인트·락 분리 |
| `OCR_SHARD` | **N대 확장**: `i/n`(0-based) 해시 샤딩 — 밴드와 조합 가능. 예: 4대 = risky 1대 + safe×`0/3`,`1/3`,`2/3` |
| `KORDOC_OCR` / `PADDLEOCR_PARSE_URL` | 워커 OCR: kordoc 내장 `KORDOC_OCR=1`(기본·서버 불필요) / (legacy) PaddleOCR 워커 주소 |

**균형 원칙 (실운영 교훈)** — 두 축을 함께 봐야 함:
- **메모리 안전** — 고해상도(디코딩 시 픽셀 폭증) 문서는 저RAM PC를 OOM시킨다. 압축 크기·MB/page로 걸러 고RAM PC로.
- **속도 균형** — 느린 PC에 페이지를 몰면 병렬화가 오히려 역효과. 총 페이지를 CPU 속도비로 분배(`OCR_SPLIT_PAGES`). *실측 예: 밀도만으로 나눴더니 다페이지 문서가 느린 PC로 몰려 10.6일 → 페이지 균형 적용 후 5일.*

```bash
# 예: 고RAM·빠른 PC1(위험·대형) / 저RAM·느린 PC2(안전·소형), 페이지 균형 72p — kordoc 내장 OCR(서버 불필요)
# PC1 (예: 12GB) — 고해상도·72p 이상 대형 담당
KORDOC_OCR=1 OCR_BAND=risky OCR_SPLIT_PAGES=72 OCR_ORDER=desc \
  OCR_CKPT_PATH=$D/ck_pc1.json OCR_LOCK_PATH=$D/pc1.lock npm run convert:ocr
# PC2 (예: 6GB) — 저밀도·72p 미만 소형만, 소청크·타임아웃·격리
KORDOC_OCR=1 OCR_BAND=safe OCR_SPLIT_PAGES=72 OCR_CHUNK_PAGES=6 OCR_MAX_TIMEOUT=480000 OCR_ORDER=asc \
  OCR_QUARANTINE_PATH=$D/quarantine.txt OCR_INFLIGHT_PATH=$D/pc2.inflight \
  OCR_CKPT_PATH=$D/ck_pc2.json OCR_LOCK_PATH=$D/pc2.lock npm run convert:ocr
```
> 밴드/샤드/타임아웃 노브는 엔진 무관 — legacy PaddleOCR로 돌리려면 각 줄의 `KORDOC_OCR=1` 대신 `OCR_ENGINE=paddleocr PADDLEOCR_PARSE_URL=http://PCx:13430/parse`.
> 저RAM PC OCR엔 **RSS 초과·hang 시 자가종료**(컨테이너 `restart`로 재기동)를 넣으면 드문 OOM 문서도 무인 자기치유된다(자가종료→재기동→클라이언트가 `OCR_INFLIGHT_PATH` 문서를 `OCR_QUARANTINE_PATH`로 올려 고RAM PC 이관). 저사양 오케스트레이터(변환·서빙 전담)는 `KORDOC_OCR`을 끄면(기본) OCR 부하를 안 받는다.

