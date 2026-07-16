#!/usr/bin/env node
/**
 * 감사(audit) 컬럼 + KST 타임존 마이그레이션 (2026-07-16)
 *
 * 기존 라이브 alio_rag DB에 적용 (신규 설치는 load_pg.js SCHEMA가 처리):
 *  1) documents/articles/institutions/article_embeddings에 감사 컬럼 추가
 *  2) load_runs 테이블 + documents UPDATE 트리거(set_updated_at)
 *  3) ALTER DATABASE alio_rag SET timezone='Asia/Seoul' — 세션 기본 KST 표시
 *     (timestamptz는 내부 UTC 저장, 표시만 KST — 데이터 이관/DST 모호성 없음)
 *
 * ⚠️ 기존 행의 created_at은 실제 생성시각을 소급할 수 없어 마이그레이션 시각으로 채워짐.
 *    구분 필요 시 created_by IS NULL(마이그레이션 이전 행) 로 판별.
 * 멱등: 모든 문장이 IF NOT EXISTS / OR REPLACE. 재실행 안전.
 *
 * Usage: node 3_rag/migrate_audit_kst.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = process.env.RAG_ROOT || path.join(__dirname, '..');   // RAG_ROOT로 데이터 워크스페이스 지정 가능
const DRY = process.argv.includes('--dry-run');

function loadEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env.api'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const STMTS = [
  // 1) 감사 컬럼 (additive, PG16에서 DEFAULT 있는 ADD COLUMN은 메타데이터만 — 무중단)
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by text`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at timestamptz`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_by text`,
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS load_run_id bigint`,
  `ALTER TABLE articles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE articles ADD COLUMN IF NOT EXISTS created_by text`,
  `ALTER TABLE articles ADD COLUMN IF NOT EXISTS load_run_id bigint`,
  `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE article_embeddings ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  // 2) load_runs + 트리거
  `CREATE TABLE IF NOT EXISTS load_runs (
     id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     script      text NOT NULL,
     mode        text,
     corpus      text,
     started_at  timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     n_docs      int,
     n_articles  int
   )`,
  `CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
   BEGIN NEW.updated_at = now(); RETURN NEW; END
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_documents_updated ON documents`,
  `CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents
     FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
  // 3) KST — 새 세션부터 적용(기존 연결은 재접속 후)
  `ALTER DATABASE alio_rag SET timezone = 'Asia/Seoul'`,
];

async function main() {
  const env = loadEnv();
  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();

  if (DRY) {
    console.log('[DRY-RUN] 실행 예정 문장:');
    STMTS.forEach((s, i) => console.log(`  ${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 90)}...`));
  } else {
    for (const sql of STMTS) {
      const t = Date.now();
      await c.query(sql);
      console.log('OK', ((Date.now() - t) / 1000).toFixed(1) + 's —', sql.replace(/\s+/g, ' ').slice(0, 70));
    }
  }

  // 검증
  const cols = await c.query(`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN ('created_at','created_by','updated_at','updated_by','load_run_id')
    ORDER BY table_name, column_name`);
  console.log('\n감사 컬럼 현황:');
  for (const r of cols.rows) console.log(`  ${r.table_name}.${r.column_name} (${r.data_type})`);
  const tz = await c.query(`SELECT current_setting('timezone') tz, now() as db_now`);
  console.log('타임존(현재 세션):', tz.rows[0].tz, '| DB now():', tz.rows[0].db_now);
  const trg = await c.query(`SELECT tgname FROM pg_trigger WHERE tgname='trg_documents_updated'`);
  console.log('트리거:', trg.rows.length ? 'trg_documents_updated 존재' : '⚠️ 없음');
  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
