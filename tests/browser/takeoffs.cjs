// Rendered acceptance journey against a disposable production server and synthetic PDF.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `journey-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let serverErrors = '';
server.stderr.on('data', data => { serverErrors += data; });
let ending = false;
server.on('exit', (code, signal) => { if (!ending) console.error(`QA server exited unexpectedly: code=${code} signal=${signal}`); });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${serverErrors}`)), 120000);
  server.stdout.on('data', data => { text += data; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
});
let browser, page;
const errors = [], violations = [], requests = [];
async function workspaceIdle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); }
async function command(action, op) {
  const pending = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.op === op);
  await action(); const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); await workspaceIdle(); return body;
}
async function dialog(title, values, button) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: button, exact: true }).click();
}
async function draw(points) {
  const overlay = page.locator('.takeoff-overlay');
  await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox(); assert.ok(box && box.width > 0);
  for (const [x, y] of points) await page.mouse.click(box.x + x * box.width, box.y + y * box.height);
}
async function fillInspector(values) {
  const inspector = page.locator('.takeoff-inspector');
  for (const [label, value] of Object.entries(values)) {
    const field = inspector.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  return command(() => inspector.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
}
async function reviewConfirm() {
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await command(() => dialog('Review 1 items?', {}, 'Mark reviewed'), 'review_items');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog('Confirm 1 items?', {}, 'Confirm reviewed items'), 'confirm_items');
}
async function transfer(update = false) {
  const pending = page.waitForResponse(r => r.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: update ? 'Update linked rows' : 'Preview transfer', exact: true }).click();
  const response = await pending; const preview = await response.json();
  fs.writeFileSync(path.join(output, `transfer-${Date.now()}.json`), JSON.stringify({ request: response.request().postDataJSON(), response: preview }, null, 2));
  assert.equal(response.status(), 200, JSON.stringify(preview));
  const applied = page.waitForResponse(r => r.url().endsWith('/transfer-apply'));
  await dialog(`${update ? 'Update' : 'Transfer'} 1 confirmed items?`, {}, update ? 'Update linked rows' : 'Add to schedule');
  const result = await applied; const state = await result.json(); assert.equal(result.status(), 200, JSON.stringify(state)); await workspaceIdle();
  return { preview, state };
}
(async () => {
  const info = await ready;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => requests.push({ url: request.url(), failure: request.failure()?.errorText }));
  page.on('response', r => { if (r.status() >= 400) requests.push({ url: r.url(), status: r.status() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', e => window.qaCsp.push({ directive: e.effectiveDirective, blocked: e.blockedURI })); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload PDFs', exact: true })).toBeVisible();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  await workspaceIdle();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100 / 842, 1 - 75 / 595], [500 / 842, 1 - 75 / 595]]);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': 'Ten metre baseline', 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 400 / 595], [500 / 842, 1 - 400 / 595]]);
  await page.getByRole('button', { name: 'Finish trace', exact: true }).click();
  let state = await command(() => dialog('Add steel object', { 'Member mark': 'B17', 'Explicit physical quantity': 2 }, 'Add draft item'), 'create_item');
  const steelId = state.snapshot.items[0].id;
  assert.ok(Math.abs(state.item_results[0].length_m - 10) < 0.02);
  state = await fillInspector({ 'Level': 'L02', 'Member type': 'Beam', 'Steel section': '100UC15', 'Protection product': 'CAFCO 300', 'Fire period (min)': 120, 'Exposed sides': 3, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides' });
  // Bulk editing is one atomic operation, and undo restores the same identities.
  await page.getByLabel('Bulk edit field', { exact: true }).selectOption('level');
  await page.getByLabel('Bulk edit value', { exact: true }).fill('L03');
  await page.getByRole('button', { name: 'Apply to selected', exact: true }).click();
  await command(() => dialog('Change 1 items?', {}, 'Apply bulk change'), 'bulk_update');
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.equal(state.snapshot.items[0].id, steelId); assert.equal(state.snapshot.items[0].fields.level, 'L02');
  await page.getByLabel('Filter register', { exact: true }).fill('B17');
  await page.getByLabel('Sort register', { exact: true }).selectOption('level');
  await page.getByLabel('Group register', { exact: true }).selectOption('level');
  await expect(page.locator(`tr[data-item-id="${steelId}"]`)).toHaveCount(1);
  await page.locator(`tr[data-item-id="${steelId}"]`).hover();
  await expect(page.locator('.takeoff-shape.hovered')).toHaveCount(1);
  await page.getByLabel('Show B17 on drawing', { exact: true }).uncheck();
  await expect(page.locator(`.takeoff-hit[data-item-id="${steelId}"]`)).toHaveCount(0);
  await page.getByLabel('Show B17 on drawing', { exact: true }).check();
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.getByLabel('Group register', { exact: true }).selectOption('');
  await reviewConfirm();
  let transferred = await transfer();
  assert.equal(transferred.preview.inputs.SCHEDULE.I10, 2); assert.ok(Math.abs(transferred.preview.inputs.SCHEDULE.J10 - 10) < 0.02);
  const firstBinding = transferred.state.snapshot.transfers[0];
  transferred = await transfer();
  assert.equal(transferred.state.snapshot.transfers.length, 1); assert.equal(transferred.state.snapshot.transfers[0].id, firstBinding.id);
  // Reconfirming an explicit source edit allows a reviewed linked-row update.
  await fillInspector({ 'Physical quantity': 3 }); await reviewConfirm();
  transferred = await transfer(true); assert.equal(transferred.preview.inputs.SCHEDULE.I10, 3);
  await page.screenshot({ path: path.join(output, 'confirmed-steel.png'), fullPage: true });
  await page.locator('[data-mode="duct"]').click();
  await page.getByRole('button', { name: 'Cite length', exact: true }).click();
  await draw([[100 / 842, 1 - 245 / 595], [600 / 842, 1 - 220 / 595]]);
  await dialog('Record a cited length', { 'Source-stated length (metres)': 10, 'Exact source reference / dimension': 'Synthetic duct schedule D-001, page 1: 10.0 m' }, 'Use cited length');
  state = await command(() => dialog('Add duct object', { 'Run ID': 'D-001', 'Explicit physical quantity': 1 }, 'Add draft item'), 'create_item');
  const ductId = state.snapshot.items.find(i => i.mode === 'duct').id;
  await fillInspector({ 'Level': 'L02', 'Shape': 'rectangular', 'Width (mm)': 600, 'Height (mm)': 400, 'Protection product': 'FyreWrap', 'Duct application / exposure': 'Internal', 'Mechanical system': 'Supply air', 'FRL': '120/120/120', 'Orientation': 'Horizontal', 'Wall penetrations': 0, 'Floor penetrations': 0 });
  await reviewConfirm(); transferred = await transfer();
  assert.equal(transferred.preview.inputs.CALCULATOR.B11, '600x400'); assert.equal(transferred.preview.inputs.CALCULATOR.D11, 10);
  // Real split/merge and recoverable deletion preserve source lineage and selection.
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 190 / 595], [500 / 842, 1 - 190 / 595]]);
  await page.getByRole('button', { name: 'Finish trace', exact: true }).click();
  let extra = await command(() => dialog('Add duct object', { 'Run ID': 'QA-SPLIT', 'Explicit physical quantity': 1 }, 'Add draft item'), 'create_item');
  const originalRun = extra.snapshot.items.find(i => i.fields.mark === 'QA-SPLIT').id;
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  extra = await command(() => dialog('Split this physical run', { 'Split position (% of traced length)': 50 }, 'Split run'), 'split_item');
  const splitRuns = extra.snapshot.items.filter(i => i.predecessor_ids.includes(originalRun)); assert.equal(splitRuns.length, 2);
  await page.getByLabel('Filter register', { exact: true }).fill('QA-SPLIT');
  await page.getByRole('button', { name: 'Select filtered items', exact: true }).click();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  extra = await command(() => dialog('Merge one physical object?', {}, 'Merge segments'), 'merge_items');
  const mergedRun = extra.snapshot.items.find(i => i.fields.mark === 'QA-SPLIT'); assert.deepEqual(new Set(mergedRun.predecessor_ids), new Set(splitRuns.map(i => i.id)));
  await page.locator('.takeoff-row-link').filter({ hasText: mergedRun.id.slice(0, 8) }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await command(() => dialog('Delete 1 objects?', {}, 'Delete objects'), 'delete_items');
  extra = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.ok(extra.snapshot.items.some(i => i.id === mergedRun.id));
  await page.locator('.takeoff-row-link').filter({ hasText: mergedRun.id.slice(0, 8) }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await command(() => dialog('Delete 1 objects?', {}, 'Delete objects'), 'delete_items');
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.locator('.takeoff-row-link').filter({ hasText: ductId.slice(0, 8) }).click();
  await page.screenshot({ path: path.join(output, 'confirmed-duct.png'), fullPage: true });
  // Project Save As commits the companion bundle before the complete JSON.
  const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/project/save-as'));
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  const saved = await savedResponse; assert.equal(saved.status(), 200, await saved.text());
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const savedJson = JSON.parse(fs.readFileSync(info.project));
  assert.equal(savedJson.version, 2); assert.equal(savedJson.takeoffs.items.length, 2);
  assert.ok(fs.existsSync(path.join(output, savedJson.takeoffs.companion_folder)));
  const loadedResponse = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const loaded = await loadedResponse; assert.equal(loaded.status(), 200, await loaded.text());
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
  await page.locator('[data-mode="duct"]').click();
  await page.locator('.takeoff-row-link').filter({ hasText: ductId.slice(0, 8) }).click();
  for (const format of ['CSV', 'XLSX']) {
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    const file = await download; const target = path.join(output, file.suggestedFilename()); await file.saveAs(target); assert.ok(fs.statSync(target).size > 100);
  }
  // PDF search discloses complete coverage and identifies pages with no text.
  await page.getByPlaceholder('Search PDF text…').fill('SYNTHETIC');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.takeoff-progress')).toContainText('4/4 pages inspected', { timeout: 30000 });
  await expect(page.locator('.takeoff-progress')).toContainText('2 without searchable text');
  // A malformed embedded image is not allowed to become an approved blank page.
  await page.locator('#takeoff-upload').setInputFiles(info.failed_fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(2, { timeout: 60000 });
  await page.locator('.takeoff-document').filter({ hasText: 'failed-image.pdf' }).click();
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('blocked', { timeout: 30000 });
  await page.waitForFunction(() => {
    try { const snapshot = window.CeasefireTakeoffs.projectSnapshot(), document = snapshot.documents.find(doc => doc.name === 'failed-image.pdf');
      return document && snapshot.render_checks.some(check => check.document_id === document.id && !check.success);
    } catch { return false; }
  });
  assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot().items.map(item => item.state)), ['confirmed', 'confirmed']);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'failed-content-blocked.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, stage: 'save-reopen-export', project: info.project, steelId, ductId, errors, requests, violations: await page.evaluate(() => window.qaCsp) }, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  console.log(`PASS: rendered upload, calibration, trace/cite, inspector, bulk/undo, confirmation, transfer/repeat/update, save/reopen and CSV/XLSX export. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(serverErrors.slice(-6000)); console.error(JSON.stringify(requests.slice(-10)));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { ending = true; fs.writeFileSync(path.join(output, 'server.log'), serverErrors); if (browser) await browser.close(); server.kill(); });
