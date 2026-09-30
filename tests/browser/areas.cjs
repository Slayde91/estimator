// Real pointer/keyboard area workflow on synthetic drawings and a disposable server.
const { chromium, expect } = require('@playwright/test');
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
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); }
async function command(action, op) {
  const pending = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.op === op);
  await action(); const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result)); await idle(); return result;
}
async function dialog(title, values, submit) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: submit, exact: true }).click();
}
async function fit() { await idle(); await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render'); }
async function draw(points, rotated = false, doubleFinish = false) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox(); assert.ok(box && box.width > 0);
  for (const [index, [x, y]] of points.entries()) {
    const [u, v] = rotated ? [(y - 30) / 540, (x - 20) / 780] : [x / 842, 1 - y / 595];
    if (doubleFinish && index === points.length - 1) await page.mouse.dblclick(box.x + u * box.width, box.y + v * box.height);
    else await page.mouse.click(box.x + u * box.width, box.y + v * box.height);
  }
}
async function edit(values) {
  const panel = page.locator('.takeoff-register-editor');
  for (const [label, value] of Object.entries(values)) {
    const field = panel.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  return command(() => panel.getByRole('button', { name: 'Apply item edits', exact: true }).click(), 'update_item');
}
async function confirm() {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  return command(() => dialog('Confirm 1 items?', {}, 'Confirm items'), 'confirm_items');
}
function checkArea(state, id, expected = 56) {
  const value = state.item_results.find(item => item.id === id);
  assert.ok(Math.abs(value.net_area_m2 - expected) < .2, JSON.stringify(value));
  assert.ok(Math.abs(value.gross_area_m2 - 60) < .2, JSON.stringify(value));
  assert.equal(Object.hasOwn(value, 'length_m'), false);
  return value;
}
async function surface(mode, rotated = false) {
  await page.locator(`[data-mode="${mode}"]`).click();
  await fit();
  await expect(page.getByRole('button', { name: 'Preview transfer', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Cite length', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await draw([[100, 75], [500, 75]], rotated);
  await command(() => dialog('Calibrate this drawing', { 'Calibration name': `${mode} baseline`, 'Known real distance (metres)': 10, 'Uniform scale confirmed': 'Yes — the drawing has the same horizontal and vertical scale' }, 'Create calibration'), 'add_calibration');
  await page.getByRole('button', { name: 'Trace surface', exact: true }).click();
  await draw([[100, 200], [500, 200], [500, 440], [100, 440]], rotated, true);
  let state = await command(() => dialog(`Add ${mode} surface`, {
    [mode === 'wall' ? 'Wall ID' : 'Slab / zone ID']: `${mode.toUpperCase()}-01`,
    'Explicit physical quantity': '1', 'Surface basis': mode === 'wall' ? 'wall-face' : 'slab-soffit',
    'True-surface source citation': `Synthetic ${mode} true-plane view, one surface, 10 x 6 m`,
  }, 'Add surface'), 'create_item');
  const id = state.snapshot.items.find(item => item.mode === mode).id;
  assert.equal(state.snapshot.items.find(item => item.id === id).geometry.points.length, 4, 'Polygon double-click preserves exactly four distinct vertices');
  // Adding a hole focuses the object; fit only after entering the exclusion tool.
  await page.getByRole('button', { name: 'Add exclusion', exact: true }).click();
  await fit();
  await draw([[180, 260], [260, 260], [260, 340], [180, 340]], rotated, true);
  state = await command(() => dialog('Add excluded opening', { 'Exclusion source / reason': 'Synthetic 2 x 2 m opening' }, 'Add exclusion'), 'update_item');
  assert.equal(state.snapshot.items.find(item => item.id === id).geometry.exclusions[0].points.length, 4, 'Exclusion double-click preserves exactly four distinct vertices');
  checkArea(state, id);
  state = await edit({ 'Level': 'L02', 'Substrate': 'Concrete', 'Treatment': 'Nominated board treatment', 'FRL / fire rating': '120/120/120' });
  assert.equal(state.snapshot.items.find(item => item.id === id).quantity, 1);
  assert.equal(state.snapshot.items.find(item => item.id === id).member_ids.length, 1);
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  state = await confirm();
  const item = state.snapshot.items.find(item => item.id === id);
  assert.equal(item.state, 'confirmed');
  assert.equal(item.confirmation.checks.engine, 'takeoffs-area-v1');
  return { id, metrics: checkArea(state, id), geometry: item.geometry, confirmation: item.confirmation };
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
  await expect(page.locator('#project-tools')).toBeVisible({ timeout: 30000 });
  const calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
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
  // Abandoning a retrace must not turn a later new-surface gesture into replacement.
  await page.getByRole('button', { name: 'Re-trace geometry', exact: true }).click();
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'polygon');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await fit();
  await page.getByRole('button', { name: 'Trace surface', exact: true }).click();
  await draw([[300, 300], [400, 300], [400, 400]]);
  await page.locator('.takeoff-viewport').press('Enter');
  await dialog('Add wall surface', {}, 'Cancel');
  await page.getByRole('button', { name: 'Cancel trace', exact: true }).click();
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
  await page.getByLabel('Sort register', { exact: true }).selectOption('area');
  await page.getByLabel('Group register', { exact: true }).selectOption('level');
  await page.locator(`tr[data-item-id="${wall.id}"]`).hover();
  await expect(page.locator('.takeoff-markup.hovered')).toHaveCount(1);
  await page.getByLabel('Hide WALL-01 on drawing', { exact: true }).check();
  await expect(page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`)).toHaveCount(0);
  await page.getByLabel('Hide WALL-01 on drawing', { exact: true }).uncheck();
  // SVG focus/hover uses the same persistent row identity after filters/grouping.
  await page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`).hover({ position: { x: 25, y: 25 } });
  await expect(page.locator(`tr[data-item-id="${wall.id}"]`)).toHaveClass(/hovered/);
  await page.getByLabel('Filter register', { exact: true }).fill('');
  await page.getByLabel('Group register', { exact: true }).selectOption('');
  await confirm();
  await page.screenshot({ path: path.join(output, 'wall-confirmed.png'), fullPage: true });
  await command(() => page.getByRole('button', { name: 'Page ›', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue('');
  const slab = await surface('slab', true);
  // Row navigation recovers exact document/page and shape after changing modes/pages.
  await page.locator('[data-mode="wall"]').click();
  await page.locator(`tr[data-item-id="${wall.id}"] .takeoff-row-link`).click();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await expect(page.locator(`.takeoff-hit[data-item-id="${wall.id}"]`)).toHaveCount(1);
  await page.locator('[data-mode="slab"]').click();
  await page.locator(`tr[data-item-id="${slab.id}"] .takeoff-row-link`).click();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
  await page.screenshot({ path: path.join(output, 'slab-rotated-confirmed.png'), fullPage: true });
  const save = page.waitForResponse(r => r.url().endsWith('/api/project/save-as'));
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  assert.equal((await save).status(), 200);
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project));
  assert.equal(saved.version, 2); assert.equal(saved.takeoffs.items.length, 2);
  const load = page.waitForResponse(r => r.url().endsWith('/api/project/open'));
  await page.getByRole('button', { name: 'Load', exact: true }).click(); assert.equal((await load).status(), 200);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'TAKEOFFS', exact: true }).click();
  for (const record of [wall, slab]) {
    const mode = record === wall ? 'wall' : 'slab';
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.locator(`tr[data-item-id="${record.id}"] .takeoff-row-link`).click();
    await expect(page.locator(`tr[data-item-id="${record.id}"] .takeoff-state`)).toHaveText('Confirmed');
    for (const format of ['CSV', 'XLSX']) {
      const download = page.waitForEvent('download'); await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
      const file = await download, target = path.join(output, `${mode}-${file.suggestedFilename()}`); await file.saveAs(target); assert.ok(fs.statSync(target).size > 100);
      if (format === 'CSV') { const text = fs.readFileSync(target, 'utf8'); assert.ok(text.includes(record.id)); assert.ok(text.includes('net_area_m2')); }
    }
  }
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, wall, slab, errors, csp: [] }, null, 2));
  console.log(`PASS: true-surface wall/slab areas, exclusions, rotated CropBox/UserUnit2/DPR2, bulk/undo, selection, confirmation, Save As/reopen, CSV/XLSX; calculators unchanged. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
