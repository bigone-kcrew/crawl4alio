#!/usr/bin/env bash
# OCR 라운드 완주 감시 → 최종 병합 → 뒷정리 (일회성 감시자)
#
# 멀티 PC OCR(--skip-main-merge)의 마지막 퍼즐: 큐가 다 소진됐는지 지켜보다가,
# 완주가 확정되면 merge_ocr_instance_ckpts.js로 인스턴스 성공을 메인 체크포인트에
# 반영하고, 검증이 통과한 경우에만 워치독·재배분 모니터를 정리한다.
#
# 완주 판정(이중 확인):
#   1) 큐(ocr_needed.json)의 모든 항목이 어느 ck에서든 success 또는 ocr_failed
#   2) 모든 인스턴스의 최신 실행 로그가 "처리할 파일 없음"(빈 재분류 안정 상태)
# 병합 검증(merge 스크립트 exit 0 = 잔여 ocr_needed가 전부 영구실패)이 실패하면
# 아무것도 죽이지 않고 수동 확인을 요청한 채 종료한다.
#
# 필수 env:
#   CATALOG_ROOT     데이터 루트
#   OCR_INSTANCES    인스턴스 이름 목록(콤마) — 워치독 INSTANCE와 동일 (예: pc1,pc2)
# 선택 env:
#   WATCH_INTERVAL(600)  판정 주기(초)
#
# Usage:
#   CATALOG_ROOT=/data OCR_INSTANCES=pc1,pc2 bash scripts/watch_final_merge.sh &
# 로그: $CATALOG_ROOT/logs/final_merge_watch.log
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE=${NODE:-node}
: "${CATALOG_ROOT:?CATALOG_ROOT 필요}"
: "${OCR_INSTANCES:?OCR_INSTANCES 필요 (예: pc1,pc2)}"
L=$CATALOG_ROOT/logs
LOG=$L/final_merge_watch.log
INTERVAL=${WATCH_INTERVAL:-600}
log(){ echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }

log "감시 시작 (INSTANCES=$OCR_INSTANCES, ${INTERVAL}s 주기)"
while true; do
  sleep "$INTERVAL"
  COMPLETE=$(cd "$L" && OCR_INSTANCES="$OCR_INSTANCES" $NODE -e "
const fs=require('fs');const rd=p=>JSON.parse(fs.readFileSync(p,'utf8'));
try{
  const insts=process.env.OCR_INSTANCES.split(',').map(s=>s.trim()).filter(Boolean);
  const q=(rd('ocr_needed.json').files||[]);
  const files=['ocr_checkpoint.json',...insts.map(i=>'ocr_ck_'+i+'.json')]
    .filter(f=>fs.existsSync(f)).map(f=>rd(f).files);
  let open=0;
  for(const it of q){
    const st=files.map(f=>f[it.id]).filter(Boolean);
    if(!(st.some(v=>v.status==='success')||st.some(v=>v.status==='ocr_failed')))open++;
  }
  console.log(open===0?'YES':'NO:'+open);
}catch(e){console.log('ERR:'+String(e.message).slice(0,40));}
" 2>/dev/null) || COMPLETE="ERR:node"
  log "완주판정: $COMPLETE"
  [ "$COMPLETE" = "YES" ] || continue

  stable=1
  IFS=',' read -ra INSTS <<< "$OCR_INSTANCES"
  for inst in "${INSTS[@]}"; do
    f=$(ls -t "$L"/ocr_${inst}_*.log 2>/dev/null | head -1)
    grep -q "처리할 파일 없음" "$f" 2>/dev/null || { stable=0; break; }
  done
  [ "$stable" = 1 ] || { log "큐 소진, 로그 안정 대기"; continue; }

  log "★ 완주 확정 — 최종 병합 실행"
  CATALOG_ROOT="$CATALOG_ROOT" $NODE "$REPO/scripts/merge_ocr_instance_ckpts.js" --instances="$OCR_INSTANCES" 2>&1 | tee -a "$LOG"
  MRC=${PIPESTATUS[0]}
  log "병합 exit=$MRC"
  if [ "$MRC" -eq 0 ]; then
    log "뒷정리: 재배분 중지 + 워치독/인스턴스 종료"
    touch "$L/ocr_rebalance.stop"
    for p in $(pgrep -x bash 2>/dev/null); do
      tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | grep -qE 'ocr_watchdog\.sh' || continue
      i=$(tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep '^INSTANCE=' || true)
      [ -n "$i" ] && kill "$p" 2>/dev/null
    done
    sleep 2
    pkill -9 -f "convert_ocr_needed.js --skip-main-merge" 2>/dev/null
    log "✅ 라운드 완주 + 병합 + 정리 완료"
  else
    log "⚠️ 병합 검증 실패(exit $MRC) — 수동 확인 필요, 프로세스 유지"
  fi
  break
done
