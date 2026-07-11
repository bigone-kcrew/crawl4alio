#!/usr/bin/env node
/**
 * ALIO 법령/지침 게시판 수집 — https://alio.go.kr/etc/etcLawList.do
 *
 * 기재부(재정경제부) 지침류의 개정본 게시판: 예산운용지침·통합공시기준·혁신지침·
 * 안전관리지침 등. 같은 지침의 개정 이력이 별도 게시글로 쌓이므로 개정 감지 소스로도 유용.
 *
 * API (페이지 JS 리버싱, 2026-07):
 *  - 목록: GET /etc/findEtcLawList.json?type=title&word=&pageNo=N
 *          → data.result[] {boardNo, rtitle, pname, idate, ...}, data.totalCnt
 *  - 상세: GET /etc/findEtcLawDtl.json?boardNo=N → data.fileList[] {fileNo, fileNm}
 *          (본문 없음 — 첨부 게시용 게시판)
 *  - 첨부: GET /download/download.json?fileNo=N
 *
 * 저장 (법령 코퍼스 소속, raw=원본/md=메타 원칙):
 *  - 첨부: <legal-raw>/법령자료/알리오지침게시판/<게시글제목>/<파일명>
 *  - 메타: <legal-md>/법령자료/알리오지침게시판/<게시글제목>/manifest.json
 *  - ckpt: logs/lawboard_ckpt.json (boardNo 기준, idate 변경 시 재처리)
 *
 * Usage:
 *   node collection/collect_alio_lawboard.js [--limit N] [--dry-run]
 *   CATALOG_ROOT=/workspace/alio/2_data node collection/collect_alio_lawboard.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');

const ALIO_BASE = 'https://alio.go.kr';
const UA = 'Mozilla/5.0 (crawl4alio lawboard collector)';
const RAW_BASE = process.env.LEGAL_RAW_ROOT
    ? path.resolve(process.env.LEGAL_RAW_ROOT)
    : fromCatalogRoot('legal-raw');
const MD_BASE = process.env.LEGAL_MD_ROOT
    ? path.resolve(process.env.LEGAL_MD_ROOT)
    : fromCatalogRoot('legal-md');
const BOARD_DIR = path.join('법령자료', '알리오지침게시판');
const CKPT_PATH = fromLogsRoot('lawboard_ckpt.json');
const DRY = process.argv.includes('--dry-run');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) || 0 : 0;

function truncateBytes(str, maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let s = buf.subarray(0, maxBytes).toString('utf8');
    if (s.endsWith('�')) s = s.slice(0, -1);
    return s;
}

function sanitize(name) {
    return truncateBytes(String(name).replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim(), 180);
}

function loadCkpt() {
    try { return JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8')); } catch { return { done: {} }; }
}

function saveCkpt(ckpt) {
    fs.mkdirSync(path.dirname(CKPT_PATH), { recursive: true });
    const tmp = CKPT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 1));
    fs.renameSync(tmp, CKPT_PATH);
}

async function getJson(url) {
    const res = await axios.get(url, {
        headers: { 'User-Agent': UA, Referer: `${ALIO_BASE}/etc/etcLawList.do` },
        timeout: 30000,
    });
    if (res.data?.status !== 'success') throw new Error(`API error: ${JSON.stringify(res.data).slice(0, 120)}`);
    return res.data.data;
}

async function fetchAllRows() {
    const rows = [];
    let page = 1;
    for (;;) {
        const data = await getJson(`${ALIO_BASE}/etc/findEtcLawList.json?type=title&word=&pageNo=${page}`);
        const batch = data.result || [];
        rows.push(...batch);
        const total = parseInt(data.totalCnt, 10) || rows.length;
        if (!batch.length || rows.length >= total) break;
        page += 1;
    }
    return rows;
}

async function downloadFile(fileNo, destPath) {
    const res = await axios.get(`${ALIO_BASE}/download/download.json?fileNo=${fileNo}`, {
        headers: { 'User-Agent': UA }, responseType: 'stream', timeout: 120000,
    });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = destPath + '.__tmp';
    const writer = fs.createWriteStream(tmp);
    res.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve); writer.on('error', reject); res.data.on('error', reject);
    });
    fs.renameSync(tmp, destPath);
    return fs.statSync(destPath).size;
}

async function main() {
    const ckpt = loadCkpt();
    let rows = await fetchAllRows();
    console.log(`목록: ${rows.length}건 (raw=${RAW_BASE})`);
    if (LIMIT) rows = rows.slice(0, LIMIT);

    let done = 0, skip = 0, files = 0, errs = 0;
    for (const row of rows) {
        const key = String(row.boardNo);
        const idate = String(row.idate || '');
        const prev = ckpt.done[key];
        if (prev && prev.idate === idate) { skip += 1; continue; }

        const title = sanitize(row.rtitle || key);
        try {
            const detail = await getJson(`${ALIO_BASE}/etc/findEtcLawDtl.json?boardNo=${key}`);
            const fileList = detail.fileList || [];
            const rawDir = path.join(RAW_BASE, BOARD_DIR, title);
            const mdDir = path.join(MD_BASE, BOARD_DIR, title);

            if (DRY) {
                console.log(`[DRY] ${title} — 첨부 ${fileList.length}건`);
            } else {
                for (const f of fileList) {
                    const dest = path.join(rawDir, sanitize(f.fileNm || `file_${f.fileNo}`));
                    if (!fs.existsSync(dest)) { await downloadFile(f.fileNo, dest); files += 1; }
                }
                fs.mkdirSync(mdDir, { recursive: true });
                fs.writeFileSync(path.join(mdDir, 'manifest.json'), JSON.stringify({
                    source: 'alio_lawboard', board_no: key, title: row.rtitle,
                    publisher: row.pname || '', idate,
                    disclosure_no: detail.etcLawDtl?.disclosureNo || '',
                    source_url: `${ALIO_BASE}/etc/etcLawDtl.do?boardNo=${key}`,
                    files: fileList.map(f => ({ file_no: f.fileNo, file_name: f.fileNm })),
                    collected_at: new Date().toISOString(),
                }, null, 2));
                ckpt.done[key] = { idate, title: row.rtitle, at: new Date().toISOString() };
                if (++done % 10 === 0) saveCkpt(ckpt);
            }
        } catch (err) {
            errs += 1;
            console.error(`오류 ${title}: ${err.message}`);
        }
    }
    if (!DRY) saveCkpt(ckpt);
    console.log(`완료: 처리 ${done} / 스킵 ${skip} / 파일 ${files} / 오류 ${errs}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
