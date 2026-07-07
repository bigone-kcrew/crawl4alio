const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

const BASE_URL = 'https://www.alio.go.kr';
const REFERER = `${BASE_URL}/statistics/statisticsDownload.do`;
const RAW_DIR = path.join(__dirname, '../2_data/raw/statistics');

const STATISTICS_MAP = [
    { code: 'excelDrop2020', name: '임직원수현황.xlsx' },
    { code: 'excelDrop2040', name: '신규채용현황.xlsx' },
    { code: 'excelDrop20501', name: '임원연봉.xlsx' },
    { code: 'excelDrop20601', name: '직원평균보수현황.xlsx' },
    { code: 'excelDrop20701', name: '기관장업무추진비.xlsx' },
    { code: 'excelDrop20801', name: '복리후생비.xlsx' },
    { code: 'excelDrop63701', name: '그밖의_복리후생제도_등의_운영현황.xlsx' },
    { code: 'excelDrop21401', name: '일가정_양립_지원제도_운영현황.xlsx' },
    { code: 'excelDrop31401', name: '수입지출현황.xlsx' },
    { code: 'excelDrop32211', name: '법인세정보.xlsx' }
];

async function downloadFile(url, savePath) {
    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'Referer': REFERER,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 60000
        });

        const writer = fs.createWriteStream(savePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        throw new Error(`Failed to download ${url}: ${err.message}`);
    }
}

async function run() {
    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
    }

    logger.info('Starting ALIO Statistics Excel Download...');

    for (const item of STATISTICS_MAP) {
        const encodedName = encodeURIComponent(item.name);
        const url = `${BASE_URL}/download/statisticsDown.json?f=${encodedName}&s=${item.code}.xlsx`;
        const savePath = path.join(RAW_DIR, item.name);

        logger.info(`Downloading ${item.name}...`);
        try {
            await downloadFile(url, savePath);
            logger.info(`Successfully downloaded ${item.name}`);
        } catch (err) {
            logger.error(err.message);
        }
    }

    // Special case: Half-year statistics
    logger.info('Downloading 공기업 반기 재정현황...');
    try {
        const halfUrl = `${BASE_URL}/download/statisticsHalf.json`;
        const halfSavePath = path.join(RAW_DIR, '공기업_반기_재정현황.xls');
        await downloadFile(halfUrl, halfSavePath);
        logger.info('Successfully downloaded 공기업_반기_재정현황.xls');
    } catch (err) {
        logger.error(`Failed to download half-year statistics: ${err.message}`);
    }

    logger.info('Statistics download completed.');
}

if (require.main === module) {
    run();
}
