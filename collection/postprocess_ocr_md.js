#!/usr/bin/env node
'use strict';

// PaddleOCR md 후처리 정규화
// 대상: alio-md 내 <!-- ocr: paddleocr --> 포함 파일
// 규칙: 줄바꿈 병합(다중 패스) + 연속공백 정규화 + 1자 고립 노이즈 제거
// 사용: node collection/postprocess_ocr_md.js [--dry-run] [--verbose]
//        MD_ROOT=data/alio-md node collection/postprocess_ocr_md.js

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const MD_ROOT  = process.env.MD_ROOT || path.join(ROOT, 'data', 'alio-md');
const LOG_DIR  = path.join(path.dirname(MD_ROOT), 'logs');
const CKPT_PATH = path.join(LOG_DIR, 'postprocess_ocr_ckpt.json');
const LOG_PATH  = path.join(LOG_DIR, 'postprocess_ocr.log');
const DRY_RUN  = process.argv.includes('--dry-run');
const VERBOSE  = process.argv.includes('--verbose');

// ── 줄바꿈 병합 금지 패턴 ─────────────────────────────────────
// 이 패턴으로 시작하는 줄은 이전 줄과 절대 병합하지 않음
const NO_MERGE_NEXT_START = [
  /^\s*$/,                                          // 빈 줄
  /^\s*<!--/,                                        // HTML 주석 (page/source/ocr)
  /^\s*[0-9]+[.．\)）]/,                            // 번호 항목 (1. 2) ... 공백 불필요)
  /^\s*[·•○●]/,                                    // 글머리 기호
  /^\s*-/,                                           // 하이픈 항목 (-항목, -1~2급 모두 포함)
  /^\s*[o0O]\s*/,                                   // o항목, 0항목 (숫자0/영문o 혼용 포함)
  /^\s*[①-⑳㉑-㊿]/,                               // 원문자
  /^\s*제\s*\d/,                                    // 제N조/장/항/호
  /^\s*[가나다라마바사아자차카타파하]\.\s/,          // 가. 나. 다.
  /^\s*20\d{2}[년.]/,                               // 연도 (2024년, 2024.)
  /^\s*#{1,6}\s/,                                   // 마크다운 헤딩
  /^\s*\|/,                                          // 표 행
  /^\s*부\s*칙/,                                    // 부칙
  /^\s*[<\[]/,                                       // HTML 태그, 링크
];

// 이 패턴으로 끝나는 줄은 다음 줄과 병합하지 않음 (문장 종결)
const NO_MERGE_CUR_END = [
  /[.!?]\s*$/,                  // 문장 부호
  /[다함]\s*\.?\s*$/,           // 한다. 이다. 함. 등
  /니다\s*\.?\s*$/,             // 습니다. 합니다.
  /:\s*$/,                       // 콜론 (열거 예고)
  /。\s*$/,                      // 전각 마침표
];

function canMerge(cur, next) {
  if (!cur.trim() || !next.trim()) return false;
  if (NO_MERGE_NEXT_START.some(re => re.test(next))) return false;
  if (NO_MERGE_CUR_END.some(re => re.test(cur)))      return false;
  return true;
}

// ── 후처리 핵심 ───────────────────────────────────────────────
function postprocess(content) {
  const fmMatch = content.match(/^(---[\s\S]*?---\n\n?)/);
  const fm   = fmMatch ? fmMatch[1] : '';
  const body = content.slice(fm.length);

  const lines = body.split('\n');
  let stats = { merged: 0, removed: 0, spaces: 0 };

  // 1단계: 연속 공백 정규화 + 1자 고립 노이즈 제거
  const s1 = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0   ? lines[i - 1] : '';
    const next = i < lines.length - 1 ? lines[i + 1] : '';

    // 1자 고립 제거: 한글/영문/숫자 1자 AND 앞뒤 모두 빈 줄
    if (/^[가-힣A-Za-z0-9]$/.test(line.trim())
        && prev.trim() === '' && next.trim() === '') {
      stats.removed++;
      continue;
    }

    // 연속 공백 → 1칸 + 구두점 뒤 공백 (HTML 주석·표 줄 제외)
    if (!line.startsWith('<!--') && !line.trimStart().startsWith('|')) {
      let norm = line.replace(/([^\s]) {2,}([^\s])/g, '$1 $2');
      // 한글 쉼표/마침표 뒤 공백, 년+월 붙음 (lookahead로 연속 매칭 보장)
      norm = norm
        .replace(/([가-힣]),(?=[가-힣0-9])/g, '$1, ')
        .replace(/([가-힣])\.(?=[가-힣])/g, '$1. ')
        .replace(/(\d{4}년)(?=\d{1,2}월)/g, '$1 ');
      if (norm !== line) stats.spaces++;
      s1.push(norm);
    } else {
      s1.push(line);
    }
  }

  // 2단계: 줄바꿈 병합 (다중 패스, 수렴까지)
  let cur = s1;
  for (let pass = 0; pass < 5; pass++) {
    const next = [];
    let i = 0, mergedThisPass = 0;
    while (i < cur.length) {
      const line     = cur[i];
      const nextLine = i + 1 < cur.length ? cur[i + 1] : null;
      if (nextLine !== null && canMerge(line, nextLine)) {
        next.push(line.trimEnd() + ' ' + nextLine.trimStart());
        stats.merged++;
        mergedThisPass++;
        i += 2;
      } else {
        next.push(line);
        i++;
      }
    }
    cur = next;
    if (mergedThisPass === 0) break;
  }

  const changed = stats.merged > 0 || stats.removed > 0 || stats.spaces > 0;
  return { text: fm + cur.join('\n'), changed, stats };
}

// ── 체크포인트 ────────────────────────────────────────────────
function loadCkpt() {
  try {
    const d = JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
    return { done: new Set(d.done || []), stats: d.stats || {} };
  } catch {
    return { done: new Set(), stats: {} };
  }
}
function saveCkpt(done, stats) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(CKPT_PATH, JSON.stringify({ done: [...done], stats }, null, 2));
}

// ── 대상 파일 수집 ────────────────────────────────────────────
function collectTargets() {
  const r = spawnSync('grep', ['-rl', 'ocr: paddleocr', MD_ROOT],
                      { maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stdout.toString().trim().split('\n').filter(Boolean);
}

// ── 로그 ──────────────────────────────────────────────────────
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFd = fs.openSync(LOG_PATH, 'a');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.writeSync(logFd, line);
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  log('=== postprocess_ocr_md 시작' + (DRY_RUN ? ' [DRY RUN]' : '') + ' ===');
  log(`MD_ROOT: ${MD_ROOT}`);

  const { done } = loadCkpt();
  log(`체크포인트: ${done.size}건 이미 처리됨`);

  log('대상 파일 수집 중...');
  const targets = collectTargets();
  const pending = targets.filter(f => !done.has(f));
  log(`전체 ${targets.length}건, 미처리 ${pending.length}건`);

  const total = { changed: 0, merged: 0, removed: 0, spaces: 0, errors: 0 };
  let processed = 0;

  for (const fpath of pending) {
    try {
      const content = fs.readFileSync(fpath, 'utf8');
      const { text, changed, stats } = postprocess(content);

      if (changed) {
        total.changed++;
        total.merged  += stats.merged;
        total.removed += stats.removed;
        total.spaces  += stats.spaces;
        if (VERBOSE) log(`  변경: merged=${stats.merged} removed=${stats.removed} spaces=${stats.spaces} ${path.basename(fpath)}`);
        if (!DRY_RUN) fs.writeFileSync(fpath, text, 'utf8');
      }

      done.add(fpath);
      processed++;

      if (processed % 500 === 0) {
        log(`진행: ${processed}/${pending.length} (변경 ${total.changed}건)`);
        if (!DRY_RUN) saveCkpt(done, total);
      }
    } catch (e) {
      log(`ERROR: ${fpath} — ${e.message}`);
      total.errors++;
    }
  }

  if (!DRY_RUN) saveCkpt(done, total);
  log(`=== 완료: 처리 ${processed}건 / 변경 ${total.changed}건 / 병합줄 ${total.merged} / 삭제줄 ${total.removed} / 공백정규화 ${total.spaces} / 오류 ${total.errors} ===`);
  fs.closeSync(logFd);
}

main().catch(e => { console.error(e); process.exit(1); });
