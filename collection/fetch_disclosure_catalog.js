#!/usr/bin/env node
/**
 * ALIO 공시항목 카탈로그 수집·재생성
 *
 * formList.json에서 전체 공시항목(92개)을 받아:
 *   1) data/disclosure_items_raw.json — API 원본 (disclosureType·reportType·quart 등 포함)
 *   2) data/disclosure_items.json     — 정규화 스키마 + disclosure_kind('정기'|'수시')
 *
 * disclosure_kind 판정: PERIODIC_SCDS(임원연봉 등 5종, itemReportListSusi가
 * 에러를 반환하는 연 1회 공시)는 '정기', 나머지는 '수시'.
 * 런타임에서 판정이 틀리면 alio_api.fetchReportRows가 반대 API로 폴백한다.
 *
 * Usage:
 *   node collection/fetch_disclosure_catalog.js            # 수집·저장
 *   node collection/fetch_disclosure_catalog.js --dry-run  # 기존 파일과 diff만 출력
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { fetchDisclosureCatalog, PERIODIC_SCDS } = require('./project/crawler/utils/alio_api');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RAW_PATH = path.join(DATA_DIR, 'disclosure_items_raw.json');
const ITEMS_PATH = path.join(DATA_DIR, 'disclosure_items.json');
const DRY_RUN = process.argv.includes('--dry-run');

function normalizeItem(row) {
    const reportNos = String(row.reportNos || '').trim();
    const scd = reportNos.split(',')[0].trim();
    return {
        report_form_root_no: reportNos,
        item_name: row.mcdnm || '',
        major_category: row.lcdnm || '',
        minor_category: row.nmcdnm || '',
        cycle_type: String(row.quart ?? ''),
        disclosure_kind: PERIODIC_SCDS.has(scd) ? '정기' : '수시'
    };
}

async function main() {
    console.log('ALIO 공시항목 카탈로그 조회 중 (formList.json)...');
    const rawRows = await fetchDisclosureCatalog();
    if (rawRows.length === 0) throw new Error('카탈로그 응답이 비어 있습니다.');
    console.log(`수신: ${rawRows.length}개 항목`);

    const items = rawRows.map(normalizeItem);
    const kinds = items.reduce((acc, it) => { acc[it.disclosure_kind] = (acc[it.disclosure_kind] || 0) + 1; return acc; }, {});
    console.log(`정기 ${kinds['정기'] || 0} / 수시 ${kinds['수시'] || 0}`);

    if (fs.existsSync(ITEMS_PATH)) {
        const existing = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
        const existingKeys = new Set(existing.map(it => it.report_form_root_no));
        const newKeys = new Set(items.map(it => it.report_form_root_no));
        const added = items.filter(it => !existingKeys.has(it.report_form_root_no));
        const removed = existing.filter(it => !newKeys.has(it.report_form_root_no));
        console.log(`기존 ${existing.length}개 대비 — 추가 ${added.length}건, 삭제 ${removed.length}건`);
        for (const it of added) console.log(`  + ${it.report_form_root_no} ${it.item_name}`);
        for (const it of removed) console.log(`  - ${it.report_form_root_no} ${it.item_name}`);
    }

    if (DRY_RUN) { console.log('[DRY RUN] 저장하지 않음'); return; }

    fs.writeFileSync(RAW_PATH, JSON.stringify({ fetched_at: new Date().toISOString(), data: rawRows }, null, 2));
    fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
    console.log(`저장 완료: ${path.relative(process.cwd(), RAW_PATH)}, ${path.relative(process.cwd(), ITEMS_PATH)}`);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
