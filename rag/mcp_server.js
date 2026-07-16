#!/usr/bin/env node
/**
 * ALIO RAG MCP 서버 (stdio) — 에이전트(Claude Code 등)가 코퍼스를 도구로 직접 검색
 *
 * 의존성 없이 MCP stdio 프로토콜(줄단위 JSON-RPC 2.0)을 직접 구현한다.
 * 검색 로직은 search.js(buildQuery/buildSemanticQuery/embedQuery)를 그대로 재사용 —
 * CLI·api_server와 동일한 결과.
 *
 * 도구:
 *   search_corpus  키워드/의미 검색 (corpus, usecase, inst, ministry, type, limit, body, semantic)
 *   get_document   문서 메타 + 조문 목록 (doc_id)
 *   get_article    특정 조문 전문 (doc_id, art_no[, art_sub])
 *
 * 등록(Claude Code): claude mcp add alio-rag -- node /workspace/alio/3_rag/mcp_server.js
 * DB 접속: .env.api (api_server와 동일). 의미검색은 NVIDIA_API_KEY 필요(없으면 키워드만).
 */
'use strict';

const { Pool } = require('pg');
const { loadEnv, buildQuery, embedQuery, buildSemanticQuery, parseUsecase,
  semanticHasFilter, buildCandidateIdsQuery, buildSemanticExactQuery, rrfFuse } = require('./search.js');

const fileEnv = (() => { try { return loadEnv(); } catch { return {}; } })();
const env = key => process.env[key] || fileEnv[key] || '';

const pool = new Pool({
  host: env('PGHOST') || 'postgres',
  port: parseInt(env('PGPORT') || '5432', 10),
  user: env('POSTGRES_USER'),
  password: env('POSTGRES_PASSWORD'),
  database: 'alio_rag',
  max: 4,
  idleTimeoutMillis: 30000,
});
pool.on('error', e => process.stderr.write('[pg pool] ' + e.message + '\n'));

// SET LOCAL은 트랜잭션 안에서만 유효(풀 세션 누수 방지) — api_server와 동일 패턴
async function withPooled(sets, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of sets) await c.query(s);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

// ── 도구 구현 ─────────────────────────────────────────────────────────────────

async function toolSearchCorpus(a) {
  const args = {
    keyword: String(a.keyword || '').slice(0, 100),
    corpus: a.corpus || 'all',
    type: a.type || null,
    inst: a.inst || null,
    ministry: a.ministry || null,
    usecase: parseUsecase(a.usecase || ''),
    section: a.section || '본칙',
    body: !!a.body,
    limit: Math.min(50, Math.max(1, parseInt(a.limit, 10) || 10)),
  };
  if (!args.keyword) throw new Error('keyword가 필요합니다');

  // 검색 행에 doc_id 부여 (DB 불변식: doc_id = corpus||':'||rel_path, 4개 코퍼스 전수 검증됨)
  // → get_document/get_article로 바로 연계 가능. search.js 쿼리는 건드리지 않음.
  const withDocId = rows => rows.map(r => ({ doc_id: r.corpus && r.rel_path ? r.corpus + ':' + r.rel_path : undefined, ...r }));

  // ── 키워드 팔: all이면 4코퍼스 병렬 (api_server와 동일 전략, 간소화) ──────────
  async function kwSearch(lim) {
    if (args.corpus === 'all') {
      const per = await Promise.all(['legal', 'ca', 'bylaws', 'disclosure'].map(corpus => {
        const q = buildQuery({ ...args, corpus, limit: lim });
        return withPooled(["SET LOCAL statement_timeout='15s'"],
          async c => (await c.query(q.sql, q.params)).rows).catch(() => []);
      }));
      return per.flat().sort((x, y) => parseFloat(y.score) - parseFloat(x.score)).slice(0, lim);
    }
    const q = buildQuery({ ...args, limit: lim });
    return withPooled(["SET LOCAL statement_timeout='15s'"],
      async c => (await c.query(q.sql, q.params)).rows);
  }

  // ── 의미검색 팔: 임베딩 1회 + KNN (재작성 융합은 api_server 전용 — MCP는
  //    에이전트가 질의를 다듬는 주체라 불필요). 2단계: 필터 후보 ≤임계면 HNSW 대신 정확 거리.
  async function semSearch(lim) {
    const key = env('NVIDIA_API_KEY');
    if (!key) throw new Error('NVIDIA_API_KEY 미설정 — semantic=false로 키워드 검색을 사용하세요');
    let candIds = null;
    if (semanticHasFilter(args)) {
      const TH = parseInt(env('SEMANTIC_EXACT_MAX') || '20000', 10);
      const cq = buildCandidateIdsQuery(args, TH + 1);
      const cand = await withPooled(["SET LOCAL statement_timeout='15s'"],
        async c => (await c.query(cq.sql, cq.params)).rows).catch(() => null);
      if (cand && cand.length === 0) return [];
      if (cand && cand.length <= TH) candIds = cand.map(r => r.id);
    }
    const vec = await embedQuery({ NVIDIA_API_KEY: key }, args.keyword);
    const vecStr = '[' + vec.map(x => x.toFixed(6)).join(',') + ']';
    if (candIds) {
      const q = buildSemanticExactQuery(vecStr, candIds, lim);
      return withPooled(["SET LOCAL statement_timeout='30s'"],
        async c => (await c.query(q.sql, q.params)).rows);
    }
    const q = buildSemanticQuery(vecStr, { ...args, limit: lim });
    const sets = ["SET LOCAL statement_timeout='30s'",
      'SET LOCAL hnsw.ef_search = ' + Math.min(500, Math.max(100, lim * 3))];
    if (q.hasFilter) sets.push("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    return withPooled(sets, async c => (await c.query(q.sql, q.params)).rows);
  }

  // ── RRF 하이브리드(hybrid=true): 키워드+의미 병렬 → 순위 융합 ────────────────
  // 의미 팔 실패(키 없음 등) 시 키워드 단독 강등. 제N조 질의는 정확 조회라 미적용.
  if (a.hybrid && !/제\s*\d+\s*조/.test(args.keyword)) {
    const depth = Math.min(100, Math.max(20, args.limit * 2));
    const [kw, sem] = await Promise.all([
      kwSearch(depth).catch(() => []),
      semSearch(depth).catch(() => []),
    ]);
    const rows = withDocId(rrfFuse([kw, sem], args.limit));
    return { hybrid: true, semantic: sem.length > 0, count: rows.length, rows };
  }

  if (a.semantic) {
    const rows = withDocId(await semSearch(args.limit));
    return { semantic: true, count: rows.length, rows };
  }
  const rows = withDocId(await kwSearch(args.limit));
  return { semantic: false, count: rows.length, rows };
}

async function toolGetDocument(a) {
  const docId = String(a.doc_id || '');
  if (!docId) throw new Error('doc_id가 필요합니다');
  const maxArts = Math.min(200, Math.max(1, parseInt(a.max_articles, 10) || 50));
  return withPooled(["SET LOCAL statement_timeout='15s'"], async c => {
    const doc = (await c.query(
      `SELECT d.doc_id, d.corpus, d.doc_title, d.alias, d.doc_type, d.doc_date, d.rel_path,
              d.n_articles, d.usecases, i.inst_name, i.ministry,
              d.created_at, d.updated_at
         FROM documents d LEFT JOIN institutions i USING (inst_code)
        WHERE d.doc_id = $1`, [docId])).rows[0];
    if (!doc) throw new Error('문서 없음: ' + docId);
    const arts = (await c.query(
      `SELECT seq, section, chapter, art_no, art_sub, title, n_chars,
              CASE WHEN $2 THEN body ELSE left(body, 200) END AS body
         FROM articles WHERE doc_id = $1 ORDER BY seq LIMIT $3`,
      [docId, !!a.include_body, maxArts])).rows;
    return { document: doc, articles: arts, articles_shown: arts.length };
  });
}

async function toolGetArticle(a) {
  const docId = String(a.doc_id || '');
  const artNo = parseInt(a.art_no, 10);
  if (!docId || !Number.isFinite(artNo)) throw new Error('doc_id와 art_no(정수)가 필요합니다');
  return withPooled(["SET LOCAL statement_timeout='15s'"], async c => {
    const params = [docId, artNo];
    let sub = '';
    if (a.art_sub != null) { params.push(parseInt(a.art_sub, 10)); sub = ' AND art_sub = $3'; }
    const rows = (await c.query(
      `SELECT seq, section, chapter, art_no, art_sub, title, body
         FROM articles WHERE doc_id = $1 AND art_no = $2${sub} ORDER BY seq`, params)).rows;
    if (!rows.length) throw new Error(`조문 없음: ${docId} 제${artNo}조`);
    return { doc_id: docId, articles: rows };
  });
}

// ── MCP 도구 스키마 ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_corpus',
    description: '한국 공공기관 노동 문서(법령 legal·기관내규 bylaws·단체협약 ca·경영공시 disclosure) 조항 검색. ' +
      'semantic=true면 의미검색(키워드가 조문에 없어도 검색), 기본은 trigram 키워드 검색(3자 이상 권장).',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '검색어 (예: 연차수당, 육아휴직 대체인력)' },
        corpus: { type: 'string', enum: ['all', 'legal', 'bylaws', 'ca', 'disclosure'], description: '검색 코퍼스 (기본 all)' },
        semantic: { type: 'boolean', description: '의미검색 사용 (기본 false=키워드)' },
        hybrid: { type: 'boolean', description: '키워드+의미 RRF 융합 단일검색 — 어느 쪽인지 모호할 때 권장' },
        usecase: { type: 'string', description: '활용처 필터, 콤마=OR (labor,audit,recruit,esg,discipline...)' },
        inst: { type: 'string', description: '기관명 필터 (부분일치)' },
        ministry: { type: 'string', description: '소관부처 필터' },
        type: { type: 'string', description: '문서유형 필터 (규정/지침/단체협약/법률...)' },
        body: { type: 'boolean', description: '본문까지 검색 (기본 제목만, 키워드 검색 전용)' },
        limit: { type: 'integer', description: '결과 수 1~50 (기본 10)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_document',
    description: '문서 메타데이터와 조문 목록 조회. search_corpus 결과의 문서를 자세히 볼 때 사용.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '문서 ID (search_corpus 결과의 doc_id)' },
        include_body: { type: 'boolean', description: '조문 전문 포함 (기본 false=200자 미리보기)' },
        max_articles: { type: 'integer', description: '조문 수 상한 1~200 (기본 50)' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'get_article',
    description: '특정 문서의 특정 조문(제N조) 전문 조회.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string' },
        art_no: { type: 'integer', description: '조 번호 (제N조의 N)' },
        art_sub: { type: 'integer', description: '가지조문 번호 (제N조의M의 M, 선택)' },
      },
      required: ['doc_id', 'art_no'],
    },
  },
];

const HANDLERS = { search_corpus: toolSearchCorpus, get_document: toolGetDocument, get_article: toolGetArticle };

// ── MCP stdio 루프 (줄단위 JSON-RPC 2.0) ─────────────────────────────────────

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alio-rag', version: '1.0.0' },
    } });
  }
  if (method === 'notifications/initialized' || String(method).startsWith('notifications/')) return; // 알림은 무응답
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    const fn = HANDLERS[name];
    if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: '알 수 없는 도구: ' + name } });
    try {
      const out = await fn(params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '오류: ' + e.message }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req).catch(e => process.stderr.write('[mcp] ' + e.message + '\n'));
  }
});
process.stdin.on('end', () => { pool.end().finally(() => process.exit(0)); });
