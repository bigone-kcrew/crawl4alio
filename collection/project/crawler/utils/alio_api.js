'use strict';
/**
 * ALIO JSON API 공용 모듈
 *
 * 프로브(probe_alio_api.js)로 확인된 실제 응답 구조 기준:
 * - 수시공시: itemOrganListSusi.json(apbaType 획득) → itemReportListSusi.json
 *   페이지네이션은 data.page.{currPage,totalPage,totalCount} (페이지당 10행)
 * - 정기공시(20501 등): itemReportListSusi.json이 status:error 반환.
 *   itemOrganListJung.json {apbaId, reportFormRootNo, quart:''}가 기관별
 *   최신 공시 1건(disclosureNo·critYyyy 포함)을 반환. 연도 파라미터는 없으며
 *   과거 연도 이력은 보고서 표 내부에 포함되는 구조.
 * - 공시항목 카탈로그: formList.json {} → 92개 항목 전체
 */

const axios = require('axios');

const ALIO_BASE = 'https://www.alio.go.kr';

// itemReportListSusi.json이 지원하지 않는 정기공시 SCD (연 1회, 기관당 1건)
const PERIODIC_SCDS = new Set(['20501', '20601', '20701', '20801', '21201']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function shouldRetryLookup(err) {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('socket hang up') || message.includes('timeout') || message.includes('econnreset');
}

async function postWithRetry(url, payload, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await axios.post(url, payload, { timeout: 30000 });
        } catch (err) {
            lastError = err;
            if (!shouldRetryLookup(err) || attempt === maxAttempts) throw err;
            await sleep(attempt * 1000);
        }
    }
    throw lastError;
}

// Susi/Jung/캐시 행을 공통 형태로 정규화 (필드 별칭 허용)
function normalizeReportRow(report, fallbackReportFormRootNo) {
    const title = report?.title || report?.disclosure_title || '';
    const dateSource = String(report?.openDate || report?.idate || report?.stDate || '');
    const yearMatch = String(report?.year || report?.critYyyy || title).match(/^(\d{4})/)
        || dateSource.match(/(20\d{2})/);

    return {
        apba_id: report?.apbaId || report?.apba_id || '',
        report_form_root_no: String(report?.reportFormNo || report?.report_form_root_no || fallbackReportFormRootNo || '').trim(),
        disclosure_no: String(report?.disclosureNo || report?.disclosure_no || '').trim(),
        submission_no: String(report?.submissionNo || report?.submission_no || '').trim(),
        year: String(report?.year || report?.critYyyy || (yearMatch ? yearMatch[1] : '') || '').trim(),
        quarter: String(report?.quarter || report?.critQuar || '').trim(),
        period_label: String(report?.period_label || report?.quartNa || '').trim(),
        title,
        disclosure_title: title
    };
}

// 수시공시: organ 정보 조회 (apbaType 획득용)
async function fetchOrganInfoSusi(apbaId, reportFormRootNo) {
    const response = await postWithRetry(`${ALIO_BASE}/item/itemOrganListSusi.json`, {
        apbaId,
        reportFormRootNo
    });
    return response?.data?.data?.organInfo || {};
}

// 수시공시: 보고서 목록 전 페이지 조회
async function fetchReportRowsSusi(apbaId, reportFormRootNo, options = {}) {
    const maxPages = options.maxPages || 50;
    const delayMs = options.delayMs ?? 500;
    let apbaType = options.apbaType;

    if (!apbaType) {
        const organInfo = await fetchOrganInfoSusi(apbaId, reportFormRootNo);
        apbaType = organInfo.apbaType || '';
    }

    const rows = [];
    const seen = new Set();

    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
        const response = await postWithRetry(`${ALIO_BASE}/item/itemReportListSusi.json`, {
            pageNo,
            apbaId,
            apbaType,
            reportFormRootNo,
            search_word: '',
            search_flag: 'title',
            bid_type: '',
            enfc_istt: ''
        });

        const body = response?.data;
        if (body?.status && body.status !== 'success') {
            throw new Error(`itemReportListSusi status=${body.status} (${reportFormRootNo})`);
        }

        const data = body?.data || {};
        const pageRows = Array.isArray(data.result) ? data.result : [];
        for (const row of pageRows) {
            // 게시판형(B1210/B1220 등)은 disclosureNo가 전부 '0000...'이라 disclosureNo만으로
            // dedup하면 기관당 1건으로 접힘 → idx까지 포함해 게시글별 유일 키로 판정.
            const dedupKey = `${String(row?.disclosureNo || '').trim()}|${String(row?.idx || '').trim()}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            rows.push(row);
        }

        const page = data.page || {};
        const currPage = Number(page.currPage || pageNo);
        const totalPage = Number(page.totalPage || 1);
        if (!pageRows.length || currPage >= totalPage) break;
        if (delayMs) await sleep(delayMs);
    }

    return rows;
}

// 정기공시: 기관별 최신 공시 조회 (연도 파라미터 없음 — 최신 스냅샷만 제공)
// 주의: apbaType 등 부가 필드를 빈 문자열로 보내면 status:error가 반환됨 — 최소 payload 사용
async function fetchOrganListJung(apbaId, reportFormRootNo) {
    const response = await postWithRetry(`${ALIO_BASE}/item/itemOrganListJung.json`, {
        apbaId,
        reportFormRootNo
    });

    const body = response?.data;
    if (body?.status && body.status !== 'success') {
        throw new Error(`itemOrganListJung status=${body.status} (${reportFormRootNo})`);
    }
    const data = body?.data || body || {};
    return Array.isArray(data.organList) ? data.organList : [];
}

/**
 * 공시 종류(정기/수시)를 판정하며 보고서 행을 조회.
 * kindHint가 없으면 PERIODIC_SCDS로 추정하고, 실패 시 반대 API로 폴백.
 * @returns {{ rows: object[], disclosure_kind: '정기'|'수시' }}
 */
async function fetchReportRows(apbaId, reportFormRootNo, kindHint, options = {}) {
    const code = String(reportFormRootNo).trim();
    const guess = kindHint || (PERIODIC_SCDS.has(code) ? '정기' : '수시');
    const order = guess === '정기' ? ['정기', '수시'] : ['수시', '정기'];

    let lastError = null;
    for (const kind of order) {
        try {
            const rows = kind === '정기'
                ? await fetchOrganListJung(apbaId, code)
                : await fetchReportRowsSusi(apbaId, code, options);
            if (rows.length > 0) return { rows, disclosure_kind: kind };
            // 빈 결과: 판정이 명시(kindHint)면 폴백하지 않고 그대로 반환
            if (kindHint) return { rows: [], disclosure_kind: kind };
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError) throw lastError;
    return { rows: [], disclosure_kind: guess };
}

// 전역 최근 공시 feed (사이트 전체 최신 N건)
async function fetchRecentDisclosures(endNum = 50) {
    const response = await axios.get(`${ALIO_BASE}/status/findDisclosureList.json`, {
        params: { endNum },
        headers: { Referer: `${ALIO_BASE}/status/disclosureStatus.do` },
        timeout: 30000
    });
    return response?.data?.data?.disclosureList || [];
}

// 공시별 첨부파일 목록
async function fetchReportFiles(disclosureNo) {
    const response = await axios.get(`${ALIO_BASE}/item/itemReportFiles.json`, {
        params: { disclosureNo },
        timeout: 20000
    });
    return response?.data?.data || response?.data || [];
}

// 공시항목 카탈로그 전체 (92항목)
async function fetchDisclosureCatalog() {
    const response = await postWithRetry(`${ALIO_BASE}/item/formList.json`, {});
    const body = response?.data;
    if (body?.status && body.status !== 'success') {
        throw new Error(`formList status=${body.status}`);
    }
    return Array.isArray(body?.data) ? body.data : [];
}

module.exports = {
    ALIO_BASE,
    PERIODIC_SCDS,
    shouldRetryLookup,
    postWithRetry,
    normalizeReportRow,
    fetchOrganInfoSusi,
    fetchReportRowsSusi,
    fetchOrganListJung,
    fetchReportRows,
    fetchRecentDisclosures,
    fetchReportFiles,
    fetchDisclosureCatalog
};
