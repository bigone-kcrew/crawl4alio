const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

const BASE_URL = 'https://www.alio.go.kr';
const RECENT_LIST_API = `${BASE_URL}/status/findDisclosureList.json`;
const INDEX_PATH = path.join(__dirname, '../2_data/structured_data/index.json');
const RETRY_TARGETS_PATH = path.join(__dirname, '../2_data/logs/recency_retry_targets.json');

async function fetchRecentDisclosures() {
    try {
        const response = await axios.get(RECENT_LIST_API, {
            params: { endNum: 50 }, // Get last 50 updates
            headers: {
                'Referer': `${BASE_URL}/status/disclosureStatus.do`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        return response.data?.data?.disclosureList || [];
    } catch (err) {
        logger.error(`Failed to fetch recent disclosures: ${err.message}`);
        return [];
    }
}

async function run() {
    logger.info('Starting disclosure recency check...');

    if (!fs.existsSync(INDEX_PATH)) {
        logger.error('Base index.json not found. Cannot compare recency.');
        return;
    }

    const indexData = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const existingDisclosureNos = new Set(indexData.documents.map(doc => doc.id.split(':')[2])); // Extract disclosureNo from ID

    const recentList = await fetchRecentDisclosures();
    logger.info(`Fetched ${recentList.length} recent disclosures from ALIO.`);

    const newTargets = [];

    for (const item of recentList) {
        if (!existingDisclosureNos.has(item.disclosureNo)) {
            logger.info(`[NEW] Detected new disclosure: ${item.title} (${item.pname}) - ${item.disclosureNo}`);
            newTargets.push({
                disclosure_no: item.disclosureNo,
                institution_name: item.pname,
                title: item.title,
                report_form_no: item.reportFormNo,
                detected_at: new Date().toISOString()
            });
        }
    }

    if (newTargets.length > 0) {
        fs.writeFileSync(RETRY_TARGETS_PATH, JSON.stringify(newTargets, null, 2));
        logger.info(`Saved ${newTargets.length} new targets to ${RETRY_TARGETS_PATH}`);
        
        // In a real scenario, we would trigger download_documents_advanced.js with these targets.
        console.log(`\nFound ${newTargets.length} new/updated disclosures to process.`);
    } else {
        logger.info('No new disclosures detected.');
    }

    logger.info('Recency check completed.');
}

if (require.main === module) {
    run();
}
