#!/usr/bin/env node
/**
 * ALIO 조항 검색 HTTP API — 웹 프론트엔드(Vercel)용 백엔드
 *
 * search.js의 buildQuery()를 그대로 재사용한다. CLI와 동일한 검색 로직·결과 필드.
 *
 * 엔드포인트:
 *   GET /api/health                인증 불필요
 *   GET /api/search?keyword=...&corpus=&type=&inst=&ministry=&usecase=audit,recruit&limit=&section=&body=1&semantic=1
 *                                   X-Api-Key 헤더 필요
 *   GET/POST /api/stats/visits      인증 불필요. GET=조회, POST=+1(방문자 식별정보 미저장,
 *                                   일별 중복제거는 프론트 localStorage 담당)
 *
 * 인증: X-Api-Key 헤더를 RAG_API_KEY와 대조. 프론트엔드 게이트는 UX용일 뿐이며
 *       실제 보안 경계는 여기 서버 쪽 검사다.
 * CORS: CORS_ORIGIN env로 허용 오리진 지정(기본 '*' — 실접근 통제는 API 키가 담당하므로
 *       브라우저 오리진 제한 자체는 보안 경계가 아님).
 *
 * 의미검색(semantic=1)은 검색어를 NVIDIA NIM API로 임베딩(.env.aiapi의 NVIDIA_API_KEY 필요)한 뒤
 * pgvector KNN으로 조회한다 — 키워드가 조문에 그대로 없어도 검색됨. HNSW 인덱스가 없으면
 * 전수 스캔이라 느릴 수 있다(README "다음 단계 ①" 참고).
 *
 * Env: RAG_API_KEY(필수), PORT(기본 8090), HOST(기본 0.0.0.0), CORS_ORIGIN(기본 *)
 *      DB 접속은 search.js와 동일하게 .env.api(PGHOST/PGPORT/POSTGRES_USER/POSTGRES_PASSWORD)
 *      또는 컨테이너 env_file로 주입된 process.env를 사용.
 *
 * 실행: node 3_rag/api_server.js
 */
'use strict';

const http = require('http');
const url = require('url');
const { Pool } = require('pg');
const { loadEnv, buildQuery, embedQuery, buildSemanticQuery, parseUsecase,
  semanticHasFilter, buildCandidateIdsQuery, buildSemanticExactQuery, rrfFuse } = require('./search.js');

const fileEnv = (() => { try { return loadEnv(); } catch { return {}; } })();
const env = key => process.env[key] || fileEnv[key] || '';

const PORT = parseInt(env('PORT') || '8090', 10);
const HOST = env('HOST') || '0.0.0.0';
const CORS_ORIGIN = env('CORS_ORIGIN') || '*';
const API_KEY = env('RAG_API_KEY');
// RAG_OPEN=1 이면 접근키 없이 공개(대신 레이트리밋으로 남용/비용 방어).
// 공개 자료라 키 게이트를 없앨 때 사용. 미설정이면 기존처럼 X-Api-Key 요구.
const OPEN = env('RAG_OPEN') === '1';

if (!OPEN && !API_KEY) {
  console.error('[FATAL] RAG_API_KEY가 없고 RAG_OPEN=1도 아닙니다. 둘 중 하나가 필요합니다.');
  process.exit(1);
}

// ── 레이트리밋 (IP당 슬라이딩 윈도우) — NVIDIA 비용·DB 과부하 방어 ──────────────
const RL_WINDOW_MS = 60000;
const RL_MAX = parseInt(env('RATE_LIMIT_PER_MIN') || '40', 10);
const rlHits = new Map();

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (rlHits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  recent.push(now);
  rlHits.set(ip, recent);
  if (rlHits.size > 5000) { // 가끔 청소
    for (const [k, v] of rlHits) if (!v.some(t => now - t < RL_WINDOW_MS)) rlHits.delete(k);
  }
  return recent.length > RL_MAX;
}

// ── 쿼리 재작성 (의미검색 문장형 질의 → 조문에 등장할 검색 문구) ─────────────────
// "임금협상을 하려는데 육아휴직대체수당 지급하는 기관" 같은 자연어는 의도어가
// 임베딩을 희석시켜 검색을 망친다. NIM 소형 LLM으로 핵심 개념어만 추출해 임베딩.
// 실패하면 원문 그대로 검색(폴백) — 재작성은 부가 기능이지 필수 경로가 아님.
const REWRITE_MODEL = 'meta/llama-3.1-8b-instruct';
const REWRITE_SYS = `너는 한국 공공기관 노동 문서(법령·내규·단체협약·공시) 검색용 질의 변환기다.
사용자의 자연어 질문을, 규정 조문에 실제로 등장할 법한 짧은 검색 문구로 바꾼다.
규칙:
- 질문 속 제도 개념어·수식어(공무상 재해, 계약직 등)는 유지하고, 묻는 대상(수당/일수/요건/절차)을 다른 것으로 바꾸지 않는다
- 의도·상황·비교 표현("~하려는데","사례","기관 중에","법적 최저요건 이상")은 지우고 조문 표준 용어로 바꾼다
- 출력은 검색 문구 하나만, 따옴표·설명 없이

예시:
- 못 쓴 연차를 수당으로 받을 수 있나요? → 연차수당
- 연차는 며칠까지 쓸 수 있나요? → 연차유급휴가 일수
- 병가는 얼마나 쓸 수 있나요? → 병가 일수
- 기관 중에 법적 최저요건 이상의 휴가를 보장하는 기관 사례 → 연차유급휴가 일수
- 계약직도 퇴직금을 받을 수 있나요? → 계약직 퇴직금
- 출장 중 사고가 나면 공무상 재해인가요? → 공무상 재해 인정
- 회사가 사업을 넘기면 고용이 승계되나요? → 합병 양도 시 고용승계
- 기관이 통폐합되면 고용은 어떻게 되나요? → 통폐합 고용보장
- 임금협상을 하려는데 육아휴직대체수당 지급하는 기관 → 육아휴직 대체인력 수당`;

// 문장형 판정: 짧은 키워드("연차휴가")는 그대로 두고 공백 있는 10자 이상만 재작성
function looksLikeSentence(kw) {
  return kw.length >= 10 && /\s/.test(kw);
}

async function rewriteQuery(nvidiaKey, keyword) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: 'Bearer ' + nvidiaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: REWRITE_MODEL, temperature: 0, max_tokens: 60,
        messages: [{ role: 'system', content: REWRITE_SYS }, { role: 'user', content: keyword }],
      }),
    });
    if (!r.ok) { console.error('[rewrite fail] HTTP', r.status, (await r.text()).slice(0, 120)); return null; }
    const j = await r.json();
    const out = String(j.choices?.[0]?.message?.content || '')
      .split('\n')[0].replace(/^["'「]|["'」]$/g, '').trim();
    // 비정상 출력(빈 값·과대·원문 그대로·설명 문장)은 버림 → 원문 폴백
    // 문장형 판정: 서술어미로 끝나면 검색어가 아니라 답변/설명임 (예: "...퇴직 방식입니다.")
    const sentenceLike = /(입니다|합니다|됩니다|습니다|어요|아요|에요|이다|하다|된다)[.?!]?$|[.?!]$/.test(out);
    if (!out || out.length < 2 || out.length > 60 || out === keyword || sentenceLike) {
      console.error('[rewrite skip] 비정상 출력:', JSON.stringify(out).slice(0, 80));
      return null;
    }
    console.log('[rewrite]', keyword.slice(0, 40), '→', out);
    return out;
  } catch (e) {
    console.error('[rewrite fail]', e.name === 'AbortError' ? 'timeout(5s)' : e.name + ': ' + e.message);
    return null;
  } finally { clearTimeout(timer); }
}

// ── 검색 실행 ──────────────────────────────────────────────────────────────────

// "제N조" 조번호 질의는 의미검색이어도 정확 조회로 라우팅 (임베딩 불필요)
const ARTICLE_RE = /제\s*\d+\s*조/;

// 같은 점수(동점) 구간에서 코퍼스를 라운드로빈으로 번갈아 뽑아 고르게 배분.
// 점수(정확도)는 그대로 우선하되, 동점일 때 물량 많은 한 코퍼스가 독점하지 않게 함.
const CORPUS_PRI = { legal: 0, ca: 1, bylaws: 2, disclosure: 3 };
// 의미검색 낮은 점수(무관) 컷오프 — 이 값 미만은 노이즈로 보고 제외
const MIN_SEMANTIC_SCORE = parseFloat(env('MIN_SEMANTIC_SCORE') || '0.28');
function interleaveByScore(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    const score = String(rows[i].score);
    while (j < rows.length && String(rows[j].score) === score) j++;
    // rows[i..j) = 동점 그룹 → 코퍼스별 버킷으로 나눠 라운드로빈
    const buckets = new Map();
    for (const r of rows.slice(i, j)) {
      if (!buckets.has(r.corpus)) buckets.set(r.corpus, []);
      buckets.get(r.corpus).push(r);
    }
    const order = [...buckets.keys()].sort((a, b) => (CORPUS_PRI[a] ?? 9) - (CORPUS_PRI[b] ?? 9));
    let added = true;
    while (added) {
      added = false;
      for (const k of order) {
        const b = buckets.get(k);
        if (b.length) { out.push(b.shift()); added = true; }
      }
    }
    i = j;
  }
  return out;
}

// 기관별 대표 1건만 남김 (점수순 정렬 상태에서 첫 행 유지).
// "여러 기관 사례 비교" 질의에서 한 기관의 조항 도배를 막는다. 법령 등 무기관 행은 문서 단위.
function dedupByInst(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const k = r.inst_name || r.doc_title || '';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── 커넥션 풀 — 요청마다 새 연결(핸드셰이크 비용) 대신 재사용. ─────────────────
// ⚠️ 풀에서는 SET이 세션에 남아 다음 요청에 샌다 → 세션 설정은 반드시
//    withPooled()의 트랜잭션 안에서 SET LOCAL로만 건다(트랜잭션 종료 시 자동 원복).
const pool = new Pool({
  host: env('PGHOST') || 'postgres',
  port: parseInt(env('PGPORT') || '5432', 10),
  user: env('POSTGRES_USER'),
  password: env('POSTGRES_PASSWORD'),
  database: 'alio_rag',
  max: parseInt(env('PGPOOL_MAX') || '10', 10),
  idleTimeoutMillis: 30000,
});
pool.on('error', e => console.error('[pg pool]', e.message));

// 풀 클라이언트 1개를 트랜잭션으로 감싸 실행. sets = SET LOCAL 문 배열.
async function withPooled(sets, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of sets) await c.query(s);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}

// ── 캐시 3종 (모두 인메모리 LRU — 단일 컨테이너 전제) ─────────────────────────
class LruCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); // 최근 사용으로 승격
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, v);
  }
}
const embedCache = new LruCache(500);    // 정규화 검색어 → 임베딩 벡터 (NVIDIA 원격호출 절약)
const rewriteCache = new LruCache(500);  // 검색어 → LLM 재작성어 (성공분만 캐시)
const resultCache = new LruCache(200);   // 검색 args 전체 → 응답 (短TTL)
const RESULT_TTL_MS = parseInt(env('RESULT_CACHE_TTL_MS') || '60000', 10);

async function embedCached(nvidiaKey, text) {
  const k = text.trim().replace(/\s+/g, ' ');
  const hit = embedCache.get(k);
  if (hit) return hit;
  const vec = await embedQuery({ NVIDIA_API_KEY: nvidiaKey }, text);
  embedCache.set(k, vec);
  return vec;
}

// ── 방문자 카운터 ────────────────────────────────────────────────────────────
// 일별 중복제거는 프론트(localStorage)가 담당 — 서버는 방문자 식별정보 없이 총합만 보관.
async function ensureVisitTable() {
  await pool.query('CREATE TABLE IF NOT EXISTS visit_counter (id smallint PRIMARY KEY DEFAULT 1, count bigint NOT NULL DEFAULT 0)');
  await pool.query('INSERT INTO visit_counter (id) VALUES (1) ON CONFLICT DO NOTHING');
}

async function runSearch(args) {
  const wantLimit = args.limit;
  // 기관별 1건 모드는 중복 제거로 줄어드는 만큼 넉넉히 가져온 뒤 자른다
  const fetchLimit = args.group ? Math.min(300, wantLimit * 4) : wantLimit;
  const useSemantic = args.semantic && !ARTICLE_RE.test(args.keyword);
  const t0 = Date.now();

  // ── 키워드 팔: 정렬된 rows 반환 (group/절단은 호출부 책임) ─────────────────
  async function keywordArm(lim) {
    // 전체(all)면 코퍼스별로 각각 가져와 동점 배분(모든 코퍼스 대표 보장)
    if (args.corpus === 'all') {
      // 코퍼스별 조회량은 요청 건수에 맞춰 완만히 키우되 상한(120)으로 비용 억제.
      const perLimit = Math.min(120, Math.ceil(lim * 0.6) + 15);
      // 4개 코퍼스를 '병렬'로 조회(풀에서 각자 체크아웃) — 순차 4배 지연 제거.
      const perCorpus = await Promise.all(['legal', 'ca', 'bylaws', 'disclosure'].map(corpus => {
        const q = buildQuery({ ...args, corpus, limit: perLimit });
        return withPooled(["SET LOCAL statement_timeout='15s'"],
          async c => (await c.query(q.sql, q.params)).rows).catch(() => []);
      }));
      const all = perCorpus.flat();
      all.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
      return interleaveByScore(all).slice(0, lim);
    }
    const q = buildQuery({ ...args, limit: lim });
    const res = await withPooled(["SET LOCAL statement_timeout='15s'"], c => c.query(q.sql, q.params));
    return res.rows;
  }

  // ── 의미검색 팔: 원문+재작성어 이중 KNN 융합 → {rows, rewritten} ─────────────
  // 재작성이 좋으면 이득, 나빠도(핵심 개념 누락 등) 원문 결과가 받쳐줘 절대 악화되지 않음.
  // 같은 조문은 max score. 두 임베딩·두 KNN 모두 병렬이라 지연 증가 미미.
  async function semanticArm(lim) {
    const nvidiaKey = env('NVIDIA_API_KEY');
    if (!nvidiaKey) throw Object.assign(new Error('semantic_unavailable'), { code: 'SEMANTIC_UNAVAILABLE' });

    // ── 2단계: 필터가 있으면 후보 id를 먼저 좁힘 ──────────────────────────
    // 후보 ≤ 임계(기본 2만)면 HNSW를 타지 않고 후보 내 정확 거리계산(실측: 선택적 필터
    // 1.1s→0.3s, 중형 1.8배, top-1 동일·recall은 정확 스캔이라 오히려 상회).
    // 후보 0이면 NVIDIA 호출 없이 즉시 빈 결과, 임계 초과면 기존 HNSW 경로 폴백.
    let candIds = null;
    if (semanticHasFilter(args)) {
      const TH = parseInt(env('SEMANTIC_EXACT_MAX') || '20000', 10);
      const cq = buildCandidateIdsQuery(args, TH + 1);
      const cand = await withPooled(["SET LOCAL statement_timeout='15s'"],
        async c => (await c.query(cq.sql, cq.params)).rows).catch(() => null);
      if (cand && cand.length === 0) return { rows: [], rewritten: null };
      if (cand && cand.length <= TH) candIds = cand.map(r => r.id);
    }

    // 문장형 질의는 핵심 개념어로 재작성 (페이지네이션은 norw+rw로 첫 검색 재작성어 재사용 — LLM 변동 방지)
    let rewritten = null;
    if (args.noRewrite) {
      rewritten = args.rw && args.rw !== args.keyword ? args.rw : null;
    } else if (looksLikeSentence(args.keyword)) {
      const rk = args.keyword.trim();
      const cached = rewriteCache.get(rk);
      if (cached !== undefined) rewritten = cached;
      else {
        rewritten = await rewriteQuery(nvidiaKey, args.keyword);
        if (rewritten !== null) rewriteCache.set(rk, rewritten); // 실패(null)는 재시도 여지 위해 미캐시
      }
    }
    const texts = rewritten ? [rewritten, args.keyword] : [args.keyword];
    const vecs = await Promise.all(texts.map(t => embedCached(nvidiaKey, t)));
    const ef = Math.min(500, Math.max(100, lim * 3));
    const perVec = await Promise.all(vecs.map(async vec => {
      const vecStr = '[' + vec.map(x => x.toFixed(6)).join(',') + ']';
      if (candIds) {   // 2단계 exact — HNSW 미사용, 세션 노브 불필요
        const q = buildSemanticExactQuery(vecStr, candIds, lim);
        return withPooled(["SET LOCAL statement_timeout='30s'"],
          async c => (await c.query(q.sql, q.params)).rows).catch(() => []);
      }
      const q = buildSemanticQuery(vecStr, { ...args, limit: lim });
      const sets = ["SET LOCAL statement_timeout='30s'", 'SET LOCAL hnsw.ef_search = ' + ef];
      if (q.hasFilter) sets.push("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      return withPooled(sets, async c => (await c.query(q.sql, q.params)).rows).catch(() => []);
    }));
    // 융합: rel_path(문서 고유)+조 참조로 동일 조문 판별, max score 채택
    const byKey = new Map();
    for (const rs of perVec) for (const r of rs) {
      const k = (r.rel_path || r.doc_title || '') + '' + (r.art_ref || '') + '' + (r.art_title || '');
      const prev = byKey.get(k);
      if (!prev || parseFloat(r.score) > parseFloat(prev.score)) byKey.set(k, r);
    }
    const rows = [...byKey.values()]
      .filter(r => parseFloat(r.score) >= MIN_SEMANTIC_SCORE)
      .sort((a, b) => parseFloat(b.score) - parseFloat(a.score))
      .slice(0, lim);
    return { rows, rewritten };
  }

  // ── RRF 하이브리드(hybrid=1): 키워드+의미 두 팔 병렬 → 순위 융합 ─────────────
  // 사용자가 keyword/semantic을 고를 필요 없는 단일 검색. 의미검색 팔이 죽어도(키 없음 등)
  // 키워드 단독으로 강등(에러 아님). 제N조 질의는 정확 조회가 답이라 하이브리드 미적용.
  if (args.hybrid && !ARTICLE_RE.test(args.keyword)) {
    const depth = Math.min(100, Math.max(20, wantLimit * 2));   // RRF는 목록이 깊을수록 안정
    const [kw, sem] = await Promise.all([
      keywordArm(depth).catch(() => []),
      semanticArm(depth).catch(() => ({ rows: [], rewritten: null })),
    ]);
    let rows = rrfFuse([kw, sem.rows], args.group ? depth : wantLimit);
    if (args.group) rows = dedupByInst(rows).slice(0, wantLimit);
    return { rows, elapsed_ms: Date.now() - t0, semantic: sem.rows.length > 0, hybrid: true,
      ...(sem.rewritten ? { rewritten: sem.rewritten } : {}) };
  }

  if (useSemantic) {
    const { rows: semRows, rewritten } = await semanticArm(fetchLimit);
    let rows = semRows;
    if (args.group) rows = dedupByInst(rows);
    rows = rows.slice(0, wantLimit);
    return { rows, elapsed_ms: Date.now() - t0, semantic: true, rewritten };
  }

  let rows = await keywordArm(fetchLimit);
  if (args.group) rows = dedupByInst(rows);
  rows = rows.slice(0, wantLimit);
  return { rows, elapsed_ms: Date.now() - t0, semantic: false };
}

// search.js의 parseArgs는 argv(--key value 배열) 전용이라, 쿼리스트링을
// 동일한 args 형태로 매핑하는 별도 파서를 둔다(같은 기본값·클램프 규칙 유지).
function parseQueryArgs(query) {
  const limit = Math.min(300, Math.max(1, parseInt(query.limit, 10) || 15));
  return {
    keyword: String(query.keyword || '').slice(0, 100),
    corpus: query.corpus || 'all',
    type: query.type || null,
    inst: query.inst || null,
    ministry: query.ministry || null,
    usecase: parseUsecase(query.usecase),
    section: query.section || '본칙',
    body: query.body === '1' || query.body === 'true',
    semantic: query.semantic === '1' || query.semantic === 'true',
    hybrid: query.hybrid === '1' || query.hybrid === 'true',   // RRF: 키워드+의미 융합 단일검색

    group: query.group === '1' || query.group === 'true',
    noRewrite: query.norw === '1' || query.norw === 'true', // '더 있음' 페이지네이션: LLM 재작성 생략
    rw: String(query.rw || '').slice(0, 100) || null,       // 페이지네이션 시 첫 검색의 재작성어(융합 재현용)
    limit,
  };
}

// ── HTTP 서버 ──────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Tailscale 켠 기기에선 ts.net이 사설 IP(100.x)로 해석돼 크롬 PNA가
    // 공개사이트→사설망 fetch를 차단함 — 이 헤더로 허용 (공개 자료라 무해)
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  if (parsed.pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (parsed.pathname === '/api/stats/visits') {
    if (rateLimited(clientIp(req))) {
      return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    try {
      const q = req.method === 'POST'
        ? 'UPDATE visit_counter SET count = count + 1 WHERE id = 1 RETURNING count'
        : 'SELECT count FROM visit_counter WHERE id = 1';
      const { rows } = await pool.query(q);
      return sendJson(res, 200, { count: Number(rows[0]?.count || 0) });
    } catch (err) {
      console.error('[stats error]', err.message);
      return sendJson(res, 500, { error: '방문자 카운터 처리 중 오류가 발생했습니다.' });
    }
  }

  if (parsed.pathname === '/api/search') {
    if (!OPEN) {
      const providedKey = req.headers['x-api-key'] || parsed.query.key || '';
      if (providedKey !== API_KEY) {
        return sendJson(res, 401, { error: '접근키가 올바르지 않습니다.' });
      }
    }

    if (rateLimited(clientIp(req))) {
      return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }

    const args = parseQueryArgs(parsed.query);
    if (!args.keyword) {
      return sendJson(res, 400, { error: 'keyword 파라미터가 필요합니다.' });
    }

    // 결과 캐시: 동일 args 재조회(챗봇 재질의·웹 새로고침)는 短TTL 내 즉답
    const cacheKey = JSON.stringify(args);
    const hit = resultCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < RESULT_TTL_MS) {
      return sendJson(res, 200, { ...hit.payload, cached: true });
    }

    try {
      const { rows, elapsed_ms, semantic, hybrid, rewritten } = await runSearch(args);
      const payload = { rows, count: rows.length, elapsed_ms, semantic,
        ...(hybrid ? { hybrid } : {}), ...(rewritten ? { rewritten } : {}) };
      resultCache.set(cacheKey, { payload, ts: Date.now() });
      return sendJson(res, 200, payload);
    } catch (err) {
      if (err.code === 'SEMANTIC_UNAVAILABLE') {
        return sendJson(res, 503, { error: '의미검색이 아직 준비되지 않았습니다 (NVIDIA_API_KEY 미설정).' });
      }
      const timeout = /statement timeout/.test(err.message);
      console.error('[search error]', err.message);
      return sendJson(res, timeout ? 408 : 500, {
        error: timeout
          ? '검색 시간 초과 — 검색어가 너무 짧거나 흔합니다. 3자 이상 구체적 키워드를 사용하세요.'
          : '검색 처리 중 오류가 발생했습니다.',
      });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
});

ensureVisitTable()
  .catch(err => console.error('[visit_counter init 실패]', err.message))
  .finally(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[3_rag/api_server] listening on http://${HOST}:${PORT} (auth: ${OPEN ? '공개(RAG_OPEN)' : 'X-Api-Key'}, rate limit: ${RL_MAX}/min)`);
    });
  });
