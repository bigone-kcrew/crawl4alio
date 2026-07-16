# OCR Markdown 후처리 — `postprocess/`

스캔 PDF를 OCR한 Markdown은 조문 경계가 붙거나 순번 표식이 탈락하는 등 구조 손상이 흔합니다. `postprocess/`는 이런 손상을 **보수적으로** 정리하는 도구 모음입니다 — 원문 의미·맞춤법·표·산식·페이지 주석은 절대 추정 보정하지 않고, 앞뒤 구조가 모두 확인되는 경우에만 자동 변경합니다.

32만+ 파일 실운영에서 여러 차례의 감사–적용–재감사 사이클을 거치며 다듬어졌고, 그 과정에서 나온 실패 사례(과다 승격 945건 복구 등)가 규칙에 반영돼 있습니다.

## 도구

| 도구 | 역할 | 자동 수정 |
|---|---|---|
| `clean_alio_markdown.js` | 조문(`제n조`) 경계 문단 분리, 붙은 항·호·목 표식 줄바꿈 | ✅ (엄격 조건) |
| `audit_article_heading_gaps.js` | Markdown 조 제목(`### 제n조`) 누락 후보 감사 | ❌ 목록만 |
| `fix_article_heading_gaps.js` | 감사 후보 중 **제목만 있는 줄**을 `###`로 승격 | ✅ (아래 원칙) |
| `audit_nested_marker_gaps.js` | 탈락한 순번 표식(`① 2 ③` 등) 후보 감사 | ❌ 목록만 |
| `fix_nested_marker_gaps.js` | 앞뒤 연속 순번이 확인되는 표식만 복원 | ✅ (엄격 조건) |

## 절대 원칙 (전 도구 공통)

1. **manifest 입력 고정** — 라이브 트리 재스캔 없이 명시된 파일 목록만 연다. 목록 밖 수정 0건을 검증한다.
2. **candidate / applied / residual 로그 분리** — 무엇을 후보로 봤고, 무엇을 적용했고, 무엇이 남았는지 JSONL로 남긴다.
3. **재실행 멱등성** — 동일 조건 재실행에서 `changed=0`이어야 한다.
4. **기본 dry-run** — `--write` 없이는 파일을 수정하지 않는다.
5. **의미 추정 금지** — OCR 오탈자·붙은 단어·`O/0/ㅇ` 혼동은 원본 PDF 대조 없이 복원하지 않는다.

## 실운영에서 배운 규칙 (코드에 반영됨)

- **조 제목 승격은 "제목만 있는 줄"만.** `제2조(목적) 본 협약은...`처럼 본문이 붙은 줄을 그대로 `###`로 승격하면 제목·본문이 한 줄에 붙어 Markdown 계층과 조문 파서가 깨진다 — 실감사에서 과다 승격 945건 중 944건이 이 형태였고 전량 복구했다. 현재 `fix_article_heading_gaps.js`는 닫는 괄호 뒤가 비어 있어야만 승격하고, 본문이 붙은 줄은 `title_body_split_candidate`로 리포트에만 기록한다.
- **순번 표식 복원은 이웃 검증 필수.** `① ... / 2... / ③ ...`처럼 바로 앞·뒤가 같은 형식의 연속 순번일 때만 가운데 표식 하나를 복원한다.
- **숫자 줄바꿈 후보는 자동 처리 금지** — 날짜·소수·페이지번호·표 숫자가 섞여 있다.
- **제외 경로**: 내규·법령·지침·세칙·예규 등 규정성 문서, 신구대비표·개정안, 삭제 조문. 이들은 인용·대비 구조 보존이 우선이다.
- **인라인·중첩 표식**(흐름도 요소, 표 열 병합, `(현행과 같음)` 등)은 줄분리가 의미를 바꿀 수 있어 **후보 탐지까지만** — 자동 수정하지 않고 문서 유형별 검토 큐로 남긴다.

## 사용 절차 (감사 → dry-run → 적용 → 재감사)

```bash
# 0) 대상 manifest 산출 (예: OCR 산출물만)
grep -rlm1 "^ocr_service: paddleocr" "$DATA/alio-md/자료/기관별공시" > $DATA/logs/ocr_done_manifest.txt

# 1) 구조 정리 (dry-run 검토 후 --write)
node postprocess/clean_alio_markdown.js --manifest=$DATA/logs/ocr_done_manifest.txt --limit=999999
node postprocess/clean_alio_markdown.js --manifest=... --limit=999999 --write --report=$DATA/logs/cleanup_applied.jsonl

# 2) 조 제목 감사 → 제목-only만 승격
node postprocess/audit_article_heading_gaps.js --root=$DATA/alio-md/... --report=$DATA/logs/heading_candidates.jsonl
node postprocess/fix_article_heading_gaps.js --input=$DATA/logs/heading_candidates.jsonl --report=... [--write]

# 3) 순번 표식 감사 → 이웃 검증 복원
node postprocess/audit_nested_marker_gaps.js --manifest=... --report=$DATA/logs/marker_candidates.jsonl
node postprocess/fix_nested_marker_gaps.js --input=$DATA/logs/marker_candidates.jsonl --report=... [--write]

# 4) 재감사: 동일 조건 잔여 0건 + 재실행 changed=0 확인
```

## 검증 기준

- 동일 조건 재실행 `changed=0` / 적용 후 같은 규칙 잔여 후보 0건
- OCR 마커(`ocr_service:` 헤더)·표 구분선·페이지 주석 보존
- 조문 번호 유실·본문 문장 병합 없음
- manifest 밖 경로 수정 0건
