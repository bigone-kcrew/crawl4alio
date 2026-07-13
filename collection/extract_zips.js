#!/usr/bin/env node
/**
 * ZIP 첨부파일 일괄 압축 해제
 *
 * 지정 루트 아래의 모든 .zip을 찾아 같은 위치의 동명 폴더(확장자 제거)로 해제한다.
 * 한글 파일명(CP437→CP949) 처리를 위해 collection/extract_zip.py(python3)를 사용.
 *
 * 해제 후 build_download_file_index.js를 재실행하면 ZIP 내부의 변환 대상
 * 파일(hwp/pdf/xlsx 등)이 다운로드 인덱스에 자동 포함되어
 * convert_to_markdown.js 파이프라인을 그대로 탄다.
 *
 * Usage:
 *   node collection/extract_zips.js                          # 기본: data/structured_data
 *   node collection/extract_zips.js --root data/institution-bylaws-raw
 *   node collection/extract_zips.js --dry                    # 대상 목록만
 *   node collection/extract_zips.js --force                  # 기존 해제 폴더 있어도 재해제
 */
'use strict';

const fs = require('fs');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ROOT = path.resolve(opt('--root', fromCatalogRoot('structured_data')));
const DRY = flag('--dry');
const FORCE = flag('--force');
const KEEP_ZIP = flag('--keep-zip'); // 기본: 해제 성공 후 원본 ZIP 삭제
const PY_EXTRACTOR = path.join(__dirname, 'extract_zip.py');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith('.zip')) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(ROOT)) { console.error('루트 없음:', ROOT); process.exit(1); }

  const zips = walk(ROOT);
  console.log(`[ROOT] ${ROOT}\nZIP 파일: ${zips.length}건${DRY ? ' (DRY)' : ''}${FORCE ? ' (FORCE)' : ''}`);

  const stat = { extracted: 0, skipped: 0, failed: 0 };
  for (const zipPath of zips) {
    const extractDir = zipPath.replace(/\.zip$/i, '');
    if (!FORCE && fs.existsSync(extractDir)) {
      // 이미 해제됨 — ZIP 원본 정리
      if (!KEEP_ZIP && !DRY && fs.existsSync(zipPath)) {
        try { fs.unlinkSync(zipPath); } catch {}
      }
      stat.skipped++;
      continue;
    }

    const rel = path.relative(ROOT, zipPath);
    if (DRY) { console.log(`  [DRY] ${rel}`); stat.extracted++; continue; }

    const run = spawnSync('python3', [PY_EXTRACTOR, zipPath, extractDir], { encoding: 'utf8' });
    if (run.status === 0) {
      const count = fs.existsSync(extractDir) ? fs.readdirSync(extractDir).length : 0;
      if (!KEEP_ZIP) {
        try { fs.unlinkSync(zipPath); } catch {}
      }
      console.log(`  ✅ ${rel} → ${count}개 항목${KEEP_ZIP ? '' : ' (zip 삭제)'}`);
      stat.extracted++;
    } else {
      console.log(`  ❌ ${rel}: ${(run.stdout || run.stderr || '').trim().slice(0, 120)}`);
      stat.failed++;
    }
  }

  console.log(`\n완료 — 해제 ${stat.extracted} · 스킵(기존) ${stat.skipped} · 실패 ${stat.failed}`);
  if (!DRY && stat.extracted > 0) {
    console.log('다음 단계: node collection/build_download_file_index.js  # ZIP 내부 파일 인덱스 반영');
  }
}

main();
