#!/usr/bin/env node
/**
 * 조항 파서 (RAG/PostgreSQL 이식 1단계)
 * md 문서를 조(제N조/제N조의N) 단위로 분해해 JSONL 스테이징 파일 생성.
 *
 * 사용법:
 *   node 3_rag/parse_articles.js legal    # legal-md 115건 (파일럿)
 *   node 3_rag/parse_articles.js bylaws   # institution-bylaws-md 기관별내규
 *   node 3_rag/parse_articles.js ca       # alio-md 내 단체협약 md
 *
 * 출력: 2_data/_rag_staging/{docs,articles}_<corpus>.jsonl + coverage_<corpus>.json
 *  docs 레코드: doc_id, corpus, rel_path, inst_code, inst_name, ministry, category,
 *               doc_title, doc_type, doc_date, meta(frontmatter), n_articles,
 *               content_chars, covered_chars, coverage, parse_status
 *  articles 레코드: doc_id, seq, section(본칙|부칙), chapter, art_no, art_sub,
 *                   title, text, n_chars
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.RAG_ROOT ? path.join(process.env.RAG_ROOT, '2_data') : path.join(__dirname, '..', '2_data');
const OUT = path.join(ROOT, '_rag_staging');

const CORPORA = {
  legal:  { base: path.join(ROOT, 'legal-md', '법령자료'), match: f => f.endsWith('.md') },
  bylaws: { base: path.join(ROOT, 'institution-bylaws-md', '기관별내규'), match: f => f.endsWith('.md') },
  ca:     { base: path.join(ROOT, 'alio-md', '자료', '기관별공시'), match: f => f.endsWith('.md') && f.includes('단체협약') },
};

// ── 조문 경계 패턴 ─────────────────────────────────────────────
// 행 시작(선택적 md 헤더/굵게 표식) + 제N조[의M] + (제목) 또는 공백 제목
const RE_ART = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?(?:\s*\(([^)\n]{1,80})\))?(.*)$/;
// 제목 없는 "제N조 ..."가 실은 조문 인용인 경우 배제 (예: "제3조 및 제4조에 따라")
const RE_REF_TAIL = /^\s*(?:제\d|및|또는|내지|부터|까지|에\s|의\s|와\s|과\s|은\s|는\s|을\s|를\s|이\s|가\s|에서|으로|로\s)/;
const RE_CHAPTER = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?제\s*(\d{1,3})\s*(장|절|편|관)\s*(.*)$/;
const RE_ADDENDUM = /^(?:#{1,6}\s*)?(?:\*{1,2}\s*)?부\s?칙\s*(?:$|[<(（【[]|제\d|\d)/;
const RE_DOCTYPE = /(시행규칙|시행령|법률|기본법|특별법|단체협약|노사합의|취업규칙|규정|지침|규칙|세칙|요령|기준|매뉴얼|가이드라인|편람|예규|고시|훈령|법)/;

function stripMd(s) { return s.replace(/\*{1,2}/g, '').trim(); }

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return { meta: null, bodyStart: 0 };
  for (let i = 1; i < Math.min(lines.length, 40); i++) {
    if (lines[i] === '---') {
      const meta = {};
      for (let j = 1; j < i; j++) {
        const m = lines[j].match(/^(\w[\w_]*):\s*'?(.*?)'?\s*$/);
        if (m) meta[m[1]] = m[2];
      }
      return { meta, bodyStart: i + 1 };
    }
  }
  return { meta: null, bodyStart: 0 };
}

function parseDoc(text) {
  const lines = text.split(/\r?\n/);
  const { meta, bodyStart } = parseFrontmatter(lines);
  const articles = [];
  let cur = null, chapter = '', section = '본칙';
  let contentChars = 0;

  const flush = () => {
    if (!cur) return;
    cur.text = cur.buf.join('\n').replace(/[\u2028\u2029\u0085]/g, '\n').trim();
    cur.n_chars = cur.text.length;
    delete cur.buf;
    if (cur.n_chars > 0) articles.push(cur);
    cur = null;
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    contentChars += line.trim().length;

    if (RE_ADDENDUM.test(line)) {
      flush(); section = '부칙'; chapter = '';
      // 부칙 전문이 한 줄(또는 이어지는 줄들)에 담긴 경우도 청크로 수집
      cur = { seq: articles.length + 1, section, chapter, art_no: null, art_sub: null,
              title: '부칙', buf: [stripMd(line).replace(/^부\s?칙\s*/, '')] };
      continue;
    }
    const ch = line.match(RE_CHAPTER);
    if (ch) { flush(); chapter = '제' + ch[1] + ch[2] + (ch[3] ? ' ' + stripMd(ch[3]) : ''); continue; }

    const m = line.match(RE_ART);
    if (m) {
      const title = m[3] ? stripMd(m[3]) : '';
      const tail = m[4] || '';
      // 제목 괄호가 없고 꼬리가 조문 인용 형태면 경계로 보지 않음
      if (!title && RE_REF_TAIL.test(tail)) {
        if (cur) cur.buf.push(line);
        continue;
      }
      flush();
      cur = {
        seq: articles.length + 1, section, chapter,
        art_no: parseInt(m[1], 10), art_sub: m[2] ? parseInt(m[2], 10) : null,
        title, buf: [],
      };
      const rest = title ? tail.trim() : stripMd(tail);
      if (!title && rest) { // "제1조 목 적" 형태: 짧으면 제목, 길면 본문
        if (rest.length <= 30 && !/[.다]$/.test(rest)) { cur.title = rest; }
        else cur.buf.push(rest);
      } else if (rest) cur.buf.push(rest);
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  flush();
  const covered = articles.reduce((s, a) => s + a.n_chars, 0);
  return { meta, articles, contentChars, covered };
}

// ── 코퍼스별 메타 추출 ─────────────────────────────────────────
function docMeta(corpus, rel, meta) {
  const d = { inst_code: null, inst_name: null, ministry: null, category: null, doc_date: null };
  const base = path.basename(rel, '.md');
  if (corpus === 'legal') {
    d.category = rel.split('/')[0];
    d.ministry = (meta && (meta.ministry || meta.authority)) || null;
    d.doc_title = (meta && meta.title) || base;
    d.doc_date = (meta && (meta.effective_date || meta.amended_at)) || null;
  } else {
    const seg = rel.split('/')[0]; // [부처]기관명_C0000
    const m = seg.match(/^\[([^\]]+)\](.+)_(C\d+)$/);
    if (m) { d.ministry = m[1]; d.inst_name = m[2]; d.inst_code = m[3]; }
    const dm = base.match(/_(\d{8})$/) || base.match(/(\d{4})년/);
    if (dm) d.doc_date = dm[1];
    d.doc_title = base.replace(/_\d{8}$/, '');
  }
  const t = d.doc_title.match(RE_DOCTYPE);
  d.doc_type = corpus === 'ca' ? '단체협약' : (t ? t[1] : '기타');
  return d;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ── 메인 ──────────────────────────────────────────────────────
const corpus = process.argv[2];
if (!CORPORA[corpus]) { console.error('사용법: node parse_articles.js <legal|bylaws|ca>'); process.exit(1); }
const { base, match } = CORPORA[corpus];
fs.mkdirSync(OUT, { recursive: true });

const docsOut = fs.createWriteStream(path.join(OUT, `docs_${corpus}.jsonl`));
const artsOut = fs.createWriteStream(path.join(OUT, `articles_${corpus}.jsonl`));
const stat = { docs: 0, withArticles: 0, articles: 0, coverageSum: 0, zero: [], low: [] };

for (const abs of walk(base)) {
  if (!match(abs)) continue;
  const rel = path.relative(base, abs);
  const text = fs.readFileSync(abs, 'utf8');
  const { meta, articles, contentChars, covered } = parseDoc(text);
  const dm = docMeta(corpus, rel, meta);
  const doc_id = `${corpus}:${rel}`;
  const coverage = contentChars ? +(covered / contentChars).toFixed(3) : 0;
  const parse_status = articles.length === 0 ? 'no_articles' : coverage < 0.5 ? 'low_coverage' : 'ok';

  docsOut.write(JSON.stringify({
    doc_id, corpus, rel_path: rel, ...dm, meta: corpus === 'legal' ? meta : undefined,
    n_articles: articles.length, content_chars: contentChars, covered_chars: covered,
    coverage, parse_status,
  }) + '\n');
  for (const a of articles) artsOut.write(JSON.stringify({ doc_id, ...a }) + '\n');

  stat.docs++; stat.articles += articles.length;
  if (articles.length) { stat.withArticles++; stat.coverageSum += coverage; }
  if (parse_status === 'no_articles') stat.zero.push(rel);
  else if (parse_status === 'low_coverage') stat.low.push(rel);
}
docsOut.end(); artsOut.end();

const report = {
  corpus, docs: stat.docs, docs_with_articles: stat.withArticles,
  docs_no_articles: stat.zero.length, docs_low_coverage: stat.low.length,
  articles: stat.articles,
  avg_coverage_of_parsed: stat.withArticles ? +(stat.coverageSum / stat.withArticles).toFixed(3) : 0,
  no_articles_samples: stat.zero.slice(0, 20), low_coverage_samples: stat.low.slice(0, 20),
};
fs.writeFileSync(path.join(OUT, `coverage_${corpus}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
