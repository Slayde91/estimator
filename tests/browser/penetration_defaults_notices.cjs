// Real Firestopping entry controls, native calculations and disposable Save/Open.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `penetration-defaults-notices-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['data/penetration.json.gz', 'estimator/penetration_calculator.py', 'estimator/penetration_entry.py'];
const sourceHashes = Object.fromEntries(sources.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
const assets = ['static/penetration.js', 'static/app.js', 'static/index.html', 'static/styles.css', 'static/penetration.css'];
const assetHashes = Object.fromEntries(assets.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${logs}`)); });
});
const errors = [], checks = {}, calculations = [];
const control = column => page.locator(`[data-penetration-scope="composer"][data-penetration-field="${column}"]`);
const tab = group => page.locator(`#penetration-input-groups [data-penetration-group="${group}"]`);
async function settled() {
  await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => { const value = window.CeasefireDesktop?.status(); return value?.ready && !value.busy; });
}
async function snapshot() { await settled(); return page.evaluate(() => ({ firestopping: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), calculators: window.CeasefireCalculators.projectSnapshot() })); }
async function select(column, value) { await control(column).selectOption(value); await settled(); }
async function details() { await tab('Penetration').click(); await expect(tab('Penetration')).toHaveAttribute('aria-selected', 'true'); await expect(page.getByRole('dialog')).toHaveCount(0); }
async function fill(column, value) { await control(column).fill(value); await control(column).press('Tab'); await settled(); }
async function clear() {
  await page.locator('#penetration-clear').click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading')).toHaveText('Clear calculator?'); await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await details(); assert.deepEqual((await snapshot()).firestopping.composer.rows[0].inputs, {});
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765, 'Only a disposable random-port fixture may be used');
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async reply => { if (new URL(reply.url()).pathname === '/api/penetration/calculate' && reply.ok()) calculations.push({ payload: reply.request().postDataJSON(), response: await reply.json() }); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  // A first save initializes specialist defaults and freezes current prices.
  // Establish that native project baseline before testing later round trips.
  const initialSave = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/project/save-as'); initialSave.catch(() => {});
  await clickProjectControl(page, 'Save'); assert.equal((await initialSave).status(), 200);
  const initialOpen = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/project/open'); initialOpen.catch(() => {});
  await clickProjectControl(page, 'Load'); assert.equal((await initialOpen).status(), 200); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await chooseCalculator(page, 'Firestopping'); await settled();
  const initial = await snapshot(), definitionReply = await page.request.post(`http://127.0.0.1:${info.port}/api/penetration/definition`, { data: { configuration: initial.pricing } });
  assert.equal(definitionReply.status(), 200); const definition = await definitionReply.json(), services = definition.row_fields.find(field => field.column === 'K').options;
  const routes = initial.firestopping.composer.globals.service_routes;
  const pick = (group, preferred) => (preferred || []).find(value => services.includes(value) && routes[group].includes(value)) || routes[group].find(value => services.includes(value));
  const cases = [['Unlagged Pipes', pick('Unlagged Pipes', ['Copper Pipes']), ['AN']], ['Lagged Pipes', pick('Lagged Pipes'), ['AN']], ['Plastic Pipes', pick('Plastic Pipes', ['PEX pipe']), ['AN']], ['Cables/Bundles', pick('Cables/Bundles', ['Data Cables']), ['AN', 'AT']], ['Cabletrays', pick('Cabletrays', ['Cable Trays']), ['AT']]];
  for (const [group, service, columns] of cases) {
    assert.ok(service, `Source metadata supplies ${group}`); await clear(); await select('M', 'Vertical'); await select('K', service);
    let inputs = (await snapshot()).firestopping.composer.rows[0].inputs; for (const column of columns) assert.equal(inputs[column], 2, `${group} vertical ${column}`);
    await tab(group).click(); await expect(control(columns[0])).toHaveValue('2.00'); await details(); await select('M', 'Horizontal');
    inputs = (await snapshot()).firestopping.composer.rows[0].inputs; for (const column of columns) assert.equal(inputs[column], 1, `${group} horizontal ${column}`);
    await tab(group).click(); await fill(columns[0], '1.23456789012345'); await details(); await select('M', 'Vertical');
    assert.equal((await snapshot()).firestopping.composer.rows[0].inputs[columns[0]], 1.23456789012345, 'A precise manual multiplier survives changing orientation');
    checks[group] = { service, columns, vertical: 2, horizontal: 1, manualPrecisionRetained: true };
  }
  await clear(); await select('K', cases[2][1]); await select('P', 'Concrete/masonry wall'); assert.equal((await snapshot()).firestopping.composer.rows[0].inputs.AN, 2);
  await select('P', 'Concrete/masonry floor'); assert.equal((await snapshot()).firestopping.composer.rows[0].inputs.AN, 1); checks.substrateOrientation = true;
  await select('L', 'Oversized core hole'); await tab('Substrate').click(); await expect(control('AY')).toHaveValue('2.00'); await fill('AY', '3.98765432109876'); await details();
  await select('J', 'Bulkheads'); await tab('Bulkhead').click(); await expect(control('BE')).toHaveValue('2.00'); await fill('BE', '4.12345678901234'); await details();
  await select('M', 'Vertical'); const multipliers = (await snapshot()).firestopping.composer.rows[0].inputs; assert.equal(multipliers.AY, 3.98765432109876); assert.equal(multipliers.BE, 4.12345678901234); checks.boardAndBulkhead = true;
  await clear(); await select('J', 'Plumbing & Hydraulic'); await select('K', cases[2][1]); await select('L', 'Core hole'); await select('M', 'Vertical'); await select('N', '-/120/120'); await select('P', 'Concrete/masonry wall'); await fill('O', '1');
  await tab('Products and labour').click(); const collar = await control('Y').locator('option').evaluateAll(options => options.find(option => option.value && !option.disabled).value); await select('Y', collar);
  await tab('Plastic Pipes').click(); await fill('AN', ''); await details(); await expect(page.locator('#app-message')).toContainText('Please enter collar Diameter and Multiplier'); await expect(page.locator('#app-message')).toHaveAttribute('role', 'alert');
  assert.equal(await page.getByRole('dialog').count(), 0); await tab('Products and labour').click(); await expect(tab('Products and labour')).toHaveAttribute('aria-selected', 'true'); await details();
  // Blank and malformed values remain source errors/invalid controls; changing
  // tabs never clears those inputs or silently substitutes a valid result.
  await tab('Plastic Pipes').click(); await fill('AL', '100'); await fill('AN', '1.98765432109876'); await details();
  checks.freeDetailsNavigation = true; checks.topNotification = true;
  const retained = await snapshot(), saving = page.waitForResponse(reply => ['/api/project/save', '/api/project/save-as'].includes(new URL(reply.url()).pathname));
  saving.catch(() => {}); await clickProjectControl(page, 'Save'); const saved = await saving; assert.equal(saved.status(), 200, await saved.text());
  await settled(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const savedBytes = fs.readFileSync(info.project), opening = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/project/open'); await clickProjectControl(page, 'Load'); assert.equal((await opening).status(), 200);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await chooseCalculator(page, 'Firestopping'); await settled();
  const reopened = await snapshot(); fs.writeFileSync(path.join(output, 'save-open-snapshots.json'), JSON.stringify({ retained, reopened }, null, 2));
  assert.ok(require('node:util').isDeepStrictEqual(reopened, retained), 'Save/Open retains exact multipliers, source identities, prices, schedule and specialist drafts'); await select('M', 'Horizontal'); assert.equal((await snapshot()).firestopping.composer.rows[0].inputs.AN, 1.98765432109876, 'A reopened saved multiplier remains explicit');
  assert.deepEqual(fs.readFileSync(info.project), savedBytes); checks.saveOpenExact = true;
  for (const width of [1146, 390]) { await page.setViewportSize({ width, height: 900 }); await tab('Plastic Pipes').click(); await fill('AN', ''); await details(); await expect(page.locator('#app-message')).toContainText('Please enter collar Diameter and Multiplier'); await page.screenshot({ path: path.join(output, `top-notice-details-${width}.png`), fullPage: true }); }
  const latest = calculations.at(-1); assert.ok(latest); const replay = await page.request.post(`http://127.0.0.1:${info.port}/api/penetration/calculate`, { data: latest.payload }); assert.equal(replay.status(), 200); assert.deepEqual(await replay.json(), latest.response, 'Repeated native calculation is exactly deterministic'); checks.nativeCalculationParity = true;
  assert.deepEqual((await snapshot()).firestopping.draft, initial.firestopping.draft, 'Defaults and notifications leave the independent Schedule unchanged');
  await page.setViewportSize({ width: 1146, height: 900 }); await clear();
  for (const [column, value] of [['J', 'Plumbing & Hydraulic'], ['K', cases[0][1]], ['L', 'Core hole'], ['M', 'Vertical'], ['N', '-/120/120'], ['P', 'Concrete/masonry wall']]) await select(column, value);
  await fill('O', '2.34567890123456'); await fill('T', 'Synthetic retained Delete and Undo proof'); await page.locator('#penetration-add-to-schedule').click();
  await expect(page.locator('#penetration-add-to-schedule')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('#penetration-estimator-schedule-body > tr')).toHaveCount(1); await settled();
  const beforeDelete = await snapshot();
  for (const body of ['penetration-estimator-schedule-body', 'penetration-schedule-body']) {
    const shape = await page.locator(`#${body}`).evaluate(element => ({ columns: element.children[0].children.length, header: element.closest('table').querySelector('thead tr').lastElementChild.textContent.trim(), actions: [...element.children[0].children[11].querySelectorAll('button')].map(button => button.textContent.trim()), trash: element.children[0].children[12].querySelector('button').getAttribute('aria-label') }));
    assert.equal(shape.columns, 13); assert.equal(shape.header, 'Delete'); assert.deepEqual(shape.actions, ['Edit']); assert.equal(shape.trash, 'Delete firestopping item 1');
  }
  async function reviewedDelete(body, decision) {
    await page.locator(`#${body} > tr td:last-child button`).click(); const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Are you sure you want to delete this item?'); await expect(dialog.getByRole('button', { name: 'Yes', exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await dialog.screenshot({ path: path.join(output, `delete-confirm-${body}-${decision}.png`) }); await dialog.getByRole('button', { name: decision, exact: true }).click(); await expect(dialog).toBeHidden(); await settled();
  }
  await reviewedDelete('penetration-estimator-schedule-body', 'Cancel'); assert.ok(require('node:util').isDeepStrictEqual(await snapshot(), beforeDelete), 'Cancel leaves every retained value unchanged');
  await reviewedDelete('penetration-estimator-schedule-body', 'Yes'); await expect(page.locator('#penetration-estimator-schedule-body > tr')).toHaveCount(0); await page.locator('#penetration-estimator-undo').click(); await expect(page.locator('#penetration-estimator-schedule-body > tr')).toHaveCount(1); await settled();
  assert.ok(require('node:util').isDeepStrictEqual(await snapshot(), beforeDelete), 'Undo restores the exact native row, precision, composer and other draft scopes');
  await page.locator('#estimate-navigation-toggle').hover(); await page.locator('#estimate-navigation-menu').getByRole('button', { name: 'Estimate', exact: true }).click(); await page.mouse.move(0, 0);
  await expect(page.locator('#main-tab-firestopping-schedule')).toHaveCount(0);
  await expect(page.locator('#main-panel-firestopping-schedule')).toBeHidden();
  assert.ok(require('node:util').isDeepStrictEqual(await snapshot(), beforeDelete)); checks.confirmedDeleteCalculatorSchedule = true; checks.cancelAndUndoExact = true;
  assert.deepEqual(errors, []);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(root, name))), expected);
  for (const [name, expected] of Object.entries(assetHashes)) assert.equal(hash(fs.readFileSync(path.join(root, name))), expected, `Tested runtime remains stable: ${name}`);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, port: info.port, checks, sourceHashes, assetHashes, nativeCalculations: calculations.length, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
})().catch(async error => { console.error(error); fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n${logs}`); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
