#!/usr/bin/env node
/**
 * 스테이징 JSONL 검증 게이트 — load_pg 적재 전에 돌려서 불완전/오염 스테이징을 잡는다.
 *
 * 2026-07-17 실사고 두 건을 계기로 만들었다:
 *   ① 쓰기 스트림 크래시로 파일이 4GiB에서 절단되고 60.7만 줄이 중복 기록됨
 *      → 라인 JSON 유효성 + (doc_id, seq) 유일성 + docs의 n_articles 합계 대조로 탐지
 *   ② 변환 산출물 1건에 섞인 NUL(0x00)이 PostgreSQL TEXT 적재 전체를 중단시킴
 *      → 본문·제목의 NUL/제어문자 검사로 탐지
 *
 * 사용법:
 *   node rag/validate_staging.js <corpus>        # legal | bylaws | ca | disclosure
 *   RAG_ROOT=/path/to/workspace node rag/validate_staging.js disclosure
 *
 * 통과하면 exit 0, 하나라도 걸리면 원인 요약을 출력하고 exit 1.
 * 파이프라인에서는 `node rag/validate_staging.js disclosure || exit 1` 로 게이트를 두면 된다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = process.env.RAG_ROOT ? path.join(process.env.RAG_ROOT, '2_data') : path.join(__dirname, '..', '2_data');
const STAGING = path.join(ROOT, '_rag_staging');

const corpus = process.argv[2];
if (!corpus) { console.error('사용법: node rag/validate_staging.js <corpus>'); process.exit(2); }

const docsPath = path.join(STAGING, `docs_${corpus}.jsonl`);
const artsPath = path.join(STAGING, `articles_${corpus}.jsonl`);
for (const p of [docsPath, artsPath]) {
  if (!fs.existsSync(p)) { console.error('파일 없음:', p); process.exit(1); }
}

const C = String.fromCharCode;
const NUL = C(0);
// 탭(9)·개행(10)·CR(13)을 제외한 C0 제어문자
const CTRL_RE = new RegExp('[' + C(1) + '-' + C(8) + C(11) + C(12) + C(14) + '-' + C(31) + ']');

async function scanLines(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let n = 0;
  for await (const l of rl) { n++; onLine(l, n); }
  return n;
}

(async () => {
  const problems = [];

  // ── docs: 라인 유효성 + 문서별 기대 청크 수 집계 ──
  let docsN = 0, docsBad = 0, expectedChunks = 0;
  const docIds = new Set();
  await scanLines(docsPath, (l, n) => {
    docsN = n;
    let j; try { j = JSON.parse(l); } catch { docsBad++; return; }
    docIds.add(j.doc_id);
    expectedChunks += j.n_articles || 0;
  });
  if (docsBad) problems.push(`docs: JSON 파싱 실패 ${docsBad}줄`);
  if (docIds.size !== docsN) problems.push(`docs: doc_id 중복 ${docsN - docIds.size}건`);

  // ── articles: 라인 유효성 + (doc_id, seq) 유일성 + NUL/제어문자 + 고아 doc_id ──
  let artsN = 0, artsBad = 0, dup = 0, nul = 0, ctrl = 0, orphan = 0;
  const seen = new Set();
  const samples = [];
  await scanLines(artsPath, (l, n) => {
    artsN = n;
    let j; try { j = JSON.parse(l); } catch { artsBad++; if (samples.length < 3) samples.push(`파싱실패 line ${n}`); return; }
    const key = j.doc_id + '|' + j.seq;
    if (seen.has(key)) { dup++; if (samples.length < 3) samples.push(`중복 ${key}`); }
    else seen.add(key);
    const s = (j.text || '') + (j.title || '');
    if (s.indexOf(NUL) >= 0) { nul++; if (samples.length < 5) samples.push(`NUL ${j.doc_id} seq ${j.seq}`); }
    else if (CTRL_RE.test(s)) { ctrl++; if (samples.length < 5) samples.push(`제어문자 ${j.doc_id} seq ${j.seq}`); }
    if (!docIds.has(j.doc_id)) orphan++;
  });
  if (artsBad) problems.push(`articles: JSON 파싱 실패 ${artsBad}줄 (절단 의심)`);
  if (dup) problems.push(`articles: (doc_id, seq) 중복 ${dup}줄 (이중 기록 의심)`);
  if (nul) problems.push(`articles: NUL(0x00) 포함 ${nul}건 — PostgreSQL 적재가 통째로 실패한다`);
  if (orphan) problems.push(`articles: docs에 없는 doc_id ${orphan}줄`);
  if (artsN !== expectedChunks + dup) {
    // 중복이 없다는 전제에서 라인 수 == docs n_articles 합이어야 한다
    if (artsN !== expectedChunks) problems.push(`articles: 라인 ${artsN} ≠ docs n_articles 합 ${expectedChunks} (누락/절단 의심)`);
  }

  console.log(`docs_${corpus}: ${docsN}줄 (${docIds.size} 문서, 기대 청크 ${expectedChunks})`);
  console.log(`articles_${corpus}: ${artsN}줄 (유니크 ${seen.size}, 제어문자 ${ctrl})`);
  if (problems.length) {
    console.error('\n❌ 검증 실패:');
    problems.forEach(p => console.error('  -', p));
    samples.forEach(s => console.error('    예:', s));
    process.exit(1);
  }
  console.log('✅ 검증 통과');
})();
