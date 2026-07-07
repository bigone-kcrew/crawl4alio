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
const alioApi = require(path.join(__dirname, 'project/crawler/utils/alio_api'));

const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235/crawl';
const CRAWL4AI_TOKEN = (process.env.CRAWL4AI_API_TOKEN || '').trim();

function parseList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
    const args = {
        ministry: null,
        retryTargets: null,
        limit: 0,
        year: null,
        scope: null,        // 'all' | 'categories' | 'items'
        categories: null,   // 중분류명 목록
        items: null,        // 공시코드(SCD) 목록
        apbaIds: null,      // 기관코드 목록
        instType: null,     // 기관유형 (예: 기타공공기관)
        printScope: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        const inlineValue = eq > 0 ? arg.slice(eq + 1) : null;
        const takeValue = () => inlineValue !== null ? inlineValue : (argv[++i] || '');

        switch (name) {
            case '--ministry': args.ministry = takeValue(); break;
            case '--retry-targets': args.retryTargets = takeValue(); break;
            case '--limit': args.limit = parseInt(takeValue(), 10) || 0; break;
            case '--year': args.year = String(takeValue()).trim(); break;
            case '--scope': args.scope = takeValue().trim(); break;
            case '--categories': args.categories = parseList(takeValue()); break;
            case '--items': args.items = parseList(takeValue()); break;
            case '--apba-ids': args.apbaIds = new Set(parseList(takeValue())); break;
            case '--inst-type': args.instType = takeValue().trim(); break;
            case '--print-scope': args.printScope = true; break;
        }
    }
    return args;
}

/**
 * 재시도 대상 로드.
 * 행에 disclosure_no가 있으면 해당 공시만, 없으면 그 (기관, 공시코드)의 전체 공시를 대상으로 한다.
 * @returns {Map<apbaId, Map<reportNo, Set<disclosureNo>|null>>}
 */
function loadRetryTargets(filePath) {
    if (!filePath) return null;

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.targets) ? raw.targets : [];
    const targetsByInstitution = new Map();

    for (const row of rows) {
        const apbaId = String(row?.apba_id || '').trim();
        const reportNo = String(row?.report_no || row?.report_form_no || '').trim();
        if (!apbaId || !reportNo) continue;

        if (!targetsByInstitution.has(apbaId)) {
            targetsByInstitution.set(apbaId, new Map());
        }
        const byReportNo = targetsByInstitution.get(apbaId);

        const disclosureNo = String(row?.disclosure_no || '').trim();
        if (!byReportNo.has(reportNo)) {
            byReportNo.set(reportNo, disclosureNo ? new Set([disclosureNo]) : null);
        } else if (disclosureNo) {
            const existing = byReportNo.get(reportNo);
            if (existing) existing.add(disclosureNo);
            // existing이 null이면 이미 전체 공시 대상이므로 유지
        } else {
            byReportNo.set(reportNo, null);
        }
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
        }, {
            timeout: 30000,
            headers: CRAWL4AI_TOKEN ? { Authorization: `Bearer ${CRAWL4AI_TOKEN}` } : {}
        });

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

const normalizeReportRow = alioApi.normalizeReportRow;

/**
 * 캐시(reports.json)에 없는 (기관, 공시코드)의 공시 목록을 라이브 API로 조회.
 * 수시공시는 전 페이지, 정기공시는 itemOrganListJung 최신 스냅샷을 반환.
 * @returns {{ rows: object[], disclosure_kind: string }}
 */
async function fetchLiveReportRows(apbaId, reportFormRootNo, kindHint) {
    if (!apbaId || !reportFormRootNo) return { rows: [], disclosure_kind: kindHint || '' };

    try {
        const { rows, disclosure_kind } = await alioApi.fetchReportRows(apbaId, reportFormRootNo, kindHint);
        const normalized = rows
            .map(row => normalizeReportRow(row, reportFormRootNo))
            .map(row => ({ ...row, apba_id: row.apba_id || apbaId }));
        return { rows: normalized, disclosure_kind };
    } catch (err) {
        logger.info(`Live report lookup failed for ${apbaId}/${reportFormRootNo}: ${err.message}`);
        return { rows: [], disclosure_kind: kindHint || '' };
    }
}

async function downloadDocuments() {
    const institutions = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/institutions.json'), 'utf8'));
    const disclosureItems = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/disclosure_items.json'), 'utf8'));
    const crawlTargets = yaml.load(fs.readFileSync(path.join(__dirname, 'project/crawler/config/crawl_targets.yaml'), 'utf8'));
    const args = parseArgs(process.argv.slice(2));
    const retryTargets = loadRetryTargets(args.retryTargets);

    // reports.json은 선택사항 — 없으면 (기관, 공시코드)별 라이브 API 조회로 대체
    const reportsPath = path.join(__dirname, '../data/reports.json');
    const reports = fs.existsSync(reportsPath) ? JSON.parse(fs.readFileSync(reportsPath, 'utf8')) : [];
    if (reports.length === 0) {
        logger.info('reports.json 없음 — 공시 목록을 ALIO 라이브 API로 조회합니다.');
    }

    const { itemByCode, scopedCodes } = buildDisclosureLookup(disclosureItems, crawlTargets, args);

    if (args.printScope) {
        const scopedItems = new Map();
        for (const code of scopedCodes) {
            const item = itemByCode[code];
            if (item) scopedItems.set(item.scd, item);
        }
        console.log(`스코프 항목 ${scopedItems.size}개 / 공시코드 ${scopedCodes.size}개`);
        for (const item of scopedItems.values()) {
            const kind = item.disclosure_kind || (alioApi.PERIODIC_SCDS.has(item.scd) ? '정기' : '수시');
            console.log(`  ${item.scd}  [${kind}] ${item.major_category} > ${item.minor_category} > ${item.item_name} (${item.codes.join(',')})`);
        }
        return;
    }

    const structuredBase = path.join(__dirname, '../data/structured_data');
    const scopedReportFormNos = [...scopedCodes].sort();
    let scopedInstitutions = institutions.filter(inst => {
        if (args.ministry && inst.ministry !== args.ministry) return false;
        if (args.apbaIds && !args.apbaIds.has(inst.apba_id)) return false;
        if (args.instType && inst.type !== args.instType) return false;
        if (retryTargets && !retryTargets.has(inst.apba_id)) return false;
        return true;
    });
    if (args.limit > 0) scopedInstitutions = scopedInstitutions.slice(0, args.limit);

    const scopedReports = reports
        .filter(report => scopedCodes.has(String(report.report_form_root_no || '').trim()))
        .map(report => normalizeReportRow(report, report.report_form_root_no));

    logger.info(`Starting advanced download for ${scopedInstitutions.length} institutions, ${scopedCodes.size} codes${args.ministry ? ` in ministry: ${args.ministry}` : ''}${args.year ? ` (year=${args.year})` : ''}${retryTargets ? ` with retry targets: ${retryTargets.size} institutions` : ''}.`);

    for (const inst of scopedInstitutions) {
        const retryByReportNo = retryTargets ? (retryTargets.get(inst.apba_id) || new Map()) : null;
        const reportFormRootNos = retryByReportNo
            ? [...retryByReportNo.keys()].filter(code => scopedCodes.has(code))
            : scopedReportFormNos;

        for (const reportFormRootNo of reportFormRootNos) {
            const scopedItem = itemByCode[reportFormRootNo] || null;
            const kindHint = scopedItem?.disclosure_kind || null;

            const localReports = scopedReports.filter(report =>
                report.apba_id === inst.apba_id && report.report_form_root_no === reportFormRootNo
            );
            let liveKind = '';
            let reportsToProcess = localReports;
            if (reportsToProcess.length === 0) {
                const live = await fetchLiveReportRows(inst.apba_id, reportFormRootNo, kindHint);
                reportsToProcess = live.rows;
                liveKind = live.disclosure_kind;
            }

            // --year 필터 및 retry-targets의 disclosure_no 필터
            if (args.year) {
                reportsToProcess = reportsToProcess.filter(report => report.year === args.year);
            }
            const allowedDisclosures = retryByReportNo ? retryByReportNo.get(reportFormRootNo) : null;
            if (allowedDisclosures) {
                reportsToProcess = reportsToProcess.filter(report => allowedDisclosures.has(report.disclosure_no));
            }

            if (reportsToProcess.length === 0) continue;

            for (const report of reportsToProcess) {
                // 게시판형 항목(21110 내부규정 등)은 disclosureNo가 없음 —
                // 상세페이지 크롤링 대상이 아니므로 스킵 (내부규정은 collect_institution_bylaws.js가 담당)
                if (!report.disclosure_no) {
                    logger.info(`Skipping ${inst.apba_id}/${report.report_form_root_no}: disclosureNo 없음 (게시판형 항목)`);
                    continue;
                }

                const resolved = resolveDisclosureItem(report.report_form_root_no, itemByCode);
                const item = resolved.item;
                if (!item) continue;
                const disclosureKind = liveKind || item.disclosure_kind
                    || (alioApi.PERIODIC_SCDS.has(resolved.code) ? '정기' : '수시');

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
                        major_category: item.major_category || '',
                        disclosure_kind: disclosureKind
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
