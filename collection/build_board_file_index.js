#!/usr/bin/env node
/**
 * 게시판형 첨부 전용 변환 인덱스 — board_files_index.json
 *
 * 게시판/채용 수집기(collect_board_disclosures/collect_recruit_attachments)의
 * 게시글 메타(board_manifest.json / recruit_manifest.json)를 걸어 첨부 바이너리를
 * 변환 인덱스로 만든다. 일반 download_files_index와 분리하는 이유:
 *  - 게시판형은 disclosureNo가 더미(0000…)라 일반 인덱스의 id 체계와 충돌
 *  - manifest 스키마가 달라 기관정보 없는 fallback 해석 → id `::…` 충돌 사고(v1.3.1)
 * id는 `form:apba:idx:파일명` — 게시글(idx) 단위로 전역 고유.
 *
 * 변환 실행:
 *   node collection/build_board_file_index.js
 *   node collection/convert_to_markdown.js --index <structured>/board_files_index.json
 *
 * Usage: CATALOG_ROOT=... node collection/build_board_file_index.js [--forms B1210,B1220]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fromCatalogRoot , fromStructuredRoot } = require('./project/crawler/utils/paths');
const { resolveRawBase } = require('./project/crawler/utils/structured_explorer');

const CONVERTIBLE = new Set(['.pdf', '.hwp', '.hwpx', '.hwpml', '.xlsx', '.xls', '.docx']);
const MANIFEST_NAMES = ['board_manifest.json', 'recruit_manifest.json'];

const formsArgIdx = process.argv.indexOf('--forms');
const FORMS = formsArgIdx >= 0 && process.argv[formsArgIdx + 1]
    ? new Set(process.argv[formsArgIdx + 1].split(',').map(s => s.trim().toUpperCase()))
    : null; // null = 전체

function parseInstitution(folderName) {
    // "[부처]기관명_C0847" → { ministry, name, apbaId }
    const m = folderName.match(/^\[([^\]]*)\](.*)_(C\d+)$/);
    if (!m) return { ministry: '', name: folderName, apbaId: '' };
    return { ministry: m[1], name: m[2], apbaId: m[3] };
}

function main() {
    const structuredBase = fromStructuredRoot();
    const rawBase = resolveRawBase(structuredBase) || structuredBase;
    const outPath = path.join(structuredBase, 'board_files_index.json');

    const entries = [];
    let postings = 0;
    const stack = [structuredBase];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        const manifestName = MANIFEST_NAMES.find(n => ents.some(e => e.isFile() && e.name === n));
        if (manifestName) {
            let mf;
            try { mf = JSON.parse(fs.readFileSync(path.join(dir, manifestName), 'utf8')); } catch { mf = null; }
            if (mf && (!FORMS || FORMS.has(String(mf.form_no || '').toUpperCase()))) {
                postings += 1;
                const rel = path.relative(structuredBase, dir);
                const parts = rel.split(path.sep); // [기관]/[B####_항목]/[연도]/[게시글]
                const inst = parseInstitution(parts[0] || '');
                const scdSeg = parts[1] || '';
                const scd = scdSeg.split('_')[0];
                const itemName = scdSeg.includes('_') ? scdSeg.slice(scdSeg.indexOf('_') + 1) : scdSeg;
                const year = parts[2] || '';
                // 첨부 바이너리는 raw 미러의 같은 게시글 폴더에 있음
                let rawFiles = [];
                try { rawFiles = fs.readdirSync(path.join(rawBase, rel), { withFileTypes: true }); } catch { /* raw 없음 */ }
                for (const f of rawFiles) {
                    if (!f.isFile()) continue;
                    const ext = path.extname(f.name).toLowerCase();
                    if (!CONVERTIBLE.has(ext)) continue;
                    entries.push({
                        id: `${mf.form_no}:${inst.apbaId}:${mf.idx}:${f.name}`,
                        institution_name: inst.name,
                        ministry: inst.ministry,
                        apba_id: inst.apbaId,
                        scd,
                        item_name: itemName,
                        year,
                        report_title: mf.title || parts[3] || '',
                        source_url: mf.source_url || '',
                        file_name: f.name,
                        file_path: path.join(rel, f.name),
                        downloaded: true, // raw 실측 기반
                    });
                }
            }
            continue; // 게시글 폴더 하위는 더 내려가지 않음
        }
        for (const e of ents) if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }

    entries.sort((a, b) => a.id.localeCompare(b.id));
    const payload = { generated_at: new Date().toISOString(), total_files: entries.length, files: entries };
    const tmp = outPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1));
    fs.renameSync(tmp, outPath);
    console.log(`게시글 ${postings}건 스캔 → 변환 대상 첨부 ${entries.length}건`);
    console.log(`인덱스: ${outPath}`);
}

main();
