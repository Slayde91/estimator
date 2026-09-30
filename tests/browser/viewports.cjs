// Rendered scale/viewport and per-member vertical-dimension acceptance on disposable data.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `viewports-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], operations = [], evidence = {};
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); }
async function command(action, op, status = 200) {
  const pending = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.op === op);
  await action(); const response = await pending, body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body)); await idle(); return body;
}
async function dialog(title, values, button) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  if (title === 'Add steel object' && values['Member mark'] === 'SCALE-100') await page.screenshot({ path: path.join(output, 'steel-creation-fields.png'), fullPage: true });
  await modal.getByRole('button', { name: button, exact: true }).click();
}
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function fit() { return command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render'); }
// Fixture page 3: original CropBox [20,30,800,570], rotation90, UserUnit2.
async function screenPoint([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  return [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
}
async function draw(points, doubleFinish = false) {
  for (let i = 0; i < points.length; i++) {
    const [x, y] = await screenPoint(points[i]);
    if (doubleFinish && i === points.length - 1) await page.mouse.dblclick(x, y); else await page.mouse.click(x, y);
  }
}
async function cancelAt(point) { const [x, y] = await screenPoint(point); await page.mouse.click(x, y, { button: 'right' }); await expect(page.getByRole('dialog')).toHaveCount(0); }
async function scale(denominator) {
  await page.getByLabel('Drawing calibration', { exact: true }).selectOption(`scale:${denominator}`);
  return command(() => dialog(`Apply drawing scale 1:${denominator}?`, {}, 'Apply scale'), 'add_calibration');
}
async function viewport(name, points, denominator) {
  await page.getByRole('button', { name: 'Viewport', exact: true }).click(); await draw(points);
  return command(() => dialog('Create viewport', { 'Viewport name': name, 'Scale': denominator }, 'Create viewport'), 'add_calibration');
}
const steelFields = { 'Member mark': 'SCALE-100', 'Level': 'L02', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Exposed sides': 3, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides', 'Physical quantity': 2 };
async function steel(mark, points) {
  await page.getByRole('button', { name: 'Trace length', exact: true }).click(); await draw(points, true);
  return command(() => dialog('Add steel object', { ...steelFields, 'Member mark': mark }, 'Add item'), 'create_item');
}
async function confirm() {
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  const start = operations.length;
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const reply = await command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items');
  assert.ok(!operations.slice(start).includes('review_items'), 'Confirmation does not require a separate review command');
  return reply;
}
async function addition(docId, kind, mm, note) {
  await page.getByRole('button', { name: 'Riser/Drop', exact: true }).click();
  return command(() => dialog('Add riser / drop', { 'Type': kind, 'Additional length (mm)': mm, 'Source document': docId, 'Source page': 3, 'Source dimension / citation': note }, 'Add length'), 'update_item');
}
async function inspector(values) {
  const panel = page.locator('.takeoff-inspector');
  for (const [label, value] of Object.entries(values)) {
    const field = panel.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  return command(() => panel.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
}
async function transfer() {
  const waiting = page.waitForResponse(r => r.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
  const response = await waiting, preview = await response.json(); assert.equal(response.status(), 200, JSON.stringify(preview));
  const applying = page.waitForResponse(r => r.url().endsWith('/transfer-apply'));
  await dialog('Transfer 1 confirmed items?', {}, 'Add to schedule');
  const applied = await applying, state = await applied.json(); assert.equal(applied.status(), 200, JSON.stringify(state)); await idle();
  return { preview, state };
}
async function load() {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200, await response.text());
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click(); await idle();
}
async function sourceAt(position) {
  return page.evaluate(position => {
    const drawing = document.querySelector('.takeoff-overlay').getBoundingClientRect(), frame = document.querySelector('.takeoff-viewport');
    const rect = frame.getBoundingClientRect();
    const screen = position || [rect.x + frame.clientWidth / 2, rect.y + frame.clientHeight / 2];
    return { point: [20 + (screen[1] - drawing.y) / drawing.height * 780, 30 + (screen[0] - drawing.x) / drawing.width * 540], screen, scroll: [frame.scrollLeft, frame.scrollTop] };
  }, position);
}
function closePoint(actual, expected, tolerance = 0.9) { actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < tolerance, `${actual} ~= ${expected}`)); }
(async () => {
  const info = await ready;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) operations.push(request.postDataJSON()?.op); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', e => window.qaCsp.push({ directive: e.effectiveDirective, blocked: e.blockedURI })); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible();
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  await command(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await fit();
  let state = await scale(100), doc = state.snapshot.documents[0], global = state.snapshot.calibrations[0];
  assert.equal(doc.pages[2].user_unit, 2); assert.equal(doc.pages[2].rotation, 90); assert.deepEqual(doc.pages[2].view, [20, 30, 800, 570]);
  assert.equal(global.scale_denominator, 100); assert.ok(Math.abs(global.distance_m - 780 * 2 * .0254 / 72 * 100) < 1e-12);
  state = await steel('SCALE-100', [[350, 500], [750, 500]]);
  const mainId = state.snapshot.items.find(item => item.fields.mark === 'SCALE-100').id;
  let main = state.snapshot.items.find(item => item.id === mainId), result = state.item_results.find(item => item.id === mainId);
  assert.equal(main.geometry.points.length, 2, 'Double-click finishing adds no duplicate endpoint');
  closePoint(main.geometry.points[0], [350, 500]); closePoint(main.geometry.points[1], [750, 500]);
  assert.ok(Math.abs(result.length_m - 400 * 2 * .0254 / 72 * 100) < .06);
  assert.equal(main.fields.section, '100UC15'); assert.equal(main.fields.product, 'CAFCO 300'); assert.equal(main.quantity, 2);
  assert.equal(main.review, null); assert.equal(main.confirmation, null);
  state = await confirm(); assert.equal(state.snapshot.items.find(item => item.id === mainId).state, 'confirmed');
  const baseline = state.item_results.find(item => item.id === mainId).length_m;
  state = await addition(doc.id, 'riser', 500, 'Synthetic R-01: 500 mm riser on each physical member; test-only cited dimension');
  main = state.snapshot.items.find(item => item.id === mainId); assert.equal(main.confirmation, null);
  result = state.item_results.find(item => item.id === mainId); assert.equal(result.base_length_m, baseline); assert.equal(result.additions_length_m, .5);
  assert.equal(result.length_m, baseline + .5); assert.equal(result.total_length_m, (baseline + .5) * 2);
  await confirm(); await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite');
  let transferred = await transfer(); const mainBinding = transferred.state.snapshot.transfers.find(binding => binding.item_id === mainId);
  assert.equal(transferred.preview.inputs.SCHEDULE['I' + mainBinding.row], 2); assert.equal(transferred.preview.inputs.SCHEDULE['J' + mainBinding.row], baseline + .5);
  transferred = await transfer(); assert.equal(transferred.preview.changes[0].action, 'unchanged');
  assert.equal(transferred.state.snapshot.transfers.filter(binding => binding.item_id === mainId).length, 1);
  // Independent detail scale plus boundary rejection. Changing scale never changes the source coordinates.
  await fit(); state = await viewport('DETAIL-50', [[100, 100], [300, 400]], 50);
  const detailId = state.snapshot.calibrations.find(calibration => calibration.name === 'DETAIL-50').id;
  const boundaryOperations = operations.length;
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[125, 150], [225, 150], [350, 150]], true);
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('cannot leave its viewport');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.ok(!operations.slice(boundaryOperations).includes('create_item'), 'Rejected double-click must not finish the old valid segment');
  await cancelAt([180, 180]); assert.equal((await snapshot()).items.length, 1, 'Right-click cancels without adding a partial item');
  state = await steel('DETAIL-50', [[125, 150], [225, 150]]);
  const detail = state.snapshot.items.find(item => item.fields.mark === 'DETAIL-50'), detailResult = state.item_results.find(item => item.id === detail.id);
  assert.equal(detail.measurement.calibration_id, detailId); assert.equal(detail.geometry.points.length, 2);
  assert.ok(Math.abs(detailResult.length_m - 100 * 2 * .0254 / 72 * 50) < .04);
  assert.equal(state.item_results.find(item => item.id === mainId).length_m, baseline + .5);
  await confirm(); await fit();
  // A page-scale trace entering a different-scale detail must also be rejected by the server.
  await page.getByRole('button', { name: 'Trace length', exact: true }).click(); await draw([[400, 200], [200, 200]], true);
  const rejected = await command(() => dialog('Add steel object', { ...steelFields, 'Member mark': 'CROSS-SCALE' }, 'Add item'), 'create_item', 400);
  assert.match(rejected.error, /viewport/i); await cancelAt([400, 450]); assert.equal((await snapshot()).items.length, 2);
  // Zoom anchor is measured from rendered geometry, not the frontend's private state.
  await fit();
  for (let i = 0; i < 6; i++) await command(() => page.getByRole('button', { name: '+', exact: true }).click(), 'record_render');
  await page.locator('.takeoff-viewport').evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  const centerBefore = await sourceAt(); await command(() => page.getByRole('button', { name: '+', exact: true }).click(), 'record_render');
  const centerAfter = await sourceAt(); closePoint(centerAfter.point, centerBefore.point, 1.5);
  const frame = await page.locator('.takeoff-viewport').boundingBox(), cursor = [frame.x + frame.width * .64, frame.y + frame.height * .43];
  const cursorBefore = await sourceAt(cursor);
  await command(async () => { await page.mouse.move(...cursor); await page.keyboard.down('Control'); await page.mouse.wheel(0, -150); await page.keyboard.up('Control'); }, 'record_render');
  const cursorAfter = await sourceAt(cursor); closePoint(cursorAfter.point, cursorBefore.point, 1.5);
  evidence.zoom = { centerBefore, centerAfter, cursorBefore, cursorAfter }; await fit();
  // Rectangular duct default, and a cited drop is added once per physical run.
  await page.locator('[data-mode="duct"]').click();
  await page.getByRole('button', { name: 'Trace length', exact: true }).click(); await draw([[400, 450], [600, 450]], true);
  state = await command(() => dialog('Add duct object', { 'Run ID': 'DUCT-DROP', 'Physical quantity': 2 }, 'Add item'), 'create_item');
  const ductId = state.snapshot.items.find(item => item.mode === 'duct').id;
  assert.equal(state.snapshot.items.find(item => item.id === ductId).fields.shape, 'rectangular');
  await expect(page.locator('.takeoff-inspector').getByLabel('Shape', { exact: true })).toHaveCount(0);
  await expect(page.locator('.takeoff-inspector').getByLabel('Diameter (mm)', { exact: true })).toHaveCount(0);
  state = await inspector({ 'Level': 'L02', 'Width (mm)': 600, 'Height (mm)': 400, 'Protection product': 'FyreWrap', 'Duct application / exposure': 'Internal', 'Mechanical system': 'Supply air', 'FRL': '120/120/120', 'Orientation': 'Horizontal', 'Wall penetrations': 0, 'Floor penetrations': 0 });
  const ductBase = state.item_results.find(item => item.id === ductId).length_m;
  state = await addition(doc.id, 'drop', 750, 'Synthetic D-02: 750 mm drop on each of two runs; no inferred height');
  assert.equal(state.item_results.find(item => item.id === ductId).total_length_m, (ductBase + .75) * 2);
  await confirm();
  const repeatedPreview = page.waitForResponse(r => r.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
  const repeatedResponse = await repeatedPreview, repeatedError = await repeatedResponse.json();
  assert.equal(repeatedResponse.status(), 400); assert.match(repeatedError.error, /each physical duct run separately/);
  await inspector({ 'Physical quantity': 1 }); await confirm(); const ductTotal = ductBase + .75;
  transferred = await transfer(); const ductBinding = transferred.state.snapshot.transfers.find(binding => binding.item_id === ductId);
  assert.equal(transferred.preview.inputs.CALCULATOR['D' + ductBinding.row], ductTotal);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'viewport-riser-confirmed.png'), fullPage: true });
  await page.locator('.takeoff-inspector').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.locator('.takeoff-inspector').screenshot({ path: path.join(output, 'riser-inspector.png') });
  const save = page.waitForResponse(r => r.url().endsWith('/api/project/save-as')); await page.getByRole('button', { name: 'Save As', exact: true }).click();
  assert.equal((await save).status(), 200); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.version, 2);
  await load();
  for (const [mode, id, base, additionLength, total] of [['steel', mainId, baseline, .5, (baseline + .5) * 2], ['duct', ductId, ductBase, .75, ductTotal]]) {
    await page.locator(`[data-mode="${mode}"]`).click(); await page.locator(`tr[data-item-id="${id}"] .takeoff-row-link`).click(); await idle();
    await expect(page.locator(`tr[data-item-id="${id}"] .takeoff-state`)).toHaveText('Confirmed');
    for (const format of ['CSV', 'XLSX']) {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
      const download = await pending, target = path.join(output, `${mode}-${download.suggestedFilename()}`); await download.saveAs(target);
      const script = `import csv,json,sys\nfrom openpyxl import load_workbook\np=sys.argv[1]\nif p.endswith('.csv'):\n rows=list(csv.DictReader(open(p,encoding='utf-8-sig',newline='')))\nelse:\n data=list(load_workbook(p,data_only=True).active.values);rows=[dict(zip(data[0],r)) for r in data[1:]]\nprint(json.dumps(next(r for r in rows if r['Item ID']==sys.argv[2])))`;
      const parsed = spawnSync(python, ['-c', script, target, id], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(parsed.status, 0, parsed.stderr);
      const row = JSON.parse(parsed.stdout);
      assert.ok(Math.abs(Number(row['Base length per item m']) - base) < 1e-11); assert.equal(Number(row['Riser/drop additions per item m']), additionLength);
      assert.ok(Math.abs(Number(row['Length per item m']) - base - additionLength) < 1e-11); assert.ok(Math.abs(Number(row['Total length m']) - total) < 1e-11);
      assert.match(row['Riser/drop source dimensions'], /Synthetic/); assert.ok(row['Riser/drop source dimensions'].includes(doc.sha256));
    }
  }
  // Untrusted project text cannot turn a changed source dimension into a valid confirmation.
  const tampered = JSON.parse(fs.readFileSync(info.project)); tampered.takeoffs.items.find(item => item.id === ductId).length_additions[0].length_mm = 1750;
  fs.writeFileSync(info.project, JSON.stringify(tampered)); await load(); await page.locator('[data-mode="duct"]').click();
  await page.locator(`tr[data-item-id="${ductId}"] .takeoff-row-link`).click(); await idle();
  const reopened = await snapshot(), stale = reopened.items.find(item => item.id === ductId);
  assert.notEqual(stale.state, 'confirmed'); assert.equal(stale.confirmation, null);
  const exportResponse = page.waitForResponse(r => r.url().endsWith('/export/csv')); await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  assert.equal((await exportResponse).status(), 400);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, strictCsp: true, mainId, detailId, ductId, baseline, ductBase, ductTotal, evidence, operations, errors, csp: [] }, null, 2));
  console.log(`PASS: preset/UserUnit/rotation/crop, independent viewport, boundary rejection, double/right click, zoom anchors, direct confirmation, per-member riser/drop transfers, Save As/reopen, CSV/XLSX and tamper rejection. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
