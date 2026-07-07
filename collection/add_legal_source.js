#!/usr/bin/env node
/**
 * 법령·행정규칙을 source_manifest.json에 추가하는 CLI
 *
 * law.go.kr 검색 API(lawSearch.do)로 법령명을 조회해 후보를 보여주고,
 * 선택한 항목을 manifest에 planned 상태로 추가한다.
 * 이후 collect_legal_corpus.js --id <id> 로 수집한다.
 *
 * Usage:
 *   node collection/add_legal_source.js --law "산업안전보건법" --category labor_laws
 *   node collection/add_legal_source.js --law "근로기준법" --pick 2      # 후보 중 2번 선택
 *   node collection/add_legal_source.js --admrul "공무직근로자 인사관리규정" --category moel_guidelines
 *   node collection/add_legal_source.js --url "https://www.law.go.kr/lsInfoP.do?lsiSeq=123456" --title "..." --category labor_laws
 *   옵션: --id <슬러그>  --local-path <경로>  --dry-run
 *
 * Env: OPENAPILAWKEY 또는 LAW_OC
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OC = (process.env.OPENAPILAWKEY || process.env.LAW_OC || '').trim();
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'legal-md', 'source_manifest.json');

// 카테고리 코드 → 저장 폴더 (기존 manifest의 local_path 관례)
const CATEGORY_DIRS = {
  labor_laws: '노동법령',
  public_institution_laws: '공공기관법령',
  moef_guidelines: '기재부지침',
  moel_guidelines: '고용부지침',
  labor_commission_reference: '노동위원회',
  civil_service_reference: '공무원규정',
  '표준·권장안': '표준·권장안'
};

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const LAW_QUERY = opt('--law', '');
const ADMRUL_QUERY = opt('--admrul', '');
const DIRECT_URL = opt('--url', '');
const TITLE = opt('--title', '');
const CATEGORY = opt('--category', 'labor_laws');
const PICK = parseInt(opt('--pick', '0'), 10);
const CUSTOM_ID = opt('--id', '');
const CUSTOM_PATH = opt('--local-path', '');
const DRY_RUN = flag('--dry-run');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function searchLaw(target, query) {
  const url = `https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=${target}&type=JSON&display=10&query=${encodeURIComponent(query)}`;
  const body = await get(url);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('검색 응답 파싱 실패: ' + body.slice(0, 200)); }
  const root = data.LawSearch || data.AdmRulSearch || data;
  let rows = root.law || root.admrul || [];
  if (!Array.isArray(rows)) rows = [rows];
  return rows.filter(Boolean);
}

function candidateInfo(row, target) {
  if (target === 'law') {
    return {
      seq: String(row['법령일련번호'] || ''),
      title: String(row['법령명한글'] || '').trim(),
      kind: String(row['법령구분명'] || ''),
      ministry: String(row['소관부처명'] || ''),
      effective_date: String(row['시행일자'] || ''),
      current: String(row['현행연혁코드'] || ''),
      url: `https://www.law.go.kr/lsInfoP.do?lsiSeq=${row['법령일련번호']}`
    };
  }
  return {
    seq: String(row['행정규칙일련번호'] || row['행정규칙ID'] || ''),
    title: String(row['행정규칙명'] || '').trim(),
    kind: String(row['행정규칙종류'] || ''),
    ministry: String(row['소관부처명'] || ''),
    effective_date: String(row['시행일자'] || ''),
    current: String(row['현행연혁구분'] || ''),
    url: `https://www.law.go.kr/admRulInfoP.do?admRulSeq=${row['행정규칙일련번호'] || row['행정규칙ID']}`
  };
}

function buildEntry(info, category) {
  const dir = CATEGORY_DIRS[category] || category;
  const eff = info.effective_date;
  const effLabel = eff ? `(${Number(eff.slice(0, 4))}.${Number(eff.slice(4, 6))}.${Number(eff.slice(6, 8))}. 시행)` : '';
  const safeTitle = info.title.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
  return {
    id: CUSTOM_ID || `${info.url.includes('admRulSeq') ? 'admrul' : 'law'}_${info.seq}`,
    title: info.title,
    category,
    authority: info.ministry || '',
    source_url: info.url,
    local_path: CUSTOM_PATH || `${dir}/${safeTitle}${effLabel}.md`,
    status: 'planned',
    effective_date: info.effective_date || '',
    ministry: info.ministry || ''
  };
}

async function main() {
  if (!OC && !DIRECT_URL) {
    console.error('OPENAPILAWKEY 또는 LAW_OC 환경변수가 필요합니다.');
    process.exit(1);
  }
  if (!LAW_QUERY && !ADMRUL_QUERY && !DIRECT_URL) {
    console.error('사용법: --law "법령명" | --admrul "행정규칙명" | --url <lsInfoP.do 주소> --title <제목>');
    process.exit(1);
  }
  if (!CATEGORY_DIRS[CATEGORY]) {
    console.error(`알 수 없는 카테고리: ${CATEGORY}\n사용 가능: ${Object.keys(CATEGORY_DIRS).join(', ')}`);
    process.exit(1);
  }

  let info;
  if (DIRECT_URL) {
    if (!TITLE) { console.error('--url 사용 시 --title이 필요합니다.'); process.exit(1); }
    const seq = (DIRECT_URL.match(/(?:lsiSeq|admRulSeq)=(\d+)/) || [])[1] || '';
    if (!seq) { console.error('URL에서 lsiSeq/admRulSeq를 찾을 수 없습니다.'); process.exit(1); }
    info = { seq, title: TITLE, url: DIRECT_URL, ministry: '', effective_date: '' };
  } else {
    const target = LAW_QUERY ? 'law' : 'admrul';
    const query = LAW_QUERY || ADMRUL_QUERY;
    const rows = await searchLaw(target, query);
    if (rows.length === 0) { console.error(`검색 결과 없음: ${query}`); process.exit(1); }

    const candidates = rows.map(r => candidateInfo(r, target));
    console.log(`검색 결과 ${candidates.length}건:`);
    candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.title} [${c.kind}] ${c.ministry} 시행 ${c.effective_date} (${c.current}) seq=${c.seq}`);
    });

    if (PICK > 0) {
      info = candidates[PICK - 1];
      if (!info) { console.error(`--pick ${PICK} 범위 밖`); process.exit(1); }
    } else {
      const exact = candidates.filter(c => c.title === query);
      if (exact.length === 1) info = exact[0];
      else {
        console.error(`\n정확 일치가 ${exact.length}건 — --pick N 으로 선택하세요.`);
        process.exit(1);
      }
    }
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const dup = manifest.sources.find(s =>
    (info.seq && String(s.source_url || '').includes(`=${info.seq}`)) ||
    (s.title === info.title && s.category === CATEGORY)
  );
  if (dup) {
    console.error(`이미 존재: ${dup.id} (${dup.title}, status=${dup.status})`);
    process.exit(1);
  }

  const entry = buildEntry(info, CATEGORY);
  console.log('\n추가할 항목:');
  console.log(JSON.stringify(entry, null, 2));

  if (DRY_RUN) { console.log('\n[DRY RUN] manifest 미변경'); return; }

  manifest.sources.push(entry);
  manifest.generated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest 추가 완료. 수집 실행:\n  node collection/collect_legal_corpus.js --id ${entry.id}`);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
