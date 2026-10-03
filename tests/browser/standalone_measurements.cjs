// Real count-only/length-only tools; disposable data and original rotated PDF.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `standalone-measurements-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
});
const errors = [], evidence = {}, operations = [];
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await page.evaluate(() => window.CeasefireTakeoffs.completeProjectSnapshot()); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded(); await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); return [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
}
async function command(action, op) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const result = await pending; assert.equal(result.status(), 200, await result.text()); await idle(); return result.json();
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) { const field = modal.getByLabel(label, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') { await expect.poll(() => field.locator('option').evaluateAll(options => options.map(option => option.value))).toContain(value); await field.selectOption(value); } else await field.fill(value); }
  await modal.getByRole('button', { name: action, exact: true }).click(); await modal.waitFor({ state: 'detached' });
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) operations.push(request.postDataJSON().op); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture); await expect(page.locator('.takeoff-document')).toHaveCount(1); await idle();
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  const before = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  for (const mode of ['STEEL', 'DUCT']) {
    await page.getByRole('tab', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: 'Count', exact: true }).click();
    await page.mouse.click(...await screen([150, 200])); await page.mouse.click(...await screen([230, 230]));
    await page.locator('.takeoff-viewport').press('Enter');
    await command(() => dialog('Add count', { Item: `${mode}-ONLY`, Level: 'L01', 'WxH (mm)': '100x200', FRL: '120/120/120', Orientation: 'Horizontal' }, 'Add count'), 'add_standalone_count');
    let current = await snapshot(), count = current.items.find(item => item.fields.mark === `${mode}-ONLY`);
    assert.equal(count.purpose, 'count-only'); assert.equal(count.quantity, 2); assert.equal(count.measurement, null); assert.equal(count.geometry.kind, 'count-only'); assert.equal(count.geometry.points.length, 2);
    await expect(page.locator('.takeoff-count-hit')).toHaveCount(2);
    await expect(page.locator('#takeoffs-workspace > .message')).not.toHaveAttribute('role', 'alert');
    await expect(page.locator('.takeoff-settings-fields').getByLabel('Total Count/QTY', { exact: true })).toHaveValue('2');
    const changed = page.locator('.takeoff-settings-fields').getByLabel('Item', { exact: true }); await changed.fill(`${mode}-EDITED`); await changed.press('Tab');
    await expect.poll(async () => (await snapshot()).items.find(item => item.id === count.id).fields.mark).toBe(`${mode}-EDITED`);
    await expect(page.locator('.takeoff-standalone-register tr[data-item-id]')).toHaveCount(1);
    const originalMembers = [...count.member_ids];
    const marker = page.locator(`.takeoff-count-hit[data-count-member-id="${originalMembers[0]}"]`);
    await marker.scrollIntoViewIfNeeded(); await marker.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Continue count', exact: true }).click();
    await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'count-only');
    await page.mouse.click(...await screen([280, 210]));
    await command(() => page.locator('.takeoff-viewport').press('Enter'), 'continue_standalone_count');
    count = (await snapshot()).items.find(item => item.id === count.id);
    assert.equal(count.quantity, 3); assert.deepEqual(count.member_ids.slice(0, 2), originalMembers);
    const added = page.locator(`.takeoff-count-hit[data-count-member-id="${count.member_ids[2]}"]`);
    await added.scrollIntoViewIfNeeded(); await added.click({ button: 'right' });
    await command(() => page.getByRole('menuitem', { name: 'Delete count marker', exact: true }).click(), 'delete_count_marker');
    count = (await snapshot()).items.find(item => item.id === count.id);
    assert.equal(count.quantity, 2); assert.deepEqual(count.member_ids, originalMembers); assert.equal(count.measurement, null);
    await expect(page.locator('.takeoff-count-hit')).toHaveCount(2);
    evidence[mode] = { id: count.id, quantity: count.quantity, points: count.geometry.points };
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  // Seed the exact page calibration independently of any calculator values.
  await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, current = takeoffs.projectSnapshot(), sid = takeoffs.sessionId(), doc = current.documents[0];
    const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add_calibration', request_id: crypto.randomUUID(), expected_revision: current.revision, calibration: { id: crypto.randomUUID(), document_id: doc.id, page: 3, name: 'Synthetic precise scale', points: [[100, 100], [200, 100]], distance_m: 10, uniform_scale: true } }) });
    if (!reply.ok) throw new Error(await reply.text()); const updated = await reply.json(); takeoffs.applyProject(await takeoffs.prepareProject(updated.snapshot, sid));
  });
  await page.getByRole('tab', { name: 'WALLS', exact: true }).click();
  await page.locator('.takeoff-source-document').first().click(); await idle();
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  for (const mode of ['WALLS', 'SLABS']) {
    await page.getByRole('tab', { name: mode, exact: true }).click(); await page.getByRole('button', { name: 'Length', exact: true }).click();
    await page.mouse.click(...await screen([150, 200])); await page.mouse.click(...await screen([250, 200])); await page.locator('.takeoff-viewport').press('Enter');
    const reply = await command(() => dialog('Add length measurement', { Item: `${mode}-LENGTH`, Level: 'L01' }, 'Add measurement'), 'create_item');
    const item = reply.snapshot.items.find(item => item.fields.mark === `${mode}-LENGTH`); assert.equal(item.purpose, 'length-only'); assert.equal(item.quantity, 1); assert.equal(item.geometry.points.length, 2); assert.equal(item.measurement.method, 'calibrated');
    const result = reply.item_results.find(row => row.id === item.id), [a, b] = item.geometry.points;
    const sourceLength = Math.hypot(a[0] - b[0], a[1] - b[1]) * .1;
    assert.ok(Math.abs(result.length_m - sourceLength) < 1e-12, 'Server preserves the actual pointer geometry precision');
    assert.ok(result.length_m > 0, 'The actual traced source line has a measured length'); evidence[mode] = { id: item.id, length_m: result.length_m, points: item.geometry.points };
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  // Retiring an inset must not silently restore a different page-scale basis.
  // Repair the retained source lines through the real calibrated-only UI.
  const beforeRepair = await snapshot(), lengthIds = ['WALLS', 'SLABS'].map(mode => evidence[mode].id);
  await page.evaluate(async identifiers => {
    const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const original = current.items.find(item => item.id === identifiers[0]), coordinates = original.geometry.points,
      xs = coordinates.map(point => point[0]), ys = coordinates.map(point => point[1]), viewportId = crypto.randomUUID();
    async function send(op, values) {
      const response = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, request_id: crypto.randomUUID(), expected_revision: current.revision, ...values }) });
      if (!response.ok) throw new Error(await response.text()); current = (await response.json()).snapshot;
    }
    await send('add_calibration', { calibration: { id: viewportId, document_id: original.geometry.document_id, page: original.geometry.page,
      name: 'Temporary inset for explicit repair', region: [Math.min(...xs)-20, Math.min(...ys)-20, Math.max(...xs)+20, Math.max(...ys)+20],
      points: coordinates, distance_m: 4, uniform_scale: true } });
    await send('delete_viewport', { calibration_id: viewportId });
    for (const id of identifiers) if (current.items.find(item => item.id === id).measurement !== null) throw new Error('A retired inset must require explicit recalibration');
    takeoffs.applyProject(await takeoffs.prepareProject(current, sid));
  }, lengthIds);
  await page.getByRole('tab', { name: 'WALLS', exact: true }).click();
  await page.locator('.takeoff-source-document').first().click(); await idle();
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  for (const mode of ['WALLS', 'SLABS']) {
    await page.getByRole('tab', { name: mode, exact: true }).click();
    const original = beforeRepair.items.find(item => item.id === evidence[mode].id);
    await page.locator(`.takeoff-standalone-register tr[data-item-id="${original.id}"]`).getByRole('button', { name: 'Edit item', exact: true }).click();
    const repair = page.locator('.takeoff-settings-tools').getByRole('button', { name: 'Attach length calibration', exact: true }); await expect(repair).toBeVisible(); await repair.click();
    const response = await command(() => dialog('Change length calibration', { 'Source page calibration': original.measurement.calibration_id }, 'Apply calibration'), 'update_item');
    const repaired = response.snapshot.items.find(item => item.id === original.id);
    assert.deepEqual(repaired.geometry, original.geometry); assert.deepEqual(repaired.member_ids, original.member_ids); assert.deepEqual(repaired.fields, original.fields); assert.deepEqual(repaired.measurement, original.measurement); assert.equal(repaired.purpose, 'length-only');
    assert.equal(response.item_results.find(item => item.id === original.id).length_m, evidence[mode].length_m);
    evidence[mode].repaired_calibration = repaired.measurement.calibration_id;
    await expect(page.locator('.takeoff-settings-tools').getByRole('button', { name: 'Change length calibration', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  // A deliberately slow options request must never delay the duct form itself.
  await page.getByRole('tab', { name: 'DUCT', exact: true }).click(); await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await page.mouse.click(...await screen([350, 200])); await page.mouse.click(...await screen([450, 200]));
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/takeoffs/options?**', async route => { await gate; await route.continue(); });
  const started = Date.now(); await page.locator('.takeoff-viewport').press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add duct object', exact: true })).toBeVisible({ timeout: 1000 });
  evidence.dialog_visible_ms = Date.now() - started; await expect(page.getByRole('dialog').getByRole('button', { name: 'Add item', exact: true })).toBeDisabled();
  release(); await expect(page.getByRole('dialog').getByRole('button', { name: 'Add item', exact: true })).toBeEnabled(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); await page.unroute('**/api/takeoffs/options?**');
  const current = await snapshot(); assert.equal(current.documents[0].sha256, before.documents[0].sha256); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 764, height: 764 }); await page.locator('.takeoff-standalone-register').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'counts-narrow.png') });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, evidence, operations, errors }, null, 2)); console.log(`Standalone measurements browser acceptance passed: ${output}`);
})().catch(async error => { console.error(error); console.error(logs); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.kill(); });
