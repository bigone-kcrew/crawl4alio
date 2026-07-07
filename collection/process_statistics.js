const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

const RAW_DIR = path.join(__dirname, '../2_data/raw/statistics');
const PROCESSED_DIR = path.join(__dirname, '../2_data/processed/statistics');

function processExcelFile(filePath, fileName) {
    const workbook = XLSX.readFile(filePath);
    const result = {};

    workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        // Read with header row offset if needed. 
        // ALIO files usually have units in row 1, headers in row 2.
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        if (rows.length < 2) return;

        let headerRowIndex = 0;
        // Find header row (usually the one containing '기관명')
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
            if (rows[i] && rows[i].includes('기관명')) {
                headerRowIndex = i;
                break;
            }
        }

        const headers = rows[headerRowIndex];
        const dataRows = rows.slice(headerRowIndex + 1);

        const structuredData = dataRows.map(row => {
            const obj = {};
            headers.forEach((header, index) => {
                if (header) {
                    obj[header] = row[index] !== undefined ? row[index] : null;
                }
            });
            return obj;
        }).filter(obj => obj['기관명']); // Filter out empty rows

        result[sheetName] = structuredData;
    });

    return result;
}

async function run() {
    if (!fs.existsSync(PROCESSED_DIR)) {
        fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    }

    const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'));
    
    logger.info(`Processing ${files.length} statistics files...`);

    for (const file of files) {
        const filePath = path.join(RAW_DIR, file);
        const outputName = file.replace(/\.(xlsx|xls)$/, '.json');
        const outputPath = path.join(PROCESSED_DIR, outputName);

        logger.info(`Processing ${file}...`);
        try {
            const processedData = processExcelFile(filePath, file);
            fs.writeFileSync(outputPath, JSON.stringify(processedData, null, 2));
            logger.info(`Saved processed data to ${outputName}`);
        } catch (err) {
            logger.error(`Failed to process ${file}: ${err.message}`);
        }
    }

    logger.info('Statistics processing completed.');
}

if (require.main === module) {
    run();
}
