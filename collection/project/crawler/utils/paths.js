
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../../../');
const collectionRoot = path.resolve(__dirname, '../../../');
const crawlerRoot = path.join(collectionRoot, 'project', 'crawler');
const catalogRoot = path.join(repoRoot, 'data');
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
