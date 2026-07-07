'use strict';
/**
 * 참고문서(PDF·HWP·HWPX·DOCX·XLSX) → Markdown 변환 (kordoc → PaddleOCR 폴백).
 * legal 등 corpus에 새 원본을 추가할 때 raw 폴더를 md 폴더로 미러 변환하는 재사용 스크립트.
 *
 * 사용법:
 *   node collection/convert_reference_docs.js                 # 기본: legal-raw/법령자료 → legal-md/법령자료
 *   node collection/convert_reference_docs.js --src <dir> --dest <dir>
 *   node collection/convert_reference_docs.js --dry           # 미리보기(변환 안 함)
 *   node collection/convert_reference_docs.js --force         # 이미 md 있어도 재변환
 *   node collection/convert_reference_docs.js --only 표준·권장안   # 하위 폴더명 필터
 *
 * 엔드포인트(환경변수로 override):
 *   KORDOC_PARSE_URL     (default http://localhost:3400/parse)
 *   PADDLEOCR_PARSE_URL  (default http://localhost:13430/parse)
 *
 * 변환 후 해당 corpus의 인덱스를 재생성하세요.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const KORDOC_URL = process.env.KORDOC_PARSE_URL    || 'http://localhost:3400/parse';
const OCR_URL    = process.env.PADDLEOCR_PARSE_URL || 'http://localhost:13430/parse';
const EXTS = new Set(['.pdf', '.hwp', '.hwpx', '.hwpml', '.docx', '.xlsx']);
const MIN_LEN = 100;         // 이보다 짧으면 변환 실패로 간주 → OCR 폴백
const KORDOC_TIMEOUT = 300000;
const OCR_TIMEOUT = 3600000;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt  = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i+1] ? args[i+1] : d; };
const SRC  = path.resolve(opt('--src',  path.join(__dirname, '..', 'data', 'legal-raw', '법령자료')));
const DEST = path.resolve(opt('--dest', path.join(__dirname, '..', 'data', 'legal-md', '법령자료')));
const ONLY = opt('--only', '');
const DRY = flag('--dry'), FORCE = flag('--force');

function extractDate(fn) {
  let m = fn.match(/\((\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = fn.match(/(\d{4})[.\-_](\d{2})[.\-_]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else if (EXTS.has(path.extname(e).toLowerCase())) out.push({ abs: p, rel: path.relative(base, p) });
  }
  return out;
}
async function callParse(url, absPath, timeout) {
  const form = new FormData();
  form.append('file', fs.createReadStream(absPath), path.basename(absPath));
  const r = await axios.post(url, form, { headers: form.getHeaders(), timeout, maxContentLength: 1e9, maxBodyLength: 1e9 });
  const d = r.data;
  return (d && (d.result?.markdown || d.markdown)) || (typeof d === 'string' ? d : '') || '';
}

(async () => {
  if (!fs.existsSync(SRC)) { console.error('SRC 없음:', SRC); process.exit(1); }
  let files = walk(SRC, SRC, []);
  if (ONLY) files = files.filter(f => f.rel.split(path.sep).includes(ONLY) || f.rel.includes(ONLY));
  console.log(`[CONFIG] kordoc=${KORDOC_URL}  ocr=${OCR_URL}`);
  console.log(`[SRC] ${SRC}\n[DEST] ${DEST}\n대상 원본: ${files.length}건${DRY ? ' (DRY)' : ''}${FORCE ? ' (FORCE)' : ''}`);
  const stat = { conv: 0, skip: 0, fail: 0 };
  for (const f of files) {
    const relMd = f.rel.replace(/\.[^.]+$/, '.md');
    const dest = path.join(DEST, relMd);
    if (!FORCE && fs.existsSync(dest)) { stat.skip++; continue; }
    const cat = f.rel.split(path.sep)[0] || '';
    const base = path.basename(f.abs);
    if (DRY) { console.log(`  [DRY] ${f.rel} → ${relMd}`); stat.conv++; continue; }
    let md = '', parser = 'kordoc';
    try { md = await callParse(KORDOC_URL, f.abs, KORDOC_TIMEOUT); } catch (e) { console.log(`  kordoc 실패 ${base}: ${e.message}`); }
    if (!md || md.length < MIN_LEN) {
      try { md = await callParse(OCR_URL, f.abs, OCR_TIMEOUT); parser = 'paddleocr'; } catch (e) { console.log(`  OCR 실패 ${base}: ${e.message}`); }
    }
    if (md && md.length >= MIN_LEN) {
      const date = extractDate(base);
      const fm = ['---', 'source_type: reference', `title: ${base.replace(/\.[^.]+$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()}`,
        `category: ${cat}`, date ? `effective_date: ${date}` : '', `original_file: ${base}`,
        `parser_used: ${parser}`, `converted_at: ${new Date().toISOString().slice(0,10)}`, '---', ''].filter(Boolean).join('\n');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fm + md, 'utf8');
      console.log(`  ✅ ${f.rel} (${md.length}자, ${parser})`);
      stat.conv++;
    } else { console.log(`  ❌ 변환 실패: ${f.rel}`); stat.fail++; }
  }
  console.log(`\n완료 — 변환 ${stat.conv} · 스킵(기존 md) ${stat.skip} · 실패 ${stat.fail}`);
})();
