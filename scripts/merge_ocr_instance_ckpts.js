#!/usr/bin/env node
/**
 * OCR 인스턴스 체크포인트 → 메인 체크포인트 최종 병합
 *
 * 멀티 PC OCR은 --skip-main-merge로 돌므로(주기 저장 race 방지), 라운드 완주 후
 * 인스턴스별 성공을 메인(conversion_checkpoint.json)에 한 번에 반영해야 한다.
 * 안 하면 Stage 게이트류가 "아직 ocr_needed"로 오판한다.
 * (convert_ocr_needed는 처리할 게 없으면 병합 전에 종료하므로 빈 런으로는 병합되지 않음 — 이 스크립트가 그 자리)
 *
 * 하는 일:
 *   1) 각 인스턴스 ck(ocr_ck_<name>.json)의 success를
 *      - conversion_checkpoint.json: 해당 id status→success(+method/output)
 *      - ocr_checkpoint.json(통합): 엔트리 없으면 복사
 *   2) 원자적 저장(.t→rename) + 사전 백업
 *   3) 검증 리포트: 병합 건수, 남은 ocr_needed(=영구실패여야 정상)
 *
 * Usage: CATALOG_ROOT=/data node scripts/merge_ocr_instance_ckpts.js --instances pc1,pc2 [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CATALOG_ROOT = process.env.CATALOG_ROOT;
if (!CATALOG_ROOT) { console.error('CATALOG_ROOT 필요'); process.exit(1); }
const L = path.join(CATALOG_ROOT, 'logs');
const DRY = process.argv.includes('--dry-run');
const instArg = (process.argv.find(a => a.startsWith('--instances=')) || '').split('=')[1]
  || process.env.OCR_INSTANCES || '';
const INSTANCES = instArg.split(',').map(s => s.trim()).filter(Boolean);
if (!INSTANCES.length) { console.error('--instances=name1,name2 또는 OCR_INSTANCES 필요'); process.exit(1); }

const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const save = (p, o) => { fs.writeFileSync(p + '.t', JSON.stringify(o, null, 2)); fs.renameSync(p + '.t', p); };
const CCK = path.join(L, 'conversion_checkpoint.json');
const OCK = path.join(L, 'ocr_checkpoint.json');

const cck = rd(CCK); cck.files = cck.files || cck;
const ock = fs.existsSync(OCK) ? rd(OCK) : { files: {}, success: 0, failed: 0 };
ock.files = ock.files || ock;

let mergedC = 0, mergedO = 0, already = 0;
for (const name of INSTANCES) {
  const p = path.join(L, `ocr_ck_${name}.json`);
  if (!fs.existsSync(p)) { console.log(`⚠️ 인스턴스 ck 없음: ${p} — 건너뜀`); continue; }
  const ick = rd(p); const files = ick.files || ick;
  let c = 0, o = 0;
  for (const [id, v] of Object.entries(files)) {
    if (!v || v.status !== 'success') continue;
    const cv = cck.files[id];
    if (cv && cv.status !== 'success') {
      if (!DRY) Object.assign(cv, { status: 'success', method: v.method || v.parser || 'ocr', ...(v.output ? { output: v.output } : {}), processed_at: v.processed_at || new Date().toISOString() });
      c++;
    } else if (cv) already++;
    if (!ock.files[id]) { if (!DRY) ock.files[id] = v; o++; }
  }
  console.log(`[${name}] 메인 반영 ${c}건, 통합ck 신규 ${o}건`);
  mergedC += c; mergedO += o;
}

if (!DRY && (mergedC || mergedO)) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  fs.copyFileSync(CCK, CCK + '.bak_final_merge_' + ts);
  ock.success = Object.values(ock.files).filter(v => v && v.status === 'success').length;
  save(OCK, ock);
  save(CCK, cck);
  console.log(`백업: ${path.basename(CCK)}.bak_final_merge_${ts}`);
}

// 검증: 남은 ocr_needed = 영구실패분이어야 정상
let remain = 0, failNoted = 0;
const failedSomewhere = new Set();
for (const name of INSTANCES) {
  const p = path.join(L, `ocr_ck_${name}.json`);
  if (!fs.existsSync(p)) continue;
  for (const [id, v] of Object.entries(rd(p).files || {})) if (v && v.status === 'ocr_failed') failedSomewhere.add(id);
}
for (const [id, v] of Object.entries(cck.files)) {
  if (!v || v.status !== 'ocr_needed') continue;
  remain++;
  if (failedSomewhere.has(id)) failNoted++;
}
console.log(`${DRY ? '[DRY] ' : ''}병합: 메인 ${mergedC}건 · 통합 ${mergedO}건 (기병합 ${already})`);
console.log(`검증: 메인 잔여 ocr_needed ${remain}건 (그중 인스턴스 영구실패 ${failNoted}건${remain === failNoted ? ' — 전부 실패분, 정상 ✓' : ' — 차이 ' + (remain - failNoted) + '건은 미완료!'})`);
process.exit(remain === failNoted ? 0 : 2);
