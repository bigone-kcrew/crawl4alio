#!/usr/bin/env node
/**
 * 공시자료(disclosure) 청커 — alio-md/자료/기관별공시 의 비조문형 문서를
 * 검색용 청크로 분해해 JSONL 스테이징 생성. (조문 파서 parse_articles.js와 별개)
 *
 * 사용법:
 *   node 3_rag/parse_disclosure.js            # 전체
 *   node 3_rag/parse_disclosure.js --limit 300  # 앞 300파일만(테스트)
 *   node 3_rag/parse_disclosure.js --sample 3   # 청크 샘플 3건 출력
 *
 * 출력: 2_data/_rag_staging/{docs,articles}_disclosure.jsonl + coverage_disclosure.json
 *  - 청크는 articles 레코드 형태로 저장(section='본칙', art_no=null) → 기존 적재·검색 재사용
 */
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const ROOT = process.env.RAG_ROOT ? path.join(process.env.RAG_ROOT, '2_data') : path.join(__dirname, '..', '2_data');
const OUT = path.join(ROOT, '_rag_staging');
const BASE = path.join(ROOT, 'alio-md', '자료', '기관별공시');

const CHUNK_CAP = 40;           // 문서당 최대 청크(거대 OCR 덤프 방어)
const MIN_CHUNK_CHARS = 40;     // 이보다 짧거나 글자 없으면 스킵
const OVERLAP = 120;

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;
const SAMPLE = args.includes('--sample') ? parseInt(args[args.indexOf('--sample') + 1], 10) : 0;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function stripFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] === '---') {
    for (let i = 1; i < Math.min(lines.length, 40); i++) {
      if (lines[i] === '---') return lines.slice(i + 1);
    }
  }
  return lines;
}

// 한 줄을 검색용 텍스트로 정리. 버릴 줄이면 null.
function cleanLine(raw) {
  let s = raw;
  if (/alio\.go\.kr/.test(s)) return null;                        // 포털 링크/nav
  if (/^\s*#{0,6}\s*!\[/.test(s)) return null;                    // 이미지(로고/CI)
  if (/\[(PDF|파일)[^\]]*다운로드\]|javascript:void/.test(s)) return null;
  if (/^\s*(#{1,6}\s*)?(문서\s*목차|첨부파일|보고서명)\s*$/.test(s)) return null;
  if (/^\s*\|?[\s:|]*-{2,}[\s:|-]*\|?\s*$/.test(s)) return null;  // 표 구분행
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.replace(/\|/g, '  ');        // 표 데이터행 → 셀 텍스트
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                  // [t](url) → t
  s = s.replace(/\*\*?/g, '').replace(/^\s*#{1,6}\s*/, '');       // 굵게/헤딩 표식 제거
  s = s.replace(/[\u3000\u00a0]/g, ' ').replace(/\s+$/, '');
  return s;
}

function meaningful(t) {
  return t.length >= MIN_CHUNK_CHARS && /[가-힣A-Za-z]/.test(t);
}

// 정리된 텍스트를 문단 누적 방식으로 청킹(적응형 크기·오버랩·상한)
function chunkDoc(rawLines) {
  const cleaned = [];
  for (const l of rawLines) {
    const c = cleanLine(l);
    if (c === null) continue;
    cleaned.push(c);
  }
  const text = cleaned.join('\n');
  const paras = text.split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const contentChars = paras.reduce((s, p) => s + p.length, 0);
  if (contentChars === 0) return { chunks: [], contentChars: 0, truncated: false };

  const target = Math.max(1000, Math.min(4000, Math.round(contentChars / CHUNK_CAP)));
  const chunks = [];
  let cur = '';
  let truncated = false;

  const push = () => {
    const t = cur.trim();
    if (meaningful(t)) chunks.push(t);
    cur = '';
  };

  for (let pi = 0; pi < paras.length; pi++) {
    let p = paras[pi];
    // 한 문단이 target보다 크면 하드 분할
    if (p.length > target) {
      if (cur) { push(); if (chunks.length >= CHUNK_CAP) { truncated = pi < paras.length; break; } }
      for (let i = 0; i < p.length; i += target) {
        if (chunks.length >= CHUNK_CAP) { truncated = true; break; }
        const piece = p.slice(i, i + target).trim();
        if (meaningful(piece)) chunks.push(piece);
      }
      if (chunks.length >= CHUNK_CAP && (pi < paras.length - 1)) { truncated = true; break; }
      continue;
    }
    if (cur && cur.length + 1 + p.length > target) {
      const prev = cur;
      push();
      if (chunks.length >= CHUNK_CAP) { truncated = pi < paras.length; break; }
      cur = prev.slice(-OVERLAP) + ' ';   // 오버랩
    }
    cur += (cur ? ' ' : '') + p;
  }
  if (chunks.length < CHUNK_CAP) push();

  return { chunks, contentChars, truncated };
}

function docMeta(rel) {
  const segs = rel.split(path.sep);
  const m = (segs[0] || '').match(/^\[([^\]]+)\](.+)_(C\d+)$/);
  const ministry = m ? m[1] : null, inst_name = m ? m[2] : null, inst_code = m ? m[3] : null;
  const yearSeg = segs.find(s => /^\d{4}$/.test(s)) || null;
  // 카테고리 세그먼트(숫자코드_항목명) 중 연도 직전의 가장 깊은 것 = 실제 항목.
  // 상위그룹(예: 기관운영)이 한 단계 더 낀 예외 경로에서도 하위항목(인력관리 등)을 집음.
  const yi = segs.findIndex(s => /^\d{4}$/.test(s));
  const endIdx = yi === -1 ? segs.length - 1 : yi;   // 파일명(basename)은 제외
  const catSegs = segs.slice(1, endIdx).filter(s => /^\d+_/.test(s));
  const scdSeg = catSegs.length ? catSegs[catSegs.length - 1] : (segs[1] || '');
  const itemName = scdSeg.includes('_') ? scdSeg.slice(scdSeg.indexOf('_') + 1) : scdSeg;
  const base = path.basename(rel, '.md');
  const dm = base.match(/\((\d{8})\)/) || base.match(/(\d{8})/) || base.match(/\((\d{4})[.\-)]/);
  const doc_date = dm ? dm[1] : yearSeg;
  const doc_title = base.replace(/\(\d{8}\)\s*$/, '').replace(/\(첨부\)/g, '').trim() || base;
  return { inst_code, inst_name, ministry, category: scdSeg || null,
           doc_title, doc_type: itemName || '공시', doc_date };
}

fs.mkdirSync(OUT, { recursive: true });
const docsOut = fs.createWriteStream(path.join(OUT, 'docs_disclosure.jsonl'));
const artsOut = fs.createWriteStream(path.join(OUT, 'articles_disclosure.jsonl'));
docsOut.on('error', e => { console.error('docs 쓰기 실패:', e); process.exit(1); });
artsOut.on('error', e => { console.error('articles 쓰기 실패:', e); process.exit(1); });
const stat = { files: 0, docs: 0, chunks: 0, empty: 0, truncated: 0, skippedCa: 0 };
let seen = 0, samplesShown = 0;

// 동기 루프는 이벤트 루프를 막아 수 GB가 스트림 버퍼에 통째로 쌓였다가
// 종료 flush에서 writev 실패로 죽는 사고가 있었음(2026-07-17, 4GiB 절단+중복) — drain 대기 필수.
async function write(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function main() {
for (const abs of walk(BASE)) {
  if (!abs.endsWith('.md')) continue;
  if (abs.includes('단체협약')) { stat.skippedCa++; continue; }  // 이미 ca 코퍼스
  seen++;
  if (LIMIT && seen > LIMIT) break;

  const rel = path.relative(BASE, abs);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const { chunks, contentChars, truncated } = chunkDoc(stripFrontmatter(text));
  const dm = docMeta(rel);
  const doc_id = `disclosure:${rel}`;
  const parse_status = chunks.length === 0 ? 'empty' : (truncated ? 'truncated' : 'chunked');
  const covered = chunks.reduce((s, c) => s + c.length, 0);
  const coverage = contentChars ? +(Math.min(1, covered / contentChars)).toFixed(3) : 0;

  await write(docsOut, JSON.stringify({
    doc_id, corpus: 'disclosure', rel_path: rel, ...dm,
    n_articles: chunks.length, coverage, parse_status,
  }) + '\n');
  for (let i = 0; i < chunks.length; i++) {
    // PostgreSQL TEXT는 NUL(0x00)을 저장 못 함 — OCR/변환 산출물에 섞여 들어와 적재 전체가 깨진 사고(2026-07-17, 1건)
    const body = chunks[i].replace(/\u0000/g, '');
    await write(artsOut, JSON.stringify({
      doc_id, seq: i + 1, section: '본칙', chapter: null, art_no: null, art_sub: null,
      title: dm.doc_title.replace(/\u0000/g, ''), text: body, n_chars: body.length,
    }) + '\n');
  }

  stat.files++; stat.docs++; stat.chunks += chunks.length;
  if (chunks.length === 0) stat.empty++;
  if (truncated) stat.truncated++;

  if (SAMPLE && samplesShown < SAMPLE && chunks.length) {
    console.log(`\n--- 샘플 [${dm.doc_type}] ${dm.doc_title} (${chunks.length}청크) ---`);
    console.log(chunks[0].slice(0, 300));
    samplesShown++;
  }
}
// flush 완료까지 대기 — 여기서 실패하면 스테이징이 불완전하므로 반드시 비정상 종료
await Promise.all([
  new Promise((res, rej) => docsOut.end(err => err ? rej(err) : res())),
  new Promise((res, rej) => artsOut.end(err => err ? rej(err) : res())),
]);

const report = {
  base_files_scanned: seen, docs: stat.docs, chunks: stat.chunks,
  empty_docs: stat.empty, truncated_docs: stat.truncated, skipped_ca: stat.skippedCa,
  avg_chunks_per_doc: stat.docs ? +(stat.chunks / stat.docs).toFixed(2) : 0,
};
fs.writeFileSync(path.join(OUT, 'coverage_disclosure.json'), JSON.stringify(report, null, 2));
console.log('\n' + JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('parse_disclosure 실패:', e); process.exit(1); });
