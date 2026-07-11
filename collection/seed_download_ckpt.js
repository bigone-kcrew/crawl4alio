#!/usr/bin/env node
/**
 * download_ckpt.json 시딩 — 기수집 report를 체크포인트에 백필.
 *
 * 용도: raw 아카이브(압축→오프사이트→로컬 삭제) 후에도 증분 수집이
 * 기수집 report를 재스크래핑/재다운로드하지 않도록, structured 트리의
 * manifest.json(disclosure_no)을 걸어 done 목록을 만든다.
 *
 * 시딩 항목은 idate가 없으므로(수집 당시 미기록) 무조건 스킵 처리된다.
 * 같은 disclosureNo의 개정(재공시)은 sync_alio → --retry-targets 경로로 재수집
 * (retry-targets는 ckpt 우회). 신규 공시는 새 disclosureNo라 ckpt에 없어 정상 수집.
 *
 * Usage: node collection/seed_download_ckpt.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');

const CKPT_PATH = process.env.DOWNLOAD_CKPT_PATH || fromLogsRoot('download_ckpt.json');
const DRY = process.argv.includes('--dry-run');
const BOARD_ZERO = '0000000000000000'; // 게시판형 더미 disclosureNo — 별도 ckpt(board/recruit) 소관

function loadCkpt(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { done: {} }; }
}

function main() {
    const structuredBase = fromCatalogRoot('structured_data');
    const ckpt = loadCkpt(CKPT_PATH);
    const before = Object.keys(ckpt.done).length;
    let scanned = 0, seeded = 0, skippedBoard = 0;

    const stack = [structuredBase];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue; }
            if (e.name !== 'manifest.json') continue;
            scanned++;
            let m;
            try { m = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')); } catch { continue; }
            const dn = m.report?.disclosure_no;
            if (!dn) continue;
            if (dn === BOARD_ZERO) { skippedBoard++; continue; }
            if (ckpt.done[dn]) continue; // 실수집 기록(idate 있음) 우선
            ckpt.done[dn] = {
                form: m.report?.report_form_root_no || '',
                idate: '',            // 미상 — 개정 재수집은 retry-targets가 담당
                at: new Date().toISOString(),
                seeded: true,
            };
            seeded++;
        }
    }

    if (!DRY) {
        fs.mkdirSync(path.dirname(CKPT_PATH), { recursive: true });
        const tmp = CKPT_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 1));
        fs.renameSync(tmp, CKPT_PATH);
    }
    console.log(`${DRY ? '[DRY-RUN] ' : ''}manifest ${scanned}건 스캔 → 시딩 ${seeded}건 (기존 ${before}, 게시판형 제외 ${skippedBoard})`);
    console.log(`ckpt: ${CKPT_PATH}`);
}

main();
