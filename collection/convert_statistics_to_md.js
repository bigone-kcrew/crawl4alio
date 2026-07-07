const fs = require('fs');
const path = require('path');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

const PROCESSED_DIR = path.join(__dirname, '../data/processed/statistics');

function jsonToMarkdown(data) {
    let md = '';
    
    for (const sheetName in data) {
        md += `## ${sheetName}\n\n`;
        const rows = data[sheetName];
        if (!rows || rows.length === 0) continue;

        const headers = Object.keys(rows[0]);
        
        // Build table header
        md += `| ${headers.join(' | ')} |\n`;
        md += `| ${headers.map(() => '---').join(' | ')} |\n`;

        // Convert rows
        rows.forEach(row => {
            const values = headers.map(h => {
                const val = row[h];
                return val === null || val === undefined ? '' : String(val).replace(/\|/g, '\\|').replace(/\n/g, ' ');
            });
            md += `| ${values.join(' | ')} |\n`;
        });
        
        md += '\n';
    }
    
    return md;
}

async function run() {
    const files = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json'));
    
    logger.info(`Converting ${files.length} JSON statistics files to Markdown...`);

    for (const file of files) {
        const filePath = path.join(PROCESSED_DIR, file);
        const outputName = file.replace('.json', '.md');
        const outputPath = path.join(PROCESSED_DIR, outputName);

        logger.info(`Converting ${file} to Markdown...`);
        try {
            const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const mdContent = jsonToMarkdown(jsonData);
            fs.writeFileSync(outputPath, mdContent);
            logger.info(`Saved Markdown to ${outputName}`);
        } catch (err) {
            logger.error(`Failed to convert ${file}: ${err.message}`);
        }
    }

    logger.info('Markdown conversion completed.');
}

if (require.main === module) {
    run();
}
