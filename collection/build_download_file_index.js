const fs   = require('fs');
const path = require('path');
const { fromCatalogRoot } = require('./project/crawler/utils/paths');
const { rebuildStructuredDownloadFileIndex, DOWNLOAD_FILE_INDEX_FILE_NAME, resolveRawBase, originalFileExists } = require('./project/crawler/utils/structured_explorer');

// CONVERTIBLE_EXTS: ZIP 추출 대상 확장자
const CONVERTIBLE_EXTS = new Set(['.pdf', '.hwp', '.hwpx', '.hwpml', '.xlsx', '.xls', '.docx']);

function walk(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walk(full));
        else results.push(full);
    }
    return results;
}

function main() {
    const structuredBase = fromCatalogRoot('structured_data');
    const indexPath = path.join(structuredBase, DOWNLOAD_FILE_INDEX_FILE_NAME);

    // 1. 기존 인덱스 보존 (rebuild 전에 읽어둠)
    let preserved = [];
    if (fs.existsSync(indexPath)) {
        const existing = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        preserved = existing.files || [];
    }
    const preservedById = new Map(preserved.map(f => [f.id, f]));

    // 2. manifest 기반 rebuild (새 항목 생성)
    const rebuildFiles = rebuildStructuredDownloadFileIndex(structuredBase);
    const rebuildIds = new Set(rebuildFiles.map(f => f.id));
    console.log(`manifest 기반 항목: ${rebuildFiles.length}건`);

    // 3. 기존 인덱스 중 rebuild에 없는 항목 전부 보존 (이력 목적)
    // rebuild가 덮어쓰지 않은 항목: 다른 공시의 파일, ZIP 추출 파일, 수동 추가 파일 등
    const merged = [...rebuildFiles];
    let kept = 0;
    for (const [id, entry] of preservedById) {
        if (rebuildIds.has(id)) continue; // rebuild가 최신 정보로 덮어씀
        // 기관정보 없는 오염 엔트리(게시판 메타 오인 혼입, id '::…') 승계 차단
        if (!id || id.startsWith('::')) continue;
        // downloaded 상태를 디스크 실제 값으로 갱신 (raw 미러 우선, md 폴백)
        const onDisk = entry.file_path ? originalFileExists(structuredBase, entry.file_path) : (entry.downloaded === true);
        merged.push({ ...entry, downloaded: onDisk });
        kept++;
    }
    console.log(`기존 항목 보존: ${kept}건`);

    // 4. ZIP 추출 파일 추가 (add_zip_extracted_to_index.js 로직 인라인)
    const mergedIds = new Set(merged.map(f => f.id));
    const mergedPaths = new Set(merged.map(f => f.file_path));
    const zipEntries = merged.filter(f => f.file_name?.toLowerCase().endsWith('.zip'));
    const zipAdded = [];
    let zipSkipped = 0;

    const rawBase = resolveRawBase(structuredBase);
    for (const zip of zipEntries) {
        // 추출 디렉터리: raw 미러 우선(원본 바이너리 위치), md 폴백(단일 트리 하위호환)
        const extractRel = zip.file_path.replace(/\.zip$/i, '');
        const candidates = rawBase
            ? [{ base: rawBase, dir: path.join(rawBase, extractRel) }, { base: structuredBase, dir: path.join(structuredBase, extractRel) }]
            : [{ base: structuredBase, dir: path.join(structuredBase, extractRel) }];
        const hit = candidates.find(c => fs.existsSync(c.dir));
        if (!hit) { zipSkipped++; continue; }
        const extractDir = hit.dir;

        for (const absFile of walk(extractDir)) {
            const ext = path.extname(absFile).toLowerCase();
            if (!CONVERTIBLE_EXTS.has(ext)) continue;
            const relPath    = path.relative(hit.base, absFile);
            if (mergedPaths.has(relPath)) continue;
            const zipDirRel  = path.relative(extractDir, absFile);
            const id         = `${zip.apba_id}:${zip.scd}:${zip.disclosure_no}:zip:${zipDirRel}`;
            if (mergedIds.has(id)) continue;

            zipAdded.push({
                id,
                report_id:           zip.report_id,
                institution_name:    zip.institution_name,
                ministry:            zip.ministry,
                apba_id:             zip.apba_id,
                scd:                 zip.scd,
                report_form_root_no: zip.report_form_root_no,
                report_nos:          zip.report_nos,
                item_name:           zip.item_name,
                minor_category:      zip.minor_category,
                major_category:      zip.major_category,
                year:                zip.year,
                disclosure_no:       zip.disclosure_no,
                submission_no:       zip.submission_no,
                report_title:        zip.report_title,
                source_url:          zip.source_url,
                manifest_path:       zip.manifest_path,
                file_name:           path.basename(absFile),
                file_label:          path.basename(absFile),
                file_path:           relPath,
                download_url:        null,
                downloaded:          true,
                from_zip:            zip.file_path,
            });
            mergedIds.add(id);
            mergedPaths.add(relPath);
        }
    }
    console.log(`ZIP 추출 파일 추가: ${zipAdded.length}건`);

    // 5. 정렬 후 저장
    const allFiles = [...merged, ...zipAdded];
    allFiles.sort((a, b) => {
        const ka = [a.institution_name, a.scd, a.year, a.file_name, a.id].join('\0');
        const kb = [b.institution_name, b.scd, b.year, b.file_name, b.id].join('\0');
        return ka.localeCompare(kb);
    });

    const payload = {
        generated_at: new Date().toISOString(),
        total_files:  allFiles.length,
        files:        allFiles,
    };
    const tmp = indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, indexPath);

    console.log(`인덱스 저장 완료: ${allFiles.length}건`);
}

main();
