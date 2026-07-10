#!/usr/bin/env node
/**
 * recruit_b1020_ckpt.json 재빌드
 * 파일 시스템의 recruit_manifest.json을 스캔해서 체크포인트를 재구성한다.
 * 기존 체크포인트를 덮어쓰지 않고 병합(union)한다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAW_BASE  = '/workspace/alio/2_data/alio-raw/자료/기관별공시';
const CKPT_PATH = path.join(__dirname, '../data/logs/recruit_b1020_ckpt.json');
const DRY_RUN   = process.argv.includes('--dry-run');

function loadCkpt() {
    try { return JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8')); }
    catch { return { done: {} }; }
}

function saveCkpt(ckpt) {
    const tmp = CKPT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 2));
    fs.renameSync(tmp, CKPT_PATH);
}

// 폴더명에서 apbaId 추출: "[부처]기관명_C0123" → "C0123"
function apbaFromDir(dirName) {
    const m = dirName.match(/_([A-Z]\d+)$/);
    return m ? m[1] : null;
}

function main() {
    // find로 모든 recruit_manifest.json 수집
    let files;
    try {
        const out = execSync(
            `find "${RAW_BASE}" -name "recruit_manifest.json" 2>/dev/null`,
            { maxBuffer: 50 * 1024 * 1024 }
        ).toString().trim();
        files = out ? out.split('\n') : [];
    } catch {
        files = [];
    }

    console.log(`manifest 파일: ${files.length}건`);

    const ckpt = loadCkpt();
    const before = Object.keys(ckpt.done).length;
    let added = 0, already = 0, skipped = 0;

    for (const mPath of files) {
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')); }
        catch { skipped++; continue; }

        const { form_no, idx, idate } = manifest;
        if (!form_no || !idx) { skipped++; continue; }

        // 폴더 구조: .../기관별공시/[부처]기관명_CXXXX/B10XX_.../연도/공고명/recruit_manifest.json
        const parts = mPath.split(path.sep);
        const instDir = parts[parts.indexOf('기관별공시') + 1] || '';
        const apbaId  = apbaFromDir(instDir);
        if (!apbaId) { skipped++; continue; }

        const key = `${form_no}:${apbaId}:${idx}`;
        if (ckpt.done[key]) {
            // idate 불일치 시 갱신
            const saved = ckpt.done[key];
            if (saved.idate && idate && saved.idate !== idate) {
                if (!DRY_RUN) ckpt.done[key] = { ...saved, idate };
                added++;
            } else {
                already++;
            }
        } else {
            if (!DRY_RUN) {
                ckpt.done[key] = { at: 'rebuilt', files: 0, idate: idate || '' };
            }
            added++;
        }
    }

    const after = Object.keys(ckpt.done).length;
    console.log(`기존: ${before}건  →  추가/갱신: ${added}건  이미존재: ${already}건  스킵: ${skipped}건`);
    console.log(`재빌드 후: ${after}건`);

    if (DRY_RUN) {
        console.log('[DRY RUN] 저장하지 않음');
        return;
    }

    // 백업 후 저장
    const backup = CKPT_PATH.replace('.json', `_backup_${Date.now()}.json`);
    fs.copyFileSync(CKPT_PATH, backup);
    console.log(`백업: ${path.basename(backup)}`);
    saveCkpt(ckpt);
    console.log('저장 완료');
}

main();
