#!/usr/bin/env node
/**
 * 2단계: _rag_staging JSONL → PostgreSQL(alio_rag) 적재
 *
 * 사용법: node 3_rag/load_pg.js          # 스키마 생성 + 전체 적재 + 인덱스
 * 접속정보: 리포 루트 .env.api 의 POSTGRES_USER / POSTGRES_PASSWORD (host=postgres)
 * 재실행 안전: TRUNCATE 후 다시 적재 (멱등)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client } = require('pg');

const ROOT = process.env.RAG_ROOT || path.join(__dirname, '..');   // RAG_ROOT로 데이터 워크스페이스 지정 가능
const STAGING = path.join(ROOT, '2_data', '_rag_staging');
const CORPORA = ['legal', 'bylaws', 'ca'];
const BATCH = 2000;

function loadEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(ROOT, '.env.api'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS institutions (
  inst_code text PRIMARY KEY,
  inst_name text NOT NULL,
  ministry  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  doc_id       text PRIMARY KEY,
  corpus       text NOT NULL,            -- legal | bylaws | ca
  rel_path     text NOT NULL,
  inst_code    text REFERENCES institutions,
  category     text,                     -- legal 하위분류
  doc_title    text,
  alias        text,                     -- 법령 공식 약칭(law.go.kr 법령명약칭, legal 코퍼스만)
  doc_type     text,                     -- 규정/지침/규칙/세칙/단체협약/법률...
  doc_date     text,                     -- YYYYMMDD 또는 YYYY
  n_articles   int,
  coverage     real,
  parse_status text,                     -- ok | low_coverage | no_articles
  -- 감사(audit): created_*=적재 시점(원본 날짜는 doc_date), updated_*=backfill 등 후속 수정
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,                     -- 기록 주체(스크립트 식별자, 예: load_pg@append)
  updated_at   timestamptz,              -- 트리거(set_updated_at)가 UPDATE 시 자동 기록
  updated_by   text,
  load_run_id  bigint                    -- load_runs.id — 어느 적재 배치에서 왔는지
);

CREATE TABLE IF NOT EXISTS articles (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id  text NOT NULL REFERENCES documents,
  seq     int  NOT NULL,
  section text,                          -- 본칙 | 부칙
  chapter text,
  art_no  int,
  art_sub int,
  title   text,
  body    text NOT NULL,
  n_chars int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  load_run_id bigint,
  UNIQUE (doc_id, seq)
);

-- 적재 실행 이력(감사 단위): 어느 스크립트가 언제 무엇을 몇 건 적재했나
CREATE TABLE IF NOT EXISTS load_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script      text NOT NULL,
  mode        text,                      -- full | append
  corpus      text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  n_docs      int,
  n_articles  int
);

-- documents UPDATE 시 updated_at 자동 기록 (라이터가 updated_by만 세팅하면 됨)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_documents_updated ON documents;
CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_articles_doc ON articles(doc_id)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_inst ON documents(inst_code)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(doc_type)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_corpus ON documents(corpus)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_body_trgm ON articles USING gin (body gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_title_trgm ON documents USING gin (doc_title gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_alias_trgm ON documents USING gin (alias gin_trgm_ops)`,
  // 조번호 정확검색(제N조)용 — 없으면 코퍼스당 전수스캔이라 전체검색이 15s 타임아웃
  `CREATE INDEX IF NOT EXISTS idx_articles_artno ON articles(art_no) WHERE art_no IS NOT NULL`,
];

async function* jsonlLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

// ── append 모드: TRUNCATE 없이 특정 코퍼스만 추가 (기존 조문·임베딩 보존) ──────
// 새 청크 행에 대해서만 article_hash/embed_queue를 채워 embed_articles.js가
// 신규 벡터만 생성하게 함. text_hash는 임베딩 입력과 동일한 문자열의 md5.
async function appendCorpus(co) {
  const env = loadEnv();
  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();
  await c.query(SCHEMA);
  for (const sql of INDEXES) await c.query(sql);
  // 부수 테이블 보장(기존과 동일 스키마)
  await c.query(`CREATE TABLE IF NOT EXISTS article_hash (id bigint PRIMARY KEY, text_hash text NOT NULL)`);
  await c.query(`CREATE TABLE IF NOT EXISTS embed_queue (text_hash text PRIMARY KEY, id bigint NOT NULL)`);

  // 적재 실행 이력 시작(감사)
  const runId = (await c.query(
    `INSERT INTO load_runs (script, mode, corpus) VALUES ('load_pg', 'append', $1) RETURNING id`, [co])).rows[0].id;
  const BY = 'load_pg@append';

  // 재실행 안전: 이 코퍼스 기존 데이터 제거 후 재적재 (조문 코퍼스는 불변)
  await c.query(`DELETE FROM article_hash ah USING articles a WHERE ah.id=a.id AND a.doc_id LIKE $1`, [co + ':%']);
  await c.query(`DELETE FROM articles WHERE doc_id LIKE $1`, [co + ':%']);
  await c.query(`DELETE FROM documents WHERE doc_id LIKE $1`, [co + ':%']);

  // institutions upsert
  for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
    if (d.inst_code) await c.query('INSERT INTO institutions (inst_code, inst_name, ministry) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [d.inst_code, d.inst_name, d.ministry]);
  }

  // documents
  let nDocs = 0;
  { const cols = Array.from({ length: 11 }, () => []);
    const flush = async () => { if (!cols[0].length) return;
      await c.query(`INSERT INTO documents (doc_id,corpus,rel_path,inst_code,category,doc_title,doc_type,doc_date,n_articles,coverage,parse_status,created_by,load_run_id)
        SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::real[],$11::text[]) AS u`, cols);
      cols.forEach(a => a.length = 0); };
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      [d.doc_id, d.corpus, d.rel_path, d.inst_code, d.category, d.doc_title, d.doc_type, d.doc_date, d.n_articles, d.coverage, d.parse_status]
        .forEach((v, i) => cols[i].push(v ?? null));
      if (++nDocs % BATCH === 0) await flush();
    }
    await flush(); }
  console.log(`documents(${co}):`, nDocs);

  // articles
  let nArts = 0;
  { const cols = Array.from({ length: 9 }, () => []);
    const flush = async () => { if (!cols[0].length) return;
      await c.query(`INSERT INTO articles (doc_id,seq,section,chapter,art_no,art_sub,title,body,n_chars,created_by,load_run_id)
        SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::text[],$8::text[],$9::int[]) AS u`, cols);
      cols.forEach(a => a.length = 0); };
    for await (const a of jsonlLines(path.join(STAGING, `articles_${co}.jsonl`))) {
      [a.doc_id, a.seq, a.section, a.chapter, a.art_no, a.art_sub, a.title, a.text, a.n_chars]
        .forEach((v, i) => cols[i].push(v ?? null));
      if (++nArts % BATCH === 0) await flush();
      if (nArts % 200000 === 0) console.log('  articles...', nArts);
    }
    await flush(); }
  console.log(`articles(${co}):`, nArts);

  // article_hash / embed_queue — 이 코퍼스 신규 행만.
  // text_hash = md5( (title? title||E'\n' : '') || left(body,4000) )  ← embed_articles.js 입력과 동일
  await c.query(`
    INSERT INTO article_hash (id, text_hash)
    SELECT a.id, md5( (CASE WHEN a.title IS NOT NULL AND a.title<>'' THEN a.title||E'\n' ELSE '' END) || left(a.body,4000) )
    FROM articles a WHERE a.doc_id LIKE $1
    ON CONFLICT (id) DO NOTHING`, [co + ':%']);
  const eq = await c.query(`
    INSERT INTO embed_queue (text_hash, id)
    SELECT DISTINCT ON (ah.text_hash) ah.text_hash, ah.id
    FROM article_hash ah JOIN articles a ON a.id=ah.id
    WHERE a.doc_id LIKE $1
    ON CONFLICT (text_hash) DO NOTHING`, [co + ':%']);
  console.log(`embed_queue 신규:`, eq.rowCount);

  await c.query('ANALYZE articles, documents');
  await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);
  const s = await c.query(`SELECT (SELECT count(*) FROM documents WHERE corpus=$1) d,
    (SELECT count(*) FROM articles a JOIN documents dd USING(doc_id) WHERE dd.corpus=$1) a,
    (SELECT count(*) FROM embed_queue) q, (SELECT count(*) FROM article_embeddings) e,
    pg_size_pretty(pg_database_size('alio_rag')) size`, [co]);
  console.log('append 완료:', JSON.stringify(s.rows[0]), `(load_run ${runId})`);
  await c.end();
}

// ── delta 모드: 스테이징에 있는 doc_id만 정확히 교체(다른 문서 불가침) ─────────
//   수시 증분(recruit) 전용. parse_disclosure --under <cat> --since <ms> --out <dir> 부분 스테이징을 받아
//   그 doc_id들만 삭제→재삽입 + 신규 해시만 embed_queue. append(전체 코퍼스 교체)와 달리 범위 한정.
async function appendCorpusDelta(co, stagingDir) {
  const dir = stagingDir || STAGING;
  const dry = process.argv.includes('--dry-run');
  const ids = [];
  for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`))) ids.push(d.doc_id);
  if (!ids.length) { console.log(`delta(${co}): 스테이징 문서 0건 — 변경 없음`); return; }
  const bad = ids.filter(id => !String(id).startsWith(co + ':'));
  if (bad.length) throw new Error(`delta(${co}): 접두 불일치 ${bad.length}건 — 중단(예: ${bad[0]})`);
  console.log(`delta(${co}): 대상 문서 ${ids.length}건${dry ? ' [DRY-RUN]' : ''}`);

  const env = loadEnv();
  const c = new Client({ host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag' });
  await c.connect();
  if (dry) {
    const d = (await c.query(`SELECT count(*) n FROM documents WHERE doc_id = ANY($1)`, [ids])).rows[0].n;
    const a = (await c.query(`SELECT count(*) n FROM articles  WHERE doc_id = ANY($1)`, [ids])).rows[0].n;
    console.log(`  [DRY] 기존 매칭 documents ${d} · articles ${a} → 이 doc_id들만 삭제 후 재삽입 예정(다른 공시 무영향)`);
    await c.end(); return;
  }
  await c.query(SCHEMA);
  await c.query(`CREATE TABLE IF NOT EXISTS article_hash (id bigint PRIMARY KEY, text_hash text NOT NULL)`);
  await c.query(`CREATE TABLE IF NOT EXISTS embed_queue (text_hash text PRIMARY KEY, id bigint NOT NULL)`);
  const runId = (await c.query(`INSERT INTO load_runs (script, mode, corpus) VALUES ('load_pg','delta',$1) RETURNING id`, [co])).rows[0].id;
  const BY = 'load_pg@delta';
  await c.query('BEGIN');
  try {
    await c.query(`DELETE FROM article_hash ah USING articles a WHERE ah.id=a.id AND a.doc_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM articles  WHERE doc_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM documents WHERE doc_id = ANY($1)`, [ids]);
    for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`)))
      if (d.inst_code) await c.query('INSERT INTO institutions (inst_code,inst_name,ministry) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [d.inst_code, d.inst_name, d.ministry]);
    let nDocs = 0; { const cols = Array.from({ length: 11 }, () => []);
      const flush = async () => { if (!cols[0].length) return;
        await c.query(`INSERT INTO documents (doc_id,corpus,rel_path,inst_code,category,doc_title,doc_type,doc_date,n_articles,coverage,parse_status,created_by,load_run_id)
          SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::real[],$11::text[]) AS u`, cols);
        cols.forEach(a => a.length = 0); };
      for await (const d of jsonlLines(path.join(dir, `docs_${co}.jsonl`))) {
        [d.doc_id,d.corpus,d.rel_path,d.inst_code,d.category,d.doc_title,d.doc_type,d.doc_date,d.n_articles,d.coverage,d.parse_status].forEach((v,i)=>cols[i].push(v??null));
        if (++nDocs % BATCH === 0) await flush(); }
      await flush(); }
    let nArts = 0; { const cols = Array.from({ length: 9 }, () => []);
      const flush = async () => { if (!cols[0].length) return;
        await c.query(`INSERT INTO articles (doc_id,seq,section,chapter,art_no,art_sub,title,body,n_chars,created_by,load_run_id)
          SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::text[],$8::text[],$9::int[]) AS u`, cols);
        cols.forEach(a => a.length = 0); };
      for await (const a of jsonlLines(path.join(dir, `articles_${co}.jsonl`))) {
        [a.doc_id,a.seq,a.section,a.chapter,a.art_no,a.art_sub,a.title,a.text,a.n_chars].forEach((v,i)=>cols[i].push(v??null));
        if (++nArts % BATCH === 0) await flush(); }
      await flush(); }
    await c.query(`INSERT INTO article_hash (id, text_hash)
      SELECT a.id, md5( (CASE WHEN a.title IS NOT NULL AND a.title<>'' THEN a.title||E'\n' ELSE '' END) || left(a.body,4000) )
      FROM articles a WHERE a.doc_id = ANY($1) ON CONFLICT (id) DO NOTHING`, [ids]);
    const eq = await c.query(`INSERT INTO embed_queue (text_hash, id)
      SELECT DISTINCT ON (ah.text_hash) ah.text_hash, ah.id FROM article_hash ah JOIN articles a ON a.id=ah.id
      WHERE a.doc_id = ANY($1) ON CONFLICT (text_hash) DO NOTHING`, [ids]);
    await c.query('COMMIT');
    await c.query('ANALYZE articles, documents');
    await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);
    console.log(`delta(${co}) 완료: documents ${nDocs} · articles ${nArts} · embed_queue 신규 ${eq.rowCount} (load_run ${runId})`);
  } catch (e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { await c.end(); }
}

async function main() {
  const appendIdx = process.argv.indexOf('--append');
  if (appendIdx >= 0) { await appendCorpus(process.argv[appendIdx + 1]); return; }
  const deltaIdx = process.argv.indexOf('--delta');
  if (deltaIdx >= 0) {
    const si = process.argv.indexOf('--staging');
    await appendCorpusDelta(process.argv[deltaIdx + 1], si >= 0 ? process.argv[si + 1] : undefined);
    return;
  }

  const env = loadEnv();
  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();
  await c.query(SCHEMA);
  const runId = (await c.query(
    `INSERT INTO load_runs (script, mode, corpus) VALUES ('load_pg', 'full', $1) RETURNING id`, [CORPORA.join(',')])).rows[0].id;
  const BY = 'load_pg@full';
  await c.query('TRUNCATE articles, documents, institutions CASCADE');

  // 1) institutions — docs_* 에서 유도
  const insts = new Map();
  for (const co of CORPORA) {
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      if (d.inst_code && !insts.has(d.inst_code)) insts.set(d.inst_code, [d.inst_code, d.inst_name, d.ministry]);
    }
  }
  for (const [code, name, min] of insts.values()) {
    await c.query('INSERT INTO institutions (inst_code, inst_name, ministry) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, name, min]);
  }
  console.log('institutions:', insts.size);

  // 2) documents
  await c.query('BEGIN');
  let nDocs = 0;
  for (const co of CORPORA) {
    const cols = [[], [], [], [], [], [], [], [], [], [], []];
    const flush = async () => {
      if (!cols[0].length) return;
      await c.query(`INSERT INTO documents (doc_id,corpus,rel_path,inst_code,category,doc_title,doc_type,doc_date,n_articles,coverage,parse_status,created_by,load_run_id)
        SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::real[],$11::text[]) AS u`, cols);
      cols.forEach(a => a.length = 0);
    };
    for await (const d of jsonlLines(path.join(STAGING, `docs_${co}.jsonl`))) {
      [d.doc_id, d.corpus, d.rel_path, d.inst_code, d.category, d.doc_title, d.doc_type,
       d.doc_date, d.n_articles, d.coverage, d.parse_status].forEach((v, i) => cols[i].push(v ?? null));
      nDocs++;
      if (cols[0].length >= BATCH) await flush();
    }
    await flush();
  }
  console.log('documents:', nDocs);

  // 3) articles
  let nArts = 0;
  for (const co of CORPORA) {
    const cols = [[], [], [], [], [], [], [], [], []];
    const flush = async () => {
      if (!cols[0].length) return;
      await c.query(`INSERT INTO articles (doc_id,seq,section,chapter,art_no,art_sub,title,body,n_chars,created_by,load_run_id)
        SELECT u.*, '${BY}'::text, ${runId}::bigint FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::text[],$8::text[],$9::int[]) AS u`, cols);
      cols.forEach(a => a.length = 0);
    };
    for await (const a of jsonlLines(path.join(STAGING, `articles_${co}.jsonl`))) {
      [a.doc_id, a.seq, a.section, a.chapter, a.art_no, a.art_sub, a.title, a.text, a.n_chars]
        .forEach((v, i) => cols[i].push(v ?? null));
      nArts++;
      if (cols[0].length >= BATCH) await flush();
      if (nArts % 200000 === 0) console.log('  articles...', nArts);
    }
    await flush();
    console.log(`articles(${co}) 누적:`, nArts);
  }
  await c.query('COMMIT');

  // 4) 인덱스
  for (const sql of INDEXES) {
    const t = Date.now();
    await c.query(sql);
    console.log('인덱스:', sql.match(/idx_\w+/)[0], ((Date.now() - t) / 1000).toFixed(1) + 's');
  }

  // 5) article_hash / embed_queue — full 경로도 반드시 채운다.
  //    (2026-07-18 사고: append만 채우던 탓에 TRUNCATE 재적재분 137만 조문이
  //     의미검색 조인(articles→article_hash→embeddings)에서 통째로 빠졌음)
  await c.query(`CREATE TABLE IF NOT EXISTS article_hash (id bigint PRIMARY KEY, text_hash text NOT NULL)`);
  await c.query(`CREATE TABLE IF NOT EXISTS embed_queue (text_hash text PRIMARY KEY, id bigint NOT NULL)`);
  const dh = await c.query(`DELETE FROM article_hash h WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = h.id)`);
  const dq = await c.query(`DELETE FROM embed_queue q WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = q.id)`);
  const ih = await c.query(`
    INSERT INTO article_hash (id, text_hash)
    SELECT a.id, md5( (CASE WHEN a.title IS NOT NULL AND a.title<>'' THEN a.title||E'\n' ELSE '' END) || left(a.body,4000) )
    FROM articles a
    ON CONFLICT (id) DO NOTHING`);
  const iq = await c.query(`
    INSERT INTO embed_queue (text_hash, id)
    SELECT DISTINCT ON (h.text_hash) h.text_hash, h.id
    FROM article_hash h
    ON CONFLICT (text_hash) DO NOTHING`);
  console.log(`article_hash: dangling -${dh.rowCount}, 신규 +${ih.rowCount} | embed_queue: dangling -${dq.rowCount}, 신규 +${iq.rowCount}`);

  await c.query('ANALYZE');
  await c.query(`UPDATE load_runs SET finished_at=now(), n_docs=$1, n_articles=$2 WHERE id=$3`, [nDocs, nArts, runId]);

  const s = await c.query(`SELECT (SELECT count(*) FROM institutions) i,
    (SELECT count(*) FROM documents) d, (SELECT count(*) FROM articles) a,
    pg_size_pretty(pg_database_size('alio_rag')) size`);
  console.log('완료:', JSON.stringify(s.rows[0]), `(load_run ${runId})`);
  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
