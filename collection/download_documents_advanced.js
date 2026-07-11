const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));
const { fromCatalogRoot, fromLogsRoot } = require(path.join(__dirname, 'project/crawler/utils/paths'));
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
// 첨부파일 동시 다운로드 수. 첨부는 ALIO 직결(crawl4ai 아님)이라 병렬 안전.
// 보고서 본문 스크래핑(crawl4ai)은 report별 순차 유지 — 단일 컨테이너 부하 보호.
const ATTACH_CONCURRENCY = Number(process.env.DOWNLOAD_ATTACH_CONCURRENCY || 4);

// 최대 limit개를 동시에 실행하며 items를 순회한다.
async function runPool(items, limit, worker) {
    const executing = new Set();
    for (const item of items) {
        const p = Promise.resolve().then(() => worker(item)).finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
}

// ── report-level 체크포인트 ──
// raw를 오프사이트로 옮겨 로컬에서 삭제해도, disclosureNo 기준으로 이미 수집한 report를
// 스킵할 수 있게 한다(디스크 존재 여부 무관). 샤드 병렬 시 SKIP_DOWNLOAD_CKPT=1로 race 회피.
function loadDownloadCkpt(p) {
    try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return { done: {} }; }
}
function saveDownloadCkpt(p, ckpt) {
    const fs = require('fs'); const tmp = p + '.tmp';
    fs.mkdirSync(require('path').dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ckpt, null, 2));
    fs.renameSync(tmp, p); // atomic
}

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
            case '--attach-only-items': args.attachOnlyItems = new Set(parseList(takeValue())); break;
            case '--apba-ids': args.apbaIds = new Set(parseList(takeValue())); break;
            case '--inst-type': args.instType = takeValue().trim(); break;
            case '--print-scope': args.printScope = true; break;
            case '--recheck': args.recheck = true; break;   // 체크포인트 무시하고 전 report 재처리
            case '--ckpt': args.ckptPath = takeValue(); break;
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

// socket hang up / ECONNRESET는 alio의 keep-alive 연결 종료 때문 — Connection: close + 재시도로 회피
function isTransientNetErr(err) {
    const m = (err && (err.code || err.message) || '').toString();
    return /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|aborted/i.test(m);
}
async function getWithRetry(url, opts, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await axios.get(url, { ...opts, headers: { Connection: 'close', ...(opts && opts.headers) } });
        } catch (err) {
            lastErr = err;
            if (attempt < retries && isTransientNetErr(err)) {
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

async function fetchHtml(url) {
    if (!url) return '';

    try {
        const response = await getWithRetry(url, { timeout: 30000 });
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
        const response = await getWithRetry('https://www.alio.go.kr/download/pdf.json', {
            params: { disclosureNo },
            timeout: 20000
        });
        return response.data || null;
    } catch (err) {
        logger.info(`pdf.json unavailable for ${disclosureNo}: ${err.message}`);
        return null;
    }
}

// 첨부 1건 확보 (ALIO 직결 스트림). 파일 존재 시 크기 비교 후 스킵/_alt, 없으면 신규.
// 한 report 내 파일명은 호출 전 dedup되어 destPath가 유일 → 동시 실행 안전(경합 없음).
async function downloadAttachment(att, yearDir) {
    const filePath = path.join(yearDir, att.file_name);
    if (fs.existsSync(filePath)) {
        const existingSize = fs.statSync(filePath).size;
        const tmpPath = filePath + '.__tmp';
        try {
            const response = await axios.get(att.download_url, { responseType: 'stream', timeout: 60000 });
            const writer = fs.createWriteStream(tmpPath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); response.data.on('error', reject); });
            const newSize = fs.statSync(tmpPath).size;
            if (newSize === existingSize) {
                fs.unlinkSync(tmpPath);
            } else {
                const ext = path.extname(filePath);
                const base = path.basename(filePath, ext);
                const dir = path.dirname(filePath);
                let n = 2; let altPath;
                do { altPath = path.join(dir, `${base}_alt${n}${ext}`); n++; } while (fs.existsSync(altPath));
                fs.renameSync(tmpPath, altPath);
                logger.info(`Downloading (alt): ${path.basename(altPath)}`);
            }
        } catch (err) {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
        return;
    }
    try {
        logger.info(`Downloading: ${att.name || att.file_name}`);
        const response = await getWithRetry(att.download_url, { responseType: 'stream', timeout: 60000 });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); response.data.on('error', reject); });
    } catch (err) {
        logger.error(`Download failed: ${att.name || att.file_name}: ${err.message}`);
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
    const institutions = JSON.parse(fs.readFileSync(fromCatalogRoot('institutions.json'), 'utf8'));
    const disclosureItems = JSON.parse(fs.readFileSync(fromCatalogRoot('disclosure_items.json'), 'utf8'));
    const crawlTargets = yaml.load(fs.readFileSync(path.join(__dirname, 'project/crawler/config/crawl_targets.yaml'), 'utf8'));
    const args = parseArgs(process.argv.slice(2));
    const retryTargets = loadRetryTargets(args.retryTargets);

    // report-level 체크포인트 (raw 삭제 후 증분 수집용). SKIP_DOWNLOAD_CKPT=1이면 비활성(샤드 병렬 시).
    const DL_CKPT = process.env.SKIP_DOWNLOAD_CKPT ? null : (args.ckptPath || fromLogsRoot('download_ckpt.json'));
    const dlCkpt = DL_CKPT ? loadDownloadCkpt(DL_CKPT) : { done: {} };
    let ckptDirty = 0;

    // reports.json은 선택사항 — 없으면 (기관, 공시코드)별 라이브 API 조회로 대체
    const reportsPath = fromCatalogRoot('reports.json');
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

    const structuredBase = fromCatalogRoot('structured_data');
    // 원본 바이너리 저장 루트(raw). 메타(content.json/manifest 등)는 structuredBase(alio-md)에 유지,
    // 첨부 원본만 alio-raw 미러로 분리. 미지정 시 structuredBase 실경로의 alio-md→alio-raw 치환.
    const rawBase = process.env.ALIO_RAW_BASE
        || (() => { try { return fs.realpathSync(structuredBase).replace('/alio-md/', '/alio-raw/'); } catch { return structuredBase; } })();
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

                // 체크포인트 스킵 — 이미 수집한 report는 raw 유무와 무관하게 건너뜀 (idate 변경 시 재처리)
                // retry-targets로 명시된 report는 개정 재수집이므로 ckpt 우회.
                if (DL_CKPT && !args.recheck && !allowedDisclosures) {
                    const prev = dlCkpt.done[report.disclosure_no];
                    const idate = String(report.idate || report.critYyyy || '');
                    if (prev && (!prev.idate || !idate || prev.idate === idate)) continue;
                }

                const resolved = resolveDisclosureItem(report.report_form_root_no, itemByCode);
                const item = resolved.item;
                if (!item) continue;
                const disclosureKind = liveKind || item.disclosure_kind
                    || (alioApi.PERIODIC_SCDS.has(resolved.code) ? '정기' : '수시');

                // 첨부전용 항목(예: 이사회 43005): 본문 가치 없음 → crawl4ai 스킵, 첨부만 수집
                const attachOnly = args.attachOnlyItems && args.attachOnlyItems.has(String(report.report_form_root_no || '').trim());

                logger.info(`Processing: ${inst.name} - ${report.report_form_root_no}${attachOnly ? ' [attach-only]' : ''}`);
                const detailUrl = `https://www.alio.go.kr/item/itemReportTerm.do?apbaId=${inst.apba_id}&reportFormRootNo=${report.report_form_root_no}&disclosureNo=${report.disclosure_no}`;
                const reportUrl = `https://www.alio.go.kr/item/itemReport.do?seq=${report.disclosure_no}&disclosureNo=${report.disclosure_no}`;

                // 서로 독립적인 네트워크 호출을 병렬 실행 (report당 ~8s 병목의 대부분).
                // 각 함수는 내부 try/catch로 실패 시 null/'' 반환 → Promise.all이 reject되지 않음.
                let crawlResult, pdfJson, reportHtml;
                if (attachOnly) {
                    [pdfJson, reportHtml] = await Promise.all([
                        fetchPdfJson(report.disclosure_no),
                        fetchHtml(reportUrl)
                    ]);
                    // crawl4ai 스킵 → 하위 코드 null-safe용 빈 스텁 (content.md/sections.json 자동 생략)
                    crawlResult = { sections: { headings: [], tocEntries: [] }, json: null, markdown: '', files: [] };
                } else {
                    [crawlResult, pdfJson, reportHtml] = await Promise.all([
                        scrapeWithCrawl4AI(detailUrl),
                        fetchPdfJson(report.disclosure_no),
                        fetchHtml(reportUrl)
                    ]);
                    if (!crawlResult || !hasMeaningfulOutput(crawlResult)) {
                        logger.info(`Skipping ${report.disclosure_no}: no Crawl4AI output.`);
                        continue;
                    }
                }

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

                // 파일명 기준 dedup (순차·저비용) — attachments는 manifest용, toDownload는 실제 다운로드 대상
                const seenNames = new Set();
                const toDownload = [];
                for (const att of attachmentSources) {
                    if (!att.download_url) continue;
                    if (seenNames.has(att.file_name)) continue;
                    seenNames.add(att.file_name);
                    attachments.push(att);
                    toDownload.push(att);
                }
                // 첨부 다운로드만 병렬 (ALIO 직결). dedup으로 destPath 유일 → 경합 없음.
                // 원본 바이너리는 alio-raw 미러 경로로 저장(메타는 alio-md yearDir 유지).
                const rawYearDir = path.join(rawBase, path.relative(structuredBase, yearDir));
                fs.mkdirSync(rawYearDir, { recursive: true });
                await runPool(toDownload, ATTACH_CONCURRENCY, att => downloadAttachment(att, rawYearDir));

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
                // 샤드 병렬 실행 시 공유 인덱스 파일 race 방지 — 수집 중 upsert 스킵(Stage C/D에서 인덱스 재생성).
                if (!process.env.SKIP_STRUCTURED_INDEX) {
                    upsertStructuredIndex(structuredBase, yearDir, explorerManifest);
                }
                // 체크포인트 기록 (disclosureNo 기준). 주기적 저장으로 I/O 절감.
                if (DL_CKPT) {
                    dlCkpt.done[report.disclosure_no] = {
                        form: report.report_form_root_no,
                        idate: String(report.idate || report.critYyyy || ''),
                        at: new Date().toISOString(),
                    };
                    if (++ckptDirty % 25 === 0) saveDownloadCkpt(DL_CKPT, dlCkpt);
                }
            }
        }
    }
    if (DL_CKPT && ckptDirty) saveDownloadCkpt(DL_CKPT, dlCkpt);  // 최종 저장
}

if (require.main === module) {
    downloadDocuments();
}

module.exports = {
    loadRetryTargets,
    parseArgs
};
