// Rendered manual topology and retained-image workflow. All sources and storage are disposable.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime', 'browser-qa', `penetrations-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, state;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], inventoryRequests = [];
const activeGraph = () => state.snapshot.physical;
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true'); }
async function response(action, suffix) {
  const pending = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix)); pending.catch(() => {}); await action();
  const reply = await pending, result = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(result)); return result;
}
async function dialog(title, values, submit) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) { const field = modal.getByLabel(label, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value)); }
  await modal.getByRole('button', { name: submit, exact: true }).click();
}
async function apply(title) { state = await response(() => dialog(title, {}, 'Apply draft change'), '/physical/apply'); await idle(); return state; }
async function create(kind, values, trigger = `Add ${kind}`) {
  await idle(); await page.getByRole('button', { name: trigger, exact: true }).click();
  const preview = await response(() => dialog(`Create draft ${kind}`, { ...values, 'Uncertainty / review state': 'human_review_required' }, 'Preview new draft'), '/physical/preview');
  assert.equal(preview.changed_ids.length, 1); await apply(`Create one draft ${kind}?`); return preview.changed_ids[0];
}
async function select(id) { await idle(); await page.locator(`tr[data-physical-id="${id}"] .takeoff-row-link`).click(); await idle(); }
async function undo() { await page.getByRole('button', { name: 'Undo physical / takeoff edit', exact: true }).click(); state = await response(() => dialog('Undo last takeoff edit?', {}, 'Undo last edit'), '/commands'); await idle(); }
async function extract() { state = await response(() => page.getByRole('button', { name: 'Extract images from selected PDF page', exact: true }).click(), '/images/extract'); await idle(); return state.extraction_id; }
async function showImage() {
  const card = page.locator('details[data-image-occurrence]').first(); await card.locator('summary').click();
  await expect(card.locator('img')).toBeVisible(); await expect.poll(() => card.locator('img').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0); return card;
}
(async () => {
  const info = await ready; browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/images') && request.method() === 'GET') inventoryRequests.push({ extraction: url.searchParams.get('extraction_id'), limit: url.searchParams.get('limit') }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible(); const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('[data-mode="physical"]').click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeHidden(); await expect(page.getByRole('button', { name: 'Preview transfer', exact: true })).toBeHidden();
  await page.locator('#takeoff-upload').setInputFiles(info.physical_fixture); await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  const firstExtraction = await extract(); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3);
  assert.equal(state.snapshot.physical, null);
  // The UI's retained-image display is the acceptance surface; source metadata is also checked exactly below.
  let card = await showImage(); await page.screenshot({ path: path.join(output, 'retained-bitmap.png'), fullPage: true });
  const barrier = await create('barrier', { 'Barrier label': 'B-01', 'Location': 'L02 north', 'Barrier type': 'Wall', 'Substrate': 'Concrete', 'Substrate orientation': 'Vertical', 'Thickness (mm)': 150 });
  const defect = await create('defect', { 'Defect label': 'D-001', 'Location': 'L02 north', 'FRL': '-/120/120' }, 'Add defect below this barrier');
  const empty = await create('opening', { 'Opening label': 'O-EMPTY', 'Opening type': 'Corehole', 'Opening size / source designation': '100 mm' }, 'Add opening below this defect');
  await expect(page.locator(`tr[data-physical-id="${empty}"]`)).toContainText('Empty opening — 0 services');
  await select(defect); const occupied = await create('opening', { 'Opening label': 'O-MIXED', 'Opening type': 'Corehole', 'Opening size / source designation': '150 mm' }, 'Add opening below this defect');
  const pipe = await create('service', { 'Service label': 'S-PIPE', 'Service': 'Copper pipe', 'Service type': 'Copper', 'Service size / source designation': '25 mm', 'Explicit service quantity': 1 }, 'Add service below this opening');
  await select(occupied); const cable = await create('service', { 'Service label': 'S-CABLE', 'Service': 'Cable', 'Service type': 'Electrical cable', 'Service size / source designation': '3 separate cables', 'Explicit service quantity': 3 }, 'Add service below this opening');
  assert.equal(activeGraph().barriers.length, 1); assert.equal(activeGraph().defects.length, 1); assert.equal(activeGraph().openings.length, 2); assert.equal(activeGraph().services.length, 2); assert.equal(activeGraph().services.reduce((sum, entity) => sum + entity.quantity, 0), 4);
  assert.ok(activeGraph().services.every(entity => entity.opening_id === occupied));
  card = page.locator('details[data-image-occurrence]').first(); await card.getByRole('button', { name: 'Link image to selected record', exact: true }).click();
  await response(() => dialog('Associate retained image evidence', { 'Supported field': 'service_type', 'Evidence note / source interpretation': 'Synthetic repeated view: cables belong to O-MIXED; three cables are explicitly recorded, not counted from photographs.' }, 'Preview evidence link'), '/physical/preview');
  await apply('Link retained image to draft record?'); const evidence = activeGraph().services.find(entity => entity.id === cable).evidence[0]; assert.match(evidence.image_sha256, /^[a-f0-9]{64}$/); assert.equal(evidence.document_sha256, state.snapshot.documents[0].sha256); assert.equal(evidence.region.length, 4);
  await select(cable); await expect(page.locator(`.takeoff-hit[data-physical-id="${cable}"]`)).toHaveCount(1);
  await page.locator(`tr[data-physical-id="${cable}"] .takeoff-row-link`).hover(); await expect(page.locator('.takeoff-physical-shape')).toHaveClass(/hovered/);
  state = await response(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), '/commands'); await idle();
  await page.locator(`.takeoff-hit[data-physical-id="${cable}"]`).hover(); await expect(page.locator(`tr[data-physical-id="${cable}"]`)).toHaveClass(/hovered/);
  await page.getByLabel('Filter physical hierarchy', { exact: true }).fill('S-CABLE'); await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(4); await expect(page.locator(`tr[data-physical-id="${barrier}"]`)).toContainText('Ancestor context'); await page.getByLabel('Filter physical hierarchy', { exact: true }).fill('');
  const notes = page.getByRole('complementary', { name: 'Physical draft inspector' }).getByLabel('Notes', { exact: true });
  await notes.fill('Unapplied inspection finding must remain visible'); const frl = page.getByLabel('FRL for D-001', { exact: true }); await frl.fill('-/90/90'); await frl.press('Tab');
  await expect(page.getByRole('alert')).toContainText('Those edits have been preserved'); await expect(notes).toHaveValue('Unapplied inspection finding must remain visible'); await expect(frl).toHaveValue('-/120/120');
  await page.getByRole('button', { name: 'Discard unfinished physical edits', exact: true }).click(); await expect(notes).toHaveValue('');
  await frl.fill('-/90/90'); await frl.press('Tab'); await apply('Change defect frl?'); assert.equal(activeGraph().defects[0].fields.frl, '-/90/90'); await undo(); assert.equal(activeGraph().defects[0].fields.frl, '-/120/120');
  await page.getByRole('button', { name: 'Clear physical selection', exact: true }).click(); await page.getByLabel('Select Service S-PIPE', { exact: true }).check(); await page.getByLabel('Select Service S-CABLE', { exact: true }).check();
  await page.getByRole('button', { name: 'Bulk edit same-type records', exact: true }).click(); const bulk = await response(() => dialog('Edit 2 draft service records', { 'Field to change': 'notes', 'New value (blank clears unknown properties)': 'One reviewed draft edit batch' }, 'Preview bulk edit'), '/physical/preview'); assert.equal(bulk.changed_ids.length, 2);
  await apply('Change 2 of 2 selected records? 0 already match and stay unchanged.'); assert.ok(activeGraph().services.every(entity => entity.fields.notes === 'One reviewed draft edit batch')); await undo(); assert.ok(activeGraph().services.every(entity => !entity.fields.notes)); assert.deepEqual(activeGraph().services.find(entity => entity.id === cable).evidence[0], evidence);
  await select(occupied); await page.getByRole('button', { name: 'Delete draft record', exact: true }).click(); const deletion = await response(() => dialog('Delete draft opening', { 'Deletion scope': 'cascade' }, 'Preview deletion'), '/physical/preview'); assert.equal(deletion.changed_ids.length, 3); await apply('Review recoverable deletion'); assert.ok(activeGraph().services.every(entity => entity.deleted)); assert.equal(activeGraph().openings.find(entity => entity.id === empty).deleted, false);
  await page.getByLabel('Show deleted records', { exact: true }).check(); await select(occupied); await page.getByRole('button', { name: 'Restore draft record', exact: true }).click(); await response(() => dialog('Restore draft opening', { 'Restore scope': 'same_deletion' }, 'Preview restoration'), '/physical/preview'); await apply('Review retained identities to restore'); assert.ok(activeGraph().services.every(entity => !entity.deleted)); assert.deepEqual(activeGraph().services.map(entity => entity.id).sort(), [pipe, cable].sort());
  await select(cable); await page.getByRole('button', { name: 'Physical / takeoff audit history', exact: true }).click(); const history = page.getByRole('dialog'); await expect(history.getByRole('heading')).toContainText('Takeoff audit history'); await expect(history).toContainText(occupied); await history.getByRole('button', { name: 'Continue', exact: true }).click(); await page.screenshot({ path: path.join(output, 'physical-hierarchy.png'), fullPage: true });
  state = await response(() => page.getByRole('button', { name: 'Page ›', exact: true }).click(), '/commands'); await idle(); const emptyExtraction = await extract(); assert.notEqual(emptyExtraction, firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(0); await expect(page.getByRole('region', { name: 'Retained image gallery' })).toContainText('0 retained image occurrences');
  await page.getByLabel('Retained image extraction', { exact: true }).selectOption(firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3); await showImage();
  const save = await response(() => page.getByRole('button', { name: 'Save As', exact: true }).click(), '/api/project/save-as'); assert.ok(save); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.version, 2); assert.equal(saved.takeoffs.version, 2); assert.equal(saved.takeoffs.items.length, 0); assert.equal(saved.takeoffs.image_extractions.length, 2); assert.deepEqual(saved.takeoffs.physical.services.map(entity => entity.id).sort(), [pipe, cable].sort());
  // A later keystroke in an already-dirty form must defeat a delayed native load.
  await select(cable); await notes.fill('First pending note'); let releaseRead, readReady;
  const holdRead = new Promise(resolve => { releaseRead = resolve; }), reachedRead = new Promise(resolve => { readReady = resolve; });
  await page.route('**/api/project/open', async route => { const reply = await route.fetch(); readReady(); await holdRead; await route.fulfill({ response: reply }); });
  await page.getByRole('button', { name: 'Load', exact: true }).click(); await reachedRead; await notes.fill('Later pending note must survive the load race'); releaseRead();
  await expect(page.getByText('Project was not loaded. Your draft changed while reading the file. Load it again when ready.', { exact: true })).toBeVisible(); await expect(notes).toHaveValue('Later pending note must survive the load race'); await page.unroute('**/api/project/open'); await page.getByRole('button', { name: 'Discard unfinished physical edits', exact: true }).click();
  await response(() => page.getByRole('button', { name: 'Load', exact: true }).click(), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('[data-mode="physical"]').click(); await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(6); await select(cable); await page.getByLabel('Retained image extraction', { exact: true }).selectOption(firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3); await showImage();
  for (const format of ['CSV', 'XLSX']) { await page.getByRole('button', { name: `Export draft ${format}`, exact: true }).click(); const download = page.waitForEvent('download'); await dialog('Export unapproved physical draft?', {}, 'Export unapproved draft'); const file = await download; assert.ok(file.suggestedFilename().includes('UNAPPROVED-DRAFT')); const filename = path.join(output, file.suggestedFilename()); await file.saveAs(filename); assert.ok(fs.statSync(filename).size > 100); if (format === 'CSV') { const csv = fs.readFileSync(filename, 'utf8'); for (const value of [barrier, defect, empty, occupied, pipe, cable, evidence.image_sha256, 'UNAPPROVED DRAFT']) assert.ok(csv.includes(value), value); } await idle(); }
  assert.ok(inventoryRequests.length); assert.ok(inventoryRequests.every(request => request.extraction && request.limit === '100')); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.screenshot({ path: path.join(output, 'reopened-draft.png'), fullPage: true });
  await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'drawing-viewport.png') });
  await page.getByRole('heading', { name: 'PENETRATIONS — PHYSICAL DRAFT', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'register-viewport.png') });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, ids: { barrier, defect, empty, occupied, pipe, cable }, evidence, firstExtraction, emptyExtraction, inventoryRequests, errors, csp: [], unfinished_edit_preserved: true, delayed_load_race_rejected: true }, null, 2));
  console.log(`PASS: explicit physical hierarchy, empty and occupied openings, retained repeated bitmap, exact evidence tuple, hover/selection/filter, bulk/undo, cascade/restore, scoped coverage, Save As/reopen and unapproved CSV/XLSX; calculators unchanged. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
