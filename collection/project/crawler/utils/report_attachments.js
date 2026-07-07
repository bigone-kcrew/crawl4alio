const cheerio = require('cheerio');

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractReportSubmissionNo(reportHtml) {
    const text = String(reportHtml || '');
    const match = text.match(/submission_no[^]*?value="([^"]+)"/);
    return match ? match[1].trim() : '';
}

function extractReportDocPath(reportHtml) {
    const text = String(reportHtml || '');
    const match = text.match(/\.load\("([^"]+\/doc\.html)"/);
    return match ? match[1].trim() : '';
}

function extractSelectedFileAttachments(reportHtml, disclosureNo) {
    const $ = cheerio.load(String(reportHtml || ''));
    const submissionNo = extractReportSubmissionNo(reportHtml);
    const attachments = [];

    $('#reportFileDown option').each((_, option) => {
        const fileNo = normalizeText($(option).attr('value'));
        if (!fileNo) return;

        const fileName = normalizeText($(option).text());
        attachments.push({
            source_type: 'report_file',
            name: fileName,
            file_name: fileName,
            file_no: fileNo,
            disclosure_no: String(disclosureNo || '').trim(),
            submission_no: submissionNo,
            download_url: buildReportFileDownloadUrl(disclosureNo, fileNo)
        });
    });

    return attachments;
}

function extractDocumentAttachments(docHtml, disclosureNo, submissionNo) {
    const $ = cheerio.load(String(docHtml || ''));
    const attachments = [];

    $('a[href^="javascript:report_attach_down"]').each((_, link) => {
        const href = normalizeText($(link).attr('href'));
        const match = href.match(/report_attach_down\('([^']+)'\)/);
        if (!match) return;

        const fileName = match[1].trim();
        if (!fileName) return;

        attachments.push({
            source_type: 'content_file',
            name: fileName,
            file_name: fileName,
            disclosure_no: String(disclosureNo || '').trim(),
            submission_no: String(submissionNo || '').trim(),
            download_url: buildReportContentDownloadUrl(fileName, submissionNo)
        });
    });

    return attachments;
}

function buildReportFileDownloadUrl(disclosureNo, fileNo) {
    const params = [];
    if (fileNo) params.push(`f=${encodeURIComponent(String(fileNo))}`);
    if (disclosureNo) params.push(`d=${encodeURIComponent(String(disclosureNo))}`);
    return params.length ? `/download/file.json?${params.join('&')}` : '';
}

function buildReportContentDownloadUrl(fileName, submissionNo) {
    const params = [];
    if (fileName) params.push(`fileName=${encodeURIComponent(String(fileName))}`);
    if (submissionNo) params.push(`submissionNo=${encodeURIComponent(String(submissionNo))}`);
    return params.length ? `/download/dfile.json?${params.join('&')}` : '';
}

function dedupeAttachments(attachments) {
    const seen = new Set();
    const unique = [];

    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        const key = attachment?.file_name || attachment?.file_no || attachment?.download_url || attachment?.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(attachment);
    }

    return unique;
}

function extractReportAttachments({ reportHtml = '', docHtml = '', disclosureNo = '' } = {}) {
    const submissionNo = extractReportSubmissionNo(reportHtml);
    const attachments = dedupeAttachments([
        ...extractSelectedFileAttachments(reportHtml, disclosureNo),
        ...extractDocumentAttachments(docHtml, disclosureNo, submissionNo)
    ]);

    return {
        submissionNo,
        docPath: extractReportDocPath(reportHtml),
        attachments
    };
}

module.exports = {
    buildReportContentDownloadUrl,
    buildReportFileDownloadUrl,
    dedupeAttachments,
    extractDocumentAttachments,
    extractReportAttachments,
    extractReportDocPath,
    extractReportSubmissionNo,
    extractSelectedFileAttachments
};
