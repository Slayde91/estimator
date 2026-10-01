// Rendered acceptance journey against a disposable production server and synthetic PDF.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `lineage-${Date.now()}`);
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
  const inspector = page.locator('.takeoff-register-editor');
  for (const [label, value] of Object.entries(values)) {
    const field = inspector.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  return command(() => inspector.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
}
async function reviewConfirm(count = 1) {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog(`Confirm ${count} items?`, {}, 'Confirm items'), 'confirm_items');
}
async function transfer(update = false, expectedNote = null, count = 1) {
  const pending = page.waitForResponse(r => r.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: update ? 'Update linked rows' : 'Preview transfer', exact: true }).click();
  const response = await pending; const preview = await response.json();
  fs.writeFileSync(path.join(output, `transfer-${Date.now()}.json`), JSON.stringify({ request: response.request().postDataJSON(), response: preview }, null, 2));
  assert.equal(response.status(), 200, JSON.stringify(preview));
  if (expectedNote) await expect(page.getByRole('dialog')).toContainText(expectedNote);
  const applied = page.waitForResponse(r => r.url().endsWith('/transfer-apply'));
  await dialog(`${update ? 'Update' : 'Transfer'} ${count} confirmed items?`, {}, update ? 'Update linked rows' : 'Add to schedule');
  const result = await applied; const state = await result.json(); assert.equal(result.status(), 200, JSON.stringify(state)); await workspaceIdle();
  return { preview, state };
}
async function screenshot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
async function fitCurrentDrawing(name) {
  await expect(page.locator('.takeoff-document[aria-selected="true"]')).toContainText(name);
  await page.waitForFunction(filename => {
    try { const snapshot = window.CeasefireTakeoffs.projectSnapshot(), doc = snapshot.documents.find(value => value.name === filename);
      return doc && snapshot.render_checks.some(check => check.document_id === doc.id && check.page === 1 && check.success);
    } catch { return false; }
  }, name);
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  await workspaceIdle();
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
}
(async () => {
  const info = await ready;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) requests.push({ url: response.url(), status: response.status() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await expect(page.locator('#project-tools')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await fitCurrentDrawing('synthetic-drawings.pdf');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100 / 842, 1 - 75 / 595], [500 / 842, 1 - 75 / 595]]);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': 'Ten metre baseline', 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 400 / 595], [500 / 842, 1 - 400 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  let state = await command(() => dialog('Add steel object', { 'Member mark': 'STEEL-REPEATED', 'Physical quantity': 3 }, 'Add item'), 'create_item');
  await fillInspector({ 'Level': 'SYNTHETIC', 'Member type': 'Beam', 'Steel section': '100UC15', 'Protection product': 'CAFCO 300', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides' });
  state = await reviewConfirm(); const steel = state.snapshot.items.find(item => item.mode === 'steel');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  state = await command(() => dialog('Partition repeated steel members', { 'Physical members in the first group': 1 }, 'Partition members'), 'split_steel_group');
  const groups = state.snapshot.items.filter(item => item.predecessor_ids.includes(steel.id));
  assert.deepEqual(groups.map(item => item.quantity).sort(), [1, 2]);
  assert.deepEqual(groups.flatMap(item => item.member_ids).sort(), [...steel.member_ids].sort());
  for (const group of groups) {
    assert.equal(group.state, 'draft'); assert.equal(group.confirmation, null); assert.equal(group.review, null);
    assert.deepEqual(group.geometry, steel.geometry); assert.deepEqual(group.measurement, steel.measurement);
    assert.deepEqual(group.fields, steel.fields); assert.deepEqual(group.evidence, steel.evidence);
    assert.ok(Math.abs(state.item_results.find(item => item.id === group.id).length_m - 10) < .02);
  }
  await page.getByLabel('Filter register', { exact: true }).fill('STEEL-REPEATED');
  await page.getByRole('button', { name: 'Select filtered items', exact: true }).click();
  await screenshot('partitioned-steel-members.png');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  state = await command(() => dialog('Merge repeated-member groups?', {}, 'Merge steel groups'), 'merge_steel_groups');
  const merged = state.snapshot.items.find(item => item.mode === 'steel');
  assert.equal(merged.quantity, 3); assert.equal(merged.state, 'draft'); assert.equal(merged.confirmation, null);
  assert.deepEqual([...merged.member_ids].sort(), [...steel.member_ids].sort());
  assert.deepEqual(merged.geometry, steel.geometry); assert.deepEqual(merged.measurement, steel.measurement); assert.deepEqual(merged.evidence, steel.evidence);
  assert.deepEqual(new Set(merged.predecessor_ids), new Set([steel.id, ...groups.map(item => item.id)]));
  assert.ok(Math.abs(state.item_results.find(item => item.id === merged.id).total_length_m - 30) < .05);
  await screenshot('reunited-steel-members.png');
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.locator('[data-mode="duct"]').click();
  await fitCurrentDrawing('synthetic-drawings.pdf');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 190 / 595], [500 / 842, 1 - 190 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  state = await command(() => dialog('Add duct object', { 'Run ID': 'LINEAGE-DUCT', 'Physical quantity': 1 }, 'Add item'), 'create_item');
  const originalRun = state.snapshot.items.find(item => item.mode === 'duct').id;
  await fillInspector({ 'Level': 'SYNTHETIC', 'Width (mm)': 600, 'Height (mm)': 400, 'Protection product': 'FyreWrap', 'Duct application / exposure': 'Internal', 'Mechanical system': 'Supply air', 'FRL': '120/120/120', 'Orientation': 'Horizontal', 'Wall penetrations': 0, 'Floor penetrations': 0 });
  await reviewConfirm(); let transferred = await transfer(); const ancestorBinding = transferred.state.snapshot.transfers[0];
  assert.ok(Math.abs(transferred.preview.inputs.CALCULATOR['D' + ancestorBinding.row] - 10) < .02);
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  state = await command(() => dialog('Split this physical run', { 'Split position (% of traced length)': 50 }, 'Split run'), 'split_item');
  const runs = state.snapshot.items.filter(item => item.predecessor_ids.includes(originalRun)); assert.equal(runs.length, 2);
  await page.getByLabel('Filter register', { exact: true }).fill('LINEAGE-DUCT');
  await page.getByRole('button', { name: 'Select filtered items', exact: true }).click(); await reviewConfirm(2);
  const before = await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.projectSnapshot() }));
  const pending = page.waitForResponse(response => response.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
  const rejected = await pending, rejection = await rejected.json(); assert.equal(rejected.status(), 400); assert.match(rejection.error, /unresolved predecessor rows/);
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('unresolved predecessor rows');
  assert.deepEqual(await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.projectSnapshot() })), before);
  await screenshot('successor-transfer-blocked.png');
  await expect(page.getByRole('button', { name: 'Linked calculator rows', exact: true })).toBeVisible();
  // The source button on a preserved calculator row resolves its now-historical source.
  await page.locator('.nav-button[data-view="calculators"]').click();
  await page.locator('.calculator-choice').filter({ hasText: 'Ductwork (spray/wrap)' }).click();
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  await page.getByRole('button', { name: `Open takeoff ${originalRun}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Linked calculator rows', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('source replaced or deleted');
  await dialog('Linked calculator rows', { 'Linked row or page': ancestorBinding.id }, 'Review selected link');
  await expect(page.getByRole('dialog')).toContainText('manual quantities remain in totals');
  await expect(page.getByRole('dialog')).toContainText(originalRun);
  await screenshot('historical-link-detach-confirmation.png');
  state = await command(() => dialog(`Detach workbook row ${ancestorBinding.row}?`, {}, 'Detach link'), 'detach_transfers');
  assert.equal(state.snapshot.transfers.length, 0);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.projectSnapshot()), before.calculators, 'Detach must retain all manual values');
  // Explicitly remove the old manual calculator line through its existing UI before retry.
  await page.locator('.nav-button[data-view="calculators"]').click();
  await page.locator('.calculator-choice').filter({ hasText: 'Ductwork (spray/wrap)' }).click();
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  const oldRow = page.locator(`tr[data-source-row="${ancestorBinding.row}"]`);
  await oldRow.getByRole('button', { name: /Remove line/ }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
  const cleared = await page.evaluate(() => window.CeasefireCalculators.projectSnapshot());
  for (const address of Object.keys(ancestorBinding.values)) assert.ok(cleared.ductwork.inputs.CALCULATOR[address] == null || cleared.ductwork.inputs.CALCULATOR[address] === '', `${address} must be explicitly cleared`);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.getByRole('button', { name: 'Select filtered items', exact: true }).click();
  transferred = await transfer(false, null, 2); assert.equal(transferred.state.snapshot.transfers.length, 2);
  const lengths = transferred.state.snapshot.transfers.map(binding => transferred.preview.inputs.CALCULATOR['D' + binding.row]);
  assert.ok(lengths.every(length => Math.abs(length - 5) < .02)); assert.ok(Math.abs(lengths.reduce((sum, length) => sum + length, 0) - 10) < .02);
  const bindingIds = transferred.state.snapshot.transfers.map(binding => binding.id).sort();
  transferred = await transfer(false, null, 2); assert.ok(transferred.preview.changes.every(change => change.action === 'unchanged'));
  assert.deepEqual(transferred.state.snapshot.transfers.map(binding => binding.id).sort(), bindingIds);
  await screenshot('successors-transferred-once.png');
  const csp = await page.evaluate(() => window.qaCsp); assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, steel: { original: steel, partitioned: groups, merged }, duct: { originalRun, ancestorBinding, successorIds: runs.map(item => item.id), rejection, lengths, bindings: transferred.state.snapshot.transfers }, errors, requests, violations: csp }, null, 2));
  console.log(`PASS: repeated steel partition/reunion preserves physical identities and evidence; transferred duct successors block until explicit historical-link handling and manual row removal; safe retry/repeat totals10m. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(serverErrors.slice(-6000));
  if (page) { await screenshot('failure.png').catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { ending = true; fs.writeFileSync(path.join(output, 'server.log'), serverErrors); if (browser) await browser.close(); server.kill(); });
