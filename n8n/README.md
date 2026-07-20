# n8n 증분 수집 자동화 (선택)

ALIO 정기/수시 공시 증분을 **감지 → 텔레그램 알림·버튼 승인 → 수집·적재 → 완료 통지**로 자동화하는 n8n 워크플로 묶음. n8n은 셸 실행 노드가 없어, 수집 파이프라인은 **HTTP 래퍼(`periodic_server.js`)** 를 통해 호출한다.

## 구성

```
n8n 스케줄(감지) ─HTTP→ periodic_server.js ─spawn→ run_periodic.sh(detect)
     │                         └ summary.json 디제스트 반환
     ▼
텔레그램 알림 + [✅수집][⏭건너뛰기] 버튼
     │ (승인 콜백)
     ▼
증분승인 WF ─HTTP(apply)→ periodic_server ─spawn→ run_periodic.sh <track> --apply
                                              └ 완료 시 완료-웹훅 POST → 완료통지 WF → 텔레그램
```

- **정기감지 / 수시감지**: 스케줄 트리거 → `POST /periodic/run {track:"detect"}` → 신규 있으면 알림.
- **증분승인**: 텔레그램 콜백(`alio:approve|skip:<track>`) → 승인 시 `POST /periodic/run {track,apply:true}`.
- **완료통지**: `periodic_server`가 apply 완료/실패 후 보내는 웹훅(`/webhook/alio-done`) 수신 → 텔레그램.

## 파일
- `workflows/*.json` — n8n 워크플로 4종(가져오기용, **새니타이즈됨** — 아래 플레이스홀더 치환 필요).
- `periodic_server.js` — 파이프라인 호스트에서 상시 실행하는 HTTP 래퍼(:8092). 로직은 `run_periodic.sh`에 있고 여기선 호출만. `run_periodic.sh`는 사이트별 경로가 있어 각자 환경에 맞게 둔다.

## 설정
1. **워크플로 가져오기**: n8n UI → Import → `workflows/*.json`.
2. **크리덴셜 생성 후 연결**(플레이스홀더 치환):
   | 플레이스홀더 | 의미 |
   |---|---|
   | `<TELEGRAM_CRED_ID>` / `<CRED_ID>` | 텔레그램 봇 크리덴셜 ID |
   | `<PIPELINE_TOKEN_CRED_ID>` | Header Auth(`X-Pipe-Token: <PIPELINE_TOKEN>`) 크리덴셜 ID |
   | `<TELEGRAM_CHAT_ID>` | 알림 받을 텔레그램 chat id |
   | `<N8N_HOST>` | n8n 호스트명(내부 DNS) |
   | `<PIPELINE_HOST>` | periodic_server 호스트명(내부 DNS) |
3. **periodic_server 실행**(파이프라인 호스트): env `PIPELINE_TOKEN`(엔드포인트 인증), `N8N_DONE_WEBHOOK=http://<N8N_HOST>:5678/webhook/alio-done`.
4. **활성화 + 스케줄**: 워크플로 활성화. 크론은 **워크플로 settings.timezone을 `Asia/Seoul` 등으로 명시**할 것(미설정 시 인스턴스 기본값=UTC라 어긋남). 예: 수시=`0 9 * * 5`(금 09시), 월간=`0 9 15 * *`(15일 09시), 정기=`0 9 1 5,8,11,2 *`.

## 트랙(track)
- **recruit**(수시, 시간민감): 채용 등. 주간 권장.
- **monthly**(참조성): 규정·이사회·임원 등. 월간 권장(볼륨↑·시간민감↓).
- **quarterly/annual**(정기공시): 분기/연간.
- **detect**: 수집 없이 감지만(디제스트 반환).
- 감지 WF는 각각 track을 지정해 `alio:approve:<track>` 버튼을 보내고, 증분승인 WF가 track을 그대로 apply로 전달한다.

## 메시지 규칙
- 모든 알림 `[ALIO]` 접두 + 이모지(🔔감지·🚀시작·✅완료·⚠️오류·⏭건너뜀). 콜백은 `alio:` 네임스페이스만 처리(공유 봇 간섭 차단).
- n8n 텍스트 필드는 `\uXXXX`를 해석하지 않으니 **이모지는 리터럴**로 넣는다.
- 텔레그램 answerCallbackQuery 등은 출력이 아이템을 덮으므로, 데이터가 필요한 downstream은 **파싱 노드에서 fan-out**한다.
