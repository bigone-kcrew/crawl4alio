#!/usr/bin/env node
/**
 * 활용처(use-case) 교차 코퍼스 분류 뷰 — 비파괴적 심링크 + 태그 매니페스트
 *
 * 3개 코퍼스(alio 공시 / 내규 / 법령)를 활용처별로 교차 분류한다. 원본은 그대로 두고
 * 활용처별 심링크 트리(자료/활용처뷰/<활용처>/<코퍼스>/...)와 usecase_index.json을 만든다.
 * RAG는 이 태그로 교차 코퍼스 필터(예: 감사대응 = alio감사 + 내규 감사규정 + 법령 감사원법).
 *
 *  - alio: 공시코드 → 활용처 (정확 매핑)
 *  - 내규: 규정명 키워드 → 활용처[] (다중 가능)
 *  - 법령: 법령명 키워드 → 활용처[] (매칭) / 미매칭은 공유참조(_shared, 전 활용처 참조)
 *
 * Usage: node 1_collection/classify_usecase.js [--dry-run] [--rebuild]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MDROOT = '/workspace/alio/2_data/alio-md';
const VIEW = '/workspace/alio/2_data/_usecase/활용처뷰';  // 배포 밖 — 교차코퍼스 심링크는 6종 단독배포에 미포함
const MANIFEST = '/workspace/alio/2_data/_usecase/usecase_index.json';  // 배포 밖(RAG/통합검색용)

const ALIO_BASE = path.join(MDROOT, '자료/기관별공시');
const BYLAWS_BASE = '/workspace/alio/2_data/institution-bylaws-md';
const LEGAL_BASE = '/workspace/alio/2_data/legal-md/법령자료';

const USECASES = {
    recruit: '01_채용정보', audit: '02_감사대응징계', governance: '03_거버넌스국민감시',
    labor: '04_노사관계', finance: '05_재무보수경영', _shared: '00_공유법령참조',
};

// ── alio 공시코드 → 활용처 ──
const CODE_MAP = {
    B1020: ['recruit'], B1010: ['recruit'], '20401': ['recruit'], '20601': ['recruit'], '20201': ['recruit'],
    '32301': ['audit'], '43006': ['audit'], '32311': ['audit'], B1220: ['audit'],
    '21301': ['audit'], '21302': ['audit'], '21311': ['audit'], '21312': ['audit'], '21201': ['audit'], '21211': ['audit'],
    B1210: ['governance'], '43005': ['governance'], '43009': ['governance'],
    '42605': ['governance'], '42703': ['governance'], '42704': ['governance'], B1230: ['governance'], B1250: ['governance'], '40211': ['governance'],
    '21021': ['labor'], '21025': ['labor'], '21026': ['labor'], '21027': ['labor'], '21028': ['labor'],
    '63795': ['labor'], '63796': ['labor'], '63787': ['labor'],
    '31201': ['finance'], '31203': ['finance'], '31301': ['finance'], '31303': ['finance'], '31401': ['finance'],
    '31801': ['finance'], '31803': ['finance'], '63601': ['finance'], '20501': ['finance'], '20801': ['finance'],
    '63701': ['finance'], '32101': ['finance'], '32135': ['finance'], '20305': ['finance'], '20905': ['finance'], '21801': ['finance'], '31921': ['finance'],
    '80202': ['recruit'], '21401': ['recruit'], B1280: ['finance'], '20701': ['governance'],
};
function alioUsecases(code) { return CODE_MAP[code] || CODE_MAP[code.slice(0, 5)] || []; }

// ── 규정/법령명 키워드 → 활용처 ──
const KEYWORD_MAP = [
    ['audit', ['감사', '청렴', '윤리', '행동강령', '제보', '신고', '부패', '이해충돌', '징계', '비위']],
    ['governance', ['이사회', '정관', '임원', '적극행정', '지배구조', '경영공시', '내부통제']],
    ['recruit', ['채용', '임용', '인사규정', '인사관리', '복무', '인재', '전형']],
    ['labor', ['취업규칙', '단체협약', '노동조합', '노사', '근로', '노동관계', '최저임금']],
    ['finance', ['보수', '급여', '수당', '복리후생', '회계', '예산', '계약', '수의계약', '입찰', '자금', '카드', '업무추진', '재무', '결산', '국가재정']],
];
function keywordUsecases(name) {
    const ucs = new Set();
    for (const [uc, kws] of KEYWORD_MAP) if (kws.some(k => name.includes(k))) ucs.add(uc);
    return [...ucs];
}

// ── 역할(role) → 분류 원자 매핑 (2026-07-13 확정: 조직 직무 12종 + 대외 이용자 2종) ──
// role은 usecase보다 세밀한 원자({usecases, alioCodes, bylawGroups})로 정의한다 —
// 내규 그룹(safety·security·travel·contract 등)은 usecase 5종 밖이라 usecase 매핑만으론 누락되기 때문.
// 소속 판정: usecase 교집합 ∪ alio 공시코드 ∪ 내규 그룹(다중). _shared 법령은 전 역할 공통 포함.
const { bylawGroupsFor } = require('./_bylaw_groups_data.js');
const ROLES = {
    union:     { label: '노조·근로자대표', type: 'internal', usecases: ['labor'], alioCodes: [], bylawGroups: ['union'] },
    hr:        { label: '인사담당', type: 'internal', usecases: ['recruit'], alioCodes: [], bylawGroups: ['hr', 'attend', 'edu'] },
    pay:       { label: '보수·급여담당', type: 'internal', usecases: [], alioCodes: ['20501', '20601', '20701'], bylawGroups: ['pay'] },
    welfare:   { label: '총무·복리후생', type: 'internal', usecases: [], alioCodes: ['20801', '63701', 'B1280'], bylawGroups: ['welfare', 'travel', 'org'] },
    account:   { label: '회계·재무담당', type: 'internal', usecases: [], alioCodes: ['31201', '31203', '31301', '31303', '31401', '31801', '31803', '32101', '32135', '63601', '31921'], bylawGroups: ['account'] },
    contract:  { label: '계약·구매담당', type: 'internal', usecases: [], alioCodes: [], bylawGroups: ['contract'] },
    audit:     { label: '감사·윤리담당', type: 'internal', usecases: ['audit'], alioCodes: [], bylawGroups: ['audit', 'disc'] },
    planning:  { label: '기획·경영평가담당', type: 'internal', usecases: [], alioCodes: ['B1230', '42605', '42703', '42704', '43005', '43009', '40211'], bylawGroups: [] },
    assembly:  { label: '대외협력·국회대응', type: 'internal', usecases: [], alioCodes: ['B1210'], bylawGroups: [] },
    safety:    { label: '안전보건담당', type: 'internal', usecases: [], alioCodes: [], bylawGroups: ['safety'] },
    security:  { label: '정보보안·개인정보담당', type: 'internal', usecases: [], alioCodes: [], bylawGroups: ['security'] },
    board:     { label: '임원·이사회', type: 'internal', usecases: [], alioCodes: ['32311', '40211', '43005'], bylawGroups: ['board'] },
    // 대외 이용자(공개 서비스 대상) — 채용정보 제공·국민감시·이직 의사결정
    jobseeker: { label: '구직자·취업준비생', type: 'public', usecases: ['recruit'], alioCodes: ['20601', '20801', '63701'], bylawGroups: [] },
    watchdog:  { label: '시민감시·언론', type: 'public', usecases: ['governance'], alioCodes: ['B1220', '32301'], bylawGroups: [] },
    transfer:  { label: '이직희망 임직원', type: 'public', usecases: ['recruit'], alioCodes: ['20201', '20501', '20601', '20701', '20801', '63701', 'B1280', 'B1230', '21026'], bylawGroups: [] },
};
function itemRoles(item) {
    const roles = [];
    const shared = (item.usecases || []).includes('_shared');
    const gids = item.corpus === '내규' ? bylawGroupsFor(item.key) : [];
    for (const [rid, r] of Object.entries(ROLES)) {
        if (shared
            || r.usecases.some(u => (item.usecases || []).includes(u))
            || (item.corpus === 'alio' && r.alioCodes.includes(item.key))
            || (gids.length && r.bylawGroups.some(g => gids.includes(g)))) roles.push(rid);
    }
    return roles;
}

function walkMdFiles(base, out = []) {
    if (!fs.existsSync(base)) return out;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        const full = path.join(base, e.name);
        if (e.isDirectory()) walkMdFiles(full, out);
        else if (e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'content.md') out.push(full);
    }
    return out;
}

function link(uc, corpusLabel, name, target, dry, counters) {
    counters.stat[uc] = (counters.stat[uc] || 0) + 1;
    if (dry) return;
    const dir = path.join(VIEW, USECASES[uc], corpusLabel);
    fs.mkdirSync(dir, { recursive: true });
    const lp = path.join(dir, name);
    if (!fs.existsSync(lp)) { try { fs.symlinkSync(target, lp); counters.linked++; } catch { /* skip */ } }
}

function main() {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry-run'), rebuild = args.includes('--rebuild');
    if (rebuild && fs.existsSync(VIEW) && !dry) fs.rmSync(VIEW, { recursive: true, force: true });

    const manifest = {};
    const counters = { stat: {}, linked: 0 };
    const unmapped = {};

    // ① alio 공시 (기관/[code]_[cat] 폴더)
    if (fs.existsSync(ALIO_BASE)) for (const inst of fs.readdirSync(ALIO_BASE)) {
        const ip = path.join(ALIO_BASE, inst);
        if (!fs.statSync(ip).isDirectory()) continue;
        for (const sub of fs.readdirSync(ip)) {
            const sp = path.join(ip, sub);
            if (!fs.statSync(sp).isDirectory()) continue;
            const code = sub.split('_')[0];
            const ucs = alioUsecases(code);
            if (!ucs.length) { unmapped[code] = (unmapped[code] || 0) + 1; continue; }
            const entry = { corpus: 'alio', key: code, usecases: ucs };
            entry.roles = itemRoles(entry);
            manifest['alio/' + path.join(inst, sub)] = entry;
            ucs.forEach(uc => link(uc, 'alio', `${inst}__${sub}`, sp, dry, counters));
        }
    }

    // ② 내규 (규정명 키워드)
    let bylawsMapped = 0;
    for (const f of walkMdFiles(BYLAWS_BASE)) {
        const name = path.basename(f);
        const ucs = keywordUsecases(name);
        // 역할 매핑은 usecase 미매칭이라도 내규 그룹(safety 등 usecase 밖 그룹)으로 소속될 수 있음
        const entry = { corpus: '내규', key: name, usecases: ucs };
        entry.roles = itemRoles(entry);
        if (!ucs.length && !entry.roles.length) continue;
        if (ucs.length) bylawsMapped++;
        manifest['내규/' + path.relative(BYLAWS_BASE, f)] = entry;
        ucs.forEach(uc => link(uc, '내규', name, f, dry, counters));
    }

    // ③ 법령 (키워드 매칭 → 활용처, 미매칭 → 공유참조 _shared)
    let legalMatched = 0, legalShared = 0;
    for (const f of walkMdFiles(LEGAL_BASE)) {
        const name = path.basename(f);
        let ucs = keywordUsecases(name);
        if (!ucs.length) { ucs = ['_shared']; legalShared++; } else legalMatched++;
        const entry = { corpus: '법령', key: name, usecases: ucs };
        entry.roles = itemRoles(entry);
        manifest['법령/' + path.relative(LEGAL_BASE, f)] = entry;
        ucs.forEach(uc => link(uc, '법령', name, f, dry, counters));
    }

    if (!dry) { fs.mkdirSync(path.dirname(MANIFEST), { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify({ generated_at: new Date().toISOString(), usecases: USECASES, roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, type: r.type }])), items: manifest }, null, 2)); }

    console.log('활용처 교차분류' + (dry ? ' [DRY]' : '') + ':');
    for (const [uc, nm] of Object.entries(USECASES)) console.log(`  ${nm}: ${counters.stat[uc] || 0}`);
    console.log(`  총 매핑: ${Object.keys(manifest).length} | 심링크: ${counters.linked}`);
    console.log(`  내규 매핑 ${bylawsMapped} | 법령 매칭 ${legalMatched}/공유참조 ${legalShared}`);
    const roleCnt = {};
    for (const it of Object.values(manifest)) for (const rid of (it.roles || [])) roleCnt[rid] = (roleCnt[rid] || 0) + 1;
    console.log('  역할별 소속: ' + Object.entries(ROLES).map(([rid, r]) => `${r.label} ${roleCnt[rid] || 0}`).join(' | '));
    const um = Object.entries(unmapped).sort((a, b) => b[1] - a[1]);
    if (um.length) console.log(`  alio 미매핑(${um.length}종): ` + um.slice(0, 15).map(([c, n]) => `${c}:${n}`).join(', '));
    if (!dry) console.log(`  뷰: ${VIEW}\n  매니페스트: ${MANIFEST}`);
}

if (require.main === module) main();
// RAG 적재(3_rag/backfill_usecase.js)·역할 패키지 생성기에서 매핑 재사용 — 활용처/역할 정의의 단일 출처
module.exports = { USECASES, ROLES, alioUsecases, keywordUsecases, itemRoles };
