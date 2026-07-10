const fs = require('fs');
const path = require('path');
const { buildDisclosureLookup, normalizeCodeList } = require('./disclosure_scope');

const INDEX_FILE_NAME = 'index.json';
const LATEST_INDEX_FILE_NAME = 'latest_index.json';
const DOWNLOAD_FILE_INDEX_FILE_NAME = 'download_files_index.json';
const DOWNLOAD_FILE_INDEX_CSV_FILE_NAME = 'download_files_index.csv';
const MANIFEST_FILE_NAME = 'manifest.json';

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null; // 동시 쓰기 중 부분 파일 등 파싱 실패 시 안전 폴백
    }
}

function uniq(values) {
    return [...new Set(values.filter(Boolean))];
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeCodeArray(value) {
    return normalizeCodeList(value).map(code => normalizeText(code)).filter(Boolean);
}

function pickCodeArray(...values) {
    for (const value of values) {
        const codes = normalizeCodeArray(value);
        if (codes.length > 0) return codes;
    }
    return [];
}

function normalizeNumericText(value) {
    const text = normalizeText(value);
    return text ? text.replace(/\D/g, '') : '';
}

function parseComparableNumber(value) {
    const text = normalizeNumericText(value);
    if (!text) return 0n;

    try {
        return BigInt(text);
    } catch (err) {
        return 0n;
    }
}

function parsePeriodRank(report) {
    const quarter = parseComparableNumber(report?.quarter);
    if (quarter > 0n) return quarter;

    const periodLabel = normalizeText(report?.period_label);
    const labelMatch = periodLabel.match(/(\d+)/);
    if (labelMatch) {
        return parseComparableNumber(labelMatch[1]);
    }

    return 0n;
}

function summarizeMarkdown(markdown) {
    const text = normalizeText(markdown);
    if (!text) return '';

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const candidate = lines.find(line => !/^(#{1,6}\s+|[-*]\s+|\d+\.\s+)/.test(line)) || lines[0] || '';
    return candidate.slice(0, 240);
}

function normalizeSections(sections) {
    const headingSource = Array.isArray(sections?.headings) ? sections.headings : [];
    const tocSource = Array.isArray(sections?.tocEntries) ? sections.tocEntries : [];

    return {
        headings: headingSource.map(heading => ({
            level: heading.level,
            title: normalizeText(heading.title),
            line: heading.line ?? null
        })).filter(heading => heading.title),
        tocEntries: tocSource.map(entry => ({
            title: normalizeText(entry.title),
            href: normalizeText(entry.href),
            line: entry.line ?? null
        })).filter(entry => entry.title)
    };
}

function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];

    return attachments.map(attachment => ({
        name: normalizeText(attachment?.name || attachment?.filename || attachment?.file_name),
        file_name: normalizeText(attachment?.file_name || attachment?.filename || attachment?.name),
        url: normalizeText(attachment?.url || attachment?.download_url)
    })).filter(attachment => attachment.name || attachment.file_name || attachment.url);
}

function normalizeDetailFields(detailFields) {
    if (!detailFields || typeof detailFields !== 'object') return null;

    const normalizedFields = detailFields.normalized_fields && typeof detailFields.normalized_fields === 'object'
        ? detailFields.normalized_fields
        : {};

    return {
        schema_version: detailFields.schema_version || '1.0',
        generated_at: detailFields.generated_at || null,
        source: detailFields.source || {},
        stats: detailFields.stats || {},
        provenance: detailFields.provenance || {},
        raw_fields: Array.isArray(detailFields.raw_fields) ? detailFields.raw_fields : [],
        normalized_fields: normalizedFields
    };
}

function resolveStructuredItem(manifest, content, itemByCode = {}) {
    const reportFormRootNo = normalizeText(
        content?.report?.report_form_root_no
        || manifest?.report?.report_form_root_no
        || content?.item?.report_form_root_no
        || manifest?.item?.report_form_root_no
    );
    const resolvedByCode = reportFormRootNo ? itemByCode[reportFormRootNo] : null;

    const item = content?.item && Object.keys(content.item).length ? content.item : (manifest?.item || {});
    const reportNos = pickCodeArray(
        item.report_nos,
        item.codes,
        resolvedByCode?.report_nos,
        resolvedByCode?.codes,
        resolvedByCode?.report_form_root_no
    );
    const scd = normalizeText(item.scd || resolvedByCode?.scd || reportNos[0] || reportFormRootNo);
    const resolvedItem = {
        scd,
        report_form_root_no: normalizeText(item.report_form_root_no || resolvedByCode?.report_form_root_no || scd || reportFormRootNo),
        report_nos: reportNos,
        item_name: normalizeText(item.item_name || resolvedByCode?.item_name || ''),
        minor_category: normalizeText(item.minor_category || resolvedByCode?.minor_category || ''),
        major_category: normalizeText(item.major_category || resolvedByCode?.major_category || ''),
        cycle_type: normalizeText(item.cycle_type || resolvedByCode?.cycle_type || ''),
        codes: reportNos,
        isScoped: Boolean(item.isScoped ?? resolvedByCode?.isScoped)
    };

    return {
        reportFormRootNo,
        scd,
        item: resolvedItem,
        canonicalItemKey: normalizeText([
            resolvedItem.minor_category,
            resolvedItem.item_name || resolvedItem.scd || resolvedItem.report_form_root_no
        ].filter(Boolean).join('::'))
    };
}

function buildLatestIndexKeywords(manifest, resolvedItem) {
    const mergedManifest = {
        ...manifest,
        item: {
            ...manifest?.item,
            scd: resolvedItem.item.scd || manifest?.item?.scd || '',
            report_form_root_no: resolvedItem.item.report_form_root_no || manifest?.item?.report_form_root_no || '',
            report_nos: resolvedItem.item.report_nos || manifest?.item?.report_nos || [],
            item_name: resolvedItem.item.item_name || manifest?.item?.item_name || '',
            minor_category: resolvedItem.item.minor_category || manifest?.item?.minor_category || '',
            major_category: resolvedItem.item.major_category || manifest?.item?.major_category || '',
            cycle_type: resolvedItem.item.cycle_type || manifest?.item?.cycle_type || ''
        },
        report: {
            ...manifest?.report,
            scd: resolvedItem.scd || manifest?.report?.scd || '',
            quarter: manifest?.report?.quarter || '',
            period_label: manifest?.report?.period_label || '',
            submission_no: manifest?.report?.submission_no || ''
        }
    };

    return buildIndexKeywords(mergedManifest);
}

function buildLatestIndexEntry(manifest, content, yearDir, structuredBase, itemByCode = {}) {
    const yearDirRelative = structuredBase ? path.relative(structuredBase, yearDir) : yearDir;
    const manifestPath = path.join(yearDirRelative, MANIFEST_FILE_NAME);
    const contentFileName = content?.source?.original_content_json
        || manifest?.source?.original_content_json
        || manifest?.source?.content_json
        || 'content.json';
    const contentPath = path.join(yearDirRelative, contentFileName);
    const resolvedItem = resolveStructuredItem(manifest, content, itemByCode);
    const report = content?.report || manifest?.report || {};
    const institution = content?.institution || manifest?.institution || {};
    const source = content?.source || manifest?.source || {};
    const detailFields = content?.detail_fields || manifest?.detail_fields || null;
    const stats = content?.stats || manifest?.stats || {};
    const canonicalItemKey = resolvedItem.canonicalItemKey || normalizeText([
        resolvedItem.item.minor_category,
        resolvedItem.item.item_name || resolvedItem.item.scd || resolvedItem.item.report_form_root_no
    ].filter(Boolean).join('::'));

    return {
        id: [
            normalizeText(institution.apba_id),
            canonicalItemKey
        ].filter(Boolean).join(':'),
        canonical_item_key: canonicalItemKey,
        institution_name: normalizeText(institution.name),
        ministry: normalizeText(institution.ministry),
        apba_id: normalizeText(institution.apba_id),
        item_name: normalizeText(resolvedItem.item.item_name),
        minor_category: normalizeText(resolvedItem.item.minor_category),
        major_category: normalizeText(resolvedItem.item.major_category),
        cycle_type: normalizeText(resolvedItem.item.cycle_type),
        scd: normalizeText(resolvedItem.scd || report.scd || resolvedItem.item.scd),
        report_form_root_no: normalizeText(report.report_form_root_no || resolvedItem.reportFormRootNo || resolvedItem.item.report_form_root_no),
        report_nos: resolvedItem.item.report_nos,
        year: normalizeText(report.year),
        quarter: normalizeText(report.quarter),
        period_label: normalizeText(report.period_label),
        disclosure_no: normalizeText(report.disclosure_no),
        submission_no: normalizeText(report.submission_no),
        report_title: normalizeText(report.title || manifest?.report?.title || ''),
        summary: normalizeText(manifest?.summary || ''),
        source_url: normalizeText(source.url),
        year_dir: yearDirRelative,
        manifest_path: manifestPath,
        content_path: contentPath,
        attachment_count: stats.attachment_count || 0,
        section_count: stats.section_count || 0,
        detail_field_count: stats.detail_field_count || Object.keys(detailFields?.normalized_fields || {}).length,
        keywords: buildLatestIndexKeywords({
            ...manifest,
            institution: {
                ...manifest?.institution,
                ...institution
            },
            report: {
                ...manifest?.report,
                ...report
            },
            item: {
                ...manifest?.item,
                ...resolvedItem.item
            },
            summary: manifest?.summary || ''
        }, resolvedItem)
    };
}

function compareLatestEntries(left, right) {
    const leftYear = parseComparableNumber(left?.year);
    const rightYear = parseComparableNumber(right?.year);
    if (leftYear !== rightYear) return leftYear > rightYear ? 1 : -1;

    const leftPeriod = parsePeriodRank(left);
    const rightPeriod = parsePeriodRank(right);
    if (leftPeriod !== rightPeriod) return leftPeriod > rightPeriod ? 1 : -1;

    const leftDisclosure = parseComparableNumber(left?.disclosure_no);
    const rightDisclosure = parseComparableNumber(right?.disclosure_no);
    if (leftDisclosure !== rightDisclosure) return leftDisclosure > rightDisclosure ? 1 : -1;

    const leftSubmission = parseComparableNumber(left?.submission_no);
    const rightSubmission = parseComparableNumber(right?.submission_no);
    if (leftSubmission !== rightSubmission) return leftSubmission > rightSubmission ? 1 : -1;

    return 0;
}

function hydrateManifestWithLookup(manifest, itemByCode = {}) {
    const resolvedItem = resolveStructuredItem(manifest, manifest, itemByCode);
    return {
        ...manifest,
        report: {
            ...manifest.report,
            scd: normalizeText(manifest?.report?.scd || resolvedItem.scd || resolvedItem.item.scd),
            report_form_root_no: normalizeText(manifest?.report?.report_form_root_no || resolvedItem.reportFormRootNo || resolvedItem.item.report_form_root_no)
        },
        item: {
            ...manifest.item,
            scd: normalizeText(manifest?.item?.scd || resolvedItem.item.scd || resolvedItem.scd),
            report_form_root_no: normalizeText(manifest?.item?.report_form_root_no || resolvedItem.item.report_form_root_no || resolvedItem.item.scd),
            report_nos: pickCodeArray(manifest?.item?.report_nos, resolvedItem.item.report_nos),
            item_name: normalizeText(manifest?.item?.item_name || resolvedItem.item.item_name),
            minor_category: normalizeText(manifest?.item?.minor_category || resolvedItem.item.minor_category),
            major_category: normalizeText(manifest?.item?.major_category || resolvedItem.item.major_category),
            cycle_type: normalizeText(manifest?.item?.cycle_type || resolvedItem.item.cycle_type)
        }
    };
}

function buildLatestIndexMap(structuredBase, documents) {
    const latestByKey = new Map();

    for (const document of documents) {
        const key = document.id || document.canonical_item_key;
        const current = latestByKey.get(key);
        if (!current || compareLatestEntries(document, current) > 0) {
            latestByKey.set(key, document);
        }
    }

    return [...latestByKey.values()].sort((left, right) => {
        return [left.institution_name, left.canonical_item_key, left.year, left.disclosure_no, left.submission_no, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.canonical_item_key, right.year, right.disclosure_no, right.submission_no, right.id].join(' '));
    });
}

function buildStructuredManifest({
    structuredBase,
    yearDir,
    institution,
    report,
    item,
    sourceUrl,
    collectedAt = new Date().toISOString(),
    title = '',
    summary = '',
    markdown = '',
    sections = {},
    attachments = [],
    detailFields = null,
    contentPath = 'content.json',
    contentMdPath = 'content.md',
    sectionsPath = 'sections.json',
    attachmentsPath = 'attachments.json',
    detailFieldsPath = 'detail_fields.json',
    originalContentPath = null
}) {
    const normalizedSections = normalizeSections(sections);
    const normalizedAttachments = normalizeAttachments(attachments);
    const normalizedDetailFields = normalizeDetailFields(detailFields);
    const yearDirRelative = structuredBase ? path.relative(structuredBase, yearDir) : yearDir;
    const summaryText = normalizeText(summary) || summarizeMarkdown(markdown) || normalizeText(title) || normalizeText(report?.title) || normalizeText(report?.disclosure_title);
    const itemReportNos = pickCodeArray(item?.report_nos, item?.codes);
    const scd = normalizeText(item?.scd || report?.scd || itemReportNos[0] || report?.report_form_root_no);

    return {
        schema_version: '1.0',
        generated_at: collectedAt,
        summary: summaryText,
        title: normalizeText(title || report?.title || report?.disclosure_title),
        institution: {
            apba_id: normalizeText(institution?.apba_id),
            name: normalizeText(institution?.name),
            ministry: normalizeText(institution?.ministry)
        },
        report: {
            scd,
            disclosure_no: normalizeText(report?.disclosure_no),
            report_form_root_no: normalizeText(report?.report_form_root_no),
            year: normalizeText(report?.year || report?.critYyyy || report?.disclosure_year || 'UnknownYear'),
            quarter: normalizeText(report?.quarter),
            period_label: normalizeText(report?.period_label),
            submission_no: normalizeText(report?.submission_no),
            title: normalizeText(report?.title || report?.disclosure_title || title)
        },
        item: {
            scd,
            report_form_root_no: scd || normalizeText(report?.report_form_root_no),
            report_nos: itemReportNos,
            item_name: normalizeText(item?.item_name || item?.minor_category || ''),
            minor_category: normalizeText(item?.minor_category || ''),
            major_category: normalizeText(item?.major_category || ''),
            cycle_type: normalizeText(item?.cycle_type || '')
        },
        source: {
            url: normalizeText(sourceUrl),
            year_dir: yearDirRelative,
            content_json: contentPath,
            content_md: markdown ? contentMdPath : null,
            sections_json: normalizedSections.headings.length || normalizedSections.tocEntries.length ? sectionsPath : null,
            attachments_json: normalizedAttachments.length ? attachmentsPath : null,
            detail_fields_json: normalizedDetailFields && Object.keys(normalizedDetailFields.normalized_fields || {}).length ? detailFieldsPath : null,
            original_content_json: originalContentPath ? path.basename(originalContentPath) : null
        },
        sections: normalizedSections,
        attachments: normalizedAttachments,
        detail_fields: normalizedDetailFields,
        stats: {
            section_count: normalizedSections.headings.length + normalizedSections.tocEntries.length,
            attachment_count: normalizedAttachments.length,
            detail_field_count: Object.keys(normalizedDetailFields?.normalized_fields || {}).length
        }
    };
}

function buildIndexKeywords(manifest) {
    const sectionTitles = [
        ...(manifest.sections?.headings || []).map(section => section.title),
        ...(manifest.sections?.tocEntries || []).map(section => section.title)
    ];
    const attachmentNames = (manifest.attachments || []).map(attachment => attachment.name || attachment.file_name);
    const detailFieldNames = Object.keys(manifest.detail_fields?.normalized_fields || {});
    const detailFieldLabels = detailFieldNames.map(key => manifest.detail_fields?.normalized_fields?.[key]?.label).filter(Boolean);
    const detailFieldAliases = detailFieldNames.flatMap(key => manifest.detail_fields?.normalized_fields?.[key]?.aliases || []);

    return uniq([
        manifest.institution?.name,
        manifest.institution?.ministry,
        manifest.institution?.apba_id,
        manifest.item?.scd,
        ...(manifest.item?.report_nos || []),
        manifest.item?.item_name,
        manifest.item?.minor_category,
        manifest.item?.major_category,
        manifest.report?.report_form_root_no,
        manifest.report?.disclosure_no,
        manifest.report?.title,
        manifest.summary,
        ...sectionTitles,
        ...attachmentNames,
        ...detailFieldNames,
        ...detailFieldLabels,
        ...detailFieldAliases
    ]);
}

function buildIndexEntry(manifest, yearDir, structuredBase) {
    const yearDirRelative = structuredBase ? path.relative(structuredBase, yearDir) : yearDir;
    const manifestPath = path.join(yearDirRelative, MANIFEST_FILE_NAME);
    const contentFileName = manifest?.source?.original_content_json || manifest?.source?.content_json || 'content.json';
    const contentPath = path.join(yearDirRelative, contentFileName);

    return {
        id: [
            manifest.institution?.apba_id || '',
            manifest.report?.report_form_root_no || '',
            manifest.report?.disclosure_no || '',
            manifest.report?.year || ''
        ].join(':'),
        institution_name: manifest.institution?.name || '',
        ministry: manifest.institution?.ministry || '',
        apba_id: manifest.institution?.apba_id || '',
        scd: manifest.report?.scd || manifest.item?.scd || manifest.report?.report_form_root_no || '',
        report_form_root_no: manifest.report?.report_form_root_no || '',
        report_nos: manifest.item?.report_nos || [],
        item_name: manifest.item?.item_name || '',
        minor_category: manifest.item?.minor_category || '',
        major_category: manifest.item?.major_category || '',
        year: manifest.report?.year || '',
        report_title: manifest.report?.title || '',
        summary: manifest.summary || '',
        source_url: manifest.source?.url || '',
        year_dir: yearDirRelative,
        manifest_path: manifestPath,
        content_path: contentPath,
        attachment_count: manifest.stats?.attachment_count || 0,
        section_count: manifest.stats?.section_count || 0,
        detail_field_count: manifest.stats?.detail_field_count || 0,
        keywords: buildIndexKeywords(manifest)
    };
}

function buildDownloadFileEntries(manifest, yearDir, structuredBase) {
    const yearDirRelative = structuredBase ? path.relative(structuredBase, yearDir) : yearDir;
    const manifestPath = path.join(yearDirRelative, MANIFEST_FILE_NAME);
    const common = {
        institution_name: manifest.institution?.name || '',
        ministry: manifest.institution?.ministry || '',
        apba_id: manifest.institution?.apba_id || '',
        scd: manifest.report?.scd || manifest.item?.scd || manifest.report?.report_form_root_no || '',
        report_form_root_no: manifest.report?.report_form_root_no || '',
        report_nos: manifest.item?.report_nos || [],
        item_name: manifest.item?.item_name || '',
        minor_category: manifest.item?.minor_category || '',
        major_category: manifest.item?.major_category || '',
        year: manifest.report?.year || '',
        disclosure_no: manifest.report?.disclosure_no || '',
        submission_no: manifest.report?.submission_no || '',
        report_title: manifest.report?.title || '',
        source_url: manifest.source?.url || '',
        manifest_path: manifestPath
    };

    return normalizeAttachments(manifest.attachments || []).map(attachment => {
        const fileName = attachment.file_name || attachment.name;
        const filePath = path.join(yearDirRelative, fileName);
        const absolutePath = path.join(yearDir, fileName);
        return {
            id: [common.apba_id, common.scd, common.disclosure_no, fileName].join(':'),
            report_id: [common.apba_id, common.report_form_root_no, common.disclosure_no, common.year].join(':'),
            ...common,
            file_name: fileName,
            file_label: attachment.name || fileName,
            file_path: filePath,
            download_url: attachment.url || '',
            downloaded: fs.existsSync(absolutePath)
        };
    });
}

function csvEscape(value) {
    const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeStructuredDownloadFileIndex(structuredBase, files) {
    const jsonPath = path.join(structuredBase, DOWNLOAD_FILE_INDEX_FILE_NAME);
    const csvPath = path.join(structuredBase, DOWNLOAD_FILE_INDEX_CSV_FILE_NAME);
    const payload = {
        generated_at: new Date().toISOString(),
        total_files: files.length,
        files
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

    const columns = [
        'institution_name',
        'ministry',
        'apba_id',
        'scd',
        'report_form_root_no',
        'report_nos',
        'item_name',
        'minor_category',
        'major_category',
        'year',
        'disclosure_no',
        'submission_no',
        'report_title',
        'file_name',
        'file_label',
        'file_path',
        'download_url',
        'downloaded',
        'source_url',
        'manifest_path'
    ];
    const lines = [columns.join(',')];
    for (const file of files) {
        lines.push(columns.map(column => csvEscape(file[column])).join(','));
    }
    fs.writeFileSync(csvPath, `${lines.join('\n')}\n`);}

function readDisclosureItemLookup(structuredBase) {
    const disclosureItemsPath = path.join(path.dirname(structuredBase), 'disclosure_items.json');
    if (!fs.existsSync(disclosureItemsPath)) return {};

    const disclosureItems = JSON.parse(fs.readFileSync(disclosureItemsPath, 'utf8'));
    const { itemByCode } = buildDisclosureLookup(disclosureItems, []);
    return itemByCode;
}

function readExistingIndex(indexPath) {
    const existing = readJsonIfExists(indexPath);
    if (!existing) {
        return { generated_at: null, documents: [] };
    }

    if (Array.isArray(existing)) {
        return { generated_at: null, documents: existing };
    }

    return {
        generated_at: existing.generated_at || null,
        documents: Array.isArray(existing.documents) ? existing.documents : (Array.isArray(existing.files) ? existing.files : [])
    };
}

function writeStructuredIndex(structuredBase, documents) {
    const indexPath = path.join(structuredBase, INDEX_FILE_NAME);
    const payload = {
        generated_at: new Date().toISOString(),
        total_documents: documents.length,
        documents
    };
    fs.writeFileSync(indexPath, JSON.stringify(payload, null, 2));
}

function readExistingLatestIndex(indexPath) {
    return readExistingIndex(indexPath);
}

function writeStructuredLatestIndex(structuredBase, documents) {
    const indexPath = path.join(structuredBase, LATEST_INDEX_FILE_NAME);
    const payload = {
        generated_at: new Date().toISOString(),
        total_documents: documents.length,
        documents
    };
    fs.writeFileSync(indexPath, JSON.stringify(payload, null, 2));
}

function upsertStructuredIndex(structuredBase, yearDir, manifest) {
    const indexPath = path.join(structuredBase, INDEX_FILE_NAME);
    const existingIndex = readExistingIndex(indexPath);
    const nextDocument = buildIndexEntry(manifest, yearDir, structuredBase);
    const filtered = existingIndex.documents.filter(document => document.id !== nextDocument.id);
    filtered.push(nextDocument);
    filtered.sort((left, right) => {
        return [left.institution_name, left.scd, left.year, left.report_title, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.scd, right.year, right.report_title, right.id].join(' '));
    });

    writeStructuredIndex(structuredBase, filtered);
    upsertStructuredLatestIndex(structuredBase, yearDir, manifest);
    upsertStructuredDownloadFileIndex(structuredBase, yearDir, manifest);
    return nextDocument;
}

function upsertStructuredLatestIndex(structuredBase, yearDir, manifest) {
    const latestIndexPath = path.join(structuredBase, LATEST_INDEX_FILE_NAME);
    const existingIndex = readExistingLatestIndex(latestIndexPath);
    const contentPath = findPrimaryContentFile(yearDir);
    const content = contentPath ? readJsonIfExists(contentPath) : null;
    const itemByCode = readDisclosureItemLookup(structuredBase);
    const nextDocument = buildLatestIndexEntry(manifest, content, yearDir, structuredBase, itemByCode);
    const filtered = existingIndex.documents.filter(document => document.id !== nextDocument.id);
    filtered.push(nextDocument);
    const latestDocuments = buildLatestIndexMap(structuredBase, filtered);

    writeStructuredLatestIndex(structuredBase, latestDocuments);
    return nextDocument;
}

function upsertStructuredDownloadFileIndex(structuredBase, yearDir, manifest) {
    const existingIndex = readExistingIndex(path.join(structuredBase, DOWNLOAD_FILE_INDEX_FILE_NAME));
    const nextFiles = buildDownloadFileEntries(manifest, yearDir, structuredBase);
    const reportId = nextFiles[0]?.report_id || [
        manifest.institution?.apba_id || '',
        manifest.report?.report_form_root_no || '',
        manifest.report?.disclosure_no || '',
        manifest.report?.year || ''
    ].join(':');
    const filtered = existingIndex.documents.filter(file => file.report_id !== reportId);
    filtered.push(...nextFiles);
    filtered.sort((left, right) => {
        return [left.institution_name, left.scd, left.year, left.report_title, left.file_name, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.scd, right.year, right.report_title, right.file_name, right.id].join(' '));
    });
    writeStructuredDownloadFileIndex(structuredBase, filtered);
    return nextFiles;
}

function collectStructuredDocumentDirs(structuredBase) {
    if (!fs.existsSync(structuredBase)) return [];

    const result = [];
    const stack = [structuredBase];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        const primaryContent = findPrimaryContentFile(currentDir);
        if (primaryContent && currentDir !== structuredBase) {
            result.push(currentDir);
        }

        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            stack.push(path.join(currentDir, entry.name));
        }
    }

    return result;
}

function findPrimaryContentFile(yearDir) {
    const preferredNames = ['content.json', 'manifest.json'];
    for (const fileName of preferredNames) {
        const filePath = path.join(yearDir, fileName);
        if (fs.existsSync(filePath)) return filePath;
    }

    const candidates = fs.readdirSync(yearDir)
        .filter(fileName => fileName.endsWith('.json'))
        .filter(fileName => !['attachments.json', 'sections.json', INDEX_FILE_NAME, LATEST_INDEX_FILE_NAME, DOWNLOAD_FILE_INDEX_FILE_NAME, MANIFEST_FILE_NAME].includes(fileName));

    if (candidates.length === 0) return null;

    return path.join(yearDir, candidates[0]);
}

function readSiblingJson(yearDir, fileName) {
    return readJsonIfExists(path.join(yearDir, fileName));
}

function normalizeManifestFromContent({
    structuredBase,
    yearDir,
    content,
    sourceFile
}) {
    if (!content) return null;

    const siblingSections = readSiblingJson(yearDir, 'sections.json');
    const siblingAttachments = readSiblingJson(yearDir, 'attachments.json');
    const siblingDetailFields = readSiblingJson(yearDir, 'detail_fields.json');

    if (content.schema_version === '1.0' && content.institution && content.report && content.item && content.source && content.sections) {
        const detailFields = normalizeDetailFields(content.detail_fields || siblingDetailFields);
        return {
            ...content,
            sections: normalizeSections(content.sections),
            attachments: normalizeAttachments(content.attachments || siblingAttachments || []),
            item: {
                ...content.item,
                report_nos: pickCodeArray(content.item?.report_nos, content.item?.codes),
                scd: normalizeText(content.item?.scd || content.report?.scd || content.item?.report_form_root_no)
            },
            report: {
                ...content.report,
                scd: normalizeText(content.report?.scd || content.item?.scd || content.item?.report_form_root_no)
            },
            detail_fields: detailFields,
            source: {
                ...content.source,
                year_dir: content.source?.year_dir || (structuredBase ? path.relative(structuredBase, yearDir) : yearDir),
                original_content_json: content.source?.original_content_json || (sourceFile ? path.basename(sourceFile) : null),
                detail_fields_json: content.source?.detail_fields_json || (detailFields ? 'detail_fields.json' : null)
            },
            stats: {
                ...content.stats,
                detail_field_count: content.stats?.detail_field_count || Object.keys(detailFields?.normalized_fields || {}).length
            }
        };
    }

    const report = content.report || {};
    const institution = content.institution || content.inst || {};
    const item = content.item || {};
    const sections = content.sections || siblingSections || {};
    const attachments = content.attachments || content.files || siblingAttachments || [];
    const detailFields = content.detail_fields || siblingDetailFields || null;
    const sourceUrl = content.source_url || content.source?.url || '';
    const title = content.title || report.title || report.disclosure_title || '';
    const markdown = content.markdown || content.content?.markdown || '';

    return buildStructuredManifest({
        structuredBase,
        yearDir,
        institution,
        report: {
            scd: report.scd || item.scd || report.report_form_root_no || report.reportFormRootNo || report.reportFormNo || content.report_form_root_no || '',
            disclosure_no: report.disclosure_no || report.disclosureNo || content.disclosure_no || '',
            report_form_root_no: report.report_form_root_no || report.reportFormRootNo || report.reportFormNo || content.report_form_root_no || '',
            submission_no: report.submission_no || report.submissionNo || content.submission_no || '',
            quarter: report.quarter || content.quarter || '',
            period_label: report.period_label || content.period_label || '',
            year: report.year || report.critYyyy || report.disclosure_year || content.year || 'UnknownYear',
            title
        },
        item,
        sourceUrl,
        title,
        markdown,
        sections,
        attachments,
        detailFields,
        originalContentPath: sourceFile
    });
}

function loadStructuredManifest(yearDir, structuredBase) {
    const contentPath = findPrimaryContentFile(yearDir);
    if (!contentPath) return null;

    const content = readJsonIfExists(contentPath);
    return normalizeManifestFromContent({
        structuredBase,
        yearDir,
        content,
        sourceFile: contentPath
    });
}

function rebuildStructuredIndex(structuredBase) {
    const documents = [];
    const latestDocuments = [];
    const downloadFiles = [];
    const itemByCode = readDisclosureItemLookup(structuredBase);
    for (const yearDir of collectStructuredDocumentDirs(structuredBase)) {
        const manifest = loadStructuredManifest(yearDir, structuredBase);
        if (!manifest) continue;
        const hydratedManifest = hydrateManifestWithLookup(manifest, itemByCode);
        const contentPath = findPrimaryContentFile(yearDir);
        const content = contentPath ? readJsonIfExists(contentPath) : null;

        const manifestPath = path.join(yearDir, MANIFEST_FILE_NAME);
        fs.writeFileSync(manifestPath, JSON.stringify(hydratedManifest, null, 2));
        documents.push(buildIndexEntry(hydratedManifest, yearDir, structuredBase));
        latestDocuments.push(buildLatestIndexEntry(hydratedManifest, content, yearDir, structuredBase, itemByCode));
        downloadFiles.push(...buildDownloadFileEntries(hydratedManifest, yearDir, structuredBase));
    }

    documents.sort((left, right) => {
        return [left.institution_name, left.scd, left.year, left.report_title, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.scd, right.year, right.report_title, right.id].join(' '));
    });
    downloadFiles.sort((left, right) => {
        return [left.institution_name, left.scd, left.year, left.report_title, left.file_name, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.scd, right.year, right.report_title, right.file_name, right.id].join(' '));
    });

    writeStructuredIndex(structuredBase, documents);
    writeStructuredLatestIndex(structuredBase, buildLatestIndexMap(structuredBase, latestDocuments));
    writeStructuredDownloadFileIndex(structuredBase, downloadFiles);
    return documents;
}

function rebuildStructuredLatestIndex(structuredBase) {
    const latestDocuments = [];
    const itemByCode = readDisclosureItemLookup(structuredBase);

    for (const yearDir of collectStructuredDocumentDirs(structuredBase)) {
        const manifest = loadStructuredManifest(yearDir, structuredBase);
        if (!manifest) continue;
        const hydratedManifest = hydrateManifestWithLookup(manifest, itemByCode);
        const contentPath = findPrimaryContentFile(yearDir);
        const content = contentPath ? readJsonIfExists(contentPath) : null;
        latestDocuments.push(buildLatestIndexEntry(manifest, content, yearDir, structuredBase, itemByCode));
    }

    const latest = buildLatestIndexMap(structuredBase, latestDocuments);
    writeStructuredLatestIndex(structuredBase, latest);
    return latest;
}

function rebuildStructuredDownloadFileIndex(structuredBase) {
    const downloadFiles = [];
    const itemByCode = readDisclosureItemLookup(structuredBase);
    for (const yearDir of collectStructuredDocumentDirs(structuredBase)) {
        const manifest = loadStructuredManifest(yearDir, structuredBase);
        if (!manifest) continue;
        const hydratedManifest = hydrateManifestWithLookup(manifest, itemByCode);
        downloadFiles.push(...buildDownloadFileEntries(hydratedManifest, yearDir, structuredBase));
    }

    downloadFiles.sort((left, right) => {
        return [left.institution_name, left.scd, left.year, left.report_title, left.file_name, left.id]
            .join(' ')
            .localeCompare([right.institution_name, right.scd, right.year, right.report_title, right.file_name, right.id].join(' '));
    });
    writeStructuredDownloadFileIndex(structuredBase, downloadFiles);
    return downloadFiles;
}

module.exports = {
    INDEX_FILE_NAME,
    LATEST_INDEX_FILE_NAME,
    DOWNLOAD_FILE_INDEX_FILE_NAME,
    DOWNLOAD_FILE_INDEX_CSV_FILE_NAME,
    MANIFEST_FILE_NAME,
    buildIndexEntry,
    buildLatestIndexEntry,
    buildStructuredManifest,
    buildDownloadFileEntries,
    loadStructuredManifest,
    rebuildStructuredIndex,
    rebuildStructuredLatestIndex,
    rebuildStructuredDownloadFileIndex,
    upsertStructuredIndex,
    upsertStructuredLatestIndex,
    upsertStructuredDownloadFileIndex
};
