// Full-limit rendered acceptance against a disposable production server.
// Test instrumentation observes Worker lifetime and DOM size without changing
// PDF.js requests, application state, or cache behaviour.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `capacity-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || 'python';
fs.mkdirSync(output, { recursive: true });
const started = Date.now(), timings = {}, errors = [], warnings = [], failedRequests = [], readDocuments = new Set();
let browser, page, ending = false, serverErrors = '', fixtureErrors = '';
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
const fixtures = spawn(python, [path.join(__dirname, 'capacity_fixtures.py'), '--directory', path.join(output, 'inputs')], { cwd: root, windowsHide: true });
server.stderr.on('data', data => { serverErrors = (serverErrors + data).slice(-12000); });
fixtures.stderr.on('data', data => { fixtureErrors = (fixtureErrors + data).slice(-12000); });
function firstJsonLine(child, label, stderr) {
  return new Promise((resolve, reject) => {
    let text = '', settled = false;
    const timer = setTimeout(() => reject(new Error(`${label} startup timed out: ${stderr()}`)), 120000);
    child.stdout.on('data', data => {
      if (settled) return;
      text += data;
      if (!text.includes('\n')) return;
      settled = true; clearTimeout(timer);
      try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`${label} exited ${code}: ${stderr()}`));
      else if (label === 'Server' && !ending) console.error(`Capacity server exited unexpectedly: ${code}`);
    });
  });
}
const serverReady = firstJsonLine(server, 'Server', () => serverErrors);
const fixturesReady = firstJsonLine(fixtures, 'Fixtures', () => fixtureErrors);
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30000 }); }
async function run() {
  const [info, inputs] = await Promise.all([serverReady, fixturesReady]);
  assert.notEqual(info.port, 8765, 'Capacity QA must never use the live application port');
  assert.equal(inputs.files.length, 100); assert.equal(inputs.pages, 2000);
  timings.startup_ms = Date.now() - started;
  console.log(`Capacity fixtures and disposable server ready in ${timings.startup_ms} ms.`);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (['warning', 'error'].includes(event.type())) warnings.push(event.text()); });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  page.on('request', request => {
    const match = request.url().match(/\/documents\/([^/]+)\/file(?:\?|$)/);
    if (match) readDocuments.add(match[1]);
  });
  page.on('response', response => { if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() }); });
  let completedUploads = 0;
  page.on('response', response => {
    if (response.ok() && /\/uploads\/[^/]+\/complete$/.test(response.url())) {
      completedUploads++;
      if (completedUploads % 20 === 0) console.log(`Capacity upload: ${completedUploads}/100 PDFs accepted.`);
    }
  });
  await page.addInitScript(() => {
    window.capacityQa = { activeWorkers: 0, maxWorkers: 0, createdWorkers: 0, maxThumbnails: 0, violations: [] };
    document.addEventListener('securitypolicyviolation', event => window.capacityQa.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.capacityObserved = String(url).includes('/takeoff-pdf-worker.mjs');
        if (this.capacityObserved) {
          const qa = window.capacityQa; qa.activeWorkers++; qa.createdWorkers++;
          qa.maxWorkers = Math.max(qa.maxWorkers, qa.activeWorkers);
        }
      }
      terminate() {
        if (this.capacityObserved) { this.capacityObserved = false; window.capacityQa.activeWorkers--; }
        return super.terminate();
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        window.capacityQa.maxThumbnails = Math.max(window.capacityQa.maxThumbnails, document.querySelectorAll('.takeoff-thumbnail[data-page]').length);
      }).observe(document.body, { childList: true, subtree: true });
    });
  });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload PDFs', exact: true })).toBeVisible();
  await expect(page.getByLabel('Text search scope', { exact: true })).toHaveValue('document');
  await expect(page.getByLabel('Sort register', { exact: true })).toHaveValue('mark');
  await expect(page.getByLabel('Register position', { exact: true })).toHaveValue('below');
  const uploadStarted = Date.now();
  await page.locator('#takeoff-upload').setInputFiles(inputs.files);
  await expect(page.locator('.takeoff-document')).toHaveCount(100, { timeout: 250000 });
  await idle(); await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  const snapshot = await page.evaluate(() => {
    const value = window.CeasefireTakeoffs.projectSnapshot();
    return { documents: value.documents.length, pages: value.documents.reduce((sum, doc) => sum + doc.pages.length, 0), ids: value.documents.map(doc => doc.id), hashes: value.documents.map(doc => doc.sha256) };
  });
  assert.equal(snapshot.documents, 100); assert.equal(snapshot.pages, 2000);
  assert.equal(new Set(snapshot.hashes).size, 100);
  assert.deepEqual(snapshot.hashes, inputs.files.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')));
  assert.equal(readDocuments.size, 1, 'Uploading 100 PDFs should render only the selected document');
  await expect(page.getByLabel('Drawing document', { exact: true }).locator('option.takeoff-document')).toHaveCount(100);
  assert.equal(await page.locator('.takeoff-thumbnail[data-page]').count(), 0, 'Compact source navigation does not create thumbnail canvases');
  timings.upload_ms = Date.now() - uploadStarted;
  console.log(`Uploaded and verified 100 documents / 2,000 pages in ${timings.upload_ms} ms.`);
  await page.screenshot({ path: path.join(output, 'all-documents-uploaded.png'), fullPage: true });

  const searchStarted = Date.now();
  await page.getByPlaceholder('Search PDF text…').fill(inputs.sentinel);
  await page.getByLabel('Text search scope', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const progress = page.locator('.takeoff-progress');
  await expect(progress).toContainText('Text search complete: 2000/2000 pages inspected', { timeout: 120000 });
  await expect(progress).toContainText('1999 without searchable text');
  await expect(progress).toContainText('0 failed');
  await expect(progress).toContainText('Scanned pages require visual inspection');
  await expect(page.locator('.takeoff-search-result')).toHaveCount(1);
  await expect(page.locator('.takeoff-search-result')).toContainText(`capacity-100.pdf · p20: ${inputs.sentinel}`);
  assert.equal(readDocuments.size, 100, 'All 100 source documents must have been searched');
  await expect.poll(() => page.evaluate(() => window.capacityQa.activeWorkers), { timeout: 10000 }).toBeLessThanOrEqual(2);
  timings.search_ms = Date.now() - searchStarted;
  console.log(`Searched every page in ${timings.search_ms} ms; 1,999 pages correctly have no searchable text.`);
  const coverage = await progress.innerText();
  await page.screenshot({ path: path.join(output, 'complete-search-coverage.png'), fullPage: true });

  const render = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === 'record_render' && response.request().postDataJSON()?.page === 20);
  await page.locator('.takeoff-search-result').click();
  const rendered = await (await render).json();
  assert.equal(rendered.snapshot.documents.length, 100);
  assert.ok(rendered.snapshot.render_checks.some(check => check.document_id === snapshot.ids[99] && check.page === 20 && check.success && check.warnings.length === 0));
  await idle();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('20');
  await expect(page.locator('.takeoff-document[aria-selected="true"]')).toContainText('capacity-100.pdf');
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  const markedPixels = await page.locator('.takeoff-viewport canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let marked = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 220 || pixels[i + 1] < 220 || pixels[i + 2] < 220) marked++;
    return marked;
  });
  assert.ok(markedPixels > 100, 'The last document/page must contain visibly rendered vector/text content');
  await expect.poll(() => page.evaluate(() => window.capacityQa.activeWorkers), { timeout: 10000 }).toBeLessThanOrEqual(2);
  const metrics = await page.evaluate(() => window.capacityQa);
  assert.equal(metrics.maxThumbnails, 0, 'Removed source thumbnails must not render eagerly during upload or search');
  assert.ok(metrics.maxWorkers <= 3, 'At most two cached PDF workers plus one replacement during asynchronous cleanup');
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []); assert.deepEqual(failedRequests, []); assert.deepEqual(metrics.violations, []);
  timings.total_ms = Date.now() - started;
  await page.screenshot({ path: path.join(output, 'last-document-last-page.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, documents: snapshot.documents, pages: snapshot.pages, uniqueHashes: new Set(snapshot.hashes).size, inputBytes: inputs.bytes, coverage, markedPixels, metrics, timings, errors, warnings, failedRequests }, null, 2));
  console.log(`PASS: 100 distinct PDFs / 2,000 pages uploaded through UI; complete text search, no thumbnail rendering, bounded workers, final page rendered. Evidence: ${output}`);
  console.log(JSON.stringify(timings));
}
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Full-capacity browser test exceeded five minutes')), 300000); })])
  .catch(async error => {
    console.error(error); console.error(serverErrors.slice(-3000));
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
      const observed = await page.evaluate(() => ({ documents: document.querySelectorAll('.takeoff-document').length, progress: document.querySelector('.takeoff-progress')?.textContent, metrics: window.capacityQa })).catch(() => null);
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ errors, warnings, failedRequests, timings, observed, elapsed_ms: Date.now() - started }, null, 2));
    }
    process.exitCode = 1;
  })
  .finally(async () => { clearTimeout(deadline); ending = true; if (browser) await browser.close(); server.kill(); fixtures.kill(); });
