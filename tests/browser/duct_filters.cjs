// Steel and Duct column filters against disposable, source-backed 102-row registers.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const mode = process.argv[2] === 'steel' ? 'steel' : 'duct', steel = mode === 'steel', title = steel ? 'Steel' : 'Duct', prefix = steel ? 'S' : 'D';
const markLabel = steel ? 'Member mark' : 'Item', sizeLabel = steel ? 'Steel section' : 'WxH (mm)', ratingLabel = steel ? 'Fire period (min)' : 'FRL', typeLabel = steel ? 'Member type' : 'Orientation';
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `${mode}-filters-${Date.now()}`);
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
const errors = [], commands = [], evidence = {};
const register = () => page.getByRole('table', { name: `${title} editable takeoff register`, exact: true });
const rows = () => register().locator('tbody tr[data-item-id]');
const rowMarks = () => rows().getByLabel(markLabel, { exact: true }).evaluateAll(fields => fields.map(field => field.value));
const panel = () => page.locator('.takeoff-column-filter');
async function menu(label) { await register().getByRole('button', { name: `Filter ${label}`, exact: true }).click(); await expect(panel()).toBeVisible(); return panel(); }
async function finishMenu(dialog, action) {
  if (action === 'Escape') await dialog.press('Escape');
  else await dialog.getByRole('button', { name: action, exact: true }).click();
  // Native dialog.close() queues a close event. Its handler commits the filter
  // before removing the dialog; a completed click or hidden dialog is too early.
  await dialog.waitFor({ state: 'detached' });
}
async function filter(label, values) {
  const dialog = await menu(label); await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck();
  for (const value of values) await dialog.getByRole('checkbox', { name: value, exact: true }).check();
  await finishMenu(dialog, 'Apply filter');
}
async function reset(label) { await finishMenu(await menu(label), 'Reset filter'); }

(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) commands.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${info.port}/`);
  // Bootstrap selects its initial view; navigate only after it has completed.
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot().render_checks.some(check => check.page === 1 && check.success); } catch { return false; } });
  // The fixture uses only validated public commands. All ordinary interaction
  // below is through the actual register controls; no filtering is mocked.
  const seeded = await page.evaluate(async mode => {
    const steel = mode === 'steel', prefix = steel ? 'S' : 'D';
    const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const command = async (op, values) => {
      const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op, ...values }) });
      const body = await reply.json(); if (!reply.ok) throw new Error(JSON.stringify(body)); current = body.snapshot; return body;
    };
    const doc = current.documents[0], view = doc.pages[0].view, calibration = crypto.randomUUID();
    const points = [[view[0] + 20, view[1] + 20], [view[0] + 120, view[1] + 20]];
    await command('add_calibration', { calibration: { id: calibration, document_id: doc.id, page: 1, name: 'Synthetic filter baseline', points, distance_m: 10, uniform_scale: true } });
    for (let index = 1; index <= 102; index++) {
      const level = index <= 2 ? 'L1' : index === 4 ? '' : 'L2';
      const fields = { mark: `${prefix}${String(index).padStart(3, '0')}`, level, shape: 'rectangular', width_mm: index <= 2 ? 100 : 300, height_mm: index <= 2 ? 200 : 400,
        frl: index === 2 ? '60/60/60' : '120/120/120', orientation: index === 2 ? 'Vertical' : index === 3 ? 'Both' : 'Horizontal', product: 'FyreWrap', exposure: 'Internal', wall_penetrations: 0, floor_penetrations: 0 };
      if (index === 4) { delete fields.width_mm; delete fields.height_mm; fields.frl = ''; fields.orientation = ''; }
      if (steel) { Object.assign(fields, { member_type: index === 2 ? 'Column' : 'Beam', section: index <= 2 ? '100UC15' : '150UC23', fire_period_min: index === 2 ? 60 : 120, critical_temperature: 550, product: 'CAFCO 300', exposure: 'Re-entrant - 3 sides' }); for (const key of ['shape', 'width_mm', 'height_mm', 'frl', 'orientation', 'wall_penetrations', 'floor_penetrations']) delete fields[key]; if (index === 4) for (const key of ['member_type', 'section', 'fire_period_min']) delete fields[key]; }
      await command('create_item', { item: { mode, quantity: 1, fields, geometry: { document_id: doc.id, page: 1, points }, measurement: { method: 'calibrated', calibration_id: calibration }, evidence: [{ document_id: doc.id, page: 1, note: 'Synthetic column-filter record' }] } });
    }
    await command('confirm_items', { item_ids: [current.items[0].id] });
    await command('create_item', { item: { mode: steel ? 'duct' : 'steel', quantity: 1, fields: { mark: steel ? 'D001' : 'S001', level: 'L1' } } });
    takeoffs.applyProject(await takeoffs.prepareProject(current, sid));
    return { first: current.items[0].id, snapshot: current };
  }, mode);
  await page.getByRole('tab', { name: mode.toUpperCase(), exact: true }).click();
  await expect(rows()).toHaveCount(100); await expect(page.getByText('1–100 of 102 matching items', { exact: true })).toBeVisible();
  for (const label of ['Filter confirmation state', 'Sort register', 'Group register']) await expect(page.getByLabel(label, { exact: true })).toBeHidden();
  for (const label of ['Select filtered items', 'Clear selection', 'Undo last edit']) await expect(page.getByRole('button', { name: label, exact: true }))[steel ? 'toBeVisible' : 'toBeHidden']();
  await expect(page.getByRole('button', { name: 'Linked calculator rows', exact: true })).toHaveCount(0);
  if (steel) for (const name of ['Select filtered items', 'Clear selection']) { const control = page.getByRole('button', { name, exact: true }); await expect(control).toHaveClass(/icon-only/); await expect(control.locator('svg')).toHaveCount(1); }
  await expect(page.getByRole('button', { name: 'Detach links', exact: true }).locator('path')).toHaveAttribute('d', 'M15 7h2a5 5 0 0 1 0 10h-2M9 17H7A5 5 0 0 1 7 7h2');
  const updateLinked = page.getByRole('button', { name: 'Update linked rows', exact: true });
  await expect(updateLinked).toHaveAttribute('title', 'Update linked rows');
  await expect(updateLinked.locator('path')).toHaveAttribute('d', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 6v6h6');
  await expect(updateLinked.locator('svg')).toHaveAttribute('stroke', 'currentColor');
  await expect(updateLinked.locator('svg')).toHaveAttribute('stroke-linejoin', 'round');
  await expect(page.getByLabel('Filter register', { exact: true })).toBeVisible();
  assert.equal(await register().locator('.takeoff-column-filter-button').count(), steel ? 7 : 6); assert.equal(await register().locator('.takeoff-group-row').count(), 0);
  const baselineCommands = commands.length;
  await page.getByRole('button', { name: 'Next 100', exact: true }).click(); assert.deepEqual(await rowMarks(), [`${prefix}101`, `${prefix}102`]);
  await filter('Level', ['L1']); assert.deepEqual(await rowMarks(), [`${prefix}001`, `${prefix}002`]);
  await expect(page.getByText('1–2 of 2 matching items', { exact: true })).toBeVisible();
  await expect(register().getByRole('button', { name: 'Filter Level', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await rows().first().getByRole('checkbox', { name: `Select ${prefix}001`, exact: true }).check();
  await filter(typeLabel, [steel ? 'Column' : 'Vertical']); assert.deepEqual(await rowMarks(), [`${prefix}002`]);
  // Existing selected-register CSV export remains based on the explicit
  // selection, even if that row is now hidden by a view filter.
  const download = page.waitForEvent('download'), exported = page.waitForRequest(request => request.url().endsWith('/export/csv'));
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  assert.deepEqual((await exported).postDataJSON().selected_ids, [seeded.first]); await (await download).saveAs(path.join(output, 'selected-confirmed.csv'));
  await page.getByLabel('Filter register', { exact: true }).fill(`${prefix}001`); await expect(rows()).toHaveCount(0);
  await page.getByLabel('Filter register', { exact: true }).fill(steel ? 'column' : 'vertical'); assert.deepEqual(await rowMarks(), [`${prefix}002`]);
  await page.getByLabel('Filter register', { exact: true }).fill(''); await reset(typeLabel);
  await filter('Confirmation', ['Confirmed']); assert.deepEqual(await rowMarks(), [`${prefix}001`]); await reset('Confirmation');
  await filter(ratingLabel, [steel ? '120' : '120/120/120']); assert.deepEqual(await rowMarks(), [`${prefix}001`]); await reset(ratingLabel);
  await filter(sizeLabel, [steel ? '150UC23' : '300 x 400']); await expect(rows()).toHaveCount(0); await reset('Level'); assert.equal((await rowMarks()).length, 99);
  await filter(markLabel, [`${prefix}003`, `${prefix}005`]); assert.deepEqual(await rowMarks(), [`${prefix}003`, `${prefix}005`]);
  await reset(markLabel); await reset(sizeLabel); await filter('Level', ['(Blanks)']); assert.deepEqual(await rowMarks(), [`${prefix}004`]); await reset('Level');
  let dialog = await menu(markLabel); await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck();
  await dialog.getByLabel(`Search ${markLabel} values`, { exact: true }).fill(`${prefix}10`);
  await expect(dialog.getByRole('group', { name: `${markLabel} values`, exact: true }).getByRole('checkbox')).toHaveCount(3);
  await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).check(); await dialog.getByLabel(`Search ${markLabel} values`, { exact: true }).fill('');
  await expect(dialog.getByRole('checkbox', { name: 'Select all values', exact: true })).toHaveJSProperty('indeterminate', true);
  await finishMenu(dialog, 'Apply filter'); assert.deepEqual(await rowMarks(), [`${prefix}100`, `${prefix}101`, `${prefix}102`]);
  dialog = await menu(markLabel); await dialog.getByRole('checkbox', { name: `${prefix}001`, exact: true }).check(); await finishMenu(dialog, 'Escape'); assert.deepEqual(await rowMarks(), [`${prefix}100`, `${prefix}101`, `${prefix}102`]);
  await page.getByRole('tab', { name: steel ? 'DUCT' : 'STEEL', exact: true }).click();
  for (const label of ['Filter confirmation state', 'Sort register', 'Group register']) await expect(page.getByLabel(label, { exact: true })).toBeHidden();
  assert.equal(await page.locator('.takeoff-column-filter-button').count(), 6);
  await page.getByRole('tab', { name: mode.toUpperCase(), exact: true }).click(); assert.deepEqual(await rowMarks(), [`${prefix}100`, `${prefix}101`, `${prefix}102`]);
  await page.setViewportSize({ width: 764, height: 764 }); dialog = await menu(markLabel);
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 764 && box.y + box.height <= 764);
  await page.screenshot({ path: path.join(output, `${mode}-filter-menu-narrow.png`) }); await finishMenu(dialog, 'Cancel');
  await page.setViewportSize({ width: 1146, height: 764 }); await register().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `${mode}-filter-active-register.png`) });
  assert.equal(commands.length, baselineCommands, 'Filters, search, pagination and export sent no item or calibration command');
  assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()), seeded.snapshot, 'Snapshot and calculation inputs remain unchanged');
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  Object.assign(evidence, { passed: true, mode, itemCount: 102, allSixColumns: true, paginationReset: true, andOrBlankSearch: true, nativeDialogCompletionVerified: true, narrowMenuInViewport: true, snapshotUnchanged: true, selectedExportUnchanged: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, ...evidence }, null, 2));
})().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(output, 'server.log'), logs); });
