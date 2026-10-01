// Toolbar acceptance against a disposable server and original synthetic PDF.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `viewer-controls-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], operations = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op) {
  const pending = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); await idle(); return body;
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function sourcePoint([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  const point = [Math.round(box.x + (y - 30) / 540 * box.width), Math.round(box.y + (x - 20) / 780 * box.height)];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport'), point), true, 'Gesture lands on the drawing, clear of fixed controls');
  return point;
}
async function assertErrorVisible() {
  const notice = page.locator('#takeoffs-workspace [role="alert"]'); await expect(notice).toBeVisible();
  const bounds = await notice.boundingBox(), header = await page.locator('.app-header').boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds.y >= header.y + header.height + 10, 'Error is below the sticky header');
  assert.ok(bounds.y + bounds.height <= viewport.height, 'Error is visible in the browser window');
  return bounds;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) operations.push(request.postDataJSON()?.op); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  const navigation = page.getByRole('group', { name: 'Page navigation', exact: true });
  assert.deepEqual(await navigation.getByRole('button').evaluateAll(nodes => nodes.map(el => el.getAttribute('aria-label'))), ['First page', '‹ Page', 'Page ›', 'Last page']);
  for (const name of ['First page', 'Last page']) {
    const button = navigation.getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('title', name); await expect(button.locator('svg')).toHaveCount(1);
  }
  await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('4');
  await command(() => page.getByRole('button', { name: 'First page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
  await command(() => page.getByRole('button', { name: '‹ Page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3');
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
  evidence.firstLastNavigation = true;

  const scale = page.getByRole('button', { name: 'Scale', exact: true }), popup = page.getByRole('group', { name: 'Drawing scale', exact: true }), calibrate = popup.getByRole('button', { name: 'Calibrate', exact: true });
  await expect(page.locator('.takeoff-tool-rail > [data-tool="calibrate"]')).toHaveCount(0);
  await scale.click(); await expect(calibrate).toBeVisible(); await expect(calibrate.locator('svg')).toHaveCount(0);
  assert.deepEqual(await popup.evaluate(el => [...el.children].map(child => child.tagName === 'SELECT' ? child.id : child.textContent)), ['takeoff-calibration', 'Calibrate', 'Edit calibration']);
  await calibrate.click(); await expect(popup).toBeHidden(); await expect(scale).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'calibrate');
  await page.mouse.click(...await sourcePoint([350, 300]), { button: 'right' });
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'select');
  assert.equal((await snapshot()).calibrations.length, 0);
  await scale.click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  await expect(popup).toBeHidden(); await expect(scale).toHaveAttribute('title', /1:100/); evidence.calibrationPopup = true;

  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await page.mouse.click(...await sourcePoint([300, 400])); await page.mouse.dblclick(...await sourcePoint([550, 400]));
  let reply = await command(() => dialog('Add steel object', { 'Member mark': 'TOOLBAR-STEEL', 'Physical quantity': 2 }, 'Add item'), 'create_item');
  const item = reply.snapshot.items[0], beforeDirty = await snapshot(), beforeDirtyCommands = [...operations], editor = page.locator(`.takeoff-register-editor[data-editor-item-id="${item.id}"]`);
  const discard = editor.getByRole('button', { name: 'Discard edits', exact: true });
  await expect(discard).toHaveAttribute('title', 'Discard edits'); await expect(discard.locator('svg')).toHaveCount(1);
  await editor.getByLabel('Level', { exact: true }).fill('UNAPPLIED-LEVEL');
  await page.getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Discard unfinished edits?', exact: true })).toBeVisible();
  const confirmDiscard = page.getByRole('dialog').getByRole('button', { name: 'Discard edits', exact: true });
  await expect(confirmDiscard.locator('svg')).toHaveCount(0); await expect(confirmDiscard).toHaveText('Discard edits');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3'); await expect(editor.getByLabel('Level', { exact: true })).toHaveValue('UNAPPLIED-LEVEL');
  assert.deepEqual(operations, beforeDirtyCommands, 'Cancelled page shortcut sends no edit or page-render command');
  await scale.click(); await calibrate.click();
  await expect(popup).toBeVisible(); await expect(scale).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('Apply or discard'); await assertErrorVisible();
  assert.deepEqual(operations, beforeDirtyCommands, 'Rejected calibration tool switch sends no item change');
  await scale.click(); await discard.click(); await expect(editor.getByLabel('Level', { exact: true })).toHaveValue(item.fields.level || '');
  assert.deepEqual(await snapshot(), beforeDirty, 'Editor discard does not issue an item change'); evidence.draftGuardsAndDiscardIcon = true;

  for (const width of [1146, 764]) {
    await page.setViewportSize({ width, height: 900 });
    await navigation.scrollIntoViewIfNeeded();
    const layout = await navigation.evaluate(el => {
      const viewer = el.closest('.takeoff-viewer').getBoundingClientRect(), group = el.getBoundingClientRect(), controls = [...el.querySelectorAll('button,input')].map(node => node.getBoundingClientRect());
      return { viewer: { left: viewer.left, right: viewer.right }, group: { left: group.left, right: group.right }, controls: controls.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
    });
    assert.ok(layout.group.left >= layout.viewer.left && layout.group.right <= layout.viewer.right, `${width}: page group fits inside viewer`);
    for (const bounds of layout.controls) assert.ok(bounds.left >= layout.group.left && bounds.right <= layout.group.right, `${width}: page buttons remain within their group`);
    assert.ok(Math.max(...layout.controls.map(rect => rect.top)) - Math.min(...layout.controls.map(rect => rect.top)) < 8, `${width}: page buttons remain on one row`);
    const before = await snapshot();
    await page.getByLabel('Page number', { exact: true }).fill('0'); await page.getByLabel('Page number', { exact: true }).press('Tab');
    await expect(page.locator('#takeoffs-workspace [role="alert"]')).toHaveText('Choose a page within this document.');
    const errorBounds = await assertErrorVisible(); assert.deepEqual(await snapshot(), before, 'Invalid page does not change the retained document or item');
    await page.screenshot({ path: path.join(output, `error-visible-${width}.png`) });
    await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
    await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('4');
    await navigation.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `page-controls-${width}.png`) });
    evidence[`width${width}`] = { layout, errorBounds };
  }
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  const final = await snapshot(); assert.deepEqual(final.items, beforeDirty.items); assert.deepEqual(final.calibrations, beforeDirty.calibrations);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, item: final.items[0], sourceHash: final.documents[0].sha256 }, null, 2));
  console.log(`PASS: Scale calibration, first/last page controls, draft guard, Discard icon, visible errors and responsive toolbar. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
