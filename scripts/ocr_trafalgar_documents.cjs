#!/usr/bin/env node
'use strict';

// Optional, local OCR of prepared image-only pages. Supplier content is never
// uploaded. Tesseract may download public English language data on first use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function argumentsFrom(argv) {
  const options = { workers: 2, limit: Infinity, includeImages: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workers') options.workers = Number(argv[++i]);
    else if (argv[i] === '--limit') options.limit = Number(argv[++i]);
    else if (argv[i] === '--lang-path') options.langPath = argv[++i];
    else if (argv[i] === '--rotation-map') options.rotationMap = argv[++i];
    else if (argv[i] === '--include-image') {
      const value = argv[++i];
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
        throw new Error('--include-image requires a 64-character hexadecimal image SHA-256');
      }
      options.includeImages.push(value.toLowerCase());
    }
    else if (!options.directory) options.directory = argv[i];
    else if (!options.output) options.output = argv[i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.directory || !options.output || !Number.isInteger(options.workers)
      || options.workers < 1 || options.workers > 4
      || !(options.limit === Infinity || Number.isInteger(options.limit) && options.limit > 0)) {
    throw new Error('Usage: node ocr_trafalgar_documents.cjs PREPARED_DIRECTORY OUTPUT_JSON [--workers 1..4] [--limit N] [--lang-path DIRECTORY] [--rotation-map JSON_FILE] [--include-image SHA256 ...]');
  }
  options.includeImages = [...new Set(options.includeImages)].sort();
  return options;
}

function safeImage(directory, filename) {
  if (typeof filename !== 'string' || path.isAbsolute(filename)) throw new Error('Invalid image path');
  const result = path.resolve(directory, filename);
  const relative = path.relative(directory, result);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.(png|jpe?g)$/i.test(result)) {
    throw new Error('Prepared image path escapes its directory or has an unsupported type');
  }
  const real = fs.realpathSync(result);
  const realRelative = path.relative(fs.realpathSync(directory), real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Image symlink escapes prepared directory');
  return real;
}

function wordsFrom(blocks) {
  return (blocks || []).flatMap(block => (block.paragraphs || [])
    .flatMap(paragraph => (paragraph.lines || []).flatMap(line => (line.words || [])
      .map(word => ({ text: word.text, confidence: word.confidence, bbox: word.bbox })))));
}

function reviewFlags(text, confidence, words) {
  const flags = ['OCR_ONLY_REQUIRES_VISUAL_REVIEW'];
  if (!text.trim()) flags.push('NO_TEXT_RECOGNIZED');
  if (confidence < 85) flags.push('LOW_PAGE_CONFIDENCE');
  if (words.some(word => word.confidence < 80 && /\d|FRL|wrap|protect|service/i.test(word.text))) {
    flags.push('LOW_CONFIDENCE_DIMENSION_OR_CALLOUT_TOKEN');
  }
  if (text.split(/\r?\n/).some(line => /FRL/i.test(line)
      && /[0-9]/.test(line) && !/-\s*\/\s*\d+\s*\/\s*(?:\d+|-)/.test(line))) {
    flags.push('POSSIBLE_MALFORMED_FRL_TEXT');
  }
  if (/(?:\d|-)\s*\/\s*[0-9OIl]*[OIl][0-9OIl]*\s*\/|\/\s*[0-9OIl]*[OIl][0-9OIl]*(?:\s|$)/m.test(text)) {
    flags.push('POSSIBLE_FRL_CHARACTER_CONFUSION');
  }
  return flags;
}

function selectedImages(directory, index, rotations, includeImages) {
  const requested = new Set(includeImages);
  const matched = new Set();
  const groups = new Map();
  for (const document of index.documents) {
    for (const page of document.pages || []) {
      if ((page.text || '').trim() && !requested.has(page.image_sha256)) continue;
      const imagePath = safeImage(directory, page.image_filename);
      const digest = sha256(fs.readFileSync(imagePath));
      if (page.image_sha256 !== digest) throw new Error(`Prepared image fingerprint mismatch: ${page.image_filename}`);
      if (requested.has(digest)) matched.add(digest);
      if (!groups.has(digest)) groups.set(digest, { image_sha256: digest,
        image_filename: page.image_filename, width: page.width, height: page.height,
        rotation_degrees: rotations[page.image_filename] || 0,
        preprocessing: rotations[page.image_filename] ? 'sharp_rotate_expand_v1' : 'none', references: [] });
      groups.get(digest).references.push({ document_id: document.document_id, page: page.page });
    }
  }
  for (const digest of requested) {
    if (!matched.has(digest)) throw new Error(`Requested supplemental image is absent from available prepared pages: ${digest}`);
  }
  return groups;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const directory = path.resolve(options.directory);
  const output = path.resolve(options.output);
  const indexBytes = fs.readFileSync(path.join(directory, 'documents-index.json'));
  const index = JSON.parse(indexBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(index.documents)) throw new Error('Missing document index');
  const rotations = options.rotationMap ? JSON.parse(fs.readFileSync(options.rotationMap, 'utf8')) : {};
  if (!rotations || Array.isArray(rotations) || typeof rotations !== 'object'
      || Object.values(rotations).some(value => ![0, 90, -90, 180].includes(value))) {
    throw new Error('Rotation map must associate relative image filenames with 0, 90, -90 or 180 degrees');
  }
  const groups = selectedImages(directory, index, rotations, options.includeImages);
  const emptyTextImages = new Set(index.documents.flatMap(document => (document.pages || [])
    .filter(page => !(page.text || '').trim()).map(page => page.image_sha256)));
  const indexSha256 = sha256(indexBytes);
  const completed = new Map();
  const previousAttempts = new Map();
  let previous = {};
  if (fs.existsSync(output)) {
    previous = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (previous.index_sha256 !== indexSha256) throw new Error('Existing OCR output is for a different prepared index');
    for (const record of previous.images || []) {
      if (!groups.has(record.image_sha256)) throw new Error('Existing OCR record absent from source index');
      if (record.status === 'ocr_complete'
          && (record.rotation_degrees || 0) === groups.get(record.image_sha256).rotation_degrees
          && (record.preprocessing || 'none') === groups.get(record.image_sha256).preprocessing) {
        completed.set(record.image_sha256, record);
      } else if (record.status === 'ocr_complete') previousAttempts.set(record.image_sha256, record);
    }
  }
  const { createWorker, PSM } = require('tesseract.js');
  const engineVersion = require('tesseract.js/package.json').version;
  const pending = [...groups.values()].filter(group => !completed.has(group.image_sha256)).slice(0, options.limit);
  const cachePath = path.join(directory, 'ocr-language-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const save = () => {
    const result = { ...previous, schema_version: 1, index_sha256: indexSha256,
      source_capture_sha256: index.source_capture_sha256, engine: 'tesseract.js', engine_version: engineVersion,
      language: 'eng', content_processing: 'local_only', authority: 'unverified_ocr_search_aid',
      settings: { oem: 1, psm: PSM.AUTO, preserve_interword_spaces: '1' },
      selection_policy: previous.selection_policy || 'Empty embedded text plus explicitly requested supplemental images.',
      supplemental_image_sha256: options.includeImages,
      counts: { ...previous.counts, eligible_unique_images: groups.size, completed_images: completed.size,
        pending_images: groups.size - completed.size,
        empty_text_unique_images: emptyTextImages.size,
        manually_selected_partial_text_images: [...groups.keys()].filter(key => !emptyTextImages.has(key)).length,
        eligible_document_pages: [...groups.values()].reduce((count, group) => count + group.references.length, 0) },
      images: [...completed.values()].sort((a, b) => a.image_filename.localeCompare(b.image_filename)) };
    const temporary = `${output}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, output);
  };
  save();
  let next = 0;
  // Initialize sequentially so initial public language download/cache creation
  // cannot race. Recognition runs concurrently, two workers by default.
  const workers = [];
  try {
    for (let i = 0; i < Math.min(options.workers, pending.length); i++) {
      const workerOptions = { cachePath };
      if (options.langPath) workerOptions.langPath = path.resolve(options.langPath);
      const worker = await createWorker('eng', 1, workerOptions);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
      workers.push(worker);
    }
    await Promise.all(workers.map(async worker => {
      while (next < pending.length) {
        const group = pending[next++];
        const imagePath = safeImage(directory, group.image_filename);
        // Sharp expands the canvas for quarter-turn rotations; rotating within
        // Tesseract can clip a portrait page that contains a sideways drawing.
        const input = group.rotation_degrees
          ? await require('sharp')(imagePath).rotate(group.rotation_degrees).png().toBuffer() : imagePath;
        const { data } = await worker.recognize(input, {}, { text: true, blocks: true });
        const words = wordsFrom(data.blocks);
        const prior = previousAttempts.get(group.image_sha256);
        completed.set(group.image_sha256, { ...group, status: 'ocr_complete', text: data.text,
          confidence: data.confidence, words,
          review_flags: reviewFlags(data.text, data.confidence, words), visual_review_status: 'not_reviewed',
          ...(prior ? { previous_attempt: { text: prior.text, confidence: prior.confidence,
            rotation_degrees: prior.rotation_degrees || 0,
            ...(prior.previous_attempt ? { previous_attempt: prior.previous_attempt } : {}) } } : {}) });
        save();
        process.stdout.write(`OCR ${completed.size}/${groups.size}: ${group.image_filename} (confidence ${data.confidence})\n`);
      }
    }));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  process.stdout.write(`${JSON.stringify({ output, completed: completed.size, eligible: groups.size })}\n`);
}

module.exports = { argumentsFrom, selectedImages };
if (require.main === module) {
  main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
