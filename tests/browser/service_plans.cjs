const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Real penetration sub-tabs, barrier markers and project round trips. Every
// source, database and native-dialog save target belongs to this fixture.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `service-plans-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || 'python';
fs.mkdirSync(output, { recursive: true });
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '', origin, state;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } }
  });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], caughtErrors = [], previews = [], evidence = {};
const details = () => page.getByRole('complementary', { name: 'Item Details', exact: true });
const row = id => page.locator(`tr[data-physical-id="${id}"]`);
const marker = id => page.locator(`.takeoff-physical-marker-hit[data-physical-id="${id}"]`);
const callout = id => page.locator(`.takeoff-physical-callout[data-physical-id="${id}"]`);
const graph = scope => state[scope === 'service_plans' ? 'service_plans' : 'physical'];
const entity = (id, scope = 'service_plans') => ['defects', 'barriers', 'services'].flatMap(kind => graph(scope)?.[kind] || []).find(value => value.id === id);
const sha = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const sourcePoint = event => [20 + (event.y - event.box.y) / event.box.height * 780, 30 + (event.x - event.box.x) / event.box.width * 540];
async function summaryContains(id, text) {
  // SVG tspans are separate rendered lines; textContent joins their endpoints
  // without whitespace even though the PDF user sees separate words.
  await expect.poll(async () => (await callout(id).locator('tspan').allTextContents()).join(' ')).toContain(text);
}
async function idle() {
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true');
}
async function snapshot() {
  await idle(); let value;
  await expect.poll(async () => { try { value = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true);
  state = value; return value;
}
async function response(action, suffix) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending, body = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(body)); return body;
}
async function renderedPage(action, number, detectScale = false) {
  const pending = [page.waitForResponse(reply => reply.url().endsWith('/commands') && reply.request().postDataJSON()?.op === 'record_render' && reply.request().postDataJSON()?.page === number)];
  if (detectScale) pending.push(page.waitForResponse(reply => reply.url().endsWith('/auto-calibrate') && reply.request().postDataJSON()?.page === number));
  pending.forEach(value => value.catch(() => {})); await action();
  for (const reply of await Promise.all(pending)) assert.equal(reply.status(), 200, await reply.text());
  await idle(); await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(number));
  await expect(page.locator('.takeoff-progress')).toHaveText(`synthetic-drawings.pdf · Page ${number} · Original source`);
}
async function fill(scope, fields) {
  for (const [label, value] of Object.entries(fields)) {
    const control = scope.getByLabel(label, { exact: true });
    if (await control.evaluate(el => el.tagName) === 'SELECT') await control.selectOption(String(value)); else await control.fill(String(value));
  }
}
async function dialog(title, fields, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await fill(modal, fields); await modal.getByRole('button', { name: action, exact: true }).click();
}
async function apply(title) {
  const reply = await response(() => dialog(title, {}, 'Apply draft change'), '/physical/apply'); state = reply.snapshot; await idle(); return reply;
}
async function create(kind, fields, trigger) {
  await page.getByRole('button', { name: trigger || `Add ${kind}`, exact: true }).click();
  const preview = await response(() => dialog(`Create draft ${kind}`, fields, 'Preview new draft'), '/physical/preview');
  await apply(`Create one draft ${kind}?`); return preview.changed_ids[0];
}
async function select(id) {
  await row(id).locator('.takeoff-row-link').click(); await idle(); await expect(details()).toBeVisible();
}
async function tab(name) { await page.getByRole('tab', { name, exact: true }).click(); await idle(); await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true'); }
// Rotated fixture page 3: crop [20,30,800,570], clockwise rotation 90, UserUnit 2.
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await page.locator('.takeoff-viewport').evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12); });
  const box = await overlay.boundingBox(), point = [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
  assert.equal(await page.evaluate(([cx, cy]) => !!document.elementFromPoint(cx, cy)?.closest('.takeoff-viewport'), point), true, `Point ${point} must lie on the visible plan`);
  return point;
}
async function saveAndLoad(info) {
  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project'); const saved = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await renderedPage(() => page.getByRole('button', { name: 'Takeoffs', exact: true }).click(), 1, true);
  await idle(); return saved;
}
async function exportDraft(format) {
  await page.getByRole('button', { name: `Export draft ${format}`, exact: true }).click(); const pending = page.waitForEvent('download');
  await dialog('Export unapproved physical draft?', {}, 'Export unapproved draft'); const download = await pending;
  const filename = path.join(output, download.suggestedFilename()); await download.saveAs(filename); return filename;
}
async function downloadDrawing() {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await pending, filename = path.join(output, download.suggestedFilename()); await download.saveAs(filename); return filename;
}
function pythonJson(code, filename) {
  const result = spawnSync(python, ['-c', code, filename], { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function controls() {
  const controls = await page.locator('.takeoff-physical-add-row').evaluate(el => ({
    previous: el.previousElementSibling.className, next: el.nextElementSibling.className,
    names: [...el.querySelectorAll('button')].map(button => button.getAttribute('aria-label') || button.textContent),
  }));
  assert.ok(controls.previous.includes('takeoff-register-table')); assert.ok(controls.next.includes('takeoff-register-controls'));
  assert.deepEqual(controls.names, ['Add substrate', 'Delete selected records']);
  const trash = page.getByRole('button', { name: 'Delete selected records', exact: true }), discard = details().getByRole('button', { name: 'Discard unfinished physical edits', exact: true });
  await expect(discard).toHaveCount(1); await expect(page.getByRole('button', { name: 'Discard unfinished physical edits', exact: true })).toHaveCount(1);
  await expect(page.locator('.takeoff-physical-register').getByRole('button', { name: 'Discard unfinished physical edits', exact: true })).toHaveCount(0);
  const style = locator => locator.evaluate(el => { const css = getComputedStyle(el); return { color: css.color, background: css.backgroundColor, border: css.borderColor }; });
  assert.deepEqual(await style(trash), await style(discard));
  for (const name of ['Select filtered records', 'Clear physical selection', 'Bulk edit same-type records']) {
    const button = page.getByRole('button', { name, exact: true }); await expect(button.locator('svg')).toHaveCount(1); assert.equal((await button.innerText()).trim(), '');
  }
  const checked = page.getByRole('button', { name: 'Select filtered records', exact: true }), unchecked = page.getByRole('button', { name: 'Clear physical selection', exact: true });
  assert.notEqual(await checked.locator('svg').innerHTML(), await unchecked.locator('svg').innerHTML(), 'Selection actions must have visibly different checked and unchecked icons');
  for (const format of ['CSV', 'XLSX']) {
    const button = page.getByRole('button', { name: `Export draft ${format}`, exact: true }); await expect(button).toContainText(format);
    const css = await style(button); assert.equal(css.background, 'rgb(43, 34, 40)'); assert.equal(css.color, 'rgb(255, 255, 255)');
  }
  const scale = await page.getByRole('button', { name: 'Scale', exact: true }).boundingBox(), count = await page.getByRole('button', { name: 'Count', exact: true }).boundingBox();
  assert.ok(count.y >= scale.y + scale.height && Math.abs(count.x - scale.x) < 2, 'Count sits directly below Scale in the left rail');
  await expect(page.getByRole('complementary', { name: 'Physical draft inspector', exact: true })).toHaveCount(0);
  await expect(page.locator('.takeoff-physical-register .takeoff-physical-inspector')).toHaveCount(0);
  evidence.controls = controls;
}

(async () => {
  const info = await ready; assert.notEqual(info.port, 8765, 'Use disposable fixture storage, never the live server'); origin = `http://127.0.0.1:${info.port}`;
  const sourceBefore = sha(info.fixture); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  const debuggerSession = await page.context().newCDPSession(page), scripts = new Map();
  debuggerSession.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, event.url));
  await debuggerSession.send('Debugger.enable'); await debuggerSession.send('Debugger.setPauseOnExceptions', { state: 'all' });
  debuggerSession.on('Debugger.paused', event => { if (event.data && !event.callFrames.every(frame => scripts.get(frame.location.scriptId)?.includes('/vendor/'))) { caughtErrors.push({ reason: event.reason, data: event.data, stack: event.callFrames.map(frame => ({ name: frame.functionName, url: scripts.get(frame.location.scriptId) || frame.url, location: frame.location })) }); fs.writeFileSync(path.join(output, 'caught-errors.json'), JSON.stringify(caughtErrors, null, 2)); } void debuggerSession.send('Debugger.resume').catch(() => {}); });
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/physical/preview')) previews.push(request.postDataJSON()); });
  await page.addInitScript(() => {
    window.qaCsp = []; window.qaDrawingEvents = [];
    document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    for (const type of ['click', 'pointerdown', 'pointerup']) document.addEventListener(type, event => {
      if (!event.target.closest('.takeoff-viewport')) return;
      const box = document.querySelector('.takeoff-overlay')?.getBoundingClientRect();
      if (box) window.qaDrawingEvents.push({ type, x: event.clientX, y: event.clientY, box: { x: box.x, y: box.y, width: box.width, height: box.height } });
    }, true);
  });
  const initial = await page.goto(origin); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect.poll(() => page.evaluate(() => window.CeasefireDesktop?.status().ready)).toBe(true);
  const calculatorBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const definitionReply = await page.request.post(`${origin}/api/penetration/definition`, { data: { configuration: await page.evaluate(() => window.CeasefireProject.configuration()) } });
  assert.equal(definitionReply.status(), 200); const definitions = await definitionReply.json();
  const frls = definitions.row_fields.find(field => field.column === 'N').options;
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('[data-mode="physical"]').click(); await idle();
  await expect(page.getByRole('tab', { name: 'Defect Reports', exact: true })).toHaveAttribute('aria-selected', 'true');
  await renderedPage(() => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1, true);
  const defect = await create('defect', { 'Defect Ref.': 'REPORT-A', 'FRL': '-/120/120' });
  const reportBarrier = await create('barrier', { 'Barrier type': 'Core hole', 'Substrate': 'Concrete/masonry wall', 'Location': 'Report only' }, 'Add barrier to D-0001');
  const reportService = await create('service', { 'Category': 'Mechanical', 'Explicit service quantity': 3, 'Service Size (mm)': '25' }, 'Add service to B-0001');
  const reportBefore = structuredClone(state.physical);
  await tab('Service Plans'); await expect(page.locator('tr[data-physical-id]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add defect', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Defect ID', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add substrate', exact: true }).click();
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: 'Create draft barrier', exact: true })).toBeVisible();
  await expect(modal.getByLabel(/Defect/)).toHaveCount(0);
  assert.deepEqual(await modal.getByLabel('FRL', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), frls);
  const preview = await response(() => dialog('Create draft barrier', { 'Barrier type': 'Core hole', 'Substrate': 'Concrete/masonry wall', 'Substrate orientation': 'Vertical', 'Location': 'PLAN-A', 'FRL': '-/90/90' }, 'Preview new draft'), '/physical/preview');
  await apply('Create one draft barrier?'); const barrier = preview.changed_ids[0];
  assert.equal(state.service_plans.version, 3); assert.ok(!Object.hasOwn(state.service_plans, 'defects')); assert.ok(!Object.hasOwn(entity(barrier), 'defect_id')); assert.equal(entity(barrier).fields.frl, '-/90/90');
  assert.deepEqual(state.physical, reportBefore); await expect(row(barrier)).toContainText('B-0001'); await expect(details().getByLabel('FRL', { exact: true })).toHaveValue('-/90/90');
  const service = await create('service', { 'Category': 'Mechanical', 'Explicit service quantity': 2, 'Service Size (mm)': '32', 'Width x Height (mm)': '100x80' }, 'Add service in Item Details');
  assert.equal(entity(service).barrier_id, barrier); assert.ok(!Object.hasOwn(entity(service).fields, 'frl')); await expect(details().getByLabel('FRL', { exact: true })).toHaveCount(0);
  await expect(row(service)).toContainText('-/90/90'); await controls();
  evidence.hierarchy = { defect, reportBarrier, reportService, barrier, service, independentSequences: true, barrierFrl: true };
  console.log('Independent hierarchies, barrier FRL and register controls passed.');
  await renderedPage(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3, true);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  // A blank drawing click clears physical selection without rendering a steel/duct register.
  // A queued ordinary-register options refresh must also be harmless after switching scopes.
  await page.getByLabel('Destination schedule', { exact: true }).evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
  await select(barrier); await page.getByRole('button', { name: 'Select', exact: true }).click(); await page.mouse.click(...await screen([240,170]));
  await expect(details()).toBeHidden(); await expect(row(barrier).getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('alert').filter({ hasText: "Cannot read properties of undefined (reading 'find')" })).toHaveCount(0);
  evidence.blankDrawingSelection = true;
  await select(barrier); await page.getByRole('button', { name: 'Count', exact: true }).click(); await page.mouse.click(...await screen([240,170]));
  await response(() => dialog('Place barrier marker', { 'Barrier': 'existing' }, 'Continue'), '/physical/apply'); await snapshot();
  await expect(marker(barrier)).toBeVisible(); await expect(details()).toBeVisible();
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'select');
  const originalMarker = structuredClone(entity(barrier).marker); assert.equal(originalMarker.page, 3); assert.equal(originalMarker.document_sha256, sourceBefore);
  evidence.placedMarker = originalMarker;
  const placedClick = await page.evaluate(() => window.qaDrawingEvents.filter(event => event.type === 'click').at(-1)), exactPlacedPoint = sourcePoint(placedClick);
  for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(originalMarker.point[axis] - exactPlacedPoint[axis]) < 1e-7, `Placed source coordinates ${originalMarker.point} from ${JSON.stringify(placedClick)}`);
  for (const text of ['B-0001', 'PLAN-A', 'Concrete/masonry wall', 'FRL -/90/90', 'S-0001', '2 ×', '100 x 80 mm']) await summaryContains(barrier, text);
  assert.ok(await callout(barrier).locator('text').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 10, 'The fitted-page callout must remain readable on screen');
  const calloutPlacement = await callout(barrier).evaluate(el => {
    const hit = [...el.parentElement.querySelectorAll('.takeoff-physical-marker-hit')].find(candidate => candidate.dataset.physicalId === el.dataset.physicalId);
    const shape = hit.previousElementSibling, box = el.querySelector('rect');
    return { point: [Number(shape.getAttribute('cx')), Number(shape.getAttribute('cy'))], radius: Number(shape.getAttribute('r')), box: ['x', 'y', 'width', 'height'].map(key => Number(box.getAttribute(key))) };
  });
  const [markerX, markerY] = calloutPlacement.point, [boxX, boxY, boxWidth, boxHeight] = calloutPlacement.box;
  assert.ok(markerX < boxX || markerX > boxX + boxWidth || markerY < boxY || markerY > boxY + boxHeight, `The fitted-page callout must not cover its marker centre: ${JSON.stringify(calloutPlacement)}`);
  const dx = Math.max(boxX - markerX, 0, markerX - boxX - boxWidth), dy = Math.max(boxY - markerY, 0, markerY - boxY - boxHeight);
  assert.ok(Math.hypot(dx, dy) > calloutPlacement.radius, 'The complete red marker must remain clear of callout text');
  evidence.calloutPlacement = calloutPlacement;
  assert.equal(state.calibrations.length, 0, 'A barrier Count marker requires no scale'); assert.equal(state.items.length, 0, 'Barrier counts must not create steel/duct quantity rows');
  const detailBox = await page.locator('.takeoff-physical-details').boundingBox(), drawingBox = await page.locator('.takeoff-viewport').boundingBox();
  assert.ok(detailBox.x + detailBox.width <= drawingBox.x + 2, 'Item Details sits left of the PDF page');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(details()).toBeHidden();
  await marker(barrier).click(); await expect(details()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(details()).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(details()).toBeVisible();
  evidence.countPlacement = { marker: originalMarker, derivedCallout: true, noScaleRequired: true, paneOnSelectionAndSettings: true };
  console.log('Count placement, exact rotated coordinates, automatic callout and Item Details passed.');
  await page.locator('.takeoff-physical-details').evaluate(el => { el.scrollTop = 0; });
  await page.getByRole('heading', { name: 'TAKEOFFS', exact: true }).evaluate(el => {
    const header = document.querySelector('header').getBoundingClientRect();
    window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12);
  });
  await expect(page.getByRole('tab', { name: 'Defect Reports', exact: true })).toBeInViewport();
  await expect(page.getByRole('tab', { name: 'Service Plans', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(output, 'service-plan-marker-item-details.png') });

  await select(service);
  for (const [label,value] of Object.entries({'Explicit service quantity':5,'Service Size (mm)':'50','Width x Height (mm)':'120x90'})) { await response(async()=>{const control=details().getByLabel(label,{exact:true});await control.fill(String(value));await control.press('Tab');},'/physical/apply');await idle();await snapshot(); }
  // A scope switch flushes input without an extra field-review dialog.
  await tab('Defect Reports'); await expect(page.getByRole('tab',{name:'Defect Reports',exact:true})).toHaveAttribute('aria-selected','true'); await tab('Service Plans');
  for (const text of ['5 \u00d7', '50', '120 x 90 mm']) await summaryContains(barrier, text);
  await expect(callout(barrier)).not.toContainText('2 ×'); assert.deepEqual(entity(barrier).marker, originalMarker); assert.deepEqual(state.physical, reportBefore);
  evidence.derivedSummaryUpdates = true;

  // Drag only the marker, then inspect the validated source coordinates. No
  // quantity, dimensions, parent link or original source evidence can change.
  await marker(barrier).click(); const beforeMove = structuredClone(entity(barrier)), serviceBeforeMove = structuredClone(entity(service));
  const start = await screen(originalMarker.point), finish = await screen([290, 220]);
  await response(async () => { await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...finish, { steps: 8 }); await page.mouse.up(); }, '/physical/apply'); await snapshot();
  const movedMarker = structuredClone(entity(barrier).marker);
  assert.deepEqual(entity(barrier).fields, beforeMove.fields); assert.deepEqual(entity(barrier).evidence, beforeMove.evidence); assert.deepEqual(entity(service), serviceBeforeMove);
  const dragEvents = await page.evaluate(() => window.qaDrawingEvents.filter(event => event.type !== 'click').slice(-2));
  assert.deepEqual(dragEvents.map(event => event.type), ['pointerdown', 'pointerup']); const dragStart = sourcePoint(dragEvents[0]), dragEnd = sourcePoint(dragEvents[1]);
  for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(movedMarker.point[axis] - (originalMarker.point[axis] + dragEnd[axis] - dragStart[axis])) < 1e-7, `Dragged source coordinate ${axis}: ${movedMarker.point}`);
  assert.equal(movedMarker.page, 3); assert.equal(movedMarker.document_sha256, sourceBefore); evidence.markerMove = { before: originalMarker, after: movedMarker };

  // Count on an already marked barrier creates another independent barrier;
  // it never repeats that barrier's existing service quantity.
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await page.mouse.click(...await screen([440, 360]));
  const secondPreview = await response(() => dialog('Create draft barrier', { 'Location': 'PLAN-B', 'Barrier type': 'Empty Opening', 'FRL': '-/60/60' }, 'Preview new draft'), '/physical/preview');
  await apply('Create one draft barrier?'); const secondBarrier = secondPreview.changed_ids[0];
  assert.equal(entity(secondBarrier).display_id, 'B-0002'); assert.equal(state.service_plans.services.length, 1); await summaryContains(secondBarrier, '0 services');
  assert.deepEqual(state.physical, reportBefore); evidence.countCreatesIndependentBarrier = secondBarrier;
  console.log('Automatic field changes, exact marker movement and independent Count creation passed.');

  await tab('Defect Reports'); await expect(row(defect)).toBeVisible(); await expect(row(barrier)).toHaveCount(0); await expect(marker(barrier)).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Defect ID', exact: true })).toBeVisible(); await snapshot(); assert.deepEqual(state.physical, reportBefore);
  await select(reportBarrier); await details().getByRole('button', { name: 'Place count marker', exact: true }).click();
  await response(async () => page.mouse.click(...await screen([330, 320])), '/physical/apply'); await snapshot();
  await summaryContains(reportBarrier, 'FRL -/120/120'); await summaryContains(reportBarrier, '3 ×');
  const savedReport = structuredClone(state.physical); await tab('Service Plans');
  await expect(marker(reportBarrier)).toHaveCount(0); await expect(marker(barrier)).toBeVisible(); await expect(marker(secondBarrier)).toBeVisible();
  evidence.scopedMarkers = true;

  const beforeRoundtrip = structuredClone(await snapshot()), saved = await saveAndLoad(info); await tab('Service Plans'); await snapshot();
  assert.deepEqual(state.physical, beforeRoundtrip.physical); assert.deepEqual(state.service_plans, beforeRoundtrip.service_plans);
  assert.deepEqual(saved.takeoffs.physical, beforeRoundtrip.physical); assert.deepEqual(saved.takeoffs.service_plans, beforeRoundtrip.service_plans);
  await renderedPage(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3, true);
  await expect(marker(barrier)).toBeVisible(); await marker(barrier).click(); await expect(details().getByLabel('FRL', { exact: true })).toHaveValue('-/90/90');
  await summaryContains(barrier, '5 ×'); evidence.savedReopenedGraphsAndMarkers = true;
  console.log('Scoped marks and exact Save As / reopen graph preservation passed.');

  const csv = await exportDraft('CSV'), xlsx = await exportDraft('XLSX'), pdf = await downloadDrawing();
  const csvText = fs.readFileSync(csv, 'utf8'); assert.ok(csvText.includes(barrier)); assert.ok(csvText.includes(service)); assert.ok(!csvText.includes(defect)); assert.ok(!csvText.includes(reportBarrier)); assert.ok(!csvText.split('\n')[0].includes('defect'));
  const workbook = pythonJson("import json,sys\nfrom openpyxl import load_workbook\nw=load_workbook(sys.argv[1],data_only=False)\nprint(json.dumps({'sheets':w.sheetnames,'formulas':[c.coordinate for s in w for r in s for c in r if c.data_type=='f']}))", xlsx);
  assert.ok(workbook.sheets.includes('Barriers')); assert.ok(workbook.sheets.includes('Services')); assert.ok(!workbook.sheets.includes('Defects')); assert.deepEqual(workbook.formulas, []);
  const pdfText = pythonJson("import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1]);print(json.dumps({'text':'\\n'.join(p.extract_text() or '' for p in r.pages),'pages':len(r.pages)}))", pdf);
  for (const text of ['PLAN-A', 'PLAN-B', 'B-0001', 'S-0001', '-/90/90', 'Unapproved draft']) assert.ok(pdfText.text.includes(text), text);
  assert.ok(!pdfText.text.includes('Report only')); assert.ok(pdfText.text.includes('Rotated crop with UserUnit 2')); assert.equal(sha(info.fixture), sourceBefore);
  evidence.exports = { csv: path.basename(csv), xlsx: workbook, pdf: { filename: path.basename(pdf), pages: pdfText.pages }, sourceSha256: sourceBefore };
  console.log('Scoped CSV, values-only XLSX and marked PDF exports passed.');

  // Removing a marker is independent of physical deletion, and both persist.
  const retainedBarrier = structuredClone(entity(barrier)), retainedService = structuredClone(entity(service));
  await marker(barrier).click({ button: 'right' });
  await response(() => page.getByRole('menuitem', { name: 'Remove count marker', exact: true }).click(), '/physical/preview'); await apply('Remove barrier count marker?');
  assert.equal(entity(barrier).marker, null); assert.equal(entity(barrier).deleted, false); assert.deepEqual(entity(service), retainedService);
  assert.deepEqual(entity(barrier).fields, retainedBarrier.fields); await expect(marker(barrier)).toHaveCount(0); await expect(row(barrier)).toBeVisible();
  await select(secondBarrier); const secondBeforeDelete = structuredClone(entity(secondBarrier));
  await details().getByRole('button', { name: 'Delete draft record', exact: true }).click();
  await response(() => dialog('Delete draft barrier', { 'Deletion scope': 'only' }, 'Preview deletion'), '/physical/preview'); await apply('Review recoverable deletion');
  assert.equal(entity(secondBarrier).deleted, true); assert.deepEqual(entity(secondBarrier).marker, secondBeforeDelete.marker); await expect(marker(secondBarrier)).toHaveCount(0);
  await page.getByLabel('Show deleted records', { exact: true }).check(); await select(secondBarrier);
  await details().getByRole('button', { name: 'Restore draft record', exact: true }).click();
  await response(() => dialog('Restore draft barrier', { 'Restore scope': 'same_deletion' }, 'Preview restoration'), '/physical/preview'); await apply('Review retained identities to restore');
  assert.equal(entity(secondBarrier).deleted, false); assert.deepEqual(entity(secondBarrier).marker, secondBeforeDelete.marker); await expect(marker(secondBarrier)).toBeVisible();
  assert.deepEqual(state.physical, savedReport); evidence.markerRemovalAndRecoverableDeletion = true;
  const removedRoundtrip = await saveAndLoad(info); await snapshot(); assert.equal(state.service_plans.barriers.find(item => item.id === barrier).marker, null); assert.deepEqual(state.service_plans, removedRoundtrip.takeoffs.service_plans);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorBefore); assert.deepEqual(errors, []); assert.equal(caughtErrors.some(error => /Cannot read properties of undefined \(reading 'find'\)/.test(error.data?.description || '')), false); assert.deepEqual(await page.evaluate(() => window.qaCsp), []); assert.equal(sha(info.fixture), sourceBefore);
  await tab('Service Plans'); await page.setViewportSize({ width: 764, height: 764 }); await page.locator('.takeoff-physical-register').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'service-plan-register-764.png'), fullPage: true });
  await renderedPage(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3, true);
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await marker(secondBarrier).click(); await expect(details()).toBeVisible(); await expect(details().getByLabel('FRL', { exact: true })).toHaveValue('-/60/60');
  await page.locator('.takeoff-physical-details').evaluate(el => { el.scrollTop = 0; });
  await page.locator('.takeoff-drawing-layout').evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12); });
  await page.screenshot({ path: path.join(output, 'service-plan-item-details-764.png') });
  assert.ok(previews.some(value => value.scope === 'service_plans')); assert.ok(previews.some(value => !value.scope || value.scope === 'defect_reports'));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, previews, errors, caughtErrors }, null, 2));
  console.log(`PASS: independent penetration sub-tabs, barrier FRL, Count markers and live callouts, Item Details, movement/removal/restoration, save/reopen and scoped exports. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-6000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
