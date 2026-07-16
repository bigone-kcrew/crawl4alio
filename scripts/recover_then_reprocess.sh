#!/usr/bin/env bash
# 회수 → (선택) 재처리 체인 — "변환 → 회수 → OCR" 순서의 회수 단계를 한 번에.
#
#   1) recover_ocr_text_pdfs.js        OCR 큐의 텍스트 PDF를 kordoc으로 회수
#      (실행 중엔 kordoc_pending.json으로 OCR이 해당 문서를 건드리지 않음)
#   2) REPROCESS=1이면 이어서 --reprocess
#      과거 race 등으로 이미 OCR 처리된 텍스트 PDF를 kordoc 결과로 교체(품질 업그레이드)
#
# OCR 인스턴스(워치독)와 병행해도 안전하다 — 우선순위는 pending 목록이 강제한다.
# 정기 증분(cron)에서는 변환 후·OCR 전에 이 스크립트를 끼워 넣으면 된다.
#
# 필수 env: CATALOG_ROOT
# 선택 env: KORDOC_PARSE_URL(HTTP 권장), REPROCESS=1, RECOVER_* (회수 스크립트 노브)
#
# Usage:
#   CATALOG_ROOT=/data KORDOC_PARSE_URL=http://kordoc:3400/parse REPROCESS=1 \
#     bash scripts/recover_then_reprocess.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE=${NODE:-node}
: "${CATALOG_ROOT:?CATALOG_ROOT 필요}"
LOGDIR=$CATALOG_ROOT/logs
mkdir -p "$LOGDIR"
TS=$(date +%Y%m%d_%H%M%S)

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "회수 시작 → $LOGDIR/recover_${TS}.log"
( cd "$REPO" && $NODE collection/recover_ocr_text_pdfs.js ) >"$LOGDIR/recover_${TS}.log" 2>&1
rc=$?
tail -1 "$LOGDIR/recover_${TS}.log"
if [ $rc -ne 0 ]; then
  log "회수 비정상 종료(exit $rc) — reprocess 생략. pending 잔재는 OCR 쪽 TTL(KORDOC_PENDING_TTL_H)이 정리"
  exit $rc
fi

if [ "${REPROCESS:-0}" = "1" ]; then
  log "재처리 시작 → $LOGDIR/reprocess_${TS}.log"
  ( cd "$REPO" && $NODE collection/recover_ocr_text_pdfs.js --reprocess ) >"$LOGDIR/reprocess_${TS}.log" 2>&1
  rc=$?
  tail -1 "$LOGDIR/reprocess_${TS}.log"
  [ $rc -ne 0 ] && { log "재처리 비정상 종료(exit $rc)"; exit $rc; }
fi
log "체인 완료"
