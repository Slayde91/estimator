// Shared drawing zoom, using real PDF rendering and disposable synthetic documents.
const { chromium, expect } = require('@playwright/test');
const { settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `smooth-zoom-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], commands = [], evidence = { cases: [] };
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function snapshot() { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function response(action, op = 'record_render') {
  const pending = page.waitForResponse(reply => reply.url().endsWith('/commands') && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const reply = await pending, body = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(body)); await settingsSettled(page); return body;
}
async function rendered(action, number, firstVisit = false) {
  const pending = firstVisit ? page.waitForResponse(reply => reply.url().endsWith('/auto-calibrate') && reply.request().postDataJSON()?.page === number) : null;
  pending?.catch(() => {});
  await page.evaluate(() => { window.qaPreviousCanvas = document.querySelector('.takeoff-page canvas'); });
  await action();
  await expect.poll(() => page.evaluate(() => window.qaPreviousCanvas !== document.querySelector('.takeoff-page canvas')), { timeout: 30000 }).toBe(true);
  await expect(page.locator('.takeoff-progress')).toContainText('Original source');
  if (pending) { const reply = await pending; assert.equal(reply.status(), 200, await reply.text()); }
  await settingsSettled(page); await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(number));
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function focusDrawing() {
  await page.locator('.takeoff-viewport').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom - 12));
}
async function metrics(point) {
  return page.evaluate(point => {
    const drawing = document.querySelector('.takeoff-overlay'), canvas = document.querySelector('.takeoff-page canvas'), frame = document.querySelector('.takeoff-viewport');
    const box = drawing.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
    const cursor = point || [Math.max(bounds.left + 80, box.left + box.width * .52), Math.max(bounds.top + 100, Math.min(bounds.bottom - 100, box.top + box.height * .48))];
    const canvasBox = canvas.getBoundingClientRect();
    return { point: cursor, normalized: [(cursor[0] - box.left) / box.width, (cursor[1] - box.top) / box.height],
      box: { x: box.x, y: box.y, width: box.width, height: box.height }, bitmap: { width: canvas.width, height: canvas.height },
      canvas: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height },
      visible: !drawing.closest('.takeoff-page').hidden, children: drawing.childElementCount, page: document.querySelector('.takeoff-page-controls input').value,
      scroll: [frame.scrollLeft, frame.scrollTop], documentScroll: [window.scrollX, window.scrollY] };
  }, point);
}
function anchored(before, after, tolerance = 1.6) {
  const projected = [after.box.x + before.normalized[0] * after.box.width, after.box.y + before.normalized[1] * after.box.height];
  const error = Math.hypot(...projected.map((value, index) => value - before.point[index]));
  assert.ok(error <= tolerance, `PDF point moved ${error}px under the zoom pointer`); return error;
}
function aligned(value) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(value.box[key] - value.canvas[key]) < .1, `Paper and overlay disagree at ${key}`);
  assert.equal(value.visible, true);
}
async function wheel(point, deltas, mode = 0) {
  await page.locator('.takeoff-viewport').evaluate((el, { point, deltas, mode }) => {
    for (const deltaY of deltas) el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, clientX: point[0], clientY: point[1], deltaY, deltaMode: mode }));
  }, { point, deltas, mode });
}
// Discover the real PDFPageProxy prototype from a separately opened copy of our
// synthetic document. Delay delivery of real render completion, never rendering
// arithmetic/pixels, so races are deterministic without a production test hook.
async function installRenderProbe(documentId) {
  await page.evaluate(async documentId => {
    const lib = await import('/vendor/pdfjs/build/pdf.mjs');
    const data = new Uint8Array(await (await fetch(`/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}/documents/${documentId}/file`)).arrayBuffer());
    const task = lib.getDocument({ data, useWasm: false, isEvalSupported: false });
    const pdf = await task.promise, probe = await pdf.getPage(1), prototype = Object.getPrototypeOf(probe), original = prototype.render;
    window.zoomQa = { hold: false, records: [], sequence: 0 };
    prototype.render = function (options) {
      const task = original.call(this, options);
      if (options.canvasContext.canvas.getAttribute('aria-label') !== 'Original PDF page') return task;
      const qa = window.zoomQa, record = { id: ++qa.sequence, page: this.pageNumber, width: options.viewport.width, height: options.viewport.height, held: qa.hold, actualDone: false, cancelled: false };
      qa.records.push(record);
      const hold = qa.hold ? new Promise(resolve => { record.release = resolve; }) : Promise.resolve();
      const actual = task.promise.then(value => { record.actualDone = true; return value; });
      return { promise: Promise.all([actual, hold]).then(([value]) => value), cancel() { record.cancelled = true; task.cancel(); } };
    };
    await task.destroy();
  }, documentId);
}
async function renderRecords() { return page.evaluate(() => window.zoomQa.records.map(({ release, ...record }) => record)); }
async function waitHeld(after) {
  await expect.poll(async () => (await renderRecords()).filter(value => value.id > after && value.held && value.actualDone).length).toBe(1);
  return (await renderRecords()).find(value => value.id > after && value.held && value.actualDone);
}
async function release(id) { await page.evaluate(id => window.zoomQa.records.find(value => value.id === id).release?.(), id); }
async function zoomCase(label) {
  await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), Number(await page.getByLabel('Page number', { exact: true }).inputValue()));
  await focusDrawing(); const before = await metrics(), countBefore = commands.filter(value => value.op === 'record_render').length;
  await page.evaluate(() => { window.zoomQa.hold = true; window.zoomQa.canvasBefore = document.querySelector('.takeoff-page canvas'); });
  const sequence = (await renderRecords()).at(-1)?.id || 0;
  await wheel(before.point, Array(24).fill(-1)); await frames();
  const preview = await metrics(before.point); aligned(preview);
  assert.ok(preview.box.width > before.box.width * 1.01 && preview.box.width < before.box.width * 1.15, 'Small trackpad deltas produce a small continuous increase, not repeated 15% jumps');
  assert.deepEqual(preview.bitmap, before.bitmap, 'Preview retains the original bitmap resolution');
  assert.equal(await page.evaluate(() => window.zoomQa.canvasBefore === document.querySelector('.takeoff-page canvas')), true, 'First animation frame retains the visible canvas');
  assert.equal(preview.children, before.children, 'Overlay remains present during zoom');
  assert.equal(preview.page, before.page); assert.deepEqual(preview.documentScroll, before.documentScroll);
  const anchorError = anchored(before, preview);
  const first = await waitHeld(sequence);
  if (label === 'Steel/landscape') await page.screenshot({ path: path.join(output, 'smooth-zoom-retained-preview.png') });
  if (label === 'Steel/landscape-narrow-764') await page.screenshot({ path: path.join(output, 'smooth-zoom-retained-preview-764.png') });
  assert.equal((await renderRecords()).filter(value => value.id > sequence).length, 1, '24 wheel events coalesce to one PDF refinement');
  assert.equal(commands.filter(value => value.op === 'record_render').length, countBefore, 'No intermediate preview records a render result');
  // Change direction and pointer position while the previous real bitmap's
  // completion is delayed. Latest completion is deliberately delivered first.
  const otherPoint = [before.point[0] + 21, before.point[1] + 17], reversing = await metrics(otherPoint);
  await wheel(otherPoint, Array(12).fill(1)); await frames();
  const latestPreview = await metrics(otherPoint); aligned(latestPreview); const reverseError = anchored(reversing, latestPreview);
  const latest = await waitHeld(first.id);
  await release(latest.id);
  await expect.poll(() => page.evaluate(() => window.zoomQa.canvasBefore !== document.querySelector('.takeoff-page canvas'))).toBe(true);
  await settingsSettled(page);
  const refined = await metrics(otherPoint); aligned(refined);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(refined.box[key] - latestPreview.box[key]) <= .1, 'High-resolution replacement never repositions or resizes the preview');
  const latestCanvas = await page.evaluate(() => { window.zoomQa.latestCanvas = document.querySelector('.takeoff-page canvas'); return window.zoomQa.latestCanvas.width; });
  await release(first.id); await frames();
  assert.equal(await page.evaluate(() => window.zoomQa.latestCanvas === document.querySelector('.takeoff-page canvas')), true, 'Late cancelled completion never replaces the latest bitmap');
  assert.equal((await metrics()).bitmap.width, latestCanvas);
  assert.equal(commands.filter(value => value.op === 'record_render').length, countBefore, 'Refinement reuses the current successful source proof');
  await page.evaluate(() => { window.zoomQa.hold = false; });
  evidence.cases.push({ label, page: before.page, beforeWidth: before.box.width, previewWidth: preview.box.width, anchorError, reverseError, refinements: 2, staleCompletionIgnored: true });
}
async function protectedState() {
  const value = await snapshot();
  const reply = await page.request.get(new URL(`/api/takeoffs/sessions/${await page.evaluate(() => window.CeasefireTakeoffs.sessionId())}`, page.url()).href);
  assert.equal(reply.status(), 200); const state = await reply.json();
  return { items: value.items, calibrations: value.calibrations, physical: value.physical, service_plans: value.service_plans, documents: value.documents,
    results: state.item_results, calculators: await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()) };
}
async function panAndNavigateDuringRefinement(landscape) {
  await focusDrawing();
  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await page.evaluate(() => { window.zoomQa.hold = true; window.zoomQa.canvasBefore = document.querySelector('.takeoff-page canvas'); });
  let sequence = (await renderRecords()).at(-1).id;
  const before = await metrics();
  await page.getByRole('button', { name: '+', exact: true }).click(); await frames();
  const first = await waitHeld(sequence), scaled = await metrics();
  assert.ok(Math.abs(scaled.box.width / before.box.width - 1.25) < .005, 'Toolbar zoom keeps the existing 25% increment');
  const start = scaled.point;
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0] + 42, start[1] + 34, { steps: 3 }); await page.mouse.up();
  const panned = await metrics();
  assert.ok(Math.abs(panned.box.x - scaled.box.x - 42) < 1.6 && Math.abs(panned.box.y - scaled.box.y - 34) < 1.6, 'Drawing remains draggable while refinement is pending');
  await release(first.id);
  await expect.poll(() => page.evaluate(() => window.zoomQa.canvasBefore !== document.querySelector('.takeoff-page canvas'))).toBe(true);
  const after = await metrics();
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(after.box[key] - panned.box[key]) < .1, 'Refinement does not undo a pan performed after it started');
  sequence = (await renderRecords()).at(-1).id;
  await page.mouse.move(...after.point); await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, -60); } finally { await page.keyboard.up('Control'); }
  await frames();
  const oldDocumentRender = await waitHeld(sequence);
  await page.getByLabel('Drawing document', { exact: true }).selectOption(landscape.id);
  const newDocumentRender = await waitHeld(oldDocumentRender.id);
  await release(newDocumentRender.id); await expect(page.locator('.takeoff-progress')).toHaveText('synthetic-drawings.pdf · Page 1 · Original source'); await settingsSettled(page);
  await page.evaluate(() => { window.zoomQa.latestCanvas = document.querySelector('.takeoff-page canvas'); });
  await release(oldDocumentRender.id); await frames();
  await expect(page.getByLabel('Drawing document', { exact: true })).toHaveValue(landscape.id);
  assert.equal(await page.evaluate(() => window.zoomQa.latestCanvas === document.querySelector('.takeoff-page canvas')), true, 'Stale zoom refinement cannot replace a newly navigated source document');
  await page.evaluate(() => { window.zoomQa.hold = false; });
  evidence.refinementPanAndNavigation = { toolbarFactor: 1.25, panDelta: [42, 34], retainedPan: true, nativeControlWheel: true, oldDocumentCompletionIgnored: true };
}
async function sequentialNativeWheel() {
  evidence.sequentialNativeWheel = [];
  for (const delta of [-60, 60]) {
    const initial = await page.evaluate(() => {
      const frame = document.querySelector('.takeoff-viewport'), drawing = document.querySelector('.takeoff-overlay'), box = drawing.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
      const cursor = [bounds.left + frame.clientWidth * .51, bounds.top + frame.clientHeight * .46];
      const qa = window.sequentialZoomQa = { initialCanvas: document.querySelector('.takeoff-page canvas'), events: [], frames: [], running: true, point: null, normalized: null };
      if (window.sequentialZoomListener) frame.removeEventListener('wheel', window.sequentialZoomListener, true);
      window.sequentialZoomListener = event => {
        qa.events.push({ point: [event.clientX, event.clientY], delta: event.deltaY });
        if (!qa.point) { qa.point = [event.clientX, event.clientY]; qa.normalized = [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]; }
      };
      frame.addEventListener('wheel', window.sequentialZoomListener, true);
      const sample = () => {
        if (!qa.running) return;
        if (qa.point) {
          const rect = drawing.getBoundingClientRect(), canvas = document.querySelector('.takeoff-page canvas').getBoundingClientRect();
          qa.frames.push({ width: rect.width, drift: Math.hypot(rect.left + qa.normalized[0] * rect.width - qa.point[0], rect.top + qa.normalized[1] * rect.height - qa.point[1]),
            visible: !drawing.closest('.takeoff-page').hidden, aligned: Math.max(Math.abs(rect.x - canvas.x), Math.abs(rect.y - canvas.y), Math.abs(rect.width - canvas.width), Math.abs(rect.height - canvas.height)) });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample); return cursor;
    });
    assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-overlay'), initial), true);
    await page.mouse.move(...initial); await page.keyboard.down('Control');
    try { for (let index = 0; index < 10; index++) await page.mouse.wheel(0, delta); } finally { await page.keyboard.up('Control'); }
    await expect.poll(() => page.evaluate(() => window.sequentialZoomQa.initialCanvas !== document.querySelector('.takeoff-page canvas'))).toBe(true);
    await expect(page.locator('.takeoff-progress')).toContainText('Original source'); await settingsSettled(page); await frames();
    const sample = await page.evaluate(() => { window.sequentialZoomQa.running = false; const { events, frames } = window.sequentialZoomQa; return { events, frames }; });
    assert.equal(sample.events.length, 10); assert.ok(new Set(sample.frames.map(value => value.width)).size >= 6, 'Native wheel burst exercises sequential rendered frames, not one synthetic frame');
    assert.ok(sample.events.every(value => value.point[0] === sample.events[0].point[0] && value.point[1] === sample.events[0].point[1]), 'Browser delivers a fixed cursor anchor');
    assert.ok(sample.frames.every(value => value.visible && value.aligned < .1));
    const maxDrift = Math.max(...sample.frames.map(value => value.drift));
    assert.ok(maxDrift < .5, `Sequential wheel previews accumulate ${maxDrift}px pointer drift`);
    evidence.sequentialNativeWheel.push({ direction: delta < 0 ? 'in' : 'out', events: sample.events.length, previewWidths: [...new Set(sample.frames.map(value => value.width))], maxPointerDriftPx: maxDrift });
  }
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) commands.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await rendered(() => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1, true);
  const landscape = (await snapshot()).documents[0];
  await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 1); await focusDrawing();
  await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await response(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  const box = (await metrics()).box;
  await page.mouse.click(box.x + box.width * .25, box.y + box.height * .5); await page.mouse.dblclick(box.x + box.width * .7, box.y + box.height * .5);
  await response(() => dialog('Add steel object', { 'Member mark': 'ZOOM-INVARIANT', 'Count/QTY': 2 }, 'Add item'), 'create_item');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await rendered(() => page.locator('#takeoff-upload').setInputFiles(info.scale_fixture), 1);
  const portrait = (await snapshot()).documents.find(value => value.id !== landscape.id);
  await rendered(() => page.getByLabel('Drawing document', { exact: true }).selectOption(portrait.id), 1, true);
  await rendered(async () => { await page.getByLabel('Drawing document', { exact: true }).selectOption(landscape.id); }, 1);
  await rendered(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3, true);
  assert.deepEqual(landscape.pages[2].view, [20, 30, 800, 570]); assert.equal(landscape.pages[2].rotation, 90); assert.equal(landscape.pages[2].user_unit, 2);
  await installRenderProbe(landscape.id); const protectedBefore = await protectedState();
  assert.ok(protectedBefore.items.length && protectedBefore.results.some(value => value.length_m > 0), 'Nonempty measurements make invariant checks meaningful');
  for (const [mode, scope] of [['Steel'], ['Duct'], ['Walls'], ['Slabs'], ['Penetrations', 'Defect Reports'], ['Penetrations', 'Service Plans']]) {
    await page.getByRole('tab', { name: mode.toUpperCase(), exact: true }).click(); await settingsSettled(page);
    if (scope) { await page.getByRole('tab', { name: scope, exact: true }).click(); await settingsSettled(page); }
    for (const [name, doc, number] of [['landscape', landscape, 1], ['rotated-crop-UserUnit2', landscape, 3], ['portrait-UserUnit2', portrait, 1]]) {
      if (await page.getByLabel('Drawing document', { exact: true }).inputValue() !== doc.id) await rendered(() => page.getByLabel('Drawing document', { exact: true }).selectOption(doc.id), 1);
      if (Number(await page.getByLabel('Page number', { exact: true }).inputValue()) !== number) await rendered(async () => { await page.getByLabel('Page number', { exact: true }).fill(String(number)); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, number);
      await zoomCase(`${scope || mode}/${name}`);
    }
  }
  await panAndNavigateDuringRefinement(landscape);
  await page.getByRole('tab', { name: 'STEEL', exact: true }).click(); await settingsSettled(page);
  await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 1); await focusDrawing();
  await page.setViewportSize({ width: 764, height: 764 });
  await zoomCase('Steel/landscape-narrow-764');
  await sequentialNativeWheel();
  assert.deepEqual(await protectedState(), protectedBefore, 'Zoom cannot alter source identity, geometry, calibration, quantities, calculated results or calculator rows');
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.screenshot({ path: path.join(output, 'smooth-zoom-settled.png') });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, renderRecords: await renderRecords() }, null, 2));
  console.log(`PASS: 19 scope/page/viewport combinations plus sequential native wheel preserve subpixel anchors and drawing/overlay preview, coalesce tiny wheel deltas, reject stale real-render completions, and retain geometry/calculations. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
