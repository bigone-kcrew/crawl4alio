'use strict';
/**
 * 문서 파서 어댑터 — kordoc 로컬(npm) / HTTP 서버 통합
 *
 * kordoc은 npm 패키지(순수 JS)라 서버 없이 in-process 변환이 기본이다.
 * KORDOC_PARSE_URL을 설정하면 기존 방식(HTTP /parse 서버)을 사용한다.
 *
 * 반환 계약은 HTTP /parse 응답과 동일하게 맞춘다:
 *   성공: { ok: true,  result: { markdown } }
 *   실패: { ok: false, error: { code, message } }
 * 스캔 PDF는 kordoc이 빈 markdown을 반환하므로 호출부의
 * 최소 글자수 검사(empty_content → ocr_needed)가 그대로 동작한다.
 */

const KORDOC_HTTP_URL = (process.env.KORDOC_PARSE_URL || process.env.KORDOC_URL || '').trim();
const MARKITDOWN_HTTP_URL = (process.env.MARKITDOWN_PARSE_URL || '').trim();
// KORDOC_OCR: 내장 kordoc(4.2.0+) 텍스트 OCR 스위치. 기본 off — 안 켜면 스캔본은
// 종전대로 빈 markdown → 호출부의 ocr_needed 판정으로 넘어간다(NAS 등 저사양 안전).
// '1'|'true'|'on' → needsOcr 페이지만 OCR / 'force'|'all' → 전 페이지 OCR.
// OCR 워커 머신(예: N100)에서만 이 env를 켜서 로컬 추론 OCR을 담당하게 한다.
const KORDOC_OCR = (process.env.KORDOC_OCR || '').trim().toLowerCase();
const KORDOC_OCR_MODE = ['1', 'true', 'on', 'yes'].includes(KORDOC_OCR) ? true
    : (['force', 'all'].includes(KORDOC_OCR) ? 'force' : false);

let kordocLib = null; // null=미시도, false=로드 실패, object=로드됨
function loadKordoc() {
    if (kordocLib === null) {
        try { kordocLib = require('kordoc'); } catch { kordocLib = false; }
    }
    return kordocLib;
}

/** 'http' | 'local' | 'none' (+OCR 스위치 상태는 kordocOcrMode) */
function kordocMode() {
    if (KORDOC_HTTP_URL) return 'http';
    return loadKordoc() ? 'local' : 'none';
}

/** 내장 OCR 스위치 상태: false | true(needsOcr 페이지) | 'force'(전 페이지) */
function kordocOcrMode() { return KORDOC_OCR_MODE; }

async function callHttpParser(url, buf, filename, timeoutMs) {
    const form = new FormData();
    form.append('file', new File([buf], filename));
    const res = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs || 30000)
    });
    // 일부 파서는 PARSE_FAILED에서도 HTTP 500 + 정상 JSON 본문을 반환하므로 상태 무관 파싱
    return res.json().catch(() => ({
        ok: false,
        error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` }
    }));
}

async function callKordocLocal(buf, filename) {
    const kordoc = loadKordoc();
    if (!kordoc) {
        return { ok: false, error: { code: 'KORDOC_UNAVAILABLE', message: 'kordoc npm 미설치 (npm install 필요)' } };
    }
    try {
        const opts = { filename };
        if (KORDOC_OCR_MODE) opts.ocr = KORDOC_OCR_MODE; // true=needsOcr 페이지만, 'force'=전 페이지
        const result = await kordoc.parse(buf, opts);
        if (result && result.success === false) {
            const message = (result.warnings || []).join('; ') || 'kordoc parse 실패';
            return { ok: false, error: { code: 'PARSE_FAILED', message } };
        }
        return { ok: true, result: { markdown: String(result?.markdown || '') } };
    } catch (err) {
        return { ok: false, error: { code: 'PARSE_FAILED', message: String(err?.message || err) } };
    }
}

// kordoc 4.0.8+는 문서 내 이미지를 images[] 바이너리로 추출하고 markdown에
// ![image](image_001.png) 같은 '상대 파일 참조'를 넣는다. 이 파이프라인은 텍스트
// 코퍼스만 유지(이미지 미저장)하므로, 저장 안 된 로컬 파일 참조는 깨진 링크가 됨 →
// 스킴 없는(=미저장 로컬) 이미지 참조만 제거. http(s)·data: URI는 보존.
function stripDanglingImageRefs(md) {
    return md.replace(/!\[[^\]]*\]\((?![a-z][a-z0-9+.-]*:)[^)]*\.(?:png|jpe?g|gif|bmp|webp)\)\s?/gi, '');
}

/**
 * kordoc 변환. KORDOC_PARSE_URL 설정 시 HTTP, 아니면 내장 npm 라이브러리.
 */
async function callKordoc(buf, filename, timeoutMs) {
    const res = KORDOC_HTTP_URL
        ? await callHttpParser(KORDOC_HTTP_URL, buf, filename, timeoutMs)
        : await callKordocLocal(buf, filename);
    if (res && res.ok !== false && res.result && typeof res.result.markdown === 'string') {
        res.result.markdown = stripDanglingImageRefs(res.result.markdown);
    }
    return res;
}

/**
 * markitdown 변환. MARKITDOWN_PARSE_URL이 설정된 경우에만 시도
 * (kordoc이 pdf/xls(x)/docx까지 커버하므로 선택적 폴백).
 */
async function callMarkitdown(buf, filename, timeoutMs) {
    if (!MARKITDOWN_HTTP_URL) {
        return { ok: false, error: { code: 'MARKITDOWN_UNSET', message: 'MARKITDOWN_PARSE_URL 미설정 — 폴백 건너뜀' } };
    }
    return callHttpParser(MARKITDOWN_HTTP_URL, buf, filename, timeoutMs);
}

module.exports = {
    kordocMode,
    kordocOcrMode,
    callKordoc,
    callMarkitdown,
    callHttpParser,
    KORDOC_HTTP_URL,
    MARKITDOWN_HTTP_URL
};
