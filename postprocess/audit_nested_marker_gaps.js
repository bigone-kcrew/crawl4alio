#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const beforeArg = process.argv.find((arg) => arg.startsWith('--before='));
const afterArg = process.argv.find((arg) => arg.startsWith('--after='));
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='));
const ROOT = path.resolve(
  process.cwd(),
  rootArg ? rootArg.slice('--root='.length) : '2_data/alio-md/자료/기관별공시',
);
const BEFORE = new Date(beforeArg ? beforeArg.slice('--before='.length) : '2026-07-01');
const AFTER = afterArg ? new Date(afterArg.slice('--after='.length)) : null;
const REPORT = path.resolve(
  process.cwd(),
  reportArg ? reportArg.slice('--report='.length) : '2_data/logs/nested_marker_gap_candidates_pre_20260701.jsonl',
);
const MANIFEST = manifestArg
  ? path.resolve(process.cwd(), manifestArg.slice('--manifest='.length))
  : '';
const AGREEMENT = /(?:단체협약|보충협약|현장협약|임금협약|노사협약)/u;
const EXCLUDED_DOCUMENT = /(?:규정|규칙|규약|정관|내규|법|시행령|시행규칙|기준|지침|요령|세칙|예규|강령|준칙|신구|대비표|대조표|개정\s*\(안\)|개정안|주요개정)/u;
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const KOREAN = '가나다라마바사아자차카타파하';

if (Number.isNaN(BEFORE.getTime())) {
  console.error(`잘못된 --before 날짜입니다: ${beforeArg || ''}`);
  process.exit(1);
}
if (AFTER && Number.isNaN(AFTER.getTime())) {
  console.error(`잘못된 --after 날짜입니다: ${afterArg || ''}`);
  process.exit(1);
}

function* markdownFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield file;
  }
}

function manifestFiles(manifest) {
  if (!fs.existsSync(manifest)) {
    console.error(`manifest가 없습니다: ${manifest}`);
    process.exit(1);
  }
  const entries = fs.readFileSync(manifest, 'utf8').split(/\r?\n/u).filter(Boolean);
  const seen = new Set();
  return entries.map((entry) => {
    const file = path.resolve(process.cwd(), entry);
    if (seen.has(file)) {
      console.error(`manifest 중복 경로입니다: ${entry}`);
      process.exit(1);
    }
    if (!file.startsWith(`${ROOT}${path.sep}`)) {
      console.error(`ALIO 공시 밖 경로입니다: ${entry}`);
      process.exit(1);
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error(`manifest 대상 파일이 없습니다: ${entry}`);
      process.exit(1);
    }
    seen.add(file);
    return file;
  });
}

function metadataDate(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(16384);
  const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
  const prefix = buffer.subarray(0, length).toString('utf8');
  const match = prefix.match(/^converted_at:\s*["']?([^"'\n]+)/mu);
  if (!match) return null;
  const value = new Date(match[1].trim());
  return Number.isNaN(value.getTime()) ? null : value;
}

function documentPath(file) {
  return path.relative(ROOT, file).split(path.sep).slice(3).join('/');
}

function isArticle(line) {
  return /^\s*(?:#{1,6}\s+)?제\s*\d+\s*조(?:\s|\(|$)/u.test(line);
}

function atLineStart(line, offset) {
  return /^\s*(?:[-*+]\s+)?$/u.test(line.slice(0, offset));
}

function tokensFor(lines, start, end, level) {
  const tokens = [];
  for (let line = start; line < end; line += 1) {
    const text = lines[line];
    if (/^\s*(?:\||<!--|```)/u.test(text)) continue;
    if (level === 'paragraph') {
      for (const match of text.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/gu)) {
        tokens.push({ line, offset: match.index, number: CIRCLED.indexOf(match[0]) + 1, suffix: '', marker: match[0], atStart: atLineStart(text, match.index) });
      }
    } else if (level === 'item') {
      for (const match of text.matchAll(/(?:^|\s)(\d{1,2})([.)])(?=\s*[가-힣A-Za-z“‘(\[])/gu)) {
        const offset = match.index + match[0].length - match[1].length - match[2].length;
        tokens.push({ line, offset, number: Number(match[1]), suffix: match[2], marker: `${match[1]}${match[2]}`, atStart: atLineStart(text, offset) });
      }
    } else {
      for (const match of text.matchAll(/(?:^|\s)([가나다라마바사아자차카타파하])([.)])(?=\s*[가-힣A-Za-z“‘(\[])/gu)) {
        const offset = match.index + match[0].length - 2;
        tokens.push({ line, offset, number: KOREAN.indexOf(match[1]) + 1, suffix: match[2], marker: `${match[1]}${match[2]}`, atStart: atLineStart(text, offset) });
      }
    }
  }
  return tokens;
}

function candidatesFor(lines, start, end, level) {
  const tokens = tokensFor(lines, start, end, level);
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (current.atStart) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const middle = previous && next
      && previous.atStart && next.atStart
      && previous.suffix === current.suffix && next.suffix === current.suffix
      && previous.number === current.number - 1 && next.number === current.number + 1;
    const firstOnArticle = current.number === 1
      && current.line === start && isArticle(lines[start])
      && next && next.atStart && next.number === 2 && next.suffix === current.suffix;
    if (!middle && !firstOnArticle) continue;
    candidates.push({
      level,
      line: current.line + 1,
      marker: current.marker,
      offset: current.offset,
      reason: middle ? '앞뒤 연속 표식은 줄 시작, 가운데 표식만 본문에 결합' : '조 제목에 첫 표식 결합, 다음 표식은 줄 시작',
      text: lines[current.line].trim(),
      previous: previous ? lines[previous.line].trim() : '',
      next: next ? lines[next.line].trim() : '',
    });
  }
  return candidates;
}

const candidates = [];
const files = new Set();
const sourceFiles = MANIFEST ? manifestFiles(MANIFEST) : markdownFiles(ROOT);
for (const file of sourceFiles) {
  const basename = path.basename(file);
  if (!MANIFEST) {
    if (!AGREEMENT.test(basename) || EXCLUDED_DOCUMENT.test(documentPath(file))) continue;
    const date = metadataDate(file);
    if (!date || date >= BEFORE || (AFTER && date < AFTER)) continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
  const articles = [];
  for (let index = 0; index < lines.length; index += 1) if (isArticle(lines[index])) articles.push(index);
  const sections = articles.length
    ? articles.map((start, position) => [start, articles[position + 1] ?? lines.length])
    : [[0, lines.length]];
  for (const [start, end] of sections) {
    for (const level of ['paragraph', 'item', 'subitem']) {
      for (const item of candidatesFor(lines, start, end, level)) {
        candidates.push({ path: path.relative(process.cwd(), file), ...item });
        files.add(file);
      }
    }
  }
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, candidates.map((item) => JSON.stringify(item)).join('\n') + (candidates.length ? '\n' : ''));
const counts = { paragraph: 0, item: 0, subitem: 0 };
for (const item of candidates) counts[item.level] += 1;
console.log(`SUMMARY\tfiles=${files.size}\tcandidates=${candidates.length}\tparagraph=${counts.paragraph}\titem=${counts.item}\tsubitem=${counts.subitem}\treport=${path.relative(process.cwd(), REPORT)}`);
