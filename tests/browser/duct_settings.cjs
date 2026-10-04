const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Duct creation and settings acceptance at the annotated browser viewport size.
// All data, native dialog targets and PDFs belong to this disposable fixture.
const { chromium, expect } = require('@playwright/test');
const { openItemSettings, editSettings, settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `duct-settings-${Date.now()}`);
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
const errors = [], requests = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
const itemMutations = () => requests.filter(value => ['create_item', 'update_item', 'bulk_update'].includes(value.op));
async function response(action, suffix, op) {
  const pending = page.waitForResponse(value => value.url().endsWith(suffix) && (!op || value.request().postDataJSON()?.op === op)); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); await idle(); return body;
}
const command = (action, op) => response(action, '/commands', op);
async function snapshot() { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function serverSnapshot() {
  const result = await page.request.get(await page.evaluate(() => `${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`));
  assert.equal(result.status(), 200, await result.text()); return (await result.json()).snapshot;
}
async function fill(scope, label, value) {
  const field = scope.getByLabel(label, { exact: true });
  if (await field.evaluate(el => el.tagName) === 'SELECT') {
    await expect.poll(() => field.locator('option').evaluateAll(options => options.map(option => option.value))).toContain(String(value));
    await field.selectOption(String(value));
  } else await field.fill(String(value));
}
async function nativeChoices(scope, label, expected) {
  const field = scope.getByLabel(label, { exact: true });
  assert.equal(await field.evaluate(el => el.tagName), 'SELECT', `${label} is a native select`);
  await expect(field).not.toHaveAttribute('list');
  await expect.poll(() => field.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['', ...expected.map(String)]);
}
async function revealFromRegister(id, action, target) {
  const button = page.locator(`tr[data-item-id="${id}"]`).getByRole('button', { name: action, exact: true });
  await button.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ y: window.scrollY, drawingTop: document.querySelector('#takeoff-viewport').getBoundingClientRect().top }));
  assert.ok(before.drawingTop < 0, 'The register action starts below the drawing');
  await button.click(); await expect(target).toBeFocused(); await settingsSettled(page);
  const after = await target.evaluate(el => ({ y: window.scrollY, top: el.getBoundingClientRect().top, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom }));
  assert.ok(before.y - after.y > 100, `${action} scrolls the outer page back to the drawing area`);
  assert.ok(Math.abs(after.top - after.headerBottom - 12) <= 2, `${action} target is visible directly below the sticky header`);
  return { before, after };
}
// Old projects may contain choices no longer in today's workbook. Seed only
// that retained-record condition through the validated API, then exercise the
// rendered UI and normal Save/Load for all edits and compatibility assertions.
async function retainedFixture(id, fields) {
  await page.evaluate(async ({ id, fields }) => {
    const takeoffs = window.CeasefireTakeoffs, session = takeoffs.sessionId(), current = takeoffs.projectSnapshot();
    const response = await fetch(`/api/takeoffs/sessions/${session}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op: 'update_item', item_id: id, changes: { fields } }) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
    takeoffs.applyProject(await takeoffs.prepareProject(result.snapshot, session)); await takeoffs.showSource(id);
  }, { id, fields });
  await settingsSettled(page);
}

(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1146, height: 764 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot().render_checks.some(check => check.page === 1 && check.success); } catch { return false; } });
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await page.locator('[data-mode="duct"]').click();
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => page.getByRole('dialog').getByRole('button', { name: 'Apply scale', exact: true }).click(), 'add_calibration');
  const choicesReply = await page.request.get(`http://127.0.0.1:${info.port}/api/takeoffs/options?calculator=ductwork`);
  assert.equal(choicesReply.status(), 200); const choices = await choicesReply.json();
  const optionsFor = column => choices.columns.find(value => value.column === column).options;
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  const overlay = page.locator('.takeoff-overlay');
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 210));
  const drawing = await overlay.boundingBox(); assert.ok(drawing?.width && drawing?.height);
  for (const x of [0.25, 0.65]) {
    const point = [drawing.x + drawing.width * x, drawing.y + drawing.height * 0.45];
    assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-overlay'), point), true, 'Trace clicks reach the drawing');
    await page.mouse.click(...point);
  }
  await page.locator('#takeoff-viewport').press('Enter');
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: 'Add duct object', exact: true })).toBeVisible();
  const values = { 'Item': 'DUCT-CREATE-QA', 'Level': 'L02', 'WxH (mm)': '600x', 'Product': 'FyreWrap', 'Exposure': 'Internal', 'FRL': '120/120/120', 'Orientation': 'Horizontal', 'Wall penetrations': 2, 'Floor penetrations': 0, 'Count/QTY': 1 };
  for (const label of Object.keys(values)) await expect(modal.getByLabel(label, { exact: true })).toHaveCount(1);
  for (const label of ['Run ID', 'Width (mm)', 'Height (mm)', 'Mechanical system', 'Duct application / exposure']) await expect(modal.getByLabel(label, { exact: true })).toHaveCount(0);
  for (const [label, column] of [['Product', 'C'], ['Exposure', 'H'], ['FRL', 'E']]) await nativeChoices(modal, label, optionsFor(column));
  for (const [label, value] of Object.entries(values)) await fill(modal, label, value);
  const beforeCreate = itemMutations().length;
  await modal.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(modal).toBeVisible();
  assert.equal(await modal.getByLabel('WxH (mm)', { exact: true }).evaluate(el => el.validity.patternMismatch), true);
  assert.equal(itemMutations().length, beforeCreate, 'Invalid creation sends no item command');
  await fill(modal, 'WxH (mm)', '600 x 400');
  await modal.evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'duct-creation-top.png') });
  await modal.getByLabel('Count/QTY', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'duct-creation-details.png') });
  const created = await command(() => modal.getByRole('button', { name: 'Add item', exact: true }).click(), 'create_item');
  const item = created.snapshot.items.find(value => value.fields.mark === 'DUCT-CREATE-QA'), id = item.id;
  assert.deepEqual(item.fields, { mark: 'DUCT-CREATE-QA', level: 'L02', width_mm: 600, height_mm: 400, product: 'FyreWrap', exposure: 'Internal', frl: '120/120/120', orientation: 'Horizontal', wall_penetrations: 2, floor_penetrations: 0, shape: 'rectangular' });
  assert.equal(item.quantity, 1); assert.equal('duct_size' in item.fields, false);
  evidence.createdFields = item.fields; evidence.invalidCreationNoCommand = true;
  console.log('Full duct details create canonical dimensions and native calculator choices at 1146x764.');

  const panel = await openItemSettings(page, id), beforeInvalid = await snapshot(), mutationCount = itemMutations().length;
  await panel.getByLabel('WxH (mm)', { exact: true }).fill('800x');
  await panel.getByLabel('WxH (mm)', { exact: true }).press('Tab');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('WxH');
  await panel.getByLabel('Level', { exact: true }).fill('L03');
  await panel.getByLabel('Level', { exact: true }).press('Tab');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('WxH');
  assert.equal(itemMutations().length, mutationCount, 'Invalid WxH blocks the whole pending settings edit');
  assert.deepEqual(await serverSnapshot(), beforeInvalid, 'No width, height or unrelated field is partially saved');
  const repaired = await editSettings(page, { 'WxH (mm)': '800X450.5' });
  const repairedItem = repaired.snapshot.items.find(value => value.id === id);
  assert.equal(repairedItem.fields.width_mm, 800); assert.equal(repairedItem.fields.height_mm, 450.5); assert.equal(repairedItem.fields.level, 'L03');
  const dimensionEdit = itemMutations().slice(mutationCount);
  assert.equal(dimensionEdit.length, 1); assert.deepEqual(dimensionEdit[0].changes.fields, { width_mm: 800, height_mm: 450.5, level: 'L03' });
  evidence.invalidSettingsAtomic = true; evidence.repairedDimensions = repairedItem.fields;

  const legacy = { system: 'Retained mechanical system', shape: 'circular', diameter_mm: 250, product: ' Legacy product ', exposure: ' Legacy exposure ', frl: ' Legacy FRL ', notes: 'Retained source notes' };
  await retainedFixture(id, legacy);
  await openItemSettings(page, id);
  for (const [label, key] of [['Product', 'product'], ['Exposure', 'exposure'], ['FRL', 'frl']]) {
    const control = panel.getByLabel(label, { exact: true }); await expect(control).toHaveValue(legacy[key]);
    await expect(control.locator('option:checked')).toContainText('retained');
  }
  await expect(panel.getByLabel('Mechanical system', { exact: true })).toHaveCount(0);
  const legacyEdited = await editSettings(page, { 'Level': 'L04' });
  const retained = legacyEdited.snapshot.items.find(value => value.id === id);
  for (const [key, value] of Object.entries(legacy)) assert.equal(retained.fields[key], value, `${key} survives unrelated settings edits exactly`);
  assert.deepEqual(retained.geometry, item.geometry); assert.deepEqual(retained.member_ids, item.member_ids);
  evidence.retainedFields = legacy;
  await expect(page.locator('.takeoff-register-editor')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'View/Edit', exact: true })).toHaveCount(1);
  await expect(page.locator(`tr[data-item-id="${id}"]`).getByRole('button', { name: id, exact: true })).toHaveCount(0);
  evidence.viewScroll = await revealFromRegister(id, 'View', page.locator('#takeoff-viewport'));
  evidence.editScroll = await revealFromRegister(id, 'Edit item', panel);
  await expect(panel).toHaveJSProperty('scrollTop', 0);
  await page.screenshot({ path: path.join(output, 'duct-settings-pane.png') });
  await panel.getByLabel('Item', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'duct-settings-item-details.png') });
  console.log('Invalid dimensions remain atomic; retained hidden values and outer View/Edit scrolling passed.');

  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')), savedItem = saved.takeoffs.items.find(value => value.id === id);
  assert.deepEqual(savedItem.fields, retained.fields); assert.equal('duct_size' in savedItem.fields, false);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await command(() => page.getByRole('button', { name: 'Takeoffs', exact: true }).click(), 'record_render');
  await page.locator('[data-mode="duct"]').click();
  const reopened = await openItemSettings(page, id); await settingsSettled(page);
  await expect(reopened.getByLabel('WxH (mm)', { exact: true })).toHaveValue('800 x 450.5');
  await expect(reopened.getByLabel('Level', { exact: true })).toHaveValue('L04');
  for (const [label, key] of [['Product', 'product'], ['Exposure', 'exposure'], ['FRL', 'frl']]) await expect(reopened.getByLabel(label, { exact: true })).toHaveValue(legacy[key]);
  const afterLoad = await snapshot(); assert.deepEqual(afterLoad.items.find(value => value.id === id).fields, retained.fields);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  evidence.saveReopen = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, viewport: page.viewportSize(), evidence, item: afterLoad.items.find(value => value.id === id), requests, errors, savedProject: info.project }, null, 2));
  console.log(`PASS: duct creation, native choices, atomic WxH, retained data, outer navigation and save/reopen. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
