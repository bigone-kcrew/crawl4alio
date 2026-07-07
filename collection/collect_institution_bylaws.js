#!/usr/bin/env node
/**
 * ALIO 21110 내부규정 게시판 수집 스크립트
 *
 * 대상: 355개 공공기관의 21110(내부규정) 게시판
 * 수집: bid_type별 최신 규정 1건 (idate 기준)
 * 저장: institution-bylaws/raw/[기관코드]/ (원본)
 *       institution-bylaws/md/[기관코드]/  (MD 변환본)
 *
 * 실행:
 *   node collection/collect_institution_bylaws.js              # 전체 수집
 *   node collection/collect_institution_bylaws.js --dry-run    # 목록 확인만
 *   node collection/collect_institution_bylaws.js --apba-id C0847  # 단일 기관
 *   node collection/collect_institution_bylaws.js --survey     # 전체 규정 현황 분석
 *   node collection/collect_institution_bylaws.js --all-files  # 게시글의 모든 첨부(과거 버전 포함) 수집
 *                                                              # (기본: 마지막 첨부 = 최신본 1건만)
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ── 설정 ──────────────────────────────────────────────────────────────────────
const ALIO_BASE       = 'https://www.alio.go.kr';
const KORDOC_URL      = process.env.KORDOC_PARSE_URL     || 'http://localhost:3400/parse';
const MARKITDOWN_URL  = process.env.MARKITDOWN_PARSE_URL || 'http://localhost:3410/parse';

const DATA_DIR   = path.join(__dirname, '..', 'data');
const RAW_DIR    = path.join(DATA_DIR, 'institution-bylaws-raw');
const MD_DIR     = path.join(DATA_DIR, 'institution-bylaws-md');
const CKPT_PATH  = path.join(DATA_DIR, 'institution-bylaws/collect_checkpoint.json');
const INST_JSON  = path.join(DATA_DIR, 'institutions.json');

const CONCURRENCY   = 2;
const REQUEST_DELAY = 400; // ms, 기관 처리 간 딜레이
const DRY_RUN       = process.argv.includes('--dry-run');
const SURVEY_MODE   = process.argv.includes('--survey');
const ALL_FILES     = process.argv.includes('--all-files'); // 첨부 전체(과거 버전 포함) 수집
const SINGLE_APBA   = process.argv.includes('--apba-id')
  ? process.argv[process.argv.indexOf('--apba-id') + 1] : null;

// 변환 라우팅
const ROUTING = {
  hwp:  ['kordoc', 'markitdown'],
  hwpx: ['kordoc', 'markitdown'],
  hwpml:['kordoc', 'markitdown'],
  pdf:  ['kordoc', 'markitdown'],
  docx: ['kordoc', 'markitdown'],
  xlsx: ['kordoc', 'markitdown'],
  xls:  ['markitdown'],
  pptx: ['markitdown'],
};

const http = axios.create({
  baseURL: ALIO_BASE,
  timeout: 30000,
  headers: { Referer: ALIO_BASE + '/' },
});

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeName(str) {
  return str.replace(/[/\\?%*:|"<>\n\r\t]/g, '_').trim().slice(0, 80);
}

function loadCheckpoint() {
  if (fs.existsSync(CKPT_PATH)) return JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
  return { done: {}, skip: {}, error: {} };
}

function saveCheckpoint(ckpt) {
  fs.writeFileSync(CKPT_PATH, JSON.stringify(ckpt, null, 2), 'utf8');
}

// ── 규정 목록 가져오기 ────────────────────────────────────────────────────────
// 페이지 파라미터: pageIndex가 아닌 pageNo 사용 (Vue 앱 소스 확인)
async function fetchRuleList(apbaId) {
  const all = [];
  let page = 1;

  while (true) {
    const res = await http.post('/item/itemReportListSusi.json', {
      apbaId, reportFormRootNo: '21110', reportFormNo: '21110',
      pageNo: page, pageUnit: 10,
    });
    const data = res.data;
    if (data.status !== 'success') break;
    const result = data.data?.result || [];
    all.push(...result);
    const pi = data.data?.page || {};
    if (page >= (pi.totalPage || 1)) break;
    page++;
    await sleep(200);
  }

  // idx 기준 중복 제거 (같은 규정이 여러 페이지에 나타나는 경우 대비)
  const seen = new Set();
  return all.filter(r => {
    if (seen.has(r.idx)) return false;
    seen.add(r.idx);
    return true;
  });
}

// ── 상세 페이지에서 fileNo + 제목 + 제·개정일 추출 ──────────────────────────
async function fetchDetailInfo(apbaId, idx, bidType) {
  const res = await http.get('/item/itemBoard21110.do', {
    params: {
      apbaId, nowcode: '21110', reportFormNo: '21110',
      table_name: 'COMM_RULE', idx_name: 'RULE_NO',
      idx, reportGbn: 'N', bid_type: bidType,
    },
    responseType: 'text',
  });
  const html = res.data;

  // 게시글 내 첨부 전체 (순서대로; 마지막 = 최신 버전)
  const fileMatches = [...html.matchAll(/rulefiledown\.json\?fileNo=(\d+)/g)];
  const fileNos = [...new Set(fileMatches.map(m => m[1]))];
  const fileNo = fileNos.length ? fileNos[fileNos.length - 1] : null;

  // 게시글 제목 (규정명)
  const titleM = html.match(/<span>\s*제목\s*<\/span>[\s\S]*?<p>([^<]+)<\/p>/);
  const pageTitle = titleM ? titleM[1].trim() : null;

  // 제·개정일 → YYYYMMDD
  const dateM = html.match(/<span>\s*제[··]?개정일\s*<\/span>[\s\S]*?<p>([^<]+)<\/p>/);
  const idate = dateM ? dateM[1].trim().replace(/\./g, '') : null;

  return { fileNo, fileNos, pageTitle, idate };
}

// ── 파일 다운로드 ─────────────────────────────────────────────────────────────
async function downloadFile(fileNo, destBase) {
  const res = await http.get('/download/rulefiledown.json', {
    params: { fileNo },
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  const cd  = res.headers['content-disposition'] || '';
  const mExt = cd.match(/\.(hwp|hwpx|hwpml|pdf|docx|xlsx|xls|pptx|zip)/i);
  const ext  = mExt ? mExt[1].toLowerCase() : 'hwp';

  const destPath = destBase + '.' + ext;
  fs.writeFileSync(destPath, Buffer.from(res.data));
  return { ext, destPath };
}

// ── 파서 호출 ─────────────────────────────────────────────────────────────────
async function callParser(parserName, filePath, filename) {
  const url = parserName === 'kordoc' ? KORDOC_URL : MARKITDOWN_URL;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), filename);

  const res = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 120000,
  });
  return res.data;
}

async function convertToMd(rawPath, ext) {
  const parsers = ROUTING[ext] || ['markitdown'];
  const filename = path.basename(rawPath);

  for (const parser of parsers) {
    try {
      const result = await callParser(parser, rawPath, filename);
      const md = result.result?.markdown || result.markdown || '';
      if (result.ok && md) return { md, parser };
    } catch (e) {
      // 다음 파서 시도
    }
  }
  return null;
}

// ── 단일 규정 수집 ────────────────────────────────────────────────────────────
async function collectRule(inst, rule, ckpt) {
  const { apba_id: apbaId, name: instName, ministry } = inst;
  const { idx, bidType, title, idate } = rule;
  const key = `${apbaId}::${idx}::${bidType}`;

  if (ckpt.done[key] || ckpt.skip[key]) return;

  const tag = `[${apbaId}][${bidType}] ${title}`;

  try {
    const { fileNo, fileNos, pageTitle, idate: pageDate } = await fetchDetailInfo(apbaId, idx, bidType);
    if (!fileNo) {
      console.log(`  SKIP ${tag} — fileNo 없음`);
      ckpt.skip[key] = { reason: 'no_fileNo', title, at: new Date().toISOString() };
      return;
    }

    // 기본: 최신본(마지막 첨부) 1건 / --all-files: 게시글의 모든 첨부(과거 버전 포함)
    const targetFileNos = ALL_FILES ? fileNos : [fileNo];

    if (DRY_RUN) {
      console.log(`  DRY  ${tag} (idx=${idx}, files=${targetFileNos.length}/${fileNos.length}, title=${pageTitle})`);
      return;
    }

    const folderName = `[${ministry}]${instName}_${apbaId}`;
    const rawInstDir = path.join(RAW_DIR, folderName);
    fs.mkdirSync(rawInstDir, { recursive: true });

    const ruleTitle = pageTitle || title;
    const dateSuffix = pageDate || idate?.replace(/\./g, '') || '';
    const baseName = safeName(dateSuffix ? `${ruleTitle}_${dateSuffix}` : ruleTitle);

    // 최신본은 baseName 그대로, 과거 버전은 _v01(가장 오래됨)부터 suffix
    const downloaded = [];
    for (const no of targetFileNos) {
      const isLatest = no === fileNo;
      const versionSuffix = isLatest ? '' : `_v${String(fileNos.indexOf(no) + 1).padStart(2, '0')}`;
      const { ext, destPath } = await downloadFile(no, path.join(rawInstDir, baseName + versionSuffix));
      downloaded.push({ fileNo: no, ext, path: destPath, latest: isLatest });
      if (targetFileNos.length > 1) await sleep(200);
    }
    const latest = downloaded.find(d => d.latest) || downloaded[downloaded.length - 1];
    console.log(`  DOWN ${tag} — ${latest.ext} (fileNo=${fileNo}${downloaded.length > 1 ? `, 전체 ${downloaded.length}건` : ''})`);

    ckpt.done[key] = {
      title, idx, bidType, fileNo, ext: latest.ext, baseName, folderName,
      instName, ministry, apbaId, idate,
      rawPath: latest.path,
      files: downloaded.length > 1 ? downloaded : undefined,
      md: false, at: new Date().toISOString(),
    };

  } catch (e) {
    console.error(`  ERR  ${tag} — ${e.message}`);
    ckpt.error[key] = { title, idx, bidType, error: e.message, at: new Date().toISOString() };
  }
}

// ── 단일 기관 수집 ────────────────────────────────────────────────────────────
async function collectInstitution(inst, ckpt) {
  const { apba_id: apbaId, name } = inst;

  let rules;
  try {
    rules = await fetchRuleList(apbaId);
  } catch (e) {
    console.error(`[${apbaId}] ${name} — 목록 조회 실패: ${e.message}`);
    return;
  }

  if (!rules.length) return;

  console.log(`[${apbaId}] ${name} — 현행 규정 ${rules.length}건`);

  for (const rule of rules) {
    await collectRule(inst, rule, ckpt);
    await sleep(300);
  }
}

// ── 서베이 모드: 전체 기관 규정 현황 파악 ────────────────────────────────────
async function surveMode(institutions) {
  const results = [];
  let i = 0;
  for (const inst of institutions) {
    i++;
    process.stdout.write(`\r조회 중 ${i}/${institutions.length} (${inst.apba_id} ${inst.name})`);
    try {
      const rules = await fetchRuleList(inst.apba_id);
      if (rules.length) {
        results.push({ apba_id: inst.apba_id, name: inst.name, ministry: inst.ministry, total: rules.length, selected: rules.length, bid_types: [...new Set(rules.map(r=>r.bidType))], titles: rules.map(r=>r.title) });
      }
    } catch(e) {}
    await sleep(150);
  }
  console.log('\n');

  const totalInst = results.length;
  const totalRules = results.reduce((s, r) => s + r.selected, 0);
  console.log(`규정 보유 기관: ${totalInst}개 / ${institutions.length}개`);
  console.log(`수집 대상 파일: ${totalRules}건 (기관별 현행 규정 전체)`);

  const surveyPath = path.join(DATA_DIR, 'institution-bylaws/survey.json');
  fs.mkdirSync(path.dirname(surveyPath), { recursive: true });
  fs.writeFileSync(surveyPath, JSON.stringify({ generated_at: new Date().toISOString(), total_institutions: totalInst, total_rules: totalRules, institutions: results }, null, 2), 'utf8');
  console.log(`\n저장: ${surveyPath}`);

  // 상위 bid_type 통계
  const bidTypeStat = {};
  for (const r of results) for (const bt of r.bid_types) bidTypeStat[bt] = (bidTypeStat[bt] || 0) + 1;
  console.log('\nbid_type별 기관 수:');
  for (const [k, v] of Object.entries(bidTypeStat).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k}: ${v}기관`);
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  const institutions = JSON.parse(fs.readFileSync(INST_JSON, 'utf8'));
  const targets = SINGLE_APBA
    ? institutions.filter(i => i.apba_id === SINGLE_APBA)
    : institutions;

  if (SURVEY_MODE) {
    await surveMode(targets);
    return;
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(MD_DIR,  { recursive: true });

  console.log(`대상 기관: ${targets.length}개${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const ckpt = loadCheckpoint();

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(inst => collectInstitution(inst, ckpt)));
    saveCheckpoint(ckpt);
    await sleep(REQUEST_DELAY);
  }

  const done  = Object.values(ckpt.done).filter(v => !v.dry).length;
  const skip  = Object.keys(ckpt.skip).length;
  const error = Object.keys(ckpt.error).length;
  console.log(`\n=== 완료 === 다운로드: ${done}건 | 스킵: ${skip}건 | 오류: ${error}건`);
  saveCheckpoint(ckpt);
}

main().catch(e => { console.error(e); process.exit(1); });
