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
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
