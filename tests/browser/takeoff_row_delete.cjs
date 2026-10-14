// Validated synthetic fixture records; real register Delete/Undo and linked rows.
const { chromium, expect } = require('@playwright/test');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `takeoff-row-delete-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = ['static/takeoffs.js', 'static/takeoffs.css', 'static/calculators.js', 'static/app.js'];
const runtimeBefore = Object.fromEntries(assets.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${logs}`)); });
});
const errors = [], writes = [], checks = {};
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); }
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function canonical() { const sid = await page.evaluate(() => window.CeasefireTakeoffs.sessionId()); const reply = await page.request.get(`http://127.0.0.1:${info.port}/api/takeoffs/sessions/${sid}`); assert.equal(reply.status(), 200); return reply.json(); }
async function publish(reply) { await page.evaluate(async reply => { const value = window.CeasefireTakeoffs; value.applyProject(await value.prepareProject(reply.snapshot, reply.session_id)); await value.open(); }, reply); await idle(); }
async function seed(op, values) {
  const before = await canonical(), reply = await page.request.post(`http://127.0.0.1:${info.port}/api/takeoffs/sessions/${before.session_id}/commands`, { data: { op, request_id: randomUUID(), expected_revision: before.revision, ...values } });
  assert.equal(reply.status(), 200, await reply.text()); return reply.json();
}
async function response(action, suffix, op, status = 200) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix) && (!op || reply.request().postDataJSON()?.op === op)); pending.catch(() => {}); await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), status, JSON.stringify(value)); await idle(); return value;
}
function recorded(value, restoredId) {
  const { revision, audit_head, render_checks, ...retained } = value;
  return { ...retained, items: retained.items.map(item => {
    if (item.id !== restoredId) return item;
    // Native Undo advances this object's version and clears its approval.
    // All physical/source/commercial fields must still be exactly retained.
    const { version, state, review, confirmation, ...source } = item; return source;
  }) };
}
async function reviewDelete(id, action, suffix = '/commands', status = 200) {
  const button = page.locator(`button[data-takeoff-delete-item="${id}"]`); await expect(button).toHaveCount(1); await expect(button.locator('svg')).toHaveCount(1); await button.click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading')).toHaveText('Are you sure you want to delete this item?'); await expect(dialog.getByRole('button', { name: 'Yes', exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  if (action === 'Cancel') { await dialog.getByRole('button', { name: action, exact: true }).click(); await expect(dialog).toBeHidden(); await idle(); return; }
  return response(() => dialog.getByRole('button', { name: 'Yes', exact: true }).click(), suffix, suffix === '/commands' ? 'delete_items' : undefined, status);
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1384, height: 1000 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/\/(commands|linked-delete|linked-undo)$/.test(new URL(request.url()).pathname)) writes.push({ endpoint: new URL(request.url()).pathname.split('/').pop(), body: request.postDataJSON() }); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  const calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1); await idle();
  const document = (await canonical()).snapshot.documents[0], sourceHash = hash(fs.readFileSync(info.fixture)), scale = randomUUID();
  await seed('add_calibration', { calibration: { id: scale, document_id: document.id, page: 1, name: 'SYNTHETIC precise Delete fixture', points: [[100, 400], [500, 400]], distance_m: 10.1234567890123, uniform_scale: true } });
  const steelFields = { mark: 'STEEL-MEASURED', level: 'L01', section: '100UC15', member_type: 'Beam', exposure: 'Re-entrant - 3 sides', fire_period_min: 120, critical_temperature: 550, product: 'CAFCO 300', sides: 3 };
  const ductFields = { mark: 'DUCT-MEASURED', level: 'L01', shape: 'rectangular', width_mm: 600.123456789, height_mm: 400.987654321, frl: '120/120/120', orientation: 'Horizontal', exposure: 'Internal', product: 'FyreWrap', wall_penetrations: 0, floor_penetrations: 0 };
  const specs = [];
  for (const mode of ['steel', 'duct', 'wall', 'slab']) {
    const id = randomUUID(), area = ['wall', 'slab'].includes(mode), fields = mode === 'steel' ? steelFields : mode === 'duct' ? ductFields : { mark: `${mode.toUpperCase()}-MEASURED`, level: 'L01', layers: 2, substrate: 'Concrete wall', frl: '120/120/120' };
    const geometry = { document_id: document.id, page: 1, points: area ? [[120.123456789,100],[380.987654321,100],[380.987654321,290],[120.123456789,290]] : [[100.123456789,390.987654321],[320.987654321,391.123456789]], ...(area ? { kind: 'polygon', exclusions: [{ id: randomUUID(), note: 'SYNTHETIC retained opening', points: [[180,160],[220,160],[220,190],[180,190]] }] } : {}) };
    await seed('create_item', { item: { id, mode, geometry, measurement: { method: 'calibrated', calibration_id: scale }, quantity: mode === 'steel' ? 2 : 1, fields, evidence: [{ document_id: document.id, page: 1, note: 'SYNTHETIC original evidence; no project authority' }] } }); specs.push({ id, mode, purpose: 'measured' });
  }
  for (const mode of ['steel', 'duct']) {
    const reply = await seed('add_standalone_count', { mode, document_id: document.id, page: 1, markers: [{ point: [440.123456789,250.987654321] }, { point: [475.987654321,280.123456789] }], fields: { mark: `${mode.toUpperCase()}-COUNT-ONLY`, level: 'L02' }, appearance: { marker_size: 19.987654321 } });
    specs.push({ id: reply.created_item_ids[0], mode, purpose: 'count-only' });
  }
  for (const mode of ['wall', 'slab']) {
    const id = randomUUID(); await seed('create_item', { item: { id, mode, purpose: 'length-only', geometry: { document_id: document.id, page: 1, points: [[400.123456789,320.987654321],[650.987654321,325.123456789]] }, measurement: { method: 'calibrated', calibration_id: scale }, quantity: 1, fields: { mark: `${mode.toUpperCase()}-LENGTH-ONLY`, level: 'L02' } } }); specs.push({ id, mode, purpose: 'length-only' });
  }
  await publish(await canonical());
  const baseline = await snapshot(); assert.equal(baseline.items.length, 8); assert.equal(baseline.documents[0].sha256, sourceHash);
  for (const spec of specs) {
    await chooseTakeoff(page, spec.mode); await idle(); const row = page.locator(`tr[data-item-id="${spec.id}"]`); await expect(row).toHaveCount(1);
    const shape = await row.evaluate(row => ({ columns: row.children.length, headings: [...row.closest('table').querySelector('thead tr').children].map(cell => cell.textContent.trim()), finalButton: row.lastElementChild.querySelector('button').dataset.takeoffDeleteItem })); assert.equal(shape.headings.at(-1), 'Delete'); assert.equal(shape.columns, shape.headings.length); assert.equal(shape.finalButton, spec.id);
    const before = await snapshot(), count = writes.length; await reviewDelete(spec.id, 'Cancel'); assert.deepEqual(await snapshot(), before); assert.equal(writes.length, count, 'Cancel sends no command');
    const removed = await reviewDelete(spec.id, 'Yes'); assert.ok(!removed.snapshot.items.some(item => item.id === spec.id)); assert.deepEqual(removed.snapshot.documents, before.documents); assert.deepEqual(removed.snapshot.calibrations, before.calibrations);
    await page.getByRole('checkbox', { name: 'Show deleted records', exact: true }).check(); const history = page.locator(`tr[data-deleted-item-id="${spec.id}"]`); await expect(history).toHaveCount(1); await expect(history.locator('td:last-child button')).toBeDisabled(); assert.equal(await history.locator('td:last-child button').getAttribute('data-locked'), 'true');
    if (spec.purpose === 'measured' && spec.mode === 'steel') await page.screenshot({ path: path.join(output, 'retained-history-delete-disabled.png'), fullPage: true });
    const undone = await response(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), '/commands', 'undo'); assert.deepEqual(recorded(undone.snapshot, spec.id), recorded(before, spec.id), `${spec.mode} ${spec.purpose} restores original IDs, evidence, geometry, precision and other retained scopes`);
    const restoredItem = undone.snapshot.items.find(item => item.id === spec.id), originalItem = before.items.find(item => item.id === spec.id); assert.equal(restoredItem.version, originalItem.version + 1); assert.equal(restoredItem.state, 'draft'); assert.equal(restoredItem.review, null); assert.equal(restoredItem.confirmation, null);
    await page.getByRole('checkbox', { name: 'Show deleted records', exact: true }).uncheck(); checks[`${spec.mode}-${spec.purpose}`] = { id: spec.id, finalDeleteColumn: true, cancelNoWrite: true, exactUndo: true, retainedHistoryLocked: true };
  }
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore, 'Unlinked Delete/Undo leaves all calculator drafts unchanged');
  // Advance the canonical server revision during an open review. The original
  // guarded request must be refused and must not remove the later edited item.
  const steel = specs[0]; await chooseTakeoff(page, 'steel'); await page.locator(`button[data-takeoff-delete-item="${steel.id}"]`).click();
  const changed = await seed('update_item', { item_id: steel.id, changes: { fields: { notes: 'SYNTHETIC later source review' } } });
  const stale = await response(() => page.getByRole('dialog').getByRole('button', { name: 'Yes', exact: true }).click(), '/commands', 'delete_items', 400); assert.match(stale.error, /draft changed/); assert.deepEqual((await canonical()).snapshot, changed.snapshot); await publish(await canonical()); checks.staleServerRevisionRefused = true;
  // One genuinely linked row exercises the same row trash, guarded calculator
  // reservation and coupled Undo used by the existing inspector deletion.
  await page.locator(`tr[data-item-id="${steel.id}"]`).getByRole('checkbox', { name: 'Select STEEL-MEASURED', exact: true }).check(); await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await response(() => page.getByRole('dialog').getByRole('button', { name: 'Confirm items', exact: true }).click(), '/commands', 'confirm_items');
  await response(() => page.getByRole('button', { name: 'Preview transfer', exact: true }).click(), '/transfer-preview'); await response(() => page.getByRole('dialog').getByRole('button', { name: 'Add to schedule', exact: true }).click(), '/transfer-apply');
  const linked = await snapshot(), binding = linked.transfers.find(value => value.item_id === steel.id), linkedCalculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); assert.ok(binding);
  await chooseCalculator(page, 'Steel (spray)'); await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click(); const lengthAddress = `J${binding.row}`, lengthControl = page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${lengthAddress}"]`), oldLength = linkedCalculators.steel_vermiculite.inputs.SCHEDULE[lengthAddress];
  await lengthControl.fill(String(oldLength + 1.23456789)); await lengthControl.press('Tab'); await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true'); const conflictedCalculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await renderDrawing(page, () => page.getByRole('button', { name: 'Takeoffs', exact: true }).click(), 1); const conflictBefore = await snapshot(); await reviewDelete(steel.id, 'Yes', '/linked-delete', 400); assert.deepEqual(await snapshot(), conflictBefore); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), conflictedCalculators); await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('row was edited');
  await chooseCalculator(page, 'Steel (spray)'); await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click(); await page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${lengthAddress}"]`).fill(String(oldLength)); await page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${lengthAddress}"]`).press('Tab'); await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
  await renderDrawing(page, () => page.getByRole('button', { name: 'Takeoffs', exact: true }).click(), 1); const linkedBefore = await snapshot(), targetBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await reviewDelete(steel.id, 'Cancel'); assert.deepEqual(await snapshot(), linkedBefore); await reviewDelete(steel.id, 'Yes', '/linked-delete'); assert.ok(!(await snapshot()).transfers.some(value => value.item_id === steel.id));
  const restored = await response(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), '/linked-undo');
  const sourceItem = value => { const { version, state, review, confirmation, ...source } = value; return source; };
  assert.deepEqual(sourceItem(restored.snapshot.items.find(value => value.id === steel.id)), sourceItem(linkedBefore.items.find(value => value.id === steel.id))); assert.equal(restored.snapshot.items.find(value => value.id === steel.id).state, 'draft');
  const sourceBindings = values => values.map(({ status, ...binding }) => binding); assert.deepEqual(sourceBindings(restored.snapshot.transfers), sourceBindings(linkedBefore.transfers)); assert.ok(restored.snapshot.transfers.filter(value => value.item_id === steel.id).every(value => value.status === 'stale')); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), targetBefore); checks.linkedConflictAndUndoExact = true;
  assert.deepEqual(errors, []); assert.equal(hash(fs.readFileSync(info.fixture)), sourceHash); const runtimeAfter = Object.fromEntries(assets.map(name => [name, hash(fs.readFileSync(path.join(root, name)))])); assert.deepEqual(runtimeAfter, runtimeBefore);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, port: info.port, creationCoverage: 'validated guarded API fixture; deletion/confirmation/history/Undo and linked transfer are rendered browser controls', checks, sourceHash, runtimeBefore, runtimeAfter, errors, requests: writes.map(value => ({ endpoint: value.endpoint, op: value.body.op, request_id: value.body.request_id, revision: value.body.expected_revision })) }, null, 2)); console.log(JSON.stringify({ passed: true, output }));
})().catch(async error => { console.error(error); fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n${logs}`); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
