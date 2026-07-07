#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');

function printUsage() {
  console.log([
    'Usage:',
    '  node ocrtomarkdown/ocr-to-markdown.js <input-file-or-dir> [options]',
    '',
    'Options:',
    '  --output-dir <dir>   Output directory for .md files (default: same folder as input)',
    '  --timeout <ms>       Force timeout per request in milliseconds',
    '  --retries <n>        Retry count after the first failure (default: 1)',
    '  --no-frontmatter     Disable YAML frontmatter in output',
    '  --base-url <url>     Override PaddleOCR parse endpoint',
    '  --help               Show this help',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    inputs: [],
    outputDir: '',
    timeout: null,
    retries: 1,
    frontmatter: true,
    baseUrl: '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      return args;
    }
    if (arg === '--output-dir') {
      args.outputDir = path.resolve(process.cwd(), argv[++i] || '');
      continue;
    }
    if (arg === '--timeout') {
      args.timeout = Number(argv[++i] || 0);
      continue;
    }
    if (arg === '--retries') {
      args.retries = Math.max(0, Number(argv[++i] || 0));
      continue;
    }
    if (arg === '--no-frontmatter') {
      args.frontmatter = false;
      continue;
    }
    if (arg === '--base-url') {
      args.baseUrl = String(argv[++i] || '');
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    args.inputs.push(path.resolve(process.cwd(), arg));
  }

  return args;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadEnvFile() {
  const candidates = [];
  let current = process.cwd();
  for (;;) {
    candidates.push(path.join(current, '.env.parsers'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  candidates.push(path.resolve(__dirname, '..', '.env.parsers'));

  for (const filePath of candidates) {
    if (!(await pathExists(filePath))) {
      continue;
    }
    const text = await fs.readFile(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    return filePath;
  }

  return '';
}

async function walkPdfFiles(entry, files = []) {
  const stat = await fs.stat(entry);
  if (stat.isFile()) {
    if (path.extname(entry).toLowerCase() === '.pdf') {
      files.push(entry);
    }
    return files;
  }

  const entries = await fs.readdir(entry, { withFileTypes: true });
  for (const item of entries) {
    await walkPdfFiles(path.join(entry, item.name), files);
  }
  return files;
}

function getParseUrl(baseUrl, envParseUrl, envBaseUrl) {
  if (baseUrl) return baseUrl;
  if (envParseUrl) return envParseUrl;
  if (envBaseUrl) return `${envBaseUrl.replace(/\/$/, '')}/parse`;
  return '';
}

function buildTimeout(bytes, forcedTimeout) {
  if (Number.isFinite(forcedTimeout) && forcedTimeout > 0) {
    return forcedTimeout;
  }
  const mb = bytes / (1024 * 1024);
  const estimate = 180000 + Math.ceil(mb * 42000);
  return Math.max(180000, Math.min(estimate, 3600000));
}

function buildOutputPath(inputPath, inputRoot, outputDir) {
  const sourceDir = path.dirname(inputPath);
  const fileName = path.basename(inputPath, path.extname(inputPath)) + '.md';
  if (!outputDir) {
    return path.join(sourceDir, fileName);
  }
  const relative = inputRoot
    ? path.relative(inputRoot, inputPath)
    : path.basename(inputPath);
  const stem = relative.replace(/\.pdf$/i, '.md');
  return path.join(outputDir, stem);
}

function deriveContext(inputPath) {
  const parts = inputPath.split(path.sep).filter(Boolean);
  const structuredIdx = parts.lastIndexOf('structured_data');
  if (structuredIdx >= 0 && parts.length >= structuredIdx + 4) {
    return {
      institution: parts[structuredIdx + 1] || '',
      scd: parts[structuredIdx + 2] || '',
      year: parts[structuredIdx + 3] || '',
    };
  }

  const parentParts = parts.slice(0, -1);
  return {
    institution: parentParts[parentParts.length - 3] || '',
    scd: parentParts[parentParts.length - 2] || '',
    year: parentParts[parentParts.length - 1] || '',
  };
}

function buildMarkdown(content, meta) {
  const body = String(content || '').trim();
  if (!meta.frontmatter) {
    return `${body}\n`;
  }

  const frontmatter = yaml.dump({
    source_file: meta.sourceFile,
    source_path: meta.sourcePath,
    source_dir: meta.sourceDir,
    institution: meta.institution,
    scd: meta.scd,
    year: meta.year,
    ocr_service: meta.ocrService,
    processed_at: meta.processedAt,
    source_bytes: meta.sourceBytes,
    source_ext: 'pdf',
  }, { lineWidth: -1 });

  return `---\n${frontmatter}---\n\n${body}\n`;
}

async function postPdfToOcr(parseUrl, inputPath, timeoutMs) {
  const buffer = await fs.readFile(inputPath);
  const form = new FormData();
  const blob = new Blob([buffer], { type: 'application/pdf' });
  form.append('file', blob, path.basename(inputPath));

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await axios.post(parseUrl, form, {
      signal: controller.signal,
      headers: form.getHeaders ? form.getHeaders() : undefined,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      validateStatus: () => true,
    });

    return {
      status: response.status,
      data: response.data,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function convertOne({ inputPath, inputRoot, outputDir, parseUrl, timeout, retries, frontmatter }) {
  const stat = await fs.stat(inputPath);
  const targetPath = buildOutputPath(inputPath, inputRoot, outputDir);
  const context = deriveContext(inputPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const timeoutMs = buildTimeout(stat.size, timeout);
  const attempts = retries + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const result = await postPdfToOcr(parseUrl, inputPath, timeoutMs * (attempt === 1 ? 1 : 1.5));
      const markdown = String(result?.data?.result?.markdown || result?.data?.markdown || '').trim();

      if (!markdown) {
        const message = result?.data?.error?.message || result?.data?.message || `OCR response missing markdown (status ${result.status})`;
        throw new Error(message);
      }

      const output = buildMarkdown(markdown, {
        frontmatter,
        sourceFile: path.basename(inputPath),
        sourcePath: inputPath,
        sourceDir: path.dirname(inputPath),
        institution: context.institution,
        scd: context.scd,
        year: context.year,
        ocrService: parseUrl,
        processedAt: new Date().toISOString(),
        sourceBytes: stat.size,
      });

      await fs.writeFile(targetPath, output, 'utf8');

      return {
        ok: true,
        inputPath,
        outputPath: targetPath,
        timeoutMs,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        markdownBytes: Buffer.byteLength(markdown, 'utf8'),
      };
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === attempts;
      if (!isLastAttempt) {
        continue;
      }
    }
  }

  return {
    ok: false,
    inputPath,
    outputPath: targetPath,
    timeoutMs,
    attempts,
    error: String(lastError?.message || lastError || 'unknown error'),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.inputs.length === 0) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  await loadEnvFile();

  const envParseUrl = process.env.PADDLEOCR_PARSE_URL || '';
  const envBaseUrl = process.env.PADDLEOCR_BASE_URL || '';
  const parseUrl = getParseUrl(args.baseUrl, envParseUrl, envBaseUrl);
  if (!parseUrl) {
    throw new Error('Missing PaddleOCR endpoint. Set PADDLEOCR_PARSE_URL or PADDLEOCR_BASE_URL, or pass --base-url.');
  }

  const resolvedInputs = [];
  for (const input of args.inputs) {
    if (!(await pathExists(input))) {
      throw new Error(`Input not found: ${input}`);
    }
    const stat = await fs.stat(input);
    if (stat.isDirectory()) {
      const pdfs = await walkPdfFiles(input);
      for (const pdf of pdfs) {
        resolvedInputs.push({ inputPath: pdf, inputRoot: input });
      }
    } else {
      resolvedInputs.push({ inputPath: input, inputRoot: path.dirname(input) });
    }
  }

  if (resolvedInputs.length === 0) {
    throw new Error('No PDF files found.');
  }

  if (args.outputDir) {
    await fs.mkdir(args.outputDir, { recursive: true });
  }

  const results = [];
  for (const item of resolvedInputs) {
    const result = await convertOne({
      inputPath: item.inputPath,
      inputRoot: item.inputRoot,
      outputDir: args.outputDir,
      parseUrl,
      timeout: args.timeout,
      retries: args.retries,
      frontmatter: args.frontmatter,
    });
    results.push(result);

    if (result.ok) {
      console.log(`OK  ${path.relative(process.cwd(), result.inputPath)} -> ${path.relative(process.cwd(), result.outputPath)} (${Math.round(result.elapsedMs / 1000)}s)`);
    } else {
      console.error(`ERR ${path.relative(process.cwd(), result.inputPath)} -> ${result.error}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
