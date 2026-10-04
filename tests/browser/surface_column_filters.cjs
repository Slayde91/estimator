const { chooseTakeoff } = require('./section_navigation.cjs');
// Real nine-column Wall/Slab filters against disposable source-backed projects.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `surface-filters-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, currentMode = 'wall';
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], commands = [], evidence = {};
const labels = mode => ['Confirmation', mode === 'wall' ? 'Wall ID' : 'Slab / zone ID', 'Level', 'Surface basis', 'Substrate', 'Treatment', 'Protection system', 'Protection product', 'FRL / fire rating'];
const register = () => page.getByRole('table', { name: `${currentMode === 'wall' ? 'Walls' : 'Slabs'} editable takeoff register`, exact: true });
const rows = () => register().locator('tbody tr[data-item-id]');
const rowMarks = () => rows().getByLabel(labels(currentMode)[1], { exact: true }).evaluateAll(fields => fields.map(field => field.value));
const panel = () => page.locator('.takeoff-column-filter');
async function mode(value) { currentMode = value; await chooseTakeoff(page, value === 'wall' ? 'WALLS' : 'SLABS'); }
async function menu(label) { await register().getByRole('button', { name: `Filter ${label}`, exact: true }).click(); await expect(panel()).toBeVisible(); return panel(); }
async function finishMenu(dialog, action) {
  if (action === 'Escape') await dialog.press('Escape'); else await dialog.getByRole('button', { name: action, exact: true }).click();
  // The native close handler commits presentation state before removing the dialog.
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
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('#takeoff-upload').setInputFiles(info.area_fixture);
  await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot().render_checks.some(check => check.page === 1 && check.success); } catch { return false; } });
  const seeded = await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const command = async (op, values) => {
      const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op, ...values }) });
      const body = await reply.json(); if (!reply.ok) throw new Error(JSON.stringify(body)); current = body.snapshot; return body;
    };
    const doc = current.documents[0], view = doc.pages[0].view, calibration = crypto.randomUUID();
    await command('add_calibration', { calibration: { id: calibration, document_id: doc.id, page: 1, name: 'Synthetic surface filter baseline', points: [[view[0] + 20, view[1] + 20], [view[0] + 120, view[1] + 20]], distance_m: 10, uniform_scale: true } });
    const first = {};
    for (const mode of ['wall', 'slab']) {
      const prefix = mode === 'wall' ? 'W' : 'S';
      for (let index = 1; index <= 102; index++) {
        const fields = { mark: `${prefix}${String(index).padStart(3, '0')}`, level: index <= 2 ? 'L1' : 'L2',
          surface_basis: mode === 'wall' ? 'wall-face' : index <= 2 ? 'slab-top' : 'slab-soffit', substrate: 'Concrete',
          treatment: index === 2 ? 'Spray' : 'Board', system: 'System A', product: 'Product A', frl: index === 2 ? '60/60/60' : '120/120/120',
          surface_citation: `Synthetic ${mode} true-plane source, one treated surface` };
        if (index === 3) Object.assign(fields, { surface_basis: 'Retained custom plane', substrate: 'Custom substrate', treatment: 'Custom treatment', system: 'Custom system', product: 'Custom product', frl: 'Custom rating' });
        if (index === 4) for (const key of ['level', 'surface_basis', 'substrate', 'treatment', 'system', 'product', 'frl']) fields[key] = '';
        const reply = await command('create_item', { item: { mode, quantity: 1, fields,
          geometry: { kind: 'polygon', document_id: doc.id, page: 1, points: [[view[0] + 140, view[1] + 140], [view[0] + 240, view[1] + 140], [view[0] + 240, view[1] + 200], [view[0] + 140, view[1] + 200]], exclusions: [] },
          measurement: { method: 'calibrated', calibration_id: calibration }, evidence: [{ document_id: doc.id, page: 1, note: 'Synthetic surface column-filter record' }] } });
        if (index === 1) first[mode] = reply.snapshot.items.at(-1).id;
      }
      await command('confirm_items', { item_ids: [first[mode]] });
    }
    takeoffs.applyProject(await takeoffs.prepareProject(current, sid)); return { first, snapshot: current };
  });
  const baselineCommands = commands.length, baselineCalculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  for (const value of ['wall', 'slab']) {
    await mode(value); const prefix = value === 'wall' ? 'W' : 'S', markLabel = labels(value)[1], basis = value === 'wall' ? 'Wall face (true elevation)' : 'Slab top';
    await expect(rows()).toHaveCount(100); await expect(page.getByText('1–100 of 102 matching items', { exact: true })).toBeVisible();
    for (const label of ['Filter confirmation state', 'Sort register', 'Group register']) await expect(page.getByLabel(label, { exact: true })).toBeHidden();
    assert.deepEqual(await register().locator('.takeoff-column-filter-button').evaluateAll(controls => controls.map(control => control.getAttribute('aria-label'))), labels(value).map(label => `Filter ${label}`));
    assert.equal(await register().locator('.takeoff-group-row').count(), 0);
    await page.getByRole('button', { name: 'Next 100', exact: true }).click(); assert.deepEqual(await rowMarks(), [`${prefix}101`, `${prefix}102`]);
    await filter('Level', ['L1']); assert.deepEqual(await rowMarks(), [`${prefix}001`, `${prefix}002`]);
    await expect(page.getByText('1–2 of 2 matching items', { exact: true })).toBeVisible();
    await rows().first().getByRole('checkbox', { name: `Select ${prefix}001`, exact: true }).check();
    await filter('Treatment', ['Spray']); assert.deepEqual(await rowMarks(), [`${prefix}002`]);
    // Export remains tied to explicit, confirmed selected IDs even if hidden.
    const download = page.waitForEvent('download'), exported = page.waitForRequest(request => request.url().endsWith('/export/csv'));
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click(); assert.deepEqual((await exported).postDataJSON().selected_ids, [seeded.first[value]]);
    const exportPath = path.join(output, `${value}-selected-confirmed.csv`); await (await download).saveAs(exportPath);
    const csv = fs.readFileSync(exportPath, 'utf8'); assert.ok(csv.includes(`${prefix}001`)); assert.ok(!csv.includes(`${prefix}002`));
    await page.getByLabel('Filter register', { exact: true }).fill(`${prefix}001`); await expect(rows()).toHaveCount(0);
    await page.getByLabel('Filter register', { exact: true }).fill('spray'); assert.deepEqual(await rowMarks(), [`${prefix}002`]);
    await page.getByLabel('Filter register', { exact: true }).fill(''); await reset('Treatment');
    for (const [label, values] of [['Confirmation', ['Confirmed']], [markLabel, [`${prefix}001`, `${prefix}002`]], ['Surface basis', [basis]], ['Substrate', ['Concrete']], ['Treatment', ['Board', 'Spray']], ['Protection system', ['System A']], ['Protection product', ['Product A']], ['FRL / fire rating', ['120/120/120']]]) {
      await filter(label, values); assert.deepEqual(await rowMarks(), [`${prefix}001`]);
    }
    assert.equal(await register().locator('.takeoff-column-filter-button[aria-pressed="true"]').count(), 9);
    for (const label of labels(value)) await reset(label);
    for (const label of ['Level', 'Surface basis', 'Substrate', 'Treatment', 'Protection system', 'Protection product', 'FRL / fire rating']) {
      await filter(label, ['(Blanks)']); assert.deepEqual(await rowMarks(), [`${prefix}004`]); await reset(label);
    }
    for (const [label, custom] of [['Surface basis', 'Retained custom plane'], ['Substrate', 'Custom substrate'], ['Treatment', 'Custom treatment'], ['Protection system', 'Custom system'], ['Protection product', 'Custom product'], ['FRL / fire rating', 'Custom rating']]) {
      await filter(label, [custom]); assert.deepEqual(await rowMarks(), [`${prefix}003`]); await reset(label);
    }
    let dialog = await menu(markLabel); await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck();
    await dialog.getByLabel(`Search ${markLabel} values`, { exact: true }).fill(`${prefix}10`);
    await expect(dialog.getByRole('group', { name: `${markLabel} values`, exact: true }).getByRole('checkbox')).toHaveCount(3);
    await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).check(); await dialog.getByLabel(`Search ${markLabel} values`, { exact: true }).fill('');
    await expect(dialog.getByRole('checkbox', { name: 'Select all values', exact: true })).toHaveJSProperty('indeterminate', true);
    await finishMenu(dialog, 'Apply filter'); assert.deepEqual(await rowMarks(), [`${prefix}100`, `${prefix}101`, `${prefix}102`]);
    dialog = await menu(markLabel); await dialog.getByRole('checkbox', { name: `${prefix}001`, exact: true }).check(); await finishMenu(dialog, 'Escape'); assert.deepEqual(await rowMarks(), [`${prefix}100`, `${prefix}101`, `${prefix}102`]);
    await register().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `${value}-filter-active-register.png`) });
  }
  await mode('wall'); assert.deepEqual(await rowMarks(), ['W100', 'W101', 'W102']); await reset('Wall ID'); await filter('Level', ['L1']);
  await mode('slab'); assert.deepEqual(await rowMarks(), ['S100', 'S101', 'S102']); await mode('wall'); assert.deepEqual(await rowMarks(), ['W001', 'W002']);
  await page.setViewportSize({ width: 764, height: 764 }); let dialog = await menu('Protection product');
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 764 && box.y + box.height <= 764);
  await page.screenshot({ path: path.join(output, 'surface-filter-menu-narrow.png') }); await finishMenu(dialog, 'Cancel');
  assert.equal(commands.length, baselineCommands, 'View filters, pagination and export sent no item or geometry commands');
  assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()), seeded.snapshot, 'Source identities, geometry, calibration, review and quantities remain unchanged');
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), baselineCalculators, 'Area view filters never alter calculator schedules');
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  Object.assign(evidence, { passed: true, wallItems: 102, slabItems: 102, allNineColumns: true, multiFilterIntersection: true, displayedBasisLabels: true, blanksAndCustomValues: true, independentModeState: true, paginationReset: true, selectedExportUnchanged: true, sourceSnapshotUnchanged: true, calculatorsUnchanged: true, narrowDialogInViewport: true, nativeDialogCompletionVerified: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, ...evidence }, null, 2));
})().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(output, 'server.log'), logs); });
