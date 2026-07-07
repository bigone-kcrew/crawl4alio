#!/usr/bin/env node
/**
 * 법령·지침 corpus 수집기
 *
 * law.go.kr 법령/행정규칙은 DRF JSON API로 직접 수집 (HTML 노이즈 없음).
 * 그 외 출처(moef, moel 등)는 crawl4ai → kordoc → PaddleOCR 파이프라인.
 *
 * Usage:
 *   source .env.api && node collect_legal_corpus.js
 *   node collect_legal_corpus.js --id civil_service_conduct_decree
 *   node collect_legal_corpus.js --category labor_laws
 *   node collect_legal_corpus.js --retry-failed
 *   node collect_legal_corpus.js --refetch-lawgov   # law.go.kr 전체 재수집
 *   node collect_legal_corpus.js --dry-run
 *
 * Env (.env.api에서 로드):
 *   CRAWL4AI_API_TOKEN   crawl4ai Bearer 토큰 (law.go.kr 외 필수)
 *   CRAWL4AI_HOST        (default: localhost:11235)
 *   KORDOC_URL           (default: http://localhost:3400/parse)
 *   PADDLEOCR_URL        (default: http://localhost:13430/parse)
 *   LEGAL_MD_ROOT        (default: data/legal-md)
 *   CONCURRENT           동시 수집 수 (default: 3)
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const yaml  = require('js-yaml');

// ── Config ────────────────────────────────────────────────────────────────────

const CRAWL4AI_HOST  = process.env.CRAWL4AI_HOST || 'localhost:11235';
const CRAWL4AI_TOKEN = (process.env.CRAWL4AI_API_TOKEN || '').trim();
const KORDOC_URL     = process.env.KORDOC_URL    || 'http://localhost:3400/parse';
const PADDLEOCR_URL  = process.env.PADDLEOCR_URL || 'http://localhost:13430/parse';
const DRF_OC         = (process.env.OPENAPILAWKEY || process.env.LAW_OC || '').trim();
const MIN_MD_CHARS   = 50;
const ROOT           = path.resolve(__dirname, '..', process.env.LEGAL_MD_ROOT  || 'data/legal-md');
const RAW_ROOT       = path.resolve(__dirname, '..', process.env.LEGAL_RAW_ROOT || 'data/legal-raw');
const MANIFEST_PATH  = path.join(ROOT, 'source_manifest.json');
const CONCURRENT     = Math.min(parseInt(process.env.CONCURRENT || '3'), 6);
const CRAWL_TIMEOUT  = 90000;
const KORDOC_TIMEOUT = 60000;
const DRF_TIMEOUT    = 30000;

const [C4AI_HOST, C4AI_PORT] = CRAWL4AI_HOST.split(':');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args            = process.argv.slice(2);
const DRY_RUN         = args.includes('--dry-run');
const ONLY_ID         = argVal('--id');
const ONLY_CAT        = argVal('--category');
const RETRY_FAILED    = args.includes('--retry-failed');
const REFETCH_LAWGOV  = args.includes('--refetch-lawgov');
const REFETCH_ALIO    = args.includes('--refetch-alio');

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ── Logging ───────────────────────────────────────────────────────────────────

let total = 0, done = 0;

function log(tag, msg) {
  const ts  = new Date().toISOString().slice(11, 19);
  const pct = total > 0 ? ` [${done}/${total}]` : '';
  console.log(`[${ts}]${pct} [${tag.padEnd(7)}] ${msg}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpRequest(opts, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = opts.protocol === 'https:' ? https : http;
    const req = mod.request({ ...opts, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP timeout (${timeoutMs}ms)`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function httpGet(url, timeoutMs = CRAWL_TIMEOUT) {
  const u   = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── ALIO 법령/지침 ────────────────────────────────────────────────────────────

function isAlioUrl(url) {
  return /alio\.go\.kr.*etcLawDtl\.do.*boardNo=(\d+)/.test(url);
}

function extractAlioBoardNo(url) {
  const m = url.match(/boardNo=(\d+)/);
  return m ? m[1] : null;
}

async function httpGetWithHeaders(url, headers, timeoutMs = 60000) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAlioFile(source, rawBasePath) {
  const boardNo = extractAlioBoardNo(source.source_url);
  const alioHeaders = {
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://alio.go.kr/etc/etcLawList.do',
  };

  // 상세 조회 → 첨부파일 목록
  const dtlRes = await httpGetWithHeaders(
    `https://alio.go.kr/etc/findEtcLawDtl.json?boardNo=${boardNo}`, alioHeaders, 30000
  );
  const dtlData = JSON.parse(dtlRes.body.toString('utf8'))?.data;
  if (!dtlData) throw new Error('ALIO 상세 조회 실패');
  const files = dtlData.fileList || [];
  if (!files.length) throw new Error('ALIO 첨부파일 없음');

  // HWP 우선, 없으면 PDF
  const file = files.find(f => /\.hwpx?$/i.test(f.fileNm)) ||
               files.find(f => /\.pdf$/i.test(f.fileNm)) ||
               files[0];
  const extMatch = file.fileNm.match(/\.(\w+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'hwp';

  // 원문 다운로드
  const dlRes = await httpGetWithHeaders(
    `https://alio.go.kr/download/download.json?fileNo=${file.fileNo}`,
    { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://alio.go.kr/etc/etcLawList.do' },
    60000
  );
  if (dlRes.status !== 200) throw new Error(`ALIO 다운로드 HTTP ${dlRes.status}`);

  // raw 저장
  const rawFile = `${rawBasePath}.${ext}`;
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  fs.writeFileSync(rawFile, dlRes.body);
  log('RAW', `${path.basename(rawFile)} (${dlRes.body.length}B)`);

  // 텍스트 변환
  const { md, parser } = await convertFile(dlRes.body, file.fileNm, ext);
  return {
    markdown: md,
    parserUsed: `alio-${parser}`,
    effectiveDate: '',
    amendedAt: '',
  };
}

// ── DRF JSON — 법령 ──────────────────────────────────────────────────────────

function isDrfLawUrl(url) {
  return /law\.go\.kr.*lsInfoP\.do.*lsiSeq=(\d+)/.test(url);
}
function isDrfAdmRulUrl(url) {
  return /law\.go\.kr.*admRulInfoP\.do.*admRulSeq=(\d+)/.test(url);
}

function extractLsiSeq(url) {
  const m = url.match(/lsiSeq=(\d+)/);
  return m ? m[1] : null;
}
function extractAdmRulSeq(url) {
  const m = url.match(/admRulSeq=(\d+)/);
  return m ? m[1] : null;
}

async function fetchDrfJson(drfUrl) {
  const res = await httpGet(drfUrl, DRF_TIMEOUT);
  if (res.status !== 200) throw new Error(`DRF HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

// 법령 JSON → Markdown 변환
function lawJsonToMarkdown(data) {
  const law = data['법령'];
  const bi  = law['기본정보'] || {};

  const effDate  = String(bi['시행일자'] || '');
  const promDate = String(bi['공포일자'] || '');
  const promNo   = String(bi['공포번호'] || '');
  const dept     = typeof bi['소관부처'] === 'object'
    ? (bi['소관부처']['소관부처명'] || '')
    : String(bi['소관부처'] || '');

  let md = '';
  if (effDate)  md += `**시행일자**: ${effDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}\n`;
  if (promDate) md += `**공포일자**: ${promDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}`;
  if (promNo)   md += `  (제${promNo}호)`;
  if (promDate || promNo) md += '\n';
  if (dept)     md += `**소관부처**: ${dept}\n`;
  md += '\n';

  // 조문
  const jm = law['조문'];
  if (jm && jm['조문단위']) {
    let units = jm['조문단위'];
    if (!Array.isArray(units)) units = [units];

    for (const u of units) {
      const content = String(u['조문내용'] || '').trim();
      const hasTitle = !!u['조문제목'];

      if (!hasTitle) {
        // 장·절 헤더
        if (content) md += `\n## ${content}\n\n`;
        continue;
      }

      // 조문 본문 (항이 없는 단순 조문)
      if (!u['항']) {
        md += content + '\n\n';
        continue;
      }

      // 조문 제목행 (항 앞에)
      if (content) md += content + '\n';

      // 항
      let hangs = u['항'];
      if (!Array.isArray(hangs)) hangs = [hangs];

      for (const h of hangs) {
        const hContent = String(h['항내용'] || '').trim();
        if (hContent) md += hContent + '\n';

        // 호
        if (h['호']) {
          let hos = h['호'];
          if (!Array.isArray(hos)) hos = [hos];
          for (const ho of hos) {
            const hoContent = String(ho['호내용'] || '').trim();
            if (hoContent) md += hoContent + '\n';

            // 목
            if (ho['목']) {
              let moks = ho['목'];
              if (!Array.isArray(moks)) moks = [moks];
              for (const mok of moks) {
                const mokContent = String(mok['목내용'] || '').trim();
                if (mokContent) md += mokContent + '\n';
              }
            }
          }
        }
      }
      md += '\n';
    }
  }

  // 부칙
  const buch = law['부칙'];
  if (buch && buch['부칙단위']) {
    let arr = buch['부칙단위'];
    if (!Array.isArray(arr)) arr = [arr];
    const buchLines = arr
      .map(b => String(b['부칙내용'] || '').trim())
      .filter(Boolean);
    if (buchLines.length) {
      md += '\n## 부칙\n\n' + buchLines.join('\n\n') + '\n';
    }
  }

  return md.trim();
}

// 행정규칙 JSON → Markdown 변환
function admRulJsonToMarkdown(data) {
  const ar = data['AdmRulService'] || {};
  const bi = ar['행정규칙기본정보'] || {};

  const effDate = String(bi['시행일자'] || '');
  const dept    = String(bi['소관부처명'] || '');
  const kind    = String(bi['행정규칙종류'] || '');

  let md = '';
  if (effDate) md += `**시행일자**: ${effDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}\n`;
  if (dept)    md += `**소관부처**: ${dept}\n`;
  if (kind)    md += `**종류**: ${kind}\n`;
  md += '\n';

  // 조문내용 (list of strings)
  const jm = ar['조문내용'];
  if (Array.isArray(jm)) {
    for (const item of jm) {
      const s = String(item).trim();
      if (!s) continue;
      if (/^제\d+장|^제\d+절/.test(s)) {
        md += `\n## ${s}\n\n`;
      } else {
        md += s + '\n\n';
      }
    }
  }

  // 부칙
  const buch = ar['부칙'];
  if (buch && buch['부칙단위']) {
    let arr = buch['부칙단위'];
    if (!Array.isArray(arr)) arr = [arr];
    const lines = arr.map(b => String(b['부칙내용'] || '').trim()).filter(Boolean);
    if (lines.length) md += '\n## 부칙\n\n' + lines.join('\n\n') + '\n';
  }

  return md.trim();
}

async function fetchLawGovDRF(source) {
  const url = source.source_url;

  if (isDrfLawUrl(url)) {
    const lsiSeq = extractLsiSeq(url);
    const drfUrl = `https://www.law.go.kr/DRF/lawService.do?OC=${DRF_OC}&target=law&MST=${lsiSeq}&type=JSON`;
    const data   = await fetchDrfJson(drfUrl);
    if (!data['법령']) throw new Error('DRF 응답에 법령 키 없음');
    const bi = data['법령']['기본정보'] || {};
    return {
      markdown:     lawJsonToMarkdown(data),
      parserUsed:   'drf-law-json',
      effectiveDate: String(bi['시행일자'] || ''),
      amendedAt:    String(bi['공포일자'] || ''),
    };
  }

  if (isDrfAdmRulUrl(url)) {
    const admRulSeq = extractAdmRulSeq(url);
    const drfUrl    = `https://www.law.go.kr/DRF/lawService.do?OC=${DRF_OC}&target=admrul&ID=${admRulSeq}&type=JSON`;
    const data      = await fetchDrfJson(drfUrl);
    if (!data['AdmRulService']) throw new Error('DRF 응답에 AdmRulService 키 없음');
    const bi = data['AdmRulService']['행정규칙기본정보'] || {};
    return {
      markdown:     admRulJsonToMarkdown(data),
      parserUsed:   'drf-admrul-json',
      effectiveDate: String(bi['시행일자'] || ''),
      amendedAt:    String(bi['발령일자'] || ''),
    };
  }

  throw new Error('law.go.kr URL 패턴 불일치');
}

// ── Crawl4AI ─────────────────────────────────────────────────────────────────

async function crawlUrl(url) {
  if (!CRAWL4AI_TOKEN) throw new Error('CRAWL4AI_API_TOKEN 미설정');
  const bodyStr = JSON.stringify({
    urls: [url],
    crawler_params: { headless: true },
    extra: { only_main_content: false },
  });
  const res = await httpRequest({
    hostname: C4AI_HOST,
    port:     parseInt(C4AI_PORT || '11235'),
    path:     '/crawl',
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Authorization':  `Bearer ${CRAWL4AI_TOKEN}`,
    },
  }, bodyStr, CRAWL_TIMEOUT);

  if (res.status === 500) {
    const err = JSON.parse(res.body.toString());
    throw new Error(`crawl4ai 500: ${err.error || JSON.stringify(err)}`);
  }
  const data = JSON.parse(res.body.toString());
  if (!data.success) throw new Error(`crawl4ai 실패: ${JSON.stringify(data).slice(0, 200)}`);
  if (data.task_id) return await pollCrawl4AI(data.task_id);
  return (data.results || [])[0] || data;
}

async function pollCrawl4AI(taskId, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(3000);
    const res = await httpRequest({
      hostname: C4AI_HOST,
      port:     parseInt(C4AI_PORT || '11235'),
      path:     `/task/${taskId}`,
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${CRAWL4AI_TOKEN}` },
    }, null, 15000);
    const data = JSON.parse(res.body.toString());
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed')    throw new Error(`task failed: ${data.error}`);
  }
  throw new Error(`task ${taskId} timed out`);
}

function extractMarkdown(result) {
  if (!result) return '';
  return result?.markdown_v2?.raw_markdown ||
         result?.markdown?.raw_markdown    ||
         (typeof result?.markdown === 'string' ? result.markdown : '') ||
         result?.content || '';
}

// ── multipart/form-data ───────────────────────────────────────────────────────

async function postMultipart(url, fileBuf, filename, timeoutMs) {
  const boundary = `Boundary${Date.now()}`;
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([head, fileBuf, tail]);
  const u    = new URL(url);
  const res  = await httpRequest({
    hostname: u.hostname,
    port:     parseInt(u.port || (u.protocol === 'https:' ? '443' : '80')),
    path:     u.pathname,
    method:   'POST',
    headers:  {
      'Content-Type':   `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body, timeoutMs);
  return JSON.parse(res.body.toString());
}

// ── kordoc / PaddleOCR ────────────────────────────────────────────────────────

async function convertWithKordoc(fileBuf, filename) {
  const data = await postMultipart(KORDOC_URL, fileBuf, filename, KORDOC_TIMEOUT);
  if (!data.ok) throw new Error(`kordoc 오류: ${JSON.stringify(data.error)}`);
  return data.result?.markdown || data.result?.text || data.markdown || '';
}

async function convertWithPaddleOcr(fileBuf, filename) {
  const safeFilename = filename.replace(/[^\w.-]/g, '_');
  const data = await postMultipart(PADDLEOCR_URL, fileBuf, safeFilename, 300000);
  if (!data.ok && data.ok !== undefined) throw new Error(`paddleocr 오류: ${JSON.stringify(data.error || data)}`);
  return data.result?.markdown || data.result?.text || data.markdown || data.text || '';
}

async function convertFile(fileBuf, filename, ext) {
  if (['pdf', 'hwp', 'hwpx', 'docx', 'xlsx'].includes(ext)) {
    try {
      const md = await convertWithKordoc(fileBuf, filename);
      if (md.length >= MIN_MD_CHARS) return { md, parser: 'kordoc' };
      if (ext === 'pdf') {
        log('OCR', `${filename}: kordoc 빈결과, PaddleOCR 시도`);
        const ocrMd = await convertWithPaddleOcr(fileBuf, filename);
        return { md: ocrMd, parser: 'paddleocr' };
      }
    } catch (e) {
      if (ext === 'pdf') {
        log('OCR', `${filename}: kordoc 실패(${e.message}), PaddleOCR 시도`);
        const ocrMd = await convertWithPaddleOcr(fileBuf, filename);
        return { md: ocrMd, parser: 'paddleocr' };
      }
      throw e;
    }
  }
  throw new Error(`지원하지 않는 확장자: ${ext}`);
}

// ── 첨부 파일 링크 추출 ───────────────────────────────────────────────────────

function extractFileLinks(markdown) {
  const links = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)]+\.(pdf|hwp|hwpx|docx|xlsx))(\?[^)]*)?\)/gi;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const url = m[2] + (m[4] || '');
    links.push({ label: m[1] || path.basename(url), url, ext: m[3].toLowerCase() });
  }
  return links;
}

// ── Frontmatter 생성 ──────────────────────────────────────────────────────────

function buildFrontmatter(source, parserUsed, extra = {}) {
  const obj = {
    source_type:     source.category.includes('law') ? 'law' : 'guideline',
    title:           source.title,
    source_url:      source.source_url,
    authority:       source.authority,
    collected_at:    new Date().toISOString().slice(0, 10),
    effective_date:  extra.effectiveDate || source.effective_date || '',
    amended_at:      extra.amendedAt    || source.amended_at     || '',
    source_priority: 'official',
    parser_used:     parserUsed,
    usage_note:      '공공기관 교섭 쟁점 검토 기준',
  };
  return '---\n' + yaml.dump(obj, { lineWidth: -1 }).trimEnd() + '\n---\n\n';
}

// ── 수집 처리 ─────────────────────────────────────────────────────────────────

async function processSource(source) {
  const outPath    = path.join(ROOT, source.local_path);
  const rawBasePath = path.join(RAW_ROOT, path.dirname(source.local_path), source.id);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const isLawGov = isDrfLawUrl(source.source_url) || isDrfAdmRulUrl(source.source_url);
  const isAlio   = isAlioUrl(source.source_url);

  // 재수집 조건 판단
  const forceRefetch = (REFETCH_LAWGOV && isLawGov) || (REFETCH_ALIO && isAlio);
  if (source.status === 'collected' && fs.existsSync(outPath) && !RETRY_FAILED && !forceRefetch) {
    log('SKIP', `${source.id} 이미 수집됨`);
    return;
  }

  const tag = isAlio ? 'ALIO' : (isLawGov ? 'DRF' : 'CRAWL');
  log(tag, source.id);
  if (DRY_RUN) { log('DRY', `${source.id} 스킵`); return; }

  let markdown = '';
  let parserUsed = '';
  let extra = {};

  // ── ALIO 경로 ────────────────────────────────────────────────────────────
  if (isAlio) {
    try {
      const result = await fetchAlioFile(source, rawBasePath);
      markdown   = result.markdown;
      parserUsed = result.parserUsed;
      extra      = result;
      if (markdown.length < MIN_MD_CHARS)
        throw new Error(`ALIO 마크다운 너무 짧음 (${markdown.length}자)`);
      log('OK', `${source.id} ALIO 완료 (${markdown.length}자)`);
    } catch (err) {
      log('ERR', `${source.id} ALIO 실패: ${err.message}`);
      updateManifest(source.id, 'failed', err.message);
      return;
    }
  }

  // ── law.go.kr DRF JSON 경로 ──────────────────────────────────────────────
  else if (isLawGov) {
    try {
      const result = await fetchLawGovDRF(source);
      markdown   = result.markdown;
      parserUsed = result.parserUsed;
      extra      = result;
      if (markdown.length < MIN_MD_CHARS)
        throw new Error(`DRF 마크다운 너무 짧음 (${markdown.length}자)`);
      log('OK', `${source.id} DRF 완료 (${markdown.length}자)`);
    } catch (err) {
      log('ERR', `${source.id} DRF 실패: ${err.message}`);
      updateManifest(source.id, 'failed', err.message);
      return;
    }
  }

  // ── crawl4ai 경로 ────────────────────────────────────────────────────────
  else {
    try {
      const result = await crawlUrl(source.source_url);
      markdown     = extractMarkdown(result);
      parserUsed   = 'crawl4ai';
      if (typeof markdown !== 'string') markdown = String(markdown || '');
      if (markdown.length < MIN_MD_CHARS)
        throw new Error(`마크다운 너무 짧음 (${markdown.length}자)`);
      log('OK', `${source.id} 크롤 완료 (${markdown.length}자)`);
    } catch (err) {
      log('ERR', `${source.id} 크롤 실패: ${err.message}`);
      updateManifest(source.id, 'failed', err.message);
      return;
    }

    // 첨부 파일 변환 + raw 저장
    const fileLinks = extractFileLinks(markdown);
    if (fileLinks.length > 0) {
      log('FILE', `${source.id}: 첨부 ${fileLinks.length}건 변환 시도`);
      const parts = [];
      for (const link of fileLinks) {
        try {
          const dl = await httpGet(link.url);
          if (dl.status !== 200) throw new Error(`HTTP ${dl.status}`);
          // raw 원문 저장
          const rawFile = `${rawBasePath}.${link.ext}`;
          fs.mkdirSync(path.dirname(rawFile), { recursive: true });
          fs.writeFileSync(rawFile, dl.body);
          log('RAW', `${path.basename(rawFile)} (${dl.body.length}B)`);
          const { md: converted, parser } = await convertFile(dl.body, `attachment.${link.ext}`, link.ext);
          if (converted.length >= MIN_MD_CHARS) {
            parts.push(`\n\n---\n\n## 첨부: ${link.label}\n\n${converted}`);
            parserUsed = `crawl4ai+${parser}`;
            log(parser.toUpperCase().slice(0, 7), `${link.label} (${converted.length}자)`);
          }
        } catch (e) {
          log('FERR', `${link.label}: ${e.message}`);
        }
      }
      markdown += parts.join('');
    }
  }

  const content = buildFrontmatter(source, parserUsed, extra) + `# ${source.title}\n\n` + markdown;
  fs.writeFileSync(outPath, content, 'utf8');
  log('SAVE', `${outPath.replace(ROOT + '/', '')} (${content.length}자)`);
  updateManifest(source.id, 'collected', '', parserUsed, extra);
}

// ── Manifest 갱신 ─────────────────────────────────────────────────────────────

function updateManifest(id, status, failureReason = '', parserUsed = '', extra = {}) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const src = manifest.sources.find(s => s.id === id);
  if (!src) return;
  src.status     = status;
  src.checked_at = new Date().toISOString().slice(0, 10);
  if (failureReason)       src.failure_reason = failureReason;
  if (parserUsed)          src.parser_used    = parserUsed;
  if (extra.effectiveDate) src.effective_date = extra.effectiveDate;
  if (extra.amendedAt)     src.amended_at     = extra.amendedAt;
  manifest.generated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// ── 병렬 실행기 ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pLimit(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]().catch(err => log('PANIC', err.message));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`source_manifest.json 없음: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // --refetch-lawgov: law.go.kr 항목을 planned로 초기화
  if (REFETCH_LAWGOV) {
    let reset = 0;
    for (const src of manifest.sources) {
      if (isDrfLawUrl(src.source_url) || isDrfAdmRulUrl(src.source_url)) {
        src.status = 'planned';
        reset++;
      }
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    log('RESET', `law.go.kr 항목 ${reset}건 재수집 대상으로 초기화`);
  }

  // --refetch-alio: ALIO 항목을 planned로 초기화
  if (REFETCH_ALIO) {
    let reset = 0;
    for (const src of manifest.sources) {
      if (isAlioUrl(src.source_url)) {
        src.status = 'planned';
        reset++;
      }
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    log('RESET', `ALIO 항목 ${reset}건 재수집 대상으로 초기화`);
  }

  // crawl4ai 토큰 필요 여부 체크 (law.go.kr/ALIO 전용 모드라면 불필요)
  const needToken = !REFETCH_LAWGOV && !REFETCH_ALIO && !ONLY_ID;
  if (!CRAWL4AI_TOKEN && !DRY_RUN && needToken) {
    const allDirect = manifest.sources
      .filter(s => s.status === 'planned' || (RETRY_FAILED && s.status === 'failed'))
      .every(s => isDrfLawUrl(s.source_url) || isDrfAdmRulUrl(s.source_url) || isAlioUrl(s.source_url));
    if (!allDirect) {
      console.error([
        'CRAWL4AI_API_TOKEN 환경변수가 필요합니다.',
        '실행 방법:',
        '  source .env.api && node collection/collect_legal_corpus.js',
      ].join('\n'));
      process.exit(1);
    }
  }

  const fresh = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  let sources = fresh.sources.filter(s =>
    s.status === 'planned' || (RETRY_FAILED && s.status === 'failed')
  );
  if (ONLY_ID)  sources = sources.filter(s => s.id === ONLY_ID);
  if (ONLY_CAT) sources = sources.filter(s => s.category === ONLY_CAT);

  total = sources.length;
  const alioCount   = sources.filter(s => isAlioUrl(s.source_url)).length;
  const lawGovCount = sources.filter(s => isDrfLawUrl(s.source_url) || isDrfAdmRulUrl(s.source_url)).length;
  const crawlCount  = total - alioCount - lawGovCount;
  log('START', `수집 대상 ${total}건 | ALIO ${alioCount}건 | DRF ${lawGovCount}건 | crawl4ai ${crawlCount}건 | 동시 ${CONCURRENT}`);
  if (DRY_RUN) log('DRY', '--- dry-run 모드: 파일 저장 없음 ---');

  const tasks = sources.map(src => () => { done++; return processSource(src); });
  await pLimit(tasks, CONCURRENT);

  const updated = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const c = updated.sources.filter(s => s.status === 'collected').length;
  const f = updated.sources.filter(s => s.status === 'failed').length;
  const p = updated.sources.filter(s => s.status === 'planned').length;
  log('DONE', `수집완료 ${c} / 실패 ${f} / 미수집 ${p}`);
}

main().catch(err => { console.error(err); process.exit(1); });
