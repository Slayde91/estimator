const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Retained legacy count-only and length-only editing; disposable rotated PDF.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `standalone-measurements-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
});
const errors = [], evidence = {}, operations = [];
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await page.evaluate(() => window.CeasefireTakeoffs.completeProjectSnapshot()); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded(); await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); return [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
}
// The fixture's third page is rotated 90 degrees with this retained crop box.
// Convert rendered marker centers back to source coordinates, independently of
// the application's draft state, so preview and committed geometry must agree.
async function renderedMarkerPoints(selector) {
  return page.locator(selector).evaluateAll(markers => markers.map(marker => {
    const [, , width, height] = marker.ownerSVGElement.getAttribute('viewBox').split(/\s+/).map(Number);
    return [20 + Number(marker.getAttribute('cy')) / height * 780, 30 + Number(marker.getAttribute('cx')) / width * 540];
  }));
}
function assertSamePoints(actual, expected, description) {
  assert.equal(actual.length, expected.length, description);
  actual.forEach((point, index) => point.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - expected[index][axis]) < 1e-9, `${description}: point ${index}, axis ${axis}`)));
}
async function command(action, op) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const result = await pending; assert.equal(result.status(), 200, await result.text()); await idle(); return result.json();
}
async function response(action, suffix) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending; assert.equal(reply.status(), 200, await reply.text()); await idle(); return reply.json();
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) { const field = modal.getByLabel(label, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') { await expect.poll(() => field.locator('option').evaluateAll(options => options.map(option => option.value))).toContain(value); await field.selectOption(value); } else await field.fill(value); }
  await modal.getByRole('button', { name: action, exact: true }).click(); await modal.waitFor({ state: 'detached' });
}
async function assertDeleteFarLeft(mode) {
  const originalViewport = page.viewportSize(), panel = page.locator('#takeoff-markup-settings');
  const measurements = [];
  for (const width of [1384, 957]) {
    await page.setViewportSize({ width, height: 764 });
    const separator = page.getByRole('separator', { name: 'Resize settings pane', exact: true });
    await separator.focus(); await separator.press('End');
    const remove = panel.getByRole('button', { name: 'Delete item', exact: true });
    await remove.scrollIntoViewIfNeeded();
    const itemBounds = await panel.getByLabel('Item', { exact: true }).boundingBox(), removeBounds = await remove.boundingBox();
    assert.ok(itemBounds && removeBounds, `${mode} settings controls have actual bounds at ${width}px`);
    assert.ok(Math.abs(removeBounds.x - itemBounds.x) < 1, `${mode} Delete starts at the leftmost Item column at ${width}px`);
    assert.deepEqual(await remove.evaluate(button => ({ start: getComputedStyle(button).gridColumnStart, end: getComputedStyle(button).gridColumnEnd })), { start: '1', end: '-1' }, 'Delete spans the settings grid after the wrapper is flattened');
    await expect(panel).not.toContainText('The total counts markers on the PDF.');
    measurements.push({ viewportWidth: width, paneWidth: Number(await separator.getAttribute('aria-valuenow')), itemX: itemBounds.x, deleteX: removeBounds.x });
    await page.screenshot({ path: path.join(output, `${mode.toLowerCase()}-delete-left-${width}.png`) });
  }
  await page.setViewportSize(originalViewport);
  const separator = page.getByRole('separator', { name: 'Resize settings pane', exact: true });
  await separator.focus(); await separator.press('Home');
  for (let index = 0; index < 8; index++) await separator.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '300'); await idle();
  return measurements;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 764 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) operations.push(request.postDataJSON().op); });
  await page.goto(`http://127.0.0.1:${info.port}/`);
  // Bootstrap selects its initial view; navigate only after it has completed.
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1); await expect(page.locator('.takeoff-document')).toHaveCount(1); await idle();
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  const before = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  for (const mode of ['STEEL', 'DUCT']) {
    await chooseTakeoff(page, mode);
    const finishedDraftPoints = [[150, 200], [230, 230]];
    if (mode === 'STEEL') {
      await expect(page.getByRole('button', { name: 'Count', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Count steel lengths', exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Count', exact: true })).toBeVisible();
    }
    // Both historical formats remain editable and extendable. Their missing
    // length is preserved; current Count creation is covered separately by
    // count_tools.cjs using the required manual millimetre field.
    await command(() => page.evaluate(async ({ mode, points }) => {
      const takeoffs = window.CeasefireTakeoffs, current = takeoffs.projectSnapshot(), sid = takeoffs.sessionId(), doc = current.documents[0];
      const response = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add_standalone_count', request_id: crypto.randomUUID(), expected_revision: current.revision, document_id: doc.id, page: 3, mode: mode.toLowerCase(), markers: points.map(point => ({ point })), fields: { mark: `${mode}-ONLY`, level: 'L01', width_mm: 100, height_mm: 200, frl: '120/120/120', orientation: 'Horizontal' }, appearance: {} }) });
      if (!response.ok) throw new Error(await response.text()); const reply = await response.json(); takeoffs.applyProject(await takeoffs.prepareProject(reply.snapshot, sid));
    }, { mode, points: finishedDraftPoints }), 'add_standalone_count');
    await renderDrawing(page, () => page.getByLabel('Page number',{exact:true}).fill('1').then(()=>page.getByLabel('Page number',{exact:true}).press('Tab')), 1); await idle();
    await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
    await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 3);
    let current = await snapshot(), count = current.items.find(item => item.fields.mark === `${mode}-ONLY`);
    await page.locator(`.takeoff-register-table tr[data-item-id="${count.id}"]`).getByRole('button', { name: 'Edit item', exact: true }).click();
    assert.equal(count.purpose, 'count-only'); assert.equal(count.quantity, 2); assert.equal(count.measurement, null); assert.equal(count.geometry.kind, 'count-only'); assert.equal(count.geometry.points.length, 2);
    assertSamePoints(count.geometry.points, finishedDraftPoints, `${mode} saved legacy geometry keeps exact source coordinates`);
    await expect(page.locator('.takeoff-count-pending')).toHaveCount(0);
    await expect(page.locator('.takeoff-count-hit')).toHaveCount(2);
    assertSamePoints(await renderedMarkerPoints('.takeoff-count-hit'), count.geometry.points, `${mode} saved markers match the post-undo geometry`);
    await expect(page.locator('#takeoffs-workspace > .message')).not.toHaveAttribute('role', 'alert');
    await expect(page.locator('.takeoff-settings-fields').getByLabel('Total Count/QTY', { exact: true })).toHaveValue('2');
    const changed = page.locator('.takeoff-settings-fields').getByLabel('Item', { exact: true }); await changed.fill(`${mode}-EDITED`); await changed.press('Tab');
    await expect.poll(async () => (await snapshot()).items.find(item => item.id === count.id).fields.mark).toBe(`${mode}-EDITED`);
    await expect(page.locator(`.takeoff-register-table tr[data-item-id="${count.id}"]`)).toHaveCount(1);
    if (mode === 'DUCT') {
      assert.equal(count.fields.shape, undefined, 'A retained count does not acquire an inferred duct shape');
      await expect(page.locator(`.takeoff-register-table tr[data-item-id="${count.id}"]`)).not.toContainText('Retained non-rectangular duct');
    }
    await expect(page.locator('.takeoff-standalone-register')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Counts', exact: true })).toHaveCount(0);
    await expect(page.locator('.takeoff-settings-fields')).not.toContainText('The total counts markers on the PDF.');
    const deleteLeft = await assertDeleteFarLeft(mode);
    const originalMembers = [...count.member_ids];
    const marker = page.locator(`.takeoff-count-hit[data-count-member-id="${originalMembers[0]}"]`);
    await marker.scrollIntoViewIfNeeded(); await marker.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Continue count', exact: true }).click();
    await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'count-only');
    await page.mouse.click(...await screen([280, 210]));
    const firstDraftPoint = (await renderedMarkerPoints('.takeoff-count-pending'))[0];
    await page.mouse.click(...await screen([300, 250])); await expect(page.locator('.takeoff-count-pending')).toHaveCount(2);
    await page.locator('.takeoff-viewport').press('Control+z'); await expect(page.locator('.takeoff-count-pending')).toHaveCount(1);
    assertSamePoints(await renderedMarkerPoints('.takeoff-count-pending'), [firstDraftPoint], `${mode} Ctrl+Z removes only the last continuation preview marker`);
    await page.mouse.click(...await screen([300, 260])); await expect(page.locator('.takeoff-count-pending')).toHaveCount(2);
    await page.locator('.takeoff-viewport').press('Backspace'); await expect(page.locator('.takeoff-count-pending')).toHaveCount(1);
    assertSamePoints(await renderedMarkerPoints('.takeoff-count-pending'), [firstDraftPoint], `${mode} Backspace removes only the replacement preview marker`);
    await command(() => page.locator('.takeoff-viewport').press('Enter'), 'continue_standalone_count');
    count = (await snapshot()).items.find(item => item.id === count.id);
    assert.equal(count.quantity, 3); assert.deepEqual(count.member_ids.slice(0, 2), originalMembers);
    assertSamePoints([count.geometry.points[2]], [firstDraftPoint], `${mode} saved continuation matches the post-undo preview`);
    const added = page.locator(`.takeoff-count-hit[data-count-member-id="${count.member_ids[2]}"]`);
    await added.scrollIntoViewIfNeeded(); await added.click({ button: 'right' });
    await command(() => page.getByRole('menuitem', { name: 'Delete count marker', exact: true }).click(), 'delete_count_marker');
    count = (await snapshot()).items.find(item => item.id === count.id);
    assert.equal(count.quantity, 2); assert.deepEqual(count.member_ids, originalMembers); assert.equal(count.measurement, null);
    await expect(page.locator('.takeoff-count-hit')).toHaveCount(2);
    evidence[mode] = { id: count.id, quantity: count.quantity, points: count.geometry.points, retainedHistoricalCount: true, creationCoverage: 'guarded legacy API fixture', mainRegisterRow: true, countsSectionRemoved: true, noInferredLength: true, deleteFarLeft: deleteLeft, totalCountHelperRemoved: true, ...(mode === 'STEEL' ? { creationButtonRemoved: true } : {}), draftUndo: { keys: ['Control+z', 'Backspace'], previewPoints: [firstDraftPoint], savedContinuationPoint: firstDraftPoint } };
    await page.locator('#view-takeoffs').getByRole('button', { name: 'Settings', exact: true }).click();
  }
  // Seed the exact page calibration independently of any calculator values.
  await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, current = takeoffs.projectSnapshot(), sid = takeoffs.sessionId(), doc = current.documents[0];
    const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add_calibration', request_id: crypto.randomUUID(), expected_revision: current.revision, calibration: { id: crypto.randomUUID(), document_id: doc.id, page: 3, name: 'Synthetic precise scale', points: [[100, 100], [200, 100]], distance_m: 10, uniform_scale: true } }) });
    if (!reply.ok) throw new Error(await reply.text()); const updated = await reply.json(); takeoffs.applyProject(await takeoffs.prepareProject(updated.snapshot, sid));
  });
  await chooseTakeoff(page, 'WALLS');
  await page.getByLabel('Page number',{exact:true}).fill('1').then(()=>page.getByLabel('Page number',{exact:true}).press('Tab')); await idle();
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  for (const mode of ['WALLS', 'SLABS']) {
    await chooseTakeoff(page, mode); await expect(page.getByRole('button', { name: 'Length', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Measure', exact: true })).toBeVisible();
    // The Length tool has retired from Walls/Floors. Explicitly seed a legacy
    // record via the guarded API so its geometry/precision/editing regression
    // remains exercised without claiming native creation coverage.
    let seeded;
    await command(async () => { seeded = await page.evaluate(async name => {
      const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId(), current = takeoffs.projectSnapshot(), doc = current.documents[0];
      const basis = current.calibrations.find(value => value.document_id === doc.id && value.page === 3 && value.name === 'Synthetic precise scale');
      if (!basis) throw new Error('Explicit legacy Length fixture requires its precise source calibration');
      const response = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'create_item', request_id: crypto.randomUUID(), expected_revision: current.revision, item: { mode: name === 'WALLS' ? 'wall' : 'slab', purpose: 'length-only', geometry: { document_id: doc.id, page: 3, points: [[150, 200], [250, 200]] }, measurement: { method: 'calibrated', calibration_id: basis.id }, quantity: 1, fields: { mark: `${name}-LENGTH`, level: 'L01' } } }) });
      if (!response.ok) throw new Error(await response.text()); const reply = await response.json(); takeoffs.applyProject(await takeoffs.prepareProject(reply.snapshot, sid)); await takeoffs.open(); return reply;
    }, mode); }, 'create_item');
    const reply = seeded;
    const item = reply.snapshot.items.find(item => item.fields.mark === `${mode}-LENGTH`); assert.equal(item.purpose, 'length-only'); assert.equal(item.quantity, 1); assert.equal(item.geometry.points.length, 2); assert.equal(item.measurement.method, 'calibrated');
    const result = reply.item_results.find(row => row.id === item.id), [a, b] = item.geometry.points;
    const sourceLength = Math.hypot(a[0] - b[0], a[1] - b[1]) * .1;
    assert.ok(Math.abs(result.length_m - sourceLength) < 1e-12, 'Server preserves retained legacy geometry precision');
    assert.ok(result.length_m > 0, 'The retained legacy source line has a measured length'); evidence[mode] = { id: item.id, length_m: result.length_m, points: item.geometry.points, creation_coverage: 'guarded API legacy fixture', length_tool_hidden: true, pdf_measure_visible: true };
    await chooseTakeoff(page, mode);
  }
  // Retiring an inset must not silently restore a different page-scale basis.
  // The requested sidebar calibration button is absent. Keep the retired inset
  // fail-closed check, then test explicit repair through the guarded command API
  // and public restore path; this positive is API coverage, not native UI.
  const beforeRepair = await snapshot(), lengthIds = ['WALLS', 'SLABS'].map(mode => evidence[mode].id);
  await page.evaluate(async identifiers => {
    const takeoffs = window.CeasefireTakeoffs, sid = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const original = current.items.find(item => item.id === identifiers[0]), coordinates = original.geometry.points,
      xs = coordinates.map(point => point[0]), ys = coordinates.map(point => point[1]), viewportId = crypto.randomUUID();
    async function send(op, values) {
      const response = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, request_id: crypto.randomUUID(), expected_revision: current.revision, ...values }) });
      if (!response.ok) throw new Error(await response.text()); current = (await response.json()).snapshot;
    }
    await send('add_calibration', { calibration: { id: viewportId, document_id: original.geometry.document_id, page: original.geometry.page,
      name: 'Temporary inset for explicit repair', region: [Math.min(...xs)-20, Math.min(...ys)-20, Math.max(...xs)+20, Math.max(...ys)+20],
      points: coordinates, distance_m: 4, uniform_scale: true } });
    await send('delete_viewport', { calibration_id: viewportId });
    for (const id of identifiers) if (current.items.find(item => item.id === id).measurement !== null) throw new Error('A retired inset must require explicit recalibration');
    takeoffs.applyProject(await takeoffs.prepareProject(current, sid));
  }, lengthIds);
  // Complete the same public restore/open lifecycle used when Takeoffs reopens.
  await renderDrawing(page, () => page.evaluate(() => window.CeasefireTakeoffs.open()), 1);
  await chooseTakeoff(page, 'WALLS');
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  for (const mode of ['WALLS', 'SLABS']) {
    await chooseTakeoff(page, mode);
    const original = beforeRepair.items.find(item => item.id === evidence[mode].id);
    await page.locator(`.takeoff-standalone-register tr[data-item-id="${original.id}"]`).getByRole('button', { name: 'Edit item', exact: true }).click();
    await expect(page.locator('.takeoff-settings-tools').getByRole('button', { name: /^(Attach|Change) length calibration$/ })).toHaveCount(0);
    const retained = (await snapshot()).items.find(item => item.id === original.id);
    assert.equal(retained.measurement, null, 'Opening native settings must not automatically restore a retired inset basis');
    assert.deepEqual(retained.geometry, original.geometry); assert.deepEqual(retained.member_ids, original.member_ids); assert.deepEqual(retained.fields, original.fields); assert.equal(retained.quantity, original.quantity);
    const response = await command(() => page.evaluate(async ({ itemId, calibrationId }) => {
      const takeoffs = window.CeasefireTakeoffs, current = takeoffs.projectSnapshot(), sid = takeoffs.sessionId();
      const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update_item', request_id: crypto.randomUUID(), expected_revision: current.revision, item_id: itemId, changes: { measurement: { method: 'calibrated', calibration_id: calibrationId } } }) });
      if (!reply.ok) throw new Error(await reply.text());
      const updated = await reply.json(); takeoffs.applyProject(await takeoffs.prepareProject(updated.snapshot, sid));
    }, { itemId: original.id, calibrationId: original.measurement.calibration_id }), 'update_item');
    await renderDrawing(page, () => page.evaluate(() => window.CeasefireTakeoffs.open()), 1);
    const repaired = response.snapshot.items.find(item => item.id === original.id);
    assert.deepEqual(repaired.geometry, original.geometry); assert.deepEqual(repaired.member_ids, original.member_ids); assert.deepEqual(repaired.fields, original.fields); assert.deepEqual(repaired.measurement, original.measurement); assert.equal(repaired.purpose, 'length-only');
    assert.equal(response.item_results.find(item => item.id === original.id).length_m, evidence[mode].length_m);
    evidence[mode].repaired_calibration = repaired.measurement.calibration_id;
    evidence[mode].removedCalibrationButtonAbsent = true; evidence[mode].retiredInsetNotAutomaticallyRepaired = true;
    evidence[mode].calibrationRepairPath = 'explicit guarded command API plus public prepareProject/applyProject/open; not native UI';
    await expect(page.locator('.takeoff-settings-tools').getByRole('button', { name: /^(Attach|Change) length calibration$/ })).toHaveCount(0);
    await page.locator('#view-takeoffs').getByRole('button', { name: 'Settings', exact: true }).click();
  }
  // A deliberately slow options request must never delay the duct form itself.
  await chooseTakeoff(page, 'DUCT');
  const traceSource = beforeRepair.items.find(item => item.id === evidence.WALLS.id);
  await expect(page.getByLabel('Drawing document', { exact: true })).toHaveValue(traceSource.geometry.document_id);
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill(String(traceSource.geometry.page)); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, traceSource.geometry.page);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  const drawingCalibration = traceSource.measurement.calibration_id;
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByLabel('Drawing calibration', { exact: true }).selectOption(drawingCalibration);
  await expect(page.getByLabel('Drawing calibration', { exact: true })).toHaveValue(drawingCalibration); await idle();
  evidence.explicitDrawingCalibrationSelected = drawingCalibration;
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await page.mouse.click(...await screen([350, 200])); await page.mouse.click(...await screen([450, 200]));
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/takeoffs/options?**', async route => { await gate; await route.continue(); });
  const started = Date.now(); await page.locator('.takeoff-viewport').press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add duct object', exact: true })).toBeVisible({ timeout: 1000 });
  evidence.dialog_visible_ms = Date.now() - started; await expect(page.getByRole('dialog').getByRole('button', { name: 'Add item', exact: true })).toBeDisabled();
  release(); await expect(page.getByRole('dialog').getByRole('button', { name: 'Add item', exact: true })).toBeEnabled(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); await page.unroute('**/api/takeoffs/options?**');
  await idle();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.CeasefireTakeoffs.projectFingerprint());
    return { busy: state.busy, modal: state.modal, finishing: state.countFinishing };
  })).toEqual({ busy: false, modal: false, finishing: false });
  const current = await snapshot(); assert.equal(current.documents[0].sha256, before.documents[0].sha256); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []);
  // The hidden Steel creation button must not make historical standalone counts
  // disappear from a saved project. Reopen the real native Save As companion
  // bundle and compare all retained fields, member IDs and source geometry.
  await response(() => clickProjectControl(page, 'Save'), '/api/project/save-as');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.items, current.items);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); assert.deepEqual((await snapshot()).items, current.items); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  await chooseTakeoff(page, 'STEEL'); await expect(page.getByRole('button', { name: 'Count', exact: true })).toHaveCount(0); await expect(page.locator(`.takeoff-register-table tr[data-item-id="${evidence.STEEL.id}"]`)).toHaveCount(1); await expect(page.locator('.takeoff-standalone-register')).toHaveCount(0); evidence.retainedCountsSavedReopened = true;
  await page.setViewportSize({ width: 764, height: 764 }); await page.locator(`.takeoff-register-table tr[data-item-id="${evidence.STEEL.id}"]`).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'counts-narrow.png') });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, evidence, operations, errors }, null, 2)); console.log(`Standalone measurements browser acceptance passed: ${output}`);
})().catch(async error => { console.error(error); console.error(logs); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.kill(); });
