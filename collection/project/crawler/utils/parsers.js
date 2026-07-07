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

let kordocLib = null; // null=미시도, false=로드 실패, object=로드됨
function loadKordoc() {
    if (kordocLib === null) {
        try { kordocLib = require('kordoc'); } catch { kordocLib = false; }
    }
    return kordocLib;
}

/** 'http' | 'local' | 'none' */
function kordocMode() {
    if (KORDOC_HTTP_URL) return 'http';
    return loadKordoc() ? 'local' : 'none';
}

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
        const result = await kordoc.parse(buf, { filename });
        if (result && result.success === false) {
            const message = (result.warnings || []).join('; ') || 'kordoc parse 실패';
            return { ok: false, error: { code: 'PARSE_FAILED', message } };
        }
        return { ok: true, result: { markdown: String(result?.markdown || '') } };
    } catch (err) {
        return { ok: false, error: { code: 'PARSE_FAILED', message: String(err?.message || err) } };
    }
}

/**
 * kordoc 변환. KORDOC_PARSE_URL 설정 시 HTTP, 아니면 내장 npm 라이브러리.
 */
async function callKordoc(buf, filename, timeoutMs) {
    if (KORDOC_HTTP_URL) return callHttpParser(KORDOC_HTTP_URL, buf, filename, timeoutMs);
    return callKordocLocal(buf, filename);
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
    callKordoc,
    callMarkitdown,
    callHttpParser,
    KORDOC_HTTP_URL,
    MARKITDOWN_HTTP_URL
};
