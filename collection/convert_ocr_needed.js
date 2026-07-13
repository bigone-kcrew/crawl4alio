#!/usr/bin/env node
/**
 * ALIO OCR 변환기 (순차 처리)
 *
 * conversion_checkpoint.json의 ocr_needed 항목을 PaddleOCR로 변환한다.
 * 원본 파일과 같은 폴더에 .md를 저장하고 체크포인트를 success로 업데이트한다.
 *
 * Usage:
 *   node collection/convert_ocr_needed.js
 *   node collection/convert_ocr_needed.js --dry-run
 *   PADDLEOCR_PARSE_URL=http://... node collection/convert_ocr_needed.js
 */

'use strict';

const fs     = require('fs');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');
const yaml   = require('js-yaml');

// ── SIGPIPE 무시 (nohup 환경에서 stdout 파이프 끊김 시 프로세스 유지) ─────────
process.on('SIGPIPE', () => {});

// ── 로그: stdout이 TTY면 파일에도 기록, nohup 리다이렉트 시엔 stdout만 사용 ──
const LOG_PATH = fromLogsRoot('ocr_conversion_run.log');
const _log = console.log.bind(console);
const IS_TTY = Boolean(process.stdout.isTTY);
console.log = (...args) => {
  const line = args.join(' ');
  // TTY 환경(직접 실행): 파일 + stdout 동시 기록
  // nohup 환경(리다이렉트): stdout만(nohup이 파일로 연결하므로 중복 방지)
  if (IS_TTY) {
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  }
  try { _log(line); } catch {}
};

// ── 경로 ───────────────────────────────────────────────────────────────────────
const ROOT            = path.join(__dirname, '..');
const STRUCTURED_DIR  = fromCatalogRoot('structured_data');
const INDEX_PATH      = path.join(STRUCTURED_DIR, 'download_files_index.json');
const MAIN_CKPT_PATH  = fromLogsRoot('conversion_checkpoint.json');
// 메인 변환과 충돌 방지: OCR 전용 별도 체크포인트 사용
// 듀얼 PC 병렬 시 인스턴스별 분리: OCR_CKPT_PATH / OCR_LOCK_PATH env로 override
const OCR_CKPT_PATH   = process.env.OCR_CKPT_PATH || fromLogsRoot('ocr_checkpoint.json');
const OCR_NEEDED_PATH = fromLogsRoot('ocr_needed.json');
// 출력 .md 경로: 원본 바이너리는 alio-raw, .md는 alio-md에 기록(2026-07-11 raw/md 분리 정합).
// 이 매핑이 없으면 .md가 alio-raw로 잘못 기록됨(2026-07-13 버그 수정).
function toMdOutput(absPath) {
  return absPath.replace('/alio-raw/', '/alio-md/').replace(/\.(pdf)$/i, '.md');
}
// 중복 실행 방지용 락파일
const LOCK_PATH       = process.env.OCR_LOCK_PATH || fromLogsRoot('ocr_convert.lock');

// ── 인스턴스 락 (중복 실행 방지) ──────────────────────────────────────────────
function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const existing = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = parseInt(existing, 10);
    if (pid && pid !== process.pid) {
      // 해당 PID가 실제로 살아있는지 확인
      try {
        process.kill(pid, 0); // 신호 0 = 프로세스 존재 확인만
        console.log(`[LOCK] 이미 실행 중 (PID ${pid}). 중복 실행 방지로 종료합니다.`);
        process.exit(0);
      } catch {
        // PID가 없으면 (이미 죽은 프로세스) 락 파일 덮어쓰기
        console.log(`[LOCK] 이전 락 파일(PID ${pid}) 정리 후 시작.`);
      }
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
// --refresh: ocr_needed.json을 메인 체크포인트에서 강제 재생성 (메인 변환 완료 후 재실행 시 사용)
const REFRESH = process.argv.includes('--refresh');
// 하이브리드 모드: kordoc 변환(convert_to_markdown)과 동시 구동 시 메인 ckpt 병합을 생략
// (실행 중인 변환기의 주기 저장이 병합을 되돌리므로, 변환 종료 후 마지막 1회만 병합)
const SKIP_MAIN_MERGE = process.argv.includes('--skip-main-merge');

// ── .env.parsers 로드 ──────────────────────────────────────────────────────────
function loadEnvFile() {
  const candidates = [
    path.join(ROOT, '.env.parsers'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const idx = t.indexOf('=');
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim().replace(/^"|"$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
    return p;
  }
  return '';
}

// ── timeout 계산 ───────────────────────────────────────────────────────────────
// 파일 크기 + 페이지 수 기반, 최대 90분
// TIMEOUT_MULTIPLIER 환경변수로 전체 배율 조정 가능
const TIMEOUT_MULTIPLIER = parseFloat(process.env.TIMEOUT_MULTIPLIER || '1');

// PDF 바이너리에서 페이지 수 추출 (/Count N 패턴)
// /Count가 파일 앞(body)·뒤(xref) 어디든 있을 수 있어 앞 32KB + 뒤 64KB 읽음
function getPdfPageCount(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const headSize = Math.min(32768, size);
    const tailSize = Math.min(65536, size);
    const head = Buffer.allocUnsafe(headSize);
    const tail = Buffer.allocUnsafe(tailSize);
    fs.readSync(fd, head, 0, headSize, 0);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    fs.closeSync(fd);
    const str = head.toString('latin1') + tail.toString('latin1');
    const matches = [...str.matchAll(/\/Count\s+(\d+)/g)];
    const counts = matches.map(m => parseInt(m[1])).filter(n => n > 0);
    return counts.length ? Math.max(...counts) : 0;
  } catch { return 0; }
}

function buildTimeout(bytes, filePath) {
  const mb = bytes / (1024 * 1024);
  const pages = filePath ? getPdfPageCount(filePath) : 0;
  // 크기 기반: 300s + 60s/MB
  const sizeBased = 300_000 + Math.ceil(mb * 60_000);
  // 페이지 기반: 페이지당 20초 (스캔 PDF OCR 처리 시간)
  const pageBased = pages > 0 ? pages * 20_000 : 0;
  // 최소 1800s: 34p 파일 실측 ~900s, 50p 청크 기준 여유 확보
  const base = Math.max(1_800_000, Math.min(Math.max(sizeBased, pageBased), 5_400_000));
  return Math.round(base * TIMEOUT_MULTIPLIER);
}

// 5MB 이상은 대형 파일로 분류 (후순위 처리)
const LARGE_FILE_THRESHOLD_BYTES = parseInt(process.env.LARGE_FILE_MB || '5') * 1024 * 1024;

// ── PaddleOCR 호출 ─────────────────────────────────────────────────────────────
// 서버 /tmp 경로의 한글/특수문자 파일명 오류 방지: ASCII 안전 이름으로 전송
function safeFileName(absPath) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(absPath).digest('hex').slice(0, 8);
  return `ocr_${hash}.pdf`;
}

async function callPaddleOcrBuffer(parseUrl, buffer, filename, timeoutMs) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await axios.post(parseUrl, form, {
      signal: controller.signal,
      timeout: 0,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res.data;
  } finally {
    clearTimeout(timer);
  }
}

// 50페이지 초과 PDF는 청크로 분할해서 처리 후 합침 (서버 max_pdf_pages=100 기준)
const CHUNK_MAX_PAGES = 50;

async function callPaddleOcr(parseUrl, absPath, timeoutMs) {
  const { PDFDocument } = require('pdf-lib');
  const buffer = fs.readFileSync(absPath);
  const filename = safeFileName(absPath);

  let pdfDoc;
  try { pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true }); } catch {
    return callPaddleOcrBuffer(parseUrl, buffer, filename, timeoutMs);
  }
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= CHUNK_MAX_PAGES) {
    return callPaddleOcrBuffer(parseUrl, buffer, filename, timeoutMs);
  }

  // 청크 분할 처리
  console.log(`  [청크분할] 총 ${totalPages}p → ${CHUNK_MAX_PAGES}p 단위 처리`);
  const parts = [];
  for (let start = 0; start < totalPages; start += CHUNK_MAX_PAGES) {
    const end = Math.min(start + CHUNK_MAX_PAGES, totalPages);
    const chunk = await PDFDocument.create();
    const pages = await chunk.copyPages(pdfDoc, Array.from({length: end - start}, (_, i) => start + i));
    pages.forEach(p => chunk.addPage(p));
    const chunkBuf = Buffer.from(await chunk.save());
    const chunkTimeout = Math.max(900_000, timeoutMs);  // 청크별 전체 타임아웃 유지
    console.log(`  [청크] ${start + 1}~${end}p 처리 중...`);
    const raw = await callPaddleOcrBuffer(parseUrl, chunkBuf, filename, chunkTimeout);
    // 서버는 JSON 객체({result:{markdown:...}}) 또는 문자열 반환 가능
    const result = typeof raw === 'string' ? raw
      : String(raw?.result?.markdown || raw?.markdown || '').trim();
    if (!result) {
      const errInfo = raw && typeof raw === 'object'
        ? (raw?.error?.message || raw?.message || JSON.stringify(raw).slice(0, 100))
        : 'OCR 결과 없음';
      throw new Error(`청크 ${start + 1}~${end}p: ${errInfo}`);
    }
    console.log(`  [청크] ${start + 1}~${end}p 완료 (${result.length}chars)`);
    // 페이지 번호 오프셋 조정: - N - 와 <!-- page: N --> 를 start 만큼 증가
    const adjusted = result
      .replace(/- (\d+) -/g, (_, n) => `- ${parseInt(n) + start} -`)
      .replace(/<!-- page: (\d+) -->/g, (_, n) => `<!-- page: ${parseInt(n) + start} -->`);
    parts.push(adjusted);
  }
  return parts.join('\n');
}

// ── YAML frontmatter 생성 ──────────────────────────────────────────────────────
function buildMarkdown(markdownContent, meta, parseUrl) {
  const fm = yaml.dump({
    institution:   meta.institution_name,
    ministry:      meta.ministry,
    apba_id:       meta.apba_id,
    scd:           String(meta.scd),
    item_name:     meta.item_name,
    category:      meta.minor_category,
    year:          String(meta.year),
    source_url:    meta.source_url || '',
    original_file: meta.original_file,
    ocr_service:   'paddleocr',
    ocr_endpoint:  parseUrl,
    converted_at:  new Date().toISOString(),
    source_ext:    'pdf',
  }, { lineWidth: -1 });

  const body = markdownContent.trim();
  return `---\n${fm}---\n\n${body}\n\n<!-- source: ${meta.original_file} -->\n<!-- ocr: paddleocr -->\n`;
}

// ── OCR 전용 체크포인트 저장 (원자적 쓰기로 중간 상태 방지) ───────────────────
function saveOcrCheckpoint(ckpt) {
  ckpt.last_updated = new Date().toISOString();
  const tmp = OCR_CKPT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 2));
  fs.renameSync(tmp, OCR_CKPT_PATH);
}

// ── 완료 후 메인 체크포인트에 OCR 결과 병합 ────────────────────────────────────
function mergeToMainCheckpoint(ocrCkpt) {
  if (!fs.existsSync(MAIN_CKPT_PATH)) return;
  let main;
  try { main = JSON.parse(fs.readFileSync(MAIN_CKPT_PATH, 'utf8')); }
  catch { console.log('메인 ckpt 파싱 실패 — 병합 건너뜀(다음 실행에서 재시도)'); return; }
  let merged = 0;
  for (const [id, v] of Object.entries(ocrCkpt.files)) {
    if (v.status === 'success') {
      main.files[id] = v;
      main.success = (main.success || 0) + 1;
      if (main.ocr_needed > 0) main.ocr_needed--;
      merged++;
    }
  }
  main.last_updated = new Date().toISOString();
  fs.writeFileSync(MAIN_CKPT_PATH, JSON.stringify(main, null, 2));
  console.log(`메인 체크포인트 병합 완료: ${merged}건`);
}

// ── 메인 ───────────────────────────────────────────────────────────────────────
async function main() {
  // --dry-run이 아닐 때만 락 획득 (dry-run은 중복 허용)
  if (!DRY_RUN) acquireLock();

  console.log('=== ALIO OCR 변환기 ===');
  if (DRY_RUN) console.log('[MODE] DRY RUN');

  // 환경변수 로드
  const envFile = loadEnvFile();
  if (envFile) console.log(`[ENV] ${envFile}`);

  const parseUrl = process.env.PADDLEOCR_PARSE_URL
    || (process.env.PADDLEOCR_BASE_URL ? process.env.PADDLEOCR_BASE_URL.replace(/\/$/, '') + '/parse' : '');
  if (!parseUrl) {
    throw new Error('PADDLEOCR_PARSE_URL 또는 PADDLEOCR_BASE_URL 환경변수가 필요합니다.');
  }
  console.log(`[OCR] ${parseUrl}`);

  // 인덱스 로드 (메타데이터 조회용)
  console.log('\n인덱스 로드 중...');
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const byId  = Object.fromEntries(index.files.map(f => [f.id, f]));

  // 소스: ocr_needed.json (메인 체크포인트와 독립)
  // --refresh 또는 파일 없으면 메인 체크포인트에서 재생성
  if (REFRESH || !fs.existsSync(OCR_NEEDED_PATH)) {
    let main;
  try { main = JSON.parse(fs.readFileSync(MAIN_CKPT_PATH, 'utf8')); }
  catch { console.log('메인 ckpt 파싱 실패 — 병합 건너뜀(다음 실행에서 재시도)'); return; }
    const list = Object.entries(main.files)
      .filter(([, v]) => v.status === 'ocr_needed' && v.file_path)
      .map(([id, v]) => ({ id, reason: v.reason, file_path: v.file_path }));
    fs.writeFileSync(OCR_NEEDED_PATH, JSON.stringify({ total: list.length, files: list }, null, 2));
    console.log(`ocr_needed.json ${REFRESH ? '갱신' : '생성'}: ${list.length}건`);
  }
  const ocrNeeded = JSON.parse(fs.readFileSync(OCR_NEEDED_PATH, 'utf8'));

  // OCR 전용 체크포인트 로드 (없으면 신규 생성)
  const ocrCkpt = fs.existsSync(OCR_CKPT_PATH)
    ? JSON.parse(fs.readFileSync(OCR_CKPT_PATH, 'utf8'))
    : { files: {}, success: 0, failed: 0 };

  // 미처리 항목만 추출 (OCR 체크포인트 기준)
  // canceled / socket hang up 실패는 리셋하여 재시도
  const RETRYABLE_ERRORS = ['canceled', 'socket hang up', 'ENETUNREACH', 'ETIMEDOUT', 'Failed to open file', 'OCR 결과 없음'];
  let resetCount = 0;
  for (const [id, v] of Object.entries(ocrCkpt.files)) {
    if (v.status === 'ocr_failed' && RETRYABLE_ERRORS.some(e => (v.error||'').includes(e))) {
      delete ocrCkpt.files[id];
      resetCount++;
    }
  }
  if (resetCount > 0) {
    console.log(`재시도 대상 리셋: ${resetCount}건 (canceled/socket hang up/ENETUNREACH/ETIMEDOUT/Failed to open file)`);
    saveOcrCheckpoint(ocrCkpt);
  }

  // 콘텐츠 DEDUP 해시맵: md5(pdf) → 완성된 .md 경로 (OCR 성공 시 추가)
  // 이전 배치에서 처리된 파일의 pdf_hash를 미리 로드해 배치 간 CDEDUP 지원
  const contentHashToMd = {};
  for (const v of Object.values(ocrCkpt.files)) {
    if (v.status === 'success' && v.pdf_hash && v.output && fs.existsSync(v.output)) {
      contentHashToMd[v.pdf_hash] = v.output;
    }
  }

  // pdf_hash 백필: 이전 배치에서 처리됐으나 pdf_hash 미저장 항목을 보완
  // ocr_needed.json의 file_path 매핑으로 소스 PDF를 찾아 해시 계산
  {
    const idToFilePath = {};
    for (const item of (ocrNeeded.files || [])) {
      idToFilePath[item.id] = item.file_path;
    }
    let backfillCount = 0;
    for (const [id, v] of Object.entries(ocrCkpt.files)) {
      if (v.status !== 'success' || v.pdf_hash) continue;
      const filePath = idToFilePath[id]
        || (v.output ? v.output.replace(/\.md$/, '.pdf') : null);
      if (!filePath || !fs.existsSync(filePath)) continue;
      try {
        const h = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
        v.pdf_hash = h;
        if (v.output && fs.existsSync(v.output)) contentHashToMd[h] = v.output;
        backfillCount++;
      } catch {}
    }
    if (backfillCount > 0) {
      console.log(`pdf_hash 백필: ${backfillCount}건`);
      saveOcrCheckpoint(ocrCkpt);
    }
  }

  if (Object.keys(contentHashToMd).length > 0)
    console.log(`이전 배치 해시 로드: ${Object.keys(contentHashToMd).length}건`);

  // 배치 분류: DEDUP(즉시) → OCR canonical(score 순) → CDEDUP pending(canonical 완료 후 즉시)
  // 해시를 미리 계산해 배치 내 중복 및 cross-batch 중복을 사전에 식별한다.
  console.log('배치 분류 중 (DEDUP / OCR canonical / CDEDUP pending)...');
  const dedupItemsPre  = [];  // .md 이미 존재 → 즉시 처리
  const ocrCanonicals  = [];  // 고유 해시 → OCR 필요, score 오름차순
  const cdedupPending  = [];  // 배치 내 중복 또는 이전 배치 canonical → 즉시 복사
  const batchHashSeen  = {};  // 배치 내 중복 탐지용

  for (const item of (ocrNeeded.files || []).filter(i => !ocrCkpt.files[i.id])) {
    let size = 0, pages = 0;
    try { size = fs.statSync(item.file_path).size; } catch {}
    pages = getPdfPageCount(item.file_path);
    const mb    = size / (1024 * 1024);
    const score = Math.max(mb * 60, pages > 0 ? pages * 20 : mb * 60);
    const base  = { id: item.id, file_path: item.file_path, reason: item.reason, size, pages, score };
    const outputPath = toMdOutput(item.file_path);

    if (fs.existsSync(outputPath)) {
      dedupItemsPre.push(base);
      continue;
    }

    let h;
    try { h = crypto.createHash('md5').update(fs.readFileSync(item.file_path)).digest('hex'); } catch {}

    // 배치 내 중복 또는 이전 배치에서 이미 처리된 hash → CDEDUP
    if (h && (batchHashSeen[h] || contentHashToMd[h])) {
      cdedupPending.push({ ...base, _hash: h });
    } else {
      if (h) batchHashSeen[h] = true;
      ocrCanonicals.push({ ...base, _hash: h });
    }
  }

  // 우선처리 파일: priority_ocr.json에 등록된 경로 → 맨 앞으로
  const PRIORITY_PATH = fromLogsRoot('priority_ocr.json');
  const prioritySet = new Set();
  if (fs.existsSync(PRIORITY_PATH)) {
    try { JSON.parse(fs.readFileSync(PRIORITY_PATH,'utf8')).paths.forEach(p => prioritySet.add(p)); } catch {}
  }
  // 듀얼 PC 정적 분할: 페이지 밴드로 인스턴스 담당 구간 제한(겹침 0). 예) PC1: 1~120p, PC2: 121p~
  const PAGE_MIN = parseInt(process.env.OCR_PAGE_MIN || '0', 10);
  const PAGE_MAX = parseInt(process.env.OCR_PAGE_MAX || '0', 10) || Infinity;
  const bandFilter = (i) => {
    const pg = i.pages > 0 ? i.pages : 1; // 페이지 불명이면 1p로 간주(소형 밴드)
    return pg >= PAGE_MIN && pg <= PAGE_MAX;
  };
  const priorityItems  = ocrCanonicals.filter(i => prioritySet.has(i.file_path) && bandFilter(i));
  const normalItems    = ocrCanonicals.filter(i => !prioritySet.has(i.file_path) && bandFilter(i));
  // OCR_ORDER=asc → 소형(고가치)부터, 기본 desc → 대형부터
  const asc = (process.env.OCR_ORDER || 'desc').toLowerCase() === 'asc';
  normalItems.sort((a, b) => asc ? a.score - b.score : b.score - a.score);
  if (PAGE_MIN || PAGE_MAX !== Infinity) console.log(`  페이지 밴드: ${PAGE_MIN}~${PAGE_MAX === Infinity ? '∞' : PAGE_MAX}p → ${normalItems.length + priorityItems.length}건`);
  console.log(`  정렬: ${asc ? '오름차순(소형 먼저)' : '내림차순(대형 먼저)'}`);
  if (priorityItems.length) console.log(`  우선처리 ${priorityItems.length}건 (priority_ocr.json)`);
  const ocrItems = [...dedupItemsPre, ...priorityItems, ...normalItems, ...cdedupPending];

  const p10 = ocrCanonicals[Math.floor(ocrCanonicals.length * 0.1)];
  const p50 = ocrCanonicals[Math.floor(ocrCanonicals.length * 0.5)];
  const p90 = ocrCanonicals[Math.floor(ocrCanonicals.length * 0.9)];
  console.log(`배치: DEDUP ${dedupItemsPre.length}건 + OCR ${ocrCanonicals.length}건 + CDEDUP ${cdedupPending.length}건 = ${ocrItems.length}건`);
  if (p10) console.log(`  OCR 하위 10%: ~${p10.score.toFixed(0)}초 (${p10.pages}p, ${(p10.size/1024/1024).toFixed(1)}MB)`);
  if (p50) console.log(`  OCR 중간 50%: ~${p50.score.toFixed(0)}초 (${p50.pages}p, ${(p50.size/1024/1024).toFixed(1)}MB)`);
  if (p90) console.log(`  OCR 상위 90%: ~${p90.score.toFixed(0)}초 (${p90.pages}p, ${(p90.size/1024/1024).toFixed(1)}MB)`);
  if (ocrItems.length === 0) {
    console.log('처리할 파일 없음.');
    return;
  }


  let success = 0, failed = 0, skipped = 0;
  const now = () => new Date().toISOString().slice(11, 19);

  for (let i = 0; i < ocrItems.length; i++) {
    const item   = ocrItems[i];
    const pct    = ((i + 1) / ocrItems.length * 100).toFixed(1);
    const absPath = item.file_path;
    const fname   = path.basename(absPath);
    const meta    = byId[item.id] || {};

    // 파일 존재 확인
    if (!fs.existsSync(absPath)) {
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] SKIP  파일없음  ${fname}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] DRY   ${fname}`);
      continue;
    }

    // 압축본 우선 사용: _압축.pdf > _압축_1.pdf > 원본
    const compCandidates = [
      absPath.replace(/\.pdf$/i, '_압축.pdf'),
      absPath.replace(/\.pdf$/i, '_압축_1.pdf'),
    ];
    const compPath = compCandidates.find(p => fs.existsSync(p)) || null;
    const ocrPath  = compPath || absPath;  // OCR에 실제 전송할 파일

    const sizeBytes = (() => { try { return fs.statSync(ocrPath).size; } catch { return 0; } })();
    const timeoutMs = buildTimeout(sizeBytes, ocrPath);
    const outputPath = toMdOutput(absPath);

    // 동일 경로 .md가 이미 존재하면 OCR 재호출 없이 체크포인트만 기록
    if (fs.existsSync(outputPath)) {
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] DEDUP  ${fname}`);
      ocrCkpt.files[item.id] = { status: 'success', output: outputPath, method: 'ocr', note: 'dedup' };
      ocrCkpt.success = (ocrCkpt.success || 0) + 1;
      success++;
      saveOcrCheckpoint(ocrCkpt);
      continue;
    }

    // 콘텐츠 DEDUP: 동일 바이트 파일의 .md가 다른 경로에 이미 존재하면 복사
    // _hash는 배치 분류 시 미리 계산된 값; 없으면 여기서 계산
    const fileHash = item._hash ||
      (() => { try { return crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex'); } catch { return null; } })();
    if (fileHash && contentHashToMd[fileHash] && fs.existsSync(contentHashToMd[fileHash])) {
      fs.copyFileSync(contentHashToMd[fileHash], outputPath);
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] CDEDUP ${fname}`);
      ocrCkpt.files[item.id] = { status: 'success', output: outputPath, method: 'ocr', note: 'content_dedup' };
      ocrCkpt.success = (ocrCkpt.success || 0) + 1;
      success++;
      saveOcrCheckpoint(ocrCkpt);
      continue;
    }

    if (compPath) console.log(`  [압축본 사용] ${path.basename(compPath)}`);

    const t0 = Date.now();
    let data;
    try {
      data = await callPaddleOcr(parseUrl, ocrPath, timeoutMs);
    } catch (err) {
      const errMsg = err.message || String(err);
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] FAIL  ${fname}  ${errMsg.slice(0, 60)}`);
      ocrCkpt.files[item.id] = { status: 'ocr_failed', error: errMsg, processed_at: new Date().toISOString() };
      ocrCkpt.failed = (ocrCkpt.failed || 0) + 1;
      failed++;
      saveOcrCheckpoint(ocrCkpt);
      continue;
    }

    const markdown = (typeof data === 'string'
      ? data
      : String(data?.result?.markdown || data?.markdown || '')).trim();
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

    if (!markdown) {
      const errMsg = data?.error?.message || data?.message || 'OCR 결과 없음';
      console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] FAIL  ${fname}  ${errMsg.slice(0, 60)}  (${elapsedS}s)`);
      ocrCkpt.files[item.id] = { status: 'ocr_failed', error: errMsg, processed_at: new Date().toISOString() };
      ocrCkpt.failed = (ocrCkpt.failed || 0) + 1;
      failed++;
      saveOcrCheckpoint(ocrCkpt);
      continue;
    }

    // 메타데이터 구성 (인덱스에 없으면 경로에서 추출)
    const fileMeta = {
      institution_name: meta.institution_name || '',
      ministry:         meta.ministry || '',
      apba_id:          meta.apba_id || '',
      scd:              meta.scd || '',
      item_name:        meta.item_name || '',
      minor_category:   meta.minor_category || '',
      year:             meta.year || '',
      source_url:       meta.source_url || '',
      original_file:    fname,
    };

    const content = buildMarkdown(markdown, fileMeta, parseUrl);
    fs.writeFileSync(outputPath, content, 'utf8');
    if (fileHash && !contentHashToMd[fileHash]) contentHashToMd[fileHash] = outputPath;

    ocrCkpt.files[item.id] = {
      status: 'success',
      parser: 'paddleocr',
      output: outputPath,
      ...(fileHash ? { pdf_hash: fileHash } : {}),
      processed_at: new Date().toISOString(),
    };
    ocrCkpt.success = (ocrCkpt.success || 0) + 1;
    success++;

    console.log(`[${now()}] [${i+1}/${ocrItems.length} ${pct}%] OK    ${fname}  ${markdown.length}자  (${elapsedS}s)`);
    saveOcrCheckpoint(ocrCkpt);
  }

  // 완료 후 메인 체크포인트에 OCR 성공 결과 병합 (메인 변환이 끝났을 때 안전하게 반영)
  if (SKIP_MAIN_MERGE) console.log('메인 ckpt 병합 생략(--skip-main-merge, 하이브리드)');
  else mergeToMainCheckpoint(ocrCkpt);

  // ocr_needed.json 갱신 (아직 실패/미처리 항목)
  const remaining = (ocrNeeded.files || []).filter(item => {
    const v = ocrCkpt.files[item.id];
    return !v || v.status !== 'success';
  });
  fs.writeFileSync(OCR_NEEDED_PATH, JSON.stringify({ total: remaining.length, files: remaining }, null, 2));

  console.log('\n=== 완료 ===');
  console.log(`성공: ${success}  실패: ${failed}  스킵: ${skipped}`);
  console.log(`잔여 미완료: ${remaining.length}건`);
  console.log(`OCR 체크포인트: ${OCR_CKPT_PATH}`);
}

main().catch(err => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
