#!/usr/bin/env node
/**
 * ALIO 증분 동기화 — 저장본 vs 웹 최신본 대조 후 신규 공시 수집
 *
 * 두 가지 대조 방식:
 *   fast (기본) : 사이트 전역 최근공시 feed(findDisclosureList.json)와 로컬 인덱스 diff.
 *                 cron으로 매일 돌리기 적합. 최근 N건(--end-num) 밖의 누락은 못 잡음.
 *   full (--full): 스코프 내 (기관 × 공시코드) 전 조합을 라이브 API로 열거해 전수 대조.
 *                 체크포인트 저장으로 중단 후 --resume 재개 가능.
 *
 * 두 가지 실행 모드:
 *   report (기본) : 누락 목록을 리포트·retry-targets 파일로만 생성 (반자동 —
 *                  사람이 검토 후 download_documents_advanced.js --retry-targets 실행)
 *   apply         : 리포트 생성 후 즉시 다운로드까지 실행 (자동)
 *
 * Usage:
 *   node collection/sync_alio.js                              # fast + report
 *   node collection/sync_alio.js --end-num 200                # feed 조회 폭 확대
 *   node collection/sync_alio.js --full --items 21026         # 특정 항목 전수 대조
 *   node collection/sync_alio.js --full --ministry 고용노동부 --resume
 *   node collection/sync_alio.js --mode=apply                 # 감지 즉시 수집
 *   공통 선택 옵션: --scope all|categories|items, --categories, --items,
 *                  --ministry, --apba-ids, --inst-type, --limit, --year
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const alioApi = require('./project/crawler/utils/alio_api');
const { buildDisclosureLookup } = require('./project/crawler/utils/disclosure_scope');

const DATA_DIR = require('./project/crawler/utils/paths').catalogRoot;
const STRUCTURED_DIR = path.join(DATA_DIR, 'structured_data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CHECKPOINT_PATH = path.join(LOGS_DIR, 'sync_alio_checkpoint.json');
const RETRY_TARGETS_PATH = path.join(LOGS_DIR, 'recency_retry_targets.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
    const args = {
        full: false, files: false, mode: 'report', resume: false,
        endNum: 100, maxPages: 50, delayMs: 700,
        ministry: null, apbaIds: null, instType: null, limit: 0, year: null,
        scope: null, categories: null, items: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        const inlineValue = eq > 0 ? arg.slice(eq + 1) : null;
        const takeValue = () => inlineValue !== null ? inlineValue : (argv[++i] || '');

        switch (name) {
            case '--full': args.full = true; break;
            case '--files': args.files = true; break;
            case '--resume': args.resume = true; break;
            case '--mode': args.mode = takeValue().trim(); break;
            case '--end-num': args.endNum = parseInt(takeValue(), 10) || 100; break;
            case '--max-pages': args.maxPages = parseInt(takeValue(), 10) || 50; break;
            case '--delay-ms': args.delayMs = parseInt(takeValue(), 10) || 700; break;
            case '--ministry': args.ministry = takeValue(); break;
            case '--apba-ids': args.apbaIds = new Set(parseList(takeValue())); break;
            case '--inst-type': args.instType = takeValue().trim(); break;
            case '--limit': args.limit = parseInt(takeValue(), 10) || 0; break;
            case '--year': args.year = String(takeValue()).trim(); break;
            case '--scope': args.scope = takeValue().trim(); break;
            case '--categories': args.categories = parseList(takeValue()); break;
            case '--items': args.items = parseList(takeValue()); break;
        }
    }
    return args;
}

// ── 로컬 보유분 로드 ────────────────────────────────────────────────────────────

function loadStoredDisclosureNos() {
    const indexPath = path.join(STRUCTURED_DIR, 'index.json');
    const stored = new Set();
    if (!fs.existsSync(indexPath)) return stored;

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const doc of index.documents || []) {
        const disclosureNo = String(doc.disclosure_no || String(doc.id || '').split(':')[2] || '').trim();
        if (disclosureNo) stored.add(disclosureNo);
    }
    return stored;
}

function loadStoredFilesByDisclosure() {
    const indexPath = path.join(STRUCTURED_DIR, 'download_files_index.json');
    const byDisclosure = new Map();
    if (!fs.existsSync(indexPath)) return byDisclosure;

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const file of index.files || []) {
        const disclosureNo = String(file.disclosure_no || '').trim();
        if (!disclosureNo) continue;
        if (!byDisclosure.has(disclosureNo)) byDisclosure.set(disclosureNo, new Set());
        byDisclosure.get(disclosureNo).add(String(file.file_name || ''));
    }
    return byDisclosure;
}

// ── fast tier: 전역 최근공시 feed 대조 ─────────────────────────────────────────

async function runFastTier(args, ctx) {
    const { stored, institutionByName, itemByCode, scopedCodes } = ctx;
    console.log(`[FAST] 최근 공시 feed 조회 (endNum=${args.endNum})`);
    const rows = await alioApi.fetchRecentDisclosures(args.endNum);
    console.log(`[FAST] 수신 ${rows.length}건`);

    const missing = [];
    const unmatched = [];
    let outOfScope = 0;
    let alreadyStored = 0;

    for (const row of rows) {
        const disclosureNo = String(row.disclosureNo || '').trim();
        const reportFormNo = String(row.reportFormNo || '').trim();
        if (!disclosureNo) continue;
        if (stored.has(disclosureNo)) { alreadyStored++; continue; }
        if (!scopedCodes.has(reportFormNo)) { outOfScope++; continue; }

        const inst = institutionByName.get(String(row.pname || '').trim());
        if (!inst) {
            unmatched.push({ disclosure_no: disclosureNo, institution_name: row.pname, report_form_no: reportFormNo, title: row.title });
            continue;
        }

        const item = itemByCode[reportFormNo];
        missing.push({
            apba_id: inst.apba_id,
            institution_name: inst.name,
            report_no: reportFormNo,
            disclosure_no: disclosureNo,
            title: row.title || '',
            disclosure_kind: item?.disclosure_kind || '',
            detected_at: new Date().toISOString()
        });
    }

    return {
        tier: 'fast',
        stats: { feed_rows: rows.length, already_stored: alreadyStored, out_of_scope: outOfScope, missing: missing.length, unmatched: unmatched.length },
        missing, unmatched, missing_files: []
    };
}

// ── full tier: (기관 × 공시코드) 전수 대조 ─────────────────────────────────────

function loadCheckpoint(resume) {
    if (resume && fs.existsSync(CHECKPOINT_PATH)) {
        try { return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')); } catch { /* 손상 시 초기화 */ }
    }
    return { started_at: new Date().toISOString(), done: {} };
}

async function runFullTier(args, ctx) {
    const { stored, storedFiles, institutions, itemByCode, scopedCodes, targetYears } = ctx;
    const codes = [...scopedCodes].sort();
    const ckpt = loadCheckpoint(args.resume);
    const totalPairs = institutions.length * codes.length;
    console.log(`[FULL] 대조 대상: 기관 ${institutions.length} × 코드 ${codes.length} = ${totalPairs}조합${args.resume ? ` (체크포인트 ${Object.keys(ckpt.done).length}건 재개)` : ''}`);

    const missing = [];
    const missingFiles = [];
    let processed = 0;
    let sinceSave = 0;

    for (const inst of institutions) {
        for (const code of codes) {
            const key = `${inst.apba_id}:${code}`;
            processed++;
            if (ckpt.done[key]) continue;

            const item = itemByCode[code];
            const kindHint = item?.disclosure_kind || null;
            let liveRows = [];
            let kind = kindHint || '';
            try {
                const live = await alioApi.fetchReportRows(inst.apba_id, code, kindHint, { maxPages: args.maxPages, delayMs: Math.min(args.delayMs, 500) });
                liveRows = live.rows.map(row => alioApi.normalizeReportRow(row, code));
                kind = live.disclosure_kind;
            } catch (err) {
                console.log(`  [ERR] ${inst.name}/${code}: ${err.message}`);
                ckpt.done[key] = { at: new Date().toISOString(), error: err.message };
                continue;
            }

            let missCount = 0;
            for (const row of liveRows) {
                if (!row.disclosure_no) continue; // 게시판형 항목(21110 등)은 disclosureNo 없음
                if (args.year && row.year !== args.year) continue;
                if (targetYears.size && row.year && !targetYears.has(row.year)) continue;
                if (stored.has(row.disclosure_no)) {
                    // --files: 보유 공시의 첨부 누락 검사
                    if (args.files) {
                        try {
                            const liveFiles = await alioApi.fetchReportFiles(row.disclosure_no);
                            const localNames = storedFiles.get(row.disclosure_no) || new Set();
                            for (const f of Array.isArray(liveFiles) ? liveFiles : []) {
                                const name = String(f.fileNm || f.file_name || f.name || '').trim();
                                if (name && !localNames.has(name)) {
                                    missingFiles.push({ apba_id: inst.apba_id, report_no: code, disclosure_no: row.disclosure_no, file_name: name });
                                }
                            }
                            await sleep(300);
                        } catch { /* 파일 목록 조회 실패는 무시 */ }
                    }
                    continue;
                }
                missCount++;
                missing.push({
                    apba_id: inst.apba_id,
                    institution_name: inst.name,
                    report_no: code,
                    disclosure_no: row.disclosure_no,
                    year: row.year,
                    title: row.title || '',
                    disclosure_kind: kind,
                    detected_at: new Date().toISOString()
                });
            }

            ckpt.done[key] = { at: new Date().toISOString(), live: liveRows.length, missing: missCount };
            if (++sinceSave >= 20) {
                fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(ckpt, null, 2));
                sinceSave = 0;
            }
            if (processed % 50 === 0) console.log(`  진행 ${processed}/${totalPairs} — 누락 ${missing.length}건`);
            await sleep(args.delayMs);
        }
    }

    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(ckpt, null, 2));
    return {
        tier: 'full',
        stats: { pairs: totalPairs, missing: missing.length, missing_files: missingFiles.length },
        missing, missing_files: missingFiles, unmatched: []
    };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(LOGS_DIR, { recursive: true });

    const institutionsAll = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'institutions.json'), 'utf8'));
    const disclosureItems = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'disclosure_items.json'), 'utf8'));
    const crawlTargets = yaml.load(fs.readFileSync(path.join(__dirname, 'project/crawler/config/crawl_targets.yaml'), 'utf8'));
    const { itemByCode, scopedCodes } = buildDisclosureLookup(disclosureItems, crawlTargets, args);

    let institutions = institutionsAll.filter(inst => {
        if (args.ministry && inst.ministry !== args.ministry) return false;
        if (args.apbaIds && !args.apbaIds.has(inst.apba_id)) return false;
        if (args.instType && inst.type !== args.instType) return false;
        return true;
    });
    if (args.limit > 0) institutions = institutions.slice(0, args.limit);

    const ctx = {
        stored: loadStoredDisclosureNos(),
        storedFiles: args.files ? loadStoredFilesByDisclosure() : new Map(),
        institutions,
        institutionByName: new Map(institutionsAll.map(inst => [inst.name, inst])),
        itemByCode,
        scopedCodes,
        targetYears: new Set((crawlTargets.target_years || []).map(String))
    };
    console.log(`로컬 보유 공시: ${ctx.stored.size}건 / 스코프 코드: ${scopedCodes.size}개 / 대상 기관: ${institutions.length}개`);

    const result = args.full ? await runFullTier(args, ctx) : await runFastTier(args, ctx);

    // 리포트 저장
    const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const reportPath = path.join(LOGS_DIR, `sync_alio_report_${dateTag}.json`);
    const report = {
        generated_at: new Date().toISOString(),
        tier: result.tier,
        mode: args.mode,
        scope: { codes: scopedCodes.size, institutions: institutions.length, ministry: args.ministry, year: args.year },
        stats: result.stats,
        missing: result.missing,
        missing_files: result.missing_files,
        unmatched: result.unmatched
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n리포트 저장: ${path.relative(process.cwd(), reportPath)}`);
    console.log(`통계: ${JSON.stringify(result.stats)}`);

    if (result.unmatched.length) {
        console.log(`⚠ 기관 매칭 실패 ${result.unmatched.length}건 — 리포트의 unmatched 확인 필요`);
    }

    if (result.missing.length === 0 && result.missing_files.length === 0) {
        console.log('신규/누락 공시 없음 — retry-targets 미작성');
        return;
    }

    // retry-targets 작성 (누락 첨부는 해당 공시 재수집으로 처리)
    const targets = [...result.missing];
    const seenPairs = new Set(targets.map(t => `${t.apba_id}:${t.report_no}:${t.disclosure_no}`));
    for (const mf of result.missing_files) {
        const key = `${mf.apba_id}:${mf.report_no}:${mf.disclosure_no}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        targets.push({ apba_id: mf.apba_id, report_no: mf.report_no, disclosure_no: mf.disclosure_no, reason: 'missing_file' });
    }
    fs.writeFileSync(RETRY_TARGETS_PATH, JSON.stringify(targets, null, 2));
    console.log(`retry-targets 저장: ${path.relative(process.cwd(), RETRY_TARGETS_PATH)} (${targets.length}건)`);

    if (args.mode === 'apply') {
        console.log('\n[APPLY] download_documents_advanced.js 실행...');
        const run = spawnSync('node', [
            path.join(__dirname, 'download_documents_advanced.js'),
            '--retry-targets', RETRY_TARGETS_PATH,
            ...(args.scope ? [`--scope=${args.scope}`] : []),
            ...(args.items ? [`--items=${args.items.join(',')}`] : []),
            ...(args.categories ? [`--categories=${args.categories.join(',')}`] : [])
        ], { stdio: 'inherit' });
        if (run.status !== 0) {
            console.error(`[APPLY] 다운로드 스크립트 종료 코드 ${run.status}`);
            process.exit(run.status || 1);
        }
        console.log('\n[APPLY] 완료. 후속 작업:');
        console.log('  node collection/build_download_file_index.js   # 파일 인덱스 갱신');
        console.log('  node collection/convert_to_markdown.js         # 신규 첨부 MD 변환');
    } else {
        console.log('\n[REPORT] 검토 후 수집하려면:');
        console.log(`  node collection/download_documents_advanced.js --retry-targets ${path.relative(process.cwd(), RETRY_TARGETS_PATH)}`);
    }
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
