// Report/System selection in the shared Firestopping schedules, using only a
// disposable library, database and project. No production port or files.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `penetration-references-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'penetration_references_fixture.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info; server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => { let stdout = ''; const timer = setTimeout(() => reject(Error(`Fixture timeout: ${logs}`)), 120000); server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); } }); server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); }); });
const errors = [], evidence = {}, requests = [];
const snapshot = () => page.evaluate(() => window.CeasefirePenetrations.projectSnapshot());
const row = (id, body = 'penetration-estimator-schedule-body') => page.locator(`#${body} tr[data-penetration-id="${id}"]`);
const settled = () => page.waitForFunction(() => window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy);
const dialog = () => page.getByRole('dialog', { name: 'Choose Technical Library references', exact: true });
async function choose(id) { await row(id).locator('[data-penetration-references]').click(); await expect(dialog()).toBeVisible(); await expect(dialog().getByRole('button', { name: 'Use selected references', exact: true })).toBeEnabled(); }
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); const origin = `http://127.0.0.1:${info.port}`;
  const libraryBytes = fs.readFileSync(path.join(info.library, 'library.json'));
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1450, height: 960 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().includes('/api/libraries/technical?')) requests.push(new URL(request.url()).searchParams.toString()); });
  await page.goto(origin); await settled();
  const initialized = page.waitForResponse(response => response.url().endsWith('/api/project/save-as')); await clickProjectControl(page, 'Save'); assert.equal((await initialized).status(), 200); await settled();
  await chooseCalculator(page, 'Firestopping'); await settled();
  await page.evaluate(async () => {
    const api = window.CeasefirePenetrations, state = api.projectSnapshot();
    const inputs = { J: 'Plumbing & Hydraulic', K: 'Copper Pipes', L: 'Core hole', M: 'Vertical', N: '-/120/120', P: 'Concrete/masonry wall', O: 2.34567890123456, T: 'Synthetic reference item' };
    state.draft.rows = [{ id: 'line-1', library_item_id: 'pkb-001', inputs }, { id: 'line-2', inputs: { ...inputs, T: 'Manual item' } }, { id: 'line-3', inputs: { ...inputs, T: 'Missing reference' }, technical_reference_ids: ['no-longer-present'] }];
    api.applyProject(await api.prepareProject(state)); await api.open();
  }); await settled();
  for (const body of ['penetration-estimator-schedule-body', 'penetration-schedule-body']) {
    await expect(row('line-1', body).locator('.register-report-references')).toHaveText('SYN-00 Rev A | SYN-01 Rev A');
    await expect(row('line-1', body).locator('[data-technical-reference]')).toHaveCount(2);
    assert.deepEqual(await row('line-1', body).locator('[data-technical-reference]').allTextContents(), ['1', '2']);
    await expect(row('line-1', body).locator('.register-report-references a').first()).toHaveAttribute('href', '/api/libraries/documents/report-a.pdf');
  }
  evidence.sharedScheduleAndInheritedLinks = true;
  const original = await snapshot(); await choose('line-2'); assert.ok(requests.some(query => query.includes('orientation=Vertical')), 'Recorded orientation automatically filters the picker');
  await dialog().locator('[data-penetration-reference-clear]').click(); await expect(dialog().getByText('Showing 1–20 of 23 technical records', { exact: true })).toBeVisible();
  await dialog().locator('[data-penetration-reference-choice="system-02"]').check();
  await dialog().locator('.penetration-reference-choice:has([data-penetration-reference-choice="system-02"])').getByRole('button', { name: 'View item', exact: true }).click();
  await expect(dialog().locator('.penetration-reference-preview').filter({ hasText: 'SYN-02 Rev A' })).toBeVisible();
  await expect(dialog().locator('[data-penetration-reference-choice="system-02"]')).toBeChecked(); evidence.previewRetainsSelection = true;
  await dialog().getByRole('button', { name: 'Next', exact: true }).click(); await expect(dialog().locator('[data-penetration-reference-choice="system-22"]')).toBeVisible();
  await dialog().locator('[data-penetration-reference-choice="system-22"]').check(); await dialog().screenshot({ path: path.join(output, 'picker-multiple.png') });
  await page.setViewportSize({ width: 390, height: 764 });
  assert.ok(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Picker stays within narrow screen width');
  await dialog().screenshot({ path: path.join(output, 'picker-narrow.png') }); await page.setViewportSize({ width: 1450, height: 960 }); evidence.narrowPicker = true;
  await dialog().getByRole('button', { name: 'Use selected references', exact: true }).click(); await expect(dialog()).toHaveCount(0); await settled();
  await expect(row('line-2').locator('.register-report-references')).toHaveText('SYN-02 Rev A | SYN-22 Rev A');
  const chosen = await snapshot(); assert.deepEqual(chosen.draft.rows[1].technical_reference_ids, ['system-02', 'system-22']); assert.deepEqual(chosen.draft.rows[1].inputs, original.draft.rows[1].inputs);
  evidence.manualSelectionAcrossPages = true;
  await choose('line-3'); await expect(dialog().getByText('1. no-longer-present', { exact: true })).toBeVisible(); await dialog().getByRole('button', { name: /^Remove system / }).click(); await dialog().getByRole('button', { name: 'Use selected references', exact: true }).click(); await expect(dialog()).toHaveCount(0); await settled(); assert.deepEqual((await snapshot()).draft.rows[2].technical_reference_ids, []); evidence.missingReferenceExplicitRemoval = true;
  const priorCancel = await snapshot(); await choose('line-2'); await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); assert.deepEqual(await snapshot(), priorCancel);
  await choose('line-2'); await page.evaluate(() => { const api = window.CeasefirePenetrations; return api.prepareProject(api.projectSnapshot()).then(state => api.applyProject(state)); });
  await dialog().getByRole('button', { name: 'Use selected references', exact: true }).click(); await expect(dialog()).toContainText('schedule item changed'); await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); assert.deepEqual(await snapshot(), priorCancel); evidence.staleDialogRejected = true;
  const quantity = row('line-2').locator('[data-penetration-field="O"]'); await quantity.fill('4.98765432109876'); await quantity.press('Tab'); await settled(); assert.deepEqual((await snapshot()).draft.rows[1].technical_reference_ids, ['system-02', 'system-22']);
  const retained = await snapshot(), save = page.waitForResponse(response => ['/api/project/save', '/api/project/save-as'].includes(new URL(response.url()).pathname)); await clickProjectControl(page, 'Save'); assert.equal((await save).status(), 200); await settled();
  const opening = page.waitForResponse(response => response.url().endsWith('/api/project/open')); await clickProjectControl(page, 'Load'); assert.equal((await opening).status(), 200); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await chooseCalculator(page, 'Firestopping'); await settled();
  assert.deepEqual(await snapshot(), retained); evidence.saveOpenExact = true;
  const systemDetail = page.waitForResponse(response => response.url().endsWith('/api/libraries/technical/system-22'));
  await row('line-2').locator('[data-technical-reference="system-22"]').click(); assert.equal((await (await systemDetail).json()).id, 'system-22'); await expect(page.locator('#technical-library-detail-heading')).toBeVisible(); assert.deepEqual(await snapshot(), retained); evidence.systemNavigationExact = true;
  await chooseCalculator(page, 'Firestopping'); await settled(); await choose('line-1'); await dialog().getByRole('button', { name: /^Remove system / }).first().click(); await dialog().getByRole('button', { name: 'Use selected references', exact: true }).click(); await expect(dialog()).toHaveCount(0); await settled();
  await expect(row('line-1').locator('.register-report-references')).toHaveText('SYN-01 Rev A'); await choose('line-1'); await dialog().getByRole('button', { name: 'Use linked references', exact: true }).click(); await expect(dialog()).toHaveCount(0); await settled(); await expect(row('line-1').locator('.register-report-references')).toHaveText('SYN-00 Rev A | SYN-01 Rev A'); assert.equal(Object.hasOwn((await snapshot()).draft.rows[0], 'technical_reference_ids'), false); evidence.restoreInheritance = true;
  // The Details select uses the exact live main-library Report choices, including groups.
  await page.evaluate(() => window.CeasefireLibraryNavigation.open('technical', { list: true }));
  const mainReports = page.locator('#technical-library-workspace [data-library-filter="report"]'); await expect(mainReports).toBeVisible();
  const options = control => control.locator('option').evaluateAll(nodes => nodes.filter(node => node.value).map(node => ({ value: node.value, label: node.textContent, group: node.parentElement.tagName === 'OPTGROUP' ? node.parentElement.label : '' })));
  const expectedReports = await options(mainReports); assert.equal(expectedReports.length, 23);
  await chooseCalculator(page, 'Firestopping'); await settled();
  await row('line-2').getByRole('button', { name: 'Edit firestopping item 2', exact: true }).click();
  const reportChoice = page.locator('[data-penetration-report]'); await expect(reportChoice).toBeEnabled(); assert.deepEqual(await options(reportChoice), expectedReports);
  const beforeReport = await snapshot(); await reportChoice.selectOption('SYN-05 Rev A'); await settled();
  assert.equal((await snapshot()).composer.rows[0].report_reference, 'SYN-05 Rev A');
  assert.deepEqual((await snapshot()).composer.rows[0].inputs, beforeReport.composer.rows[0].inputs);
  await reportChoice.selectOption('SYN-06 Rev A'); await settled(); await page.locator('#penetration-update-schedule').click(); await settled();
  await expect(row('line-2').locator('.register-report-references')).toHaveText('SYN-02 Rev A | SYN-22 Rev A | SYN-06 Rev A');
  assert.deepEqual((await snapshot()).draft.rows[1].technical_reference_ids, ['system-02', 'system-22']);
  await choose('line-2'); await expect(dialog().locator('[data-penetration-reference-filter="report"]')).toHaveValue('SYN-06 Rev A'); await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  const savedReport = await snapshot(), saveReport = page.waitForResponse(response => ['/api/project/save', '/api/project/save-as'].includes(new URL(response.url()).pathname)); await clickProjectControl(page, 'Save'); assert.equal((await saveReport).status(), 200); await settled();
  const reopenReport = page.waitForResponse(response => response.url().endsWith('/api/project/open')); await clickProjectControl(page, 'Load'); assert.equal((await reopenReport).status(), 200); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await chooseCalculator(page, 'Firestopping'); await settled(); assert.deepEqual(await snapshot(), savedReport);
  await row('line-2').getByRole('button', { name: 'Edit firestopping item 2', exact: true }).click();
  // Reopening a saved current item can require acknowledging replacement.
  const confirmEdit = page.getByRole('dialog').getByRole('button', { name: 'Edit item', exact: true }); await expect(confirmEdit).toBeVisible(); await confirmEdit.click();
  await expect(page.locator('#penetration-update-schedule')).toBeVisible();
  await expect(reportChoice).toHaveValue('SYN-06 Rev A'); await reportChoice.selectOption(''); await settled(); assert.equal(Object.hasOwn((await snapshot()).composer.rows[0], 'report_reference'), false); await page.locator('#penetration-update-schedule').click(); await settled();
  await expect(row('line-2').locator('.register-report-references')).toHaveText('SYN-02 Rev A | SYN-22 Rev A'); assert.equal(Object.hasOwn((await snapshot()).draft.rows[1], 'report_reference'), false);
  evidence.reportDropdownExactOptionsAndGrouping = true; evidence.reportOnlyChoicePreservesSystemsAndInputs = true; evidence.reportChoiceChangeClearAndSaveReopen = true;
  await row('line-1').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'shared-schedule.png') });
  assert.deepEqual(fs.readFileSync(path.join(info.library, 'library.json')), libraryBytes); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, librarySha256: crypto.createHash('sha256').update(libraryBytes).digest('hex') }, null, 2)); console.log(`PASS: Firestopping Report/System picker and persistence. ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-2000)); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, evidence, errors }, null, 2)); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill(); });
