// Real Add-to-schedule review with existing links and manual calculator edits.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `transfer-skip-${Date.now()}`);
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
const calculators = () => page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function response(action, suffix, status = 200, op) {
  const pending = page.waitForResponse(value => value.url().endsWith(suffix) && (!op || value.request().postDataJSON()?.op === op)); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), status, JSON.stringify(body)); await idle(); return body;
}
const command = (action, op, status) => response(action, '/commands', status, op);
async function fill(scope, label, value) {
  const field = scope.getByLabel(label, { exact: true });
  if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) await fill(modal, label, value);
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  return [Math.round(box.x + x / 842 * box.width), Math.round(box.y + (595 - y) / 595 * box.height)];
}
async function trace(mark, y) {
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await page.mouse.click(...await screen([150, y])); await page.mouse.dblclick(...await screen([350, y]));
  const reply = await command(() => dialog('Add steel object', { 'Member mark': mark, 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides', 'Physical quantity': 2 }, 'Add item'), 'create_item');
  return reply.snapshot.items.find(item => item.fields.mark === mark);
}
async function select(ids) {
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  for (const id of ids) await page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox', { name: /^Select / }).check();
}
async function confirmSelected(count) {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog(`Confirm ${count} items?`, {}, 'Confirm items'), 'confirm_items');
}
async function preview(status = 200, update = false) {
  return response(() => page.getByRole('button', { name: update ? 'Update linked rows' : 'Preview transfer', exact: true }).click(), '/transfer-preview', status);
}
async function apply(count) {
  return response(() => dialog(`Transfer ${count} confirmed items?`, {}, 'Add to schedule'), '/transfer-apply');
}
async function changeCell(address, value) {
  const control = page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${address}"]`);
  await control.fill(String(value)); await control.press('Tab');
  await expect.poll(async () => (await calculators()).steel_vermiculite.inputs.SCHEDULE[address]).toBe(value);
}
async function openSpray() {
  await page.locator('.nav-button[data-view="calculators"]').click();
  await page.locator('.calculator-choice').filter({ hasText: 'Steel (spray)' }).click();
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
}
function assertSkipped(preview, binding) {
  assert.deepEqual(preview.skipped.find(entry => entry.item_id === binding.item_id), { item_id: binding.item_id, calculator_id: binding.calculator_id, row: binding.row, binding_id: binding.id, status: binding.status, reason: 'already_linked' });
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(commands|transfer-preview|transfer-apply)$/.test(request.url())) requests.push({ endpoint: request.url().split('/').pop(), body: request.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
  await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  const a = await trace('LINKED-A', 350); await select([a.id]); await confirmSelected(1); await preview();
  let result = await apply(1); const originalBinding = result.snapshot.transfers.find(binding => binding.item_id === a.id); assert.ok(originalBinding);
  const b = await trace('NEW-B', 250); await select([b.id]); await confirmSelected(1);
  // A stale source and a manually edited destination are outside append authority.
  await select([a.id]);
  const editor = page.locator(`.takeoff-register-editor[data-editor-item-id="${a.id}"]`);
  if (!await editor.isVisible()) await page.locator(`tr[data-item-id="${a.id}"]`).getByRole('button', { name: 'Edit item', exact: true }).click();
  await fill(editor, 'Level', 'UNCONFIRMED-SOURCE-EDIT'); await command(() => editor.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
  await openSpray(); const linkedLength = (await calculators()).steel_vermiculite.inputs.SCHEDULE[`J${originalBinding.row}`];
  await changeCell(`J${originalBinding.row}`, linkedLength + 7.125);
  await page.getByRole('button', { name: 'Add row', exact: true }).click(); await changeCell('A11', 'UNRELATED-MANUAL-ROW');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await select([a.id, b.id]);
  const before = await snapshot(), beforeCalculators = await calculators(), staleBinding = before.transfers.find(binding => binding.item_id === a.id);
  assert.equal(before.items.find(item => item.id === a.id).state, 'draft'); assert.equal(staleBinding.status, 'stale');
  const mixed = await preview(); assertSkipped(mixed, staleBinding); assert.equal(mixed.skipped.length, 1);
  assert.equal(mixed.changes.length, 1); assert.deepEqual(mixed.changes.map(change => [change.item_id, change.action]), [[b.id, 'append']]);
  assert.equal(mixed.bindings.length, 1); assert.equal(mixed.bindings[0].item_id, b.id); assert.notEqual(mixed.bindings[0].row, originalBinding.row); assert.notEqual(mixed.bindings[0].row, 11);
  const modal = page.getByRole('dialog'); await expect(modal).toContainText(/skip/i); await expect(modal).toContainText('LINKED-A'); await expect(modal).toContainText('NEW-B');
  await page.screenshot({ path: path.join(output, 'mixed-transfer-review.png') });
  result = await apply(1);
  const after = await snapshot(), afterCalculators = await calculators(), newBinding = after.transfers.find(binding => binding.item_id === b.id);
  assert.equal(after.revision, before.revision + 1); assert.deepEqual(after.items, before.items); assert.deepEqual(after.transfers.find(binding => binding.item_id === a.id), staleBinding);
  assert.equal(after.transfers.length, 2); assert.equal(newBinding.status, 'current'); assert.equal(newBinding.row, mixed.bindings[0].row);
  const expectedCalculators = structuredClone(beforeCalculators);
  Object.assign(expectedCalculators.steel_vermiculite.inputs.SCHEDULE, newBinding.values);
  expectedCalculators.steel_vermiculite.schedule_rows = [...new Set([...expectedCalculators.steel_vermiculite.schedule_rows, newBinding.row])].sort((left, right) => left - right);
  assert.deepEqual(afterCalculators, expectedCalculators, 'Append changes only the new item row across all calculator inputs');
  assertSkipped(result.transfer, staleBinding); evidence.mixedBatchSkipsStaleConflict = true;
  console.log('Mixed Add skipped stale linked source and edited schedule row while appending the new confirmed item.');
  // Repeated all-linked Add is informational: no modal, apply request, revision,
  // audit entry, new binding, calculator edit or new save requirement.
  await response(() => page.getByRole('button', { name: 'Save As', exact: true }).click(), '/api/project/save-as'); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const noOpBaseline = await snapshot(); assert.equal(noOpBaseline.revision, after.revision); assert.equal(noOpBaseline.audit_head, after.audit_head);
  const applyCount = requests.filter(request => request.endpoint === 'transfer-apply').length;
  for (let retry = 0; retry < 2; retry++) {
    const allSkipped = await preview(); assert.equal(allSkipped.preview_id, null); assert.deepEqual(allSkipped.changes, []); assert.deepEqual(allSkipped.bindings, []);
    assert.equal(allSkipped.skipped.length, 2); for (const binding of after.transfers) assertSkipped(allSkipped, binding);
    await expect(page.locator('#takeoffs-workspace .message[role="status"]')).toContainText(/already.*linked|skipped/i);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(requests.filter(request => request.endpoint === 'transfer-apply').length, applyCount);
    assert.deepEqual(await snapshot(), noOpBaseline); assert.deepEqual(await calculators(), afterCalculators);
    await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  }
  await page.locator('#takeoffs-workspace .message[role="status"]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'all-linked-informational-no-op.png') });
  evidence.allLinkedNoOp = true;
  // Explicit Update still refuses the edited row; Add did not weaken overwrite guards.
  await select([a.id]); await confirmSelected(1);
  const updateBefore = await snapshot(); await preview(400, true);
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText(/row was edited|conflict/i);
  assert.deepEqual(await snapshot(), updateBefore); assert.deepEqual(await calculators(), afterCalculators); evidence.explicitUpdateConflictPreserved = true;
  await response(() => page.getByRole('button', { name: 'Save As', exact: true }).click(), '/api/project/save-as'); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.transfers, updateBefore.transfers);
  await response(() => page.getByRole('button', { name: 'Load', exact: true }).click(), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  assert.deepEqual(await calculators(), afterCalculators); assert.deepEqual((await snapshot()).transfers, saved.takeoffs.transfers); evidence.savedLinksAndManualRowsRetained = true;
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, requests, errors, savedProject: info.project }, null, 2));
  console.log(`PASS: mixed append skipping, exact linked/manual input preservation, repeated all-linked no-op, explicit Update conflict and save/reopen. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
