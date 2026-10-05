"use strict";
// Rendered viewer-only shortcuts and new-upload selection against disposable
// synthetic originals. Never opens the live database, project files or port.
const {chromium, expect} = require('@playwright/test');
const {renderDrawing} = require('./viewer_helpers.cjs');
const {settingsSettled} = require('./settings_helpers.cjs');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `viewer-shortcuts-${Date.now()}`);
fs.mkdirSync(output, {recursive: true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'search_fixture.py'), '--directory', output], {cwd: root, windowsHide: true});
let logs = '', browser, page; const errors = [], evidence = {};
server.stderr.on('data', value => {logs += value;});
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => {stdout += value; if (stdout.includes('\n')) {clearTimeout(timer); try {resolve(JSON.parse(stdout.split('\n')[0]));} catch (error) {reject(error);}}});
  server.once('error', reject); server.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`));});
});
async function snapshot() {await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());}
async function textMatrix() {
  await expect(page.locator('.takeoff-text-layer[data-text-state=ready]')).toBeVisible();
  return page.locator('.takeoff-text-layer').evaluate(el => {const m = new DOMMatrix(getComputedStyle(el).transform); return {a: m.a, b: m.b, c: m.c, d: m.d};});
}
const drawing = () => page.locator('.takeoff-viewport');
const pageNumber = () => page.getByLabel('Page number', {exact: true});
async function key(value) {await drawing().focus(); await page.keyboard.press(value);}
async function renderViewer(action, number) {
  // The text tool replaces the generic "Original source" progress line with
  // native-copy instructions. Verify the actual bitmap/overlay and save guard.
  const previous = await page.locator('.takeoff-viewport canvas').elementHandle();
  try {
    await action();
    await page.waitForFunction(old => {
      const canvas = document.querySelector('.takeoff-viewport canvas'), overlay = document.querySelector('.takeoff-overlay');
      return canvas && overlay && canvas !== old && !old.isConnected && canvas.width > 0 && canvas.height > 0 && Math.abs(parseFloat(canvas.style.width) - Number(overlay.getAttribute('width'))) < .01 && Math.abs(parseFloat(canvas.style.height) - Number(overlay.getAttribute('height'))) < .01;
    }, previous);
    await settingsSettled(page); if (number !== undefined) await expect(pageNumber()).toHaveValue(String(number));
  } finally {await previous?.dispose();}
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); evidence.port = info.port;
  browser = await chromium.launch({headless: true}); page = await browser.newPage({viewport: {width: 1500, height: 1000}}); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective));});
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', {name: 'Takeoffs', exact: true}).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.other), 1); await expect(page.locator('.takeoff-document')).toHaveCount(1); await snapshot();
  const old = await snapshot(), oldId = old.documents[0].id;
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  await expect(page.locator('.takeoff-document')).toHaveCount(2);
  const initial = await snapshot(), newId = initial.documents.find(doc => doc.id !== oldId).id;
  await expect(page.getByLabel('Drawing document', {exact: true})).toHaveValue(newId);
  assert.deepEqual(initial.documents.find(doc => doc.id === oldId), old.documents[0]); evidence.newUploadSelected = true;
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', {name: 'Select PDF text', exact: true}).click(); const base = await textMatrix();
  await renderViewer(() => key('Control+ArrowUp')); const left = await textMatrix();
  assert.ok(Math.abs(left.a) < .001 && Math.abs(left.d) < .001 && left.b < 0 && left.c > 0, 'Ctrl+Up rotates left');
  await renderViewer(() => key('Control+ArrowDown')); const restored = await textMatrix(); assert.deepEqual(restored, base);
  await renderViewer(() => key('Control+ArrowDown')); const right = await textMatrix();
  assert.ok(Math.abs(right.a) < .001 && Math.abs(right.d) < .001 && right.b > 0 && right.c < 0, 'Ctrl+Down rotates right');
  evidence.rotation = {base, left, right};
  await renderViewer(() => key('Control+ArrowRight'), 2); await renderViewer(() => key('Control+ArrowLeft'), 1); await textMatrix();
  await key('Control+ArrowLeft'); await expect(pageNumber()).toHaveValue('1'); evidence.boundedPages = true;
  for (const [shortcut, ratio] of [['Control+Equal', 1.25], ['Control+Shift+Equal', 1.25], ['Control+Minus', 1 / 1.25]]) {
    const width = await page.locator('.takeoff-page>canvas').evaluate(el => parseFloat(el.style.width));
    await renderViewer(() => key(shortcut));
    const after = await page.locator('.takeoff-page>canvas').evaluate(el => parseFloat(el.style.width));
    assert.ok(Math.abs(after / width - ratio) < .001, `${shortcut} changes viewer zoom only`);
  }
  evidence.zoom = true;
  const search = page.getByLabel('Search original document text', {exact: true}), current = await textMatrix();
  await search.fill('editable caret'); await search.press('Control+ArrowDown'); await search.press('Control+ArrowRight'); await expect(pageNumber()).toHaveValue('1'); assert.deepEqual(await textMatrix(), current);
  await page.getByRole('button', {name: 'Stop search', exact: true}).click();
  await page.getByLabel('Filter register', {exact: true}).focus(); await page.keyboard.press('Control+ArrowRight'); await expect(pageNumber()).toHaveValue('1');
  await page.evaluate(() => {const field = document.createElement('div'); field.id = 'qa-native-rich-field'; field.contentEditable = 'true'; document.querySelector('.takeoff-viewport').append(field); field.focus();});
  await page.keyboard.press('Control+ArrowDown'); assert.deepEqual(await textMatrix(), current); await page.locator('#qa-native-rich-field').evaluate(el => el.remove());
  evidence.editableAndOutsideGuards = true;
  await page.getByRole('button', {name: 'Scale', exact: true}).click(); await page.getByLabel('Drawing calibration', {exact: true}).selectOption('scale:100'); await expect(page.getByRole('dialog')).toBeVisible();
  await drawing().dispatchEvent('keydown', {key: 'ArrowDown', ctrlKey: true, bubbles: true}); assert.deepEqual(await textMatrix(), current);
  await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click(); await snapshot(); evidence.modalGuard = true;
  let held; await page.route('**/api/takeoffs/sessions/*/commands', async route => {if (route.request().postDataJSON()?.op === 'record_render') held = route; else await route.continue();});
  const rotating = renderViewer(() => key('Control+ArrowDown')); rotating.catch(() => {});
  await expect.poll(() => !!held).toBe(true); await expect(page.locator('#takeoffs-workspace')).toHaveAttribute('aria-busy', 'true');
  await drawing().dispatchEvent('keydown', {key: 'ArrowRight', ctrlKey: true, bubbles: true}); await expect(pageNumber()).toHaveValue('1');
  await held.continue(); await rotating; await page.unroute('**/api/takeoffs/sessions/*/commands'); evidence.busyGuard = true;
  const final = await snapshot();
  for (const field of ['documents', 'items', 'calibrations', 'transfers', 'physical', 'service_plans', 'viewports', 'annotations']) assert.deepEqual(final[field], initial[field], `Viewer shortcuts preserve ${field}`);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.screenshot({path: path.join(output, 'viewer-shortcuts.png')}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({completed: true, evidence, errors}, null, 2));
  console.log(`PASS new PDF auto selection; left/right rotate, bounded pages, Ctrl+plus/minus viewer zoom, native fields/outside/modal/busy guards and preserved source/calculator state. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));}
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({completed: false, evidence, error: String(error), errors}, null, 2)); process.exitCode = 1;
}).finally(async () => {fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill();});
