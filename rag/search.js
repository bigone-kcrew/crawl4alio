#!/usr/bin/env node
/**
 * ALIO 조항 DB 검색 CLI
 *
 * 사용법:
 *   node 3_rag/search.js "연차휴가"
 *   node 3_rag/search.js "임금피크제" --corpus bylaws --limit 20
 *   node 3_rag/search.js "단체협약 체결" --corpus ca --type 단체협약
 *   node 3_rag/search.js "육아휴직" --inst 근로복지공단
 *   node 3_rag/search.js "연차" --ministry 고용노동부 --csv
 *   node 3_rag/search.js "제60조" --compare "근로기준법"  # 특정 법령 조항 기준 유사기관 내규 검색
 *
 * 옵션:
 *   --corpus bylaws|legal|ca|all   코퍼스 필터 (기본: all)
 *   --type   취업규칙|규정|지침...  문서유형 필터 (부분일치)
 *   --inst   기관명                 기관명 필터 (부분일치)
 *   --ministry 부처명              소관부처 필터 (부분일치)
 *   --usecase recruit|audit|governance|labor|finance  활용처 필터 (콤마로 복수 지정 시 OR — 문서의 usecases 배열과 겹침 매칭)
 *   --limit  N                     결과 수 (기본: 15, 최대: 100)
 *   --section 본칙|부칙            조문 구분 필터 (기본: 본칙)
 *   --body                         본문까지 검색 (기본: 조제목만)
 *   --semantic                     의미 검색 (pgvector KNN — 키워드가 조문에 없어도 검색됨.
 *                                  검색어를 NVIDIA API로 임베딩하므로 .env.aiapi 필요)
 *   --json                         JSON 출력
 *   --csv                          CSV 파일로 저장 (search_result_<keyword>.csv)
 *   --full                         본문 전체 출력 (기본: 앞 300자)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = process.env.RAG_ROOT || path.join(__dirname, '..');   // RAG_ROOT로 데이터 워크스페이스 지정 가능

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

// 검색어 임베딩 (조문은 passage, 검색어는 query — 반드시 구분)
function embedQuery(env, text) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'nvidia/llama-nemotron-embed-1b-v2', input: [text.slice(0, 500)],
      input_type: 'query', dimensions: 1024, truncate: 'END',
    });
    const req = https.request({
      hostname: 'integrate.api.nvidia.com', path: '/v1/embeddings', method: 'POST',
      timeout: 30000,
      headers: {
        'Authorization': 'Bearer ' + env.NVIDIA_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d).data[0].embedding); }
        catch (e) { reject(new Error('임베딩 API: ' + d.slice(0, 150))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('임베딩 API timeout')); });
    req.write(body);
    req.end();
  });
}

// '--usecase audit' 또는 'audit,recruit' → text[] 파라미터용 배열 (미지정 시 null)
function parseUsecase(val) {
  if (!val || val === true) return null;
  const list = String(val).split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s));
  return list.length ? list : null;
}

// 의미검색에 필터가 걸렸는지 (2단계 exact 경로 분기 판단용 — api_server/mcp에서 사용)
function semanticHasFilter(args) {
  return args.corpus !== 'all' || !!args.type || !!args.inst || !!args.ministry || !!args.usecase;
}

// ── 2단계 하이브리드 (filtered semantic 가속) ─────────────────────────────────
// HNSW+필터(iterative_scan)는 선택적 필터에서 ~7s까지 걸린다(실측). 대신:
//   1단계: SQL로 필터 후보 조문 id를 먼저 좁힌다(btree/GIN — 수십 ms)
//   2단계: 후보가 작으면(기본 ≤2만) HNSW를 타지 않고 후보 내 '정확' 거리계산
// ORDER BY의 `+ 0`은 의도적 — 식이 인덱스 연산자와 달라져 HNSW가 못 붙는다(정확 스캔 보장).
// 후보가 임계 초과면 기존 HNSW 경로로 폴백. (아이디어 출처: turbovec의 allowlist 2단계 패턴)
function buildCandidateIdsQuery(args, limitPlusOne) {
  return {
    sql: `
      SELECT a.id
      FROM articles a
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      WHERE a.section = $1
        AND ($2 = 'all' OR d.corpus = $2)
        AND ($3::text IS NULL OR d.doc_type ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR i.inst_name ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.ministry ILIKE '%'||$5||'%')
        AND ($6::text[] IS NULL OR d.usecases && $6::text[])
      LIMIT $7`,
    params: [args.section, args.corpus, args.type, args.inst, args.ministry, args.usecase, limitPlusOne],
  };
}

function buildSemanticExactQuery(vecStr, ids, limit) {
  return {
    sql: `
      SELECT
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.rel_path  AS rel_path,
        CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars,
        ROUND((1 - (e.embedding <=> $1::vector(1024)))::numeric, 3) AS score
      FROM articles a
      JOIN article_hash h ON h.id = a.id
      JOIN article_embeddings e ON e.text_hash = h.text_hash
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      WHERE a.id = ANY($2::bigint[])
      ORDER BY (e.embedding <=> $1::vector(1024)) + 0
      LIMIT $3`,
    params: [vecStr, ids, limit],
  };
}

function buildSemanticQuery(vecStr, args) {
  // 필터가 있으면 article_hash로 모든 사본을 대상(기관 필터 등이 대표조문에 안 걸리는 문제 방지),
  // 없으면 embed_queue 대표조문만(중복 제거)
  const hasFilter = semanticHasFilter(args);
  const join = hasFilter
    ? 'JOIN article_hash h USING(text_hash) JOIN articles a ON a.id = h.id'
    : 'JOIN embed_queue q USING(text_hash) JOIN articles a ON a.id = q.id';
  return {
    hasFilter,
    sql: `
      SELECT
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.rel_path  AS rel_path,
        CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars,
        ROUND((1 - (e.embedding <=> $1::vector(1024)))::numeric, 3) AS score
      FROM article_embeddings e
      ${join}
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)
      WHERE a.section = $2
        AND ($3 = 'all' OR d.corpus = $3)
        AND ($4::text IS NULL OR d.doc_type ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.inst_name ILIKE '%'||$5||'%')
        AND ($6::text IS NULL OR i.ministry ILIKE '%'||$6||'%')
        AND ($7::text[] IS NULL OR d.usecases && $7::text[])
      ORDER BY e.embedding <=> $1::vector(1024)
      LIMIT $8`,
    params: [vecStr, args.section, args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit],
  };
}

function parseArgs(argv) {
  const args = { keyword: '', corpus: 'all', type: null, inst: null, ministry: null,
                  usecase: null, limit: 15, section: '본칙', json: false, csv: false, full: false, body: false,
                  semantic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key === 'limit') args.limit = Math.min(100, Math.max(1, parseInt(val) || 15));
      else if (key === 'corpus') args.corpus = val;
      else if (key === 'type') args.type = val;
      else if (key === 'inst') args.inst = val;
      else if (key === 'ministry') args.ministry = val;
      else if (key === 'usecase') args.usecase = parseUsecase(val);
      else if (key === 'section') args.section = val;
      else if (key === 'body') args.body = true;
      else if (key === 'semantic') args.semantic = true;
      else if (key === 'json') args.json = true;
      else if (key === 'csv') args.csv = true;
      else if (key === 'full') args.full = true;
    } else if (!args.keyword) {
      args.keyword = a;
    }
  }
  return args;
}

function buildQuery(args) {
  // 1) 제N조 패턴 감지 → 조번호 직접 검색
  const artMatch = args.keyword.match(/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/);
  if (artMatch) {
    const artNo = parseInt(artMatch[1]);
    const artSub = artMatch[2] ? parseInt(artMatch[2]) : null;
    return {
      sql: `
        SELECT
          i.inst_name AS inst_name,
          i.ministry  AS ministry,
          d.doc_title AS doc_title,
          d.doc_type  AS doc_type,
          d.corpus    AS corpus,
          d.rel_path  AS rel_path,
          CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END AS art_ref,
          a.title     AS art_title,
          a.body      AS body,
          a.n_chars   AS n_chars,
          1.0::real   AS score
        FROM articles a
        JOIN documents d USING(doc_id)
        LEFT JOIN institutions i USING(inst_code)
        WHERE a.art_no = $1
          AND ($2::int IS NULL OR a.art_sub = $2)
          AND a.section = $3
          AND ($4 = 'all' OR d.corpus = $4)
          AND ($5::text IS NULL OR d.doc_type ILIKE '%'||$5||'%')
          AND ($6::text IS NULL OR i.inst_name ILIKE '%'||$6||'%')
          AND ($7::text IS NULL OR i.ministry ILIKE '%'||$7||'%')
          AND ($8::text[] IS NULL OR d.usecases && $8::text[])
        ORDER BY CASE d.corpus WHEN 'legal' THEN 0 WHEN 'ca' THEN 1 ELSE 2 END, inst_name
        LIMIT $9`,
      params: [artNo, artSub, args.section, args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit]
    };
  }

  // 2) 일반 키워드: title % 로 후보 → similarity 정렬
  //    --body 시 본문 ILIKE 포함 (body trgm GIN 인덱스가 ILIKE 가속)
  const kw = args.keyword.slice(0, 40);
  // 조문 단위 히트: 조문 제목(--body 시 본문 ILIKE 포함) 매칭.
  const artHit = args.body
    ? `(a.title ILIKE '%'||$1||'%' OR a.body ILIKE '%'||$1||'%')`
    : `a.title % $1`;
  const artRef = `CASE WHEN a.art_no IS NOT NULL THEN '제'||a.art_no||'조'||COALESCE('의'||a.art_sub::text,'') ELSE '' END`;
  const cols = `
        i.inst_name AS inst_name,
        i.ministry  AS ministry,
        d.doc_title AS doc_title,
        d.doc_type  AS doc_type,
        d.corpus    AS corpus,
        d.rel_path  AS rel_path,
        ${artRef} AS art_ref,
        a.title     AS art_title,
        a.body      AS body,
        a.n_chars   AS n_chars`;
  const from = `
      FROM articles a
      JOIN documents d USING(doc_id)
      LEFT JOIN institutions i USING(inst_code)`;
  const filter = `
        AND a.section = $2
        AND ($3 = 'all' OR d.corpus = $3)
        AND ($4::text IS NULL OR d.doc_type ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR i.inst_name ILIKE '%'||$5||'%')
        AND ($6::text IS NULL OR i.ministry ILIKE '%'||$6||'%')
        AND ($7::text[] IS NULL OR d.usecases && $7::text[])`;
  // 공시자료는 청크 제목(a.title)이 곧 문서명(doc_title)이라 문서명 브랜치가 100% 중복.
  // → 조문 히트만으로 문서명 매칭까지 커버되므로 UNION 생략(가장 무거운 코퍼스 가속, 결과 동일).
  if (args.corpus === 'disclosure') {
    return {
      sql: `
        SELECT ${cols},
               ROUND(similarity(a.title, $1)::numeric, 3) AS score
        ${from}
        WHERE ${artHit}${filter}
        ORDER BY score DESC, inst_name
        LIMIT $8`,
      params: [kw, args.section, args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit]
    };
  }
  // 그 외: 조문 단위 매칭 + 법령/문서 이름 매칭(문서당 대표 1건)을 UNION.
  // 각 브랜치가 자기 trgm 인덱스를 타므로 교차 테이블 OR의 전수스캔을 피한다.
  return {
    sql: `
      SELECT inst_name, ministry, doc_title, doc_type, corpus, rel_path,
             art_ref, art_title, body, n_chars, score
      FROM (
        (SELECT ${cols},
                ROUND(similarity(a.title, $1)::numeric, 3) AS score
         ${from}
         WHERE ${artHit}${filter})
        UNION ALL
        (SELECT DISTINCT ON (d.doc_id) ${cols},
                ROUND(GREATEST(similarity(d.doc_title, $1), COALESCE(similarity(d.alias, $1), 0))::numeric, 3) AS score
         ${from}
         WHERE (d.doc_title % $1 OR d.alias % $1)${filter}
         ORDER BY d.doc_id, a.art_no NULLS LAST, a.id)
      ) t
      ORDER BY score DESC, CASE corpus WHEN 'legal' THEN 0 WHEN 'ca' THEN 1 ELSE 2 END, inst_name
      LIMIT $8`,
    params: [kw, args.section, args.corpus, args.type, args.inst, args.ministry, args.usecase, args.limit]
  };
}

function corpusLabel(c) {
  return c === 'legal' ? '법령' : c === 'ca' ? '단협' : c === 'disclosure' ? '공시' : '내규';
}

function truncate(str, len) {
  if (!str) return '';
  const s = str.replace(/\n+/g, ' ');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

function renderTable(rows, full) {
  if (!rows.length) {
    console.log('검색 결과 없음.');
    return;
  }
  const bodyLen = full ? 2000 : 300;
  rows.forEach((r, i) => {
    const src = r.inst_name || r.doc_title || corpusLabel(r.corpus);
    const no = r.art_ref || '-';
    console.log(`\n[${String(i + 1).padStart(2)}] ${corpusLabel(r.corpus)} | ${src} | ${r.doc_title}`);
    console.log(`     ${no} ${r.art_title || '(제목없음)'}  (유사도: ${r.score}  부처: ${r.ministry || '-'})`);
    console.log(`     ${truncate(r.body, bodyLen)}`);
  });
  console.log(`\n총 ${rows.length}건`);
}

function toCsv(rows) {
  const H = ['corpus', 'inst_name', 'ministry', 'doc_title', 'doc_type', 'art_ref', 'art_title', 'score', 'n_chars', 'body'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return [H.join(','), ...rows.map(r => H.map(k => esc(r[k])).join(','))].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.keyword) {
    console.error('사용법: node 3_rag/search.js "검색어" [옵션]');
    console.error('  --corpus bylaws|legal|ca|all  --type 취업규칙  --inst 기관명  --ministry 부처명');
    console.error('  --usecase recruit|audit|governance|labor|finance(콤마 복수)  --limit N  --section 본칙|부칙  --json  --csv  --full');
    process.exit(1);
  }

  const env = loadEnv();
  const client = new Client({
    host: env.PGHOST || 'postgres', port: +(env.PGPORT || 5432),
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    database: 'alio_rag',
  });

  try {
    await client.connect();
    await client.query("SET statement_timeout='60s'");

    let sql, params;
    if (args.semantic) {
      if (!env.NVIDIA_API_KEY) { console.error('--semantic은 .env.aiapi의 NVIDIA_API_KEY 필요'); process.exit(1); }
      const vec = await embedQuery(env, args.keyword);
      const vecStr = '[' + vec.map(x => x.toFixed(6)).join(',') + ']';
      const q = buildSemanticQuery(vecStr, args);
      if (q.hasFilter) {
        // 선택적 필터 + HNSW 후처리 필터링 대응: 반복 스캔으로 결과 확보
        await client.query("SET hnsw.ef_search = 200");
        await client.query("SET hnsw.iterative_scan = 'relaxed_order'");
      }
      ({ sql, params } = q);
    } else {
      ({ sql, params } = buildQuery(args));
    }

    const t0 = Date.now();
    const res = await client.query(sql, params);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const rows = res.rows;

    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (args.csv) {
      const fname = `search_result_${args.keyword.replace(/[^\w가-힣]/g, '_').slice(0, 20)}.csv`;
      fs.writeFileSync(fname, '﻿' + toCsv(rows)); // BOM for Excel
      renderTable(rows, args.full);
      console.log(`\nCSV 저장: ${fname}`);
    } else {
      renderTable(rows, args.full);
    }

    console.log(`(${elapsed}s)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(e => {
    if (/statement timeout/.test(e.message)) {
      console.error('시간 초과(15s): 검색어가 너무 짧거나 흔합니다.');
      console.error('--body 검색은 3자 이상의 구체적 키워드에 적합합니다. (예: "편차보정", "강제배분")');
      console.error('짧은 키워드는 기본(조제목) 검색을 사용하세요.');
    } else {
      console.error('오류:', e.message);
    }
    process.exit(1);
  });
}

// api_server.js 등 외부 재사용을 위한 export (CLI 동작에는 영향 없음)
// ── RRF(Reciprocal Rank Fusion): 점수 체계가 다른 결과 목록들을 순위만으로 융합 ──
// score(문서) = Σ 1/(K + rank). K=60(관례) — 상위권 가중을 완만하게 눌러 안정적.
// trgm similarity와 cosine처럼 스케일이 다른 점수를 정규화 없이 합칠 수 있다.
const RRF_K = 60;
function rrfFuse(lists, limit) {
  const byKey = new Map();
  for (const rows of lists) rows.forEach((r, i) => {
    const key = (r.rel_path || r.doc_title || '') + '|' + (r.art_ref || '') + '|' + (r.art_title || '');
    const e = byKey.get(key) || { row: r, s: 0 };
    e.s += 1 / (RRF_K + i + 1);
    byKey.set(key, e);
  });
  return [...byKey.values()].sort((a, b) => b.s - a.s).slice(0, limit)
    .map(e => ({ ...e.row, rrf: +e.s.toFixed(4) }));
}

module.exports = { loadEnv, buildQuery, corpusLabel, truncate, embedQuery, buildSemanticQuery, parseUsecase,
  semanticHasFilter, buildCandidateIdsQuery, buildSemanticExactQuery, rrfFuse };
