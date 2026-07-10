#!/usr/bin/env node
'use strict';

/**
 * B1020/B1010(임·직원 채용정보) 게시판 첨부파일 수집기
 *
 * B1020(TTB_RECRUIT)·B1010(COMM_BOARD) 모두 게시판형으로 doc.html이 없고,
 * 각 itemBoardBXXXX.do 상세페이지에 첨부파일이 붙는다. 흐름:
 *   itemReportListSusi.json (idx 목록) → itemBoardBXXXX.do 상세 HTML 파싱
 *   → download/download.json?fileNo= 다운로드
 *
 * Usage:
 *   node collection/collect_recruit_attachments.js [options]
 *     --forms <목록>        공시코드 쉼표구분 (기본 "B1020,B1010")
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
const ALL_CATEGORIES = ['공고문', '입사지원서', '직무기술서', '기타 첨부파일'];
const REQUEST_DELAY_MS = 400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// 공시코드별 설정: 상세페이지 URL 경로, 기본 tableName, idxName
const FORM_CONFIG = {
    B1020: { detailPath: '/item/itemBoardB1020.do', tableName: 'TTB_RECRUIT', idxName: 'IDX',      scdFolder: 'B1020_인력관리' },
    B1010: { detailPath: '/item/itemBoardB1010.do', tableName: 'COMM_BOARD',  idxName: 'BOARD_NO', scdFolder: 'B1010_인력관리' },
};

// B1010 파일명 기반 카테고리 추론 키워드 (더 구체적인 것 먼저)
const CATEGORY_KEYWORDS = [
    { category: '직무기술서', patterns: [/직무\s*기술서/, /직무기술/, /NCS/, /직무\s*소개서/] },
    { category: '입사지원서', patterns: [/입사\s*지원서/, /지원\s*서류/, /지원서/, /자기소개서/, /이력서/] },
    { category: '공고문',    patterns: [/공고문/, /채용\s*공고/, /모집\s*공고/, /초빙\s*공고/, /공고/] },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
    const args = {
        forms: ['B1020', 'B1010'],
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
            case '--forms': args.forms = String(takeValue()).split(',').map(s => s.trim().toUpperCase()).filter(Boolean); break;
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

// B1020: <th>카테고리</th> 구간별로 fileNo 추출
function parseAttachmentSections_B1020(html) {
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

// B1010: 파일명에 [카테고리] 레이블이 있거나 키워드로 추론
function inferCategory(fileName) {
    // [카테고리] 형태
    const bracket = fileName.match(/^\[([^\]]+)\]/);
    if (bracket) {
        const label = bracket[1].trim();
        if (ALL_CATEGORIES.includes(label)) return label;
    }
    // 키워드 매칭
    for (const { category, patterns } of CATEGORY_KEYWORDS) {
        if (patterns.some(p => p.test(fileName))) return category;
    }
    return '기타 첨부파일';
}

function parseAttachmentSections_B1010(html) {
    const result = {};
    const fRe = /fileNo=(\d+)[^>]*>([^<]+)</g;
    let fm;
    const seen = new Set();
    while ((fm = fRe.exec(html)) !== null) {
        const fileNo = fm[1];
        let fileName = fm[2].trim();
        if (!fileName || seen.has(fileNo)) continue;
        // 버튼/아이콘 텍스트 제외
        if (/바로보기|다운로드|미리보기/.test(fileName)) continue;
        seen.add(fileNo);
        // [카테고리] 레이블을 파일명에서 제거하고 실제 파일명만 남김
        const cleanName = fileName.replace(/^\[[^\]]+\]\s*/, '');
        const category = inferCategory(fileName);
        if (!result[category]) result[category] = [];
        result[category].push({ fileNo, fileName: cleanName || fileName });
    }
    return result;
}

function parseAttachmentSections(html, formNo) {
    if (formNo === 'B1010') return parseAttachmentSections_B1010(html);
    return parseAttachmentSections_B1020(html);
}

function buildDetailUrl(row, formNo) {
    const cfg = FORM_CONFIG[formNo] || FORM_CONFIG.B1020;
    const params = new URLSearchParams({
        disclosureNo: row.disclosureNo,
        apbaId: row.apbaId,
        nowcode: formNo,
        reportFormNo: row.reportFormNo || formNo,
        table_name: row.tableName || cfg.tableName,
        idx_name: row.idxName || cfg.idxName,
        idx: row.idx,
        reportGbn: row.reportGbn || 'N'
    });
    return `${ALIO_BASE}${cfg.detailPath}?${params.toString()}`;
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

// fileNo → 다운로드된 절대경로. 같은 fileNo는 재다운로드 없이 복사.
const fileNoCache = new Map();

// destPath에 파일을 확보한다. 반환값: { action: 'downloaded'|'copied'|'skipped', size }
async function acquireFile(fileNo, destPath) {
    // fileNo 캐시 hit → 복사 (이미 다운로드된 파일 재사용)
    if (fileNoCache.has(fileNo)) {
        const src = fileNoCache.get(fileNo);
        if (!fs.existsSync(destPath)) {
            fs.copyFileSync(src, destPath);
        }
        return { action: 'copied', size: fs.statSync(destPath).size };
    }
    // 파일명 충돌 (fileNo가 다른 파일) → 크기 비교
    if (fs.existsSync(destPath)) {
        const existingSize = fs.statSync(destPath).size;
        const tmpPath = destPath + '.__tmp';
        try {
            const newSize = await downloadFile(fileNo, tmpPath);
            if (newSize === existingSize) {
                // 크기 동일 → 같은 내용으로 간주, 스킵
                fs.unlinkSync(tmpPath);
                fileNoCache.set(fileNo, destPath);
                return { action: 'skipped', size: existingSize };
            }
            // 크기 다름 → _alt 이름으로 보존
            const ext = path.extname(destPath);
            const base = path.basename(destPath, ext);
            const dir = path.dirname(destPath);
            let n = 2;
            let altPath;
            do { altPath = path.join(dir, `${base}_alt${n}${ext}`); n++; } while (fs.existsSync(altPath));
            fs.renameSync(tmpPath, altPath);
            fileNoCache.set(fileNo, altPath);
            return { action: 'alt', size: newSize };
        } catch (err) {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            throw err;
        }
    }
    // 신규 다운로드
    const size = await downloadFile(fileNo, destPath);
    fileNoCache.set(fileNo, destPath);
    return { action: 'downloaded', size };
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

async function processForm(inst, formNo, args, cutoffYear, ckpt, totals) {
    const cfg = FORM_CONFIG[formNo] || FORM_CONFIG.B1020;
    let rows;
    try {
        rows = await alioApi.fetchReportRowsSusi(inst.apba_id, formNo, { delayMs: REQUEST_DELAY_MS });
    } catch (err) {
        logger.error(`${inst.name}(${formNo}): 목록 조회 실패 — ${err.message}`);
        totals.errors += 1;
        return;
    }

    let scoped = rows.filter(row => {
        const y = parseInt(String(row.idate || row.openDate || '').slice(0, 4), 10);
        return Number.isFinite(y) && y >= cutoffYear && row.idx;
    });
    if (args.limit > 0) scoped = scoped.slice(0, args.limit);
    if (!scoped.length) return;

    logger.info(`${inst.name}(${formNo}): 게시글 ${scoped.length}건 (${cutoffYear}년 이후)`);

    for (const row of scoped) {
        const key = `${formNo}:${inst.apba_id}:${row.idx}`;
        if (ckpt.done[key]) {
            // idate가 저장된 것과 같으면 스킵, 달라지면 재처리 (파일 교체 감지)
            const saved = ckpt.done[key];
            if (!saved.idate || saved.idate === (row.idate || '')) { totals.skipped += 1; continue; }
            logger.info(`${inst.name}(${formNo}) idx=${row.idx}: idate 변경 감지 (${saved.idate} → ${row.idate}), 재처리`);
        }

        const detailUrl = buildDetailUrl(row, formNo);
        let sections;
        try {
            const html = await fetchDetailHtml(detailUrl);
            sections = parseAttachmentSections(html, formNo);
        } catch (err) {
            logger.error(`${inst.name}(${formNo}) idx=${row.idx}: 상세 조회 실패 — ${err.message}`);
            totals.errors += 1;
            await sleep(REQUEST_DELAY_MS);
            continue;
        }

        const year = String(row.idate || '').slice(0, 4) || 'unknown';
        const postFolder = sanitizeSegment(String(row.title || `idx_${row.idx}`)).slice(0, 120);
        const postDir = path.join(args.out, getInstitutionFolderName(inst), cfg.scdFolder, year, postFolder);

        const manifest = {
            form_no: formNo,
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
                    const safeName = sanitizeSegment(file.fileName) || 'file';
                    const { action, size } = await acquireFile(file.fileNo, path.join(postDir, safeName));
                    manifest.downloaded[category].push({ file_no: file.fileNo, file_name: safeName, size, action });
                    totals.files += 1;
                    totals.bytes += size;
                    downloadedAny = true;
                    logger.info(`  ${category} [${action}]: ${safeName} (${(size / 1024).toFixed(0)}KB)`);
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
            ckpt.done[key] = { at: new Date().toISOString(), files: totals.files, idate: row.idate || '' };
            saveCkpt(ckpt);
        }
        totals.postings += 1;
        await sleep(REQUEST_DELAY_MS);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const cutoffYear = new Date().getFullYear() - (args.years - 1);

    const institutionsAll = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/institutions.json'), 'utf8'));
    const institutions = args.apba
        ? institutionsAll.filter(inst => args.apba.includes(inst.apba_id))
        : institutionsAll;

    const unknownForms = args.forms.filter(f => !FORM_CONFIG[f]);
    if (unknownForms.length) {
        logger.error(`알 수 없는 form 코드: ${unknownForms.join(', ')} (지원: ${Object.keys(FORM_CONFIG).join(', ')})`);
        process.exit(1);
    }

    logger.info(`채용 첨부 수집 시작: form [${args.forms.join(', ')}], 기관 ${institutions.length}개, ${cutoffYear}년 이후, 카테고리 [${args.categories.join(', ')}]${args.dryRun ? ' [DRY RUN]' : ''}`);

    const ckpt = loadCkpt();
    const totals = { postings: 0, skipped: 0, files: 0, bytes: 0, errors: 0 };

    for (const inst of institutions) {
        for (const formNo of args.forms) {
            await processForm(inst, formNo, args, cutoffYear, ckpt, totals);
        }
    }

    logger.info(`완료: 게시글 ${totals.postings}건 처리 (스킵 ${totals.skipped}) / 파일 ${totals.files}건 ${(totals.bytes / 1e6).toFixed(1)}MB / 오류 ${totals.errors}건`);
}

main().catch(err => { logger.error(err.stack || err.message); process.exit(1); });
