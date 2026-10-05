const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Rendered manual topology and retained-image workflow. All sources and storage are disposable.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime', 'browser-qa', `penetrations-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output, '--physical-legacy'], { cwd: root, windowsHide: true });
let logs = '', browser, page, state, physicalChoices;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], inventoryRequests = [], physicalRequests = [], automaticFieldChecks = {};
const activeGraph = () => state.snapshot.physical;
const records = () => ['defects', 'barriers', 'services'].flatMap(kind => activeGraph()[kind]);
const record = id => records().find(entity => entity.id === id);
const identities = () => records().map(({ id, display_id }) => ({ id, display_id })).sort((a, b) => a.display_id.localeCompare(b.display_id));
async function identifier(id, display) {
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(record(id).display_id, display);
  await expect(page.locator(`tr[data-physical-id="${id}"]`)).toContainText(display);
}
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true'); }
async function canonicalState() {
  const reply = await page.request.get(await page.evaluate(() => `${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`));
  assert.equal(reply.status(), 200); return reply.json();
}
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
async function dropdown(control, expected) {
  assert.equal(await control.evaluate(element=>element.tagName), 'SELECT');
  assert.deepEqual(await control.locator('option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean)), expected);
}
async function physicalForm(kind, scope) {
  if (kind === 'barrier') {
    for (const label of ['Barrier label', 'Thickness (mm)']) await expect(scope.getByLabel(label, { exact: true })).toHaveCount(0);
    await dropdown(scope.getByLabel('Barrier type', { exact: true }), ['Empty Opening', 'Core hole', 'Oversized']);
    await dropdown(scope.getByLabel('Substrate', { exact: true }), physicalChoices.substrate);
    await dropdown(scope.getByLabel('Substrate orientation', { exact: true }), physicalChoices.orientation);
  } else if (kind === 'service') {
    await expect(scope.getByLabel('Service label', { exact: true })).toHaveCount(0);
    await dropdown(scope.getByLabel('Category', { exact: true }), physicalChoices.service);
    await dropdown(scope.getByLabel('Service type', { exact: true }), physicalChoices.service_type);
    await expect(scope.getByLabel('Service Size (mm)', { exact: true })).toBeVisible();
    const names=await scope.locator('input, select, textarea').evaluateAll(controls=>controls.map(control=>control.name));
    assert.equal(names.indexOf('quantity'), names.indexOf('service_type')+1, 'Service quantity follows Service type');
  }
}
async function create(kind, values, trigger = `Add ${kind}`) {
  await idle(); await page.getByRole('button', { name: trigger, exact: true }).click();
  const modal=page.getByRole('dialog');await expect(modal.getByRole('heading', { name:`Create draft ${kind}`,exact:true })).toBeVisible();await physicalForm(kind,modal);
  if(kind==='barrier'||kind==='service')await modal.screenshot({path:path.join(output,`create-${kind}-form.png`)});
  const preview = await response(() => dialog(`Create draft ${kind}`, { ...values, 'Uncertainty / review state': 'human_review_required' }, 'Preview new draft'), '/physical/preview');
  assert.equal(preview.changed_ids.length, 1); await apply(`Create one draft ${kind}?`);await physicalForm(kind,page.getByRole('complementary',{name:'Item Details'}));return preview.changed_ids[0];
}
async function select(id) { await idle(); await page.locator(`tr[data-physical-id="${id}"] .takeoff-row-link`).click(); await idle(); }
// Undo remains an API compatibility operation after its physical toolbar shortcut is removed.
async function undo() {
  state = await page.evaluate(async () => {
    const takeoffs=window.CeasefireTakeoffs, session=takeoffs.sessionId(), current=takeoffs.projectSnapshot();
    const reply=await fetch(`/api/takeoffs/sessions/${session}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:current.revision,request_id:crypto.randomUUID(),op:'undo'})});
    const result=await reply.json();if(!reply.ok)throw new Error(JSON.stringify(result));
    takeoffs.applyProject(await takeoffs.prepareProject(result.snapshot,session));await takeoffs.open();return result;
  }); await idle();
}
async function extract() { state = await response(() => page.getByRole('button', { name: 'Extract images from selected PDF page', exact: true }).click(), '/images/extract'); await idle(); return state.extraction_id; }
async function showImage() {
  const card = page.locator('details[data-image-occurrence]').first(); await card.locator('summary').click();
  await expect(card.locator('img')).toBeVisible(); await expect.poll(() => card.locator('img').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0); return card;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765, 'Browser QA must use disposable storage and a random port'); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/images') && request.method() === 'GET') inventoryRequests.push({ extraction: url.searchParams.get('extraction_id'), limit: url.searchParams.get('limit') }); if (/\/physical\/(preview|apply)$/.test(url.pathname)) physicalRequests.push({ path: url.pathname, body: request.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready); await expect.poll(() => page.evaluate(() => window.CeasefireDesktop?.status().ready)).toBe(true); const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const definitionReply=await page.request.post(`http://127.0.0.1:${info.port}/api/penetration/definition`,{data:{configuration:await page.evaluate(()=>window.CeasefireProject.configuration())}});assert.equal(definitionReply.status(),200);
  const definition=await definitionReply.json();physicalChoices=Object.fromEntries(Object.entries({substrate:'P',orientation:'M',service:'J',service_type:'K',frl:'N'}).map(([key,column])=>[key,definition.row_fields.find(field=>field.column===column).options]));
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeHidden(); await expect(page.getByRole('button', { name: 'Preview transfer', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add defect', exact: true })).toBeVisible();
  assert.deepEqual((await page.getByRole('table', { name: 'Draft penetration hierarchy register' }).getByRole('columnheader').allTextContents()).slice(0, 4), ['Select', 'Defect ID', 'Barrier ID', 'Service ID']);
  for (const kind of ['barrier', 'opening', 'service']) await expect(page.getByRole('button', { name: `Add ${kind}`, exact: true })).toHaveCount(0);
  await page.locator('#takeoff-upload').setInputFiles(info.physical_v2_fixture); await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  const firstExtraction = await extract(); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3);
  assert.equal(state.snapshot.physical, null);
  // The UI's retained-image display is the acceptance surface; source metadata is also checked exactly below.
  let card = await showImage(); await page.screenshot({ path: path.join(output, 'retained-bitmap.png'), fullPage: true });
  const defect = await create('defect', { 'Defect Ref.': 'D-001', 'Location': 'L02 north', 'FRL': '-/120/120' }); await identifier(defect, 'D-0001');
  const barrierFields = { 'Location': 'L02 north', 'Barrier type': 'Core hole', 'Substrate': 'Concrete/masonry wall', 'Substrate orientation': 'Vertical' };
  const empty = await create('barrier', barrierFields, 'Add barrier to D-0001'); await identifier(empty, 'B-0001');
  for(const field of ['label','thickness_mm'])assert.equal(Object.hasOwn(record(empty).fields,field),false);
  await dropdown(page.getByLabel('Substrate for B-0001',{exact:true}),physicalChoices.substrate);await dropdown(page.getByLabel('Substrate orientation for B-0001',{exact:true}),physicalChoices.orientation);
  await expect(page.locator(`tr[data-physical-id="${empty}"]`)).toContainText('0 services');
  const otherDefect = await create('defect', { 'Defect Ref.': 'OTHER-DEFECT', 'Location': 'L03 south' }); await identifier(otherDefect, 'D-0002');
  // The row that owns '+' is the parent, regardless of the currently selected row.
  await select(otherDefect);
  const occupied = await create('barrier', barrierFields, 'Add barrier to D-0001'); await identifier(occupied, 'B-0002');
  assert.equal(record(occupied).defect_id, defect); assert.equal(record(empty).defect_id, defect);
  const serviceFields = { 'Category': 'Plumbing & Hydraulic', 'Service type': 'Copper Pipes', 'Service Size (mm)': '25', 'Explicit service quantity': 1 };
  const pipe = await create('service', serviceFields, 'Add service to B-0002'); await identifier(pipe, 'S-0001');
  assert.equal(Object.hasOwn(record(pipe).fields,'label'),false);await dropdown(page.getByLabel('Category for S-0001',{exact:true}),physicalChoices.service);await dropdown(page.getByLabel('Service type for S-0001',{exact:true}),physicalChoices.service_type);
  await select(empty);
  const cable = await create('service', { 'Category': 'Electrical & Communications', 'Service type': 'Single Cables', 'Service Size (mm)': '10', 'Explicit service quantity': 3 }, 'Add service to B-0002'); await identifier(cable, 'S-0002');
  assert.equal(activeGraph().version, 2); assert.equal(activeGraph().barriers.length, 2); assert.equal(activeGraph().defects.length, 2); assert.equal(activeGraph().services.length, 2); assert.equal(activeGraph().services.reduce((sum, entity) => sum + entity.quantity, 0), 4);
  assert.ok(!Object.hasOwn(activeGraph(), 'openings')); assert.ok(activeGraph().services.every(entity => entity.barrier_id === occupied && !Object.hasOwn(entity, 'opening_id')));
  await expect(page.locator('.takeoff-physical-register')).not.toContainText('Opening');
  card = page.locator('details[data-image-occurrence]').first(); await card.getByRole('button', { name: 'Link image to selected record', exact: true }).click();
  await response(() => dialog('Associate retained image evidence', { 'Supported field': 'service_type', 'Evidence note / source interpretation': 'Synthetic repeated view: cables belong to B-0002; three cables are explicitly recorded, not counted from photographs.' }, 'Preview evidence link'), '/physical/preview');
  await apply('Link retained image to draft record?'); const evidence = activeGraph().services.find(entity => entity.id === cable).evidence[0]; assert.match(evidence.image_sha256, /^[a-f0-9]{64}$/); assert.equal(evidence.document_sha256, state.snapshot.documents[0].sha256); assert.equal(evidence.region.length, 4);
  await select(cable); await expect(page.locator(`.takeoff-hit[data-physical-id="${cable}"]`)).toHaveCount(1);
  await page.locator(`tr[data-physical-id="${cable}"] .takeoff-row-link`).hover(); await expect(page.locator('.takeoff-physical-shape')).toHaveClass(/hovered/);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click()); await idle();
  await page.locator(`.takeoff-hit[data-physical-id="${cable}"]`).hover(); await expect(page.locator(`tr[data-physical-id="${cable}"]`)).toHaveClass(/hovered/);
  await page.getByLabel('Filter physical hierarchy', { exact: true }).fill('S-0002'); await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(3); await expect(page.locator(`tr[data-physical-id="${defect}"]`)).toContainText('Ancestor context'); await page.getByLabel('Filter physical hierarchy', { exact: true }).fill('');
  const notes = page.getByRole('complementary', { name: 'Item Details' }).getByLabel('Notes', { exact: true });
  const frl = page.getByLabel('FRL for D-001', { exact: true }), beforePending = await canonicalState(), requestsBeforePending = physicalRequests.length;
  // Stage separate inspector/table inputs in one browser task so a slow runner
  // cannot save the first field before this conservative mixed-edit guard runs.
  await page.evaluate(({ notes, frl }) => {
    notes.value = 'Unapplied inspection finding must remain visible'; notes.dispatchEvent(new Event('input', { bubbles: true }));
    frl.value = '-/90/90'; frl.dispatchEvent(new Event('change', { bubbles: true }));
  }, { notes: await notes.elementHandle(), frl: await frl.elementHandle() });
  await expect(page.getByRole('alert')).toHaveText('Finish the separate physical field edits before saving. Your unfinished input is preserved.');
  await expect(notes).toHaveValue('Unapplied inspection finding must remain visible'); await expect(frl).toHaveValue('-/90/90');
  assert.deepEqual((await canonicalState()).snapshot.physical, beforePending.snapshot.physical, 'Mixed unfinished inputs cannot change canonical fields, identities, quantities or evidence');
  assert.equal(physicalRequests.length, requestsBeforePending, 'The mixed-edit guard sends no preview or apply request');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard unfinished physical edits', exact: true }).click(); await expect(notes).toHaveValue(''); await expect(frl).toHaveValue('-/120/120');
  assert.deepEqual((await canonicalState()).snapshot.physical, beforePending.snapshot.physical); assert.equal(physicalRequests.length, requestsBeforePending);
  state = await response(() => frl.selectOption('-/90/90'), '/physical/apply'); await idle(); await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(record(defect).fields.frl, '-/90/90'); assert.deepEqual(activeGraph().services, beforePending.snapshot.physical.services);
  await undo(); assert.equal(record(defect).fields.frl, '-/120/120');
  Object.assign(automaticFieldChecks, { mixedInputsRetained: true, mixedCanonicalUnchanged: true, mixedRequestsBlocked: true, discardRestoresBoth: true, routineFrlAutoAppliedWithoutReview: true, undoRestoresFrl: true });
  await page.getByRole('checkbox',{name:'Select all matching physical records',exact:true}).check();await page.getByRole('checkbox',{name:'Select all matching physical records',exact:true}).uncheck(); await page.getByLabel('Select Service S-0001', { exact: true }).check(); await page.getByLabel('Select Service S-0002', { exact: true }).check();
  await page.getByRole('button', { name: 'Bulk edit same-type records', exact: true }).click();await dialog('Choose field for 2 draft records',{'Field to change':'notes'},'Continue');const bulk = await response(() => dialog('Edit 2 draft service records', { 'Notes': 'One reviewed draft edit batch' }, 'Preview bulk edit'), '/physical/preview'); assert.equal(bulk.changed_ids.length, 2);
  await apply('Change 2 of 2 selected records? 0 already match and stay unchanged.'); assert.ok(activeGraph().services.every(entity => entity.fields.notes === 'One reviewed draft edit batch')); await undo(); assert.ok(activeGraph().services.every(entity => !entity.fields.notes)); assert.deepEqual(activeGraph().services.find(entity => entity.id === cable).evidence[0], evidence);
  const beforeDeleteIds = identities();
  await select(occupied); await page.getByRole('button', { name: 'Delete draft record', exact: true }).click(); const deletion = await response(() => dialog('Delete draft barrier', { 'Deletion scope': 'cascade' }, 'Preview deletion'), '/physical/preview'); assert.equal(deletion.changed_ids.length, 3); await apply('Review recoverable deletion'); assert.ok(activeGraph().services.every(entity => entity.deleted)); assert.equal(record(empty).deleted, false); assert.equal(record(otherDefect).deleted, false);
  await page.getByLabel('Show deleted records', { exact: true }).check(); await select(occupied); await page.getByRole('button', { name: 'Restore draft record', exact: true }).click(); await response(() => dialog('Restore draft barrier', { 'Restore scope': 'same_deletion' }, 'Preview restoration'), '/physical/preview'); await apply('Review retained identities to restore'); assert.ok(activeGraph().services.every(entity => !entity.deleted)); assert.deepEqual(identities(), beforeDeleteIds);
  await page.getByLabel('Show deleted records', { exact: true }).uncheck();
  // Undo and recoverable deletion must reserve serials, not recycle them for new records.
  const undone = await create('service', serviceFields, 'Add service to B-0001'); await identifier(undone, 'S-0003'); await undo(); assert.equal(record(undone).deleted, true);
  const deleted = await create('service', serviceFields, 'Add service to B-0001'); await identifier(deleted, 'S-0004');
  await page.getByRole('button', { name: 'Delete draft record', exact: true }).click(); await response(() => dialog('Delete draft service', { 'Deletion scope': 'only' }, 'Preview deletion'), '/physical/preview'); await apply('Review recoverable deletion'); assert.equal(record(deleted).deleted, true);
  const savedIdentities = identities(); await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(6);
  await select(cable); for(const label of ['Physical / takeoff audit history','Undo physical / takeoff edit'])await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0); const historyReply=await page.request.post(await page.evaluate(()=>`${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}/history`),{data:{offset:0,limit:100}});assert.equal(historyReply.status(),200);assert.ok(JSON.stringify(await historyReply.json()).includes(occupied),'Audit identity remains available after toolbar removal'); await page.screenshot({ path: path.join(output, 'physical-hierarchy.png'), fullPage: true });
  state = await response(() => page.getByRole('button', { name: 'Page ›', exact: true }).click(), '/commands'); await idle(); const emptyExtraction = await extract(); assert.notEqual(emptyExtraction, firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(0); await expect(page.getByRole('region', { name: 'Retained image gallery' })).toContainText('0 retained image occurrences');
  await page.getByLabel('Retained image extraction', { exact: true }).selectOption(firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3); await showImage();
  const save = await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as'); assert.ok(save); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.version, 2); assert.equal(saved.takeoffs.version, 2); assert.equal(saved.takeoffs.items.length, 0); assert.equal(saved.takeoffs.image_extractions.length, 2); assert.deepEqual(saved.takeoffs.physical, activeGraph());
  // A later keystroke in an already-dirty form must defeat a delayed native load.
  await select(cable); let releaseRead, readReady;
  const holdRead = new Promise(resolve => { releaseRead = resolve; }), reachedRead = new Promise(resolve => { readReady = resolve; });
  const activeRoutes = new Set(), quantity = page.getByRole('complementary', { name: 'Item Details' }).getByLabel('Explicit service quantity', { exact: true }), requestsBeforeRace = physicalRequests.length;
  const trackRoute = action => { activeRoutes.add(action); return action.finally(() => activeRoutes.delete(action)); };
  const delayRead = route => trackRoute((async () => { const reply = await route.fetch(); readReady(); await holdRead; await route.fulfill({ response: reply }); })());
  await page.route('**/api/project/open', delayRead);
  try {
    // An invalid quantity keeps both fields unfinished through local validation,
    // without an in-flight operation masking the native Load's draft-stamp guard.
    await page.evaluate(({ notes, quantity }) => {
      notes.value = 'First pending note'; notes.dispatchEvent(new Event('input', { bubbles: true }));
      quantity.value = '0'; quantity.dispatchEvent(new Event('change', { bubbles: true }));
    }, { notes: await notes.elementHandle(), quantity: await quantity.elementHandle() });
    await expect(page.getByRole('alert')).toHaveText('Every service needs an explicit positive whole quantity.'); await idle();
    await expect(notes).toHaveValue('First pending note'); await expect(quantity).toHaveValue('0'); assert.equal(physicalRequests.length, requestsBeforeRace);
    await clickProjectControl(page, 'Load'); await reachedRead;
    await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
    // Load now lives on Projects. Settle the return navigation before testing
    // later typing against the still-held native file read.
    await idle();
    const beforeLater = await page.evaluate(() => JSON.parse(window.CeasefireTakeoffs.projectFingerprint()));
    assert.equal(beforeLater.busy, false); assert.equal(beforeLater.physicalUnfinished, true);
    await notes.fill('Later pending note must survive the load race');
    const afterLater = await page.evaluate(() => JSON.parse(window.CeasefireTakeoffs.projectFingerprint()));
    const { physicalEditRevision: beforeRevision, ...beforeStable } = beforeLater, { physicalEditRevision: afterRevision, ...afterStable } = afterLater;
    assert.deepEqual(afterStable, beforeStable, 'Only the already-dirty field revision changes while the native read waits');
    assert.ok(afterRevision > beforeRevision, 'Later typing advances the already-dirty field revision while canonical state stays unchanged');
    releaseRead();
    await expect(page.getByText('Project was not loaded. Your draft changed while reading the file. Load it again when ready.', { exact: true })).toBeVisible();
    await expect(notes).toHaveValue('Later pending note must survive the load race'); await expect(quantity).toHaveValue('0'); await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual((await canonicalState()).snapshot.physical, beforeLater.snapshot.physical, 'A rejected native Load cannot replace the pending physical hierarchy');
    assert.equal(physicalRequests.length, requestsBeforeRace, 'Invalid pending fields and rejected Load send no physical preview or apply request');
    const originalQuantity = beforeLater.snapshot.physical.services.find(entity => entity.id === cable).quantity;
    state = await response(() => quantity.fill(String(originalQuantity)), '/physical/apply'); await idle();
    assert.equal(record(cable).quantity, originalQuantity); assert.equal(record(cable).fields.notes, 'Later pending note must survive the load race');
    await expect(notes).toHaveValue('Later pending note must survive the load race'); await expect(page.getByRole('dialog')).toHaveCount(0);
    Object.assign(automaticFieldChecks, { delayedLoadRejectsLaterDirtyRevision: true, invalidQuantityPreservesCanonical: true, latestInvalidPendingNoteRetained: true, correctedQuantityAutoSavesLatestNoteWithoutReview: true });
  } finally { releaseRead(); await Promise.all([...activeRoutes]); await page.unroute('**/api/project/open', delayRead); }
  const reopened = await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); assert.deepEqual(reopened.takeoffs.physical, saved.takeoffs.physical);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(6); await select(cable); await page.getByLabel('Retained image extraction', { exact: true }).selectOption(firstExtraction); await expect(page.locator('details[data-image-occurrence]')).toHaveCount(3); await showImage();
  const afterReopen = await create('service', serviceFields, 'Add service to B-0001'); await identifier(afterReopen, 'S-0005'); await undo(); assert.equal(record(afterReopen).deleted, true); assert.deepEqual(identities().filter(entity => entity.id !== afterReopen), savedIdentities);
  await select(cable); assert.deepEqual(record(cable).evidence[0], evidence);
  for (const format of ['CSV', 'XLSX']) { await page.getByRole('button', { name: `Export draft ${format}`, exact: true }).click(); const download = page.waitForEvent('download'); await dialog('Export unapproved physical draft?', {}, 'Export unapproved draft'); const file = await download; assert.ok(file.suggestedFilename().includes('UNAPPROVED-DRAFT')); const filename = path.join(output, file.suggestedFilename()); await file.saveAs(filename); assert.ok(fs.statSync(filename).size > 100); if (format === 'CSV') { const csv = fs.readFileSync(filename, 'utf8'); for (const value of [defect, otherDefect, empty, occupied, pipe, cable, 'D-0001', 'D-0002', 'B-0001', 'B-0002', 'S-0001', 'S-0005', evidence.image_sha256, 'UNAPPROVED DRAFT']) assert.ok(csv.includes(value), value); assert.ok(!/opening/i.test(csv), 'New exports must omit Opening fields and relationships'); } await idle(); }
  assert.ok(inventoryRequests.length); assert.ok(inventoryRequests.every(request => request.extraction && request.limit === '100')); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.screenshot({ path: path.join(output, 'reopened-draft.png'), fullPage: true });
  await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'drawing-viewport.png') });
  await page.locator('.takeoff-physical-register').evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().height - 12)); await page.screenshot({ path: path.join(output, 'register-viewport.png') });
  await page.getByRole('table', { name: 'Draft penetration hierarchy register' }).screenshot({ path: path.join(output, 'hierarchy-table.png') });
  // Preserve the v2 saved artifact and open an authentic pre-v2 project through the same native Load path.
  fs.copyFileSync(info.project, path.join(output, 'saved-v2-project.json'));
  const legacyBytes = fs.readFileSync(info.legacy_project), legacySaved = JSON.parse(legacyBytes); fs.writeFileSync(info.project, legacyBytes);
  const legacy = await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); assert.deepEqual(legacy.takeoffs.physical, legacySaved.takeoffs.physical); assert.equal(legacy.takeoffs.physical.version, 1);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project'); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await expect(page.locator('.takeoff-physical-register')).toContainText('Legacy hierarchy');
  await expect(page.locator('.takeoff-physical-register tr[data-physical-id]')).toHaveCount(4);
  for (const label of ['Add defect', 'Bulk edit same-type records', 'Delete selected records', 'Extract images from selected PDF page']) await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await select(legacySaved.takeoffs.physical.services[0].id);
  for (const label of ['Preview physical edits', 'Delete draft record', 'Restore draft record', 'Change physical parent', 'Link original source page', 'Remove source association']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  const legacyInspector = page.getByRole('complementary', { name: 'Item Details' }), legacyNavigation = legacyInspector.getByRole('table', { name: 'Item Details navigation' });
  await expect(legacyNavigation.locator('select')).toHaveCount(3);
  // Navigation remains available on a legacy record; it must never expose editable fields or rewrite the retained hierarchy.
  for (const [kind, label] of [['defects', 'Defect'], ['barriers', 'Barrier'], ['services', 'Service']]) {
    const target = legacySaved.takeoffs.physical[kind][0].id, control = legacyNavigation.getByLabel(`${label} ID in Item Details`, { exact: true });
    await control.selectOption(target); await idle(); await expect(control).toHaveValue(target);
    await expect(legacyInspector.locator('input, textarea, select:not(.takeoff-physical-navigation select)')).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot().physical), legacySaved.takeoffs.physical);
  }
  await page.getByRole('button', { name: 'Export draft CSV', exact: true }).click(); const legacyDownload = page.waitForEvent('download'); await dialog('Export unapproved physical draft?', {}, 'Export unapproved draft'); const legacyFile = await legacyDownload; const legacyFilename = path.join(output, 'legacy-physical.csv'); await legacyFile.saveAs(legacyFilename);
  const legacyCsv = fs.readFileSync(legacyFilename, 'utf8'); for (const value of ['opening_id', 'LEGACY-OPENING', 'Legacy 100 mm', ...['barriers', 'defects', 'openings', 'services'].flatMap(key => legacySaved.takeoffs.physical[key].map(entity => entity.id))]) assert.ok(legacyCsv.includes(value), value);
  assert.deepEqual(fs.readFileSync(info.legacy_project), legacyBytes); assert.deepEqual(fs.readFileSync(info.project), legacyBytes);
  await page.screenshot({ path: path.join(output, 'legacy-read-only.png'), fullPage: true }); await page.getByRole('table', { name: 'Draft penetration hierarchy register' }).screenshot({ path: path.join(output, 'legacy-table.png') }); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, ids: { defect, otherDefect, empty, occupied, pipe, cable, undone, deleted, afterReopen }, savedIdentities, evidence, firstExtraction, emptyExtraction, inventoryRequests, physicalRequests, automaticFieldChecks, errors, csp: [], contextual_child_creation: true, stable_serials_after_undo_delete_reopen: true, legacy_read_only_preserved: true, unfinished_edit_preserved: true, delayed_load_race_rejected: true }, null, 2));
  console.log(`PASS: numbered Defect → Barrier → Service hierarchy, contextual child creation, serials preserved across Undo/deletion/reopen, legacy v1 read-only/export, retained repeated bitmap, exact evidence, hover/filter, bulk/undo, cascade/restore, Save As/reopen and unapproved CSV/XLSX; calculators unchanged. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
