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
async function assertAutoHeight(layout) {
  const sizes = {};
  for (const selector of ['.takeoff-register', '.takeoff-register-table', '.takeoff-register-editor']) {
    const size = await page.locator(selector).evaluate(el => ({clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,overflowY:getComputedStyle(el).overflowY}));
    assert.ok(size.scrollHeight <= size.clientHeight + 1,`${layout} ${selector} has nested vertical scrolling: ${JSON.stringify(size)}`);sizes[selector]=size;
  }
  (evidence.autoHeight ||= {})[layout]=sizes;
}
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
  if (!await page.getByLabel('Drawing calibration', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByLabel('Drawing calibration', { exact: true }).selectOption(`scale:${denominator}`);
  return command(() => dialog(`Apply drawing scale 1:${denominator}?`, {}, 'Apply scale'), 'add_calibration');
}
async function viewport(name, points, denominator) {
  const panel = page.getByRole('complementary', { name: 'Viewports', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await panel.getByRole('button', { name: 'Add viewport', exact: true }).click();
  const before = operations.filter(op => op === 'add_calibration').length;
  await draw([points[0]]); await page.mouse.move(...await screenPoint(points[1]));
  const preview = page.locator('.takeoff-viewport-preview'); await expect(preview).toBeVisible();
  assert.equal((await preview.getAttribute('points')).trim().split(/\s+/).length, 4, 'The live viewport boundary is a rectangle, never an arbitrary polygon');
  assert.notEqual(await preview.evaluate(el => getComputedStyle(el).fill), 'none', 'Viewport tracing has a filled preview like surface tracing');
  await draw([points[1]]); await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(operations.filter(op => op === 'add_calibration').length, before, 'Two single clicks do not create a viewport or open its scale dialog');
  if (!fs.existsSync(path.join(output, 'viewport-pending-rectangle.png'))) await page.screenshot({ path: path.join(output, 'viewport-pending-rectangle.png') });
  await page.mouse.dblclick(...await screenPoint(points[1]));
  return command(() => dialog('Create viewport', { 'Viewport name': name, 'Scale': denominator }, 'Create viewport'), 'add_calibration');
}
const steelFields = { 'Member mark': 'SCALE-100', 'Level': 'L02', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides', 'Physical quantity': 2 };
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
async function addition(docId, kind, mm) {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const handle = page.locator('.takeoff-control-point[data-exclusion-id=""]').first();
  const itemId = await handle.getAttribute('data-control-item-id'), pointIndex = Number(await handle.getAttribute('data-point-index'));
  await handle.click({button:'right'});
  await page.getByRole('menuitem', {name:'Insert Rise / Drop',exact:true}).click();
  const modal = page.getByRole('dialog');
  for (const label of ['Source document','Source page','Source dimension / citation']) await expect(modal.getByLabel(label,{exact:true})).toHaveCount(0);
  const result = await command(() => dialog('Insert Rise / Drop', { 'Type': kind, 'Additional length (mm)': mm }, 'Add length'), 'update_item');
  const item = result.snapshot.items.find(value=>value.id===itemId), retained = item.length_additions.at(-1);
  assert.equal(retained.document_id,docId); assert.equal(retained.page,3);
  assert.equal(retained.note,undefined); assert.deepEqual(retained.anchor,{point_index:pointIndex,point:item.geometry.points[pointIndex]});
  await expect(page.locator(`[data-addition-id="${retained.id}"]`)).toContainText(String(mm));
  return result;
}
async function inspector(values) {
  const panel = page.locator('.takeoff-register-editor');
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
  const shownReview = await page.getByRole('dialog').innerText();
  if (!fs.existsSync(path.join(output, 'transfer-preview-fixed2.png'))) await page.getByRole('dialog').screenshot({ path: path.join(output, 'transfer-preview-fixed2.png') });
  const applying = page.waitForResponse(r => r.url().endsWith('/transfer-apply'));
  await dialog('Transfer 1 confirmed items?', {}, 'Add to schedule');
  const applied = await applying, state = await applied.json(); assert.equal(applied.status(), 200, JSON.stringify(state)); await idle();
  return { preview, state, shownReview };
}
async function load() {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200, await response.text());
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
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
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish trace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cite length', exact: true })).toHaveCount(0);
  await expect(page.locator('.takeoff-inspector')).toHaveCount(0);
  await expect(page.getByLabel('Drawing calibration', { exact: true }).locator('option:checked')).toHaveText('No Scale Selected');
  const scaleToggle = page.getByRole('button', { name: 'Scale', exact: true });
  await expect(scaleToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toBeHidden();
  assert.equal(await scaleToggle.evaluate(el => el.parentElement.previousElementSibling.getAttribute('aria-label')), 'Viewport');
  await expect(page.locator('.takeoff-tool-rail > [data-tool="calibrate"]')).toHaveCount(0);
  const calibrate = page.locator('#takeoff-scale-controls [data-tool="calibrate"]');
  await expect(calibrate.locator('svg')).toHaveCount(0);
  assert.deepEqual(await calibrate.evaluate(el => [el.previousElementSibling.id, el.nextElementSibling.textContent]), ['takeoff-calibration', 'Edit calibration']);
  assert.equal(await page.getByRole('group', { name: 'Drawing downloads', exact: true }).evaluate(el => el.previousElementSibling.getAttribute('aria-label')), 'Takeoff modes');
  await scaleToggle.click(); await expect(scaleToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toBeFocused();
  await page.getByLabel('Drawing calibration', { exact: true }).press('Escape');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toBeHidden(); await expect(scaleToggle).toBeFocused();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  await command(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await fit();
  let state = await scale(100), doc = state.snapshot.documents[0], global = state.snapshot.calibrations[0];
  await expect(scaleToggle).toHaveAttribute('title', /1:100/); await expect(scaleToggle).toHaveAttribute('aria-expanded', 'false');
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
  // The register owns the editor: unapplied edits survive filters and a late Apply response.
  const editor = page.locator(`.takeoff-register-editor[data-editor-item-id="${mainId}"]`);
  await expect(editor).toBeVisible(); await expect(editor.locator('xpath=ancestor::table')).toHaveCount(1);
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await editor.getByLabel('Level', { exact: true }).fill('L03');
  await page.getByLabel('Filter register', { exact: true }).fill('not-a-matching-item');
  await expect(page.locator(`tr[data-item-id="${mainId}"]`)).toHaveCount(0);
  await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L03');
  await expect(page.locator('.takeoff-editor-pending-notice')).toContainText('unfinished edits');
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L03');
  for (const target of ['steel_board', 'steel_vermiculite']) {
    const choices = page.waitForResponse(r => r.url().includes(`/options?calculator=${target}&`));
    await page.getByLabel('Destination schedule', { exact: true }).selectOption(target); assert.equal((await choices).status(), 200);
    await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L03');
    await expect(editor.getByLabel('Steel section', { exact: true })).toHaveValue('100UC15');
    await expect(editor.getByLabel('Protection product', { exact: true })).toHaveValue('CAFCO 300');
  }
  const beforeDirtyTool = operations.length;
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('unfinished item edits');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await draw([[400, 420], [500, 420]]); await page.locator('.takeoff-viewport').press('Enter');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('unfinished item edits');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.ok(!operations.slice(beforeDirtyTool).includes('create_item'));
  await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L03');
  const unsavedGuard = await page.evaluate(() => { try { window.CeasefireTakeoffs.projectSnapshot(); return ''; } catch (error) { return error.message; } });
  assert.match(unsavedGuard, /unfinished/);
  const saveRequests = []; const watchSave = request => { if (request.url().endsWith('/api/project/save-as')) saveRequests.push(request.url()); }; page.on('request', watchSave);
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(page.locator('#app-message')).toContainText(/unfinished/);
  await page.screenshot({path:path.join(output,'unapplied-save-guard.png'),fullPage:true});
  page.off('request', watchSave); assert.deepEqual(saveRequests, []); assert.equal(fs.existsSync(info.project), false);
  await editor.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L02');
  await page.getByRole('button', { name: 'Cancel trace', exact: true }).click();
  await editor.getByLabel('Level', { exact: true }).fill('L03');
  await page.route('**/commands', route => route.request().postDataJSON()?.op === 'update_item' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({error:'Synthetic revision race; reload current source'}) }) : route.continue());
  try {
    await command(() => editor.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item', 409);
    await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L03');
    assert.match(await page.evaluate(() => { try { window.CeasefireTakeoffs.projectSnapshot(); return ''; } catch (error) { return error.message; } }), /unfinished/);
  } finally { await page.unroute('**/commands'); }
  await editor.getByRole('button', { name: 'Discard edits', exact: true }).click();
  let releaseApply, arrivedResolve, heldOnce = false;
  const heldApply = new Promise(resolve => { releaseApply = resolve; }), arrived = new Promise(resolve => { arrivedResolve = resolve; });
  await page.route('**/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'update_item' && body.item_id === mainId && !heldOnce) {
      heldOnce = true; const response = await route.fetch(); arrivedResolve(); await heldApply; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await editor.getByLabel('Level', { exact: true }).fill('L03');
    const applying = command(() => editor.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
    await arrived; await editor.getByLabel('Level', { exact: true }).fill('L04'); releaseApply();
    const captured = await applying; assert.equal(captured.snapshot.items.find(item => item.id === mainId).fields.level, 'L03');
    await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('L04');
    await expect(page.locator('#takeoffs-workspace [role="status"]').filter({hasText:'Later form edits remain unfinished'})).toBeVisible();
    await inspector({ 'Level': 'L04' });
  } finally { releaseApply(); await page.unroute('**/commands'); }
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.equal(state.snapshot.items.find(item => item.id === mainId).fields.level, 'L03');
  state = await inspector({ 'Level': 'L02' });
  const restoredMain = state.snapshot.items.find(item => item.id === mainId);
  assert.equal(restoredMain.fields.level, 'L02'); assert.deepEqual(restoredMain.geometry, main.geometry); assert.equal(restoredMain.quantity, main.quantity);
  evidence.register = { preservedFilteredEdit: true, blockedUnappliedSave: true, retainedLaterApplyEdit: true, undoRestoredInputs: true, failedApplyPreservedEdits: true, dirtyTraceBlocked: true, destinationChoicesRetainPendingEdits: true };
  state = await confirm(); assert.equal(state.snapshot.items.find(item => item.id === mainId).state, 'confirmed');
  const confirmedBeforeNoop = state.snapshot.items.find(item => item.id === mainId), noOpStart = operations.length;
  await editor.getByLabel('Level', { exact: true }).fill('L02');
  await editor.getByRole('button', { name: 'Apply item edits', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => { try { return !!window.CeasefireTakeoffs.projectSnapshot(); } catch { return false; } })).toBe(true);
  assert.ok(!operations.slice(noOpStart).includes('update_item'));
  assert.deepEqual((await snapshot()).items.find(item => item.id === mainId), confirmedBeforeNoop, 'No-op apply preserves sparse fields, revision and bound confirmation');
  evidence.register.noOpPreservesConfirmation = true;
  const baseline = state.item_results.find(item => item.id === mainId).length_m;
  state = await addition(doc.id, 'riser', 500, 'Synthetic R-01: 500 mm riser on each physical member; test-only cited dimension');
  main = state.snapshot.items.find(item => item.id === mainId); assert.equal(main.confirmation, null);
  result = state.item_results.find(item => item.id === mainId); assert.equal(result.base_length_m, baseline); assert.equal(result.additions_length_m, .5);
  assert.equal(result.length_m, baseline + .5); assert.equal(result.total_length_m, (baseline + .5) * 2);
  await confirm(); await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite');
  let transferred = await transfer(); const mainBinding = transferred.state.snapshot.transfers.find(binding => binding.item_id === mainId);
  assert.ok(transferred.shownReview.includes(`Per-member length: ${(baseline + .5).toFixed(2)} m`));
  assert.ok(transferred.shownReview.includes(`Total length: ${((baseline + .5) * 2).toFixed(2)} m`));
  assert.equal(transferred.preview.inputs.SCHEDULE['I' + mainBinding.row], 2); assert.equal(transferred.preview.inputs.SCHEDULE['J' + mainBinding.row], baseline + .5);
  const beforeDuplicate = await snapshot(), calculatorBeforeDuplicate = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  let duplicateApplyRequests = 0; const watchDuplicateApply = request => { if (request.url().endsWith('/transfer-apply')) duplicateApplyRequests++; };
  page.on('request', watchDuplicateApply);
  try {
    const pending = page.waitForResponse(response => response.url().endsWith('/transfer-preview'));
    await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
    const response = await pending, duplicate = await response.json(); assert.equal(response.status(), 200, JSON.stringify(duplicate));
    assert.deepEqual(duplicate.changes, []); assert.equal(duplicate.skipped.length, 1);
    assert.equal(duplicate.skipped[0].item_id, mainId); assert.equal(duplicate.skipped[0].binding_id, mainBinding.id); assert.equal(duplicate.skipped[0].reason, 'already_linked');
    await expect(page.locator('#takeoffs-workspace [role="status"]').filter({ hasText: 'already linked to Steel Spray' })).toContainText('No rows were added or changed');
    await expect(page.getByRole('dialog')).toHaveCount(0); assert.equal(duplicateApplyRequests, 0);
    assert.deepEqual(await snapshot(), beforeDuplicate); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorBeforeDuplicate);
    evidence.duplicateTransferSkippedWithoutMutation = true;
  } finally { page.off('request', watchDuplicateApply); }
  // Independent detail scale plus boundary rejection. Changing scale never changes the source coordinates.
  const beforeViewportCancel = await snapshot(), beforeCancelOperations = operations.length;
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByRole('complementary', { name: 'Viewports', exact: true }).getByRole('button', { name: 'Add viewport', exact: true }).click();
  await draw([[100, 100], [300, 400]]); await expect(page.getByRole('dialog')).toHaveCount(0);
  await cancelAt([250, 350]); await expect(page.locator('.takeoff-viewport-preview')).toHaveCount(0);
  assert.deepEqual((await snapshot()).calibrations, beforeViewportCancel.calibrations); assert.deepEqual((await snapshot()).items, beforeViewportCancel.items);
  assert.ok(!operations.slice(beforeCancelOperations).includes('add_calibration'), 'Right-click cancellation creates no scale or viewport');
  // Existing hit shapes are replaced by the first click's preview render. The
  // second click must still finish even when the browser suppresses dblclick.
  await page.getByRole('complementary', { name: 'Viewports', exact: true }).getByRole('button', { name: 'Add viewport', exact: true }).click();
  await draw([[100, 100]]);
  const markupFinish = await screenPoint([550, 500]);
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-item-id]')?.dataset.itemId, markupFinish), mainId, 'The opposite corner lands on an existing saved markup');
  await page.mouse.dblclick(...markupFinish);
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Create viewport', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.takeoff-viewport-preview')).toHaveCount(0);
  assert.deepEqual((await snapshot()).calibrations, beforeViewportCancel.calibrations); assert.deepEqual((await snapshot()).items, beforeViewportCancel.items);
  assert.ok(!operations.slice(beforeCancelOperations).includes('add_calibration'), 'Cancelling viewport details preserves calibrations and saved markups');
  evidence.viewportFinishOverSavedMarkup = true;
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
  await confirm();
  const outsideConfirmation = (await snapshot()).items.find(item => item.id === mainId).confirmation;
  const detailTransfer = await transfer(), detailBinding = detailTransfer.state.snapshot.transfers.find(binding => binding.item_id === detail.id);
  assert.ok(detailBinding); const destinationBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const panel = page.getByRole('complementary', { name: 'Viewports', exact: true });
  await expect(panel.locator('[data-calibration-id]')).toHaveCount(1);
  await expect(panel.getByLabel('Scale for viewport DETAIL-50', { exact: true })).toHaveValue('50');
  await panel.getByRole('button', { name: 'Select viewport DETAIL-50', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete viewport', exact: true }).click();
  const deleted = await command(() => dialog('Delete viewport DETAIL-50?', {}, 'Delete viewport'), 'delete_viewport');
  assert.ok(deleted.snapshot.calibrations.find(value => value.supersedes_id === detailId && value.deleted));
  assert.ok(deleted.snapshot.calibrations.find(value => value.id === detailId));
  assert.equal(deleted.snapshot.items.find(item => item.id === detail.id).confirmation, null);
  assert.equal(deleted.snapshot.items.find(item => item.id === detail.id).measurement.calibration_id, detailId);
  assert.deepEqual(deleted.snapshot.items.find(item => item.id === mainId).confirmation, outsideConfirmation);
  assert.equal(deleted.snapshot.transfers.find(binding => binding.item_id === detail.id).status, 'stale');
  await expect(panel.locator('[data-calibration-id]')).toHaveCount(0);
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue('');
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), destinationBefore);
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.equal(state.snapshot.items.find(item => item.id === detail.id).measurement.calibration_id, detailId);
  assert.equal(state.snapshot.items.find(item => item.id === detail.id).confirmation, null);
  await expect(panel.locator(`[data-calibration-id="${detailId}"]`)).toHaveCount(1);
  await confirm();
  // Row scales create revisions; undo restores the original calibration and exact source geometry.
  await panel.getByLabel('Scale for viewport DETAIL-50', { exact: true }).selectOption('manual');
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'calibrate');
  await panel.getByLabel('Scale for viewport DETAIL-50', { exact: true }).selectOption('75');
  const rescaled = await command(() => dialog('Apply drawing scale 1:75?', {}, 'Apply scale'), 'update_calibration');
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'select');
  const revisedScale = rescaled.snapshot.calibrations.find(value => value.supersedes_id === detailId && !value.deleted);
  assert.equal(revisedScale.scale_denominator, 75); assert.deepEqual(rescaled.snapshot.items.find(item => item.id === detail.id).geometry, detail.geometry);
  assert.equal(rescaled.snapshot.items.find(item => item.id === detail.id).confirmation, null);
  assert.deepEqual(rescaled.snapshot.items.find(item => item.id === mainId).confirmation, outsideConfirmation);
  await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo'); await confirm();
  await command(async () => { await page.getByLabel('Page number', { exact: true }).fill('1'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await expect(panel.locator('[data-calibration-id]')).toHaveCount(0);
  await command(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await expect(panel.locator(`[data-calibration-id="${detailId}"]`)).toHaveCount(1);
  await panel.getByRole('button', { name: 'Close viewports', exact: true }).click(); await expect(panel).toBeHidden();
  evidence.viewportPanel = { currentPageOnly: true, preservedDeletedHistory: true, invalidatedDependentOnly: true, destinationPreserved: true, undoRestoredIdentities: true, rowScaleRevision: true, abandonedManualReset: true };
  await fit();
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
  await expect(page.locator('.takeoff-register-editor').getByLabel('Shape', { exact: true })).toHaveCount(0);
  await expect(page.locator('.takeoff-register-editor').getByLabel('Diameter (mm)', { exact: true })).toHaveCount(0);
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
  await viewport('SECOND-25', [[100, 450], [250, 540]], 25);
  await page.setViewportSize({width:1440,height:1000}); await fit();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'viewport-riser-confirmed.png'), fullPage: true });
  await page.locator('.takeoff-register-editor').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.locator('.takeoff-register-editor').screenshot({ path: path.join(output, 'riser-inspector.png') });
  const save = page.waitForResponse(r => r.url().endsWith('/api/project/save-as')); await page.getByRole('button', { name: 'Save As', exact: true }).click();
  assert.equal((await save).status(), 200); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.version, 2);
  const openPanel = page.getByRole('complementary', {name:'Viewports',exact:true}); await expect(openPanel.locator('[data-calibration-id]')).toHaveCount(2);
  await page.locator('.takeoff-register-table').evaluate(el => {el.scrollTop=0;el.scrollLeft=0;});
  await page.locator('.takeoff-drawing-layout').screenshot({path:path.join(output,'viewports-panel-open-desktop.png')});
  await page.setViewportSize({width:1440,height:1800});
  assert.equal(await page.locator('.takeoff-register').evaluate(el=>getComputedStyle(el).resize),'none','The register follows its content rather than manual sizing');
  await assertAutoHeight('below-desktop');
  await page.locator('.takeoff-register-table').evaluate(el=>{el.scrollTop=0;el.scrollLeft=0;});
  await page.locator('.takeoff-register').screenshot({path:path.join(output,'register-expanded-desktop.png')});
  await page.getByLabel('Register position',{exact:true}).selectOption('beside');await assertAutoHeight('beside-desktop');
  await page.setViewportSize({width:750,height:1000});await assertAutoHeight('beside-tablet');
  await page.locator('.takeoff-register-table').evaluate(el => {el.scrollTop=0;el.scrollLeft=0;});
  await page.screenshot({path:path.join(output,'register-viewports-tablet.png'),fullPage:true});
  await page.getByLabel('Register position',{exact:true}).selectOption('below'); await page.setViewportSize({width:1440,height:1000});

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
      const dimensions = JSON.parse(row['Riser/drop source dimensions']);
      assert.equal(dimensions[0].document_sha256, doc.sha256); assert.equal(dimensions[0].document_id, doc.id);
      assert.equal(dimensions[0].page, 3); assert.ok(Number.isInteger(dimensions[0].anchor.point_index));
      assert.equal(dimensions[0].length_mm, additionLength * 1000);
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
  console.log(`PASS: sole register editor, dirty/filter/save and late/failed Apply guards, panel deletion/rescale/undo, preset/UserUnit/rotation/crop, boundary and zoom, full-precision transfers with fixed2 display, Save As/reopen, exports and tamper rejection. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
