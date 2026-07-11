
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../../../');
const collectionRoot = path.resolve(__dirname, '../../../');
const crawlerRoot = path.join(collectionRoot, 'project', 'crawler');
// CATALOG_ROOT: 데이터 카탈로그 루트 override.
// 별도 데이터 폴더 운영 시(예: CATALOG_ROOT=/workspace/alio/2_data) 심링크 없이
// structured_data·logs·체크포인트가 전부 그 아래로 일관 배치된다.
const catalogRoot = process.env.CATALOG_ROOT
    ? path.resolve(process.env.CATALOG_ROOT)
    : path.join(repoRoot, 'data');
const processedDataRoot = path.join(catalogRoot, 'data');
const logsRoot = path.join(catalogRoot, 'logs');

function fromRepoRoot(...segments) {
    return path.join(repoRoot, ...segments);
}

function fromCollectionRoot(...segments) {
    return path.join(collectionRoot, ...segments);
}

function fromCrawlerRoot(...segments) {
    return path.join(crawlerRoot, ...segments);
}

function fromCatalogRoot(...segments) {
    return path.join(catalogRoot, ...segments);
}

function fromProcessedDataRoot(...segments) {
    return path.join(processedDataRoot, ...segments);
}

function fromLogsRoot(...segments) {
    return path.join(logsRoot, ...segments);
}

module.exports = {
    repoRoot,
    collectionRoot,
    crawlerRoot,
    catalogRoot,
    processedDataRoot,
    logsRoot,
    fromRepoRoot,
    fromCollectionRoot,
    fromCrawlerRoot,
    fromCatalogRoot,
    fromProcessedDataRoot,
    fromLogsRoot
};
