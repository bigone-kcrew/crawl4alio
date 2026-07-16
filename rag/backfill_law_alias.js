#!/usr/bin/env node
/**
 * source_manifest.json의 법령명약칭(alias)을 documents.alias 컬럼에 반영.
 * 매칭 키: documents.doc_title == manifest title (legal 코퍼스는 frontmatter title이 manifest title과 동일).
 * 재실행 안전: 컬럼 없으면 생성, alias는 title 기준 upsert.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, '2_data', 'legal-md', 'source_manifest.json'), 'utf8'));
  const aliasByTitle = new Map();
  for (const s of manifest.sources) {
    if (s.alias) aliasByTitle.set(s.title, s.alias);
  }
  console.log('약칭 보유 법령:', aliasByTitle.size);

  const env = loadEnv();
  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();

  await c.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS alias text`);

  let updated = 0;
  for (const [title, alias] of aliasByTitle) {
    const r = await c.query(
      `UPDATE documents SET alias=$1, updated_by='backfill_law_alias' WHERE corpus='legal' AND doc_title=$2`,
      [alias, title]);
    if (r.rowCount > 0) updated += r.rowCount;
    else console.log('  매칭 안됨:', title);
  }
  console.log('documents.alias 갱신:', updated);

  await c.query(`CREATE INDEX IF NOT EXISTS idx_docs_alias_trgm ON documents USING gin (alias gin_trgm_ops)`);
  await c.query('ANALYZE documents');

  const check = await c.query(`SELECT doc_title, alias FROM documents WHERE alias IS NOT NULL ORDER BY doc_title LIMIT 5`);
  console.log('샘플:', check.rows);

  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
