#!/usr/bin/env node
/**
 * ALIO Markdown Converter
 *
 * download_files_index.json의 파일을 kordoc → markitdown 순으로 변환.
 * 변환 불가(스캔 PDF 등)는 ocr_needed로 분리하고 나머지를 계속 처리.
 *
 * Usage:
 *   node convert_to_markdown.js
 *   node convert_to_markdown.js --dry-run
 *   node convert_to_markdown.js --reset-checkpoint
 *   CONCURRENT=3 node convert_to_markdown.js
 *
 * Env:
 *   KORDOC_PARSE_URL      (default: http://localhost:3400/parse)
 *   MARKITDOWN_PARSE_URL  (default: http://localhost:3410/parse)
 *   CONCURRENT            일반 파일 동시 처리 수 (default: 5)
 *   CONCURRENT_LARGE      대형 파일 동시 처리 수 (default: 2)
 *   LARGE_FILE_MB         대형 파일 기준 MB (default: 10)
 *   CHECKPOINT_INTERVAL   체크포인트 저장 간격 파일 수 (default: 100)
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const yaml   = require('js-yaml');

// stdout 파이프 끊김 시 프로세스가 종료되지 않도록 SIGPIPE 무시
process.on('SIGPIPE', () => {});

// 경로는 카탈로그 루트 기준 (CATALOG_ROOT env로 데이터 폴더 전체 이동 가능)
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');

// TTY 환경: 파일 + stdout 동시 기록 / nohup 리다이렉트 환경: stdout만(nohup이 파일로 연결)
const LOG_PATH = fromLogsRoot('conversion_run.log');
const IS_TTY   = Boolean(process.stdout.isTTY);
const _origLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.join(' ');
  if (IS_TTY) {
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  }
  try { _origLog(line); } catch {}
};

// ── Config ─────────────────────────────────────────────────────────────────────

const parsers = require('./project/crawler/utils/parsers');
const CONCURRENT       = Math.min(parseInt(process.env.CONCURRENT       || '5'), 10);
const CONCURRENT_LARGE = Math.min(parseInt(process.env.CONCURRENT_LARGE || '2'), 5);
const LARGE_BYTES      = parseInt(process.env.LARGE_FILE_MB || '10') * 1024 * 1024;
const CKPT_INTERVAL    = parseInt(process.env.CHECKPOINT_INTERVAL || '100');
const REQUEST_TIMEOUT_MS        = parseInt(process.env.REQUEST_TIMEOUT_MS        || '30000');
// markitdown PDF 폴백용 별도 짧은 timeout (markitdown이 스캔 PDF에서 hang됨)
const MARKITDOWN_PDF_TIMEOUT_MS = parseInt(process.env.MARKITDOWN_PDF_TIMEOUT_MS || '15000');
// 변환 결과가 이 글자 수 이하면 "빈 결과"로 간주 (헤더만 있는 경우 등)
const MIN_CONTENT_CHARS = 20;
// PDF 품질 게이트: 페이지당 글자 수가 이 값 미만이면 스캔 문서로 보고 ocr_needed 분류
const PDF_MIN_CHARS_PER_PAGE = parseInt(process.env.PDF_MIN_CHARS_PER_PAGE || '100');

async function pdfPageCount(absPath) {
  const { PDFDocument } = require('pdf-lib');
  const buf = fs.readFileSync(absPath);
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

// ── Parser 라우팅 ───────────────────────────────────────────────────────────────
// kordoc 지원: hwp3/hwp/hwpx/hwpml, pdf, xls/xlsx, docx (npm 내장 or HTTP)
// markitdown은 MARKITDOWN_PARSE_URL 설정 시에만 폴백으로 사용 (pptx는 markitdown 전용)
const ROUTING = {
  hwp:   ['kordoc', 'markitdown'],
  hwpx:  ['kordoc', 'markitdown'],
  hwpml: ['kordoc', 'markitdown'],
  pdf:   ['kordoc', 'markitdown'],
  xlsx:  ['kordoc', 'markitdown'],
  docx:  ['kordoc', 'markitdown'],
  xls:   ['kordoc', 'markitdown'],
  pptx:  ['markitdown'],
};
const CONVERTIBLE = new Set(Object.keys(ROUTING));

// 스캔/이미지 PDF 오류 → OCR 필요로 분류 (markitdown 폴백 건너뜀)
const OCR_ERROR_PATTERNS = [
  'IMAGE_BASED_PDF',
  'Jbig2Error',
  'JBig2',
  '이미지 기반 PDF',   // kordoc 한국어 오류 메시지
];

// ── 경로 ───────────────────────────────────────────────────────────────────────

const ROOT             = path.join(__dirname, '..');
const STRUCTURED_DIR   = fromCatalogRoot('structured_data');
const INDEX_PATH       = path.join(STRUCTURED_DIR, 'download_files_index.json');
const CHECKPOINT_PATH  = fromLogsRoot('conversion_checkpoint.json');
const OCR_NEEDED_PATH  = fromLogsRoot('ocr_needed.json');
const HASH_CACHE_PATH  = fromLogsRoot('file_hash_cache.json');

// MD 미러 출력 루트 (raw/md 트리 분리 배포용).
// 미지정 시 기존 동작(원본 파일 옆에 .md 저장) 유지.
//   MD_MIRROR_ROOT=data/alio-md node collection/convert_to_markdown.js
//   node collection/convert_to_markdown.js --md-root data/alio-md
const mdRootArgIdx = process.argv.indexOf('--md-root');
const MD_MIRROR_ROOT = mdRootArgIdx >= 0 && process.argv[mdRootArgIdx + 1]
  ? path.resolve(process.argv[mdRootArgIdx + 1])
  : (process.env.MD_MIRROR_ROOT ? path.resolve(ROOT, process.env.MD_MIRROR_ROOT) : null);

// 원본 바이너리 소스 루트 (raw/md 분리 배포용).
// 미지정 시 STRUCTURED_DIR(=structured_data) 하위에서 읽던 기존 동작 유지.
//   node collection/convert_to_markdown.js --raw-root /workspace/alio/2_data/alio-raw/자료/기관별공시
const rawRootArgIdx = process.argv.indexOf('--raw-root');
const RAW_SOURCE_ROOT = rawRootArgIdx >= 0 && process.argv[rawRootArgIdx + 1]
  ? path.resolve(process.argv[rawRootArgIdx + 1])
  : (process.env.RAW_SOURCE_ROOT ? path.resolve(ROOT, process.env.RAW_SOURCE_ROOT) : STRUCTURED_DIR);

// ── 인스턴스 락 (중복 실행 방지) ──────────────────────────────────────────────

const LOCK_PATH = fromLogsRoot('convert_main.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const existing = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = parseInt(existing, 10);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.log(`[LOCK] 이미 실행 중 (PID ${pid}). 중복 실행 방지로 종료합니다.`);
        process.exit(0);
      } catch {
        console.log(`[LOCK] 이전 락 파일(PID ${pid}) 정리 후 시작.`);
      }
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const DRY_RUN   = process.argv.includes('--dry-run');
const RESET_CKP = process.argv.includes('--reset-checkpoint');

// ── Checkpoint ─────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (RESET_CKP || !fs.existsSync(CHECKPOINT_PATH)) {
    return { files: {}, success: 0, failed: 0, ocr_needed: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch {
    console.warn('[WARN] 체크포인트 손상, 처음부터 시작합니다.');
    return { files: {}, success: 0, failed: 0, ocr_needed: 0 };
  }
}

function saveCheckpoint(ckpt) {
  ckpt.last_updated = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(ckpt, null, 2));
}

// ── 파일 해시 캐시 (동일 파일 중복 파싱 방지) ──────────────────────────────────

const hashCache = new Map(); // md5 → outputPath

function loadHashCache() {
  if (RESET_CKP || !fs.existsSync(HASH_CACHE_PATH)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(HASH_CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(obj)) hashCache.set(k, v);
    console.log(`[HASH_CACHE] ${hashCache.size}개 기존 해시 로드`);
  } catch {}
}

function saveHashCache() {
  fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(Object.fromEntries(hashCache)));
}

// ── 동시 실행 풀 ────────────────────────────────────────────────────────────────

async function runPool(items, concurrency, handler) {
  const queue = [...items];
  let active = 0;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  const next = () => {
    while (active < concurrency && queue.length > 0) {
      active++;
      handler(queue.shift()).finally(() => {
        active--;
        if (active === 0 && queue.length === 0) resolveDone();
        else next();
      });
    }
    if (active === 0 && queue.length === 0) resolveDone();
  };

  next();
  return done;
}

// ── 파서 호출 ──────────────────────────────────────────────────────────────────

async function callParser(parserName, absPath, filename, timeoutMs) {
  const buf = fs.readFileSync(absPath);
  const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
  return parserName === 'kordoc'
    ? parsers.callKordoc(buf, filename, timeout)
    : parsers.callMarkitdown(buf, filename, timeout);
}

function isOcrError(errObj) {
  if (!errObj) return false;
  const msg = (errObj.code || '') + ' ' + (errObj.message || '');
  return OCR_ERROR_PATTERNS.some(p => msg.includes(p));
}

// ── YAML 프론트매터 생성 ────────────────────────────────────────────────────────

function buildFrontmatter(meta, parserUsed) {
  const data = {
    institution: meta.institution_name,
    ministry:    meta.ministry,
    apba_id:     meta.apba_id,
    scd:         String(meta.scd),
    item_name:   meta.item_name,
    category:    meta.minor_category,
    year:        String(meta.year),
    source_url:  meta.source_url || '',
    original_file: meta.original_file,
    converted_at: new Date().toISOString(),
    parser:      parserUsed,
  };
  return '---\n' + yaml.dump(data, { lineWidth: -1 }).trimEnd() + '\n---\n\n';
}

// ── 진행 로그 ──────────────────────────────────────────────────────────────────

let progTotal = 0;
let progDone  = 0;

function log(fileId, tag, detail) {
  progDone++;
  const pct = progTotal > 0 ? ((progDone / progTotal) * 100).toFixed(1) : '?';
  const ts  = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${progDone}/${progTotal} ${pct}%] ${tag.padEnd(10)} ${fileId}${detail ? '  ' + detail : ''}`);
}

// ── 파일 변환 ──────────────────────────────────────────────────────────────────

async function convertFile(entry, ckpt) {
  const { id, file_path, file_name, institution_name, ministry, apba_id,
          scd, item_name, year, source_url, minor_category } = entry;

  if (ckpt.files[id]) return;

  const ext     = file_name.split('.').pop().toLowerCase();
  const absPath = path.join(RAW_SOURCE_ROOT, file_path);           // 원본(raw 분리 시 alio-raw)
  // 변환 출력은 항상 md 트리(STRUCTURED_DIR) 기준 — raw 분리 시 .md가 raw에 떨어지는 것 방지
  const outputPath = (MD_MIRROR_ROOT
    ? path.join(MD_MIRROR_ROOT, file_path)
    : path.join(STRUCTURED_DIR, file_path)).replace(/\.[^.]+$/, '.md');
  const parsers = ROUTING[ext];
  const meta = { institution_name, ministry, apba_id, scd, item_name,
                 year, source_url, minor_category, original_file: file_name };

  if (DRY_RUN) {
    log(id, 'DRY', `${ext} → ${parsers.join(' → ')}`);
    ckpt.files[id] = { status: 'dry', processed_at: new Date().toISOString() };
    return;
  }

  // 원본 부재(무가치 정리로 삭제됐거나 미수집) → 실패 아닌 skip 집계.
  if (!fs.existsSync(absPath)) {
    ckpt.files[id] = { status: 'skipped_missing', processed_at: new Date().toISOString() };
    log(id, 'SKIP', 'source missing');
    return;
  }

  // ── 해시 캐시: 동일 파일 내용이면 파서 호출 없이 md 복사 ─────────────────────
  let fileHash;
  try {
    fileHash = crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex');
    const cachedMd = hashCache.get(fileHash);
    if (cachedMd && fs.existsSync(cachedMd)) {
      const existing = fs.readFileSync(cachedMd, 'utf8');
      const bodyMatch = existing.match(/^---[\s\S]*?---\n\n?([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1] : existing;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buildFrontmatter(meta, 'hash_reuse') + body, 'utf8');
      ckpt.files[id] = { status: 'success', parser: 'hash_reuse', output: outputPath,
                          source_hash: fileHash, processed_at: new Date().toISOString() };
      ckpt.success++;
      log(id, 'HASH_REUSE', fileHash.slice(0, 8));
      return;
    }
  } catch { /* 파일 없거나 해시 실패 → 일반 처리 */ }

  let usedParser = null;
  let markdown   = null;
  let lastError  = null;
  let needsOcr   = false;

  for (const parser of parsers) {
    // markitdown이 PDF 스캔 문서에서 hang되므로 짧은 timeout 적용
    const timeoutMs = (parser === 'markitdown' && ext === 'pdf')
      ? MARKITDOWN_PDF_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;

    let data;
    try {
      data = await callParser(parser, absPath, file_name, timeoutMs);
    } catch (err) {
      lastError = err.message;
      // PDF에서 markitdown 타임아웃 → 스캔 문서 가능성 높음
      if (ext === 'pdf' && parser === 'markitdown') {
        needsOcr = true;
        lastError = 'markitdown_timeout';
        break;
      }
      continue;
    }

    if (!data.ok) {
      // OCR 필요 판단 — kordoc 전용 에러 코드
      if (isOcrError(data.error)) {
        needsOcr = true;
        lastError = data.error?.code || 'IMAGE_BASED_PDF';
        break; // markitdown도 처리 못하므로 OCR로 분기
      }
      lastError = data.error?.message || data.error?.code || 'unknown';
      // kordoc HTTP 500 등 → markitdown 시도 계속
      continue;
    }

    const md = (data.result?.markdown || '').trim();
    if (md.length < MIN_CONTENT_CHARS) {
      // 텍스트 추출 성공이지만 내용이 사실상 없음 → 스캔 문서 의심
      needsOcr = true;
      lastError = 'empty_content';
      break;
    }

    // PDF 품질 게이트: 페이지당 글자 수 기준 저품질(스캔 문서) → OCR 대기
    if (ext === 'pdf') {
      try {
        const pages = await pdfPageCount(absPath);
        if (pages >= 1 && md.length / pages < PDF_MIN_CHARS_PER_PAGE) {
          needsOcr = true;
          lastError = `low_quality_${parser} (${md.length}자/${pages}p)`;
          break;
        }
      } catch { /* pdf-lib 부재·페이지 수 파악 실패 시 게이트 생략 */ }
    }

    markdown   = md;
    usedParser = parser;
    break;
  }

  // PDF에서 모든 파서 실패 → 스캔 문서 가능성 높으므로 ocr_needed로 분류
  if (!markdown && !needsOcr && ext === 'pdf') {
    needsOcr = true;
    lastError = lastError || 'all_parsers_failed';
  }

  const now = new Date().toISOString();

  if (markdown) {
    const frontmatter = buildFrontmatter(meta, usedParser);
    const footer = `\n\n<!-- source: ${file_name} -->\n<!-- converted_at: ${now} -->`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, frontmatter + markdown + footer, 'utf8');

    ckpt.files[id] = { status: 'success', parser: usedParser, output: outputPath, processed_at: now };
    ckpt.success++;
    log(id, `OK(${usedParser})`, '');
    if (fileHash) hashCache.set(fileHash, outputPath);
  } else if (needsOcr) {
    ckpt.files[id] = { status: 'ocr_needed', reason: lastError, file_path: absPath, processed_at: now };
    ckpt.ocr_needed = (ckpt.ocr_needed || 0) + 1;
    log(id, 'OCR_NEEDED', lastError);
  } else {
    ckpt.files[id] = { status: 'failed', error: lastError, processed_at: now };
    ckpt.failed++;
    log(id, 'FAIL', (lastError || '').slice(0, 80));
  }
}

// ── OCR 필요 목록 저장 ─────────────────────────────────────────────────────────

function saveOcrNeededList(ckpt) {
  const list = Object.entries(ckpt.files)
    .filter(([, v]) => v.status === 'ocr_needed')
    .map(([id, v]) => ({ id, reason: v.reason, file_path: v.file_path }));
  fs.writeFileSync(OCR_NEEDED_PATH, JSON.stringify({ total: list.length, files: list }, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  acquireLock();
  console.log('=== ALIO Markdown Converter ===');
  if (DRY_RUN) console.log('[MODE] DRY RUN');
  if (RESET_CKP) console.log('[MODE] RESET CHECKPOINT');
  console.log(`[CONFIG] kordoc:      ${parsers.kordocMode() === 'http' ? parsers.KORDOC_HTTP_URL : parsers.kordocMode() === 'local' ? '내장 npm (in-process)' : '사용 불가 — npm install 필요'}`);
  console.log(`[CONFIG] markitdown:  ${parsers.MARKITDOWN_HTTP_URL || '미설정 (폴백 건너뜀)'}`);
  console.log(`[CONFIG] concurrency: normal=${CONCURRENT}, large=${CONCURRENT_LARGE}`);
  console.log(`[CONFIG] large 기준:  ${LARGE_BYTES / 1024 / 1024}MB\n`);

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const allFiles = index.files.filter(f =>
    f.downloaded && CONVERTIBLE.has(f.file_name.split('.').pop().toLowerCase())
  );
  console.log(`변환 대상: ${allFiles.length}개`);

  const ckpt       = loadCheckpoint();
  loadHashCache();
  const pending    = allFiles.filter(f => !ckpt.files[f.id]);
  const alreadyDone = allFiles.length - pending.length;
  console.log(`기처리: ${alreadyDone} / 미처리: ${pending.length}\n`);

  if (pending.length === 0) { console.log('처리할 파일 없음.'); return; }

  // hwp/hwpx 우선 → xlsx/docx → pdf 순으로 정렬
  const EXT_PRIORITY = { hwp:0, hwpx:0, hwpml:0, xlsx:1, xls:1, docx:1, pdf:2 };
  pending.sort((a, b) => {
    const ea = (a.file_name.split('.').pop()||'').toLowerCase();
    const eb = (b.file_name.split('.').pop()||'').toLowerCase();
    return (EXT_PRIORITY[ea]??9) - (EXT_PRIORITY[eb]??9);
  });

  const normal = [], large = [];
  for (const e of pending) {
    let size = 0;
    try { size = fs.statSync(path.join(STRUCTURED_DIR, e.file_path)).size; } catch {}
    (size >= LARGE_BYTES ? large : normal).push(e);
  }
  console.log(`큐: 일반 ${normal.length}개, 대형 ${large.length}개 (≥${LARGE_BYTES/1024/1024}MB)\n`);

  progTotal = pending.length;
  let sinceSave = 0;

  const wrap = e => convertFile(e, ckpt).finally(() => {
    if (++sinceSave >= CKPT_INTERVAL) { saveCheckpoint(ckpt); sinceSave = 0; }
  });

  await Promise.all([
    runPool(normal, CONCURRENT,       wrap),
    runPool(large,  CONCURRENT_LARGE, wrap),
  ]);

  saveCheckpoint(ckpt);
  saveHashCache();
  saveOcrNeededList(ckpt);

  const vals      = Object.values(ckpt.files);
  const success   = vals.filter(v => v.status === 'success').length;
  const failed    = vals.filter(v => v.status === 'failed').length;
  const ocrNeeded = vals.filter(v => v.status === 'ocr_needed').length;
  const hashReused = vals.filter(v => v.parser === 'hash_reuse').length;

  console.log('\n=== 완료 ===');
  console.log(`전체(누적):  ${vals.length}`);
  console.log(`성공:       ${success}`);
  console.log(`해시 재사용: ${hashReused}`);
  console.log(`실패:       ${failed}`);
  console.log(`OCR 필요:   ${ocrNeeded}  →  ${OCR_NEEDED_PATH}`);
  console.log(`체크포인트: ${CHECKPOINT_PATH}`);
}

main().catch(err => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
