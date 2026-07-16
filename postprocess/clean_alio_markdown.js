#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { USECASES, alioUsecases } = require('../collection/classify_usecase');

const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const ROOT = path.resolve(process.cwd(), rootArg ? rootArg.slice(7) : '2_data/alio-md');
const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='));
const MANIFEST = manifestArg
  ? path.resolve(process.cwd(), manifestArg.slice('--manifest='.length))
  : '';
const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const preview = args.has('--preview');
const quiet = args.has('--quiet');
const all = args.has('--all');
const afterArg = process.argv.find((arg) => arg.startsWith('--after='));
const beforeArg = process.argv.find((arg) => arg.startsWith('--before='));
const scopeArg = process.argv.find((arg) => arg.startsWith('--scope='));
const parserArg = process.argv.find((arg) => arg.startsWith('--parser='));
const usecaseArg = process.argv.find((arg) => arg.startsWith('--usecase='));
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const REPORT = reportArg
  ? path.resolve(process.cwd(), reportArg.slice('--report='.length))
  : '';
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 20;
const scope = scopeArg ? scopeArg.slice('--scope='.length) : (all ? 'all' : 'agreements');
const parserFilter = parserArg ? parserArg.slice('--parser='.length) : 'all';
const usecaseFilter = new Set(
  usecaseArg ? usecaseArg.slice('--usecase='.length).split(',').filter(Boolean) : [],
);
const listOnly = args.has('--list') || scope !== 'agreements';

const TARGET_WORDS = [
  '단체협약', '공동단체협약', '노사합의서', '노사 협약',
  '부속합의서', '보충협약', '업무협약서', '합의서',
];

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function collectManifestFiles(manifest) {
  if (!fs.existsSync(manifest)) {
    console.error(`manifest가 없습니다: ${manifest}`);
    process.exit(1);
  }
  const entries = fs.readFileSync(manifest, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  const seen = new Set();
  const files = [];
  for (const entry of entries) {
    const file = path.resolve(process.cwd(), entry);
    if (seen.has(file)) {
      console.error(`manifest 중복 경로입니다: ${entry}`);
      process.exit(1);
    }
    if (!file.startsWith(`${process.cwd()}${path.sep}`)) {
      console.error(`workspace 밖 경로입니다: ${entry}`);
      process.exit(1);
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error(`manifest 대상 파일이 없습니다: ${entry}`);
      process.exit(1);
    }
    seen.add(file);
    files.push(file);
  }
  return files;
}

function readMetadata(source) {
  const value = (key) => {
    const match = source.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'mu'));
    return match ? match[1].trim() : '';
  };
  return {
    convertedAt: value('converted_at'),
    parser: value('parser') || value('ocr_service'),
    scd: value('scd'),
  };
}

function pathCode(file) {
  for (const part of file.split(path.sep)) {
    const match = part.match(/^((?:B)?\d+(?:-[A-Z]\d+)?)_/u);
    if (match) return match[1];
  }
  return '';
}

function matchesScope(file, metadata) {
  if (MANIFEST) return true;
  if (scope === 'all') return true;
  if (scope === 'agreements') {
    return TARGET_WORDS.some((word) => path.basename(file).includes(word));
  }
  if (scope !== 'expanded') return false;

  const usecases = alioUsecases(metadata.scd || pathCode(file));
  if (!usecases.length) return false;
  return !usecaseFilter.size || usecases.some((usecase) => usecaseFilter.has(usecase));
}

function matchesDate(metadata) {
  if (!afterArg && !beforeArg) return true;
  if (!metadata.convertedAt) return false;
  const convertedAt = new Date(metadata.convertedAt);
  if (Number.isNaN(convertedAt.getTime())) return false;
  if (afterArg && convertedAt < new Date(afterArg.slice('--after='.length))) return false;
  if (beforeArg && convertedAt >= new Date(beforeArg.slice('--before='.length))) return false;
  return true;
}

function matchesParser(metadata) {
  if (parserFilter === 'all') return true;
  if (parserFilter === 'ocr') return /ocr/iu.test(metadata.parser);
  return metadata.parser === parserFilter;
}

function transformOnce(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const hasArticleHeading = lines.some((line) => /^#{1,6}\s+제\d+조(?:\s|\(|$)/u.test(line));
  const output = [];
  let inFence = false;
  let articleCount = 0;
  let itemCount = 0;
  let suspiciousCount = 0;

  for (const original of lines) {
    if (/^\s*```/.test(original)) {
      inFence = !inFence;
      output.push(original);
      continue;
    }
    if (inFence || /^\s*<!--/.test(original) || /^\s*\|/.test(original)) {
      output.push(original);
      continue;
    }

    if (/\S+\n?/.test(original) && /(?:^|\s)\S+\s+\S+/.test(original) && /[가-힣]\n?[가-힣]/.test(original)) {
      // OCR/spacing anomalies are reported, not guessed or rewritten.
      if (/\S\n\S/.test(original) || /\d\n\d/.test(original)) suspiciousCount += 1;
    }

    let normalized = original;
    const articleHeading = /^#{1,6}\s+제\d+조(?:\s|\(|$)/u.test(normalized);
    const articleStart = articleHeading || /^\s*제\d+조(?:\s|\(|$)/u.test(normalized);
    if (articleStart) articleCount += 1;

    // Split paragraph markers only when they are attached to an article line.
    if (articleStart && !articleHeading && !hasArticleHeading) {
      normalized = normalized.replace(/\)\s*([①②③④⑤⑥⑦⑧⑨⑩])/gu, ")\n$1");
      itemCount += (normalized.match(/\n(?=(?:\d{1,2}[.)]|[가-힣][.)]))/gu) || []).length;
    } else if (!hasArticleHeading && /^\s*(?:\d{1,2}[.)]|[가-힣][.)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(normalized)) {
      normalized = normalized.replace(/\s+(?=(?:\d{1,2}[.)]|[가-힣][.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*[가-힣])/gu, "\n");
      itemCount += (normalized.match(/\n(?=(?:\d{1,2}[.)]|[가-힣][.)]|[①②③④⑤⑥⑦⑧⑨⑩]))/gu) || []).length;
    }

    const chunks = normalized.split('\n');
    for (const chunk of chunks) {
      if (/^\s*제\d+조(?:\s|\(|$)/u.test(chunk) && output.length && !/^\s*$/u.test(output.at(-1))) {
        output.push('');
      }
      output.push(chunk);
    }
  }

  return {
    text: output.join(newline),
    articleCount,
    itemCount,
    suspiciousCount,
  };
}

function transform(source) {
  let current = source;
  let itemCount = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const result = transformOnce(current);
    itemCount += result.itemCount;
    if (result.text === current) return { ...result, itemCount };
    current = result.text;
  }
  throw new Error('허용된 구조 변환이 20회 안에 안정화되지 않았습니다.');
}

if (!MANIFEST && !fs.existsSync(ROOT)) {
  console.error(`대상 경로가 없습니다: ${ROOT}`);
  process.exit(1);
}

if (!['agreements', 'expanded', 'all'].includes(scope)) {
  console.error(`지원하지 않는 scope입니다: ${scope}`);
  process.exit(1);
}
if (!['all', 'ocr', 'kordoc', 'markitdown'].includes(parserFilter)) {
  console.error(`지원하지 않는 parser입니다: ${parserFilter}`);
  process.exit(1);
}
for (const dateArg of [afterArg, beforeArg].filter(Boolean)) {
  const date = dateArg.slice(dateArg.indexOf('=') + 1);
  if (!date || Number.isNaN(new Date(date).getTime())) {
    console.error(`올바르지 않은 날짜입니다: ${dateArg}`);
    process.exit(1);
  }
}
const invalidUsecases = [...usecaseFilter].filter((usecase) => !(usecase in USECASES) || usecase === '_shared');
if (invalidUsecases.length) {
  console.error(`지원하지 않는 usecase입니다: ${invalidUsecases.join(',')}`);
  process.exit(1);
}
if (!Number.isFinite(limit) || limit < 1) {
  console.error(`limit은 1 이상의 숫자여야 합니다: ${limitArg || ''}`);
  process.exit(1);
}
if (REPORT && !REPORT.startsWith(`${process.cwd()}${path.sep}`)) {
  console.error(`workspace 밖 report 경로입니다: ${REPORT}`);
  process.exit(1);
}

const candidates = [];
const sourceFiles = MANIFEST ? collectManifestFiles(MANIFEST) : collectFiles(ROOT);
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const metadata = readMetadata(source);
  if (!matchesScope(file, metadata)) continue;
  if (!matchesDate(metadata)) continue;
  if (!matchesParser(metadata)) continue;
  candidates.push({ file, source, metadata });
}
const files = candidates.slice(0, limit);
let changed = 0;
let articles = 0;
let items = 0;
let suspicious = 0;
const changedFiles = [];

for (const candidate of files) {
  const { file, source: before, metadata } = candidate;
  if (listOnly) {
    const code = metadata.scd || pathCode(file) || '-';
    const usecases = alioUsecases(code).join(',') || '-';
    if (!quiet) console.log(`LIST\t${path.relative(process.cwd(), file)}\tconverted_at=${metadata.convertedAt || '-'}\tparser=${metadata.parser || '-'}\tscd=${code}\tusecase=${usecases}`);
    continue;
  }
  const result = transform(before);
  articles += result.articleCount;
  items += result.itemCount;
  suspicious += result.suspiciousCount;
  if (result.text === before) continue;
  changed += 1;
  changedFiles.push(path.relative(process.cwd(), file));
  if (!quiet) console.log(`${write ? 'WRITE' : 'DRY'}\t${path.relative(process.cwd(), file)}\tarticles=${result.articleCount}\titems=${result.itemCount}\tsuspicious=${result.suspiciousCount}`);
  if (preview) console.log(result.text.split('\n').slice(0, 60).join('\n'));
  if (write) fs.writeFileSync(file, result.text);
}

if (REPORT) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, changedFiles.length ? `${changedFiles.join('\n')}\n` : '');
}
console.log(`SUMMARY\tmatched=${candidates.length}\tlisted=${files.length}\tchanged=${changed}\tarticles=${articles}\titems=${items}\tsuspicious=${suspicious}\tscope=${MANIFEST ? 'manifest' : scope}\tparser=${parserFilter}\tmode=${listOnly ? 'list' : (write ? 'write' : 'dry-run')}`);
