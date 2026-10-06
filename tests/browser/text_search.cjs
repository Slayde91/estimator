"use strict";
const { chromium, expect } = require('@playwright/test');
const { settingsSettled } = require('./settings_helpers.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `text-search-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'search_fixture.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page; server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], evidence = {};
const input = () => page.getByLabel('Search original document text', { exact: true });
const results = () => page.locator('.takeoff-search-result');
const active = () => results().filter({ has: page.locator(':scope[aria-current=true]') });
async function query(value) { await input().fill(value); await expect(page.locator('.takeoff-progress')).toContainText('Text search complete:', { timeout: 60000 }); }
async function goPage(value) { await page.getByLabel('Page number', { exact: true }).fill(String(value)); await page.getByLabel('Page number', { exact: true }).press('Tab'); await expect(page.locator('.takeoff-page>canvas')).toBeVisible(); await expect.poll(() => page.locator('.takeoff-page-input').inputValue()).toBe(String(value)); await settingsSettled(page); }
async function selectedId() { return page.locator('.takeoff-search-result[aria-current=true]').getAttribute('data-search-hit-id'); }
async function pageInputDuringZoomRefinement(value) {
  // Hold delivery of the existing zoom timer, then release the real refinement
  // while a native page-number draft is focused. PDF.js pixels stay unmodified.
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.searchZoomPageInputQa = { original, armed: true, callback: null, requested: 0 };
    window.setTimeout = function (callback, delay, ...args) {
      const qa = window.searchZoomPageInputQa;
      if (qa.armed && Number(delay) === 120 && typeof callback === 'function') {
        qa.requested++; qa.armed = false;
        return original.call(window, () => { qa.callback = () => callback(...args); }, delay);
      }
      return original.call(window, callback, delay, ...args);
    };
  });
  try {
    await page.getByRole('button', { name: '+', exact: true }).click();
    await page.waitForFunction(() => typeof window.searchZoomPageInputQa.callback === 'function');
    await page.getByLabel('Page number', { exact: true }).fill(String(value));
    const before = await page.evaluate(() => ({ value: document.querySelector('.takeoff-page-input').value, focused: document.activeElement === document.querySelector('.takeoff-page-input') }));
    assert.equal(before.value, String(value)); assert.equal(before.focused, true);
    await renderDrawing(page, () => page.evaluate(() => window.searchZoomPageInputQa.callback()));
    const after = await page.evaluate(() => ({ value: document.querySelector('.takeoff-page-input').value, focused: document.activeElement === document.querySelector('.takeoff-page-input'), requested: window.searchZoomPageInputQa.requested }));
    evidence.pageInputDuringZoomRefinement = { before, after };
    assert.equal(after.requested, 1, 'The real pending zoom refinement completed after the native edit');
    assert.equal(after.value, String(value), 'Same-page bitmap refinement preserves the native page-number draft');
    assert.equal(after.focused, true, 'Bitmap refinement leaves page-number editing focused');
    await renderDrawing(page, () => page.getByLabel('Page number', { exact: true }).press('Tab'), value);
    await settingsSettled(page);
    evidence.pageInputDuringZoomRefinement.nativeTabNavigates = true;
  } finally {
    await page.evaluate(() => { window.setTimeout = window.searchZoomPageInputQa.original; });
  }
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.searchCsp = []; document.addEventListener('securitypolicyviolation', event => window.searchCsp.push(event.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.getByLabel('Include drawing labels', { exact: true }).uncheck();
  await page.locator('#takeoff-upload').setInputFiles([info.fixture, info.other]);
  await expect(page.locator('.takeoff-document')).toHaveCount(2); await expect(page.locator('.takeoff-page>canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  const initial = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  await input().fill('fire rated wall'); await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.takeoff-progress')).toContainText('Text search complete:', { timeout: 60000 }); await expect(results()).toHaveCount(4);
  await expect(page.locator('.takeoff-search-results')).toBeHidden(); await expect(input()).toHaveValue('fire rated wall');
  await input().click(); await expect(page.locator('.takeoff-search-results')).toBeVisible();
  assert.equal(await results().first().locator('mark').allTextContents().then(parts => parts.join('')), 'fire rated wall', 'Dropdown emphasizes actual matched source words across text runs');
  evidence.outsideDismissalSurvivesBackgroundResults = true;
  const boxes = await page.evaluate(() => { const input = document.querySelector('.takeoff-search-anchor>input').getBoundingClientRect(), list = document.querySelector('.takeoff-search-results').getBoundingClientRect(); return { input: { x: input.x, y: input.y, bottom: input.bottom }, list: { x: list.x, y: list.y } }; });
  assert.ok(Math.abs(boxes.input.x - boxes.list.x) <= 2 && boxes.list.y >= boxes.input.bottom && boxes.list.y - boxes.input.bottom <= 8, 'Typing dropdown anchors immediately below input');
  assert.ok(await page.locator('.takeoff-search-match').count() >= 6, 'Three phrases each span multiple real text runs');
  const measured = await page.locator('.takeoff-search-match').evaluateAll(elements => elements.map(el => ({ id: el.dataset.searchHitId, geometry: el.dataset.searchGeometry })));
  assert.equal(new Set(measured.map(hit => hit.id)).size, 3); assert.ok(measured.every(hit => hit.geometry === 'rendered-text-bounds'));
  const paint = await page.evaluate(() => ({ contextOpacity: Number(getComputedStyle(document.querySelector('.takeoff-search-contexts')).opacity), matchFill: getComputedStyle(document.querySelector('.takeoff-search-match')).fill }));
  assert.equal(paint.contextOpacity, .2); assert.match(paint.matchFill, /^rgba\(.+, 0\.25/);
  evidence.readableHighlightPaint = paint;
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.takeoff-search-result[aria-current=true]')).toContainText('Centre');
  const first = await selectedId(); await page.getByRole('button', { name: 'Search', exact: true }).click(); const second = await selectedId();
  await expect(page.locator('.takeoff-search-result[aria-current=true]')).toContainText('Lower');
  await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(page.locator('.takeoff-search-result[aria-current=true]')).toContainText('Upper');
  await page.getByRole('button', { name: 'Search', exact: true }).click(); assert.equal(await selectedId(), first); assert.notEqual(first, second);
  evidence.nearestAndWrap = true;
  await page.screenshot({ path: path.join(output, 'sentence-search-readable.png') });
  await input().focus(); await input().press('ArrowDown'); assert.equal(await results().first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowDown'); assert.equal(await results().nth(1).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await expect(page.locator('.takeoff-search-results')).toBeHidden(); await expect(input()).toBeFocused();
  await input().fill(''); await expect(results()).toHaveCount(0); await expect(page.locator('.takeoff-search-context,.takeoff-search-match')).toHaveCount(0);
  await query('fire rated wall'); await goPage(2); await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.takeoff-progress')).toContainText('No searchable matches on the current page'); await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
  await results().filter({ hasText: 'p3:' }).click(); await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3'); await expect(page.locator('.takeoff-search-match')).toHaveCount(1);
  await settingsSettled(page); const beforeZoom = await page.locator('.takeoff-page>canvas').boundingBox(); await page.getByRole('button', { name: '+', exact: true }).click();
  await expect.poll(async () => (await page.locator('.takeoff-page>canvas').boundingBox())?.width / beforeZoom.width || 0).toBeGreaterThan(1.24);
  await expect(page.locator('.takeoff-search-match')).toHaveCount(1);
  const alignment = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.takeoff-text-layer span')].find(el => el.textContent.includes('fire rated wall')), range = document.createRange(), start = span.firstChild.textContent.indexOf('fire rated wall');
    range.setStart(span.firstChild, start); range.setEnd(span.firstChild, start + 'fire rated wall'.length);
    const text = range.getBoundingClientRect(), match = document.querySelector('.takeoff-search-match').getBoundingClientRect();
    return Math.max(Math.abs(text.x - match.x), Math.abs(text.y - match.y), Math.abs(text.width - match.width), Math.abs(text.height - match.height));
  });
  assert.ok(alignment < 2, `Rotated/cropped/UserUnit zoom word geometry aligns with native text within two screen pixels (${alignment})`);
  evidence.rotatedCropUserUnitZoom = true;
  await page.screenshot({ path: path.join(output, 'sentence-search-rotated.png') });
  await pageInputDuringZoomRefinement(1);
  await goPage(1); await query('wall'); await expect(results()).toHaveCount(500); await expect(page.locator('.takeoff-progress')).toContainText('Stopped at 500 matches; coverage is incomplete');
  await goPage(4); await expect.poll(() => page.locator('.takeoff-search-match').count()).toBeGreaterThan(490);
  const dense = await page.locator('.takeoff-search-contexts').evaluate(group => ({ opacity: Number(getComputedStyle(group).opacity), polygons: group.children.length, unique: new Set([...group.children].map(el => el.getAttribute('points'))).size }));
  assert.equal(dense.opacity, .2, 'Repeated/overlapping sentence polygons composite once instead of accumulating yellow opacity'); assert.equal(dense.polygons, dense.unique);
  evidence.denseHighlightsCompositeOnce = dense; await page.screenshot({ path: path.join(output, 'dense-search-readable.png') });
  await goPage(1);
  await page.getByRole('button', { name: 'Stop search', exact: true }).click(); await expect(input()).toHaveValue(''); await expect(results()).toHaveCount(0); await expect(page.locator('.takeoff-search-context,.takeoff-search-match')).toHaveCount(0);
  const secondDocument = initial.documents[1].id; let held;
  await page.route(`**/documents/${secondDocument}/file`, route => { held = route; });
  await page.getByLabel('Text search scope', { exact: true }).selectOption('all'); await input().fill('fire rated wall');
  await expect.poll(() => !!held, { timeout: 30000 }).toBe(true);
  await page.getByRole('button', { name: 'Stop search', exact: true }).click(); await expect(input()).toHaveValue(''); await expect(results()).toHaveCount(0);
  await held.continue(); await page.unroute(`**/documents/${secondDocument}/file`);
  await query('Elsewhere'); await expect(results()).toHaveCount(1); await expect(results()).toContainText('other-document.pdf');
  await page.getByRole('button', { name: 'Stop search', exact: true }).click();
  evidence.stopDuringSourceLoad = true;
  const final = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  for (const key of ['items', 'calibrations', 'documents', 'transfers', 'physical', 'service_plans']) assert.deepEqual(final[key], initial[key], `Search preserves ${key}`);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.searchCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors }, null, 2));
  console.log(`PASS typing dropdown, cross-run words/sentences, nearest/wrap, keyboard, clear/Stop, scan, rotated crop/UserUnit/zoom, 500 bound and interrupted source load. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill(); });
