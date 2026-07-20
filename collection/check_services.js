#!/usr/bin/env node
/**
 * 서비스·환경 진단 — 현재 환경에서 어떤 기능이 활성인지 출력
 *
 * 최소/풀스택 어느 프로필이든 설치 직후 이 스크립트로 상태를 확인한다.
 * AI 에이전트(Claude Code 등)가 설치를 도울 때의 1차 진단 명령이기도 하다.
 *
 * Usage: node collection/check_services.js
 * 종료코드: 0 (진단 자체는 항상 성공 — 기능별 가용성은 출력으로 판단)
 */
'use strict';

const path = require('path');
const parsers = require('./project/crawler/utils/parsers');

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235/crawl';
const PADDLEOCR_URL = process.env.PADDLEOCR_PARSE_URL || process.env.PADDLEOCR_URL || 'http://localhost:13430/parse';
const LAW_KEY = (process.env.OPENAPILAWKEY || process.env.LAW_OC || '').trim();

async function probe(url, timeoutMs = 5000) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return { reachable: true, status: res.status };
    } catch (err) {
        return { reachable: false, error: err.cause?.code || err.name };
    }
}

function mark(ok) { return ok ? '✅' : '❌'; }

async function main() {
    console.log('=== crawl4alio 서비스 진단 ===\n');

    // 1. Node 버전
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    console.log(`${mark(nodeMajor >= 18)} Node.js ${process.versions.node} (18+ 필요)`);

    // 2. kordoc (변환 핵심)
    const kordocMode = parsers.kordocMode();
    if (kordocMode === 'local') {
        const { VERSION } = require('kordoc');
        console.log(`✅ kordoc: 내장 npm v${VERSION} (in-process — 서버 불필요)`);
    } else if (kordocMode === 'http') {
        const health = await probe(parsers.KORDOC_HTTP_URL.replace(/\/parse$/, '/health'));
        console.log(`${mark(health.reachable)} kordoc: HTTP ${parsers.KORDOC_HTTP_URL} ${health.reachable ? '(도달 가능)' : `(도달 불가: ${health.error})`}`);
    } else {
        console.log('❌ kordoc: 사용 불가 — npm install을 실행하세요');
    }

    // 3. OCR 엔진 (스캔 PDF) — 기본 kordoc(4.2 --ocr 서버), legacy paddleocr
    const ocrEngine = (process.env.OCR_ENGINE || 'kordoc').trim().toLowerCase();
    const ocrUrl = process.env.OCR_PARSE_URL
        || (ocrEngine === 'kordoc' ? (process.env.KORDOC_PARSE_URL || process.env.KORDOC_URL || '') : PADDLEOCR_URL);
    if (ocrUrl) {
        const ocrHealth = await probe(ocrUrl.replace(/\/parse$/, '/health'));
        console.log(`${mark(ocrHealth.reachable)} OCR(${ocrEngine}): ${ocrUrl} ${ocrHealth.reachable ? '(도달 가능)' : `(도달 불가: ${ocrHealth.error})`}`);
    } else {
        const need = ocrEngine === 'kordoc' ? 'KORDOC_PARSE_URL' : 'PADDLEOCR_PARSE_URL';
        console.log(`⚠️  OCR(${ocrEngine}): 서버 URL 미설정 — ${need} 지정 필요(스캔본 OCR 시)`);
    }

    // 4. Crawl4AI (ALIO 본문 표)
    const crawlHealth = await probe(CRAWL4AI_URL.replace(/\/crawl$/, '/health'));
    const hasToken = Boolean((process.env.CRAWL4AI_API_TOKEN || '').trim());
    console.log(`${mark(crawlHealth.reachable)} Crawl4AI: ${CRAWL4AI_URL} ${crawlHealth.reachable ? `(도달 가능, 토큰 ${hasToken ? '설정됨' : '미설정'})` : `(도달 불가: ${crawlHealth.error})`}`);

    // 5. markitdown (선택 폴백)
    if (parsers.MARKITDOWN_HTTP_URL) {
        const mdHealth = await probe(parsers.MARKITDOWN_HTTP_URL.replace(/\/parse$/, '/health'));
        console.log(`${mark(mdHealth.reachable)} markitdown(선택): ${parsers.MARKITDOWN_HTTP_URL}`);
    } else {
        console.log('➖ markitdown(선택): 미설정 — kordoc이 pdf/xls(x)/docx까지 커버하므로 보통 불필요');
    }

    // 6. law.go.kr API 키
    console.log(`${mark(Boolean(LAW_KEY))} law.go.kr API 키(OPENAPILAWKEY/LAW_OC): ${LAW_KEY ? '설정됨' : '미설정 — https://open.law.go.kr 에서 발급'}`);

    // 7. python3 (ZIP 해제)
    const { spawnSync } = require('child_process');
    const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    console.log(`${mark(py.status === 0)} python3 (ZIP 해제용): ${py.status === 0 ? py.stdout.trim() || py.stderr.trim() : '미설치'}`);

    // 기능 매트릭스
    const kordocOk = kordocMode === 'local' || kordocMode === 'http';
    console.log('\n=== 활성 기능 ===');
    console.log(`${mark(true)} ALIO 첨부·법령·내규·통계 수집, 증분 동기화 감지 (외부 서비스 불필요)`);
    console.log(`${mark(Boolean(LAW_KEY))} 법령 corpus 수집·개정 감지 (API 키)`);
    console.log(`${mark(kordocOk)} HWP/PDF/DOCX/XLS(X) → Markdown 변환`);
    console.log(`${mark(ocrHealth.reachable)} 스캔 PDF OCR ${ocrHealth.reachable ? '' : '(미가용 시 ocr_needed 큐에 대기 — 나중에 처리 가능)'}`);
    console.log(`${mark(crawlHealth.reachable)} ALIO 공시 본문 표 수집 ${crawlHealth.reachable ? '' : '(미가용 시 해당 공시 스킵)'}`);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
