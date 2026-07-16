#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = new Set(process.argv.slice(2));
const inputArg = process.argv.find((arg) => arg.startsWith('--input='));
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const write = args.has('--write');
const INPUT = path.resolve(
  process.cwd(),
  inputArg ? inputArg.slice('--input='.length) : '2_data/logs/article_heading_gap_candidates_pre_20260701.jsonl',
);
const REPORT = path.resolve(
  process.cwd(),
  reportArg ? reportArg.slice('--report='.length) : '2_data/logs/article_heading_gap_repairs_pre_20260701.jsonl',
);
const ALIO_ROOT = path.resolve(process.cwd(), '2_data/alio-md/자료/기관별공시');
const AGREEMENT = /(?:단체협약|보충협약|현장협약|임금협약|노사협약)/u;
const COMPARISON = /(?:신구|대비표|대조표|개정\s*\(안\)|개정안|주요개정)/u;

if (!fs.existsSync(INPUT)) {
  console.error(`감사 로그가 없습니다: ${INPUT}`);
  process.exit(1);
}

// ⚠️ 승격 전제 = "제목만 있는 줄" (실감사 교훈: `제n조(제목) 본문...`을 그대로 ###로
//    승격하면 제목·본문이 한 줄에 붙어 Markdown 계층과 조문 파서가 깨진다 — 과거 945건 중
//    944건이 이 형태였고 전량 복구했다). 닫는 괄호 뒤에 아무것도 없어야 승격하고,
//    본문이 붙은 줄은 '분리 후보'로 리포트에만 기록한다(자동 수정 없음).
const TITLE_ONLY = /^제\s*\d+\s*조(?:의\s*\d+)?\s*\([^()]*\)\s*$/u;
const splitCandidates = [];
const candidates = fs.readFileSync(INPUT, 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map(JSON.parse)
  .filter((item) => {
    const basename = path.basename(item.path);
    const eligible = item.grade === 'A'
      && !item.excluded
      && AGREEMENT.test(basename)
      && !COMPARISON.test(basename)
      && /^제\s*\d+\s*조\s*\(/u.test(item.text);
    if (!eligible) return false;
    if (!TITLE_ONLY.test(item.text)) {
      splitCandidates.push({ ...item, action: 'title_body_split_candidate' });
      return false;
    }
    return true;
  });

const grouped = new Map();
for (const item of candidates) {
  const file = path.resolve(process.cwd(), item.path);
  if (!file.startsWith(`${ALIO_ROOT}${path.sep}`)) {
    console.error(`ALIO 공시 밖 경로입니다: ${item.path}`);
    process.exit(1);
  }
  const key = `${file}:${item.line}`;
  if (grouped.has(key)) {
    console.error(`중복 후보입니다: ${item.path}:${item.line}`);
    process.exit(1);
  }
  grouped.set(key, item);
}

const byFile = new Map();
for (const item of candidates) {
  if (!byFile.has(item.path)) byFile.set(item.path, []);
  byFile.get(item.path).push(item);
}

const applied = [];
const updates = [];
for (const [relative, items] of byFile) {
  const file = path.resolve(process.cwd(), relative);
  const source = fs.readFileSync(file, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  for (const item of items) {
    const index = item.line - 1;
    if (lines[index] !== item.text) {
      console.error(`감사 이후 원문이 달라졌습니다: ${relative}:${item.line}`);
      process.exit(1);
    }
    lines[index] = `### ${lines[index]}`;
    applied.push({ ...item, after: lines[index] });
  }
  updates.push({ file, text: lines.join(newline) });
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
const reportRows = [...applied, ...splitCandidates];
fs.writeFileSync(REPORT, reportRows.map((item) => JSON.stringify(item)).join('\n') + (reportRows.length ? '\n' : ''));
if (write) for (const update of updates) fs.writeFileSync(update.file, update.text);

console.log(
  `SUMMARY\tfiles=${updates.length}\trepairs=${applied.length}\tsplit_candidates=${splitCandidates.length}`
  + `\tmode=${write ? 'write' : 'dry-run'}\treport=${path.relative(process.cwd(), REPORT)}`,
);
