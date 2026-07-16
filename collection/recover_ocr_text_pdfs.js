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
 * 대상: reason이 timeout/aborted/low_quality 이고, 텍스트연산(BT/Tj)이 있는 PDF, 미완료.
 *   - 하이브리드(텍스트+이미지) PDF도 포함한다. 실측상 회수분의 58%가 이미지 다수(img>2) 하이브리드로,
 *     "이미지 적은 것만" 좁게 거르면 절반 이상을 놓친다. 대신 추출 후 페이지당 품질 게이트로 걸러낸다.
 *   - empty_content는 폰트/ToUnicode 부재라 kordoc·OCR 모두 빈결과 → 제외.
 *
 * 품질 게이트: 하이브리드를 넓게 받으므로, kordoc이 부분추출한 진짜 스캔을 걸러내 OCR에 남긴다.
 *   페이지당 글자수가 임계 미만이면 부실로 보고 OCR 유지(품질 퇴행 방지). 다중페이지 100자/p·1페이지 70자.
 *
 * Usage:
 *   node collection/recover_ocr_text_pdfs.js [--dry-run] [--limit=N]
 * Env:
 *   KORDOC_PARSE_URL            kordoc HTTP API (미설정 시 npm 내장)
 *   RECOVER_TIMEOUT_MS          건당 타임아웃(기본 300000)
 *   RECOVER_REASON_RE           대상 사유 정규식(기본 'timeout|aborted|low_quality')
 *   RECOVER_MIN_CHARS_PER_PAGE  다중페이지 페이지당 최소 글자수(기본 100)
 *   RECOVER_MIN_CHARS_1P        1페이지 최소 글자수(기본 70)
 *   RECOVER_FLUSH_EVERY         체크포인트 저장 주기(건, 기본 20) — 매 건 통째 rewrite 대신 배치 저장
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');
const parsers = require('./project/crawler/utils/parsers');

const DRY = process.argv.includes('--dry-run');
// --reprocess: 이미 OCR로 처리된 텍스트PDF를 kordoc으로 재추출해 품질게이트 통과 시 OCR 출력을 교체.
//   동시 실행 race로 OCR이 먼저 잡은 텍스트PDF(=kordoc이 더 정확)를 사후 업그레이드하는 2차 패스.
//   ⚠️ 현재 회수 패스가 끝난 뒤(체크포인트 write 경합 없는 시점) 단독 실행할 것.
const REPROCESS = process.argv.includes('--reprocess');
const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
const TIMEOUT = parseInt(process.env.RECOVER_TIMEOUT_MS || '300000', 10);
const REASON_RE = new RegExp(process.env.RECOVER_REASON_RE || 'timeout|aborted|low_quality', 'i');
const MIN_CHARS = 20;  // 절대 최소 글자수(이하는 사실상 빈 결과)
const MIN_CHARS_PP = parseInt(process.env.RECOVER_MIN_CHARS_PER_PAGE || '100', 10);  // 다중페이지 페이지당 최소
const MIN_CHARS_1P = parseInt(process.env.RECOVER_MIN_CHARS_1P || '70', 10);          // 1페이지 최소
const FLUSH_EVERY = parseInt(process.env.RECOVER_FLUSH_EVERY || '20', 10);

const OCR_NEEDED_PATH = fromLogsRoot('ocr_needed.json');
const OCK_PATH = fromLogsRoot('ocr_checkpoint.json');
const CCK_PATH = fromLogsRoot('conversion_checkpoint.json');
// kordoc 우선 강제: 아직 kordoc이 판정 안 한 대상 id 목록. OCR 소비자(convert_ocr_needed)가
// 이 목록의 id를 큐에서 제외 → OCR이 kordoc 적격 문서를 먼저 잡는 race를 원천 차단.
// kordoc이 각 건 판정(성공/LOW/실패)하면 목록에서 빠져 OCR로 방출(성공분은 .md 존재로 어차피 스킵).
const PENDING_PATH = fromLogsRoot('kordoc_pending.json');
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
// 원본 alio-raw → 산출 alio-md, .pdf → .md (convert_ocr_needed.js와 동일 규약)
const toMd = p => p.replace('/alio-raw/', '/alio-md/').replace(/\.(pdf)$/i, '.md');

// 텍스트PDF 판별: 텍스트연산(BT/Tj) 존재 여부만 본다(하이브리드 포함). 스캔 여부는 추출 후 품질 게이트가 판정.
function isTextPdf(fp) {
  try {
    const s = fs.readFileSync(fp).toString('latin1');
    let t = (s.match(/\bBT\b/g) || []).length;
    if (t === 0) { for (const m of s.matchAll(/stream\r?\n(.*?)endstream/gs)) { try { if (/\b(Tj|TJ)\b/.test(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'))) t++; } catch {} if (t) break; } }
    return t > 0;
  } catch { return false; }
}

// 페이지 수(품질 게이트용). 1차: 원본 바이트에서 /Type /Page 카운트(빠름).
// ⚠️ 압축 오브젝트 스트림(/ObjStm) PDF는 페이지 마커가 압축돼 있어 regex가 못 세고 1로 오인 →
//    부실 추출(예: 45p 스캔본 1,278자)이 "1p"로 게이트를 통과해 OCR 대상에서 빠지는 버그.
//    regex가 1 이하이면서 압축 스트림이 있으면 pdf-lib로 정확히 재계산한다.
//    페이지 수를 끝내 확정 못 하면 0(불명)을 반환 → 호출부에서 회수 스킵(OCR 유지, 안전측).
async function pageCount(fp) {
  try {
    const buf = fs.readFileSync(fp);
    const s = buf.toString('latin1');
    const m = s.match(/\/Type\s*\/Page[^s]/g);
    let pg = m ? m.length : 0;
    if (pg <= 1 && /\/ObjStm/.test(s)) {
      try { pg = (await PDFDocument.load(buf, { updateMetadata: false })).getPageCount(); } catch { return 0; }
    }
    return pg;   // 0 = 불명
  } catch { return 0; }
}

(async () => {
  const need = rd(OCR_NEEDED_PATH);
  const arr = (need.files || need.items || []).filter(x => x && x.file_path);

  // 체크포인트 선행 로드(대상 선별에 method 필요). 건마다 rewrite 대신 메모리 누적 → 배치 저장.
  const ock = rd(OCK_PATH); ock.files = ock.files || ock;
  const cck = rd(CCK_PATH); cck.files = cck.files || cck;
  // 해당 문서를 OCR(paddleocr)로 처리 완료했는지 — reprocess 대상 판정용
  const doneByOcr = (id) => {
    const v = ock.files[id] || cck.files[id];
    if (!v || v.status !== 'success') return false;
    if (v.method === 'kordoc_recovery') return false;   // 이미 kordoc이면 재처리 불필요
    return v.parser === 'paddleocr' || v.method === 'ocr' || (!v.method && !v.parser) || v.method === undefined;
  };

  const targets = [];
  for (const it of arr) {
    if (!REASON_RE.test(it.reason || '')) continue;
    if (!fs.existsSync(it.file_path)) continue;
    if (!isTextPdf(it.file_path)) continue;
    if (REPROCESS) {
      // OCR로 이미 처리된 것만(kordoc이 더 정확할 후보). .md 존재해도 교체 목적이라 스킵 안 함.
      if (!doneByOcr(it.id)) continue;
    } else {
      // 일반 회수: 아직 .md 없는 것만
      const md = toMd(it.file_path);
      try { if (fs.existsSync(md) && fs.statSync(md).size > 0) continue; } catch {}
    }
    targets.push(it);
  }
  const list = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  const modeLabel = REPROCESS ? '재처리(OCR→kordoc 교체)' : '회수';
  console.log(`[${modeLabel}] 대상 ${targets.length}건 (처리 ${list.length}) · kordoc=${parsers.KORDOC_HTTP_URL || 'npm내장'} · timeout ${TIMEOUT}ms${DRY ? ' · DRY-RUN' : ''}`);

  let ok = 0, empty = 0, fail = 0;
  const now = () => new Date().toISOString().slice(11, 19);
  let dirty = 0;
  const flush = () => {
    if (dirty === 0) return;
    for (const [P, obj] of [[OCK_PATH, ock], [CCK_PATH, cck]]) {
      try { fs.writeFileSync(P + '.t', JSON.stringify(obj, null, 2)); fs.renameSync(P + '.t', P); }
      catch (e) { console.log(`  ⚠️ ${path.basename(P)}: ${e.message}`); }
    }
    dirty = 0;
  };
  // pending = list[fromIdx..] (아직 판정 전). 인덱스 기반이라 crash 시에도 진행중 문서는 계속 제외됨(안전).
  // reprocess/DRY 모드는 OCR 큐에서 뺄 필요가 없으므로 미기록.
  const writePending = (fromIdx) => {
    if (DRY || REPROCESS) return;
    try {
      const ids = list.slice(fromIdx).map(x => x.id);
      fs.writeFileSync(PENDING_PATH + '.t', JSON.stringify({ updated: new Date().toISOString(), ids }));
      fs.renameSync(PENDING_PATH + '.t', PENDING_PATH);
    } catch (e) { console.log(`  ⚠️ pending: ${e.message}`); }
  };
  let curIdx = 0;
  if (!DRY) {
    const onSig = (code) => { flush(); writePending(curIdx); process.exit(code); };
    process.on('SIGINT', () => onSig(130)); process.on('SIGTERM', () => onSig(143));
  }
  writePending(0);   // 시작: 전체 대상이 pending(OCR 제외)

  for (let i = 0; i < list.length; i++) {
    curIdx = i;
    if (i % 20 === 0) writePending(i);   // 20건마다 판정된 앞부분을 OCR로 방출
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
    // 품질 게이트: 페이지당 글자수가 임계 미만이면 부분추출된 스캔으로 보고 OCR에 남긴다.
    const pg = await pageCount(it.file_path);
    if (pg === 0) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] LOW   ${name}  ${md.length}자/?p 페이지수불명 (${secs}s) — OCR 유지`); empty++; continue; }
    const gate = pg === 1 ? MIN_CHARS_1P : MIN_CHARS_PP;
    if (md.length < MIN_CHARS || md.length / pg < gate) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] LOW   ${name}  ${md.length}자/${pg}p (${secs}s) — OCR 유지`); empty++; continue; }
    const outPath = toMd(it.file_path);
    const oldChars = (() => { try { return fs.existsSync(outPath) ? fs.statSync(outPath).size : 0; } catch { return 0; } })();
    if (DRY) { console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] ${REPROCESS ? 'REPL' : 'DRY '}  ${name}  ${REPROCESS ? oldChars + '→' : ''}${md.length}자 (${secs}s)`); ok++; continue; }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md);   // reprocess 시 기존 OCR .md를 kordoc 출력으로 덮어씀
    const note = REPROCESS ? 'kordoc_reprocess' : 'kordoc_recovery';
    const wasSuccess = ock.files[it.id] && ock.files[it.id].status === 'success';
    ock.files[it.id] = { status: 'success', output: outPath, method: 'kordoc_recovery', note, processed_at: new Date().toISOString() };
    if (!wasSuccess) ock.success = (ock.success || 0) + 1;   // 이미 success면 중복 카운트 방지
    if (cck.files[it.id]) { cck.files[it.id].status = 'success'; cck.files[it.id].method = 'kordoc_recovery'; }
    dirty++;
    if (dirty >= FLUSH_EVERY) flush();
    console.log(`[${now()}] [${i+1}/${list.length} ${pct}%] ${REPROCESS ? 'REPL' : 'OK  '}  ${name}  ${REPROCESS ? oldChars + '→' : ''}${md.length}자 (${secs}s)`);
    ok++;
  }
  flush();
  writePending(list.length);   // 완료: pending 비움 → 판정 끝난 전건 OCR로 방출(LOW/실패분)
  console.log(`\n[${modeLabel} 완료] OK ${ok} · EMPTY ${empty}(OCR유지) · FAIL ${fail}`);
})();
