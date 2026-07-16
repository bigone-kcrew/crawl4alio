#!/usr/bin/env node
/**
 * documents.usecases(text[]) 활용처 태그 백필 — RAG에서 활용처 필터 지원.
 * 매핑은 1_collection/classify_usecase.js(단일 출처)의 CODE_MAP/KEYWORD_MAP 재사용.
 *  - disclosure: category(예: 31301_재무성과, B1210_국회지적사항)의 코드 → alioUsecases
 *  - bylaws/legal: doc_title 키워드 → keywordUsecases (legal 미매칭은 _shared)
 *  - ca: 단체협약 → ['labor'] 고정
 * 재실행 안전: 컬럼 없으면 생성, 전체 재계산 upsert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { alioUsecases, keywordUsecases } = require('../collection/classify_usecase.js');

const ROOT = process.env.RAG_ROOT || path.join(__dirname, '..');   // RAG_ROOT로 데이터 워크스페이스 지정 가능

function loadEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env.api'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();

  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS usecases text[]`);

  // ① disclosure: distinct category 단위(수백 종)로 일괄 UPDATE
  const cats = await c.query(
    `SELECT DISTINCT category FROM documents WHERE corpus='disclosure' AND category IS NOT NULL`);
  let discRows = 0, discCats = 0;
  for (const { category } of cats.rows) {
    const code = category.split('_')[0];
    const ucs = alioUsecases(code);
    if (!ucs.length) continue;
    const r = await c.query(
      `UPDATE documents SET usecases=$1, updated_by='backfill_usecase' WHERE corpus='disclosure' AND category=$2`,
      [ucs, category]);
    discRows += r.rowCount; discCats++;
  }
  console.log(`disclosure: ${discCats}/${cats.rows.length} 카테고리 매핑, ${discRows}행`);

  // ② ca: 단체협약 전체 → labor
  const ca = await c.query(`UPDATE documents SET usecases=ARRAY['labor'], updated_by='backfill_usecase' WHERE corpus='ca'`);
  console.log(`ca: ${ca.rowCount}행 → ['labor']`);

  // ③ bylaws/legal: doc_title 키워드 매칭 (JS 계산 → unnest 일괄 UPDATE)
  for (const corpus of ['bylaws', 'legal']) {
    const docs = await c.query(`SELECT doc_id, doc_title FROM documents WHERE corpus=$1`, [corpus]);
    const ids = [], arrs = [];
    for (const d of docs.rows) {
      let ucs = keywordUsecases(d.doc_title || '');
      if (!ucs.length) {
        if (corpus === 'legal') ucs = ['_shared'];  // classify_usecase와 동일: 미매칭 법령은 공유참조
        else continue;                              // 내규 미매칭은 태그 없음(NULL)
      }
      ids.push(d.doc_id); arrs.push('{' + ucs.join(',') + '}');
    }
    let updated = 0;
    const BATCH = 5000;
    for (let i = 0; i < ids.length; i += BATCH) {
      const r = await c.query(
        `UPDATE documents d SET usecases=u.ucs::text[], updated_by='backfill_usecase'
           FROM unnest($1::text[], $2::text[]) AS u(doc_id, ucs)
          WHERE d.doc_id=u.doc_id`,
        [ids.slice(i, i + BATCH), arrs.slice(i, i + BATCH)]);
      updated += r.rowCount;
    }
    console.log(`${corpus}: ${updated}/${docs.rows.length}행 태그`);
  }

  await c.query(`CREATE INDEX IF NOT EXISTS idx_docs_usecases ON documents USING gin (usecases)`);
  await c.query('ANALYZE documents');

  const stat = await c.query(
    `SELECT corpus, unnest(usecases) AS uc, count(*) FROM documents GROUP BY 1,2 ORDER BY 1,2`);
  console.log('활용처별 문서 수:');
  for (const r of stat.rows) console.log(`  ${r.corpus}/${r.uc}: ${r.count}`);

  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
