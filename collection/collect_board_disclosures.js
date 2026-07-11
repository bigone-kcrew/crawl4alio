#!/usr/bin/env node
/**
 * 게시판형 공시 수집 — 국회/감사원 지적사항(B1210/B1220), 경영평가(B1230/B1250)
 *
 * 일반 다운로더(download_documents_advanced.js)는 게시판형(disclosureNo 없음)을 스킵하고,
 * 채용 수집기(collect_recruit_attachments.js)는 채용 게시판(B1010/B1020) 전용이라,
 * 이 4개 항목은 어느 수집기로도 안 잡히던 사각지대. 이 스크립트가 담당.
 *
 * 유형별 첨부/본문 방식 (라이브 실측 확정):
 *  - PTOT(B1210/B1220): 본문이 페이지 인라인 텍스트(지적사항/시정조치 계획·결과).
 *      본문 → 내용.md 저장. 첨부 → downAttachFile(spath,sfile,dfile) → /download/pfile.json
 *  - COMM(B1230/B1250): 첨부 download.json?fileNo=N (B1010과 동일). 본문 없음.
 *
 * Usage:
 *   node collection/collect_board_disclosures.js --forms B1210,B1220,B1230,B1250 --years 3 \
 *        --out /workspace/alio/2_data/alio-raw/자료/기관별공시
 *   옵션: --apba C0247 (테스트) --limit N --dry-run
 */
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const alioApi = require(path.join(__dirname, 'project/crawler/utils/alio_api'));
const { fromCatalogRoot, fromLogsRoot } = require(path.join(__dirname, 'project/crawler/utils/paths'));
const { sanitizeSegment, getInstitutionFolderName } = require(path.join(__dirname, 'project/crawler/utils/disclosure_scope'));

const ALIO_BASE = alioApi.ALIO_BASE || 'https://www.alio.go.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REQUEST_DELAY_MS = Number(process.env.BOARD_DELAY_MS || 150);
const POSTING_CONCURRENCY = Number(process.env.BOARD_POSTING_CONCURRENCY || 6);
const ALIO_CONCURRENCY = Number(process.env.BOARD_ALIO_CONCURRENCY || 6);

const FORM_CONFIG = {
    B1210: { detailPath: '/item/itemBoardB1210.do', kind: 'PTOT', folder: 'B1210_국회지적사항' },
    B1220: { detailPath: '/item/itemBoardB1220.do', kind: 'PTOT', folder: 'B1220_감사원등지적사항' },
    B1230: { detailPath: '/item/itemBoardB1230.do', kind: 'COMM', folder: 'B1230_경영평가결과' },
    B1250: { detailPath: '/item/itemBoardB1250.do', kind: 'COMM', folder: 'B1250_경영평가결과' },
};

const logger = {
    info: (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), 'INFO', ...a),
    error: (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), 'ERROR', ...a),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runPool(items, limit, worker) {
    const executing = new Set();
    for (const item of items) {
        const p = Promise.resolve().then(() => worker(item)).finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
}

function createSemaphore(max) {
    let active = 0; const queue = [];
    async function acquire() { if (active >= max) await new Promise(r => queue.push(r)); active += 1; }
    function release() { active -= 1; const n = queue.shift(); if (n) n(); }
    return { async run(fn) { await acquire(); try { return await fn(); } finally { release(); } } };
}
const alioSem = createSemaphore(ALIO_CONCURRENCY);

function truncateBytes(str, maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let s = buf.subarray(0, maxBytes).toString('utf8');
    if (s.endsWith('�')) s = s.slice(0, -1);
    return s;
}

function parseArgs(argv) {
    const args = { forms: ['B1210', 'B1220', 'B1230', 'B1250'], years: 3, apba: null, limit: 0,
        out: fromCatalogRoot('structured_data'), dryRun: false };
    for (let i = 2; i < argv.length; i += 1) {
        const take = () => argv[++i];
        switch (argv[i]) {
            case '--forms': args.forms = String(take()).split(',').map(s => s.trim().toUpperCase()).filter(Boolean); break;
            case '--years': args.years = parseInt(take(), 10) || 3; break;
            case '--apba': args.apba = String(take()).split(',').map(s => s.trim()).filter(Boolean); break;
            case '--limit': args.limit = parseInt(take(), 10) || 0; break;
            case '--out': args.out = take(); break;
            case '--dry-run': args.dryRun = true; break;
            default: break;
        }
    }
    return args;
}

async function fetchDetailHtml(url) {
    return alioSem.run(async () => {
        const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000 });
        return String(res.data || '');
    });
}

function buildDetailUrl(row, formNo, cfg) {
    const params = new URLSearchParams({
        disclosureNo: row.disclosureNo || '',
        apbaId: row.apbaId,
        nowcode: formNo,
        reportFormNo: row.reportFormNo || formNo,
        table_name: row.tableName || '',
        idx_name: row.idxName || '',
        idx: row.idx,
        reportGbn: row.reportGbn || 'N',
    });
    return `${ALIO_BASE}${cfg.detailPath}?${params.toString()}`;
}

// COMM(B1230/B1250): download.json?fileNo=N
function parseCommAttachments(html) {
    const re = /download\.json\?fileNo=(\d+)[^>]*>\s*([^<]+?)\s*</g;
    const out = []; const seen = new Set(); let m;
    while ((m = re.exec(html)) !== null) {
        const fileNo = m[1]; let name = m[2].trim();
        if (!name || seen.has(fileNo) || /바로보기|다운로드|미리보기/.test(name)) continue;
        seen.add(fileNo);
        out.push({ fileName: name, url: `${ALIO_BASE}/download/download.json?fileNo=${fileNo}` });
    }
    return out;
}

// PTOT(B1210/B1220): downAttachFile('spath','sfile','dfile') → /download/pfile.json
function parsePtotAttachments(html) {
    const re = /downAttachFile\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    const out = []; const seen = new Set(); let m;
    while ((m = re.exec(html)) !== null) {
        const [, spath, sfile, dfile] = m;
        const key = spath + sfile;
        if (seen.has(key) || !sfile) continue;
        seen.add(key);
        const qs = new URLSearchParams({ spath, sfile, dfile });
        out.push({ fileName: dfile || sfile, url: `${ALIO_BASE}/download/pfile.json?${qs.toString()}` });
    }
    return out;
}

// PTOT 본문 텍스트 추출 — 라벨 앞에 줄바꿈 삽입해 구조 보존
function parsePtotContent(html) {
    let txt = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
    // 헤더/푸터 잡음 제거
    txt = txt.replace(/^.*?공공기관 경영정보 공개시스템\s*/, '');
    txt = txt.replace(/\s*(닫기|취소하기)\s*$/g, '').trim();
    // 라벨 앞 줄바꿈
    for (const label of ['시행기간', '지적사항 첨부파일', '지적사항', '시정조치 계획 첨부파일', '시정조치 계획', '시정조치 결과 첨부파일', '시정조치 결과']) {
        txt = txt.split(label).join('\n### ' + label + '\n');
    }
    return txt.replace(/\n{3,}/g, '\n\n').trim();
}

async function downloadTo(url, destPath) {
    return alioSem.run(async () => {
        const res = await axios.get(url, { headers: { 'User-Agent': UA }, responseType: 'stream', timeout: 120000, maxContentLength: 500 * 1024 * 1024 });
        const writer = fs.createWriteStream(destPath);
        await new Promise((resolve, reject) => {
            res.data.on('error', reject); writer.on('error', reject); writer.on('finish', resolve);
            res.data.pipe(writer);
        });
        return fs.statSync(destPath).size;
    });
}

// ── 체크포인트 ──
function ckptPath() { return fromLogsRoot('board_ckpt.json'); }
function loadCkpt() { try { return JSON.parse(fs.readFileSync(ckptPath(), 'utf8')); } catch { return { done: {} }; } }
function saveCkpt(ckpt) {
    const p = ckptPath(); const tmp = p + '.tmp';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 2));
    fs.renameSync(tmp, p);
}

function rowYear(row) {
    const s = String(row.idate || row.openDate || '');
    let m = s.match(/(20\d{2})/);
    if (m) return m[1];
    m = String(row.title || '').match(/(20\d{2})\s*년/);
    return m ? m[1] : 'unknown';
}

async function processForm(inst, formNo, args, cutoffYear, ckpt, totals) {
    const cfg = FORM_CONFIG[formNo];
    let rows;
    try {
        rows = await alioApi.fetchReportRowsSusi(inst.apba_id, formNo, { delayMs: REQUEST_DELAY_MS });
    } catch (err) {
        logger.error(`${inst.name}(${formNo}): 목록 조회 실패 — ${err.message}`);
        totals.errors += 1; return;
    }
    if (!Array.isArray(rows) || !rows.length) return;
    let scoped = rows.filter(r => r.idx);
    // 연도 필터 (날짜 있는 경우만; 없으면 포함 — 누락 방지)
    scoped = scoped.filter(r => {
        const y = parseInt(rowYear(r), 10);
        return !Number.isFinite(y) || y >= cutoffYear;
    });
    if (args.limit > 0) scoped = scoped.slice(0, args.limit);
    if (!scoped.length) return;

    logger.info(`${inst.name}(${formNo}): 게시글 ${scoped.length}건`);

    const processPosting = async (row) => {
        const key = `${formNo}:${inst.apba_id}:${row.idx}`;
        if (ckpt.done[key]) { totals.skipped += 1; return; }

        const detailUrl = buildDetailUrl(row, formNo, cfg);
        let html;
        try { html = await fetchDetailHtml(detailUrl); }
        catch (err) { logger.error(`${inst.name}(${formNo}) idx=${row.idx}: 상세조회 실패 — ${err.message}`); totals.errors += 1; return; }

        const attachments = cfg.kind === 'PTOT' ? parsePtotAttachments(html) : parseCommAttachments(html);
        const content = cfg.kind === 'PTOT' ? parsePtotContent(html) : null;

        const year = rowYear(row);
        const postFolder = truncateBytes(sanitizeSegment(String(row.title || `idx_${row.idx}`)), 200);
        const postDir = path.join(args.out, getInstitutionFolderName(inst), cfg.folder, year, postFolder);

        const manifest = {
            form_no: formNo, kind: cfg.kind, idx: row.idx, disclosure_no: row.disclosureNo || '',
            title: row.title || '', source_url: detailUrl, collected_at: new Date().toISOString(),
            has_content: !!content, attachments: [],
        };

        if (args.dryRun) {
            logger.info(`  [DRY] ${formNo} ${row.title?.slice(0, 30)} | 첨부 ${attachments.length} | 본문 ${content ? content.length + '자' : '없음'}`);
            return;
        }

        fs.mkdirSync(postDir, { recursive: true });
        if (content && content.length > 20) {
            const md = `# ${row.title || formNo}\n\n${content}\n`;
            fs.writeFileSync(path.join(postDir, '내용.md'), md);
        }

        await runPool(attachments, 3, async (att) => {
            try {
                const safeName = sanitizeSegment(att.fileName) || 'file';
                const dest = path.join(postDir, safeName);
                if (fs.existsSync(dest)) { manifest.attachments.push({ file_name: safeName, size: fs.statSync(dest).size, action: 'exists' }); return; }
                const size = await downloadTo(att.url, dest);
                manifest.attachments.push({ file_name: safeName, size, action: 'downloaded' });
                totals.files += 1; totals.bytes += size;
                logger.info(`  [downloaded] ${safeName} (${(size / 1024).toFixed(0)}KB)`);
            } catch (err) {
                logger.error(`  다운로드 실패 (${att.fileName}) — ${err.message}`);
                totals.errors += 1;
            }
            await sleep(REQUEST_DELAY_MS);
        });

        fs.writeFileSync(path.join(postDir, 'board_manifest.json'), JSON.stringify(manifest, null, 2));
        ckpt.done[key] = { at: new Date().toISOString(), files: manifest.attachments.length, has_content: !!content };
        saveCkpt(ckpt);
        totals.postings += 1;
    };

    await runPool(scoped, POSTING_CONCURRENCY, async (row) => {
        try { await processPosting(row); }
        catch (err) { logger.error(`${inst.name}(${formNo}) idx=${row.idx}: 처리 실패 — ${err.message}`); totals.errors += 1; }
    });
}

async function main() {
    const args = parseArgs(process.argv);
    const cutoffYear = new Date().getFullYear() - (args.years - 1);
    const unknown = args.forms.filter(f => !FORM_CONFIG[f]);
    if (unknown.length) { logger.error(`알 수 없는 form: ${unknown.join(', ')} (지원: ${Object.keys(FORM_CONFIG).join(', ')})`); process.exit(1); }

    const institutionsAll = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/institutions.json'), 'utf8'));
    const institutions = args.apba ? institutionsAll.filter(i => args.apba.includes(i.apba_id)) : institutionsAll;

    logger.info(`게시판형 공시 수집 시작: forms [${args.forms.join(', ')}], 기관 ${institutions.length}개, ${cutoffYear}년 이후${args.dryRun ? ' [DRY]' : ''}`);
    const ckpt = loadCkpt();
    const totals = { postings: 0, skipped: 0, files: 0, bytes: 0, errors: 0 };

    for (const inst of institutions) {
        for (const formNo of args.forms) {
            await processForm(inst, formNo, args, cutoffYear, ckpt, totals);
        }
    }
    logger.info(`완료: 게시글 ${totals.postings}건 (스킵 ${totals.skipped}) / 파일 ${totals.files}건 ${(totals.bytes / 1e6).toFixed(1)}MB / 오류 ${totals.errors}건`);
}

if (require.main === module) {
    main().catch(err => { logger.error(err.stack || err.message); process.exit(1); });
} else {
    module.exports = { parseCommAttachments, parsePtotAttachments, parsePtotContent, downloadTo };
}
