const { chooseTakeoff } = require('./section_navigation.cjs');
// Native PDF text selection and clipboard; original sources and storage are synthetic.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { settingsSettled } = require('./settings_helpers.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `pdf-text-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], evidence = { scopes: [] };
const layer = () => page.locator('.takeoff-text-layer');
async function rendered(action) {
  await page.evaluate(() => { window.oldTextCanvas = document.querySelector('.takeoff-page canvas'); }); await action();
  await expect.poll(() => page.evaluate(() => window.oldTextCanvas !== document.querySelector('.takeoff-page canvas')), { timeout: 30000 }).toBe(true);
  await settingsSettled(page);
}
async function fit() { await rendered(() => page.getByRole('button', { name: 'Fit page', exact: true }).click()); }
async function focusDrawing() {
  await page.locator('.takeoff-viewport').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom - 12));
}
async function textTool() {
  await page.getByRole('button', { name: 'Select PDF text', exact: true }).click();
  await expect(layer()).toHaveAttribute('data-text-state', 'ready'); await focusDrawing();
}
async function dragText(phrase, vertical = false) {
  const span = layer().locator('span').filter({ hasText: phrase }).first();
  await expect(span).toBeAttached();
  const points = await span.evaluate((el, { vertical, phrase }) => {
    const text = el.firstChild, first = document.createRange(), last = document.createRange();
    const startIndex = text.textContent.indexOf(phrase), endIndex = startIndex + phrase.length;
    first.setStart(text, startIndex); first.setEnd(text, startIndex + 1); last.setStart(text, endIndex - 1); last.setEnd(text, endIndex);
    const start = first.getBoundingClientRect(), end = last.getBoundingClientRect();
    return vertical ? [[start.x + start.width / 2, start.y + .1], [end.x + end.width / 2, end.bottom - .1]]
      : [[start.x + .1, start.y + start.height / 2], [end.right - .1, end.y + end.height / 2]];
  }, { vertical, phrase });
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-text-layer'), points[0]), true, 'Pointer reaches native text');
  await page.mouse.move(...points[0]); await page.mouse.down(); await page.mouse.move(...points[1], { steps: 18 }); await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  assert.ok(selected.includes(phrase), `Native drag selected ${JSON.stringify(selected)}`);
  await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied.replace(/\r\n/g, '\n'), selected, 'Ctrl+C copies native selection exactly (platform line endings normalized)');
  return selected;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.textCsp = []; document.addEventListener('securitypolicyviolation', event => window.textCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await rendered(() => page.locator('#takeoff-upload').setInputFiles(info.fixture)); await fit();
  const initial = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  for (const [mode, scope] of [['STEEL'], ['DUCT'], ['WALLS'], ['SLABS'], ['PENETRATIONS', 'Defect Reports'], ['PENETRATIONS', 'Service Plans']]) {
    await chooseTakeoff(page, mode); await settingsSettled(page);
    if (scope) { await chooseTakeoff(page, scope); await settingsSettled(page); }
    await textTool(); const copied = await dragText('100UC15'); evidence.scopes.push({ scope: scope || mode, copied });
    await page.getByRole('button', { name: 'Pan', exact: true }).click();
    assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Changing tool clears only drawing text selection');
    assert.equal(await layer().evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  }
  await chooseTakeoff(page, 'STEEL'); await settingsSettled(page); await textTool();
  const selected = await dragText('100UC15');
  await page.evaluate(() => { window.selectedTextSpan = document.querySelector('.takeoff-text-layer span'); window.selectedTextLayer = document.querySelector('.takeoff-text-layer'); });
  const before = await layer().boundingBox(); await rendered(() => page.getByRole('button', { name: '+', exact: true }).click());
  assert.equal(await page.evaluate(() => window.selectedTextLayer === document.querySelector('.takeoff-text-layer') && window.selectedTextSpan === document.querySelector('.takeoff-text-layer span')), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected, 'Bitmap refinement preserves the native DOM selection');
  const after = await layer().boundingBox(); assert.ok(Math.abs(after.width / before.width - 1.25) < .002);
  await dragText('100UC15'); evidence.zoomRetainsSelection = true;
  await rendered(async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); });
  await fit(); await textTool(); evidence.rotatedCropUserUnit = await dragText('Rotated crop with UserUnit 2', true);
  await page.screenshot({ path: path.join(output, 'native-text-rotated.png') });
  await rendered(async () => { await page.getByLabel('Page number', { exact: true }).fill('2'); await page.getByLabel('Page number', { exact: true }).press('Tab'); });
  await expect(layer()).toHaveAttribute('data-text-state', 'empty'); await expect(page.locator('.takeoff-progress')).toContainText('no selectable PDF text');
  await expect(layer().locator('span')).toHaveCount(0); assert.equal(await page.evaluate(() => getSelection().toString()), ''); evidence.scanHasNoInventedText = true;
  const final = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  for (const key of ['items', 'calibrations', 'documents', 'physical', 'service_plans', 'transfers']) assert.deepEqual(final[key], initial[key], `Text selection leaves ${key} unchanged`);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.textCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors }, null, 2));
  console.log(`PASS native PDF text selection/copy across six scopes, zoom, rotated crop/UserUnit and image-only source. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); await browser?.close(); server.kill(); });
