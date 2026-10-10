const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing, viewRegisterItem } = require('./viewer_helpers.cjs');
// Real pointer/keyboard area workflow on synthetic drawings and a disposable server.
const { chromium, expect } = require('@playwright/test');
const { editSettings, settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `areas-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [];
const registerExports = [];
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); }
async function exportArea(record, format) {
  // View already waits for navigation. Check readiness again at each export:
  // later rendering can start before a separate public API invocation.
  await settingsSettled(page); await idle();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const extension = format.toLowerCase();
  const pendingResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith(`/export/${extension}`));
  const pendingDownload = page.waitForEvent('download');
  pendingResponse.catch(() => {}); pendingDownload.catch(() => {});
  // Snapshot, exact selection and the original export call share one browser
  // turn; readiness cannot go stale between their checks and the request.
  const invocationHandle = await page.waitForFunction(({ id, extension }) => {
    const api = window.CeasefireTakeoffs;
    const workspaceBusy = document.querySelector('#takeoffs-workspace').getAttribute('aria-busy') === 'true';
    const openDialogs = document.querySelectorAll('dialog[open]').length;
    const sessionId = api.sessionId();
    if (workspaceBusy || openDialogs || api.hasPendingOperation() || !sessionId) return false;
    const snapshot = api.projectSnapshot();
    const selectedIds = [...document.querySelectorAll('#takeoffs-workspace tr[data-item-id] input[aria-label^="Select "]:checked')]
      .map(control => control.closest('tr').dataset.itemId);
    const item = snapshot?.items.find(value => value.id === id);
    if (selectedIds.length !== 1 || selectedIds[0] !== id || !item?.confirmation) {
      throw new Error('The selected confirmed surface must be settled before exporting.');
    }
    const evidence = { sessionId, workspaceBusy, openDialogs, selectedIds, item };
    return api.exportRegister(extension).then(() => evidence);
  }, { id: record.id, extension });
  let invocation;
  try { invocation = await invocationHandle.jsonValue(); } finally { await invocationHandle.dispose(); }
  assert.equal(invocation.item.mode, record.mode);
  assert.deepEqual(invocation.item.geometry, record.geometry);
  assert.equal(invocation.item.fields.layers, 3);
  const response = await pendingResponse;
  assert.equal(response.status(), 200, response.status() === 200 ? `${format} export response` : await response.text());
  assert.deepEqual(response.request().postDataJSON(), { selected_ids: [record.id] });
  assert.ok(new URL(response.url()).pathname.endsWith(`/sessions/${invocation.sessionId}/export/${extension}`));
  const file = await pendingDownload;
  assert.equal(await file.failure(), null);
  const target = path.join(output, `${record.mode}-${file.suggestedFilename()}`);
  await file.saveAs(target); assert.ok(fs.statSync(target).size > 100);
  const after = await page.evaluate(id => window.CeasefireTakeoffs.projectSnapshot().items.find(item => item.id === id), record.id);
  assert.deepEqual(after, invocation.item, 'Export preserves the surface geometry, layers, receipt and identity');
  registerExports.push({ format, target, status: response.status(), invocation });
  return target;
}
async function command(action, op) {
  const pending = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.op === op);
  pending.catch(() => {}); await action(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result)); await idle(); return result;
}
async function dialog(title, values, submit) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible({timeout:30000});
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: submit, exact: true }).click();
  // The native close event clears the in-progress review asynchronously.
  // Wait for that cleanup before taking a synchronous project snapshot.
  await expect(page.locator('dialog.takeoff-dialog')).toHaveCount(0);
}
async function fit() { await idle(); await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click()); }
async function draw(points, rotated = false, doubleFinish = false) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  // Draw at enough CSS pixels per source unit that mouse-event quantization
  // cannot overwhelm the nominal-area tolerance, including on the rotated page.
  for (let step = 0; step < 10 && (await overlay.boundingBox()).width / (rotated ? 540 : 842) < 1.5; step++) await renderDrawing(page, () => page.getByRole('button', { name: '+', exact: true }).click());
  await page.locator('.takeoff-viewport').evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  for (const [index, [x, y]] of points.entries()) {
    const [u, v] = rotated ? [(y - 30) / 540, (x - 20) / 780] : [x / 842, 1 - y / 595];
    await page.locator('.takeoff-viewport').evaluate((frame, [u, v]) => {
      const paper = frame.querySelector('.takeoff-overlay').getBoundingClientRect(), bounds = frame.getBoundingClientRect();
      frame.scrollLeft += paper.left + u * paper.width - (bounds.left + frame.clientWidth / 2);
      frame.scrollTop += paper.top + v * paper.height - (bounds.top + frame.clientHeight / 2);
    }, [u, v]);
    const box = await overlay.boundingBox(); assert.ok(box && box.width > 0);
    // Keep the subpixel coordinates at fitted zoom; rounding each calibration
    // endpoint independently can bias the squared area conversion.
    const client = [box.x + u * box.width, box.y + v * box.height];
    if (doubleFinish && index === points.length - 1) await page.mouse.dblclick(...client);
    else await page.mouse.click(...client);
  }
}
async function edit(values) { return editSettings(page, values); }
async function confirm() {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items');
}
function checkArea(state, id, expected = 56) {
  const value = state.item_results.find(item => item.id === id);
  const item = state.snapshot.items.find(item => item.id === id), calibration = state.snapshot.calibrations.find(value => value.id === item.measurement.calibration_id);
  const area = points => Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0)) / 2;
  const scale = calibration.distance_m / Math.hypot(calibration.points[1][0] - calibration.points[0][0], calibration.points[1][1] - calibration.points[0][1]);
  const gross = area(item.geometry.points) * scale ** 2, excluded = item.geometry.exclusions.reduce((sum, hole) => sum + area(hole.points) * scale ** 2, 0);
  assert.ok(Math.abs(value.gross_area_m2 - gross) < 1e-8, 'Gross area retains the full precision of the source vertices and calibration');
  assert.ok(Math.abs(value.excluded_area_m2 - excluded) < 1e-8, 'Excluded area retains the full precision of its source vertices');
  assert.ok(Math.abs(value.net_area_m2 - (gross - excluded)) < 1e-8, 'Net area subtracts the retained source exclusions');
  assert.ok(Math.abs(value.net_area_m2 - expected) < .2, JSON.stringify(value));
  assert.ok(Math.abs(value.gross_area_m2 - 60) < .2, JSON.stringify(value));
  assert.equal(value.layers,item.fields.layers);assert.equal(value.total_area_m2,value.net_area_m2*item.fields.layers);
  assert.equal(Object.hasOwn(value, 'length_m'), false);
  return value;
}
async function surface(mode, rotated = false) {
  await chooseTakeoff(page, mode);
  if (await page.getByRole('button', { name: 'Close settings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await fit();
  await expect(page.getByRole('button', { name: 'Preview transfer', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Cite length', exact: true })).toBeHidden();
  if (!await page.getByRole('button', { name: 'Calibrate', exact: true }).isVisible()) await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100, 75], [500, 75]], rotated);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': `${mode} baseline`, 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace surface', exact: true }).click();
  await draw([[100, 200], [500, 200], [500, 440], [100, 440]], rotated, true);
  const creation=page.getByRole('dialog');await expect(creation.getByRole('heading',{name:'Add surface',exact:true})).toBeVisible();
  await expect(creation.getByLabel('Surface Type',{exact:true})).toHaveCount(1);await expect(creation.getByLabel('Number of layers',{exact:true})).toHaveAttribute('type','number');
  for(const removed of ['Surface basis','Treatment','True-surface source citation','Explicit physical quantity'])await expect(creation.getByLabel(removed,{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('New surface type',{exact:true})).toHaveCount(0);
  let state = await command(() => dialog('Add surface', {
    'Surface Type':mode,'Surface ID':`${mode.toUpperCase()}-01`,
    'Number of layers':3,
    'Level': 'L01', 'Substrate': 'Concrete',
    'Protection system': 'Synthetic evidenced system', 'Protection product': 'Synthetic evidenced product', 'FRL / fire rating': '90/90/90',
  }, 'Add surface'), 'create_item');
  const id = state.snapshot.items.find(item => item.mode === mode).id;
  assert.deepEqual(state.snapshot.items.find(item => item.id === id).fields, {
    mark:`${mode.toUpperCase()}-01`,layers:3,
    level: 'L01', substrate: 'Concrete', system: 'Synthetic evidenced system',
    product: 'Synthetic evidenced product', frl:'90/90/90',
  }, 'Every surface detail entered at creation is retained in the authoritative record');
  assert.equal(state.snapshot.items.find(item => item.id === id).geometry.points.length, 4, 'Polygon double-click preserves exactly four distinct vertices');
  // Adding a hole focuses the object; fit only after entering the exclusion tool.
  await page.getByRole('button', { name: 'Add exclusion', exact: true }).click();
  await fit();
  await draw([[180, 260], [260, 260], [260, 340], [180, 340]], rotated, true);
  state = await command(() => dialog('Add excluded opening', { 'Exclusion source / reason': 'Synthetic 2 x 2 m opening' }, 'Add exclusion'), 'update_item');
  assert.equal(state.snapshot.items.find(item => item.id === id).geometry.exclusions[0].points.length, 4, 'Exclusion double-click preserves exactly four distinct vertices');
  checkArea(state, id);
  state = await edit({ 'Level': 'L02', 'Substrate': 'Concrete', 'FRL / fire rating': '120/120/120' });
  const actions = page.locator('#takeoff-markup-settings .takeoff-settings-tools > .actions');
  await expect(actions.getByRole('button')).toHaveCount(1); await expect(actions.getByRole('button', { name: 'Delete item', exact: true })).toBeVisible();
  assert.equal(state.snapshot.items.find(item => item.id === id).quantity, 1);
  assert.equal(state.snapshot.items.find(item => item.id === id).member_ids.length, 1);
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0);
  state = await confirm();
  const item = state.snapshot.items.find(item => item.id === id);
  assert.equal(item.state, 'confirmed');
  assert.equal(item.confirmation.checks.engine, 'takeoffs-area-v2');assert.equal(item.confirmation.checks.layers,3);assert.equal(item.confirmation.checks.total_area_m2,item.confirmation.checks.net_area_m2*3);
  return { id, mode, metrics: checkArea(state, id), geometry: item.geometry, confirmation: item.confirmation };
}
(async () => {
  const info = await ready;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', e => window.qaCsp.push({ directive: e.effectiveDirective, blocked: e.blockedURI })); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  const calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  const undoParity=await page.evaluate(()=>{
    const undo=document.querySelector('.takeoff-workspace-split .takeoff-register [aria-label="Undo last edit"]'),reference=document.querySelector('#penetration-undo');
    const style=control=>Object.fromEntries(['display','alignItems','justifyItems','width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopColor','borderTopLeftRadius','color','backgroundColor','fontSize','fontWeight','boxShadow'].map(key=>[key,getComputedStyle(control)[key]]));
    const glyph=control=>Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','color'].map(key=>[key,getComputedStyle(control.querySelector('.button-symbol'))[key]]));
    return {undo:style(undo),reference:style(reference),glyph:glyph(undo),referenceGlyph:glyph(reference),text:undo.querySelector('.button-symbol').textContent};
  });assert.deepEqual(undoParity.undo,undoParity.reference);assert.deepEqual(undoParity.glyph,undoParity.referenceGlyph);assert.equal(undoParity.text,'↶');
  await page.locator('#takeoff-upload').setInputFiles(info.area_fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  const wall = await surface('wall');
  // Source-coordinate editing retains the exclusion ID and invalidates approval.
  await page.getByRole('button', { name: 'Edit exclusion', exact: true }).click();
  let state = await command(() => dialog('Edit excluded opening', { 'Source vertices (x, y per line)': '180, 260\n260, 260\n260, 300\n180, 300' }, 'Apply geometry'), 'update_item');
  checkArea(state, wall.id, 58);
  assert.equal(state.snapshot.items.find(item => item.id === wall.id).confirmation, null);
  assert.equal(state.snapshot.items.find(item => item.id === wall.id).geometry.exclusions[0].id, wall.geometry.exclusions[0].id);
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.deepEqual(state.snapshot.items.find(item => item.id === wall.id).geometry, wall.geometry);
  await page.locator(`tr[data-item-id="${wall.id}"] .takeoff-row-link`).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  state = await command(() => dialog('Delete 1 objects?', {}, 'Delete objects'), 'delete_items');
  assert.equal(state.snapshot.items.some(item => item.id === wall.id), false);
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.deepEqual(state.snapshot.items.find(item => item.id === wall.id).geometry, wall.geometry);
  await page.locator(`tr[data-item-id="${wall.id}"] .takeoff-row-link`).click();
  // Abandoning an exclusion must not attach a later new-surface gesture to its old target.
  await expect(page.getByRole('button', { name: 'Re-trace geometry', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add exclusion', exact: true }).click();
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'exclusion');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await fit();
  await page.getByRole('button', { name: 'Trace surface', exact: true }).click();
  await draw([[300, 300], [400, 300], [400, 400]]);
  await page.locator('.takeoff-viewport').press('Enter');
  await dialog('Add surface', {}, 'Cancel');
  await page.locator('.takeoff-viewport').press('Escape');
  assert.deepEqual(await page.evaluate(id => window.CeasefireTakeoffs.projectSnapshot().items.find(item => item.id === id).geometry, wall.id), wall.geometry);
  // A bulk edit invalidates confirmation; one undo restores identities and evidence.
  await page.getByLabel('Bulk edit field', { exact: true }).selectOption('level');
  await page.getByLabel('Bulk edit value', { exact: true }).fill('L03');
  await page.getByRole('button', { name: 'Apply to selected', exact: true }).click();
  state = await command(() => dialog('Change 1 items?', {}, 'Apply bulk change'), 'bulk_update');
  assert.equal(state.snapshot.items.find(item => item.id === wall.id).confirmation, null);
  state = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo');
  assert.equal(state.snapshot.items.find(item => item.id === wall.id).fields.level, 'L02');
  assert.deepEqual(state.snapshot.items.find(item => item.id === wall.id).geometry, wall.geometry);
  await page.getByLabel('Filter register', { exact: true }).fill('WALL-01');
  for (const label of ['Filter confirmation state', 'Sort register', 'Group register']) await expect(page.getByLabel(label, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Filter Level', exact: true }).click();
  let filterDialog = page.locator('.takeoff-column-filter'); await filterDialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck();
  await filterDialog.getByRole('button', { name: 'Apply filter', exact: true }).click(); await filterDialog.waitFor({ state: 'detached' });
  await expect(page.locator(`tr[data-item-id="${wall.id}"]`)).toHaveCount(0);
  assert.deepEqual(await page.evaluate(id => window.CeasefireTakeoffs.projectSnapshot().items.find(item => item.id === id).geometry, wall.id), wall.geometry);
  await page.getByRole('button', { name: 'Filter Level', exact: true }).click(); filterDialog = page.locator('.takeoff-column-filter');
  await filterDialog.getByRole('checkbox', { name: 'L02', exact: true }).check();
  await filterDialog.getByRole('button', { name: 'Apply filter', exact: true }).click(); await filterDialog.waitFor({ state: 'detached' });
  await page.locator(`tr[data-item-id="${wall.id}"]`).hover();
  await expect(page.locator('.takeoff-markup.hovered')).toHaveCount(1);
  await page.getByLabel('Hide WALL-01 on drawing', { exact: true }).check();
  await expect(page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`)).toHaveCount(0);
  await page.getByLabel('Hide WALL-01 on drawing', { exact: true }).uncheck();
  // SVG focus/hover uses the same persistent row identity after column filtering.
  await page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`).hover({ position: { x: 25, y: 25 } });
  await expect(page.locator(`tr[data-item-id="${wall.id}"]`)).toHaveClass(/hovered/);
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Filter Level', exact: true }).click(); filterDialog = page.locator('.takeoff-column-filter');
  await filterDialog.getByRole('button', { name: 'Reset filter', exact: true }).click(); await filterDialog.waitFor({ state: 'detached' });
  await confirm();
  await page.screenshot({ path: path.join(output, 'wall-confirmed.png'), fullPage: true });
  await command(() => page.getByRole('button', { name: 'Page ›', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue('');
  const slab = await surface('slab', true);
  // Row navigation recovers exact document/page and shape after changing modes/pages.
  await chooseTakeoff(page, 'wall');
  await viewRegisterItem(page, wall.id, wall.geometry);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await expect(page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`)).toHaveCount(1);
  await chooseTakeoff(page, 'slab');
  await viewRegisterItem(page, slab.id, slab.geometry);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
  await page.screenshot({ path: path.join(output, 'slab-rotated-confirmed.png'), fullPage: true });
  const save = page.waitForResponse(r => r.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page, 'Save');
  assert.equal((await save).status(), 200);
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project));
  assert.equal(saved.version, 2); assert.equal(saved.takeoffs.items.length, 2);assert.ok(saved.takeoffs.items.every(item=>item.fields.layers===3&&item.quantity===1&&item.member_ids.length===1));
  const load = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await clickProjectControl(page, 'Load'); assert.equal((await load).status(), 200);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  for (const record of [wall, slab]) {
    const mode = record === wall ? 'wall' : 'slab';
    await chooseTakeoff(page, mode);
    await viewRegisterItem(page, record.id, record.geometry);
    await expect(page.locator(`tr[data-item-id="${record.id}"] .takeoff-state`)).toHaveText('Confirmed');
    for (const format of ['CSV', 'XLSX']) {
      const target = await exportArea(record, format);
      if (format === 'CSV') { const text = fs.readFileSync(target, 'utf8'); assert.ok(text.includes(record.id)); assert.ok(text.includes('net_area_m2'));assert.ok(text.includes('total_area_m2'));assert.ok(text.includes('layers')); }
    }
  }
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  assert.equal(registerExports.length, 4);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed:true,wall,slab,undoParity,registerExports,errors,csp:[] }, null, 2));
  console.log(`PASS: true-surface wall/slab areas, exclusions, rotated CropBox/UserUnit2/DPR2, bulk/undo, selection, confirmation, Save As/reopen, CSV/XLSX; calculators unchanged. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
