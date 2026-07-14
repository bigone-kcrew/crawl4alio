"""
PaddleOCR /parse 래퍼 — crawl4alio 파서 계약 구현

PP-StructureV3(레이아웃 분석+표 인식+OCR)로 스캔 PDF/이미지를 Markdown으로 변환한다.

계약 (collection/convert_ocr_needed.js, ocrtomarkdown/ 이 기대하는 형식):
  POST /parse  (multipart, 필드명 'file')
  성공: { "ok": true,  "result": { "markdown": "...", "pages": N } }
  실패: { "ok": false, "error": { "code": "...", "message": "..." } }
  PDF 페이지 경계에는 <!-- page: N --> 마커를 삽입한다 (기존 corpus 관례).

  GET /health → { "status": "ok", "ready": true|false }
  (ready=false면 첫 요청 시 모델 로딩 중 — 최초 기동 시 모델 다운로드로 수 분 소요)

Env:
  OCR_DEVICE   cpu(기본) | gpu
  OCR_LANG     korean(기본)
"""
import os
import tempfile
import threading

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="paddleocr-parser")


# ── 자가복구(선택): RSS 초과 또는 요청 hang 시 프로세스 self-exit → 컨테이너 restart로 재기동 ──
#    저RAM 다중 PC 스케일아웃에서 드물게 OOM/hang을 유발하는 문서에 무인 대응.
#    0=비활성(기본). 저RAM 인스턴스에서 OCR_SELF_KILL_RSS_MB(예 4200)·_HANG_S(예 600) 설정 권장.
#    predict()가 GIL을 놓으므로 데몬 스레드가 감시 가능; os._exit는 어느 스레드에서든 즉시 종료.
import time as _time
import threading as _threading

_SELF_KILL_RSS_MB = float(os.environ.get("OCR_SELF_KILL_RSS_MB", "0"))
_SELF_KILL_HANG_S = float(os.environ.get("OCR_SELF_KILL_HANG_S", "0"))
_req_started_at = {"t": 0.0}


def _mark_busy():
    _req_started_at["t"] = _time.time()


def _mark_idle():
    _req_started_at["t"] = 0.0


def _rss_mb():
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576.0
    except Exception:
        return 0.0


def _self_watchdog():
    while True:
        _time.sleep(15)
        started = _req_started_at["t"]
        hung = _SELF_KILL_HANG_S > 0 and started > 0 and (_time.time() - started > _SELF_KILL_HANG_S)
        over = _SELF_KILL_RSS_MB > 0 and _rss_mb() > _SELF_KILL_RSS_MB
        if over or hung:
            print(f"[self-watchdog] self-exit (rss={_rss_mb():.0f}MB, hung={hung}) -> container restart", flush=True)
            os._exit(137)


if _SELF_KILL_RSS_MB > 0 or _SELF_KILL_HANG_S > 0:
    _threading.Thread(target=_self_watchdog, daemon=True).start()
# ── 자가복구 끝 ──

_pipeline = None
_pipeline_lock = threading.Lock()
_pipeline_error = None


def get_pipeline():
    """PP-StructureV3 파이프라인 lazy 초기화 (최초 호출 시 모델 다운로드)."""
    global _pipeline, _pipeline_error
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is not None:
            return _pipeline
        try:
            from paddleocr import PPStructureV3
            _pipeline = PPStructureV3(
                device=os.environ.get("OCR_DEVICE", "cpu"),
                lang=os.environ.get("OCR_LANG", "korean"),
            )
            _pipeline_error = None
        except Exception as e:  # noqa: BLE001
            _pipeline_error = str(e)
            raise
    return _pipeline


def extract_markdown(page_result):
    """페이지 결과 객체에서 markdown 텍스트를 최대한 유연하게 추출."""
    md = getattr(page_result, "markdown", None)
    if md is None:
        return ""
    if isinstance(md, str):
        return md
    if isinstance(md, dict):
        for key in ("markdown_texts", "markdown", "text"):
            value = md.get(key)
            if isinstance(value, str):
                return value
    return str(md)


@app.get("/health")
def health():
    return {"status": "ok", "ready": _pipeline is not None, "error": _pipeline_error}


@app.post("/parse")
async def parse(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "input.pdf")[1] or ".pdf"
    tmp_path = None
    try:
        _mark_busy()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        pipeline = get_pipeline()
        results = pipeline.predict(input=tmp_path)

        pages = []
        for i, page_result in enumerate(results, start=1):
            text = extract_markdown(page_result).strip()
            marker = f"<!-- page: {i} -->"
            pages.append(f"{marker}\n\n{text}" if text else marker)

        markdown = "\n\n".join(pages).strip()
        if not markdown:
            return JSONResponse(
                status_code=200,
                content={"ok": False, "error": {"code": "EMPTY_RESULT", "message": "OCR 결과 없음"}},
            )
        return {"ok": True, "result": {"markdown": markdown, "pages": len(pages)}}

    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            status_code=200,  # 클라이언트는 본문 JSON의 ok로 판정 (기존 파서 관례)
            content={"ok": False, "error": {"code": "OCR_FAILED", "message": str(e)[:500]}},
        )
    finally:
        _mark_idle()
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
