const { chooseTakeoff } = require('./section_navigation.cjs');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Rendered acceptance journey against a disposable production server and synthetic PDF.
const { chromium, expect } = require('@playwright/test');
const { openItemSettings, editSettings, settingsSettled } = require('./settings_helpers.cjs');
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
  pending.catch(() => {}); await action(); const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); await workspaceIdle(); return body;
}
async function dialog(title, values, button) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible({timeout:30000});
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
async function fillInspector(values) { return editSettings(page, values); }
// Historical cited measurements remain supported when an existing project is
// opened. The removed conversion button is not a route for creating new ones.
// Seed this compatibility fixture through the validated API, then exercise the
// real editor, confirmation and transfer UI on the resulting retained record.
async function retainedCitedFixture(itemId, length, citation) {
  await expect(page.getByRole('button',{name:'Change length basis',exact:true})).toHaveCount(0);
  const result = await page.evaluate(async ({itemId,length,citation})=>{
    const takeoffs=window.CeasefireTakeoffs, session=takeoffs.sessionId(), snapshot=takeoffs.projectSnapshot();
    const response=await fetch(`/api/takeoffs/sessions/${session}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:snapshot.revision,request_id:crypto.randomUUID(),op:'update_item',item_id:itemId,changes:{measurement:{method:'cited',length_m:length,citation}}})});
    const result=await response.json(); if(!response.ok)throw new Error(JSON.stringify(result));
    const prepared=await takeoffs.prepareProject(result.snapshot,session); takeoffs.applyProject(prepared); await takeoffs.showSource(itemId); return result;
  },{itemId,length,citation});
  await workspaceIdle(); return result;
}
async function reviewConfirm() {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items');
}
async function transfer(update = false, expectedNote = null, expectedDetails = []) {
  const pending = page.waitForResponse(r => r.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: update ? 'Update linked rows' : 'Preview transfer', exact: true }).click();
  const response = await pending; const preview = await response.json();
  fs.writeFileSync(path.join(output, `transfer-${Date.now()}.json`), JSON.stringify({ request: response.request().postDataJSON(), response: preview }, null, 2));
  assert.equal(response.status(), 200, JSON.stringify(preview));
  if (expectedNote) await expect(page.getByRole('dialog')).toContainText(expectedNote);
  for (const detail of expectedDetails) await expect(page.getByRole('dialog')).toContainText(detail);
  const applied = page.waitForResponse(r => r.url().endsWith('/transfer-apply'));
  await dialog(`${update ? 'Update' : 'Transfer'} 1 confirmed items?`, {}, update ? 'Update linked rows' : 'Add to schedule');
  const result = await applied; const state = await result.json(); assert.equal(result.status(), 200, JSON.stringify(state)); await workspaceIdle();
  return { preview, state };
}
async function skippedTransfer(bindingIds) {
  const before = await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.completeProjectSnapshot() }));
  let applyRequests = 0; const watchApply = request => { if (request.url().endsWith('/transfer-apply')) applyRequests++; };
  page.on('request', watchApply);
  try {
    const pending = page.waitForResponse(response => response.url().endsWith('/transfer-preview'));
    await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
    const response = await pending, preview = await response.json(); assert.equal(response.status(), 200, JSON.stringify(preview));
    assert.deepEqual(preview.changes, []); assert.deepEqual(preview.skipped.map(item => item.binding_id).sort(), [...bindingIds].sort());
    assert.ok(preview.skipped.every(item => item.reason === 'already_linked'));
    await expect(page.locator('#takeoffs-workspace [role="status"]').filter({ hasText: 'already linked to' })).toContainText('No rows were added or changed');
    await expect(page.getByRole('dialog')).toHaveCount(0); assert.equal(applyRequests, 0);
    const after = await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.completeProjectSnapshot() }));
    assert.deepEqual(after, before, 'Repeated Add skips linked items without changing either source or calculator state');
    fs.writeFileSync(path.join(output, `skipped-transfer-${Date.now()}.json`), JSON.stringify({ preview, applyRequests, unchanged: true }, null, 2));
    return { preview, state: { snapshot: after.takeoffs } };
  } finally { page.off('request', watchApply); }
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
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
}
async function boardJourney(info) {
  const initial = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await chooseTakeoff(page, 'steel');
  await page.locator('#takeoff-upload').setInputFiles(info.board_fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(2, { timeout: 60000 });
  await page.getByLabel('Drawing document', { exact: true }).selectOption(await page.locator('.takeoff-document').filter({ hasText: 'synthetic-board.pdf' }).getAttribute('value'));
  await fitCurrentDrawing('synthetic-board.pdf');
  await page.getByLabel('Destination schedule', { exact: true }).selectOption('steel_board');
  if (!await page.getByRole('button', { name: 'Calibrate', exact: true }).isVisible()) await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100 / 842, 1 - 75 / 595], [500 / 842, 1 - 75 / 595]]);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': 'Synthetic board baseline', 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 400 / 595], [500 / 842, 1 - 400 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  let state = await command(() => dialog('Add steel object', { 'Member mark': 'BOARD-MEASURED', 'Count/QTY': 2 }, 'Add item'), 'create_item');
  const measuredId = state.snapshot.items.find(item => item.fields.mark === 'BOARD-MEASURED').id;
  await openItemSettings(page,measuredId);
  // The exact profile is selected using the same catalog dialog available to operators.
  await page.getByRole('button', { name: 'Find steel section', exact: true }).click();
  const profileResponse = page.waitForResponse(response => response.url().includes('/profiles?calculator=steel_board'));
  await dialog('Find steel section', { 'Section designation': '100UC15' }, 'Search');
  const profiles = await (await profileResponse).json();
  assert.deepEqual(profiles.items, [{ id: '100UC15', label: '100UC15' }]);
  await dialog('Choose a database section', { 'Steel section': '100UC15' }, 'Use section');
  const supported = { 'Level': 'SYNTHETIC', 'Member type': 'Beam', 'Product': 'TRAFALGAR COREX', 'Fire period (min)': 120, 'Exposed sides': 3, 'Crit. Temp (\u00b0C)': 620, 'Exposure': 'Re-entrant - 3 sides' };
  state = await fillInspector(supported);
  const temperature = page.locator('#takeoff-markup-settings').getByLabel('Crit. Temp (\u00b0C)', {exact:true});
  assert.equal(await temperature.evaluate(control=>control.tagName),'SELECT');
  await expect(temperature).toHaveValue('620');
  assert.ok((await temperature.locator('option').evaluateAll(options=>options.map(option=>option.value))).includes('620'));
  const measured = state.item_results.find(item => item.id === measuredId);
  assert.ok(Math.abs(measured.length_m - 10) < 0.02); assert.equal(measured.total_length_m, measured.length_m * 2);
  assert.equal(state.snapshot.items.find(item => item.id === measuredId).member_ids.length, 2);
  await reviewConfirm(); let transferred = await transfer(false, 'CLADDING ESTIMATE', ['Physical quantity: 2', `Per-member length: ${measured.length_m.toFixed(2)} m`, `Total length: ${measured.total_length_m.toFixed(2)} m`, `Lineal metres: ${measured.total_length_m.toFixed(2)}`]);
  const measuredBinding = transferred.state.snapshot.transfers.find(binding => binding.item_id === measuredId);
  assert.equal(measuredBinding.calculator_id, 'steel_board');
  assert.equal(transferred.preview.inputs[measuredBinding.sheet]['F' + measuredBinding.row], measured.total_length_m);
  assert.equal(transferred.preview.inputs[measuredBinding.sheet]['D' + measuredBinding.row], '100UC15');
  transferred = await skippedTransfer([measuredBinding.id]);
  assert.equal(transferred.state.snapshot.transfers.find(binding => binding.item_id === measuredId).id, measuredBinding.id);
  transferred = await transfer(true); assert.equal(transferred.preview.changes[0].action, 'unchanged');
  assert.equal(transferred.state.snapshot.transfers.find(binding => binding.item_id === measuredId).id, measuredBinding.id);
  await fitCurrentDrawing('synthetic-board.pdf');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 300 / 595], [730 / 842, 1 - 270 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  state = await command(() => dialog('Add steel object', { 'Member mark': 'BOARD-CITED', 'Count/QTY': 3 }, 'Add item'), 'create_item');
  state = await retainedCitedFixture(state.snapshot.items.find(item=>item.fields.mark==='BOARD-CITED').id,7.25,'Synthetic board drawing p1, BOARD-CITED: 3 separate physical members, 7.25 m EACH');
  const citedId = state.snapshot.items.find(item => item.fields.mark === 'BOARD-CITED').id;
  state = await fillInspector({ ...supported, 'Steel section': '100UC15' });
  assert.equal(state.item_results.find(item => item.id === citedId).total_length_m, 21.75);
  assert.equal(state.snapshot.items.find(item => item.id === citedId).member_ids.length, 3);
  await reviewConfirm(); transferred = await transfer(false, 'CLADDING ESTIMATE', ['Physical quantity: 3', 'Per-member length: 7.25 m', 'Total length: 21.75 m', 'Lineal metres: 21.75']);
  const citedBinding = transferred.state.snapshot.transfers.find(binding => binding.item_id === citedId);
  assert.equal(transferred.preview.inputs[citedBinding.sheet]['F' + citedBinding.row], 21.75);
  transferred = await skippedTransfer([citedBinding.id]);
  assert.equal(transferred.state.snapshot.transfers.filter(binding => binding.calculator_id === 'steel_board').length, 2);
  assert.equal(transferred.state.snapshot.transfers.find(binding => binding.item_id === citedId).id, citedBinding.id);
  const after = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  for (const [id, calculator] of Object.entries(initial)) {
    if (id !== 'steel_board') assert.deepEqual(after[id], calculator, `${id} inputs unchanged`);
    else for (const [sheet, cells] of Object.entries(calculator.inputs)) {
      if (sheet !== measuredBinding.sheet) assert.deepEqual(after[id].inputs[sheet], cells, `${sheet} settings unchanged`);
      else for (const [address, value] of Object.entries(cells)) {
        if (![measuredBinding.row, citedBinding.row].includes(Number(address.match(/\d+$/)[0]))) assert.deepEqual(after[id].inputs[sheet][address], value, `unrelated ${address} unchanged`);
      }
    }
  }
  await page.locator('.nav-button[data-view="calculators"]').click();
  await chooseCalculator(page, 'Steel (board)');
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  const source = page.getByRole('button', { name: `Open takeoff ${citedId}`, exact: true });
  await expect(source).toBeVisible({ timeout: 60000 });
  await expect(page.locator(`[data-calculator-sheet="CALCULATOR"][data-calculator-cell="A${citedBinding.row}"]`)).toHaveValue('BOARD-CITED');
  await expect(page.locator(`[data-calculator-sheet="CALCULATOR"][data-calculator-cell="F${citedBinding.row}"]`)).toHaveValue('21.75');
  await screenshot('confirmed-board-schedule.png');
  await source.click();
  await expect(page.locator(`tr[data-item-id="${citedId}"]`).getByRole('checkbox',{name:/^Select /})).toBeChecked();
  await openItemSettings(page,citedId);
  await expect(page.locator('.takeoff-markup.selected')).toHaveCount(1);
  await expect(page.locator('.takeoff-calibration-summary')).toContainText('7.25');
  await expect(page.locator('.takeoff-calibration-summary')).toContainText('Synthetic board drawing');
  await screenshot('board-source-return.png');
  // A separately drawn unsupported combination must fail without changing requirements or schedules.
  await fitCurrentDrawing('synthetic-board.pdf');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 193 / 595], [790 / 842, 1 - 148 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  state = await command(() => dialog('Add steel object', { 'Member mark': 'BOARD-UNSUPPORTED', 'Count/QTY': 1 }, 'Add item'), 'create_item');
  state = await retainedCitedFixture(state.snapshot.items.find(item=>item.fields.mark==='BOARD-UNSUPPORTED').id,10,'Synthetic board drawing p1, BOARD-UNSUPPORTED: explicitly 120 min beam at 550 C; do not substitute a design');
  const unsupportedId = state.snapshot.items.find(item => item.fields.mark === 'BOARD-UNSUPPORTED').id;
  await fillInspector({...supported,'Steel section':'100UC15'});
  // A historical project can retain an unsupported value even though new edits
  // now offer only calculator-backed choices. Seed that saved-record condition.
  await page.evaluate(async itemId=>{
    const takeoffs=window.CeasefireTakeoffs,session=takeoffs.sessionId(),snapshot=takeoffs.projectSnapshot();
    const response=await fetch(`/api/takeoffs/sessions/${session}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:snapshot.revision,request_id:crypto.randomUUID(),op:'update_item',item_id:itemId,changes:{fields:{critical_temperature:550}}})});
    const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
    takeoffs.applyProject(await takeoffs.prepareProject(result.snapshot,session));await takeoffs.showSource(itemId);
  },unsupportedId);
  const retainedSettings=await openItemSettings(page,unsupportedId),retainedTemperature=retainedSettings.getByLabel('Crit. Temp (\u00b0C)',{exact:true});
  await expect(retainedTemperature).toHaveValue('550');await expect(retainedTemperature.locator('option[value="550"]')).toContainText('retained');
  await reviewConfirm();
  const beforeRejection = await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.projectSnapshot() }));
  const failedPreview = page.waitForResponse(response => response.url().endsWith('/transfer-preview'));
  await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
  const rejected = await failedPreview, rejection = await rejected.json();
  assert.equal(rejected.status(), 400, JSON.stringify(rejection)); assert.match(rejection.error, /NO BOARD DESIGN/i);
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('NO BOARD DESIGN');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const afterRejection = await page.evaluate(() => ({ takeoffs: window.CeasefireTakeoffs.projectSnapshot(), calculators: window.CeasefireCalculators.projectSnapshot() }));
  assert.deepEqual(afterRejection, beforeRejection, 'Rejected native design changes neither evidence nor calculator inputs');
  await screenshot('unsupported-board-blocked.png');
  return { measuredId, citedId, unsupportedId, measured, citedTotal: 21.75, rejection, bindings: transferred.state.snapshot.transfers.filter(binding => binding.calculator_id === 'steel_board') };
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
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  await expect(page.getByRole('button', { name: 'Upload PDFs', exact: true })).toBeVisible();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  await workspaceIdle();
  if (!await page.getByRole('button', { name: 'Calibrate', exact: true }).isVisible()) await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100 / 842, 1 - 75 / 595], [500 / 842, 1 - 75 / 595]]);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': 'Ten metre baseline', 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 400 / 595], [500 / 842, 1 - 400 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  let state = await command(() => dialog('Add steel object', { 'Member mark': 'B17', 'Count/QTY': 2 }, 'Add item'), 'create_item');
  const steelId = state.snapshot.items[0].id;
  assert.ok(Math.abs(state.item_results[0].length_m - 10) < 0.02);
  state = await fillInspector({ 'Level': 'L02', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Crit. Temp (\u00b0C)': 550, 'Exposure': 'Re-entrant - 3 sides' });
  // Bulk editing is one atomic operation, and undo restores the same identities.
  await page.getByLabel('Bulk edit field', { exact: true }).selectOption('level');
  await page.getByLabel('Bulk edit value', { exact: true }).fill('L03');
  await page.getByRole('button', { name: 'Apply to selected', exact: true }).click();
  await command(() => dialog('Change 1 items?', {}, 'Apply bulk change'), 'bulk_update');
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.equal(state.snapshot.items[0].id, steelId); assert.equal(state.snapshot.items[0].fields.level, 'L02');
  await page.getByLabel('Filter register', { exact: true }).fill('B17');
  for (const label of ['Filter confirmation state', 'Sort register', 'Group register']) await expect(page.getByLabel(label, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Filter Level', exact: true }).click();
  await page.locator('.takeoff-column-filter').getByRole('button', { name: 'Apply filter', exact: true }).click();
  await page.locator('.takeoff-column-filter').waitFor({ state: 'detached' });
  await expect(page.locator(`tr[data-item-id="${steelId}"]`)).toHaveCount(1);
  await page.locator(`tr[data-item-id="${steelId}"]`).hover();
  await expect(page.locator('.takeoff-markup.hovered')).toHaveCount(1);
  await page.getByLabel('Hide B17 on drawing', { exact: true }).check();
  await expect(page.locator(`.takeoff-hit[data-item-id="${steelId}"]`)).toHaveCount(0);
  await page.getByLabel('Hide B17 on drawing', { exact: true }).uncheck();
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await reviewConfirm();
  let transferred = await transfer();
  assert.equal(transferred.preview.inputs.SCHEDULE.I10, 2); assert.ok(Math.abs(transferred.preview.inputs.SCHEDULE.J10 - 10) < 0.02);
  const firstBinding = transferred.state.snapshot.transfers[0];
  transferred = await skippedTransfer([firstBinding.id]);
  assert.equal(transferred.state.snapshot.transfers.length, 1); assert.equal(transferred.state.snapshot.transfers[0].id, firstBinding.id);
  // Reconfirming an explicit source edit allows a reviewed linked-row update.
  await fillInspector({ 'Count/QTY': 3 }); await reviewConfirm();
  transferred = await transfer(true); assert.equal(transferred.preview.inputs.SCHEDULE.I10, 3);
  await screenshot('confirmed-steel.png');
  await chooseTakeoff(page, 'duct');
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 245 / 595], [600 / 842, 1 - 220 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  const ductCreation=page.getByRole('dialog');
  const ductValues={'Item':'D-001','Level':'L02','WxH (mm)':'600x400','Product':'FyreWrap','Exposure':'Internal','FRL':'120/120/120','Orientation':'Horizontal','Wall penetrations':0,'Floor penetrations':0,'Count/QTY':1};
  for(const label of Object.keys(ductValues))await expect(ductCreation.getByLabel(label,{exact:true})).toBeVisible();
  for(const label of ['Product','Exposure','FRL'])assert.equal(await ductCreation.getByLabel(label,{exact:true}).evaluate(el=>el.tagName),'SELECT');
  for(const label of ['Run ID','Width (mm)','Height (mm)','Mechanical system','Duct application / exposure'])await expect(ductCreation.getByLabel(label,{exact:true})).toHaveCount(0);
  await ductCreation.screenshot({path:path.join(output,'duct-creation-details.png')});
  state = await command(() => dialog('Add duct object', ductValues, 'Add item'), 'create_item');
  const createdDuct=state.snapshot.items.find(item=>item.fields.mark==='D-001');assert.equal(createdDuct.fields.width_mm,600);assert.equal(createdDuct.fields.height_mm,400);assert.equal(createdDuct.fields.product,'FyreWrap');assert.equal(createdDuct.fields.exposure,'Internal');assert.equal(createdDuct.fields.frl,'120/120/120');

  state = await retainedCitedFixture(state.snapshot.items.find(item=>item.fields.mark==='D-001').id,10,'Synthetic duct schedule D-001, page 1: 10.0 m');
  const ductId = state.snapshot.items.find(i => i.mode === 'duct').id;
  const ductSettings=await openItemSettings(page,ductId),beforeBadSize=await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());
  const badSizeRequests=[];const watchSize=request=>{if(request.url().endsWith('/commands')&&request.postDataJSON()?.op==='bulk_update')badSizeRequests.push(request.postDataJSON());};page.on('request',watchSize);
  await ductSettings.getByLabel('WxH (mm)',{exact:true}).fill('600x');await ductSettings.getByLabel('WxH (mm)',{exact:true}).press('Tab');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText(/width|height|WxH/i);
  assert.deepEqual(badSizeRequests,[],'Invalid compound size issues no partial dimension update');
  const retainedState=await page.request.get(await page.evaluate(()=>`${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`));assert.deepEqual((await retainedState.json()).snapshot.items,beforeBadSize.items);
  page.off('request',watchSize);await editSettings(page,{'WxH (mm)':'600x400'});
  await ductSettings.screenshot({path:path.join(output,'duct-settings-details.png')});
  await reviewConfirm(); transferred = await transfer();
  assert.equal(transferred.preview.inputs.CALCULATOR.B11, '600x400'); assert.equal(transferred.preview.inputs.CALCULATOR.D11, 10);
  // Real split/merge and recoverable deletion preserve source lineage and selection.
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await draw([[100 / 842, 1 - 190 / 595], [500 / 842, 1 - 190 / 595]]);
  await page.locator('.takeoff-viewport').press('Enter');
  let extra = await command(() => dialog('Add duct object', { 'Item': 'QA-SPLIT', 'Count/QTY': 1 }, 'Add item'), 'create_item');
  const originalRun = extra.snapshot.items.find(i => i.fields.mark === 'QA-SPLIT').id;
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  extra = await command(() => dialog('Split this physical run', { 'Split position (% of traced length)': 50 }, 'Split run'), 'split_item');
  const splitRuns = extra.snapshot.items.filter(i => i.predecessor_ids.includes(originalRun)); assert.equal(splitRuns.length, 2);
  await page.getByLabel('Filter register', { exact: true }).fill('QA-SPLIT');
  await page.getByRole('checkbox', { name: 'Select all matching items', exact: true }).check();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  extra = await command(() => dialog('Merge one physical object?', {}, 'Merge segments'), 'merge_items');
  const mergedRun = extra.snapshot.items.find(i => i.fields.mark === 'QA-SPLIT'); assert.deepEqual(new Set(mergedRun.predecessor_ids), new Set([originalRun, ...splitRuns.map(i => i.id)]));
  await page.locator(`tr[data-item-id=\"${mergedRun.id}\"] .takeoff-row-link`).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await command(() => dialog('Delete 1 objects?', {}, 'Delete objects'), 'delete_items');
  // Duct has no redundant Undo toolbar button. The shared workspace history
  // remains accessible from Steel and restores the exact deleted identity.
  await chooseTakeoff(page, 'steel');
  extra = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.ok(extra.snapshot.items.some(i => i.id === mergedRun.id));
  await chooseTakeoff(page, 'duct');
  await page.locator(`tr[data-item-id=\"${mergedRun.id}\"] .takeoff-row-link`).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await command(() => dialog('Delete 1 objects?', {}, 'Delete objects'), 'delete_items');
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.locator(`tr[data-item-id=\"${ductId}\"] .takeoff-row-link`).click();
  await screenshot('confirmed-duct.png');
  const board = await boardJourney(info);
  await chooseTakeoff(page, 'duct');
  await page.locator(`tr[data-item-id=\"${ductId}\"] .takeoff-row-link`).click();
  // Project Save As commits the companion bundle before the complete JSON.
  const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page, 'Save As');
  const saved = await savedResponse; assert.equal(saved.status(), 200, await saved.text());
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const savedJson = JSON.parse(fs.readFileSync(info.project));
  assert.equal(savedJson.version, 2); assert.equal(savedJson.takeoffs.items.length, 5);
  assert.equal(savedJson.takeoffs.transfers.filter(binding => binding.calculator_id === 'steel_board').length, 2);
  assert.ok(fs.existsSync(path.join(output, savedJson.takeoffs.companion_folder)));
  const loadedResponse = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await clickProjectControl(page, 'Load');
  const loaded = await loadedResponse; assert.equal(loaded.status(), 200, await loaded.text());
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await chooseTakeoff(page, 'duct');
  await page.locator(`tr[data-item-id=\"${ductId}\"] .takeoff-row-link`).click();
  const reopenedDuct=await openItemSettings(page,ductId);await expect(reopenedDuct.getByLabel('WxH (mm)',{exact:true})).toHaveValue('600 x 400');await expect(reopenedDuct.getByLabel('Product',{exact:true})).toHaveValue('FyreWrap');await expect(reopenedDuct.getByLabel('Exposure',{exact:true})).toHaveValue('Internal');await expect(reopenedDuct.getByLabel('FRL',{exact:true})).toHaveValue('120/120/120');
  for (const format of ['CSV', 'XLSX']) {
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    const file = await download; const target = path.join(output, file.suggestedFilename()); await file.saveAs(target); assert.ok(fs.statSync(target).size > 100);
  }
  // PDF search discloses complete coverage and identifies pages with no text.
  await page.getByLabel('Drawing document', { exact: true }).selectOption(await page.locator('.takeoff-document').filter({ hasText: 'synthetic-drawings.pdf' }).getAttribute('value'));
  await page.getByPlaceholder('Search PDF text…').fill('SYNTHETIC');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.takeoff-progress')).toContainText('4/4 pages inspected', { timeout: 30000 });
  await expect(page.locator('.takeoff-progress')).toContainText('2 without searchable text');
  // A malformed embedded image is not allowed to become an approved blank page.
  await page.locator('#takeoff-upload').setInputFiles(info.failed_fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(3, { timeout: 60000 });
  await page.getByLabel('Drawing document', { exact: true }).selectOption(await page.locator('.takeoff-document').filter({ hasText: 'failed-image.pdf' }).getAttribute('value'));
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('blocked', { timeout: 30000 });
  await page.waitForFunction(() => {
    try { const snapshot = window.CeasefireTakeoffs.projectSnapshot(), document = snapshot.documents.find(doc => doc.name === 'failed-image.pdf');
      return document && snapshot.render_checks.some(check => check.document_id === document.id && !check.success);
    } catch { return false; }
  });
  assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot().items.map(item => item.state)), Array(5).fill('confirmed'));
  await screenshot('failed-content-blocked.png');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, stage: 'save-reopen-export', project: info.project, steelId, ductId, board, errors, requests, violations: await page.evaluate(() => window.qaCsp) }, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  console.log(`PASS: rendered upload, calibration, trace/cite, automatic settings, compound duct dimensions, bulk/undo, confirmation, three calculator destinations, Board native-design rejection, source links, transfer/repeat/update, save/reopen and CSV/XLSX export. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(serverErrors.slice(-6000)); console.error(JSON.stringify(requests.slice(-10)));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { ending = true; fs.writeFileSync(path.join(output, 'server.log'), serverErrors); if (browser) await browser.close(); server.kill(); });
