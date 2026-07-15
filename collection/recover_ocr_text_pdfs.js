#!/usr/bin/env node
/**
 * OCR 큐 텍스트PDF 회수 (kordoc 복구)
 *
 * ocr_needed.json 중 실제로는 "텍스트 내장 PDF"인데 잘못 OCR로 이관된 문서를
 * kordoc으로 재추출해 OCR 없이 복구한다. kordoc은 OCR보다 품질이 좋고 훨씬 빠르다
 * (대형 감사보고서: OCR 수십분 → kordoc 수십초).
 *
 * 오이관 원인: 초기 변환의 kordoc 타임아웃이 짧아(기본 30s) 대형 텍스트PDF가 타임아웃→ocr_needed.
 * → convert_to_markdown.js의 KORDOC_PDF_TIMEOUT_MS(기본 300s)로 예방. 이 스크립트는 잔여/증분 회수용.
 *
 * 대상: reason이 timeout/aborted/low_quality 이고, 텍스트연산(BT/Tj) 있고 이미지 적은 PDF, 미완료.
 *   (empty_content는 폰트/ToUnicode 부재라 kordoc·OCR 모두 빈결과 → 제외)
 *
 * Usage:
 *   node collection/recover_ocr_text_pdfs.js [--dry-run] [--limit=N]
 * Env:
 *   KORDOC_PARSE_URL     kordoc HTTP API (미설정 시 npm 내장)
 *   RECOVER_TIMEOUT_MS   건당 타임아웃(기본 300000)
 *   RECOVER_REASON_RE    대상 사유 정규식(기본 'timeout|aborted|low_quality')
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');
const parsers = require('./project/crawler/utils/parsers');

const DRY = process.argv.includes('--dry-run');
const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
const TIMEOUT = parseInt(process.env.RECOVER_TIMEOUT_MS || '300000', 10);
const REASON_RE = new RegExp(process.env.RECOVER_REASON_RE || 'timeout|aborted|low_quality', 'i');
const MIN_CHARS = 20;

const OCR_NEEDED_PATH = fromLogsRoot('ocr_needed.json');
const OCK_PATH = fromLogsRoot('ocr_checkpoint.json');
const CCK_PATH = fromLogsRoot('conversion_checkpoint.json');
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
// 원본 alio-raw → 산출 alio-md, .pdf → .md (convert_ocr_needed.js와 동일 규약)
const toMd = p => p.replace('/alio-raw/', '/alio-md/').replace(/\.(pdf)$/i, '.md');

// 텍스트PDF 판별: 텍스트연산(BT/Tj) 존재 + 이미지 적음(스캔 아님)
function isTextPdf(fp) {
  try {
    const s = fs.readFileSync(fp).toString('latin1');
    const img = (s.match(/\/Subtype\s*\/Image/g) || []).length + (s.match(/\/DCTDecode/g) || []).length;
    let t = (s.match(/\bBT\b/g) || []).length;
    if (t === 0) { for (const m of s.matchAll(/stream\r?\n(.*?)endstream/gs)) { try { if (/\b(Tj|TJ)\b/.test(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))) t++; } catch {} if (t) break; } }
    return t > 0 && img <= 2;
  } catch { return false; }
}

(async () => {
  const need = rd(OCR_NEEDED_PATH);
  const arr = (need.files || need.items || []).filter(x => x && x.file_path);
  const targets = [];
  for (const it of arr) {
    if (!REASON_RE.test(it.reason || '')) continue;
    const md = toMd(it.file_path);
    try { if (fs.existsSync(md) && fs.statSync(md).size > 0) continue; } catch {}
    if (!fs.existsSync(it.file_path)) continue;
    if (!isTextPdf(it.file_path)) continue;
    targets.push(it);
  }
  const list = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  console.log(`[회수] 대상 ${targets.length}건 (처리 ${list.length}) · kordoc=${parsers.KORDOC_HTTP_URL || 'npm내장'} · timeout ${TIMEOUT}ms${DRY ? ' · DRY-RUN' : ''}`);

  let ok = 0, empty = 0, fail = 0;
  const now = () => new Date().toISOString().slice(11, 19);
  for (let i = 0; i < list.length; i++) {
    const it = list[i]; const name = path.basename(it.file_path);
    const pct = ((i + 1) / list.length * 100).toFixed(1); const t0 = Date.now();
    let md = '';
    try {
      const buf = fs.readFileSync(it.file_path);
      const res = await parsers.callKordoc(buf, name, TIMEOUT);
      md = String(res?.result?.markdown || '').trim();
      if (res && res.ok === false) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] FAIL  ${name}  ${(res.error?.message||res.error?.code||'').slice(0,40)}`); fail++; continue; }
    } catch (e) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] FAIL  ${name}  ${String(e.message||e).slice(0,40)}`); fail++; continue; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (md.length < MIN_CHARS) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] EMPTY ${name} (${secs}s) — OCR 유지`); empty++; continue; }
    const outPath = toMd(it.file_path);
    if (DRY) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] DRY   ${name}  ${md.length}자 (${secs}s)`); ok++; continue; }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md);
    for (const [P, patch] of [[OCK_PATH, { status: 'success', output: outPath, method: 'kordoc_recovery', note: 'kordoc_recovery', processed_at: new Date().toISOString() }],
                              [CCK_PATH, null]]) {
      try {
        const ck = rd(P); ck.files = ck.files || ck;
        if (P === OCK_PATH) { ck.files[it.id] = patch; ck.success = (ck.success || 0) + 1; }
        else if (ck.files[it.id]) { ck.files[it.id].status = 'success'; ck.files[it.id].method = 'kordoc_recovery'; }
        fs.writeFileSync(P + '.t', JSON.stringify(ck, null, 2)); fs.renameSync(P + '.t', P);
      } catch (e) { console.log(`  ⚠️ ${path.basename(P)}: ${e.message}`); }
    }
    console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] OK    ${name}  ${md.length}자 (${secs}s)`);
    ok++;
  }
  console.log(`\n[회수 완료] OK ${ok} · EMPTY ${empty}(OCR유지) · FAIL ${fail}`);
})();
