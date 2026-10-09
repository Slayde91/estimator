const { chooseTakeoff } = require('./section_navigation.cjs');
const { chooseNewPhysicalItem, startDefect } = require('./physical_dialogs.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Physical detail navigation and explicit marker placement use a disposable source/server only.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { retainBarrierMarker } = require('./physical_marker_fixtures.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `physical-navigation-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '', state;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const details = () => page.getByRole('complementary', { name: 'Item Details', exact: true });
const row = id => page.locator(`tr[data-physical-id="${id}"]`);
const marker = id => page.locator(`.takeoff-physical-marker-hit[data-physical-id="${id}"]`);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function idle() {
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true');
}
async function snapshot() {
  await idle(); await expect.poll(async () => { try { state = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return state;
}
async function response(action, suffix) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending, result = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(result)); return result;
}
async function dialog(title, fields, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(fields)) { const control = modal.getByLabel(label, { exact: true }); if (await control.evaluate(el => el.tagName) === 'SELECT') await control.selectOption(String(value)); else await control.fill(String(value)); }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function apply(title) {
  const reply = await response(() => dialog(title, {}, 'Apply draft change'), '/physical/apply'); state = reply.snapshot; await idle(); return reply;
}
async function create(kind, fields, trigger) {
  if (!trigger) {
    if (kind === 'defect') await startDefect(page);
    else await details().getByRole('button', { name: `Add ${kind} in Item Details`, exact: true }).click();
  } else await trigger();
  await chooseNewPhysicalItem(page,kind);
  const preview = await response(() => dialog(kind === 'defect' ? 'Add Defect' : `Create draft ${kind}`, fields, 'Preview new draft'), '/physical/preview');
  await apply(`Create one draft ${kind}?`); return preview.changed_ids[0];
}
async function navigate(kind, id) {
  await details().getByLabel(`${kind} ID in Item Details`, { exact: true }).selectOption(id); await idle();
  await expect(details().getByLabel(`${kind} ID in Item Details`, { exact: true })).toHaveValue(id);
}
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await page.locator('.takeoff-viewport').evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12); });
  let box = await overlay.boundingBox(), point = [box.x + x / 842 * box.width, box.y + (595 - y) / 595 * box.height];
  await page.locator('.takeoff-viewport').evaluate((el, [px, py]) => {
    const frame = el.getBoundingClientRect();
    el.scrollLeft += px - (frame.left + el.clientWidth / 2);
    el.scrollTop += py - (frame.top + el.clientHeight / 2);
  }, point);
  box = await overlay.boundingBox(); point = [box.x + x / 842 * box.width, box.y + (595 - y) / 595 * box.height];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-overlay'), point), true, `Pointer reaches drawing at ${point}`); return point;
}
async function place(id, point, explicit = false) {
  if (explicit) {
    await expect(details().getByRole('button', { name: 'Place count marker', exact: true })).toHaveCount(0);
    await retainBarrierMarker(page, id, point);
    await row(id).getByRole('button', { name: 'Edit', exact: true }).click(); await idle();
  }
  await marker(id).dblclick({ delay: 100 }); await snapshot(); await expect(marker(id)).toBeVisible(); await expect(marker(id)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'select');
  const selectedGraph=await snapshot(),placed=[...selectedGraph.physical.barriers,...(selectedGraph.service_plans?.barriers||[])].find(value=>value.id===id);
  assert.ok(placed);assert.equal(placed.marker.appearance.marker_size,10);
  assert.deepEqual(placed.marker.point, point);
  (evidence.retainedBarrierMarkers ||= []).push({ id, point, removedCreationShortcutAbsent: true, nativeInspectionRetainsSource: true });
}
async function layout(width) {
  await page.setViewportSize({ width, height: width === 764 ? 764 : 1100 });
  await expect(details()).toBeVisible();
  // A sourced Defect retains its Marker Settings above Item Details. The narrow
  // pane scrolls; exercise native reachability before asserting table bounds.
  await page.locator('.takeoff-physical-navigation').scrollIntoViewIfNeeded();
  const boxes = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    return { source: box('.takeoff-source-documents'), details: box('.takeoff-physical-details'), drawing: box('.takeoff-viewport'), rail: box('.takeoff-tool-rail'), navigation: box('.takeoff-physical-navigation'), pageWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(boxes.source.y >= boxes.drawing.y && boxes.source.right <= boxes.drawing.right, `Source dropdown stays in the viewer at ${width}: ${JSON.stringify(boxes)}`);
  assert.ok(Math.abs(boxes.details.y - boxes.drawing.y) < 2 && Math.abs(boxes.rail.y - boxes.drawing.y) < 2, `Rail/details align with PDF at ${width}: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.navigation.right <= boxes.details.right && boxes.navigation.width > 100, 'Compact dropdown table remains inside the detail pane');
  assert.ok(boxes.navigation.y >= boxes.details.y && boxes.navigation.bottom <= boxes.details.bottom, 'Item Details navigation is fully reachable within its scrollable pane');
  if (width > 1000) assert.ok(boxes.details.right <= boxes.drawing.x, 'Wide Item Details sits beside PDF');
  assert.ok(boxes.scrollWidth <= boxes.pageWidth + 1, 'No document horizontal overflow');
  await page.locator('.takeoff-drawing-layout').evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - Math.max(0, header.bottom) - 12); });
  await page.screenshot({ path: path.join(output, `physical-navigation-${width}.png`) }); evidence[`layout${width}`] = boxes;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765, 'Never use the live app'); const sourceBefore = sha(info.fixture);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/physical/preview')) requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect.poll(() => page.evaluate(() => window.CeasefireDesktop?.status().ready)).toBe(true);
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await idle();
  await expect(page.getByRole('group', { name: 'Defect report count', exact: true })).toHaveCount(0);
  await page.locator('#takeoff-upload').setInputFiles(info.fixture); await expect(page.locator('.takeoff-progress')).toContainText('Original source'); await idle();
  const defect = await create('defect', { 'Defect Ref.': 'NAV-A', Location: 'Existing unplaced barrier', FRL: '-/120/120' });
  const barrier = await create('barrier', { Substrate: 'Concrete/masonry wall' });
  const service = await create('service', { Category: 'Mechanical', 'Explicit service quantity': 2, 'Service Size (mm)': '25' });
  assert.equal(state.physical.barriers[0].defect_id, defect); assert.equal(state.physical.services[0].barrier_id, barrier); assert.equal(state.physical.barriers[0].marker, undefined); assert.equal(state.documents.length, 1);
  const otherDefect = await create('defect', { 'Defect Ref.': 'NAV-B', Location: 'Second family', FRL: '-/90/90' });
  const otherBarrier = await create('barrier', {});
  const otherService = await create('service', { Category: 'Mechanical', 'Explicit service quantity': 3 });
  assert.equal(state.physical.barriers[1].defect_id, otherDefect); assert.equal(state.physical.services[1].barrier_id, otherBarrier); evidence.createdFromSource = { defect, barrier, service, otherDefect, otherBarrier, otherService };
  await expect(page.locator('.takeoff-physical-register')).not.toContainText('UNAPPROVED DRAFT. These are recorded physical assertions');
  await idle();
  await navigate('Defect', defect); await navigate('Barrier', barrier); await place(barrier, [270, 300], true);
  await expect(details().getByLabel('Defect Ref.', { exact: true })).toHaveValue('NAV-A'); await expect(details().getByLabel('Barrier ID in Item Details', { exact: true })).toHaveValue('');
  await expect(row(barrier).getByRole('checkbox', { name: /^Select / })).toBeChecked(); assert.equal(state.physical.barriers.length, 2); assert.equal(state.calibrations.length, 0);
  const firstMarker = structuredClone(state.physical.barriers[0].marker); assert.equal(firstMarker.document_sha256, sourceBefore); assert.equal(firstMarker.page, 1);
  assert.ok(state.physical.defects.every(value => value.annotation?.document_sha256 === sourceBefore), 'Current toolbar creation retains a distinct original-source annotation for each Defect');
  evidence.currentDefectToolbarSource = true;
  await navigate('Defect', otherDefect); await navigate('Service', otherService); await expect(details().getByLabel('Defect ID in Item Details', { exact: true })).toHaveValue(''); await expect(details().getByLabel('Defect ID in Item Details', { exact: true }).locator('option').first()).toHaveText('View D-0002'); await expect(details().getByLabel('Barrier ID in Item Details', { exact: true }).locator('option').first()).toHaveText('View B-0002');
  await expect(details().getByLabel('Explicit service quantity', { exact: true })).toHaveValue('3');
  await navigate('Barrier', otherBarrier); await expect(details().getByLabel('Location', { exact: true })).toHaveCount(0); await expect(row(otherBarrier)).toContainText('Second family');
  await navigate('Defect', otherDefect); await expect(details().getByLabel('Defect Ref.', { exact: true })).toHaveValue('NAV-B'); await expect(details().getByLabel('Location', { exact: true })).toHaveValue('Second family');
  await navigate('Service', otherService);
  const newBarrier = await create('barrier', {}, () => row(otherDefect).getByRole('button', { name: /^Add barrier to / }).click());
  assert.equal(state.physical.barriers.at(-1).defect_id, otherDefect); await place(newBarrier, [500, 300], true);
  await expect(details().getByLabel('Defect Ref.', { exact: true })).toHaveValue('NAV-B');
  const newService = await create('service', { Category: 'Mechanical', 'Explicit service quantity': 4 }, () => row(newBarrier).getByRole('button', { name: /^Add service to / }).click()); assert.equal(state.physical.services.at(-1).barrier_id, newBarrier);
  await marker(barrier).dblclick({ delay: 100 }); await expect(details().getByLabel('Defect Ref.', { exact: true })).toHaveValue('NAV-A'); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'true');
  const navigation = details().getByRole('table', { name: 'Item Details navigation', exact: true });
  assert.deepEqual(await navigation.getByRole('columnheader').allTextContents(), ['Defect', 'Barrier', 'Service']);
  for (const [kind, expected] of [['Defect', [defect, otherDefect]], ['Barrier', [barrier]], ['Service', [service]]]) assert.deepEqual(await navigation.getByLabel(`${kind} ID in Item Details`, { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), expected);
  await expect(details().locator('.takeoff-physical-defect-id')).toHaveText('Defect ID: D-0001');
  for (const action of ['View','Edit']) { await row(service).getByRole('button',{name:action,exact:true}).click(); await idle(); const geometry=await page.evaluate(()=>({drawing:document.querySelector('.takeoff-viewport').getBoundingClientRect().top,header:document.querySelector('.app-header').getBoundingClientRect().bottom})); assert.ok(Math.abs(geometry.drawing-geometry.header-12)<3, JSON.stringify(geometry)); await expect(details()).toBeVisible(); }
  await navigate('Defect',defect);
  const previews = requests.length; await details().getByLabel('Notes', { exact: true }).fill('Retain unfinished Defect edit');
  await response(()=>navigation.getByLabel('Service ID in Item Details', { exact: true }).selectOption(service),'/physical/apply'); await idle(); await snapshot(); assert.equal(state.physical.defects.find(entry=>entry.id===defect).fields.notes,'Retain unfinished Defect edit'); await expect(details().getByLabel('Service ID in Item Details', { exact: true })).toHaveValue(service); assert.equal(requests.length, previews+1);
  await page.locator('.takeoff-physical-details').evaluate(el => { el.scrollTop = el.scrollHeight; }); await marker(barrier).dblclick({ delay: 100 });
  await expect.poll(() => page.locator('.takeoff-physical-details').evaluate(el => el.scrollTop)).toBe(0);
  await layout(1600); await layout(764); evidence.markerKeepsSelectionAndOpensDefect = true;
  await chooseTakeoff(page, 'Service Plans'); await idle(); await page.setViewportSize({ width: 1600, height: 1100 });
  await expect(page.getByRole('group', { name: 'Defect report count', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add Defect', exact: true })).toHaveCount(0);
  const planBarrier = await create('barrier', { Location: 'Independent plan', FRL: '-/60/60' }, () => page.getByRole('button', { name: 'Add substrate', exact: true }).click());
  assert.equal(state.service_plans.barriers[0].id, planBarrier); assert.equal(state.service_plans.barriers[0].defect_id, undefined); assert.equal(state.service_plans.defects, undefined);
  assert.deepEqual(await details().getByRole('table', { name: 'Item Details navigation', exact: true }).getByRole('columnheader').allTextContents(), ['Barrier', 'Service']);
  await expect(details().getByLabel('Defect ID in Item Details', { exact: true })).toHaveCount(0); await expect(details().getByLabel('FRL', { exact: true })).toHaveValue('-/60/60'); evidence.servicePlanIsolation = true;
  await chooseTakeoff(page, 'Defect Reports'); await idle(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await navigate('Defect', defect); await navigate('Barrier', barrier);
  assert.deepEqual((await snapshot()).physical.barriers[0].marker, firstMarker);
  const beforeSave = structuredClone(state); await response(() => clickProjectControl(page, 'Save'), '/api/project/save-as'); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.physical, beforeSave.physical); assert.deepEqual(saved.takeoffs.service_plans, beforeSave.service_plans);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await snapshot(); assert.deepEqual(state.physical, beforeSave.physical); assert.deepEqual(state.service_plans, beforeSave.service_plans);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []); assert.equal(sha(info.fixture), sourceBefore);
  evidence.savedReopened = true; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, requests, errors }, null, 2));
  console.log(`PASS: Source Call-out creation, correct parents, explicit marker placement, Defect-first inspection, active-ID navigation, pending guards, separate Service Plans, responsive source/panel alignment and Save/Load. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-4000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
