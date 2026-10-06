const { chooseTakeoff, chooseLibrary } = require('./section_navigation.cjs');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Public selectors and saved legacy descriptions on disposable synthetic storage.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), python = process.env.CEASEFIRE_PYTHON || 'python';
const output = path.join(root, '.runtime/browser-qa', `services-choices-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(__dirname, 'project_library_fixture.py');
const server = spawn(python, [fixture, '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info, origin;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const services = ['Access Panel','Blank Seal','Busbar Trunking','Cable Bundles','Cable Trays','Coaxial Cables','Conduits','D1 Power Cables','D2 Comms Cables','Data Cables','Downlights','Fibre Optic','Fire Dampers','Fire Resistant Cables','Flexible Ducts','Junction Box','Lagged Copper Pipes','Lagged Steel Pipes','Linear Joints','Mixed Services','Movement Joints','Pair Coils','uPVC pipe','uPVC floorwaste','PEX pipe','HDPE pipe','Power Cables','Single Cables','TPS & Fire Alarm Cables','Copper Pipes','Steel Pipes','Air Transfer Grilles','Communications Cables','Structural Steel','Structural Timber','Wall Sockets'];
const errors = [], evidence = {};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
async function options(control, legacy) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const actual = await control.locator('option').evaluateAll(rows => rows.filter(row => row.value).map(row => ({ value: row.value, disabled: row.disabled, label: row.textContent })));
  assert.deepEqual(actual.filter(row => row.value !== legacy).map(row => row.value), services);
  if (legacy) { assert.equal(actual.at(-1).value, legacy); await expect(control).toHaveValue(legacy); }
  return actual;
}
async function response(action, suffix) {
  const pending = page.waitForResponse(value => new URL(value.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending; assert.equal(reply.status(), 200, await reply.text()); return reply.json();
}
async function api(pathname) { const reply = await page.request.get(origin + pathname); assert.equal(reply.status(), 200, await reply.text()); return reply.json(); }
async function load(seed) {
  fs.writeFileSync(path.join(output, 'dialog-mode.json'), JSON.stringify({ seed }));
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
}
function protectedDatabase() {
  const result = spawnSync(python, [fixture, '--snapshot-database', info.database], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).filter(([name]) => !name.startsWith('takeoff')));
}
async function physicalIdle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true'); }
async function takeoffSnapshot() { const session = await page.evaluate(() => window.CeasefireTakeoffs.sessionId()); return (await api(`/api/takeoffs/sessions/${session}`)).snapshot; }

(async () => {
  info = await ready; assert.notEqual(info.port, 8765); origin = `http://127.0.0.1:${info.port}`;
  // Before the first request, add explicit source records to this test's private
  // fixture. Broad legacy rows are intentionally distinct from material rows.
  const sourcePath = path.join(output, 'reference-library/library.json'), source = JSON.parse(fs.readFileSync(sourcePath));
  source.libraries.technical.filters.push({ key: 'services', label: 'Services' });
  const template = copy(source.libraries.technical.items[0]);
  source.libraries.technical.items = [
    ['report-a-v1','HDPE pipe',null], ['copper-pipe','Copper pipe',null], ['broad-plastic','', 'Plastic Pipes'],
    ['mixed-conduit','uPVC conduits and copper pipes',null], ['mixed-hdpe-conduit','uPVC pipe and HDPE cable conduits',null], ['mixed-floorwaste','uPVC pipe and copper floor waste',null],
    ['legacy-data','', 'Data Cable Bundles'], ['legacy-alarm','', 'TPS & Fire Alarm Cable Bundles'],
    ['mixed-data-pipe','Data pipes and power cable bundles',null], ['mixed-tps-pipe','TPS pipes and coaxial cables',null],
  ].map(([id, service, legacy]) => ({ ...copy(template), id, title: id, fields: [...copy(template.fields), { label: 'Service', value: service }], filter_values: { ...copy(template.filter_values), ...(legacy ? { services: [legacy] } : {}) } }));
  fs.writeFileSync(sourcePath, JSON.stringify(source)); const sourceBefore = fs.readFileSync(sourcePath), sourceImageBefore = fs.readFileSync(info.diagram);
  const seed = JSON.parse(fs.readFileSync(info.seed)); seed.penetration.composer.rows[0].inputs.K = 'Plastic Pipes'; fs.writeFileSync(info.seed, JSON.stringify(seed));
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(origin); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); fs.copyFileSync(info.seed, info.project); await load(false);
  const databaseBefore = protectedDatabase(), sharedBefore = await api(`/api/libraries/penetration/${info.item_id}/edit`);

  await page.getByRole('button', { name: 'Libraries', exact: true }).click(); await chooseLibrary(page, 'technical');
  const technical = page.locator('#library-technical [data-library-filter=services]'); evidence.technicalOptions = await options(technical);
  await technical.selectOption('HDPE pipe'); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(1); await expect(page.locator('#library-technical [data-library-record]')).toHaveAttribute('data-library-record', 'report-a-v1');
  await technical.selectOption('PEX pipe'); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(0);
  await technical.selectOption('Copper Pipes'); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(2); assert.deepEqual((await page.locator('#library-technical [data-library-record]').evaluateAll(rows=>rows.map(row=>row.dataset.libraryRecord))).sort(), ['copper-pipe','mixed-conduit']);
  await technical.selectOption('uPVC floorwaste'); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(0);
  await technical.selectOption('uPVC pipe'); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(2); assert.deepEqual((await page.locator('#library-technical [data-library-record]').evaluateAll(rows=>rows.map(row=>row.dataset.libraryRecord))).sort(), ['mixed-floorwaste','mixed-hdpe-conduit']);
  for (const [label, id] of [['Data Cables','legacy-data'], ['TPS & Fire Alarm Cables','legacy-alarm']]) {
    await technical.selectOption(label); await expect(page.locator('#library-technical [data-library-record]')).toHaveCount(1); await expect(page.locator('#library-technical [data-library-record]')).toHaveAttribute('data-library-record', id);
  }
  await page.screenshot({ path: path.join(output, 'technical-services.png') });

  await chooseLibrary(page, 'penetration'); await page.locator(`[data-library-edit="${info.item_id}"]`).first().click();
  const librarySettings=page.locator('#library-editor-settings'),detailsTab=page.locator('#library-editor-groups').getByRole('tab',{name:'DETAILS',exact:true});
  await expect(librarySettings).toBeVisible();await expect(detailsTab).toBeVisible();
  const settingsBox=await librarySettings.boundingBox(),detailsBox=await detailsTab.boundingBox();assert.ok(settingsBox.x+settingsBox.width<=detailsBox.x,'Library Settings icon must be left of DETAILS');
  const beforeSettings=await page.evaluate(()=>window.CeasefireLibraryEditor.projectFingerprint());await librarySettings.click();await expect(librarySettings).toHaveAttribute('aria-pressed','true');await detailsTab.click();await expect(librarySettings).toHaveAttribute('aria-pressed','false');assert.equal(await page.evaluate(()=>window.CeasefireLibraryEditor.projectFingerprint()),beforeSettings);evidence.librarySettings={leftOfDetails:true,nativeToggle:true,draftUnchanged:true};
  const libraryService = page.locator('[data-library-editor-field=K]'); evidence.libraryOptions = await options(libraryService, 'Copper service'); assert.equal(evidence.libraryOptions.at(-1).disabled, true);
  const libraryDraft = await page.evaluate(() => window.CeasefireLibraryEditor.projectFingerprint()); await libraryService.focus(); await libraryService.press('Tab'); assert.equal(await page.evaluate(() => window.CeasefireLibraryEditor.projectFingerprint()), libraryDraft);
  await page.screenshot({ path: path.join(output, 'library-saved-service.png') }); await page.locator('#library-editor-cancel').click();
  await chooseCalculator(page, 'Firestopping Estimator');
  const composerService = page.locator('#penetration-row-fields [data-penetration-field=K]'); evidence.composerOptions = await options(composerService, 'Plastic Pipes'); assert.equal(evidence.composerOptions.at(-1).disabled, true);
  await page.locator('#penetration-row-fields [data-penetration-field=T]').fill('Independent saved composer description'); await page.locator('#penetration-row-fields [data-penetration-field=T]').press('Tab');
  await expect.poll(() => page.evaluate(() => window.CeasefireDesktop.status().busy)).toBe(false);
  assert.equal(await page.evaluate(() => window.CeasefirePenetrations.projectSnapshot().composer.rows[0].inputs.K), 'Plastic Pipes'); await page.screenshot({ path: path.join(output, 'composer-saved-service.png') });

  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await physicalIdle();
  // Canonical compatibility fixture: these are pre-existing saved descriptions,
  // seeded through the same public draft command API as other physical tests.
  const ids = { defect: randomUUID(), barrier: randomUUID(), service: randomUUID() };
  const entity = (id, fields, extra = {}) => ({ id, fields, evidence: [], uncertainty: { state: 'not_assessed', note: '' }, ...extra });
  const commands = [
    { op: 'create', kind: 'defect', entity: entity(ids.defect, { label: 'SAVED-SERVICES', location: 'Level01', frl: '-/120/120' }) },
    { op: 'create', kind: 'barrier', entity: entity(ids.barrier, { substrate: 'Concrete/masonry wall', orientation: 'Vertical' }, { defect_id: ids.defect }) },
    { op: 'create', kind: 'service', entity: entity(ids.service, { service: 'Plumbing & Hydraulic', service_type: 'Plastic Pipes', width_mm: 12.3456789012345 }, { barrier_id: ids.barrier, quantity: 1 }) },
  ];
  const sid = await page.evaluate(() => window.CeasefireTakeoffs.sessionId()), snapshot = await takeoffSnapshot();
  const previewReply = await page.request.post(`${origin}/api/takeoffs/sessions/${sid}/physical/preview`, { data: { scope: 'defect_reports', expected_revision: snapshot.revision, commands } }); assert.equal(previewReply.status(), 200, await previewReply.text()); const preview = await previewReply.json();
  const applyReply = await page.request.post(`${origin}/api/takeoffs/sessions/${sid}/physical/apply`, { data: { scope: 'defect_reports', expected_revision: preview.revision, request_id: randomUUID(), preview_id: preview.preview_id } }); assert.equal(applyReply.status(), 200, await applyReply.text()); const applied = await applyReply.json();
  await page.evaluate(async value => { const t = window.CeasefireTakeoffs; t.applyProject(await t.prepareProject(value, t.sessionId())); await t.open(); }, applied.snapshot); await chooseTakeoff(page, 'physical'); await physicalIdle();
  await page.locator(`tr[data-physical-id="${ids.barrier}"] .takeoff-row-link`).click(); await page.getByRole('button', { name: 'Add service in Item Details', exact: true }).click();
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: 'Create draft service', exact: true })).toBeVisible(); evidence.takeoffNewOptions = await options(modal.getByLabel('Service type', { exact: true })); await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator(`tr[data-physical-id="${ids.service}"] .takeoff-row-link`).click(); const details = page.getByRole('complementary', { name: 'Item Details', exact: true }); evidence.takeoffSavedOptions = await options(details.getByLabel('Service type', { exact: true }), 'Plastic Pipes');
  await details.getByLabel('Notes', { exact: true }).fill('Independent service note'); await details.getByLabel('Notes', { exact: true }).press('Tab'); await expect.poll(async () => (await takeoffSnapshot()).physical.services[0].fields.notes).toBe('Independent service note');
  await page.screenshot({ path: path.join(output, 'takeoff-saved-service.png') });
  await response(() => clickProjectControl(page, 'Save'), '/api/project/save'); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project)); assert.equal(saved.penetration.composer.rows[0].inputs.K, 'Plastic Pipes'); assert.equal(saved.takeoffs.physical.services[0].fields.service_type, 'Plastic Pipes'); assert.equal(saved.takeoffs.physical.services[0].id, ids.service); assert.equal(saved.takeoffs.physical.services[0].quantity, 1); assert.equal(saved.takeoffs.physical.services[0].fields.width_mm, 12.3456789012345);
  // Reopening mounts a fresh inspector before its asynchronous shared choices
  // arrive. Retained values stay visible but locked until the definition loads.
  let definitionHeld = false, releaseDefinition;
  const definitionGate = new Promise(resolve => { releaseDefinition = resolve; });
  const heldDefinition = async route => { definitionHeld = true; await definitionGate; await route.continue(); };
  await page.route('**/api/penetration/definition', heldDefinition);
  try {
    await load(false); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await physicalIdle();
    await expect.poll(() => definitionHeld).toBe(true);
    await page.locator(`tr[data-physical-id="${ids.service}"] .takeoff-row-link`).click();
    const reopenedService = details.getByLabel('Service type', { exact: true });
    await expect(reopenedService).toBeVisible(); await expect(reopenedService).toBeDisabled(); await expect(reopenedService).toHaveValue('Plastic Pipes');
    const pendingOptions = await reopenedService.locator('option').evaluateAll(rows => rows.filter(row => row.value && row.value !== 'Plastic Pipes').map(row => row.value));
    assert.deepEqual(pendingOptions, []); assert.deepEqual((await takeoffSnapshot()).physical.services[0], saved.takeoffs.physical.services[0]);
    await page.screenshot({ path: path.join(output, 'takeoff-reopened-choices-pending.png') });
    releaseDefinition(); evidence.takeoffReopenedOptions = await options(reopenedService, 'Plastic Pipes');
    evidence.reopenedChoiceReadiness = { definition_response_held: true, retained_value_visible_and_disabled: true, pending_general_options: pendingOptions, saved_service_unchanged: true, enabled_after_definition: true };
  } finally { releaseDefinition(); await page.unroute('**/api/penetration/definition', heldDefinition); }
  await details.getByLabel('Service type', { exact: true }).selectOption('HDPE pipe'); await expect.poll(async () => (await takeoffSnapshot()).physical.services[0].fields.service_type).toBe('HDPE pipe'); assert.equal((await takeoffSnapshot()).physical.services[0].id, ids.service);
  assert.deepEqual(protectedDatabase(), databaseBefore); assert.deepEqual(await api(`/api/libraries/penetration/${info.item_id}/edit`), sharedBefore); assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore); assert.deepEqual(fs.readFileSync(info.diagram), sourceImageBefore); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, exactServices: services, ...evidence, ids, legacy_save_reopen_precise_identity: true, broad_type_not_expanded_to_subtypes: true, shared_database_preserved: true, shared_library_preserved: true, source_sha256: sha(sourceBefore), image_sha256: sha(sourceImageBefore), errors, csp: [] }, null, 2));
  console.log(`PASS: exact 36 Services choices in Technical Library, library editor, Firestopping composer and Takeoffs; explicit scoped filtering; legacy descriptions, precision and IDs retained across Save/Open; source/shared database unchanged. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
