#!/usr/bin/env bash
# OCR 인스턴스 워치독 — convert_ocr_needed.js를 무인 감독한다.
#
# 하는 일:
#   - 프로세스가 죽으면(크래시·OOM) 재기동
#   - 로그가 STALL_SEC 이상 조용하면 정체로 보고 강제 재기동
#   - 큐가 비어 "처리할 파일 없음"으로 끝나면 EMPTY_BACKOFF만큼 쉬었다 재확인(churn 방지)
#   - 재기동 때마다 $LOGDIR/ocr_band_config.env를 소싱 → 재배분 모니터(ocr_rebalance.sh)가
#     올려둔 OCR_SPLIT_PAGES를 반영해 새 경계로 재분류
#
# 정체 판정은 실행 로그 mtime 기준이다. inflight 파일은 문서 단위로만 갱신돼
# 대형 다청크 문서(20분+ 정상 처리)를 오인 종료시킨다 — 실제로 당해보고 고친 부분.
#
# 필수 env:
#   INSTANCE              인스턴스 이름 (체크포인트·락·로그 파일명에 사용, 예: pc1)
#   CATALOG_ROOT          데이터 루트 (logs/ 하위에 상태 파일)
#   PADDLEOCR_PARSE_URL   이 인스턴스가 붙을 OCR 서버
# 선택 env (convert_ocr_needed.js로 그대로 전달):
#   OCR_BAND OCR_SPLIT_PAGES OCR_BAND_SIZE_MAX_MB OCR_BAND_DENSITY_MAX OCR_BAND_MIN_PAGES
#   OCR_CHUNK_PAGES OCR_MAX_TIMEOUT OCR_ORDER OCR_QUARANTINE_PATH OCR_SHARD(i/n, N대 샤딩)
# 워치독 자체 노브:
#   STALL_SEC(1200)       로그 무활동 정체 판정 초. 대형 문서 담당 인스턴스는 2400 권장
#   CHECK_INTERVAL(60)    점검 주기
#   EMPTY_BACKOFF(300)    큐 소진 시 재기동 대기
#
# Usage:
#   INSTANCE=pc1 CATALOG_ROOT=/data OCR_BAND=risky OCR_SPLIT_PAGES=72 \
#     PADDLEOCR_PARSE_URL=http://PC1:13430/parse bash scripts/ocr_watchdog.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE=${NODE:-node}
: "${INSTANCE:?INSTANCE 이름 필요 (예: pc1)}"
: "${CATALOG_ROOT:?CATALOG_ROOT 필요}"
: "${PADDLEOCR_PARSE_URL:?PADDLEOCR_PARSE_URL 필요}"
export CATALOG_ROOT PADDLEOCR_PARSE_URL
LOGDIR=$CATALOG_ROOT/logs
mkdir -p "$LOGDIR"
STALL_SEC=${STALL_SEC:-1200}
CHECK_INTERVAL=${CHECK_INTERVAL:-60}
EMPTY_BACKOFF=${EMPTY_BACKOFF:-300}
BAND_CONFIG=$LOGDIR/ocr_band_config.env

# 인스턴스별 상태 파일 — 이름 규약을 재배분 모니터와 공유한다
export OCR_CKPT_PATH=${OCR_CKPT_PATH:-$LOGDIR/ocr_ck_${INSTANCE}.json}
export OCR_LOCK_PATH=${OCR_LOCK_PATH:-$LOGDIR/ocr_${INSTANCE}.lock}
export OCR_INFLIGHT_PATH=${OCR_INFLIGHT_PATH:-$LOGDIR/ocr_${INSTANCE}.inflight}
PIDFILE=$LOGDIR/ocr_watchdog_${INSTANCE}.pid

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
is_alive(){ [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

start_instance(){
  rm -f "$OCR_LOCK_PATH" "$OCR_INFLIGHT_PATH"
  # 동적 재배분: 공유 config의 OCR_SPLIT_PAGES 오버라이드(양 인스턴스 동일값 → 밴드 상보 유지).
  # ⚠️ 밀도 임계(OCR_BAND_DENSITY_MAX)는 여기서 바꾸지 않는다 — 고밀도 문서가 저RAM PC로 새면 OOM.
  if [ -f "$BAND_CONFIG" ]; then . "$BAND_CONFIG"; export OCR_SPLIT_PAGES; fi
  RUN_LOG=$LOGDIR/ocr_${INSTANCE}_$(date +%Y%m%d_%H%M%S).log
  log "기동: OCR_BAND=${OCR_BAND:-미지정} chunk=${OCR_CHUNK_PAGES:-50} SPLIT=${OCR_SPLIT_PAGES:-미지정} → $RUN_LOG"
  ( cd "$REPO" && $NODE collection/convert_ocr_needed.js --skip-main-merge ) >"$RUN_LOG" 2>&1 &
  echo $! > "$PIDFILE"
}

last_run_empty(){ [ -n "${RUN_LOG:-}" ] && [ -f "$RUN_LOG" ] && grep -q "처리할 파일 없음" "$RUN_LOG"; }

log "워치독 시작 (INSTANCE=$INSTANCE, STALL_SEC=$STALL_SEC, CHECK_INTERVAL=${CHECK_INTERVAL}s)"
while true; do
  if ! is_alive; then
    if last_run_empty; then
      log "처리할 파일 없음(큐 소진) — ${EMPTY_BACKOFF}s 백오프 후 재확인"
      sleep "$EMPTY_BACKOFF"
    else
      log "프로세스 없음 — 재기동"
    fi
    start_instance
  elif [ -n "${RUN_LOG:-}" ] && [ -f "$RUN_LOG" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$RUN_LOG" 2>/dev/null || date +%s) ))
    if [ "$age" -gt "$STALL_SEC" ]; then
      log "정체 감지(로그 ${age}s 무활동) — 강제 종료 후 재기동"
      kill -9 "$(cat "$PIDFILE")" 2>/dev/null
      start_instance
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
