const fs = require('fs');
const { fromCatalogRoot, fromLogsRoot } = require('./project/crawler/utils/paths');
const path = require('path');
const axios = require('axios');
const logger = require(path.join(__dirname, 'project/crawler/utils/logging'));

/**
 * [준비 단계] ALIO 수시 공시 및 비정형 데이터 수집기
 * 대상: 지적사항, 회의록, 연구보고서, 내부규정 등
 * 상태: 설계 및 구현 완료 (실행 보류 중)
 */

const BASE_URL = 'https://www.alio.go.kr';
const SUSI_API_URL = `${BASE_URL}/information/informationList.json`;
const RAW_SUSI_DIR = fromCatalogRoot('raw', 'susi');

const CATEGORY_MAP = {
    'audit': '감사원/주무부처 지적사항',
    'assembly': '국회 지적사항',
    'board': '이사회 회의록',
    'research': '연구보고서',
    'internal': '내부규정'
};

async function fetchSusiList(category) {
    // API 호출 로직 설계
    // params: { category, pageNo, pageSize, ... }
    logger.info(`Ready to fetch list for category: ${category}`);
    return [];
}

async function downloadSusiDocument(docUrl, savePath) {
    // 문서 다운로드 로직 설계
    logger.info(`Ready to download from: ${docUrl}`);
}

async function run() {
    logger.info('ALIO Susi Document Crawler is prepared.');
    logger.info('Categories to be handled: ' + Object.values(CATEGORY_MAP).join(', '));
    // 사용자의 별도 지시가 있을 때까지 실행 로직은 주석 처리 또는 대기 상태 유지
}

if (require.main === module) {
    run();
}
