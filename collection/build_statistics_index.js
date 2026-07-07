const fs = require('fs');
const path = require('path');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

const PROCESSED_DIR = path.join(__dirname, '../2_data/processed/statistics');
const INDEX_PATH = path.join(PROCESSED_DIR, 'index.json');

async function run() {
    if (!fs.existsSync(PROCESSED_DIR)) {
        logger.error(`Processed directory not found: ${PROCESSED_DIR}`);
        return;
    }

    const files = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
    
    logger.info(`Building index for ${files.length} statistics files...`);

    const index = {
        generated_at: new Date().toISOString(),
        total_categories: files.length,
        categories: []
    };

    for (const file of files) {
        const filePath = path.join(PROCESSED_DIR, file);
        const mdName = file.replace('.json', '.md');
        const rawName = file.replace('.json', '.xlsx').replace('공기업_반기_재정현황.json', '공기업_반기_재정현황.xls');
        
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const sheetNames = Object.keys(data);
            
            let totalRowCount = 0;
            let institutionSet = new Set();
            let sampleColumns = [];
            
            sheetNames.forEach(sheet => {
                if (Array.isArray(data[sheet])) {
                    totalRowCount += data[sheet].length;
                    data[sheet].forEach(row => {
                        if (row['기관명']) institutionSet.add(row['기관명']);
                    });
                    if (sampleColumns.length === 0 && data[sheet].length > 0) {
                        sampleColumns = Object.keys(data[sheet][0]);
                    }
                }
            });

            index.categories.push({
                id: file.replace('.json', ''),
                name: file.replace('.json', ''),
                json_path: file,
                markdown_path: mdName,
                raw_path: `../../raw/statistics/${rawName}`,
                institution_count: institutionSet.size,
                row_count: totalRowCount,
                sheets: sheetNames,
                columns: sampleColumns,
                updated_at: fs.statSync(filePath).mtime.toISOString()
            });
            
        } catch (err) {
            logger.error(`Failed to index ${file}: ${err.message}`);
        }
    }

    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    logger.info(`Saved statistics index to ${INDEX_PATH}`);
}

if (require.main === module) {
    run();
}
