const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Real keyboard/pointer copy and paste. All sources, saves and server state are disposable.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `length-copy-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '', pageNumber = 1;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const row = id => page.locator(`tr[data-item-id="${id}"]`);
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() {
  await idle(); let result;
  await expect.poll(async () => { try { result = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true);
  return result;
}
async function command(action, op, status = 200) {
  const pending = page.waitForResponse(reply => reply.url().endsWith('/commands') && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, result = await response.json(); assert.equal(response.status(), status, JSON.stringify(result)); await idle(); return result;
}
async function fill(scope, values) {
  for (const [label, value] of Object.entries(values)) {
    const field = scope.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await fill(modal, values); await modal.getByRole('button', { name: action, exact: true }).click();
}
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  const box = await overlay.boundingBox();
  const point = pageNumber === 3 ? [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height]
    : [box.x + x / 842 * box.width, box.y + (595 - y) / 595 * box.height];
  assert.equal(await page.evaluate(([cx, cy]) => !!document.elementFromPoint(cx, cy)?.closest('.takeoff-overlay'), point), true, `Pointer reaches drawing at ${point}`);
  return point;
}
async function navigate(number) {
  await rendered(async () => { await page.getByLabel('Page number', { exact: true }).fill(String(number)); await page.getByLabel('Page number', { exact: true }).press('Tab'); });
  pageNumber = number; await expect(page.locator('.takeoff-progress')).toHaveText(`synthetic-drawings.pdf · Page ${number} · Original source`);
  await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click());
}
async function rendered(action) {
  await renderDrawing(page, action);
}
async function scale(denominator) {
  const choice = page.getByLabel('Drawing calibration', { exact: true });
  if (!await choice.isVisible()) await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await choice.selectOption(`scale:${denominator}`);
  return command(() => dialog(`Apply drawing scale 1:${denominator}?`, {}, 'Apply scale'), 'add_calibration');
}
async function create(mode, vertices, values) {
  await chooseTakeoff(page, mode);
  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  for (const point of vertices) await page.mouse.click(...await screen(point));
  await page.locator('.takeoff-viewport').press('Enter');
  const response = await command(() => dialog(`Add ${mode} object`, values, 'Add item'), 'create_item');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  return response.snapshot.items.at(-1);
}
async function select(id) {
  await row(id).locator('.takeoff-row-link').click(); await idle(); await expect(page.locator('.takeoff-viewport')).toBeFocused();
  await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await page.locator('.takeoff-viewport').focus();
}
async function copy(id) {
  await select(id); await page.keyboard.press('Control+c');
  await expect(page.locator('#takeoffs-workspace .message')).toContainText('Copied 1 Length markup');
}
async function paste(point, status = 200) {
  await page.locator('.takeoff-viewport').focus(); await page.mouse.move(...await screen(point));
  return command(() => page.keyboard.press('Control+v'), 'duplicate_items', status);
}
function assertCopy(original, copy, response, point, length) {
  for (const key of ['fields', 'quantity', 'appearance', 'evidence']) assert.deepEqual(copy[key], original[key], key);
  assert.notEqual(copy.id, original.id); assert.equal(copy.state, 'draft'); assert.equal(copy.review, null); assert.equal(copy.confirmation, null);
  assert.deepEqual(copy.predecessor_ids, []); assert.deepEqual(copy.copied_from, { item_id: original.id, version: original.version });
  assert.ok(copy.member_ids.every(id => !original.member_ids.includes(id)));
  assert.ok(copy.geometry.points[0].every((value, index) => Math.abs(value - point[index]) < .05), 'First source control point lands at pointer');
  const result = response.item_results.find(value => value.id === copy.id);
  assert.ok(Math.abs(result.length_m - length) < 1e-8); assert.ok(Math.abs(result.total_length_m - length * original.quantity) < 1e-8);
}
async function assertRow(copy, response) {
  await expect(row(copy.id)).toBeVisible(); await expect(row(copy.id).getByRole('checkbox', { name: /^Select / })).toBeChecked();
  await expect(row(copy.id).getByLabel(copy.mode === 'steel' ? 'Member mark' : 'Item', { exact: true })).toHaveValue(copy.fields.mark);
  await expect(row(copy.id).getByLabel('Level', { exact: true })).toHaveValue(copy.fields.level);
  await expect(row(copy.id).getByLabel('Quantity', { exact: true })).toHaveValue(String(copy.quantity));
  const length = response.item_results.find(value => value.id === copy.id).length_m;
  await expect(row(copy.id)).toContainText(length.toFixed(2));
}
async function saveLoad(info) {
  const saving = page.waitForResponse(reply => reply.url().endsWith('/api/project/save-as')); saving.catch(() => {});
  await clickProjectControl(page, 'Save As'); assert.equal((await saving).status(), 200);
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  const opening = page.waitForResponse(reply => reply.url().endsWith('/api/project/open')); opening.catch(() => {});
  await clickProjectControl(page, 'Load'); assert.equal((await opening).status(), 200);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); pageNumber = 1;
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); return { saved, reopened: await snapshot() };
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  await navigate(3); await scale(100);
  // Retained metadata and appearance enter through the real validated creation
  // request; all selection, clipboard, drawing and save actions use rendered UI.
  await page.route('**/commands', route => {
    const value = route.request().postDataJSON();
    if (value.op === 'create_item') {
      Object.assign(value.item.fields, { zone: 'Retained zone', notes: '=Retained notes', group: 'QA-copy' });
      value.item.appearance = { stroke_color: '#A020F0', stroke_width: 3.75, opacity: .8 };
      return route.continue({ postData: JSON.stringify(value) });
    }
    return route.continue();
  });
  const steel = await create('steel', [[250, 200], [450, 200]], { 'Member mark': 'COPY-STEEL', 'Level': 'L03', 'Member type': 'Beam', 'Steel section': '100UC15', 'Product': 'CAFCO 300', 'Fire period (min)': 120, 'Crit. Temp (°C)': 550, 'Exposure': 'Re-entrant - 3 sides', 'Count/QTY': 2 });
  const sourceScale = (await snapshot()).calibrations.find(value => value.id === steel.measurement.calibration_id);
  const sourcePoints = steel.geometry.points, length = Math.hypot(sourcePoints[1][0] - sourcePoints[0][0], sourcePoints[1][1] - sourcePoints[0][1]) * sourceScale.distance_m / Math.hypot(sourceScale.points[1][0] - sourceScale.points[0][0], sourceScale.points[1][1] - sourceScale.points[0][1]);
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await copy(steel.id); let reply = await paste([250, 350]), first = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]);
  assertCopy(steel, first, reply, [250, 350], length); await assertRow(first, reply);
  reply = await paste([450, 350]); const second = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]);
  assertCopy(steel, second, reply, [450, 350], length); assert.notEqual(second.id, first.id); assert.ok(second.member_ids.every(id => !first.member_ids.includes(id)));
  await assertRow(second, reply);
  const beforeBlank = await snapshot(), beforeCommands = requests.length;
  await page.mouse.click(...await screen([650, 480]));
  await expect(page.getByRole('checkbox', { name: /^Select COPY-STEEL/ }).first()).not.toBeChecked();
  await expect(page.locator('.takeoff-register tbody input[type="checkbox"]:checked')).toHaveCount(0);
  assert.deepEqual((await snapshot()).items, beforeBlank.items); assert.equal(requests.length, beforeCommands);
  evidence.blankLengthClick = { recordsUnchanged: true, noCommand: true };
  await copy(steel.id);
  const filter = page.getByLabel('Filter register', { exact: true }), countBeforeText = (await snapshot()).items.length;
  await filter.fill('native-clipboard'); await filter.press('Control+a'); await filter.press('Control+c'); await filter.fill(''); await filter.press('Control+v');
  await expect(filter).toHaveValue('native-clipboard'); assert.equal((await snapshot()).items.length, countBeforeText); await filter.fill('');
  evidence.nativeTextClipboard = true;
  await select(steel.id); if (!await page.locator('.takeoff-markup-settings').isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.takeoff-markup-settings');
  await command(async () => { await settings.getByLabel('Level', { exact: true }).fill('L-CHANGED'); await settings.getByLabel('Level', { exact: true }).press('Tab'); }, 'bulk_update');
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  const beforeStale = await snapshot(); await paste([550, 470], 400);
  await expect(page.locator('#takeoffs-workspace .message')).toContainText('changed or was deleted'); assert.deepEqual((await snapshot()).items, beforeStale.items);
  evidence.staleClipboardRejected = true;
  await copy(steel.id); await navigate(1); await scale(50);
  reply = await paste([220, 320]); const crossPage = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]), currentSteel = reply.snapshot.items.find(item => item.id === steel.id);
  assertCopy(currentSteel, crossPage, reply, [220, 320], length / 4); assert.equal(crossPage.geometry.page, 1); await assertRow(crossPage, reply);
  evidence.crossPageScale = { from: length, to: length / 4, sourceUserUnit: 2, destinationUserUnit: 1 };
  const duct = await create('duct', [[200, 250], [380, 250]], { 'Item': 'COPY-DUCT', 'Level': 'L01', 'WxH (mm)': '600x400', 'Product': 'FyreWrap', 'Exposure': 'Internal', 'FRL': '120/120/120', 'Orientation': 'Horizontal', 'Wall penetrations': 2, 'Floor penetrations': 1, 'Count/QTY': 3 });
  await page.unroute('**/commands');
  await copy(duct.id); reply = await paste([420, 330]); const copiedDuct = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]);
  const ductLength = reply.item_results.find(item => item.id === duct.id).length_m;
  assertCopy(duct, copiedDuct, reply, [420, 330], ductLength); await assertRow(copiedDuct, reply);
  console.log('Steel/Duct paste, repeated identities, cross-page scale, native text clipboard and stale-source rejection passed.');
  await chooseTakeoff(page, 'steel');
  await page.getByRole('button', { name: 'Count steel lengths', exact: true }).click(); await page.mouse.click(...await screen([550, 220]));
  await dialog('Counted member length', { 'Length per member (m)': 4.25 }, 'Place marker');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForFunction(() => { const value = JSON.parse(window.CeasefireTakeoffs.projectFingerprint()); return !value.modal && value.countEntries.length === 1 && value.countEntries[0].length_m === 4.25; });
  reply = await command(() => page.locator('.takeoff-viewport').press('Enter'), 'add_count_items');
  const countId = reply.created_item_ids[0], count = reply.snapshot.items.find(item => item.id === countId);
  const countSettings = page.locator('.takeoff-markup-settings'); if (await countSettings.isVisible()) await countSettings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.locator(`.takeoff-count-hit[data-count-member-id="${count.member_ids[0]}"]`).click();
  await expect(row(countId).getByRole('checkbox', { name: /^Select / })).toBeChecked();
  const beforeCountBlank = await snapshot(), beforeCountCommands = requests.length;
  await page.mouse.click(...await screen([650, 400]));
  await expect(row(countId).getByRole('checkbox', { name: /^Select / })).not.toBeChecked();
  await expect(page.locator('.takeoff-count-hit[aria-pressed="true"]')).toHaveCount(0);
  assert.deepEqual((await snapshot()).items, beforeCountBlank.items); assert.equal(requests.length, beforeCountCommands);
  evidence.blankCountClick = { recordsUnchanged: true, markersUnselected: true };
  const beforeSave = await snapshot(), roundtrip = await saveLoad(info);
  assert.deepEqual(roundtrip.saved.takeoffs.items, beforeSave.items); assert.deepEqual(roundtrip.reopened.items, beforeSave.items);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  evidence.copies = [first.id, second.id, crossPage.id, copiedDuct.id]; evidence.saveReopenExact = true;
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.locator('.takeoff-register').screenshot({ path: path.join(output, 'register.png') });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, requests }, null, 2));
  console.log(`PASS: Steel/Duct keyboard copy at pointer, fields/quantity/style, fresh identities, destination scale, stale rejection, native text shortcuts, blank line/count deselection and Save/Load. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000)); process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ requests, fingerprint: await page.evaluate(() => window.CeasefireTakeoffs?.projectFingerprint()).catch(() => null), activeElement: await page.evaluate(() => document.activeElement?.outerHTML).catch(() => null) }, null, 2)); }
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
