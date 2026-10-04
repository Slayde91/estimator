const { chooseTakeoff } = require('./section_navigation.cjs');
// Native Defect annotation/callout gestures on a disposable, cropped PDF.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `defect-callouts-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '', current, id;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const details = () => page.getByRole('complementary', { name: 'Item Details', exact: true });
const callout = () => page.locator(`.takeoff-physical-callout[data-physical-id="${id}"]`);
const marker = () => page.locator(`.takeoff-physical-marker-hit[data-physical-id="${id}"]`);
const frame = () => callout().locator('.takeoff-physical-callout-frame');
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true'); }
async function snapshot() { await idle(); await expect.poll(async () => { try { current = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return current; }
async function response(action, suffix) { const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {}); await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(value)); if (!suffix.endsWith('/preview')) await idle(); return value; }
async function dialog(title, fields, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(fields)) { const control = modal.getByLabel(label, { exact: true }); if (await control.evaluate(el => el.tagName) === 'SELECT') await control.selectOption(String(value)); else await control.fill(String(value)); }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function fit() { await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 3); }
async function sourcePoint([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => { const header = document.querySelector('header').getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - header.bottom - 12); });
  const box = await overlay.boundingBox(), point = [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-overlay'), point), true); return point;
}
async function drag(target, dx, dy) {
  await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); assert.ok(box);
  const start = [box.x + box.width / 2, box.y + box.height / 2];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-physical-callout,.takeoff-physical-marker-hit,.takeoff-physical-callout-handle'), start), true, 'Native gesture reaches its callout or annotation');
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0] + dx, start[1] + dy, { steps: 6 }); await page.mouse.up(); await snapshot();
}
async function textFits() {
  const value = await callout().evaluate(el => { const rect = el.querySelector('rect'), box = el.querySelector('text').getBBox(); const x = +rect.getAttribute('x'), y = +rect.getAttribute('y'), width = +rect.getAttribute('width'), height = +rect.getAttribute('height'); return { fits: box.x >= x && box.y >= y && box.x + box.width <= x + width && box.y + box.height <= y + height, lines: el.querySelectorAll('tspan').length, width, height }; });
  assert.equal(value.fits, true, 'Actual SVG text fits the framed callout'); assert.ok(value.lines >= 2); return value;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); const sourceHash = hash(info.fixture);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/\/physical\/(preview|apply)$/.test(request.url())) requests.push({ endpoint: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => { const value = window.CeasefireDesktop?.status(); return value?.ready && !value.busy; });
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await chooseTakeoff(page, 'PENETRATIONS'); await idle(); await fit();
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await page.mouse.click(...await sourcePoint([350.123456789, 280.987654321]));
  const preview = await response(() => dialog('Add Defect', { 'Defect Ref.': 'FRAMED-DEFECT', Location: 'Level 3', FRL: '-/60/60' }, 'Preview new draft'), '/physical/preview');
  await response(() => dialog('Create one draft defect?', {}, 'Apply draft change'), '/physical/apply'); id = preview.changed_ids[0];
  await snapshot(); const original = structuredClone(current.physical.defects[0]), source = original.evidence[0];
  assert.equal(original.annotation.document_sha256, sourceHash); assert.equal(original.annotation.page, 3); assert.equal(original.marker, undefined); assert.equal(original.quantity, undefined);
  assert.deepEqual(original.annotation.point, JSON.parse(source.note.match(/PDF point (\[[^\]]+\])/)[1])); assert.equal(current.physical.barriers.length, 0); assert.equal(current.physical.services.length, 0);
  await expect(callout()).toContainText('D-0001'); await expect(callout()).toContainText('FRAMED-DEFECT'); await expect(callout()).toContainText('0 substrates · 0 services');
  await expect(page.locator('.takeoff-overlay .takeoff-label')).toHaveCount(0); evidence.initialFrame = await textFits();
  await page.getByRole('button', { name: 'Close Item Details', exact: true }).click(); await expect(details()).not.toBeVisible(); await fit();
  await callout().press('Enter'); await expect(details()).not.toBeVisible(); await expect(page.locator('.takeoff-physical-callout-handle')).toHaveCount(4);
  await marker().press('Enter'); await expect(details()).toBeVisible(); await callout().press(' '); await expect(details()).toBeVisible(); await marker().press('Control+Enter'); await expect(details()).not.toBeVisible(); await fit();
  evidence.calloutSelectsMarkerKeyboardOpensModifierDeselects = true;
  await callout().press('Enter'); const firstPoint = structuredClone((await snapshot()).physical.defects[0].annotation.point);
  await drag(callout(), 24, 18); await expect(details()).not.toBeVisible(); assert.deepEqual(current.physical.defects[0].annotation.point, firstPoint); assert.ok(current.physical.defects[0].annotation.callout);
  const moved = structuredClone(current.physical.defects[0].annotation.callout); evidence.resizes = [];
  for (const corner of ['nw', 'ne', 'sw', 'se']) { await drag(page.locator(`.takeoff-physical-callout-handle[data-corner="${corner}"]`), corner.includes('w') ? -8 : 8, corner.includes('n') ? -6 : 6); assert.deepEqual(current.physical.defects[0].annotation.point, firstPoint); evidence.resizes.push({ corner, layout: structuredClone(current.physical.defects[0].annotation.callout), text: await textFits() }); }
  assert.notDeepEqual(current.physical.defects[0].annotation.callout, moved); await drag(marker(), 18, 14); await expect(details()).not.toBeVisible(); assert.notDeepEqual(current.physical.defects[0].annotation.point, firstPoint);
  await page.waitForTimeout(550); await marker().dblclick({ delay: 100 }); await expect(details()).toBeVisible();
  assert.deepEqual(current.physical.defects[0].evidence, original.evidence); assert.deepEqual(current.physical.defects[0].fields, original.fields); assert.equal(current.physical.barriers.length, 0); assert.equal(current.physical.services.length, 0); evidence.markerMovePreservesEvidence = true;
  await details().getByLabel('Defect Ref.', { exact: true }).fill('UPDATED-FRAMED-DEFECT'); await details().getByLabel('Defect Ref.', { exact: true }).press('Tab'); await expect(callout()).toContainText('UPDATED-FRAMED-DEFECT'); await snapshot(); await textFits();
  await page.getByRole('button', { name: 'Close Item Details', exact: true }).click(); await fit(); const savedGraph = structuredClone((await snapshot()).physical);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click(); const pdf = await download; await pdf.saveAs(path.join(output, 'defect-callout.pdf')); assert.ok(fs.statSync(path.join(output, 'defect-callout.pdf')).size > 1000); assert.deepEqual((await snapshot()).physical, savedGraph);
  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as'); const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.physical, savedGraph);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'PENETRATIONS'); assert.deepEqual((await snapshot()).physical, savedGraph); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3); await fit(); await expect(callout()).toContainText('UPDATED-FRAMED-DEFECT'); await textFits(); evidence.saveReopenAndPdf = true;
  for (const width of [1146, 764]) { await page.setViewportSize({ width, height: 900 }); await fit(); await callout().scrollIntoViewIfNeeded(); await textFits(); await page.screenshot({ path: path.join(output, `defect-callout-${width}.png`) }); }
  await page.setViewportSize({ width: 1146, height: 900 }); await fit(); await page.waitForTimeout(550); await marker().dblclick({ delay: 100 }); await expect(details()).toBeVisible();
  const annotationBeforeLinks = structuredClone((await snapshot()).physical.defects[0].annotation);
  await page.locator(`tr[data-physical-id="${id}"]`).getByRole('button', { name: 'Add barrier to D-0001', exact: true }).click();
  const barrier = await response(() => dialog('Create draft barrier', { Substrate: 'Concrete/masonry wall' }, 'Preview new draft'), '/physical/preview');
  await response(() => dialog('Create one draft barrier?', {}, 'Apply draft change'), '/physical/apply');
  await details().getByRole('button', { name: 'Add service in Item Details', exact: true }).click();
  const service = await response(() => dialog('Create draft service', { Category: 'Mechanical', 'Service type': 'Copper Pipes', 'Explicit service quantity': 2 }, 'Preview new draft'), '/physical/preview');
  await response(() => dialog('Create one draft service?', {}, 'Apply draft change'), '/physical/apply');
  await snapshot(); for (const value of ['B-0001 · Concrete/masonry wall', 'S-0001 · 2 × · Mechanical · Copper Pipes']) await expect(callout()).toContainText(value);
  assert.equal(current.physical.barriers.find(value => value.id === barrier.changed_ids[0]).defect_id, id);
  assert.equal(current.physical.services.find(value => value.id === service.changed_ids[0]).barrier_id, barrier.changed_ids[0]);
  assert.equal(current.physical.services[0].quantity, 2); assert.deepEqual(current.physical.defects[0].annotation, annotationBeforeLinks);
  await textFits(); await page.screenshot({ path: path.join(output, 'defect-linked-values.png') }); evidence.linkedValuesDisplayed = true;
  await page.waitForTimeout(550); await callout().dblclick({ delay: 100 }); await expect(details()).toBeVisible();
  await expect(details()).toContainText('Callout Settings'); await expect(details()).not.toContainText('Automatic callout'); await expect(details()).not.toContainText('SOURCE ASSOCIATIONS');
  await response(async () => { await details().getByLabel('Font Colour', { exact: true }).fill('#008000'); await details().getByLabel('Font Colour', { exact: true }).press('Tab'); }, '/physical/apply');
  await response(async () => { await details().getByLabel('Fill colour', { exact: true }).fill('#fff1dd'); await details().getByLabel('Fill colour', { exact: true }).press('Tab'); }, '/physical/apply');
  await snapshot(); const calloutAppearance = structuredClone(current.physical.defects[0].annotation.callout.appearance);
  assert.equal(calloutAppearance.font_color, '#008000'); assert.equal(calloutAppearance.fill_color, '#fff1dd'); assert.equal(current.physical.defects[0].annotation.appearance, undefined);
  await page.getByRole('button', { name: 'Close Item Details', exact: true }).click(); await fit(); await page.waitForTimeout(550); await marker().dblclick({ delay: 100 });
  await expect(details()).toContainText('Marker Settings'); await expect(details().getByLabel('Font Colour', { exact: true })).toHaveCount(0);
  await response(async () => { await details().getByLabel('Line Colour', { exact: true }).fill('#a020f0'); await details().getByLabel('Line Colour', { exact: true }).press('Tab'); }, '/physical/apply');
  await snapshot(); assert.equal(current.physical.defects[0].annotation.appearance.stroke_color, '#a020f0'); assert.deepEqual(current.physical.defects[0].annotation.callout.appearance, calloutAppearance);
  await page.getByRole('button', { name: 'Close Item Details', exact: true }).click(); await fit(); await callout().click(); await page.locator('.takeoff-viewport').press('Control+c');
  await page.mouse.move(...await sourcePoint([430, 320]));
  await response(() => page.locator('.takeoff-viewport').press('Control+v'), '/physical/preview');
  const pasted = await response(() => dialog('Copy callout and linked physical records?', {}, 'Apply draft change'), '/physical/apply');
  await snapshot(); const copiedDefect = current.physical.defects.find(value => value.id !== id), copiedBarrier = current.physical.barriers.find(value => value.defect_id === copiedDefect.id), copiedService = current.physical.services.find(value => value.barrier_id === copiedBarrier.id);
  assert.equal(copiedDefect.display_id, 'D-0002'); assert.equal(copiedBarrier.display_id, 'B-0002'); assert.equal(copiedService.display_id, 'S-0002'); assert.equal(copiedService.quantity, 2); assert.equal(copiedDefect.copied_from.entity_id, id);
  assert.notEqual(copiedDefect.id, id); assert.notEqual(copiedBarrier.id, barrier.changed_ids[0]); assert.notEqual(copiedService.id, service.changed_ids[0]);
  const copiedCallout = page.locator(`.takeoff-physical-callout[data-physical-id="${copiedDefect.id}"]`); await expect(copiedCallout).toContainText('S-0002 · 2 × · Mechanical · Copper Pipes');
  await copiedCallout.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
  await response(() => page.getByRole('menuitem', { name: 'Delete', exact: true }).click(), '/physical/preview');
  await response(() => dialog('Delete this record and its linked barriers/services?', {}, 'Apply draft change'), '/physical/apply');
  await snapshot(); for (const entity of [copiedDefect, copiedBarrier, copiedService]) { const record = [...current.physical.defects, ...current.physical.barriers, ...current.physical.services].find(value => value.id === entity.id); assert.equal(record.deleted, true); assert.deepEqual(record.evidence, entity.evidence); }
  assert.equal(current.physical.defects.find(value => value.id === id).deleted, false); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  evidence.independentStylesCopyCascade = { created: pasted.changed_ids, retainedTombstones: 3 };
  assert.equal(hash(info.fixture), sourceHash); assert.deepEqual(errors, []); evidence.annotation = savedGraph.defects[0].annotation; evidence.sourceUnchanged = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, disposablePort: info.port, evidence, requests, errors }, null, 2)); console.log(`Defect callout acceptance passed: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-2500)); if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, requests, errors, error: String(error) }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill(); });
