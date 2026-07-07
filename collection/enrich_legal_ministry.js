'use strict';
/**
 * legal source_manifest.json에 소관부처(ministry)·담당과(depts)를 1회 보강.
 * - law.go.kr DRF API(OC=사용자 발급 ID)로 lsiSeq(법령)·admRulSeq(행정규칙) 소관부처 수집
 * - 그 외 지침류는 카테고리상 자명한 부처만 매핑
 * 재실행 안전: 이미 ministry 있는 항목은 건너뜀(--force로 재수집)
 */
const fs = require('fs');
const https = require('https');
const path = require('path');

const OC = process.env.LAW_OC || '';
const MANIFEST = process.env.LEGAL_MANIFEST_PATH || path.join(__dirname, '..', '2_data', 'legal-md', 'source_manifest.json');

if (!OC) {
  console.error('LAW_OC 환경변수가 필요합니다 (law.go.kr Open API 신청 시 발급받은 이용자 ID).');
  process.exit(1);
}
const force = process.argv.includes('--force');

const CAT_MINISTRY = { '고용부지침': '고용노동부', '기재부지침': '기획재정부' };

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 20000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', () => resolve('')).on('timeout', function(){ this.destroy(); resolve(''); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseDrf(json) {
  let d;
  try { d = JSON.parse(json); } catch { return null; }
  const law = d['법령'] || d['행정규칙'] || d;
  const b = law['기본정보'] || law;
  if (!b) return null;
  const dep = b['소관부처'];
  const ministry = dep && (dep.content || (Array.isArray(dep) ? (dep[0] && dep[0].content) : '')) || '';
  const depts = [];
  const lc = b['연락부서'];
  const units = lc && lc['부서단위'];
  if (units) {
    (Array.isArray(units) ? units : [units]).forEach(u => {
      const nm = (u['부서명'] || '').split(' - ')[0].trim();
      if (nm && depts.indexOf(nm) < 0) depts.push(nm);
    });
  }
  return { ministry, depts: depts.slice(0, 3) };
}

async function drf(target, mst) {
  const url = `https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=${target}&MST=${mst}&type=JSON`;
  const r = await get(url);
  if (!r || r.indexOf('실패') >= 0 && r.length < 300) return null;
  return parseDrf(r);
}

(async () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  fs.writeFileSync(MANIFEST + '.bak_' + Date.now(), JSON.stringify(m, null, 2));
  let drfOk = 0, catOk = 0, miss = 0;
  for (const s of m.sources) {
    if (!force && s.ministry) continue;
    const url = s.source_url || '';
    let res = null;
    const ls = url.match(/lsiSeq=(\d+)/);
    const ar = url.match(/admRulSeq=(\d+)/);
    if (ls) res = await drf('law', ls[1]);
    else if (ar) res = await drf('admrul', ar[1]);
    if (res && res.ministry) {
      s.ministry = res.ministry;
      s.depts = res.depts;
      s.ministry_source = 'law.go.kr';
      drfOk++;
      process.stdout.write(`  ✓ ${s.title} → ${res.ministry}${res.depts.length ? ' (' + res.depts.join('·') + ')' : ''}\n`);
      await sleep(350);
    } else if (CAT_MINISTRY[s.category] || CAT_MINISTRY[categoryKo(s)]) {
      s.ministry = CAT_MINISTRY[s.category] || CAT_MINISTRY[categoryKo(s)];
      s.depts = [];
      s.ministry_source = 'category';
      catOk++;
    } else {
      miss++;
    }
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`\n완료 — DRF ${drfOk}건 · 카테고리매핑 ${catOk}건 · 미상 ${miss}건 / 총 ${m.sources.length}`);
})();

// category 필드가 영문 코드일 수 있어 로컬 경로 기반 한글 카테고리 유추
function categoryKo(s) {
  const p = s.local_path || '';
  return p.split('/')[0] || '';
}
