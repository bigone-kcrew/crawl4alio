#!/usr/bin/env node
/**
 * 조문 임베딩 생성 — NVIDIA NIM API (llama-nemotron-embed-1b-v2, 1024차원)
 *
 * 사용법:
 *   node 3_rag/embed_articles.js --pilot            # 파일럿: 인사·복무 관련 1만 건
 *   node 3_rag/embed_articles.js                    # 전량 (미처리분만, 재개 가능)
 *   node 3_rag/embed_articles.js --limit 50000      # 상한 지정
 *
 * 전제: load_pg.js 적재 + article_hash/embed_queue/article_embeddings 테이블 존재
 * 체크포인트: article_embeddings에 저장된 해시는 자동 건너뜀 (중단 후 재실행 = 재개)
 * 키: .env.aiapi 의 NVIDIA_API_KEY
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');

const ROOT = process.env.RAG_ROOT || path.join(__dirname, '..');   // RAG_ROOT로 데이터 워크스페이스 지정 가능
const MODEL = 'nvidia/llama-nemotron-embed-1b-v2';
const DIM = 1024;
const BATCH = 128;          // API 1회당 텍스트 수
const FETCH_CHUNK = 2560;   // DB에서 한 번에 가져올 미처리 건수 (BATCH*20)
const MAX_CHARS = 4000;     // 텍스트 길이 상한 (초과분은 서버 truncate:END 병행)
const PILOT_RE = '평가|평정|연차|휴가|휴직|임금|보수|징계|복무';

function loadEnv() {
  const env = {};
  for (const f of ['.env.api', '.env.aiapi']) {
    try {
      for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = l.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
    } catch (e) {}
  }
  return env;
}

function embed(apiKey, texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL, input: texts,
      input_type: 'passage', dimensions: DIM, truncate: 'END',
    });
    const req = https.request({
      hostname: 'integrate.api.nvidia.com', path: '/v1/embeddings', method: 'POST',
      timeout: 120000,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 200) {
          try {
            const j = JSON.parse(d);
            resolve(j.data.map(x => x.embedding));
          } catch (e) { reject(new Error('parse: ' + d.slice(0, 200))); }
        } else {
          const err = new Error(`HTTP ${r.statusCode}: ${d.slice(0, 200)}`);
          err.status = r.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function embedWithRetry(apiKey, texts) {
  const waits = [5000, 15000, 60000, 180000];
  for (let i = 0; ; i++) {
    try {
      return await embed(apiKey, texts);
    } catch (e) {
      if (i >= waits.length) throw e;
      const w = (e.status === 429) ? Math.max(waits[i], 60000) : waits[i];
      console.log(`  재시도 ${i + 1} (${e.message.slice(0, 80)}) — ${w / 1000}s 대기`);
      await new Promise(r => setTimeout(r, w));
    }
  }
}

function parseArgs(argv) {
  const a = { pilot: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pilot') { a.pilot = true; a.limit = a.limit || 10000; }
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i]) || 0;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.NVIDIA_API_KEY) { console.error('NVIDIA_API_KEY 없음 (.env.aiapi)'); process.exit(1); }

  const c = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alio_rag',
  });
  await c.connect();
  await c.query("SET statement_timeout='300s'");

  const pilotCond = args.pilot ? `AND a.title ~ '${PILOT_RE}'` : '';
  const t0 = Date.now();
  let done = 0;

  while (true) {
    if (args.limit && done >= args.limit) break;
    const fetchN = args.limit ? Math.min(FETCH_CHUNK, args.limit - done) : FETCH_CHUNK;
    const { rows } = await c.query(`
      SELECT q.text_hash, a.title, a.body
      FROM embed_queue q
      JOIN articles a ON a.id = q.id
      LEFT JOIN article_embeddings e ON e.text_hash = q.text_hash
      WHERE e.text_hash IS NULL ${pilotCond}
      LIMIT $1`, [fetchN]);
    if (!rows.length) break;

    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const texts = slice.map(r =>
        ((r.title ? r.title + '\n' : '') + r.body).slice(0, MAX_CHARS));
      const vecs = await embedWithRetry(env.NVIDIA_API_KEY, texts);

      const hashes = slice.map(r => r.text_hash);
      const vecStrs = vecs.map(v => '[' + v.map(x => x.toFixed(6)).join(',') + ']');
      await c.query(`
        INSERT INTO article_embeddings (text_hash, embedding, model)
        SELECT h, v::vector(${DIM}), '${MODEL}'
        FROM unnest($1::text[], $2::text[]) AS t(h, v)
        ON CONFLICT (text_hash) DO NOTHING`, [hashes, vecStrs]);

      done += slice.length;
      if (done % (BATCH * 10) < BATCH) {
        const rate = done / ((Date.now() - t0) / 60000);
        console.log(`${done}건 완료 — ${rate.toFixed(0)}건/분`);
      }
    }
  }

  const s = await c.query('SELECT count(*) n FROM article_embeddings');
  console.log(`종료: 이번 실행 ${done}건, 누적 ${s.rows[0].n}건, ${((Date.now() - t0) / 60000).toFixed(1)}분`);
  await c.end();
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
