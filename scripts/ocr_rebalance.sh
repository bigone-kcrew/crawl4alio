#!/usr/bin/env bash
# OCR 밴드 동적 재배분 모니터 (안정성 중심)
#
# 목적: safe(저RAM·소형 담당) 인스턴스가 자기 밴드를 거의 소진해 놀게 생기면,
#       저밀도 대형 문서를 safe로 편입(OCR_SPLIT_PAGES 상향)해 risky(고RAM) 쪽
#       페이지 병목을 나눠 갖는다. SPLIT 값은 $LOGDIR/ocr_band_config.env에 기록되고,
#       워치독(ocr_watchdog.sh)이 재기동 때 소싱한다(양 인스턴스 동일값 → 상보 유지).
#
# ★ 안정성 불변식 — 하나라도 어기면 실운영에서 사고난다:
#   1) 밀도 임계(OCR_BAND_DENSITY_MAX)는 절대 건드리지 않는다 → 고밀도 문서는 항상 risky.
#      저RAM PC는 저밀도 문서만 받으므로 OOM/hang이 나지 않는다.
#   2) SPLIT은 상향만(하향 없음). 저밀도 대형을 safe로 "넘기기만" 한다.
#   3) STEP씩 조금씩 + MIN_INTERVAL 간격 + SPLIT_CAP 상한 — 느린 PC에 몰아주면 역효과.
#   4) 양 서버 /health 정상일 때만 재기동. 깨진 서버로 재기동하지 않는다.
#   5) recovery(kordoc 회수)가 진행 중(kordoc_pending 비어있지 않음)이면 보류 —
#      pending 제외로 safe 밴드가 실제보다 작아 보여 오발동하기 때문.
#
# 필수 env:
#   CATALOG_ROOT          데이터 루트
#   SAFE_INSTANCE         safe 밴드 인스턴스 이름 (워치독 INSTANCE와 동일)
#   RISKY_INSTANCE        risky 밴드 인스턴스 이름
#   SAFE_HEALTH_URL       safe 쪽 OCR 서버 /health
#   RISKY_HEALTH_URL      risky 쪽 OCR 서버 /health
# 노브:
#   REBALANCE_CHECK(300) REBALANCE_SAFE_MIN(40) REBALANCE_STEP(100)
#   REBALANCE_SPLIT_CAP(400) REBALANCE_MIN_INTERVAL(1800)
#
# Usage:
#   CATALOG_ROOT=/data SAFE_INSTANCE=pc2 RISKY_INSTANCE=pc1 \
#     SAFE_HEALTH_URL=http://PC2:13430/health RISKY_HEALTH_URL=http://PC1:13430/health \
#     bash scripts/ocr_rebalance.sh
# 중지: touch $CATALOG_ROOT/logs/ocr_rebalance.stop
set -u
NODE=${NODE:-node}
: "${CATALOG_ROOT:?CATALOG_ROOT 필요}"
: "${SAFE_INSTANCE:?SAFE_INSTANCE 필요}"
: "${RISKY_INSTANCE:?RISKY_INSTANCE 필요}"
: "${SAFE_HEALTH_URL:?SAFE_HEALTH_URL 필요}"
: "${RISKY_HEALTH_URL:?RISKY_HEALTH_URL 필요}"
LOGDIR=$CATALOG_ROOT/logs
CFG=$LOGDIR/ocr_band_config.env
STOP=$LOGDIR/ocr_rebalance.stop
LOG=$LOGDIR/ocr_rebalance.log

CHECK=${REBALANCE_CHECK:-300}
SAFE_MIN=${REBALANCE_SAFE_MIN:-40}
STEP=${REBALANCE_STEP:-100}
SPLIT_CAP=${REBALANCE_SPLIT_CAP:-400}
MIN_INTERVAL=${REBALANCE_MIN_INTERVAL:-1800}
BASE_SPLIT=${OCR_SPLIT_PAGES:-72}

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cur_split(){ if [ -f "$CFG" ]; then ( . "$CFG"; echo "${OCR_SPLIT_PAGES:-$BASE_SPLIT}" ); else echo "$BASE_SPLIT"; fi; }

# 최신 실행 로그 헤더의 "밴드: <band> ... → N건" = 재기동 시점 실OCR 총량
band_count(){
  local inst=$1 band=$2 f n
  f=$(ls -t "$LOGDIR"/ocr_${inst}_*.log 2>/dev/null | head -1)
  [ -z "$f" ] && { echo 999; return; }
  n=$(grep -oE "밴드: ${band}.*→ [0-9]+건" "$f" 2>/dev/null | grep -oE '→ [0-9]+건' | grep -oE '[0-9]+' | tail -1)
  [ -z "$n" ] && echo 999 || echo "$n"
}

# 이번 런의 실제 OCR 완료 수 = 'OK' 라인 수(DEDUP/CDEDUP 즉시복사는 미포함)
ok_count(){
  local inst=$1 f c
  f=$(ls -t "$LOGDIR"/ocr_${inst}_*.log 2>/dev/null | head -1)
  [ -z "$f" ] && { echo 0; return; }
  c=$(grep -cE '\] OK ' "$f" 2>/dev/null)
  echo "${c:-0}"
}

server_ok(){ timeout 12 "$NODE" -e "
const h=require('http');const u=new URL('$1');
const r=h.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'GET',timeout:10000},x=>process.exit(x.statusCode?0:1));
r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});r.end();" 2>/dev/null; }

risky_has_backlog(){
  local band ok
  band=$(band_count "$RISKY_INSTANCE" risky); ok=$(ok_count "$RISKY_INSTANCE")
  [ "$band" = 999 ] && return 0
  [ $(( band - ok )) -gt 20 ] 2>/dev/null
}

last_rebalance=0
log "재배분 모니터 시작 (SAFE_MIN=$SAFE_MIN STEP=$STEP CAP=$SPLIT_CAP MIN_INTERVAL=${MIN_INTERVAL}s CHECK=${CHECK}s)"
log "  불변식: 밀도 임계 불변(고밀도→risky 고정), SPLIT 상향만, 서버 정상 시에만 재기동"
while true; do
  sleep "$CHECK"
  [ -f "$STOP" ] && { log "중지 플래그 감지 — 종료"; rm -f "$STOP"; exit 0; }

  # recovery 진행 중이면 보류(pending 제외로 safe 밴드가 작아 보이는 오발동 방지)
  if [ -s "$LOGDIR/kordoc_pending.json" ]; then
    pend=$($NODE -e "try{console.log((require('$LOGDIR/kordoc_pending.json').ids||[]).length)}catch{console.log(0)}" 2>/dev/null || echo 0)
    if [ "${pend:-0}" -gt 0 ] 2>/dev/null; then continue; fi
  fi

  split=$(cur_split); now=$(date +%s)
  band=$(band_count "$SAFE_INSTANCE" safe); ok=$(ok_count "$SAFE_INSTANCE")
  remain=$(( band - ok )); [ "$remain" -lt 0 ] && remain=0

  if [ "$remain" -ge "$SAFE_MIN" ]; then continue; fi
  if [ "$split" -ge "$SPLIT_CAP" ]; then continue; fi
  if [ $((now - last_rebalance)) -lt "$MIN_INTERVAL" ]; then continue; fi
  if ! risky_has_backlog; then
    log "safe 소진(잔여 ~$remain)이나 risky backlog 미미 — 재배분 불필요(곧 전체 완료)"
    continue
  fi
  if ! server_ok "$RISKY_HEALTH_URL"; then log "risky 서버 무응답 — 재배분 보류"; continue; fi
  if ! server_ok "$SAFE_HEALTH_URL";  then log "safe 서버 무응답 — 재배분 보류"; continue; fi

  new=$((split + STEP)); [ "$new" -gt "$SPLIT_CAP" ] && new="$SPLIT_CAP"
  echo "OCR_SPLIT_PAGES=$new" > "$CFG"
  log "safe 잔여 ~$remain (<$SAFE_MIN) → 저밀도 대형 이관: OCR_SPLIT_PAGES $split→$new (고밀도는 risky 고정)"
  pkill -9 -f "convert_ocr_needed.js --skip-main-merge" 2>/dev/null
  log "  양 OCR 인스턴스 재기동 신호(워치독이 새 SPLIT로 자동 재기동)"
  last_rebalance=$now
done
