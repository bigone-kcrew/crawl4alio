const FIELD_RULES = {
    '노동조합': [
        { key: 'union_name', patterns: [/노동조합명/, /노조명/, /노동조합 이름/], exact: true },
        { key: 'established_date', patterns: [/설립일/, /설립연월일/] },
        { key: 'chairperson', patterns: [/위원장/, /대표자/] },
        { key: 'term', patterns: [/임기/] },
        { key: 'membership_scope', patterns: [/가입범위/] },
        { key: 'eligible_members', patterns: [/가입대상/, /대상인원/] },
        { key: 'members_count', patterns: [/조합원수/, /조합원 수/] },
        { key: 'bargaining_right', patterns: [/교섭권/] },
        { key: 'work_time_off', patterns: [/근로시간면제/] },
        { key: 'fulltime_officers', patterns: [/전임자수/, /전임자 수/] },
        { key: 'affiliated_union', patterns: [/상급단체/] }
    ],
    '인력관리': [
        { key: 'employee_total', patterns: [/임직원총계/, /임직원 수/, /임직원수/, /직원수/] },
        { key: 'executives', patterns: [/임원/, /기관장/, /이사/, /감사/] },
        { key: 'regular_employees', patterns: [/정규직/, /일반정규직/] },
        { key: 'contract_employees', patterns: [/무기계약직/, /계약직/] },
        { key: 'non_regular_employees', patterns: [/비정규직/] },
        { key: 'new_hires', patterns: [/신규채용/] },
        { key: 'retirements', patterns: [/퇴직/] },
        { key: 'disciplinary_actions', patterns: [/징계/] },
        { key: 'executive_status', patterns: [/임원현황/, /임원 현황/] },
        { key: 'gender_breakdown', patterns: [/여성현원/, /남성현원/, /남성/, /여성/] },
        { key: 'quota', patterns: [/정원/] },
        { key: 'current_headcount', patterns: [/현원/] }
    ],
    '보수관리': [
        { key: 'executive_salary', patterns: [/임원연봉/, /임원 보수/] },
        { key: 'employee_average_salary', patterns: [/직원 평균보수/, /직원평균보수/] },
        { key: 'base_salary', patterns: [/기본급/] },
        { key: 'fixed_allowance', patterns: [/고정수당/] },
        { key: 'performance_allowance', patterns: [/실적수당/] },
        { key: 'performance_bonus', patterns: [/성과상여금/] },
        { key: 'average_compensation_per_person', patterns: [/1인당 평균보수액/, /1인당 평균보수/] },
        { key: 'regular_employee_count', patterns: [/상시종업원수/] },
        { key: 'male', patterns: [/남성/, /남자/] },
        { key: 'female', patterns: [/여성/, /여자/] },
        { key: 'allowance_details', patterns: [/세부수당/] }
    ],
    '복리후생': [
        { key: 'welfare_cost', patterns: [/복리후생비/] },
        { key: 'welfare_system', patterns: [/복리후생제도/, /제도/, /운영현황/] },
        { key: 'support_basis', patterns: [/지원기준/] },
        { key: 'support_amount', patterns: [/금액/] },
        { key: 'support_target', patterns: [/대상/] },
        { key: 'usage_status', patterns: [/이용현황/, /이용실적/] },
        { key: 'remarks', patterns: [/비고/] }
    ]
};

function normalizeText(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function compactKey(value) {
    return normalizeText(value).replace(/[\s\(\)\[\]{}<>·,./\\\-_=|:]+/g, '');
}

function stripMarkdownLinks(value) {
    return normalizeText(value).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function parseTableRows(markdown) {
    const lines = String(markdown ?? '').split(/\r?\n/);
    const tables = [];
    let current = [];
    let lineStart = null;

    const flush = () => {
        if (current.length === 0) return;
        tables.push({ lineStart, rows: current });
        current = [];
        lineStart = null;
    };

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        const isTableLine = trimmed.includes('|') && !/^```/.test(trimmed);
        if (!isTableLine) {
            flush();
            return;
        }

        if (lineStart === null) lineStart = index + 1;
        const cells = trimmed
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(cell => stripMarkdownLinks(cell).trim());

        if (cells.some(Boolean)) current.push({ line: index + 1, cells });
    });

    flush();
    return tables;
}

function isLikelyValueCell(cell) {
    const text = normalizeText(cell);
    if (!text) return false;
    if (/^(해당(사항)?\s*없음|없음|있음|미공개|비공개|N\/A|NA|null)$/i.test(text)) return true;
    if (/^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/.test(text)) return true;
    if (/^\d+(?:\.\d+)?$/.test(text)) return true;
    if (/^\d{4}년(?:\s*\d{1,2}월)?(?:\s*\d{1,2}일)?$/.test(text)) return true;
    if (/^\d{1,2}:\d{2}$/.test(text)) return true;
    if (/^\d{4}\s*\/\s*\d{1,2}$/.test(text)) return true;
    if (/^\d{4}\s*년\s*\d{1,2}\s*\/\s*\d{1,2}\s*분기$/.test(text)) return true;
    if (/^[0-9]+(\.[0-9]+)?(명|원|%)$/.test(text)) return true;
    if (/^(남성|여성|남|여|합계|계|전일제|단시간|상임|비상임|정규직|무기계약직|비정규직)$/i.test(text)) return true;
    return false;
}

function joinLabelParts(parts) {
    return parts.map(part => normalizeText(part)).filter(Boolean).join(' / ');
}

function emitRecord(records, record) {
    const normalizedLabel = normalizeText(record.label || record.field_label || '');
    const normalizedValue = normalizeText(record.value);
    if (!normalizedLabel && !normalizedValue) return;

    records.push({
        label: normalizedLabel,
        value: normalizedValue,
        source_type: record.source_type,
        source_ref: record.source_ref,
        line: record.line ?? null,
        table_index: record.table_index ?? null,
        row_index: record.row_index ?? null,
        column_index: record.column_index ?? null,
        column_label: normalizeText(record.column_label || ''),
        headers: Array.isArray(record.headers) ? record.headers.map(normalizeText).filter(Boolean) : [],
        raw_cells: Array.isArray(record.raw_cells) ? record.raw_cells.map(normalizeText) : [],
        json_path: record.json_path || null
    });
}

function extractFromTable(table, tableIndex, records) {
    const rows = table.rows || [];
    const headerRow = rows.find(row => row.cells.length > 1 && !isSeparatorRow(row.cells));
    const headers = headerRow ? headerRow.cells.slice() : [];

    rows.forEach((row, rowIndex) => {
        const cells = row.cells.map(normalizeText);
        if (!cells.some(Boolean) || isSeparatorRow(cells)) return;
        if (headerRow && rowIndex === rows.indexOf(headerRow)) return;

        if (cells.length === 2) {
            emitRecord(records, {
                label: cells[0],
                value: cells[1],
                source_type: 'markdown_table',
                source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}`,
                line: row.line,
                table_index: tableIndex,
                row_index: rowIndex,
                raw_cells: cells
            });
            return;
        }

        if (headerRow && cells.length === headers.length) {
            cells.forEach((cell, columnIndex) => {
                emitRecord(records, {
                    label: headers[columnIndex],
                    value: cell,
                    source_type: 'markdown_table',
                    source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}:col:${columnIndex + 1}`,
                    line: row.line,
                    table_index: tableIndex,
                    row_index: rowIndex,
                    column_index: columnIndex,
                    column_label: headers[columnIndex],
                    headers,
                    raw_cells: cells
                });
            });
            return;
        }

        const firstValueIndex = cells.findIndex((cell, index) => index > 0 && isLikelyValueCell(cell));
        if (firstValueIndex > 0) {
            const labelParts = cells.slice(0, firstValueIndex);
            const valueCells = cells.slice(firstValueIndex);
            const valueHeaders = headers.length > 0 ? headers.slice(Math.max(0, headers.length - valueCells.length)) : [];

            if (valueHeaders.length >= valueCells.length && valueHeaders.length > 0) {
                valueCells.forEach((cell, idx) => {
                    emitRecord(records, {
                        label: joinLabelParts(labelParts) || headers[0] || `table_${tableIndex + 1}`,
                        value: cell,
                        source_type: 'markdown_table',
                        source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}:col:${idx + 1}`,
                        line: row.line,
                        table_index: tableIndex,
                        row_index: rowIndex,
                        column_index: idx,
                        column_label: valueHeaders[idx],
                        headers,
                        raw_cells: cells
                    });
                });
            }

            emitRecord(records, {
                label: joinLabelParts(labelParts),
                value: valueCells.join(' | '),
                source_type: 'markdown_table',
                source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}`,
                line: row.line,
                table_index: tableIndex,
                row_index: rowIndex,
                raw_cells: cells,
                headers
            });
            return;
        }

        if (cells.length % 2 === 0) {
            for (let i = 0; i < cells.length; i += 2) {
                emitRecord(records, {
                    label: cells[i],
                    value: cells[i + 1],
                    source_type: 'markdown_table',
                    source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}:pair:${(i / 2) + 1}`,
                    line: row.line,
                    table_index: tableIndex,
                    row_index: rowIndex,
                    column_index: i,
                    raw_cells: cells
                });
            }
            return;
        }

        emitRecord(records, {
            label: cells[0],
            value: cells.slice(1).join(' | '),
            source_type: 'markdown_table',
            source_ref: `table:${tableIndex + 1}:row:${rowIndex + 1}`,
            line: row.line,
            table_index: tableIndex,
            row_index: rowIndex,
            raw_cells: cells,
            headers
        });
    });
}

function extractMarkdownLinePairs(markdown, records) {
    const lines = String(markdown ?? '').split(/\r?\n/);
    lines.forEach((line, index) => {
        const trimmed = stripMarkdownLinks(line).trim();
        if (!trimmed || trimmed.includes('|')) return;

        const colonMatch = trimmed.match(/^(.+?)\s*[:：]\s*(.+)$/);
        if (colonMatch) {
            emitRecord(records, {
                label: colonMatch[1],
                value: colonMatch[2],
                source_type: 'markdown_line',
                source_ref: `line:${index + 1}`,
                line: index + 1
            });
            return;
        }

        const dashMatch = trimmed.match(/^(.+?)\s*-\s*(.+)$/);
        if (dashMatch && dashMatch[1].length <= 40) {
            emitRecord(records, {
                label: dashMatch[1],
                value: dashMatch[2],
                source_type: 'markdown_line',
                source_ref: `line:${index + 1}`,
                line: index + 1
            });
        }
    });
}

function flattenJson(value, pathParts, records, sourceType, sourceRefPrefix) {
    if (value === null || value === undefined) {
        emitRecord(records, {
            label: joinLabelParts(pathParts),
            value: '',
            source_type: sourceType,
            source_ref: sourceRefPrefix,
            json_path: pathParts.join('.')
        });
        return;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        emitRecord(records, {
            label: joinLabelParts(pathParts),
            value: value,
            source_type: sourceType,
            source_ref: sourceRefPrefix,
            json_path: pathParts.join('.')
        });
        return;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            emitRecord(records, {
                label: joinLabelParts(pathParts),
                value: '[]',
                source_type: sourceType,
                source_ref: sourceRefPrefix,
                json_path: pathParts.join('.')
            });
            return;
        }

        value.forEach((item, index) => {
            flattenJson(item, [...pathParts, String(index + 1)], records, sourceType, `${sourceRefPrefix}[${index}]`);
        });
        return;
    }

    Object.entries(value).forEach(([key, child]) => {
        flattenJson(child, [...pathParts, key], records, sourceType, sourceRefPrefix);
    });
}

function normalizeFieldKey(label) {
    const compact = compactKey(label);
    for (const [category, rules] of Object.entries(FIELD_RULES)) {
        for (const rule of rules) {
            if (rule.exact && rule.patterns.some(pattern => pattern.test(compact))) {
                return `${category}:${rule.key}`;
            }

            if (rule.patterns.some(pattern => pattern.test(compact))) {
                return `${category}:${rule.key}`;
            }
        }
    }

    return null;
}

function normalizeDetailFields(records, context) {
    const normalized = {};
    const grouped = new Map();

    for (const record of records) {
        const fieldKey = normalizeFieldKey(record.label);
        if (!fieldKey) continue;

        const existing = grouped.get(fieldKey) || [];
        existing.push(record);
        grouped.set(fieldKey, existing);
    }

    for (const [fieldKey, fieldRecords] of grouped.entries()) {
        const best = fieldRecords.find(record => normalizeText(record.value)) || fieldRecords[0];
        normalized[fieldKey] = {
            key: fieldKey,
            label: best?.label || '',
            value: best?.value ?? '',
            source_type: best?.source_type || null,
            source_ref: best?.source_ref || null,
            line: best?.line ?? null,
            table_index: best?.table_index ?? null,
            row_index: best?.row_index ?? null,
            column_index: best?.column_index ?? null,
            column_label: best?.column_label || '',
            json_path: best?.json_path || null,
            aliases: [...new Set(fieldRecords.map(record => record.label).filter(Boolean))],
            sources: fieldRecords.map(record => ({
                source_type: record.source_type,
                source_ref: record.source_ref,
                line: record.line ?? null,
                table_index: record.table_index ?? null,
                row_index: record.row_index ?? null,
                column_index: record.column_index ?? null,
                column_label: record.column_label || '',
                json_path: record.json_path || null,
                value: record.value
            }))
        };
    }

    return {
        schema_version: '1.0',
        generated_at: new Date().toISOString(),
        source: {
            url: normalizeText(context?.sourceUrl || ''),
            report_form_root_no: normalizeText(context?.report?.report_form_root_no || ''),
            disclosure_no: normalizeText(context?.report?.disclosure_no || ''),
            item_name: normalizeText(context?.item?.item_name || context?.item?.minor_category || '')
        },
        stats: {
            raw_field_count: records.length,
            normalized_field_count: Object.keys(normalized).length,
            markdown_table_count: context?.tableCount || 0,
            attachment_count: Array.isArray(context?.attachments) ? context.attachments.length : 0
        },
        provenance: {
            markdown_present: Boolean(normalizeText(context?.markdown || '')),
            raw_json_present: context?.rawJson !== null && context?.rawJson !== undefined,
            pdf_json_present: context?.pdfJson !== null && context?.pdfJson !== undefined,
            attachment_count: Array.isArray(context?.attachments) ? context.attachments.length : 0
        },
        raw_fields: records,
        normalized_fields: normalized
    };
}

function buildDetailFieldsExtraction({
    markdown = '',
    rawJson = null,
    pdfJson = null,
    attachments = [],
    sourceUrl = '',
    report = {},
    item = {},
    tableCount = 0
}) {
    const records = [];
    const tableBlocks = parseTableRows(markdown);

    tableBlocks.forEach((table, tableIndex) => {
        extractFromTable(table, tableIndex, records);
    });

    extractMarkdownLinePairs(markdown, records);

    if (rawJson !== null && rawJson !== undefined && !Array.isArray(rawJson) && typeof rawJson === 'object') {
        flattenJson(rawJson, ['raw_json'], records, 'page_json', 'raw_json');
    } else if (Array.isArray(rawJson)) {
        rawJson.forEach((entry, index) => {
            flattenJson(entry, ['raw_json', String(index + 1)], records, 'page_json', `raw_json[${index}]`);
        });
    }

    if (pdfJson !== null && pdfJson !== undefined) {
        flattenJson(pdfJson, ['pdf_json'], records, 'pdf_json', 'pdf_json');
    }

    return normalizeDetailFields(records, {
        markdown,
        rawJson,
        pdfJson,
        attachments,
        sourceUrl,
        report,
        item,
        tableCount: tableBlocks.length
    });
}

function collectDetailKeywords(detailFields) {
    if (!detailFields || typeof detailFields !== 'object') return [];

    const normalizedKeys = Object.keys(detailFields.normalized_fields || {});
    const labels = normalizedKeys.map(key => detailFields.normalized_fields[key]?.label).filter(Boolean);
    const aliases = normalizedKeys.flatMap(key => detailFields.normalized_fields[key]?.aliases || []);

    return [...new Set([...normalizedKeys, ...labels, ...aliases])];
}

module.exports = {
    buildDetailFieldsExtraction,
    collectDetailKeywords,
    compactKey,
    normalizeText,
    stripMarkdownLinks
};
