#!/usr/bin/env node
'use strict';

/**
 * B1020(임·직원 채용정보) 게시판 첨부파일 수집기
 *
 * 일반 공시와 달리 B1020은 게시판형(TTB_RECRUIT)이라 doc.html이 없고,
 * itemBoardB1020.do 상세페이지에 카테고리별(공고문/입사지원서/직무기술서/기타)
 * 첨부파일이 붙는다. 흐름:
 *   itemReportListSusi.json (idx 목록) → itemBoardB1020.do 상세 HTML 파싱
 *   → download/download.json?fileNo= 다운로드
 *
 * Usage:
 *   node collection/collect_recruit_attachments.js [options]
 *     --years <N>          최근 N년만 수집 (기본 3)
 *     --categories <목록>   쉼표구분 (기본 "공고문,입사지원서,직무기술서")
 *     --apba <ID[,ID..]>   특정 기관만 (테스트용)
 *     --limit <N>          기관당 게시글 수 제한 (테스트용)
 *     --out <dir>          출력 루트 (기본 data/structured_data)
 *     --dry-run            다운로드 없이 대상만 출력
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));
const { sanitizeSegment } = require(path.join(__dirname, 'project/crawler/utils/disclosure_scope'));
const alioApi = require(path.join(__dirname, 'project/crawler/utils/alio_api'));

const ALIO_BASE = alioApi.ALIO_BASE || 'https://www.alio.go.kr';
const REPORT_FORM_NO = 'B1020';
const SCD_FOLDER = 'B1020_인력관리';
const ALL_CATEGORIES = ['공고문', '입사지원서', '직무기술서', '기타 첨부파일'];
const REQUEST_DELAY_MS = 400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
    const args = {
        years: 3,
        categories: ['공고문', '입사지원서', '직무기술서'],
        apba: null,
        limit: 0,
        out: path.join(__dirname, '../data/structured_data'),
        dryRun: false
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const takeValue = () => argv[++i];
        switch (arg) {
            case '--years': args.years = parseInt(takeValue(), 10) || 3; break;
            case '--categories': args.categories = String(takeValue()).split(',').map(s => s.trim()).filter(Boolean); break;
            case '--apba': args.apba = String(takeValue()).split(',').map(s => s.trim()).filter(Boolean); break;
            case '--limit': args.limit = parseInt(takeValue(), 10) || 0; break;
            case '--out': args.out = takeValue(); break;
            case '--dry-run': args.dryRun = true; break;
            default: break;
        }
    }
    return args;
}

function getInstitutionFolderName(inst) {
    const ministry = String(inst.ministry || '').replace(/[\[\]]/g, '');
    return `[${ministry}]${sanitizeSegment(inst.name || 'UnknownInstitution')}_${sanitizeSegment(inst.apba_id || 'UnknownCode')}`;
}

// ── 상세페이지 파싱 ──────────────────────────────────────────────
// <th>카테고리</th> 구간별로 download.json?fileNo= 링크를 추출
function parseAttachmentSections(html) {
    const result = {};
    const thRe = /<th[^>]*>\s*([^<]{1,30}?)\s*<\/th>/g;
    const ths = [];
    let m;
    while ((m = thRe.exec(html)) !== null) {
        ths.push({ label: m[1].trim(), end: thRe.lastIndex, start: m.index });
    }
    for (let i = 0; i < ths.length; i += 1) {
        const label = ths[i].label;
        if (!ALL_CATEGORIES.includes(label)) continue;
        const segEnd = i + 1 < ths.length ? ths[i + 1].start : html.length;
        const seg = html.slice(ths[i].end, segEnd);
        const files = [];
        const fRe = /fileNo=(\d+)[^>]*>([^<]+)</g;
        let fm;
        while ((fm = fRe.exec(seg)) !== null) {
            const fileNo = fm[1];
            const fileName = fm[2].trim();
            if (!fileName || files.some(f => f.fileNo === fileNo)) continue;
            files.push({ fileNo, fileName });
        }
        if (files.length) result[label] = files;
    }
    return result;
}

function buildDetailUrl(row) {
    const params = new URLSearchParams({
        disclosureNo: row.disclosureNo,
        apbaId: row.apbaId,
        nowcode: REPORT_FORM_NO,
        reportFormNo: row.reportFormNo || REPORT_FORM_NO,
        table_name: row.tableName || 'TTB_RECRUIT',
        idx_name: row.idxName || 'IDX',
        idx: row.idx,
        reportGbn: row.reportGbn || 'N'
    });
    return `${ALIO_BASE}/item/itemBoardB1020.do?${params.toString()}`;
}

async function fetchDetailHtml(url) {
    const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000 });
    return String(res.data || '');
}

async function downloadFile(fileNo, destPath) {
    const url = `${ALIO_BASE}/download/download.json?fileNo=${fileNo}`;
    const res = await axios.get(url, {
        headers: { 'User-Agent': UA },
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 500 * 1024 * 1024
    });
    fs.writeFileSync(destPath, Buffer.from(res.data));
    return fs.statSync(destPath).size;
}

// 같은 폴더 내 파일명 충돌 시 " (2)" 식 접미사
function resolveCollision(dir, fileName) {
    let candidate = fileName;
    let n = 2;
    while (fs.existsSync(path.join(dir, candidate))) {
        const ext = path.extname(fileName);
        candidate = `${path.basename(fileName, ext)} (${n})${ext}`;
        n += 1;
    }
    return candidate;
}

// ── 체크포인트 ───────────────────────────────────────────────────
function ckptPath() { return path.join(__dirname, '../data/logs/recruit_b1020_ckpt.json'); }
function loadCkpt() {
    try { return JSON.parse(fs.readFileSync(ckptPath(), 'utf8')); }
    catch { return { done: {} }; }
}
function saveCkpt(ckpt) {
    fs.mkdirSync(path.dirname(ckptPath()), { recursive: true });
    fs.writeFileSync(ckptPath(), JSON.stringify(ckpt, null, 2));
}

async function main() {
    const args = parseArgs(process.argv);
    const cutoffYear = new Date().getFullYear() - (args.years - 1);

    const institutionsAll = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/institutions.json'), 'utf8'));
    const institutions = args.apba
        ? institutionsAll.filter(inst => args.apba.includes(inst.apba_id))
        : institutionsAll;

    logger.info(`B1020 채용 첨부 수집 시작: 기관 ${institutions.length}개, ${cutoffYear}년 이후, 카테고리 [${args.categories.join(', ')}]${args.dryRun ? ' [DRY RUN]' : ''}`);

    const ckpt = loadCkpt();
    const totals = { postings: 0, skipped: 0, files: 0, bytes: 0, errors: 0 };

    for (const inst of institutions) {
        let rows;
        try {
            rows = await alioApi.fetchReportRowsSusi(inst.apba_id, REPORT_FORM_NO, { delayMs: REQUEST_DELAY_MS });
        } catch (err) {
            logger.error(`${inst.name}: 목록 조회 실패 — ${err.message}`);
            totals.errors += 1;
            continue;
        }

        // 연도 필터 (idate: "2026.03.04")
        let scoped = rows.filter(row => {
            const y = parseInt(String(row.idate || row.openDate || '').slice(0, 4), 10);
            return Number.isFinite(y) && y >= cutoffYear && row.idx;
        });
        if (args.limit > 0) scoped = scoped.slice(0, args.limit);
        if (!scoped.length) continue;

        logger.info(`${inst.name}: 게시글 ${scoped.length}건 (전체 ${rows.length}건 중 ${cutoffYear}년 이후)`);

        for (const row of scoped) {
            const key = `${inst.apba_id}:${row.idx}`;
            if (ckpt.done[key]) { totals.skipped += 1; continue; }

            const detailUrl = buildDetailUrl(row);
            let sections;
            try {
                const html = await fetchDetailHtml(detailUrl);
                sections = parseAttachmentSections(html);
            } catch (err) {
                logger.error(`${inst.name} idx=${row.idx}: 상세 조회 실패 — ${err.message}`);
                totals.errors += 1;
                await sleep(REQUEST_DELAY_MS);
                continue;
            }

            const year = String(row.idate || '').slice(0, 4) || 'unknown';
            const postFolder = sanitizeSegment(String(row.title || `idx_${row.idx}`)).slice(0, 120);
            const postDir = path.join(args.out, getInstitutionFolderName(inst), SCD_FOLDER, year, postFolder);

            const manifest = {
                disclosure_no: row.disclosureNo,
                idx: row.idx,
                title: row.title || '',
                idate: row.idate || '',
                source_url: detailUrl,
                collected_at: new Date().toISOString(),
                available_categories: Object.keys(sections),
                downloaded: {}
            };

            let downloadedAny = false;
            for (const category of args.categories) {
                const files = sections[category];
                if (!files) continue;
                manifest.downloaded[category] = [];
                for (const file of files) {
                    if (args.dryRun) {
                        logger.info(`  [DRY] ${category}: ${file.fileName} (fileNo=${file.fileNo})`);
                        continue;
                    }
                    try {
                        fs.mkdirSync(postDir, { recursive: true });
                        const safeName = resolveCollision(postDir, sanitizeSegment(file.fileName));
                        const size = await downloadFile(file.fileNo, path.join(postDir, safeName));
                        manifest.downloaded[category].push({ file_no: file.fileNo, file_name: safeName, size });
                        totals.files += 1;
                        totals.bytes += size;
                        downloadedAny = true;
                        logger.info(`  ${category}: ${safeName} (${(size / 1024).toFixed(0)}KB)`);
                    } catch (err) {
                        logger.error(`  다운로드 실패 fileNo=${file.fileNo} (${file.fileName}) — ${err.message}`);
                        totals.errors += 1;
                    }
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            if (!args.dryRun && downloadedAny) {
                fs.writeFileSync(path.join(postDir, 'recruit_manifest.json'), JSON.stringify(manifest, null, 2));
            }
            if (!args.dryRun) {
                ckpt.done[key] = { at: new Date().toISOString(), files: totals.files };
                saveCkpt(ckpt);
            }
            totals.postings += 1;
            await sleep(REQUEST_DELAY_MS);
        }
    }

    logger.info(`완료: 게시글 ${totals.postings}건 처리 (스킵 ${totals.skipped}) / 파일 ${totals.files}건 ${(totals.bytes / 1e6).toFixed(1)}MB / 오류 ${totals.errors}건`);
}

main().catch(err => { logger.error(err.stack || err.message); process.exit(1); });
