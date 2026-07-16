#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = new Set(process.argv.slice(2));
const inputArg = process.argv.find((arg) => arg.startsWith('--input='));
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const write = args.has('--write');
const articleFirstOnly = args.has('--article-first-only');
const INPUT = path.resolve(
  process.cwd(),
  inputArg ? inputArg.slice('--input='.length) : '2_data/logs/nested_marker_gap_candidates_pre_20260701.jsonl',
);
const REPORT = path.resolve(
  process.cwd(),
  reportArg ? reportArg.slice('--report='.length) : '2_data/logs/nested_marker_gap_repairs_pre_20260701.jsonl',
);
const ALIO_ROOT = path.resolve(process.cwd(), '2_data/alio-md/자료/기관별공시');

function selected(item) {
  if (item.level === 'paragraph') {
    if (!item.reason.startsWith('조 제목')) return true;
    return item.marker === '①'
      && /^(?:###\s+)?제\s*\d+\s*조/u.test(item.text);
  }
  if (item.level === 'item') {
    if (item.reason.startsWith('조 제목')) {
      return articleFirstOnly
        && item.marker === '1.'
        && /^(?:###\s+)?제\s*\d+\s*조/u.test(item.text);
    }
    return !item.reason.startsWith('조 제목')
      && !/^\d{1,2}[.)]\s+\d{1,2}[.)]/u.test(item.text);
  }
  return item.level === 'subitem' && !item.reason.startsWith('조 제목');
}

if (!fs.existsSync(INPUT)) {
  console.error(`감사 로그가 없습니다: ${INPUT}`);
  process.exit(1);
}

const candidates = fs.readFileSync(INPUT, 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map(JSON.parse)
  .filter((item) => selected(item)
    && (!articleFirstOnly || item.reason.startsWith('조 제목')));
const grouped = new Map();
for (const item of candidates) {
  const file = path.resolve(process.cwd(), item.path);
  if (!file.startsWith(`${ALIO_ROOT}${path.sep}`)) {
    console.error(`ALIO 공시 밖 경로입니다: ${item.path}`);
    process.exit(1);
  }
  const key = `${file}:${item.line}:${item.offset}`;
  if (grouped.has(key)) {
    console.error(`중복 후보입니다: ${item.path}:${item.line}:${item.offset}`);
    process.exit(1);
  }
  grouped.set(key, item);
}

const byFile = new Map();
for (const item of candidates) {
  if (!byFile.has(item.path)) byFile.set(item.path, []);
  byFile.get(item.path).push(item);
}

const updates = [];
for (const [relative, items] of byFile) {
  const file = path.resolve(process.cwd(), relative);
  const source = fs.readFileSync(file, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const byLine = new Map();
  for (const item of items) {
    const index = item.line - 1;
    if (lines[index].trim() !== item.text) {
      console.error(`감사 이후 원문이 달라졌습니다: ${relative}:${item.line}`);
      process.exit(1);
    }
    if (!byLine.has(index)) byLine.set(index, []);
    byLine.get(index).push(item);
  }
  for (const [index, lineItems] of byLine) {
    lineItems.sort((left, right) => right.offset - left.offset);
    for (const item of lineItems) {
      if (!lines[index].startsWith(item.marker, item.offset)) {
        console.error(`표식 위치가 달라졌습니다: ${relative}:${item.line}:${item.offset}`);
        process.exit(1);
      }
      lines[index] = `${lines[index].slice(0, item.offset)}${newline}${lines[index].slice(item.offset)}`;
    }
  }
  updates.push({ file, text: lines.join(newline) });
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, candidates.map((item) => JSON.stringify(item)).join('\n') + (candidates.length ? '\n' : ''));
if (write) for (const update of updates) fs.writeFileSync(update.file, update.text);

const counts = { paragraph: 0, item: 0, subitem: 0 };
for (const item of candidates) counts[item.level] += 1;
console.log(`SUMMARY\tfiles=${updates.length}\trepairs=${candidates.length}\tparagraph=${counts.paragraph}\titem=${counts.item}\tsubitem=${counts.subitem}\tmode=${write ? 'write' : 'dry-run'}\treport=${path.relative(process.cwd(), REPORT)}`);
