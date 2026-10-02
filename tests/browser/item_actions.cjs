// Real item actions, calculator leases and saved Undo on disposable source data.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `item-actions-${Date.now()}`);
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
async function pageNumber(number) {
  return command(async () => { await fill(page, 'Page number', number); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
}
const fit = () => command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
// Opening Takeoffs with a retained PDF renders it asynchronously. aria-busy
// becomes true only when its render observation is recorded, so a click plus
// an immediate idle check can race that command before a snapshot or edit.
const returnToTakeoffs = () => command(() => page.getByRole('button', { name: 'Takeoffs', exact: true }).click(), 'record_render');
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  return [Math.round(box.x + (y - 30) / 540 * box.width), Math.round(box.y + (x - 20) / 780 * box.height)];
}
async function editItem(id) {
  const row = page.locator(`tr[data-item-id="${id}"]`), panel = page.locator(`.takeoff-register-editor[data-editor-item-id="${id}"]`);
  if (!await panel.isVisible()) await row.getByRole('button', { name: 'Edit item', exact: true }).click();
  await expect(panel).toBeVisible(); return panel;
}
async function confirmItem() {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items');
}
async function transfer() {
  const preview = await response(() => page.getByRole('button', { name: 'Preview transfer', exact: true }).click(), '/transfer-preview');
  const result = await response(() => dialog('Transfer 1 confirmed items?', {}, 'Add to schedule'), '/transfer-apply');
  return { preview, result };
}
async function openSpray() {
  await page.locator('.nav-button[data-view="calculators"]').click();
  await page.locator('.calculator-choice').filter({ hasText: 'Steel (spray)' }).click();
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
}
async function changeCell(address, value) {
  const control = page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${address}"]`);
  await control.fill(String(value)); await control.press('Tab');
  await expect.poll(async () => (await calculators()).steel_vermiculite.inputs.SCHEDULE[address]).toBe(value);
}
async function deleteItem(id, status = 200) {
  const panel = await editItem(id), trash = panel.getByRole('button', { name: 'Delete item', exact: true });
  await expect(trash.locator('svg')).toHaveCount(1); await trash.click();
  await expect(page.getByRole('dialog')).toContainText('2 linked schedule rows');
  return response(() => dialog('Delete item?', {}, 'Delete item'), '/linked-delete', status);
}
async function saveLoad(info) {
  await response(() => page.getByRole('button', { name: 'Save As', exact: true }).click(), '/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  await response(() => page.getByRole('button', { name: 'Load', exact: true }).click(), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await returnToTakeoffs(); return saved;
}
function clearedExpected(original, bindings) {
  const expected = structuredClone(original);
  for (const binding of bindings) {
    const draft = expected[binding.calculator_id];
    for (const address of Object.keys(binding.values)) draft.inputs[binding.sheet][address] = null;
    draft.schedule_rows = draft.schedule_rows.filter(row => row !== binding.row);
    if (!draft.schedule_rows.length) draft.schedule_rows = [binding.calculator_id === 'steel_vermiculite' ? 10 : 9];
  }
  return expected;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(commands|linked-delete|linked-undo)$/.test(request.url())) requests.push({ endpoint: request.url().split('/').pop(), body: request.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle(); await pageNumber(3); await fit();
  await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  for (const point of [[150, 400], [350, 400]]) await page.mouse.click(...await screen(point));
  await page.mouse.dblclick(...await screen([550, 400]));
  let reply = await command(() => dialog('Add steel object', { 'Member mark': 'ACTIONS-STEEL', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides', 'Physical quantity': 2 }, 'Add item'), 'create_item');
  const id = reply.snapshot.items[0].id, originalMembers = reply.snapshot.items[0].member_ids;
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const handle = page.locator(`.takeoff-control-point[data-control-item-id="${id}"][data-point-index="0"]`);
  await handle.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Insert Rise / Drop', exact: true }).click();
  const modal = page.getByRole('dialog');
  for (const label of ['Source document', 'Source page', 'Source dimension / citation']) await expect(modal.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(modal.locator('input,select,textarea')).toHaveCount(2);
  reply = await command(() => dialog('Insert Rise / Drop', { 'Type': 'riser', 'Additional length (mm)': 1250.125 }, 'Add length'), 'update_item');
  let item = reply.snapshot.items[0], addition = item.length_additions[0];
  assert.deepEqual(addition.anchor, { point_index: 0, point: item.geometry.points[0] }); assert.equal(addition.note, undefined); assert.equal(addition.page, 3);
  await handle.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Delete control point', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(output, 'anchored-rise-control-menu.png') });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await handle.scrollIntoViewIfNeeded(); let box = await handle.boundingBox();
  reply = await command(async () => { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 18, { steps: 8 }); await page.mouse.up(); }, 'update_item');
  item = reply.snapshot.items[0]; assert.notDeepEqual(item.geometry.points[0], addition.anchor.point); assert.deepEqual(item.length_additions[0].anchor.point, item.geometry.points[0]); assert.equal(item.length_additions[0].length_mm, 1250.125);
  evidence.anchorFollowsMovedPoint = true;
  await page.locator(`.takeoff-control-point[data-control-item-id="${id}"][data-point-index="1"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert Rise / Drop', exact: true }).click();
  reply = await command(() => dialog('Insert Rise / Drop', { 'Type': 'drop', 'Additional length (mm)': 700.25 }, 'Add length'), 'update_item');
  assert.deepEqual(reply.snapshot.items[0].length_additions.map(value => [value.kind, value.length_mm]), [['riser', 1250.125], ['drop', 700.25]]);
  console.log('Rise/Drop simplified fields, anchored-point protection and anchor movement passed.');
  const panel = await editItem(id);
  for (const name of ['Add rise / drop', 'Clone', 'New draft', 'Replace source on current page']) await expect(panel.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true }).locator('svg')).toHaveCount(1);
  await confirmItem(); await transfer();
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_board');
  await fill(panel, 'Protection product', 'TRAFALGAR COREX'); await fill(panel, 'Critical temperature (°C)', 620); await fill(panel, 'Exposed sides', 3);
  await command(() => panel.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item'); await confirmItem(); await transfer();
  let state = await snapshot(), bindings = state.transfers;
  assert.equal(bindings.length, 2); assert.equal(bindings.find(value => value.calculator_id === 'steel_vermiculite').status, 'stale');
  console.log('The same source item has two actual linked calculator rows.');
  const spray = bindings.find(value => value.calculator_id === 'steel_vermiculite');
  await openSpray(); await page.getByRole('button', { name: 'Add row', exact: true }).click(); await changeCell('A11', 'UNRELATED-MANUAL');
  let baseline = await calculators(); const sourceLength = baseline.steel_vermiculite.inputs.SCHEDULE[`J${spray.row}`];
  await changeCell(`J${spray.row}`, sourceLength + 1); const conflicted = await calculators();
  await returnToTakeoffs(); const conflictBefore = await snapshot();
  await deleteItem(id, 400); assert.deepEqual(await snapshot(), conflictBefore); assert.deepEqual(await calculators(), conflicted);
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('row was edited'); evidence.conflictPreservesBothSchedules = true;
  console.log('Manual row conflict blocked deletion without changing either calculator or takeoffs.');
  await openSpray(); await changeCell(`J${spray.row}`, sourceLength); await returnToTakeoffs(); baseline = await calculators();
  const before = await snapshot();
  // Lose one response after the server commits, then let the UI retry the same
  // request identity. No second deletion or calculator overwrite is permitted.
  let lost = false;
  await page.route('**/linked-delete', async route => { if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  try { reply = await deleteItem(id); } finally { await page.unroute('**/linked-delete'); }
  assert.equal(reply.revision, before.revision + 1); assert.equal(reply.snapshot.items.length, 0); assert.equal(reply.snapshot.transfers.length, 0);
  assert.deepEqual(await calculators(), clearedExpected(baseline, bindings));
  const retries = requests.filter(value => value.endpoint === 'linked-delete').slice(-2); assert.equal(retries[0].body.request_id, retries[1].body.request_id); evidence.idempotentResponseRecovery = true;
  await page.screenshot({ path: path.join(output, 'linked-item-and-schedules-deleted.png') });
  const saved = await saveLoad(info); assert.equal(saved.takeoffs.items.length, 0); assert.deepEqual(saved.calculators.steel_vermiculite.inputs, (await calculators()).steel_vermiculite.inputs);
  await pageNumber(2); await fit(); const renderChecks = (await snapshot()).render_checks;
  reply = await response(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), '/linked-undo');
  assert.deepEqual(await calculators(), baseline); item = reply.snapshot.items.find(value => value.id === id);
  assert.deepEqual(item.member_ids, originalMembers); assert.deepEqual(item.geometry, before.items[0].geometry); assert.deepEqual(item.length_additions, before.items[0].length_additions); assert.equal(item.state, 'draft');
  assert.deepEqual(reply.snapshot.render_checks, renderChecks); assert.equal(reply.snapshot.transfers.length, 2); assert.ok(reply.snapshot.transfers.every(value => value.status === 'stale')); evidence.savedReopenedRenderedUndo = true;
  console.log('Atomic deletion, lost-response recovery and saved/reopened/rendered coupled Undo passed.');
  await pageNumber(3); await fit(); await editItem(id);
  await page.locator('.takeoff-register-editor').getByRole('button', { name: 'Delete item', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'restored-item-details-and-rise.png') });
  await openSpray(); await page.locator(`tr[data-source-row="${spray.row}"]`).getByRole('button', { name: /Remove line/ }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true'); const alreadyCleared = await calculators();
  for (const address of Object.keys(spray.values)) assert.ok(alreadyCleared.steel_vermiculite.inputs.SCHEDULE[address] == null);
  await returnToTakeoffs();
  const uncertainBefore = await snapshot(); let unreadable = 0, saveAttempts = 0;
  const saveWatcher = request => { if (/\/api\/project\/save(?:-as)?$/.test(request.url())) saveAttempts++; };
  page.on('request', saveWatcher);
  await page.route('**/linked-delete', async route => {
    if (unreadable < 2) {
      unreadable++; const committed = await route.fetch(); assert.equal(committed.status(), 200);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"session_id":' });
    } else await route.continue();
  });
  try {
    const currentEditor = await editItem(id);
    await currentEditor.getByRole('button', { name: 'Delete item', exact: true }).click();
    await dialog('Delete item?', {}, 'Delete item');
    const retry = page.getByRole('button', { name: 'Retry linked change', exact: true });
    await expect(retry).toBeVisible(); await expect.poll(() => unreadable).toBe(2);
    await expect(page.locator('#takeoffs-workspace')).toHaveAttribute('aria-busy', 'true');
    await expect(currentEditor.getByRole('button', { name: 'Delete item', exact: true })).toBeDisabled();
    await expect(currentEditor.getByLabel('Member mark', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Trace length', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Undo last edit', exact: true })).toBeDisabled();
    const guards = await page.evaluate(() => {
      const attempt = action => { try { action(); return ''; } catch (error) { return error.message; } };
      return { takeoffs: attempt(() => window.CeasefireTakeoffs.projectSnapshot()), calculators: attempt(() => window.CeasefireCalculators.projectSnapshot()) };
    });
    assert.match(guards.takeoffs, /Finish|Wait/); assert.match(guards.calculators, /Finish|Wait/);
    const saveButton = page.getByRole('button', { name: 'Save As', exact: true });
    if (await saveButton.isEnabled()) {
      await saveButton.click(); await expect(page.locator('#app-message')).toContainText(/Finish|Wait/);
    }
    assert.equal(saveAttempts, 0, 'Project saving cannot serialize either side while a linked outcome is uncertain');
    const serverState = await page.evaluate(async () => (await fetch(`/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`)).json());
    assert.equal(serverState.revision, uncertainBefore.revision + 1); assert.equal(serverState.snapshot.items.length, 0); assert.equal(serverState.snapshot.transfers.length, 0);
    await page.screenshot({ path: path.join(output, 'uncertain-linked-response-locked.png') });
    reply = await response(() => retry.click(), '/linked-delete');
    assert.equal(reply.revision, serverState.revision, 'Explicit recovery returns the existing committed revision');
    const attempts = requests.filter(value => value.endpoint === 'linked-delete').slice(-3);
    assert.equal(attempts.length, 3); assert.ok(attempts.every(value => value.body.request_id === attempts[0].body.request_id));
    await expect(page.getByRole('button', { name: 'Retry linked change', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Trace length', exact: true })).toBeEnabled();
    evidence.repeatedUnreadableResponseLocksUntilExplicitRecovery = true;
  } finally { await page.unroute('**/linked-delete'); page.off('request', saveWatcher); }
  assert.deepEqual(await calculators(), clearedExpected(alreadyCleared, bindings));
  await response(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), '/linked-undo');
  assert.deepEqual(await calculators(), alreadyCleared); evidence.alreadyRemovedRowSafe = true;
  state = await snapshot(); assert.equal(state.items.length, 1); assert.equal(state.items[0].id, id); assert.deepEqual(state.items[0].member_ids, originalMembers);

  // The last marker represents its entire Count item. Its context menu must
  // use the same coupled deletion, rather than leaving its schedule quantity.
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite');
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await page.mouse.click(...await screen([300, 200]));
  await dialog('Counted member length', { 'Length per member (m)': 2.3456789 }, 'Place marker');
  await expect(page.locator('.takeoff-count-pending')).toHaveCount(1);
  reply = await command(async () => page.mouse.dblclick(...await screen([450, 200])), 'add_count_items');
  const counted = reply.snapshot.items.find(value => value.geometry?.kind === 'count'), countPanel = page.locator('.takeoff-markup-settings');
  for (const [label, value] of Object.entries({ 'Member mark': 'LAST-COUNT', 'Member type': 'Beam', 'Protection product': 'CAFCO 300', 'Steel section': '100UC15', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides' })) await fill(countPanel, label, value);
  await command(() => countPanel.getByRole('button', { name: 'Apply settings', exact: true }).click(), 'bulk_update');
  await confirmItem(); await transfer();
  const countBefore = await snapshot(), countCalculators = await calculators(), countBinding = countBefore.transfers.find(value => value.item_id === counted.id);
  assert.ok(countBinding);
  await page.locator(`[data-count-member-id="${counted.member_ids[0]}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete count marker', exact: true }).click();
  reply = await response(() => dialog('Delete last count marker?', {}, 'Delete marker and linked rows'), '/linked-delete');
  assert.ok(!reply.snapshot.items.some(value => value.id === counted.id)); assert.ok(!reply.snapshot.transfers.some(value => value.item_id === counted.id));
  assert.deepEqual(await calculators(), clearedExpected(countCalculators, [countBinding]));
  reply = await response(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), '/linked-undo');
  const restoredCount = reply.snapshot.items.find(value => value.id === counted.id);
  assert.equal(restoredCount.count_id, counted.count_id); assert.deepEqual(restoredCount.member_ids, counted.member_ids); assert.equal(restoredCount.measurement.length_m, 2.3456789); assert.equal(restoredCount.quantity, 1);
  assert.deepEqual(await calculators(), countCalculators); evidence.lastLinkedCountMarkerUsesCoupledDelete = true;
  state = reply.snapshot;
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, item: state.items[0], bindings: state.transfers, requests: requests.map(value => ({ endpoint: value.endpoint, op: value.body.op, request_id: value.body.request_id, revision: value.body.expected_revision })), errors, savedProject: info.project }, null, 2));
  console.log(`PASS: anchored Rise/Drop, item trash, two linked schedules, manual conflict, lost-response recovery, save/reopen/render Undo and already-cleared rows. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
