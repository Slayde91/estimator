const { chooseLibrary } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Rendered project-only library preservation. Every file, database and dialog
// target is owned by the disposable synthetic fixture below.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), python = process.env.CEASEFIRE_PYTHON || 'python';
const output = path.join(root, '.runtime/browser-qa', `project-library-drafts-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(__dirname, 'project_library_fixture.py');
const server = spawn(python, [fixture, '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
function choose(mode) { fs.writeFileSync(path.join(output, 'dialog-mode.json'), JSON.stringify(mode)); }
function sharedDatabase() {
  const result = spawnSync(python, [fixture, '--snapshot-database', info.database], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Drawing sessions are separate draft state. Include every shared pricing,
  // quote, calculator and library table in this preservation comparison.
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).filter(([name]) => !name.startsWith('takeoff')));
}
async function api(pathname) { const response = await page.request.get(`http://127.0.0.1:${info.port}${pathname}`); assert.equal(response.status(), 200, await response.text()); return response.json(); }
async function reply(action, pathname) {
  const pending = page.waitForResponse(value => new URL(value.url()).pathname === pathname); pending.catch(() => {});
  await action(); const response = await pending, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body;
}
async function load(seed = false) {
  choose({ seed }); await reply(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
}
async function libraryIdle() { await expect.poll(() => page.evaluate(() => window.CeasefireLibraryEditor.hasPendingOperation())).toBe(false); }
async function picture() {
  const image = page.locator('#library-editor-diagram-image');
  await expect(image).toBeVisible(); await expect.poll(() => image.evaluate(value => value.complete && value.naturalWidth > 0)).toBe(true);
  return image.getAttribute('src');
}
async function independentDrafts() { return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot() })); }
async function enterLibraries() { await page.getByRole('button', { name: 'Libraries', exact: true }).click(); }
async function openProjectCopy() {
  await enterLibraries(); await chooseLibrary(page, 'penetration');
  const section = page.getByRole('region', { name: 'Project library drafts', exact: true });
  await expect(section).toBeVisible(); await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'project-library-list.png') });
  await section.locator(`[data-project-library-draft="${info.item_id}"]`).click();
  await expect(page.locator('#library-editor-save')).toHaveText('Keep in project draft');
  await expect(page.locator('.library-editor-scope')).toHaveText('These library edits stay within the current project. Use Save or Save As to store them in its file.');
  await expect(page.locator('#library-editor-pricing-heading')).toHaveText('Project library price');
}

(async () => {
  info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  // Bootstrap exposes project tools before the initial Firestopping draft has
  // finished loading. Let it settle before capturing the first Load revision.
  await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; });
  await load(true);
  const retained = await independentDrafts(), seed = JSON.parse(fs.readFileSync(info.seed, 'utf8'));
  assert.equal(retained.penetration.composer.rows[0].inputs.T, 'Unscheduled composer retained');
  assert.equal(retained.penetration.composer.rows[0].inputs.O, 3);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await page.getByLabel('Client', { exact: true }).fill('Project copy client');
  const sharedBefore = await api(`/api/libraries/penetration/${info.item_id}/edit`), databaseBefore = sharedDatabase();
  const originalSource = fs.readFileSync(path.join(output, 'reference-library/library.json'));
  const originalImage = fs.readFileSync(info.diagram);
  const uploadPath = path.join(output, 'project-diagram.png');
  const imageFixture = spawnSync(python, ['-c', "from PIL import Image, ImageDraw; import sys; im=Image.new('RGB',(640,360),'#edf4ff'); d=ImageDraw.Draw(im); d.rectangle((40,45,600,305),outline='#19678f',width=9); d.ellipse((235,95,405,265),fill='#cb0018'); d.text((55,20),'SYNTHETIC PROJECT-ONLY DIAGRAM',fill='#102d48'); im.save(sys.argv[1],format='PNG')", uploadPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(imageFixture.status, 0, imageFixture.stderr);

  await enterLibraries(); await chooseLibrary(page, 'pricing');
  await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first();
  const priceIdentity = await price.evaluate(control => ({ id: control.closest('tr').dataset.priceId, kind: control.closest('tr').dataset.priceKind }));
  await price.fill('789.12'); await price.press('Tab');
  await chooseLibrary(page, 'penetration');
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator(`[data-library-edit="${info.item_id}"]`).first().click();
  await expect(page.locator('#firestopping-library-editor')).toBeVisible();
  const description = page.locator('[data-library-editor-field="T"]'), quantity = page.locator('[data-library-editor-field="O"]');
  await description.fill('Project-only edited library item');
  await quantity.fill('2.125'); await quantity.press('Tab');
  await page.locator('#library-editor-diagram-file').setInputFiles(uploadPath);
  await libraryIdle(); await picture();
  await page.locator('#library-editor-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'library-edits-before-project-save.png') });
  choose({});
  // Save immediately after a fresh edit: no Recalculate button or manual delay
  // is required to collect the pending library draft.
  await description.fill('Project-only edited library item saved immediately');
  const firstSave = await reply(() => clickProjectControl(page, 'Save As'), '/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await expect(page.locator('#library-editor-save')).toHaveText('Keep in project draft');
  const first = JSON.parse(fs.readFileSync(info.project, 'utf8')), copy = first.library_drafts.records[0];
  assert.equal(copy.id, info.item_id); assert.equal(copy.draft.rows[0].inputs.T, 'Project-only edited library item saved immediately'); assert.equal(copy.draft.rows[0].inputs.O, 2.125);
  assert.equal(copy.diagram.filename, `${info.item_id}.jpg`);
  assert.notDeepEqual(Buffer.from(copy.diagram.content_base64, 'base64'), originalImage, 'Uploaded project diagram is retained as its validated JPEG');
  assert.match(await picture(), /^data:image\/jpeg;base64,/);
  assert.equal(first.estimate.configuration[priceIdentity.kind][priceIdentity.id].supplier_price, 789.12);
  assert.equal(first.estimate.client, 'Project copy client'); assert.equal(first.estimate.measurements, seed.estimate.measurements);
  assert.deepEqual(await independentDrafts(), retained); assert.deepEqual(first.calculators, seed.calculators);
  assert.deepEqual(first.penetration, seed.penetration);
  assert.deepEqual(await api(`/api/libraries/penetration/${info.item_id}/edit`), sharedBefore);
  assert.deepEqual(sharedDatabase(), databaseBefore);
  assert.deepEqual(fs.readFileSync(path.join(output, 'reference-library/library.json')), originalSource);
  assert.deepEqual(fs.readFileSync(info.diagram), originalImage);
  evidence.firstSave = { file: firstSave.file.path, libraryId: copy.id, quantity: copy.draft.rows[0].inputs.O, pricing: priceIdentity, sharedDatabaseUnchanged: true, sharedLibraryUnchanged: true, independentDraftsPreserved: true };
  console.log('Top Save As captured shared pricing and library edits only in this project; shared database and independent drafts remain unchanged.');

  await quantity.fill('4.875'); await quantity.press('Tab');
  await reply(() => clickProjectControl(page, 'Save'), '/api/project/save');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const second = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  assert.equal(second.library_drafts.records[0].draft.rows[0].inputs.O, 4.875);
  assert.deepEqual(second.library_drafts.records[0].diagram, copy.diagram);
  assert.deepEqual(sharedDatabase(), databaseBefore);
  assert.deepEqual(await api(`/api/libraries/penetration/${info.item_id}/edit`), sharedBefore);
  await page.locator('#library-editor-save').click(); await expect(page.locator('#firestopping-library-editor')).toBeHidden();
  await openProjectCopy(); await picture();
  await page.screenshot({ path: path.join(output, 'project-library-copy-saved.png') });
  await page.locator('#library-editor-cancel').click();

  // Remove only the synthetic fixture's shared record to prove the project is
  // self-contained and does not silently rebind to shared storage on reopen.
  const deleted = await page.request.post(`http://127.0.0.1:${info.port}/api/libraries/penetration/${info.item_id}/delete`, { data: {} });
  assert.equal(deleted.status(), 200, await deleted.text());
  assert.equal((await page.request.get(`http://127.0.0.1:${info.port}/api/libraries/penetration/${info.item_id}/edit`)).status(), 404);
  const afterDelete = sharedDatabase();
  await load(false);
  await page.evaluate(() => window.CeasefireLibraries.invalidate());
  const sharedReads = requests.filter(request => request.path === `/api/libraries/penetration/${info.item_id}/edit`).length;
  await openProjectCopy();
  await expect(description).toHaveValue('Project-only edited library item saved immediately');
  await quantity.focus(); await expect(quantity).toHaveValue('4.875');
  assert.match(await picture(), /^data:image\/jpeg;base64,/);
  assert.equal(requests.filter(request => request.path === `/api/libraries/penetration/${info.item_id}/edit`).length, sharedReads);
  assert.deepEqual(await independentDrafts(), retained);
  assert.deepEqual(sharedDatabase(), afterDelete);
  assert.deepEqual(fs.readFileSync(path.join(output, 'reference-library/library.json')), originalSource);
  assert.deepEqual(fs.readFileSync(info.diagram), originalImage);
  await page.locator('#library-editor-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'reopened-orphan-project-copy.png') });
  const csp = await page.evaluate(() => window.qaCsp);
  assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  assert.equal(requests.some(request => request.method === 'POST' && /\/api\/libraries\/penetration\/[^/]+\/save$/.test(request.path)), false);
  assert.equal(requests.some(request => request.method === 'POST' && request.path === '/api/configuration'), false);
  evidence.secondSave = { quantity: 4.875, diagramBytesUnchanged: true };
  evidence.reopen = { sourceSharedRecordDeleted: true, projectCopyOpenedWithoutSharedRead: true, actualDiagramRendered: true, quoteCalculatorsComposerPreserved: true };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, viewport: page.viewportSize(), fixture: info, evidence, errors, csp, requests, sharedBefore: databaseBefore, sharedAfterFixtureDelete: afterDelete }, null, 2));
  console.log(`PASS: rendered project library capture, pricing isolation, second Save, orphan reopen and image preservation. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
