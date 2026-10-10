// Estimator disclosure state, saved project names and Firestopping controls use
// real endpoints in an isolated synthetic project folder, never the live app.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `estimator-header-state-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const assets = ['static/app.js', 'static/index.html', 'static/styles.css', 'static/penetration.js', 'static/penetration.css', 'static/calculators.js'];
const assetHashes = Object.fromEntries(assets.map(name => [name, sha256(fs.readFileSync(path.join(root, name)))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info, releaseHeld;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], calculations = [], checks = {};
async function idle() { await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function settledEstimate() { await expect(page.locator('#estimator-main .summary-card')).toHaveAttribute('aria-busy', 'false'); }
async function snapshot() { return page.evaluate(() => ({ details: window.CeasefireProject.details(), pricing: window.CeasefireProject.configuration(), calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot() })); }
async function response(action, pathname, matches = () => true) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname === pathname && reply.request().method() === 'POST' && matches(reply)); pending.catch(() => {});
  await action(); const reply = await pending; assert.equal(reply.status(), 200, await reply.text()); return reply.json();
}
async function disclosure(key, open) {
  const section = page.locator(`details[data-input-section="${key}"]`);
  if (await section.evaluate(element => element.open) !== open) await section.locator(':scope > summary').click();
  await expect(section).toHaveJSProperty('open', open);
}
async function disclosureStates() { return page.locator('details[data-input-section]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.inputSection, element.open]))); }
async function headerTitle(title) {
  const label = page.locator('#header-project-name'); await expect(label).toHaveText(title); await expect(label).toHaveAttribute('title', title);
  if (title) await expect(label).toBeVisible(); else await expect(label).toBeHidden();
  assert.equal(await label.locator('*').count(), 0, 'Quote names must remain plain text');
}
function retainedScopes(value) { return { pricing: value.pricing, calculators: value.calculators, globals: value.penetration.composer.globals, schedule: value.penetration.draft }; }
(async () => {
  info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/calculate') calculations.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline')); await idle();
  for (const asset of assets) {
    const served = await page.request.get(`http://127.0.0.1:${info.port}/${asset === 'static/index.html' ? '' : path.basename(asset)}`);
    assert.equal(served.status(), 200); assert.equal(sha256(await served.body()), assetHashes[asset]);
  }
  await headerTitle(''); await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  await page.getByRole('button', { name: 'Estimates', exact: true }).click(); await settledEstimate();
  await disclosure('teams-crews', true);
  const masking = page.locator('#input-D7'), active = await masking.locator('option').evaluateAll(options => options.find(option => option.value && option.value.trim().toLowerCase() !== 'n/a').value);
  const inactive = await masking.locator('option').evaluateAll(options => options.find(option => option.value.trim().toLowerCase() === 'n/a').value);
  await masking.selectOption(active); await settledEstimate();
  const expected = { 'access-travel': true, 'teams-crews': true, 'masking-cleaning': true, 'global-adjustments': false, additions: true };
  for (const [key, open] of Object.entries(expected)) await disclosure(key, open);
  await page.locator('#input-F26').fill('1.234567891'); await page.locator('#input-F26').press('Tab'); await settledEstimate();
  const originalInputs = calculations.at(-1).inputs, scopesBefore = await snapshot(); assert.equal(originalInputs.F26, 1.23, 'Native numeric editing retains the established two-decimal entry rule');
  await masking.selectOption(inactive); await settledEstimate();
  await expect(page.locator('details[data-input-section="masking-cleaning"]')).toHaveCount(0);
  const withoutMasking = await disclosureStates(); for (const [key, open] of Object.entries(expected)) if (key !== 'masking-cleaning') assert.equal(withoutMasking[key], open);
  await masking.selectOption(active); await settledEstimate(); const restored = await disclosureStates();
  for (const [key, open] of Object.entries(expected)) assert.equal(restored[key], open);
  assert.deepEqual(calculations.at(-1).inputs, originalInputs); assert.deepEqual(await snapshot(), scopesBefore);
  await disclosure('masking-cleaning', false); await masking.selectOption(inactive); await settledEstimate(); await masking.selectOption(active); await settledEstimate();
  await expect(page.locator('details[data-input-section="masking-cleaning"]')).toHaveJSProperty('open', false);
  assert.deepEqual(calculations.at(-1).inputs, originalInputs); checks.disclosures = { mixedOpenClosedRetained: true, maskingReturnsToPriorState: true, closedMaskingRetained: true, exactInputPrecision: originalInputs.F26, unrelatedDraftsAndPricesUnchanged: true };
  await page.screenshot({ path: path.join(output, 'retained-estimator-sections.png'), fullPage: true });

  await page.locator('#project-no').fill('CF-7000'); await page.locator('#client').fill('<saved quote> & Client'); await page.locator('#site-address').fill('Fixture site');
  await headerTitle('');
  const saved = await response(() => clickProjectControl(page, 'Save'), '/api/project/save-as'); await idle(); await settledEstimate();
  const savedTitle = saved.project.estimate.title; assert.equal(saved.file.title, savedTitle); assert.notEqual(savedTitle, path.basename(info.project)); await headerTitle(savedTitle);
  const savedSnapshot = await snapshot(), beforeSavedFile = fs.readFileSync(info.project); assert.equal(saved.project.estimate.inputs.F26, originalInputs.F26);
  await page.locator('#client').fill('Captured save client'); await expect(page.locator('#project-save-state')).toHaveText('Unsaved changes'); await headerTitle(savedTitle);
  const entered = deferred(), release = deferred(); releaseHeld = release.resolve;
  let captured;
  await page.route('**/api/project/save', async route => { captured = route.request().postDataJSON(); entered.resolve(); await release.promise; const reply = await route.fetch(); await route.fulfill({ response: reply }); });
  const heldSave = response(() => clickProjectControl(page, 'Save'), '/api/project/save'); heldSave.catch(() => {}); await Promise.race([entered.promise, heldSave]);
  await expect(page.locator('#project-save-state')).toHaveText('Working…'); await headerTitle(savedTitle);
  await page.locator('#client').fill('Later unsaved client'); await headerTitle(savedTitle); assert.deepEqual(fs.readFileSync(info.project), beforeSavedFile);
  release.resolve(); const heldReply = await heldSave; await idle(); await page.unroute('**/api/project/save'); releaseHeld = null;
  await headerTitle(captured.estimate.title); await expect(page.locator('#project-save-state')).toHaveText('Unsaved changes'); await expect(page.locator('#client')).toHaveValue('Later unsaved client');
  assert.equal(heldReply.file.title, captured.estimate.title); assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.client, 'Captured save client');
  assert.deepEqual((await snapshot()).pricing, savedSnapshot.pricing); assert.deepEqual((await snapshot()).calculators, savedSnapshot.calculators); assert.deepEqual((await snapshot()).penetration, savedSnapshot.penetration);
  checks.savedName = { plainText: true, differsFromFilename: true, dirtyEditsRetainSavedTitle: true, busyRetainsSavedTitle: true, savedTitleUsesCapturedPayload: true, laterEditsRemainUnsaved: true };
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await idle(); await settledEstimate();
  await headerTitle(captured.estimate.title); await expect(page.locator('#client')).toHaveValue('Captured save client');
  await page.locator('#client').fill('Draft before New'); await page.getByRole('button', { name: 'Projects', exact: true }).click(); await page.locator('#new-quote').click(); await page.getByRole('dialog').getByRole('button', { name: 'New project', exact: true }).click(); await idle(); await settledEstimate(); await headerTitle('');
  await response(() => page.locator('#project-import-file').setInputFiles(info.project), '/api/project/import'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await idle(); await settledEstimate();
  await headerTitle(captured.estimate.title); await expect(page.locator('#client')).toHaveValue('Captured save client'); assert.deepEqual((await snapshot()).pricing, savedSnapshot.pricing); assert.deepEqual((await snapshot()).calculators, savedSnapshot.calculators); assert.deepEqual((await snapshot()).penetration, savedSnapshot.penetration);
  checks.savedName.nativeReloadNewAndImport = true;

  // Saved workbook inputs can retain more precision than the native entry
  // display. Load that legitimate state, then prove UI rebuilds preserve it.
  const preciseProject = JSON.parse(fs.readFileSync(info.project)), preciseFile = path.join(output, 'precise-synthetic-project.cf.json');
  preciseProject.estimate.inputs.F26 = 1.234567891; fs.writeFileSync(preciseFile, JSON.stringify(preciseProject));
  await response(() => page.locator('#project-import-file').setInputFiles(preciseFile), '/api/project/import'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await idle(); await settledEstimate();
  await headerTitle(captured.estimate.title); const preciseInputs = calculations.at(-1).inputs, preciseScopes = await snapshot(); assert.equal(preciseInputs.F26, 1.234567891);
  await disclosure('teams-crews', true); await page.locator('#input-D7').selectOption(inactive); await settledEstimate(); await page.locator('#input-D7').selectOption(active); await settledEstimate();
  assert.deepEqual(calculations.at(-1).inputs, preciseInputs); assert.deepEqual(await snapshot(), preciseScopes); checks.disclosures.importedFullPrecisionRetained = preciseInputs.F26;

  // Native schedule edits retain full precision. Quantity controls align with
  // Item QTY; the Document/Library pair stays together and may wrap below it.
  await chooseCalculator(page, 'Firestopping'); await idle(); await expect(page.locator('#estimator-penetration')).toBeVisible();
  const clear = page.locator('#penetration-clear'), add = page.locator('#penetration-add-to-schedule'), library = page.locator('#penetration-add-to-library'), fresh = page.locator('#penetration-estimator-add');
  await expect(page.locator('#penetration-new-item')).toBeHidden(); await expect(page.locator('#penetration-recalculate')).toBeHidden();
  for (const [control, name] of [[clear, 'Clear'], [add, 'Add to Schedule'], [library, 'Add to Library']]) { await expect(control).toBeVisible(); await expect(control).toHaveAccessibleName(name); }
  assert.equal(await clear.locator('svg path').count(), 2); assert.equal(await add.locator('svg circle').count(), 1);
  checks.firestoppingViewports = [];
  for (const width of [1146, 825, 570, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    const geometry = await page.locator('#penetration-item-quantity [data-penetration-field="O"]').evaluate(element => {
      const ids = ['penetration-clear', 'penetration-add-to-schedule', 'penetration-add-to-library'];
      const bounds = control => { const rectangle = control.getBoundingClientRect(); return { top: rectangle.top, bottom: rectangle.bottom, height: rectangle.height, left: rectangle.left, right: rectangle.right }; };
      const centres = control => { const button = control.getBoundingClientRect(), icon = control.querySelector('svg').getBoundingClientRect(); return { x: icon.x + icon.width / 2 - (button.x + button.width / 2), y: icon.y + icon.height / 2 - (button.y + button.height / 2) }; };
      const pair = document.querySelector('.penetration-library-actions'), documentButton = pair.querySelector('[data-document-menu-toggle]');
      return { input: bounds(element), buttons: Object.fromEntries(ids.map(id => [id, bounds(document.getElementById(id))])), document: bounds(documentButton), pairGap: parseFloat(getComputedStyle(pair).columnGap), iconOffsets: Object.fromEntries(ids.map(id => [id, centres(document.getElementById(id))])), viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
    });
    assert.equal(geometry.input.height, 48); for (const button of [...Object.values(geometry.buttons), geometry.document]) { assert.equal(button.height, 48); assert.ok(button.left >= 0); assert.ok(button.right <= width); }
    for (const id of ['penetration-clear', 'penetration-add-to-schedule']) { const button = geometry.buttons[id]; assert.ok(Math.abs(button.top - geometry.input.top) < 1, `${id} aligns with Item QTY at ${width}`); assert.ok(Math.abs(button.bottom - geometry.input.bottom) < 1); }
    const libraryButton = geometry.buttons['penetration-add-to-library'];
    assert.ok(Math.abs(libraryButton.top - geometry.document.top) < 1, `Document and Library share a row at ${width}`);
    assert.ok(Math.abs(libraryButton.bottom - geometry.document.bottom) < 1);
    assert.ok(Math.abs(libraryButton.left - geometry.document.right - geometry.pairGap) < 1, `Document immediately precedes Library at ${width}`);
    if (Math.abs(geometry.document.top - geometry.input.top) < 1) assert.ok(geometry.document.left >= geometry.buttons['penetration-add-to-schedule'].right, `Document follows Add to Schedule at ${width}`);
    else assert.ok(geometry.document.top >= geometry.input.bottom, `Document and Library wrap below the quantity controls at ${width}`);
    assert.ok(geometry.pageWidth <= width, `Firestopping escaped viewport at ${width}`);
    for (const offset of Object.values(geometry.iconOffsets)) { assert.ok(Math.abs(offset.x) < 1, `Icon is horizontally centred at ${width}`); assert.ok(Math.abs(offset.y) < 1, `Icon is vertically centred at ${width}`); }
    if ([1146, 390].includes(width)) await page.screenshot({ path: path.join(output, `firestopping-controls-${width}.png`), fullPage: true });
    checks.firestoppingViewports.push({ width, geometry });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  const mainSchedule = page.locator('details[aria-labelledby="penetration-estimator-schedule-heading"]'); if (!await mainSchedule.evaluate(element => element.open)) await mainSchedule.locator(':scope > summary').click();
  await expect(fresh).toBeVisible(); await expect(fresh).toHaveAccessibleName('Add new item');
  const style = element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor });
  assert.deepEqual(await fresh.evaluate(style), await page.locator('#penetration-add').evaluate(style), 'Both Firestopping schedules retain the same new-item styling');
  const description = page.locator('#penetration-row-fields [data-penetration-field="T"]'), quantity = page.locator('#penetration-item-quantity [data-penetration-field="O"]');
  for (const [column, value] of [['J', 'Plumbing & Hydraulic'], ['K', 'Copper Pipes'], ['L', 'Core Hole'], ['M', 'Vertical'], ['N', '-/120/120'], ['P', 'Concrete/masonry wall']]) await page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`).selectOption(value);
  await page.locator('#penetration-input-groups').getByRole('tab', { name: 'Products and labour', exact: true }).click();
  const crew = page.locator('#penetration-row-fields [data-penetration-field="W"]'); await crew.selectOption(await crew.locator('option').evaluateAll(options => options.find(option => option.value && !option.disabled).value));
  await page.locator('#penetration-input-groups').getByRole('tab', { name: 'OTHER', exact: true }).click(); const labour = page.locator('#penetration-row-fields [data-penetration-field="AH"]'); await labour.fill('1'); await labour.press('Tab');
  await page.locator('#penetration-input-groups').getByRole('tab', { name: 'DETAILS', exact: true }).click();
  await description.fill('Native button precision item'); await description.press('Tab');
  const calculated = await response(async () => { await quantity.fill('3.123456789'); await quantity.press('Tab'); }, '/api/penetration/calculate', reply => { const inputs = reply.request().postDataJSON()?.draft?.rows?.[0]?.inputs; return inputs?.O === 3.123456789 && inputs?.T === 'Native button precision item'; });
  await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy', 'false'); await idle();
  assert.deepEqual(calculated.rows[0].errors, []); assert.ok(Number.isFinite(calculated.rows[0].outputs.H)); assert.ok(calculated.rows[0].outputs.H > 0, 'The test adds a valid priced labour item');
  const beforeAdd = await snapshot(); await add.click(); await expect(add).toHaveAttribute('aria-busy', 'false'); await idle();
  const afterAdd = await snapshot(); assert.equal(afterAdd.penetration.draft.rows.length, beforeAdd.penetration.draft.rows.length + 1);
  assert.deepEqual(afterAdd.penetration.draft.rows.slice(0, -1), beforeAdd.penetration.draft.rows); const added = afterAdd.penetration.draft.rows.at(-1);
  assert.equal(added.inputs.O, 3.123456789); assert.equal(added.inputs.T, 'Native button precision item'); assert.deepEqual(afterAdd.pricing, beforeAdd.pricing); assert.deepEqual(afterAdd.calculators, beforeAdd.calculators); assert.deepEqual(afterAdd.penetration.draft.globals, beforeAdd.penetration.draft.globals);
  await clear.click(); await expect(description).toHaveValue(''); await expect(quantity).toHaveValue(''); await idle();
  const cleared = await snapshot(); assert.deepEqual(retainedScopes(cleared), retainedScopes(afterAdd)); assert.deepEqual(cleared.penetration.composer.rows[0].inputs, {});
  await response(async () => { await description.fill('Pending current copy'); await description.press('Tab'); }, '/api/penetration/calculate', reply => reply.request().postDataJSON()?.draft?.rows?.[0]?.inputs?.T === 'Pending current copy'); await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy', 'false'); await idle();
  await fresh.click(); await page.getByRole('dialog').getByRole('button', { name: 'New item', exact: true }).click(); await expect(description).not.toHaveValue('Pending current copy'); await idle();
  const renewed = await snapshot(); assert.deepEqual(retainedScopes(renewed), retainedScopes(afterAdd)); assert.notEqual(renewed.penetration.composer.rows[0].inputs.T, 'Pending current copy');
  checks.firestoppingActions = { addInsertsExactlyOneRow: true, scheduleQuantityPrecision: added.inputs.O, unrelatedRowsAndCalculatorsAndPricesRetained: true, clearAffectsOnlyCurrentCopy: true, newItemPreservesScheduleAndSettings: true, matchingScheduleNewItemActions: true, headerNewAndRecalculateHidden: true, requiredDetailsPresentForNewEntry: true, fieldEditCalculatesAutomatically: true };
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  for (const asset of assets) assert.equal(sha256(fs.readFileSync(path.join(root, asset))), assetHashes[asset], 'Sources stayed fixed during the full browser journey');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, port: info.port, disposable: true, assetHashes, checks, consoleErrors: errors, cspViolations: [], limits: ['Synthetic fixture only; no live application or existing project touched.', 'Held Save response verifies captured versus later edits; successful file writes use the real endpoint.'] }, null, 2));
  console.log(JSON.stringify({ passed: true, output, port: info.port }));
})().catch(async error => {
  console.error(error); fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n${logs}`); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
}).finally(async () => { releaseHeld?.(); fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
