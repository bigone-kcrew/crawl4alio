#!/usr/bin/env node
/**
 * ALIO API 프로브 (읽기 전용)
 *
 * 확장 개발 전 라이브 API의 실제 응답 shape을 확인하는 도구.
 *   ① itemReportListSusi.json 페이지네이션 필드(total/count)와 pageNo=2 동작
 *   ② 정기공시 SCD(20501)의 Jung 계열 API 실존 여부·shape
 *   ③ itemList.do 뒤 공시항목 카탈로그 JSON 엔드포인트
 *
 * Usage: node collection/probe_alio_api.js [--apba-id C0451] [--scd 21026]
 */
'use strict';

const path = require('path');
const axios = require('axios');

const BASE = 'https://www.alio.go.kr';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APBA_ID = opt('--apba-id', 'C0451');   // 창업진흥원
const SUSI_SCD = opt('--scd', '21026');      // 이사회 의결 (수시, 다건)
const PERIODIC_SCD = '20501';                // 임원 연봉 (정기)

const sleep = ms => new Promise(r => setTimeout(r, ms));

function show(label, data, depth = 3) {
  console.log(`\n━━━ ${label} ━━━`);
  console.log(JSON.stringify(data, (k, v) => {
    if (Array.isArray(v) && v.length > 3) return [...v.slice(0, 3), `...(${v.length}건)`];
    return v;
  }, 2)?.slice(0, 3000));
}

async function post(url, payload) {
  try {
    const res = await axios.post(BASE + url, payload, { timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, status: e.response?.status, body: String(e.response?.data || e.message).slice(0, 300) };
  }
}

async function get(url) {
  try {
    const res = await axios.get(BASE + url, { timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, status: e.response?.status, body: String(e.response?.data || e.message).slice(0, 300) };
  }
}

async function main() {
  console.log(`프로브 대상: apbaId=${APBA_ID}, 수시 SCD=${SUSI_SCD}, 정기 SCD=${PERIODIC_SCD}`);

  // ── ① Susi 페이지네이션 ──────────────────────────────────────────────────
  const organ = await post('/item/itemOrganListSusi.json', { apbaId: APBA_ID, reportFormRootNo: SUSI_SCD });
  const apbaType = organ.ok ? organ.data?.data?.organInfo?.apbaType : '';
  show('① itemOrganListSusi (organInfo)', organ.ok ? organ.data?.data?.organInfo : organ);
  await sleep(1500);

  for (const pageNo of [1, 2]) {
    const list = await post('/item/itemReportListSusi.json', {
      pageNo, apbaId: APBA_ID, apbaType, reportFormRootNo: SUSI_SCD,
      search_word: '', search_flag: 'title', bid_type: '', enfc_istt: ''
    });
    if (list.ok) {
      const d = list.data?.data || {};
      console.log(`\n━━━ ① Susi page=${pageNo} ━━━`);
      console.log('data 키:', Object.keys(d).join(', '));
      const rows = d.result || [];
      console.log(`rows=${rows.length}, 첫행 disclosureNo=${rows[0]?.disclosureNo}, 마지막=${rows[rows.length-1]?.disclosureNo}`);
      const meta = { ...d }; delete meta.result;
      console.log('메타 필드:', JSON.stringify(meta).slice(0, 800));
      if (rows[0]) console.log('행 필드:', Object.keys(rows[0]).join(', '));
    } else {
      show(`① Susi page=${pageNo} 실패`, list);
    }
    await sleep(1500);
  }

  // ── ② 정기공시(Jung) 계열 ────────────────────────────────────────────────
  const jungOrgan = await post('/item/itemOrganListJung.json', { apbaId: APBA_ID, reportFormRootNo: PERIODIC_SCD });
  show('② itemOrganListJung', jungOrgan.ok ? { keys: Object.keys(jungOrgan.data?.data || {}), sample: jungOrgan.data?.data } : jungOrgan);
  await sleep(1500);

  const jungApbaType = jungOrgan.ok ? (jungOrgan.data?.data?.organInfo?.apbaType || apbaType) : apbaType;
  for (const candidate of ['/item/itemReportListJung.json', '/item/itemReportList.json']) {
    const r = await post(candidate, {
      pageNo: 1, apbaId: APBA_ID, apbaType: jungApbaType, reportFormRootNo: PERIODIC_SCD,
      search_word: '', search_flag: 'title', bid_type: '', enfc_istt: ''
    });
    show(`② 후보 ${candidate}`, r.ok ? { keys: Object.keys(r.data?.data || {}), rows: (r.data?.data?.result || []).length, first: (r.data?.data?.result || [])[0] } : r);
    await sleep(1500);
  }

  // 정기 SCD를 Susi API로 호출하면 실제로 어떤 에러가 오는지 확인
  const periodicViaSusi = await post('/item/itemReportListSusi.json', {
    pageNo: 1, apbaId: APBA_ID, apbaType, reportFormRootNo: PERIODIC_SCD,
    search_word: '', search_flag: 'title', bid_type: '', enfc_istt: ''
  });
  show('② 정기 SCD를 Susi로 호출 시', periodicViaSusi.ok ? { keys: Object.keys(periodicViaSusi.data?.data || {}), rows: (periodicViaSusi.data?.data?.result || []).length, status: periodicViaSusi.data?.status } : periodicViaSusi);
  await sleep(1500);

  // ── ③ 카탈로그 JSON 엔드포인트 ───────────────────────────────────────────
  const html = await get('/item/itemList.do');
  if (html.ok) {
    const jsonUrls = [...new Set(String(html.data).match(/["'\/][\w\/]*\.json/g) || [])];
    console.log('\n━━━ ③ itemList.do 내 .json 참조 ━━━');
    console.log(jsonUrls.join('\n') || '(없음)');
    // ajax url 패턴 추가 탐색
    const ajaxCalls = [...new Set(String(html.data).match(/url\s*[:=]\s*["'][^"']+["']/g) || [])].slice(0, 30);
    console.log('\nurl: 패턴:', ajaxCalls.join('\n'));
  } else {
    show('③ itemList.do', html);
  }
  await sleep(1500);

  for (const candidate of ['/item/itemListAll.json', '/item/findItemList.json', '/item/itemList.json']) {
    const r = await post(candidate, {});
    show(`③ 후보 ${candidate}`, r.ok ? { keys: Object.keys(r.data || {}), dataLen: Array.isArray(r.data?.data) ? r.data.data.length : typeof r.data?.data } : r);
    await sleep(1500);
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
