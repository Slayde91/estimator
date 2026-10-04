// Native filtered register results from receipt-bound spray and board schedules.
// Validated API commands seed synthetic source rows; transfers, filtering,
// calculator edits and Save/Load use the rendered controls.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `linked-thickness-${Date.now()}`);
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
const errors = [], evidence = {}, requests = [];
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() {
  // A reopened drawing can still be recording its render proof after derived
  // thickness appears. Capture one committed snapshot, without editing drafts.
  const captured = await page.waitForFunction(() => {
    try { return window.CeasefireTakeoffs.projectSnapshot(); }
    catch (error) {
      if (error.message === 'Finish the current takeoff operation before saving.') return false;
      throw error;
    }
  });
  try { return await captured.jsonValue(); } finally { await captured.dispose(); }
}
const calculators = () => page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
const row = id => page.locator(`tr[data-item-id="${id}"]`);
const thickness = id => page.locator(`td[data-thickness-item-id="${id}"]`);
async function response(action, suffix) {
  const pending = page.waitForResponse(value => value.url().endsWith(suffix)); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); await idle(); return body;
}
async function seed() {
  return page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, session = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const doc = current.documents[0], calibration = crypto.randomUUID();
    const command = async (op, values) => {
      const response = await fetch(`/api/takeoffs/sessions/${session}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op, ...values }) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); current = result.snapshot; return result;
    };
    await command('add_calibration', { calibration: { id: calibration, document_id: doc.id, page: 1, name: 'Synthetic known 10 m', points: [[100, 75], [500, 75]], distance_m: 10, uniform_scale: true } });
    const ids = [];
    for (const [mark, product, section, y] of [['SPRAY-LINK', 'MONOKOTE MK-6 HY', '410UB54', 400], ['BOARD-LINK', 'TRAFALGAR COREX', '100UC15', 300], ['UNLINKED', 'CAFCO 300', '100UC15', 200]]) {
      await command('create_item', { item: { mode: 'steel', geometry: { document_id: doc.id, page: 1, points: [[100, y], [500, y]] }, measurement: { method: 'calibrated', calibration_id: calibration }, quantity: 2,
        fields: { mark, section, member_type: 'Beam', exposure: 'Re-entrant - 3 sides', fire_period_min: 120, critical_temperature: 620, product, sides: 3 }, evidence: [{ document_id: doc.id, page: 1, note: 'Synthetic calculator projection acceptance' }] } });
      ids.push(current.items.at(-1).id);
    }
    await command('confirm_items', { item_ids: ids });
    takeoffs.applyProject(await takeoffs.prepareProject(current, session)); await takeoffs.open();
    return ids;
  });
}
async function select(id) {
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await row(id).getByRole('checkbox', { name: /^Select / }).check();
}
async function transfer(id, target) {
  await page.getByLabel('Destination schedule', { exact: true }).selectOption(target); await select(id);
  await response(() => page.getByRole('button', { name: 'Preview transfer', exact: true }).click(), '/transfer-preview');
  return response(() => page.getByRole('dialog').getByRole('button', { name: 'Add to schedule', exact: true }).click(), '/transfer-apply');
}
async function nativeOutput(target, binding, column) {
  const drafts = await calculators(), response = await page.request.post(`${new URL(page.url()).origin}/api/calculators/${target}/calculate`, { data: { inputs: drafts[target].inputs, sheet: binding.sheet, start_row: binding.row, row_count: 1 } });
  assert.equal(response.status(), 200, await response.text()); const calculated = await response.json();
  return calculated.rows.flatMap(row => row.cells).find(cell => cell.address === column + binding.row).value;
}
async function editSprayLength(binding, value) {
  await chooseCalculator(page, 'Steel (spray)');
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
  const control = page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="J${binding.row}"]`);
  await control.fill(String(value)); await control.press('Tab');
  await expect.poll(async () => (await calculators()).steel_vermiculite.inputs.SCHEDULE[`J${binding.row}`]).toBe(value);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(commands|transfer-apply|linked-results)$/.test(request.url())) requests.push({ endpoint: request.url().split('/').pop(), body: request.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot().render_checks.some(check => check.page === 1 && check.success); } catch { return false; } });
  const [sprayId, boardId, unlinkedId] = await seed(); await idle();
  for (const id of [sprayId, boardId, unlinkedId]) await expect(thickness(id)).toHaveText('—');
  const sprayed = await transfer(sprayId, 'steel_vermiculite'), sprayBinding = sprayed.snapshot.transfers.find(value => value.item_id === sprayId);
  const sprayValue = await nativeOutput('steel_vermiculite', sprayBinding, 'P');
  assert.ok(Number.isFinite(sprayValue) && sprayValue > 0);
  await expect(thickness(sprayId)).toHaveText(String(sprayValue)); await expect(thickness(unlinkedId)).toHaveText('—');
  await expect(thickness(sprayId)).toHaveAttribute('title', /Estimating thickness.*Published thickness:.*Calculator source SHA-256/);
  assert.equal(await thickness(sprayId).locator('input').count(), 0, 'Calculated thickness is read-only'); evidence.exactSpray = sprayValue;
  const beforeFilter = await snapshot(), beforeCalculators = await calculators(), writesBefore = requests.filter(value => value.endpoint !== 'linked-results').length;
  await page.getByRole('button', { name: 'Filter Thickness (mm)', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: String(sprayValue), exact: true }).check(); await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(row(sprayId)).toBeVisible(); await expect(row(boardId)).toHaveCount(0); await expect(row(unlinkedId)).toHaveCount(0);
  assert.deepEqual(await snapshot(), beforeFilter); assert.deepEqual(await calculators(), beforeCalculators);
  assert.equal(requests.filter(value => value.endpoint !== 'linked-results').length, writesBefore);
  await page.getByRole('button', { name: 'Filter Thickness (mm)', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset filter', exact: true }).click(); evidence.filterIsReadOnly = true;
  const boarded = await transfer(boardId, 'steel_board'), boardBinding = boarded.snapshot.transfers.find(value => value.item_id === boardId);
  const boardValue = await nativeOutput('steel_board', boardBinding, 'AB');
  await expect(thickness(boardId)).toHaveText(String(boardValue)); await expect(thickness(sprayId)).toHaveText('—');
  await expect(thickness(boardId)).toHaveAttribute('title', /Total board thickness.*Stack:.*layers:/); evidence.exactBoardTotal = boardValue;
  await thickness(boardId).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'steel-linked-board-thickness.png') });
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite');
  await expect(thickness(sprayId)).toHaveText(String(sprayValue)); await expect(thickness(boardId)).toHaveText('—'); evidence.destinationScoped = true;
  // Hold a real projection response while a register field has uncommitted
  // text. Returning the derived result must preserve that focused input.
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_board'); await expect(thickness(boardId)).toHaveText(String(boardValue));
  let releaseProjection, startedProjection;
  const projectionHeld = new Promise(resolve => { startedProjection = resolve; }), release = new Promise(resolve => { releaseProjection = resolve; });
  await page.route('**/linked-results', async route => { const result = await route.fetch(); startedProjection(); await release; await route.fulfill({ response: result }); });
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_vermiculite'); await projectionHeld;
  const pendingLevel = row(sprayId).getByLabel('Level', { exact: true }), oldLevel = await pendingLevel.inputValue();
  const writesBeforeProjection = requests.filter(value => value.endpoint === 'commands').length;
  await pendingLevel.fill('UNCOMMITTED LEVEL'); releaseProjection();
  await expect(thickness(sprayId)).toHaveText(String(sprayValue)); await expect(pendingLevel).toBeFocused(); await expect(pendingLevel).toHaveValue('UNCOMMITTED LEVEL');
  assert.equal(requests.filter(value => value.endpoint === 'commands').length, writesBeforeProjection);
  await pendingLevel.fill(oldLevel); await pendingLevel.press('Tab'); await page.unroute('**/linked-results'); evidence.pendingInputPreserved = true;
  const length = (await calculators()).steel_vermiculite.inputs.SCHEDULE[`J${sprayBinding.row}`];
  await editSprayLength(sprayBinding, length + 0.125); await expect(thickness(sprayId)).toHaveText('Unavailable');
  await expect(thickness(sprayId)).toHaveAttribute('title', /linked row was edited/); evidence.manualEditWithheld = true;
  await editSprayLength(sprayBinding, length); await expect(thickness(sprayId)).toHaveText(String(sprayValue)); evidence.restoredExactDraftRechecked = true;
  const savedBefore = await snapshot(), calculatorsBeforeSave = await calculators();
  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as');
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await expect(thickness(sprayId)).toHaveText(String(sprayValue)); assert.deepEqual((await snapshot()).transfers, savedBefore.transfers); assert.deepEqual(await calculators(), calculatorsBeforeSave); evidence.saveReopenRetainsProvenance = true;
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click(); await select(sprayId);
  await page.getByRole('button', { name: 'Detach links', exact: true }).click();
  await response(() => page.getByRole('dialog').getByRole('button', { name: 'Detach links', exact: true }).click(), '/commands');
  await expect(thickness(sprayId)).toHaveText('—'); assert.deepEqual(await calculators(), calculatorsBeforeSave); evidence.detachPreservesManualCalculator = true;
  const cspViolations = await page.evaluate(() => window.qaCsp); assert.deepEqual(errors, []); assert.deepEqual(cspViolations, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, cspViolations, requests, savedProject: info.project }, null, 2));
  console.log(`PASS: exact spray/board cells, native filter, scoped destinations, edited draft withholding, restoration, Save/Load and detach. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
