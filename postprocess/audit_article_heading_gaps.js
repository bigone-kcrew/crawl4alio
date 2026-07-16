#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const beforeArg = process.argv.find((arg) => arg.startsWith('--before='));
const afterArg = process.argv.find((arg) => arg.startsWith('--after='));
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const ROOT = path.resolve(
  process.cwd(),
  rootArg ? rootArg.slice('--root='.length) : '2_data/alio-md/자료/기관별공시',
);
const BEFORE = new Date(beforeArg ? beforeArg.slice('--before='.length) : '2026-07-01');
const AFTER = afterArg ? new Date(afterArg.slice('--after='.length)) : null;
const REPORT = reportArg
  ? path.resolve(process.cwd(), reportArg.slice('--report='.length))
  : '';
const EXCLUDED_DOCUMENT = /(?:규정|규칙|규약|정관|내규|법|시행령|시행규칙|기준|지침|요령|세칙|예규|강령|준칙|신구조문)/u;

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

function convertedAt(file) {
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
  const parts = path.relative(ROOT, file).split(path.sep);
  return parts.slice(3).join('/');
}

function articleHeading(line) {
  const match = line.match(/^\s*#{1,6}\s+제\s*(\d+)\s*조(?:\s|\(|$)/u);
  return match ? Number(match[1]) : null;
}

function plainArticle(line) {
  if (/^\s*(?:#|\||<!--|```)/u.test(line)) return null;
  const match = line.match(/^\s*제\s*(\d+)\s*조(?:\s|\(|$)/u);
  return match ? Number(match[1]) : null;
}

function embeddedArticles(line) {
  if (/^\s*(?:\||<!--|```)/u.test(line)) return [];
  return [...line.matchAll(/제\s*(\d+)\s*조\s*\([^)]{1,100}\)/gu)]
    .map((match) => Number(match[1]));
}

const summary = {
  scannedMarkdown: 0,
  beforeDate: 0,
  headingGaps: 0,
  gradeA: 0,
  gradeAExcluded: 0,
  gradeB: 0,
};
const candidates = [];

for (const file of markdownFiles(ROOT)) {
  summary.scannedMarkdown += 1;
  const date = convertedAt(file);
  if (!date || date >= BEFORE || (AFTER && date < AFTER)) continue;
  summary.beforeDate += 1;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const number = articleHeading(lines[index]);
    if (number !== null) headings.push({ index, number, text: lines[index].trim() });
  }

  for (let position = 1; position < headings.length; position += 1) {
    const previous = headings[position - 1];
    const next = headings[position];
    if (next.number <= previous.number + 1 || next.number - previous.number > 100) continue;
    summary.headingGaps += 1;

    for (let index = previous.index + 1; index < next.index; index += 1) {
      const plain = plainArticle(lines[index]);
      const embedded = embeddedArticles(lines[index]);
      const missing = plain !== null
        ? [plain]
        : embedded;
      for (const number of missing) {
        if (number <= previous.number || number >= next.number) continue;
        const grade = plain === number ? 'A' : 'B';
        const excluded = EXCLUDED_DOCUMENT.test(documentPath(file));
        summary[grade === 'A' ? 'gradeA' : 'gradeB'] += 1;
        if (grade === 'A' && excluded) summary.gradeAExcluded += 1;
        candidates.push({
          grade,
          excluded,
          path: path.relative(process.cwd(), file),
          line: index + 1,
          missing: number,
          previous: previous.text,
          next: next.text,
          text: lines[index].trim(),
        });
      }
    }
  }
}

summary.candidateFiles = new Set(candidates.map((item) => item.path)).size;
summary.gradeAEligible = candidates.filter((item) => item.grade === 'A' && !item.excluded).length;
summary.gradeAEligibleFiles = new Set(
  candidates.filter((item) => item.grade === 'A' && !item.excluded).map((item) => item.path),
).size;

if (REPORT) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(
    REPORT,
    candidates.map((item) => JSON.stringify(item)).join('\n') + (candidates.length ? '\n' : ''),
  );
  console.log(JSON.stringify({ summary, report: path.relative(process.cwd(), REPORT) }, null, 2));
} else {
  console.log(JSON.stringify({ summary, candidates }, null, 2));
}
