const { renderDrawing } = require('./viewer_helpers.cjs');
// Real plan layout, control-point movement and surface-label acceptance on disposable evidence.
const { chromium, expect } = require('@playwright/test');
const { editSettings } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `plan-tools-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {}, assetTasks = [], assets = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function command(action, op, status = 200) {
  const pending = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body)); await idle(); return body;
}
async function linkedOperation(action, endpoint) {
  const pending = page.waitForResponse(r => r.url().endsWith(`/${endpoint}`)); pending.catch(() => {});
  await action(); const response = await pending, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); await idle(); return body;
}
async function snapshot() { let value; await idle(); await expect.poll(async () => { try { value = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return value; }
async function dialog(title, values, submit) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible({timeout:30000});
  for (const [label, value] of Object.entries(values)) { const field = modal.getByLabel(label, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value)); }
  await modal.getByRole('button', { name: submit, exact: true }).click();
}
const fit = () => renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
async function screen([x, y]) { const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded(); await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180)); const box = await overlay.boundingBox(); return [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height]; }
async function points(vertices) { for (const vertex of vertices) await page.mouse.click(...await screen(vertex)); }
const finish = () => page.locator('.takeoff-viewport').press('Enter');
const handle = (id, index, exclusion = '') => page.locator(`.takeoff-control-point[data-control-item-id="${id}"][data-point-index="${index}"][data-exclusion-id="${exclusion}"]`);
async function select(id) { const all = page.getByRole('checkbox', { name: 'Select all matching items', exact: true }); await all.check(); await all.uncheck(); await page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox', { name: /^Select / }).check(); await page.getByRole('button', { name: 'Select', exact: true }).click(); }
async function drag(id, index, destination, exclusion = '', during) {
  const point = handle(id, index, exclusion); await point.scrollIntoViewIfNeeded(); const target = await screen(destination), before = await point.boundingBox();
  const origin = [before.x + before.width / 2, before.y + before.height / 2]; await page.mouse.move(...origin); await page.mouse.down();
  try { let midway; if (during) { await page.mouse.move((origin[0] + target[0]) / 2, (origin[1] + target[1]) / 2, { steps: 4 }); midway = await page.evaluate(() => window.CeasefireTakeoffs.projectFingerprint()); } await page.mouse.move(...target, { steps: 8 }); if (during) await during(midway); } finally { await page.mouse.up(); }
}
const item = (state, id) => state.snapshot.items.find(value => value.id === id);
const result = (state, id) => state.item_results.find(value => value.id === id);
const squareMetres = geometry => {
  const ring = vertices => Math.abs(vertices.reduce((sum, point, index) => { const next = vertices[(index + 1) % vertices.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0)) / 2;
  return (ring(geometry.points) - (geometry.exclusions || []).reduce((sum, hole) => sum + ring(hole.points), 0)) * (2 * .0254 / 72 * 100) ** 2;
};
async function checkAreaLabel(state, id) {
  const expected = squareMetres(item(state, id).geometry); assert.ok(Math.abs(result(state, id).net_area_m2 - expected) < 1e-9);
  const label = page.locator(`.takeoff-area-label[data-area-item-id="${id}"]`); await expect(label).toContainText('m²');
  const numeric = Number((await label.textContent()).replace(/,/g, '').match(/\d+(?:\.\d+)?/)[0]); assert.ok(Math.abs(numeric - expected) <= .0051, JSON.stringify({ numeric, expected }));
  return expected;
}
async function edit(values) { return editSettings(page, values); }
async function confirm() { await page.getByRole('button', { name: 'Confirm', exact: true }).click(); return command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items'); }
async function layout(width) {
  await page.setViewportSize({ width, height: 1100 }); await page.evaluate(() => window.scrollTo(0, 0));
  const rail = page.getByRole('toolbar', { name: 'Drawing tools', exact: true }), navigation = page.getByLabel('Drawing navigation', { exact: true });
  const boxes = { rail: await rail.boundingBox(), plan: await page.locator('.takeoff-viewport').boundingBox(), navigation: await navigation.boundingBox(), top: await page.locator('.takeoff-viewer-top').boundingBox(), bottom: await page.locator('.takeoff-page-controls').boundingBox(), sources: await page.locator('.takeoff-source-documents').boundingBox(), register: await page.locator('.takeoff-register').boundingBox() };
  assert.ok(boxes.rail.x + boxes.rail.width <= boxes.plan.x + 1, JSON.stringify(boxes)); assert.ok(boxes.rail.width < 120);
  for (const key of ['top','bottom']) { const box = boxes[key]; assert.ok(box.x >= boxes.plan.x && box.y >= boxes.plan.y && box.x + box.width <= boxes.plan.x + boxes.plan.width && box.y + box.height <= boxes.plan.y + boxes.plan.height, JSON.stringify(boxes)); assert.ok(Math.abs(box.x + box.width / 2 - boxes.plan.x - boxes.plan.width / 2) < 1, JSON.stringify(boxes)); }
  assert.ok(boxes.navigation.y >= boxes.top.y && boxes.navigation.y + boxes.navigation.height <= boxes.top.y + boxes.top.height, JSON.stringify(boxes)); assert.ok(boxes.sources.y + boxes.sources.height <= boxes.plan.y + 1, JSON.stringify(boxes)); assert.ok(Math.abs(boxes.rail.y - boxes.plan.y) < 2, JSON.stringify(boxes)); assert.ok(boxes.register.y >= boxes.plan.y + boxes.plan.height - 1, JSON.stringify(boxes));
  await expect(rail.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0); await expect(rail.getByRole('button', { name: 'Pan', exact: true })).toHaveCount(0); for (const name of ['Select','Pan']) await expect(page.locator('.takeoff-page-controls').getByRole('button', { name, exact: true })).toBeVisible(); await expect(page.locator('.takeoff-source-document')).toHaveCount(2); await expect(page.locator('.takeoff-rail,.takeoff-thumbnail')).toHaveCount(0);
  evidence[`layout${width}`] = boxes;
}
(async () => {
  const info = await ready; browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (['/takeoffs.js', '/takeoff-geometry.js', '/takeoffs.css'].includes(pathname)) assetTasks.push(response.body().then(bytes => { assets[pathname] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; })); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click(); await page.locator('#takeoff-upload').setInputFiles([info.fixture, info.area_fixture]); await expect(page.locator('.takeoff-document')).toHaveCount(2, { timeout: 60000 }); await idle();
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  const sources = (await snapshot()).documents, primary = sources.find(doc => doc.name === 'synthetic-drawings.pdf'), secondary = sources.find(doc => doc.id !== primary.id);
  if (await page.getByLabel('Drawing document', { exact: true }).inputValue() !== secondary.id) await command(() => page.getByLabel('Drawing document', { exact: true }).selectOption(secondary.id), 'record_render');
  await command(() => page.getByLabel('Drawing document', { exact: true }).selectOption(primary.id), 'record_render');
  await command(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render'); await fit();
  await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100'); await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click(); await points([[100, 100], [200, 100], [250, 180]]); await finish();
  let state = await command(() => dialog('Add steel object', { 'Member mark': 'DRAG-STEEL', 'Level': 'L1', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Crit. Temp (\u00b0C)': 550, 'Exposure': 'Re-entrant - 3 sides', 'Count/QTY': 2 }, 'Add item'), 'create_item');
  const steel = state.snapshot.items.find(value => value.mode === 'steel'); await select(steel.id); await confirm();
  const preview = page.waitForResponse(r => r.url().endsWith('/transfer-preview')); await page.getByRole('button', { name: 'Preview transfer', exact: true }).click(); assert.equal((await preview).status(), 200);
  const transferred = page.waitForResponse(r => r.url().endsWith('/transfer-apply')); await dialog('Transfer 1 confirmed items?', {}, 'Add to schedule'); assert.equal((await transferred).status(), 200); await idle();
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  state = await command(() => drag(steel.id, 1, [220, 135]), 'update_item'); const movedSteel = item(state, steel.id);
  assert.deepEqual(movedSteel.geometry.points[0], steel.geometry.points[0]); assert.deepEqual(movedSteel.geometry.points[2], steel.geometry.points[2]); assert.ok(Math.hypot(movedSteel.geometry.points[1][0] - 220, movedSteel.geometry.points[1][1] - 135) < 2);
  assert.equal(movedSteel.confirmation, null); assert.equal(state.snapshot.transfers.find(link => link.item_id === steel.id).status, 'stale'); assert.deepEqual(movedSteel.evidence, steel.evidence);
  assert.equal(movedSteel.quantity, 2); assert.deepEqual(movedSteel.member_ids, steel.member_ids); assert.deepEqual(movedSteel.fields, steel.fields);
  assert.ok(Math.abs(result(state, steel.id).length_m - movedSteel.geometry.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - movedSteel.geometry.points[i][0], p[1] - movedSteel.geometry.points[i][1]), 0) * 2 * .0254 / 72 * 100) < 1e-10);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  const beforeInvalid = await snapshot(); await drag(steel.id, 1, [-100, 100]); await expect(page.locator('#takeoffs-workspace > .message')).toContainText(/outside|page|crop|boundary/i); assert.deepEqual(await snapshot(), beforeInvalid);
  const middle = steel.geometry.points[0].map((value, index) => (value + movedSteel.geometry.points[1][index]) / 2); await page.mouse.click(...await screen(middle), { button: 'right' });
  const linked = state.snapshot.transfers.find(link => link.item_id === steel.id), beforeCells = calculators[linked.calculator_id].inputs[linked.sheet], rowAddress = new RegExp(`^[A-Z]+${linked.row}$`), populatedRow = Object.keys(beforeCells).filter(address => rowAddress.test(address) && beforeCells[address] != null && beforeCells[address] !== ''); assert.ok(populatedRow.length > 0);
  await page.getByRole('menu', { name: 'Markup actions', exact: true }).getByRole('menuitem', { name: 'Delete markup', exact: true }).click(); state = await linkedOperation(() => dialog('Delete markup?', {}, 'Delete markup'), 'linked-delete');
  assert.equal(item(state, steel.id), undefined); assert.equal(state.snapshot.transfers.find(link => link.item_id === steel.id), undefined);
  const deletedCalculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), deletedCells = deletedCalculators[linked.calculator_id].inputs[linked.sheet]; for (const address of populatedRow) assert.equal(deletedCells[address], null); for (const [address, value] of Object.entries(beforeCells)) if (!rowAddress.test(address)) assert.deepEqual(deletedCells[address], value); for (const id of Object.keys(calculators)) if (id !== linked.calculator_id) assert.deepEqual(deletedCalculators[id], calculators[id]);
  state = await linkedOperation(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'linked-undo'); assert.deepEqual(item(state, steel.id).geometry, movedSteel.geometry); assert.equal(item(state, steel.id).confirmation, null); assert.equal(state.snapshot.transfers.find(link => link.item_id === steel.id).id, linked.id); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); evidence.linkedDeletion = { calculator: linked.calculator_id, row: linked.row, clearedLiteralCells: populatedRow, unrelatedInputsPreserved: true, undoRestoredExactCalculatorDraft: true };
  // Closed polygon previews and server-bound labels exist for both area modes.
  const areaRecords = [];
  for (const mode of ['wall', 'slab']) {
    await page.locator(`[data-mode="${mode}"]`).click(); await fit(); await page.getByRole('button', { name: 'Trace surface', exact: true }).click(); await points([[100, 100], [400, 100], [400, 400], [100, 400]]);
    const previewLabel = page.locator('.takeoff-area-preview'); await expect(previewLabel).toContainText('m²'); const previewArea = Number((await previewLabel.textContent()).replace(/,/g, '').match(/\d+(?:\.\d+)?/)[0]);
    const outline = page.locator('polygon.takeoff-pending,path.takeoff-pending,polyline.takeoff-pending'); const closed = await outline.evaluate(el => el.tagName.toLowerCase() === 'polygon' || /z\s*$/i.test(el.getAttribute('d') || '') || el.points?.numberOfItems > 3 && el.points.getItem(0).x === el.points.getItem(el.points.numberOfItems - 1).x && el.points.getItem(0).y === el.points.getItem(el.points.numberOfItems - 1).y); assert.equal(closed, true, 'Live surface preview must include its closing boundary');
    const previewBox = await previewLabel.boundingBox(), outlineBox = await outline.boundingBox(); assert.ok(previewBox.x >= outlineBox.x && previewBox.y >= outlineBox.y && previewBox.x + previewBox.width <= outlineBox.x + outlineBox.width && previewBox.y + previewBox.height <= outlineBox.y + outlineBox.height, 'Area preview stays inside the traced rectangle');
    await page.screenshot({ path: path.join(output, `${mode}-live-preview.png`) }); await finish();
    state = await command(() => dialog(`Add ${mode} surface`, { [mode === 'wall' ? 'Wall ID' : 'Slab / zone ID']: `DRAG-${mode.toUpperCase()}`, 'Explicit physical quantity': 1, 'Surface basis': mode === 'wall' ? 'wall-face' : 'slab-soffit', 'True-surface source citation': `Synthetic true ${mode} surface only` }, 'Add surface'), 'create_item');
    const area = state.snapshot.items.find(value => value.mode === mode); await select(area.id); const committedArea = await checkAreaLabel(state, area.id); assert.ok(Math.abs(previewArea - committedArea) <= .0051); evidence[`${mode}Preview`] = { previewArea, committedArea };
    state = await command(() => drag(area.id, 1, [450, 120], '', async midway => { await expect(page.locator('.takeoff-area-preview')).toContainText('Preview'); const current = await page.evaluate(() => window.CeasefireTakeoffs.projectFingerprint()); assert.notEqual(current, midway, 'Every changed pending point position changes the project fingerprint'); assert.deepEqual(JSON.parse(current).snapshot.items.find(value => value.id === area.id).geometry, area.geometry); }), 'update_item'); assert.deepEqual(item(state, area.id).geometry.points[0], area.geometry.points[0]); await checkAreaLabel(state, area.id);
    if (mode === 'wall') {
      await page.getByRole('button', { name: 'Add exclusion', exact: true }).click(); await fit(); await points([[180, 180], [250, 180], [250, 250], [180, 250]]); await finish(); state = await command(() => dialog('Add excluded opening', { 'Exclusion source / reason': 'Synthetic retained opening' }, 'Add exclusion'), 'update_item');
      const hole = item(state, area.id).geometry.exclusions[0]; await page.getByRole('button', { name: 'Select', exact: true }).click(); state = await command(() => drag(area.id, 1, [280, 180], hole.id), 'update_item');
      assert.equal(item(state, area.id).geometry.exclusions[0].id, hole.id); assert.equal(item(state, area.id).geometry.exclusions[0].note, hole.note); await checkAreaLabel(state, area.id);
      state = await edit({ 'Substrate': 'Concrete', 'Treatment': 'Nominated board', 'FRL / fire rating': '120/120/120' }); await confirm();
      state = await command(() => drag(area.id, 2, [410, 420]), 'update_item'); assert.equal(item(state, area.id).confirmation, null); await checkAreaLabel(state, area.id);
    }
    areaRecords.push(item(state, area.id));
  }
  await page.locator('[data-mode="duct"]').click(); await fit(); await page.getByRole('button', { name: 'Trace length', exact: true }).click(); await points([[150, 200], [300, 200]]); await finish();
  state = await command(() => dialog('Add duct object', { 'Item': 'DRAG-DUCT', 'Count/QTY': 1 }, 'Add item'), 'create_item'); const duct = state.snapshot.items.find(value => value.mode === 'duct'); await select(duct.id);
  state = await command(() => drag(duct.id, 1, [350, 225]), 'update_item'); assert.equal(item(state, duct.id).fields.shape, 'rectangular'); assert.deepEqual(item(state, duct.id).geometry.points[0], duct.geometry.points[0]);
  await page.locator('[data-mode="wall"]').click(); await select(areaRecords[0].id); await fit();
  for (const width of [1600, 900, 620]) { await layout(width); await page.locator('.takeoff-viewport').evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180)); await page.screenshot({ path: path.join(output, `layout-${width}.png`) }); }
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.getByLabel('Register position', { exact: true }).selectOption('beside'); const besidePlan = await page.locator('.takeoff-viewport').boundingBox(), besideNav = await page.getByLabel('Drawing navigation', { exact: true }).boundingBox(), besideRegister = await page.locator('.takeoff-register').boundingBox(); assert.ok(besideNav.y >= besidePlan.y && besideNav.y + besideNav.height < besidePlan.y + besidePlan.height); assert.ok(besideRegister.x >= besidePlan.x + besidePlan.width); evidence.beside = { plan: besidePlan, navigation: besideNav, register: besideRegister }; await page.screenshot({ path: path.join(output, 'layout-beside-1600.png') }); await page.getByLabel('Register position', { exact: true }).selectOption('below');
  for (const [label, extension] of [['Download PDF', 'pdf'], ['Download XLSX', 'xlsx']]) { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); const download = await pending, target = path.join(output, `edited-surface.${extension}`); await download.saveAs(target); const bytes = fs.readFileSync(target); assert.ok(bytes.length > 100); assert.equal(bytes.subarray(0, extension === 'pdf' ? 5 : 2).toString(), extension === 'pdf' ? '%PDF-' : 'PK'); }
  const beforeSave = await snapshot(), saving = page.waitForResponse(r => r.url().endsWith('/api/project/save-as')); await page.getByRole('button', { name: 'Save As', exact: true }).click(); assert.equal((await saving).status(), 200); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const opening = page.waitForResponse(r => r.url().endsWith('/api/project/open')); await page.getByRole('button', { name: 'Load', exact: true }).click(); assert.equal((await opening).status(), 200); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  assert.deepEqual((await snapshot()).items, beforeSave.items); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.takeoffs.documents.length, 2); for (const file of [info.fixture, info.area_fixture]) assert.equal(saved.takeoffs.documents.find(doc => doc.name === path.basename(file)).sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []); await Promise.all(assetTasks); assert.equal(Object.keys(assets).length, 3);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, assets, requests, errors, csp: [], savedItems: saved.takeoffs.items }, null, 2));
  console.log(`PASS: left plan tools, fixed viewer overlays, source documents, source-coordinate line/surface/exclusion editing, live and committed area labels, invalid rollback, deletion/undo, unchanged calculator inputs, save/reopen and downloads. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2)); if (browser) await browser.close(); server.kill(); });
