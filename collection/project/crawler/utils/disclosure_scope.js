const path = require('path');

const DEFAULT_ALLOWED_MINOR_CATEGORIES = ['노동조합', '인력관리', '보수관리', '복리후생'];

function normalizeCodeList(value) {
    if (Array.isArray(value)) {
        return value.map(String).map(code => code.trim()).filter(Boolean);
    }

    return String(value || '')
        .split(',')
        .map(code => code.trim())
        .filter(Boolean);
}

function sanitizeSegment(value) {
    return String(value || '').replace(/[\/:*?"<>|]/g, '_').trim();
}

function getInstitutionFolderName(inst) {
    const ministry = String(inst.ministry || '').replace(/[\[\]]/g, '');
    const name = sanitizeSegment(inst.name || 'UnknownInstitution');
    return `[${ministry}]${name}_${sanitizeSegment(inst.apba_id || 'UnknownCode')}`;
}

function buildCategoryScopedDisclosureLookup(items, allowedMinorCategories = DEFAULT_ALLOWED_MINOR_CATEGORIES) {
    const allowedSet = new Set(allowedMinorCategories);
    const itemByCode = {};
    const scopedCodes = new Set();

    for (const item of items) {
        const codes = normalizeCodeList(item.report_form_root_no);
        const scd = codes[0] || '';
        const record = {
            ...item,
            scd,
            report_nos: codes,
            codes,
            isScoped: allowedSet.has(item.minor_category)
        };

        for (const code of codes) {
            itemByCode[code] = record;
            if (record.isScoped) scopedCodes.add(code);
        }

        if (scd && record.isScoped) {
            itemByCode[scd] = record;
        }
    }

    return { itemByCode, scopedCodes };
}

function buildExplicitScopedDisclosureLookup(items, targetItems) {
    const itemByCode = {};
    const scopedCodes = new Set();
    const rawItemByCode = {};

    for (const item of items) {
        const codes = normalizeCodeList(item.report_form_root_no);
        for (const code of codes) {
            rawItemByCode[code] = item;
        }
    }

    for (const targetItem of Array.isArray(targetItems) ? targetItems : []) {
        const reportNos = normalizeCodeList(targetItem.report_nos || targetItem.report_form_root_no || targetItem.codes);
        const scd = String(targetItem.scd || reportNos[0] || '').trim();
        const matchedItem = reportNos.map(code => rawItemByCode[code]).find(Boolean) || rawItemByCode[scd] || null;
        const record = {
            ...(matchedItem || {}),
            scd,
            report_nos: reportNos,
            codes: reportNos,
            report_form_root_no: matchedItem?.report_form_root_no || scd,
            isScoped: true
        };

        if (scd) {
            itemByCode[scd] = record;
        }

        for (const code of reportNos) {
            itemByCode[code] = record;
            scopedCodes.add(code);
        }
    }

    return { itemByCode, scopedCodes };
}

// 전체 92개 공시항목을 모두 수집 대상으로 스코프
function buildFullDisclosureLookup(items) {
    const itemByCode = {};
    const scopedCodes = new Set();

    for (const item of items) {
        const codes = normalizeCodeList(item.report_form_root_no);
        const scd = codes[0] || '';
        const record = { ...item, scd, report_nos: codes, codes, isScoped: true };

        for (const code of codes) {
            itemByCode[code] = record;
            scopedCodes.add(code);
        }
        if (scd) itemByCode[scd] = record;
    }

    return { itemByCode, scopedCodes };
}

// CLI --items로 지정한 공시코드 목록만 스코프 (해당 항목의 분기 코드 전체 포함)
function buildItemScopedDisclosureLookup(items, requestedCodes) {
    const requested = new Set(normalizeCodeList(requestedCodes));
    const itemByCode = {};
    const scopedCodes = new Set();

    for (const item of items) {
        const codes = normalizeCodeList(item.report_form_root_no);
        const scd = codes[0] || '';
        const isScoped = codes.some(code => requested.has(code)) || requested.has(scd);
        const record = { ...item, scd, report_nos: codes, codes, isScoped };

        for (const code of codes) {
            itemByCode[code] = record;
            if (isScoped) scopedCodes.add(code);
        }
        if (scd && isScoped) itemByCode[scd] = record;
    }

    return { itemByCode, scopedCodes };
}

/**
 * 스코프 결정 우선순위: CLI 오버라이드 > yaml scope 키 > target_items > 기본 카테고리.
 * @param {object|string[]} scopeConfig crawl_targets.yaml 파싱 결과 또는 카테고리 배열
 * @param {object} [cliOverride] { scope: 'all'|'categories'|'items', categories: [], items: [] }
 */
function buildDisclosureLookup(items, scopeConfig = DEFAULT_ALLOWED_MINOR_CATEGORIES, cliOverride = null) {
    if (cliOverride) {
        if (cliOverride.scope === 'all') return buildFullDisclosureLookup(items);
        if (Array.isArray(cliOverride.items) && cliOverride.items.length) {
            return buildItemScopedDisclosureLookup(items, cliOverride.items);
        }
        if (Array.isArray(cliOverride.categories) && cliOverride.categories.length) {
            return buildCategoryScopedDisclosureLookup(items, cliOverride.categories);
        }
        if (cliOverride.scope === 'categories') {
            return buildCategoryScopedDisclosureLookup(items, DEFAULT_ALLOWED_MINOR_CATEGORIES);
        }
    }

    if (Array.isArray(scopeConfig)) {
        return buildCategoryScopedDisclosureLookup(items, scopeConfig);
    }

    if (scopeConfig && typeof scopeConfig === 'object') {
        const mode = String(scopeConfig.scope || '').trim();
        if (mode === 'all') return buildFullDisclosureLookup(items);
        if (mode === 'categories') {
            return buildCategoryScopedDisclosureLookup(items, scopeConfig.minor_categories || DEFAULT_ALLOWED_MINOR_CATEGORIES);
        }
        if (Array.isArray(scopeConfig.target_items)) {
            return buildExplicitScopedDisclosureLookup(items, scopeConfig.target_items);
        }
    }

    return buildCategoryScopedDisclosureLookup(items, DEFAULT_ALLOWED_MINOR_CATEGORIES);
}

function resolveDisclosureItem(reportFormRootNo, itemByCode) {
    const code = String(reportFormRootNo || '').trim();
    if (code && itemByCode[code]) return { code, item: itemByCode[code] };

    const fallbackCode = normalizeCodeList(reportFormRootNo)[0];
    if (fallbackCode && itemByCode[fallbackCode]) {
        return { code: fallbackCode, item: itemByCode[fallbackCode] };
    }

    return { code, item: null };
}

function getReportYear(report) {
    return String(report.year || report.critYyyy || report.disclosure_year || 'UnknownYear');
}

function buildStructuredPaths(baseDir, inst, report, item) {
    const institutionFolderName = getInstitutionFolderName(inst);
    const code = String(item?.scd || report?.scd || report?.report_form_root_no || '').trim();
    const itemName = sanitizeSegment(item?.minor_category || item?.item_name || 'UnknownItem');
    const scdFolderName = `${code}_${itemName}`;
    const yearFolderName = getReportYear(report);

    return {
        institutionFolderName,
        scdFolderName,
        yearFolderName,
        institutionDir: path.join(baseDir, institutionFolderName),
        scdDir: path.join(baseDir, institutionFolderName, scdFolderName),
        yearDir: path.join(baseDir, institutionFolderName, scdFolderName, yearFolderName)
    };
}

function extractMarkdownSections(markdown) {
    const text = String(markdown || '').trim();
    if (!text) {
        return { headings: [], tocEntries: [] };
    }

    const lines = text.split(/\r?\n/);
    const headings = [];
    const tocEntries = [];

    lines.forEach((line, index) => {
        const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (headingMatch) {
            headings.push({
                level: headingMatch[1].length,
                title: headingMatch[2].trim(),
                line: index + 1
            });
            return;
        }

        const tocMatch = line.match(/^\s*[\*\-]\s*\[(.+?)\]\(#toc-\d+/);
        if (tocMatch) {
            tocEntries.push({
                title: tocMatch[1].trim(),
                line: index + 1
            });
        }
    });

    return { headings, tocEntries };
}

function normalizeCrawl4AIResult(payload) {
    const root = payload?.data ?? payload ?? {};
    const result = Array.isArray(root.results) ? root.results[0] : root.results || root;
    const markdown = String(result?.markdown?.raw_markdown || result?.markdown || '').trim();
    const json = result?.json ?? result?.data ?? result?.content ?? null;
    const files = result?.downloaded_files || result?.files || [];

    return {
        root,
        result,
        json,
        markdown,
        files: Array.isArray(files) ? files : [],
        sections: extractMarkdownSections(markdown)
    };
}

function hasMeaningfulOutput(crawlResult) {
    const json = crawlResult?.json;
    const markdown = String(crawlResult?.markdown || '').trim();
    const files = Array.isArray(crawlResult?.files) ? crawlResult.files : [];

    const hasJson = json !== null && json !== undefined && (!(Array.isArray(json)) || json.length > 0) && (typeof json !== 'object' || Object.keys(json).length > 0);
    return hasJson || markdown.length > 0 || files.length > 0;
}

module.exports = {
    DEFAULT_ALLOWED_MINOR_CATEGORIES,
    buildDisclosureLookup,
    buildFullDisclosureLookup,
    buildItemScopedDisclosureLookup,
    buildStructuredPaths,
    extractMarkdownSections,
    getInstitutionFolderName,
    getReportYear,
    hasMeaningfulOutput,
    normalizeCodeList,
    normalizeCrawl4AIResult,
    resolveDisclosureItem,
    sanitizeSegment
};
