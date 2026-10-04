const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Count tool availability and placed Defects on a disposable source/server.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { renderDrawing } = require('./viewer_helpers.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `count-tools-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], physicalRequests = [], evidence = {};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runtimeHashes = () => Object.fromEntries(['static/takeoffs.js', 'static/takeoff-physical.js', 'static/takeoffs.css'].map(file => [file, hash(path.join(root, file))]));
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await idle(); let current; await expect.poll(async () => { try { current = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return current; }
async function response(action, suffix) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(value)); await idle(); return value;
}
async function dialog(title, fields, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(fields)) { const control = modal.getByLabel(label, { exact: true }); if (await control.evaluate(el => el.tagName) === 'SELECT') await control.selectOption(String(value)); else await control.fill(String(value)); }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
// Original PDF page 3: CropBox [20,30,800,570], rotation 90, UserUnit 2.
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12); });
  const box = await overlay.boundingBox(), point = [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-overlay'), point), true, 'Drawing pointer reaches the original PDF'); return point;
}
async function pendingPoint() {
  return page.locator('.takeoff-defect-pending').evaluate(marker => {
    const [, , width, height] = marker.ownerSVGElement.getAttribute('viewBox').split(/\s+/).map(Number);
    return [20 + Number(marker.getAttribute('cy')) / height * 780, 30 + Number(marker.getAttribute('cx')) / width * 540];
  });
}
async function countCursor() {
  await expect(page.locator('.takeoff-viewport')).toHaveCSS('cursor', 'crosshair');
  await expect(page.locator('.takeoff-overlay')).toHaveCSS('cursor', 'crosshair');
  for (const element of await page.locator('.takeoff-overlay [role="button"]').all()) await expect(element).toHaveCSS('cursor', 'crosshair');
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765, 'Never use the live app'); const sourceHash = hash(info.fixture), runtimeBefore = runtimeHashes();
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/\/physical\/(preview|apply)$/.test(request.url())) physicalRequests.push({ endpoint: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => { const value = window.CeasefireDesktop?.status(); return value?.ready && !value.busy; });
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 3);
  const before = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await expect(page.getByRole('button', { name: 'Count', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Count steel lengths', exact: true }).click(); await countCursor();
  await page.mouse.click(...await screen([500, 400]), { button: 'right' });
  assert.deepEqual((await snapshot()).items, before.items); evidence.steelStandaloneRemovedDedicatedLengthCountRetained = true;
  await chooseTakeoff(page, 'DUCT'); await page.getByRole('button', { name: 'Count', exact: true }).click(); await countCursor();
  await page.mouse.click(...await screen([150, 200])); await page.locator('.takeoff-viewport').press('Enter');
  const ductReply = await response(() => dialog('Add count', { Item: 'DUCT-CROSSHAIR', Level: 'L01', 'WxH (mm)': '100x200', FRL: '120/120/120', Orientation: 'Horizontal' }, 'Add count'), '/commands');
  const duct = ductReply.snapshot.items.find(value => value.fields.mark === 'DUCT-CROSSHAIR'); assert.equal(duct.purpose, 'count-only'); assert.equal(duct.quantity, 1); assert.equal(duct.measurement, null);
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await countCursor(); await page.mouse.click(...await screen([500, 400]), { button: 'right' }); evidence.ductCrosshairOverSavedMarker = true;
  await chooseTakeoff(page, 'PENETRATIONS'); await idle();
  const initial = await snapshot(), requestCount = physicalRequests.length;
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await countCursor(); await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(physicalRequests.length, requestCount); assert.deepEqual(await snapshot(), initial); evidence.countOnlyArms = true;
  await page.mouse.click(...await screen([250, 300])); await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add Defect', exact: true })).toBeVisible();
  const cancelledPoint = await pendingPoint(); assert.ok(cancelledPoint.every(Number.isFinite)); await page.screenshot({ path: path.join(output, 'pending-defect-location.png') });
  await dialog('Add Defect', {}, 'Cancel'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.takeoff-defect-pending')).toHaveCount(0);
  assert.deepEqual(await snapshot(), initial); assert.equal(physicalRequests.length, requestCount); evidence.formCancelCreatesNothing = true;
  // Click near the crop edge: the marker's source annotation must remain inside
  // the original PDF, while its exact source point survives without rounding.
  await page.mouse.click(...await screen([23, 33])); await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add Defect', exact: true })).toBeVisible(); const acceptedPoint = await pendingPoint();
  const preview = await response(() => dialog('Add Defect', { 'Defect Ref.': 'PLACED-DEFECT', FRL: '-/120/120' }, 'Preview new draft'), '/physical/preview');
  await expect(page.locator('.takeoff-defect-pending')).toHaveCount(1); await response(() => dialog('Create one draft defect?', {}, 'Apply draft change'), '/physical/apply');
  let current = await snapshot(), defect = current.physical.defects.find(value => value.id === preview.changed_ids[0]), reference = defect.evidence[0];
  assert.equal(current.physical.defects.length, 1); assert.equal(current.physical.barriers.length, 0); assert.equal(current.physical.services.length, 0); assert.equal(defect.quantity, undefined); assert.equal(defect.marker, undefined);
  assert.equal(reference.document_sha256, sourceHash); assert.equal(reference.document_id, before.documents[0].id); assert.equal(reference.page, 3); assert.equal(reference.region.length, 4);
  const retainedPoint = JSON.parse(reference.note.match(/PDF point (\[[^\]]+\])/)[1]); retainedPoint.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - acceptedPoint[axis]) < 1e-9, 'Pending point and retained source coordinates agree'));
  assert.ok(reference.region.every(([x, y]) => x >= 20 && x <= 800 && y >= 30 && y <= 570)); assert.equal(reference.region[0][0], 20); assert.equal(reference.region[0][1], 30); assert.match(reference.note, /does not represent physical size or quantity/);
  const sourceMarker = page.locator('.takeoff-overlay .takeoff-physical-marker-hit'), callout = page.locator('.takeoff-overlay .takeoff-physical-callout');
  await expect(sourceMarker).toHaveCount(1); await expect(callout).toHaveCount(1);
  for (const element of [sourceMarker, callout]) await expect(element).toHaveAttribute('data-physical-id', defect.id);
  const summary = `${defect.display_id} · PLACED-DEFECT · FRL -/120/120\n0 substrates · 0 services`;
  await expect(sourceMarker).toHaveAttribute('aria-label', `Source annotation ${defect.display_id} · ${summary}`);
  await expect(callout).toHaveAttribute('aria-label', `Callout ${defect.display_id} · ${summary}`);
  await expect(callout.locator('.takeoff-physical-callout-frame')).toHaveCount(1);
  for (const text of [defect.display_id, 'PLACED-DEFECT', 'FRL -/120/120', '0 substrates · 0 services']) await expect(callout).toContainText(text);
  assert.deepEqual(defect.annotation, { document_id: reference.document_id, document_sha256: sourceHash, page: 3, point: retainedPoint });
  const renderedSourcePoint = await sourceMarker.evaluate(marker => {
    const [, , width, height] = marker.ownerSVGElement.getAttribute('viewBox').split(/\s+/).map(Number);
    return [20 + Number(marker.getAttribute('cy')) / height * 780, 30 + Number(marker.getAttribute('cx')) / width * 540];
  });
  renderedSourcePoint.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - retainedPoint[axis]) < 1e-9, 'Rendered source annotation keeps the exact retained PDF point'));
  await expect(page.getByRole('complementary', { name: 'Item Details', exact: true }).getByLabel('Defect Ref.', { exact: true })).toHaveValue('PLACED-DEFECT');
  await expect(page.locator('.takeoff-defect-pending')).toHaveCount(0); evidence.placedDefect = { id: defect.id, source: reference, annotation: defect.annotation, renderedSourcePoint, summary, pendingPoint: acceptedPoint, noBarrierOrServiceCreated: true };
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await countCursor();
  await page.mouse.click(...await screen([400, 400])); await response(() => dialog('Add Defect', { 'Defect Ref.': 'CANCELLED-REVIEW' }, 'Preview new draft'), '/physical/preview');
  const beforeReviewCancel = structuredClone(current.physical); await dialog('Create one draft defect?', {}, 'Cancel'); await expect(page.locator('.takeoff-defect-pending')).toHaveCount(0); assert.deepEqual((await snapshot()).physical, beforeReviewCancel); evidence.reviewCancelCreatesNothing = true;
  await page.getByRole('button', { name: 'Select', exact: true }).click(); await chooseTakeoff(page, 'Service Plans'); await page.getByRole('button', { name: 'Count', exact: true }).click(); await countCursor();
  await page.mouse.click(...await screen([300, 300])); await expect(page.getByRole('dialog').getByRole('heading', { name: 'Create draft barrier', exact: true })).toBeVisible(); await dialog('Create draft barrier', {}, 'Cancel'); evidence.servicePlanBarrierPlacementPreserved = true;
  await page.getByRole('button', { name: 'Select', exact: true }).click(); await chooseTakeoff(page, 'Defect Reports');
  current = await snapshot(); const physicalBeforeSave = structuredClone(current.physical);
  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as'); const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.physical, physicalBeforeSave);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'PENETRATIONS'); current = await snapshot(); assert.deepEqual(current.physical, physicalBeforeSave); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 3); await page.setViewportSize({ width: 764, height: 764 }); await page.locator('.takeoff-viewer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'retained-defect-source-location-764.png') }); evidence.savedReopened = true;
  assert.equal(hash(info.fixture), sourceHash); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, disposablePort: info.port, evidence, physicalRequests, errors, runtimeBefore, runtimeAfter: runtimeHashes() }, null, 2)); console.log(`Count tools and placed Defect acceptance passed: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-3000)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, physicalRequests, errors, error: String(error) }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill(); });
