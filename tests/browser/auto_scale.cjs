const { clickProjectControl } = require('./project_actions.cjs');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Printed-scale acceptance uses only generated PDFs and a disposable server.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `auto-scale-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], detections = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function response(action, suffix, op) {
  const pending = page.waitForResponse(value => value.url().endsWith(suffix) && (!op || value.request().postDataJSON()?.op === op)); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); await idle(); return body;
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible({timeout:30000});
  for (const [label, value] of Object.entries(values)) await modal.getByLabel(label, { exact: true }).fill(String(value));
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function point([x, y]) {
  const overlay = page.locator('.takeoff-overlay');
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  const position = [box.x + x / 600 * box.width, box.y + (800-y) / 800 * box.height];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport'), position), true);
  return position;
}
let savedOnce = false;
async function saveAndReopen(info) {
  await response(() => clickProjectControl(page, 'Save'), savedOnce ? '/api/project/save' : '/api/project/save-as');
  savedOnce = true;
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project));
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  return saved;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/auto-calibrate')) detections.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  let reply = await response(() => page.locator('#takeoff-upload').setInputFiles(info.scale_fixture), '/auto-calibrate');
  assert.equal(reply.auto_calibration.status, 'applied');
  const calibration = reply.snapshot.calibrations[0], document = reply.snapshot.documents[0];
  assert.equal(calibration.scale_denominator, 100); assert.equal(document.pages[0].user_unit, 2);
  assert.ok(Math.abs(calibration.distance_m - 5.08) < 1e-12);
  assert.equal(calibration.printed_scale_evidence.text, 'SCALE 1:100'); assert.equal(calibration.printed_scale_evidence.source_sha256, document.sha256);
  const scale = page.getByRole('button', { name: 'Scale', exact: true });
  await expect(scale).toHaveAttribute('title', /1:100/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'automatic-footer-scale.png') });
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  assert.equal(detections.length, 1); assert.equal((await snapshot()).calibrations.length, 1, 'Rerender never creates a duplicate calibration');

  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await page.mouse.click(...await point([100, 400])); await page.mouse.dblclick(...await point([244, 400]));
  reply = await response(() => dialog('Add steel object', { 'Member mark': 'AUTOMATIC-SCALE', 'Count/QTY': 1 }, 'Add item'), '/commands', 'create_item');
  const item = reply.snapshot.items[0], measured = reply.item_results.find(value => value.id === item.id).length_m;
  assert.ok(Math.abs(measured-10.16) < .05, `Physical UserUnit is applied once: ${measured} ~= 10.16 m`);
  const [start, end] = item.geometry.points, sourceUnits = Math.hypot(end[0]-start[0], end[1]-start[1]);
  assert.ok(Math.abs(measured-sourceUnits*2*.0254/72*100) < 1e-12, 'Measured source coordinates use the exact physical conversion');
  assert.equal(item.measurement.calibration_id, calibration.id);
  assert.equal(item.review, null); assert.equal(item.confirmation, null, 'Automatic scale never approves measured quantities');
  evidence.measurement = { length_m: measured, expected_m: 10.16, user_unit: 2, source_distance_units: sourceUnits };

  await saveAndReopen(info);
  assert.deepEqual((await snapshot()).calibrations, [calibration]);
  await expect(scale).toHaveAttribute('title', /1:100/);
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(calibration.id);
  assert.equal(detections.length, 1, 'Reopening a saved automatic scale selects it without extracting again');

  await scale.click(); await page.getByRole('button', { name: 'Edit calibration', exact: true }).click();
  reply = await response(() => dialog('Revise page calibration', { 'Calibration name': 'Manual correction', 'Known real distance (metres)': 10.16 }, 'Revise calibration'), '/commands', 'update_calibration');
  const manual = reply.snapshot.calibrations[1];
  assert.equal(manual.name, 'Manual correction'); assert.equal(manual.printed_scale_evidence, undefined); assert.equal(manual.scale_denominator, undefined);
  assert.deepEqual(reply.snapshot.calibrations[0], calibration, 'Original extracted scale and evidence stay immutable');
  assert.ok(Math.abs(reply.item_results.find(value => value.id === item.id).length_m - measured*2) < 1e-10);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  assert.equal(detections.length, 1); assert.deepEqual((await snapshot()).calibrations[1], manual, 'Rerender preserves the manual correction');

  for (const pageNumber of [2, 3]) {
    reply = await response(async () => { await page.getByLabel('Page number', { exact: true }).fill(String(pageNumber)); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, '/auto-calibrate');
    assert.equal(reply.auto_calibration.status, 'not_detected');
    assert.equal(reply.snapshot.calibrations.length, 2);
    await expect(page.getByLabel('Drawing calibration', { exact: true }).locator('option:checked')).toHaveText('No Scale Selected');
    await page.screenshot({ path: path.join(output, `manual-required-page-${pageNumber}.png`) });
  }
  await response(() => page.getByRole('button', { name: 'First page', exact: true }).click(), '/commands', 'record_render');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(manual.id);
  await expect(page.locator('#takeoff-active-scale')).toHaveText('Manual correction');
  const savedSnapshot = await snapshot(); assert.deepEqual(savedSnapshot.calibrations, [calibration, manual]);
  const saved = await saveAndReopen(info); assert.deepEqual(saved.takeoffs.calibrations, savedSnapshot.calibrations);
  const reopened = await snapshot(); assert.deepEqual(reopened.calibrations, savedSnapshot.calibrations); assert.deepEqual(reopened.documents, savedSnapshot.documents);
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(manual.id);
  await expect(page.locator('#takeoff-active-scale')).toHaveText('Manual correction');
  await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'manual-scale-reopened.png') });

  // A manually chosen preset must return with its page, then drive the actual
  // measurement rather than only correcting the text beside the Scale button.
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  const presetDocument = (await snapshot()).documents.find(value => value.id !== document.id);
  assert.ok(presetDocument); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue('');
  async function preset(denominator) {
    if (await scale.getAttribute('aria-expanded') !== 'true') await scale.click();
    await expect(page.getByLabel('Drawing calibration', { exact: true })).toBeVisible(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption(`scale:${denominator}`);
    return response(() => page.getByRole('dialog').getByRole('button', { name: 'Apply scale', exact: true }).click(), '/commands', 'add_calibration');
  }
  async function go(number) { await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill(String(number)); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, number); }
  reply = await preset(100); const presetScale = reply.snapshot.calibrations.find(value => value.document_id === presetDocument.id && value.page === 1);
  await expect(page.locator('#takeoff-active-scale')).toHaveText('Page 1 scale · 1:100');
  await go(2); await expect(page.locator('#takeoff-active-scale')).toHaveText('No Scale Selected');
  reply = await preset(50); const secondScale = reply.snapshot.calibrations.find(value => value.document_id === presetDocument.id && value.page === 2);
  const beforeReturning = await snapshot();
  await go(1); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(presetScale.id); await expect(page.locator('#takeoff-active-scale')).toHaveText('Page 1 scale · 1:100');
  await go(2); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(secondScale.id); await expect(page.locator('#takeoff-active-scale')).toHaveText('Page 2 scale · 1:50');
  await go(1); assert.deepEqual((await snapshot()).calibrations, beforeReturning.calibrations); assert.deepEqual((await snapshot()).items, beforeReturning.items, 'Navigation does not revise retained measurements or calibration history');
  await chooseTakeoff(page, 'WALLS'); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(presetScale.id);
  await page.getByRole('button', { name: 'Length', exact: true }).click();
  async function presetPoint([x, y]) {
    const overlay = page.locator('.takeoff-overlay'); await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
    const box = await overlay.boundingBox(); const position = [box.x + x / 842 * box.width, box.y + (595 - y) / 595 * box.height];
    assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport'), position), true); return position;
  }
  await page.mouse.click(...await presetPoint([100, 400])); await page.mouse.click(...await presetPoint([244, 400])); await page.locator('.takeoff-viewport').press('Enter');
  reply = await response(() => dialog('Add length measurement', { Item: 'RESTORED-PAGE-SCALE' }, 'Add measurement'), '/commands', 'create_item');
  const restoredItem = reply.snapshot.items.find(value => value.fields.mark === 'RESTORED-PAGE-SCALE'), restoredResult = reply.item_results.find(value => value.id === restoredItem.id);
  assert.equal(restoredItem.measurement.calibration_id, presetScale.id); assert.equal(restoredItem.geometry.document_id, presetDocument.id); assert.equal(restoredItem.geometry.page, 1);
  const restoredDistance = Math.hypot(restoredItem.geometry.points[1][0] - restoredItem.geometry.points[0][0], restoredItem.geometry.points[1][1] - restoredItem.geometry.points[0][1]);
  assert.ok(Math.abs(restoredResult.length_m - restoredDistance * .0254 / 72 * 100) < 1e-12, 'Restored preset uses full original-coordinate precision');
  assert.equal(restoredItem.confirmation, null); assert.equal(restoredItem.review, null);
  await renderDrawing(page, () => page.getByLabel('Drawing document', { exact: true }).selectOption(document.id), 1); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(manual.id);
  await renderDrawing(page, () => page.getByLabel('Drawing document', { exact: true }).selectOption(presetDocument.id), 1); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(presetScale.id);
  const presetSavedSnapshot = await snapshot(), presetSaved = await saveAndReopen(info); assert.deepEqual(presetSaved.takeoffs.calibrations, presetSavedSnapshot.calibrations); assert.deepEqual((await snapshot()).items, presetSavedSnapshot.items);
  await renderDrawing(page, () => page.getByLabel('Drawing document', { exact: true }).selectOption(presetDocument.id), 1); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(presetScale.id); await expect(page.locator('#takeoff-active-scale')).toHaveText('Page 1 scale · 1:100');
  await go(2); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(secondScale.id); await go(1); await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(presetScale.id);
  evidence.restoredPreset = { document_id: presetDocument.id, page1: presetScale, page2: secondScale, item: restoredItem, exact_length_m: restoredResult.length_m, savedReopened: true };
  await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'preset-scale-restored-and-reopened.png') });
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, strictCsp: true, evidence, calibration, manual, detections, errors }, null, 2));
  console.log(`PASS: printed footer calibration, physical PDF units, manual/preset page and document restoration, exact restored measurement, ambiguous-scale refusal, no rerender duplicates, Save As and reopen. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
