#!/usr/bin/env node
/**
 * law.go.kr DRF API 프로브 (읽기 전용)
 *
 * 별표·서식(붙임) 수집과 개정 감지 개발 전 응답 shape 확인:
 *   ① lawSearch.do (법령 검색) — 법령일련번호·시행일자 필드
 *   ② lawService.do 법령 JSON의 별표/별표단위 구조와 파일링크
 *   ③ lawSearch.do target=licbyl (별표서식 검색) 응답
 *
 * Env: OPENAPILAWKEY 또는 LAW_OC (law.go.kr Open API 이용자 ID)
 * Usage: node collection/probe_lawgo_annex.js [--query "근로기준법 시행규칙"]
 */
'use strict';

const axios = require('axios');

const OC = (process.env.OPENAPILAWKEY || process.env.LAW_OC || '').trim();
if (!OC) { console.error('OPENAPILAWKEY 또는 LAW_OC 환경변수가 필요합니다.'); process.exit(1); }

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const QUERY = opt('--query', '근로기준법 시행규칙');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function summarize(v, depth = 0) {
  if (Array.isArray(v)) return `[${v.length}건: ${v.length ? summarize(v[0], depth + 1) : ''}]`;
  if (v && typeof v === 'object') {
    if (depth > 2) return '{...}';
    return '{' + Object.keys(v).map(k => `${k}: ${summarize(v[k], depth + 1)}`).join(', ') + '}';
  }
  return JSON.stringify(String(v).slice(0, 60));
}

async function drf(params) {
  const url = 'https://www.law.go.kr/DRF/' + params.svc + '.do';
  const query = Object.entries({ OC, type: 'JSON', ...params.q })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try {
    const res = await axios.get(`${url}?${query}`, { timeout: 30000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, status: e.response?.status, body: String(e.response?.data || e.message).slice(0, 300) };
  }
}

async function main() {
  // ── ① 법령 검색 ─────────────────────────────────────────────────────────
  const search = await drf({ svc: 'lawSearch', q: { target: 'law', query: QUERY, display: 5 } });
  console.log('━━━ ① lawSearch target=law ━━━');
  if (search.ok) {
    const root = search.data?.LawSearch || search.data;
    console.log('최상위 키:', Object.keys(search.data || {}));
    console.log('구조:', summarize(root));
    const laws = root?.law || [];
    const first = Array.isArray(laws) ? laws[0] : laws;
    console.log('\n첫 결과 전체:', JSON.stringify(first, null, 2)?.slice(0, 1200));
  } else console.log('실패:', search);
  await sleep(1200);

  // 검색 결과에서 법령일련번호 추출
  let lsiSeq = '';
  if (search.ok) {
    const root = search.data?.LawSearch || search.data;
    const laws = root?.law || [];
    const first = Array.isArray(laws) ? laws[0] : laws;
    lsiSeq = String(first?.['법령일련번호'] || '');
  }
  console.log('\n사용할 lsiSeq:', lsiSeq || '(추출 실패)');

  // ── ② 법령 본문 JSON의 별표 구조 ─────────────────────────────────────────
  if (lsiSeq) {
    const law = await drf({ svc: 'lawService', q: { target: 'law', MST: lsiSeq } });
    console.log('\n━━━ ② lawService 법령 JSON ━━━');
    if (law.ok) {
      const body = law.data?.['법령'] || law.data;
      console.log('법령 하위 키:', Object.keys(body || {}));
      const annex = body?.['별표'];
      if (annex) {
        console.log('별표 하위 키:', Object.keys(annex));
        const units = annex['별표단위'];
        const arr = Array.isArray(units) ? units : [units];
        console.log(`별표단위: ${arr.length}건`);
        console.log('첫 별표단위 전체:', JSON.stringify(arr[0], null, 2)?.slice(0, 1500));
      } else {
        console.log('별표 키 없음. 본문 키 상세:', summarize(body));
      }
    } else console.log('실패:', law);
    await sleep(1200);
  }

  // ── ③ 별표서식 검색 (licbyl) ─────────────────────────────────────────────
  const licbyl = await drf({ svc: 'lawSearch', q: { target: 'licbyl', query: QUERY, display: 3 } });
  console.log('\n━━━ ③ lawSearch target=licbyl ━━━');
  if (licbyl.ok) {
    console.log('최상위 키:', Object.keys(licbyl.data || {}));
    console.log('구조:', summarize(licbyl.data));
    console.log('원본 일부:', JSON.stringify(licbyl.data).slice(0, 1200));
  } else console.log('실패:', licbyl);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
