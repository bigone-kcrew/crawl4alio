#!/usr/bin/env node
/**
 * 법령 corpus 개정 감지 — 저장본 vs law.go.kr 최신본 대조
 *
 * source_manifest.json의 law.go.kr 소스(lsiSeq/admRulSeq)별로 lawSearch.do를
 * 법령명으로 조회해 최신 일련번호·시행일자를 얻고, 저장된 값과 다르면 개정으로 판정.
 *
 *   report (기본): data/logs/legal_revision_report_<날짜>.json 생성 (반자동 —
 *                  사람이 검토 후 --apply 실행)
 *   --apply      : 개정 항목의 source_url을 새 일련번호로 교체하고 status=planned로
 *                  리셋 (+prev_lsiSeq 기록) → collect_legal_corpus.js 재실행 시 재수집
 *
 * Usage:
 *   node collection/sync_legal.js                 # 전체 대조 리포트
 *   node collection/sync_legal.js --limit 5       # 앞 5건만 (테스트)
 *   node collection/sync_legal.js --id labor_standards_act
 *   node collection/sync_legal.js --apply         # 감지된 개정을 manifest에 반영
 *
 * Env: OPENAPILAWKEY 또는 LAW_OC
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OC = (process.env.OPENAPILAWKEY || process.env.LAW_OC || '').trim();
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'legal-md', 'source_manifest.json');
const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt((args[args.indexOf('--limit') + 1] || '0'), 10) || 0;
const ONLY_ID = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// 가운뎃점(·ㆍ•)·공백 차이를 무시하고 법령명 비교
function normalizeTitle(value) {
  return String(value || '').replace(/[·ㆍ•]/g, '·').replace(/\s+/g, '').trim();
}

async function searchLatest(target, title) {
  const url = `https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=${target}&type=JSON&display=10&query=${encodeURIComponent(title)}`;
  const body = await get(url);
  const data = JSON.parse(body);
  const root = data.LawSearch || data.AdmRulSearch || data;
  let rows = root.law || root.admrul || [];
  if (!Array.isArray(rows)) rows = [rows];

  // 법령명 정확 일치(가운뎃점·공백 정규화) + 현행만
  const nameKey = target === 'law' ? '법령명한글' : '행정규칙명';
  const seqKey = target === 'law' ? '법령일련번호' : '행정규칙일련번호';
  const wanted = normalizeTitle(title);
  const exact = rows.filter(r => normalizeTitle(r?.[nameKey]) === wanted);
  const current = exact.find(r => /현행/.test(String(r?.['현행연혁코드'] || r?.['현행연혁구분'] || ''))) || exact[0];
  if (!current) return null;
  return {
    seq: String(current[seqKey] || ''),
    effective_date: String(current['시행일자'] || '')
  };
}

async function main() {
  if (!OC) { console.error('OPENAPILAWKEY 또는 LAW_OC 환경변수가 필요합니다.'); process.exit(1); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  let targets = manifest.sources.filter(s => /(?:lsiSeq|admRulSeq)=\d+/.test(String(s.source_url || '')));
  if (ONLY_ID) targets = targets.filter(s => s.id === ONLY_ID);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  console.log(`대조 대상: ${targets.length}건 (law.go.kr 소스)`);

  const revisions = [];
  const errors = [];
  let unchanged = 0;

  for (const source of targets) {
    const isLaw = /lsiSeq=/.test(source.source_url);
    const oldSeq = (source.source_url.match(/(?:lsiSeq|admRulSeq)=(\d+)/) || [])[1] || '';
    try {
      const latest = await searchLatest(isLaw ? 'law' : 'admrul', source.title);
      if (!latest || !latest.seq) {
        errors.push({ id: source.id, title: source.title, error: '검색 결과에서 정확 일치 없음' });
      } else if (latest.seq !== oldSeq && (!source.effective_date || latest.effective_date > String(source.effective_date))) {
        revisions.push({
          id: source.id,
          title: source.title,
          old_seq: oldSeq,
          new_seq: latest.seq,
          old_effective_date: String(source.effective_date || ''),
          new_effective_date: latest.effective_date
        });
        console.log(`  ⚠ 개정: ${source.title} (${source.effective_date || '?'} → ${latest.effective_date})`);
      } else {
        unchanged++;
      }
    } catch (err) {
      errors.push({ id: source.id, title: source.title, error: err.message });
    }
    await sleep(1000);
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const reportPath = path.join(LOGS_DIR, `legal_revision_report_${dateTag}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    checked: targets.length,
    unchanged,
    revisions,
    errors
  }, null, 2));
  console.log(`\n리포트: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`대조 ${targets.length} — 최신 ${unchanged} / 개정 ${revisions.length} / 오류 ${errors.length}`);

  if (revisions.length === 0) return;

  if (!APPLY) {
    console.log('\n[REPORT] 개정 반영·재수집하려면:');
    console.log('  node collection/sync_legal.js --apply');
    console.log('  node collection/collect_legal_corpus.js   # planned 항목 재수집');
    return;
  }

  for (const rev of revisions) {
    const src = manifest.sources.find(s => s.id === rev.id);
    if (!src) continue;
    src.prev_lsiSeq = rev.old_seq;
    src.source_url = src.source_url.replace(/((?:lsiSeq|admRulSeq)=)\d+/, `$1${rev.new_seq}`);
    src.status = 'planned';
  }
  manifest.generated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\n[APPLY] ${revisions.length}건 manifest 반영 완료. 재수집:`);
  console.log('  node collection/collect_legal_corpus.js');
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
