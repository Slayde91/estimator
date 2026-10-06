"use strict";
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const {settingsSettled} = require('./settings_helpers.cjs');
const {renderDrawing} = require('./viewer_helpers.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `drawing-ocr-${Date.now()}`);
fs.mkdirSync(output, {recursive: true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'ocr_fixture.py'), '--directory', output], {cwd: root, windowsHide: true});
let logs = '', browser, page; server.stderr.on('data', value => logs += value);
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error('OCR fixture startup timeout: ' + logs)), 120000);
  server.stdout.on('data', value => {stdout += value; if (stdout.includes('\n')) {clearTimeout(timer); try {resolve(JSON.parse(stdout.split('\n')[0]));} catch (error) {reject(error);}}});
  server.once('error', reject); server.once('exit', code => {clearTimeout(timer); reject(new Error(`OCR fixture exited ${code}: ${logs}`));});
});
const errors = [], outbound = [], evidence = {};
const input = () => page.getByLabel('Search original document text', {exact: true});
const results = () => page.locator('.takeoff-search-result');
async function waitSearch() {await expect(page.locator('.takeoff-progress')).toContainText('Text search complete:', {timeout: 150000});}
async function navigateOcrResult(result, pageNumber) {
  const previous = await page.locator('.takeoff-page>canvas').elementHandle();
  try {
    await result.click();
    // Selection becomes current only after navigateDocument has awaited both
    // replacement rendering and its evidence commands. Input/quad updates can
    // precede a late record_render request and do not establish that boundary.
    await expect(result).toHaveAttribute('aria-current', 'true');
    await page.waitForFunction(old => {
      const canvas = document.querySelector('.takeoff-page>canvas'), overlay = document.querySelector('.takeoff-overlay');
      return canvas && overlay && canvas !== old && !old.isConnected && canvas.width > 0 && canvas.height > 0
        && Math.abs(parseFloat(canvas.style.width) - Number(overlay.getAttribute('width'))) < .01
        && Math.abs(parseFloat(canvas.style.height) - Number(overlay.getAttribute('height'))) < .01;
    }, previous);
    await expect(page.getByLabel('Page number', {exact: true})).toHaveValue(String(pageNumber));
    await settingsSettled(page);
  } finally {await previous.dispose();}
}
async function originalOcrQuads(viewerRotation) {
  return page.evaluate(async viewerRotation => {
    const snapshot = window.CeasefireTakeoffs.projectSnapshot(), doc = snapshot.documents[0], lib = await import('/vendor/pdfjs/build/pdf.mjs');
    const task = lib.getDocument({url: `/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}/documents/${doc.id}/file`, useWasm: false, isEvalSupported: false});
    try {
      const pdf = await task.promise, source = await pdf.getPage(2), rotation = (source.rotate + viewerRotation) % 360, base = source.getViewport({scale: 1, rotation});
      const scale = Number(document.querySelector('.takeoff-overlay').getAttribute('width')) / base.width, viewport = source.getViewport({scale, rotation});
      return [...document.querySelectorAll('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')].map(element => element.getAttribute('points').split(' ').map(point => viewport.convertToPdfPoint(...point.split(',').map(Number))));
    } finally {await task.destroy();}
  }, viewerRotation);
}
function equalOriginalQuads(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let quad = 0; quad < actual.length; quad++) for (let corner = 0; corner < 4; corner++) for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(actual[quad][corner][axis] - expected[quad][corner][axis]) < 0.00001, 'Zoom/rotation retain original PDF word coordinates');
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  const source = fs.readFileSync(info.fixture), digest = createHash('sha256').update(source).digest('hex');
  browser = await chromium.launch({headless: true}); const context = await browser.newContext({viewport: {width: 1500, height: 1000}});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== info.port) {outbound.push(url.href); return route.abort();}
    return route.continue();
  });
  await context.addInitScript(() => {
    window.ocrCsp = []; document.addEventListener('securitypolicyviolation', event => window.ocrCsp.push({directive: event.effectiveDirective, blocked: event.blockedURI}));
    const OriginalWorker = window.Worker; window.ocrWorkerQa = {created: 0, terminated: 0};
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {super(url, options); this.ocrOwned = String(url).includes('/vendor/ocr/worker.min.js'); if (this.ocrOwned) window.ocrWorkerQa.created++;}
      terminate() {if (this.ocrOwned) window.ocrWorkerQa.terminated++; super.terminate();}
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', {name: 'Takeoffs', exact: true}).click();
  await expect(page.getByLabel('Include drawing labels', {exact: true})).toBeChecked();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture); await expect(page.locator('.takeoff-page>canvas')).toBeVisible(); await settingsSettled(page);
  const initial = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); assert.equal(initial.documents[0].sha256, digest);
  let held;
  await context.route('**/vendor/ocr/lang/eng.traineddata.gz', route => {held = route;});
  await input().fill('Beyond'); await expect.poll(() => !!held, {timeout: 60000}).toBe(true);
  await page.getByRole('button', {name: 'Stop search', exact: true}).click();
  await expect(input()).toHaveValue(''); await expect(results()).toHaveCount(0); await expect(page.locator('.takeoff-search-context,.takeoff-search-match')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.ocrWorkerQa.terminated)).toBe(1);
  await held.abort().catch(() => {}); await context.unroute('**/vendor/ocr/lang/eng.traineddata.gz'); evidence.stopDuringEngineStartup = true;
  await input().fill('Air conditioner'); await waitSearch(); await expect(results()).toHaveCount(4);
  const labels = await results().allTextContents(); assert.equal(labels.filter(label => /OCR/i.test(label)).length, 3, 'Native glyph match wins, plus three scanned labels');
  assert.ok(labels.filter(label => /OCR/i.test(label)).every(label => /\d+%/.test(label) && /approximate|search.only/i.test(label)), 'OCR results disclose confidence and approximate search-only bounds');
  const native = await page.evaluate(async () => {
    const session = window.CeasefireTakeoffs.sessionId(), snapshot = window.CeasefireTakeoffs.projectSnapshot(), doc = snapshot.documents[0];
    const lib = await import('/vendor/pdfjs/build/pdf.mjs');
    const task = lib.getDocument({url: `/api/takeoffs/sessions/${session}/documents/${doc.id}/file`, useWasm: false, isEvalSupported: false});
    const pdf = await task.promise, counts = [];
    try {for (let page = 1; page <= 3; page++) {const source = await pdf.getPage(page), text = await source.getTextContent(); counts.push(window.CeasefireTakeoffSearch.find(window.CeasefireTakeoffSearch.indexText(text.items), 'Air conditioner').length);}}
    finally {await task.destroy();}
    return counts;
  });
  assert.deepEqual(native, [1, 0, 0], 'Negative control: scanned labels have no embedded text'); evidence.nativePreferredScannedLabels = {native, labels};
  await expect(page.locator('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')).toHaveCount(4);
  await page.screenshot({path: path.join(output, 'ocr-horizontal.png')});
  let heldRender = null, releaseRender, navigationReady = false;
  const releasedRender = new Promise(resolve => {releaseRender = resolve;});
  const holdNavigationRender = async route => {
    const request = route.request().postDataJSON();
    if (request?.op !== 'record_render' || request.page !== 2 || heldRender) return route.continue();
    heldRender = await route.fetch(); await releasedRender; await route.fulfill({response: heldRender});
  };
  await context.route('**/commands', holdNavigationRender);
  const navigation = navigateOcrResult(results().filter({hasText: 'p2:'}), 2).then(() => {navigationReady = true;}); navigation.catch(() => {});
  try {
    await expect.poll(() => heldRender?.status()).toBe(200);
    await expect(page.getByLabel('Page number', {exact: true})).toHaveValue('2');
    await expect(page.locator('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')).toHaveCount(2);
    await expect(page.locator('#takeoffs-workspace')).toHaveAttribute('aria-busy', 'true');
    const refusal = await page.evaluate(() => {try {window.CeasefireTakeoffs.projectSnapshot(); return null;} catch (error) {return error.message;}});
    assert.match(refusal, /Finish the current takeoff operation before saving/);
    assert.equal(navigationReady, false, 'Navigation readiness cannot pass merely because the page input and OCR quads changed');
    evidence.navigationReadiness = {heldRecordRenderStatus: heldRender.status(), pageInputAndOcrQuadsUpdatedBeforeCompletion: true, snapshotRefusal: refusal, completedBeforeRelease: navigationReady};
  } finally {releaseRender(); await context.unroute('**/commands', holdNavigationRender);}
  await navigation;
  await expect(page.locator('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')).toHaveCount(2);
  const geometry = await page.evaluate(() => [...document.querySelectorAll('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')].map(element => ({points: element.getAttribute('points'), geometry: element.dataset.searchGeometry})));
  assert.ok(geometry.every(record => record.points.split(' ').length === 4)); evidence.rotatedCropUserUnit = geometry;
  const originalQuads = await originalOcrQuads(0); assert.equal(originalQuads.length, 2);
  for (const point of originalQuads.flat()) assert.ok(point[0] >= 80 && point[0] <= 430 && point[1] >= 420 && point[1] <= 465, 'OCR word bounds map into the original raster label, including CropBox/Rotate/UserUnit');
  const before = await page.locator('.takeoff-page>canvas').boundingBox();
  await renderDrawing(page, () => page.getByRole('button', {name: '+', exact: true}).click(), 2);
  const after = await page.locator('.takeoff-page>canvas').boundingBox(); assert.ok(after.width / before.width > 1.24);
  await expect(page.locator('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')).toHaveCount(2);
  const zoomedQuads = await originalOcrQuads(0); equalOriginalQuads(zoomedQuads, originalQuads);
  await renderDrawing(page, () => page.getByRole('button', {name: 'Rotate page', exact: true}).click(), 2);
  await expect(page.locator('.takeoff-search-match[data-search-geometry="ocr-word-bounds"]')).toHaveCount(2);
  const rotatedQuads = await originalOcrQuads(90); equalOriginalQuads(rotatedQuads, originalQuads); evidence.originalCoordinatePreservation = {originalQuads, zoomedQuads, rotatedQuads};
  await page.screenshot({path: path.join(output, 'ocr-rotated-crop-userunit.png')});
  await input().fill(''); await expect(results()).toHaveCount(0); await expect(page.locator('.takeoff-search-context,.takeoff-search-match')).toHaveCount(0);
  const final = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  for (const key of ['documents', 'items', 'calibrations', 'transfers', 'physical', 'service_plans', 'annotations']) assert.deepEqual(final[key], initial[key], `OCR preserves ${key}`);
  const response = await page.request.get(`http://127.0.0.1:${info.port}/api/takeoffs/sessions/${await page.evaluate(() => window.CeasefireTakeoffs.sessionId())}/documents/${initial.documents[0].id}/file`);
  assert.equal(createHash('sha256').update(await response.body()).digest('hex'), digest, 'Original PDF bytes remain unchanged');
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []); assert.deepEqual(await page.evaluate(() => window.ocrCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({completed: true, evidence, errors, outbound}, null, 2));
  console.log(`PASS offline OCR scanned/native preference, engine-startup Stop, quarter-turn/CropBox/UserUnit/zoom bounds, source and authority preservation. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));}
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({completed: false, evidence, error: String(error), errors, outbound}, null, 2)); process.exitCode = 1;
}).finally(async () => {fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill();});
