const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));
const {
    buildDisclosureLookup,
    buildStructuredPaths,
    hasMeaningfulOutput,
    normalizeCrawl4AIResult,
    resolveDisclosureItem,
    sanitizeSegment
} = require(path.join(__dirname, 'project/crawler/utils/disclosure_scope'));
const {
    extractReportAttachments
} = require(path.join(__dirname, 'project/crawler/utils/report_attachments'));
const {
    buildDetailFieldsExtraction
} = require(path.join(__dirname, 'project/crawler/utils/detail_extractor'));
const {
    buildStructuredManifest,
    upsertStructuredIndex
} = require(path.join(__dirname, 'project/crawler/utils/structured_explorer'));

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235/crawl';

function parseArgs(argv) {
    const args = { ministry: null, retryTargets: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--ministry') {
            args.ministry = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--retry-targets') {
            args.retryTargets = argv[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg.startsWith('--ministry=')) {
            args.ministry = arg.slice('--ministry='.length);
            continue;
        }
        if (arg.startsWith('--retry-targets=')) {
            args.retryTargets = arg.slice('--retry-targets='.length);
        }
    }
    return args;
}

function loadRetryTargets(filePath) {
    if (!filePath) return null;

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.targets) ? raw.targets : [];
    const targetsByInstitution = new Map();

    for (const row of rows) {
        const apbaId = String(row?.apba_id || '').trim();
        const reportNo = String(row?.report_no || '').trim();
        if (!apbaId || !reportNo) continue;

        if (!targetsByInstitution.has(apbaId)) {
            targetsByInstitution.set(apbaId, new Set());
        }
        targetsByInstitution.get(apbaId).add(reportNo);
    }

    return targetsByInstitution;
}

async function scrapeWithCrawl4AI(url) {
    try {
        const response = await axios.post(CRAWL4AI_URL, {
            urls: [url],
            word_count_threshold: 0,
            extraction_strategy: 'json',
            page_options: { only_main_content: true }
        }, { timeout: 30000 });

        return normalizeCrawl4AIResult(response);
    } catch (err) {
        logger.error(`Crawl4AI failed for ${url}: ${err.message}`);
        return null;
    }
}

async function fetchHtml(url) {
    if (!url) return '';

    try {
        const response = await axios.get(url, { timeout: 30000 });
        return String(response.data || '');
    } catch (err) {
        logger.info(`HTML fetch failed for ${url}: ${err.message}`);
        return '';
    }
}

function shouldRetryLookup(err) {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('socket hang up') || message.includes('timeout') || message.includes('econnreset');
}

async function postWithRetry(url, payload, maxAttempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await axios.post(url, payload, { timeout: 30000 });
        } catch (err) {
            lastError = err;
            if (!shouldRetryLookup(err) || attempt === maxAttempts) {
                throw err;
            }
            logger.info(`Retrying ${url} (${attempt}/${maxAttempts}) after ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }

    throw lastError;
}

function buildDownloadUrl(att) {
    const rawUrl = att?.url || att?.download_url || att?.href || '';
    if (!rawUrl) return '';
    if (rawUrl.startsWith('http')) return rawUrl;
    return `https://www.alio.go.kr${rawUrl}`;
}

function buildAttachmentName(att, fallbackIndex) {
    const rawName = att?.name || att?.filename || att?.title || path.basename(att?.url || att?.download_url || att?.href || '');
    const sanitized = sanitizeSegment(rawName || `attachment_${fallbackIndex + 1}`);
    return sanitized || `attachment_${fallbackIndex + 1}`;
}

function normalizeAttachmentRecord(att, fallbackIndex) {
    const downloadUrl = buildDownloadUrl(att);
    const fileName = buildAttachmentName(att, fallbackIndex);
    return {
        name: att?.name || att?.filename || fileName,
        file_name: fileName,
        file_no: att?.file_no || att?.fileNo || '',
        submission_no: att?.submission_no || att?.submissionNo || '',
        source_type: att?.source_type || '',
        url: downloadUrl,
        download_url: downloadUrl
    };
}

async function fetchPdfJson(disclosureNo) {
    if (!disclosureNo) return null;

    try {
        const response = await axios.get('https://www.alio.go.kr/download/pdf.json', {
            params: { disclosureNo },
            timeout: 20000
        });
        return response.data || null;
    } catch (err) {
        logger.info(`pdf.json unavailable for ${disclosureNo}: ${err.message}`);
        return null;
    }
}

function normalizeReportRow(report, fallbackReportFormRootNo) {
    const title = report?.title || report?.disclosure_title || '';
    const yearMatch = String(report?.year || report?.critYyyy || title).match(/^(\d{4})/);

    return {
        apba_id: report?.apbaId || report?.apba_id || '',
        report_form_root_no: String(report?.reportFormNo || report?.report_form_root_no || fallbackReportFormRootNo || '').trim(),
        disclosure_no: String(report?.disclosureNo || report?.disclosure_no || '').trim(),
        submission_no: String(report?.submissionNo || report?.submission_no || '').trim(),
        year: String(report?.year || report?.critYyyy || (yearMatch ? yearMatch[1] : '') || '').trim(),
        quarter: String(report?.quarter || '').trim(),
        period_label: String(report?.period_label || '').trim(),
        title,
        disclosure_title: title
    };
}

async function fetchLiveReportRows(apbaId, reportFormRootNo) {
    if (!apbaId || !reportFormRootNo) return [];

    try {
        const organResponse = await postWithRetry('https://www.alio.go.kr/item/itemOrganListSusi.json', {
            apbaId,
            reportFormRootNo
        });

        const organInfo = organResponse?.data?.data?.organInfo || {};
        const apbaType = organInfo.apbaType || '';

        const reportResponse = await postWithRetry('https://www.alio.go.kr/item/itemReportListSusi.json', {
            pageNo: 1,
            apbaId,
            apbaType,
            reportFormRootNo,
            search_word: '',
            search_flag: 'title',
            bid_type: '',
            enfc_istt: ''
        });

        const rows = reportResponse?.data?.data?.result || [];
        return Array.isArray(rows) ? rows.map(row => normalizeReportRow(row, reportFormRootNo)) : [];
    } catch (err) {
        logger.info(`Live report lookup failed for ${apbaId}/${reportFormRootNo}: ${err.message}`);
        return [];
    }
}

async function downloadDocuments() {
    const institutions = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/institutions.json'), 'utf8'));
    const reports = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reports.json'), 'utf8'));
    const disclosureItems = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/disclosure_items.json'), 'utf8'));
    const crawlTargets = yaml.load(fs.readFileSync(path.join(__dirname, 'project/crawler/config/crawl_targets.yaml'), 'utf8'));
    const args = parseArgs(process.argv.slice(2));
    const retryTargets = loadRetryTargets(args.retryTargets);

    const { itemByCode, scopedCodes } = buildDisclosureLookup(disclosureItems, crawlTargets);
    const structuredBase = path.join(__dirname, '../data/structured_data');
    const scopedReportFormNos = [...scopedCodes].sort();
    const scopedInstitutions = institutions.filter(inst => {
        if (args.ministry && inst.ministry !== args.ministry) return false;
        if (retryTargets && !retryTargets.has(inst.apba_id)) return false;
        return true;
    });
    const scopedReports = reports
        .filter(report => scopedCodes.has(String(report.report_form_root_no || '').trim()))
        .map(report => normalizeReportRow(report, report.report_form_root_no));

    logger.info(`Starting advanced download for ${scopedInstitutions.length} institutions${args.ministry ? ` in ministry: ${args.ministry}` : ''}${retryTargets ? ` with retry targets: ${retryTargets.size} institutions` : ''}.`);

    for (const inst of scopedInstitutions) {
        const reportFormRootNos = retryTargets
            ? [...(retryTargets.get(inst.apba_id) || [])].filter(code => scopedCodes.has(code))
            : scopedReportFormNos;

        for (const reportFormRootNo of reportFormRootNos) {
            const localReports = scopedReports.filter(report =>
                report.apba_id === inst.apba_id && report.report_form_root_no === reportFormRootNo
            );
            const reportsToProcess = localReports.length > 0
                ? localReports
                : await fetchLiveReportRows(inst.apba_id, reportFormRootNo);

            if (reportsToProcess.length === 0) continue;

            for (const report of reportsToProcess) {
                const resolved = resolveDisclosureItem(report.report_form_root_no, itemByCode);
                const item = resolved.item;
                if (!item) continue;

                logger.info(`Processing: ${inst.name} - ${report.report_form_root_no}`);
                const detailUrl = `https://www.alio.go.kr/item/itemReportTerm.do?apbaId=${inst.apba_id}&reportFormRootNo=${report.report_form_root_no}&disclosureNo=${report.disclosure_no}`;
                const crawlResult = await scrapeWithCrawl4AI(detailUrl);
                if (!crawlResult || !hasMeaningfulOutput(crawlResult)) {
                    logger.info(`Skipping ${report.disclosure_no}: no Crawl4AI output.`);
                    continue;
                }

                const pdfJson = await fetchPdfJson(report.disclosure_no);
                const reportUrl = `https://www.alio.go.kr/item/itemReport.do?seq=${report.disclosure_no}&disclosureNo=${report.disclosure_no}`;
                const reportHtml = await fetchHtml(reportUrl);
                const reportAttachmentContext = extractReportAttachments({ reportHtml, disclosureNo: report.disclosure_no });
                const docHtml = reportAttachmentContext.docPath ? await fetchHtml(`https://www.alio.go.kr${reportAttachmentContext.docPath}`) : '';
                const reportAttachments = extractReportAttachments({ reportHtml, docHtml, disclosureNo: report.disclosure_no });
                const { yearDir } = buildStructuredPaths(structuredBase, inst, report, item);
                fs.mkdirSync(yearDir, { recursive: true });

                const manifest = {
                    institution: {
                        apba_id: inst.apba_id,
                        name: inst.name,
                        ministry: inst.ministry
                    },
                    report: {
                        disclosure_no: report.disclosure_no,
                        report_form_root_no: report.report_form_root_no,
                        year: report.year || report.critYyyy || 'UnknownYear',
                        title: report.title || report.disclosure_title || ''
                    },
                    item: {
                        report_form_root_no: report.report_form_root_no,
                        item_name: item.item_name || item.minor_category || '',
                        minor_category: item.minor_category || '',
                        major_category: item.major_category || ''
                    },
                    source_url: detailUrl,
                    collected_at: new Date().toISOString(),
                    sections: crawlResult.sections
                };

                if (crawlResult.json !== null && crawlResult.json !== undefined) {
                    manifest.content = crawlResult.json;
                }

                fs.writeFileSync(path.join(yearDir, 'content.json'), JSON.stringify(manifest, null, 2));

                if (crawlResult.markdown) {
                    fs.writeFileSync(path.join(yearDir, 'content.md'), crawlResult.markdown);
                }

                if (crawlResult.sections.headings.length || crawlResult.sections.tocEntries.length) {
                    fs.writeFileSync(path.join(yearDir, 'sections.json'), JSON.stringify(crawlResult.sections, null, 2));
                }

                const attachments = [];
                const attachmentSources = [
                    ...(Array.isArray(crawlResult.files) ? crawlResult.files.map((att, index) => normalizeAttachmentRecord(att, index)) : []),
                    ...(Array.isArray(reportAttachments.attachments) ? reportAttachments.attachments.map((att, index) => normalizeAttachmentRecord(att, index)) : [])
                ];

                for (const [index, att] of attachmentSources.entries()) {
                    if (!att.download_url) continue;
                    if (attachments.some(existing => existing.file_name === att.file_name)) continue;

                    attachments.push(att);
                    const filePath = path.join(yearDir, att.file_name);
                    if (fs.existsSync(filePath)) continue;

                    try {
                        logger.info(`Downloading: ${att.name || att.file_name}`);
                        const response = await axios.get(att.download_url, { responseType: 'stream', timeout: 60000 });
                        const writer = fs.createWriteStream(filePath);
                        response.data.pipe(writer);
                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });
                    } catch (err) {
                        logger.error(`Download failed: ${att.name || att.file_name}: ${err.message}`);
                    }
                }

                if (attachments.length > 0) {
                    fs.writeFileSync(path.join(yearDir, 'attachments.json'), JSON.stringify(attachments, null, 2));
                }

                const detailFields = buildDetailFieldsExtraction({
                    markdown: crawlResult.markdown,
                    rawJson: crawlResult.json,
                    pdfJson,
                    attachments,
                    sourceUrl: detailUrl,
                    report,
                    item
                });

                if (detailFields.stats.raw_field_count > 0 || detailFields.stats.normalized_field_count > 0) {
                    fs.writeFileSync(path.join(yearDir, 'detail_fields.json'), JSON.stringify(detailFields, null, 2));
                }

                const explorerManifest = buildStructuredManifest({
                    structuredBase,
                    yearDir,
                    institution: inst,
                    report,
                    item,
                    sourceUrl: detailUrl,
                    title: report.title || report.disclosure_title || '',
                    markdown: crawlResult.markdown,
                    sections: crawlResult.sections,
                    attachments,
                    detailFields,
                    originalContentPath: path.join(yearDir, 'content.json')
                });
                fs.writeFileSync(path.join(yearDir, 'manifest.json'), JSON.stringify(explorerManifest, null, 2));
                upsertStructuredIndex(structuredBase, yearDir, explorerManifest);
            }
        }
    }
}

if (require.main === module) {
    downloadDocuments();
}

module.exports = {
    loadRetryTargets,
    parseArgs
};
