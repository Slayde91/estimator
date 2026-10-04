const { chooseLibrary } = require('./section_navigation.cjs');
// Native navigation acceptance against disposable synthetic data only. Hover,
// keyboard and touch must select the existing workspaces without replacing drafts.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `calculator-navigation-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const assets = ['static/app.js', 'static/calculators.js', 'static/calculators.css', 'static/index.html', 'static/styles.css'];
const assetHashes = Object.fromEntries(assets.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const destinations = ['Steel (spray)', 'Steel (board)', 'Ductwork (spray/wrap)', 'Firestopping Estimator'];
function monitor(target) {
  target.setDefaultTimeout(60000); target.on('pageerror', error => errors.push(error.message));
  target.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  return target.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
}
async function idle(target = page) { await target.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function snapshots() { return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details() })); }
async function workbook(title) {
  await expect(page.locator('#calculator-workspace')).toBeVisible(); await expect(page.locator('#estimator-penetration')).toBeHidden();
  await expect(page.locator('#calculator-title')).toHaveText(title); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false');
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await monitor(page);
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline')); await idle();
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  const calculationRequests = () => requests.filter(item => item.path.startsWith('/api/calculators/')).length;
  const before = await snapshots(), beforeRequests = calculationRequests();
  const toggle = page.getByRole('button', { name: 'Calculators', exact: true }), menu = page.getByRole('group', { name: 'Choose a calculator', exact: true });
  await expect(page.locator('#calculator-list')).toHaveCount(0); await expect(page.locator('.calculator-choice')).toHaveCount(0);
  await toggle.hover(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(menu).toBeVisible();
  assert.deepEqual(await menu.getByRole('button').allTextContents(), destinations);
  await page.mouse.move(0, 0); await expect(menu).toBeHidden(); assert.deepEqual(await snapshots(), before);
  assert.equal(calculationRequests(), beforeRequests, 'Hover must not open a calculator or make a calculation request');
  evidence.hover = { destinations, changedDrafts: false, openedCalculator: false, requestedCalculation: false };

  await toggle.focus(); await expect(menu).toBeVisible(); await toggle.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(menu.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(menu.getByRole('button').last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(menu.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(menu).toBeHidden();
  assert.deepEqual(await snapshots(), before);
  await toggle.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('button', { name: 'Steel (board)', exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await workbook('Steel (board)');
  assert.deepEqual(await snapshots(), before); evidence.keyboard = { focus: true, arrows: true, homeEnd: true, escapeReturnsFocus: true, enterSelectsCalculator: true, changedDrafts: false };

  // Select every real calculator, then retain an edited schedule value and its
  // current page while navigating through the other workspaces.
  await chooseCalculator(page, 'Steel (spray)'); await workbook('Steel (spray)');
  await page.locator('#calculator-pages button').filter({ hasText: /^SCHEDULE$/ }).click(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false');
  const input = page.locator('[data-calculator-sheet="SCHEDULE"][data-calculator-cell="A10"]'); await expect(input).toBeVisible(); await input.fill('MENU-DRAFT-1'); await input.press('Tab');
  await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false'); const retained = await snapshots();
  for (const title of ['Steel (board)', 'Ductwork (spray/wrap)']) { await chooseCalculator(page, title); await workbook(title); }
  await chooseCalculator(page, 'Firestopping Estimator'); await idle(); await expect(page.locator('#estimator-penetration')).toBeVisible(); await expect(page.locator('#calculator-workspace')).toBeHidden();
  await chooseCalculator(page, 'Steel (spray)'); await workbook('Steel (spray)'); await expect(page.locator('#calculator-sheet-title')).toHaveText('SCHEDULE'); await expect(input).toHaveValue('MENU-DRAFT-1');
  assert.deepEqual(await snapshots(), retained); evidence.selection = { allDestinations: true, unsavedScheduleRetained: true, pageRetained: true, unrelatedDraftsUnchanged: true };

  // Menu navigation uses the established library confirmation, including its
  // cancellation behavior. An explicit Continue retains the unsaved prices.
  await page.getByRole('button', { name: 'Libraries', exact: true }).click(); await chooseLibrary(page, 'pricing'); await page.locator('#pricing-scope').selectOption('library');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first(); await price.fill('789.12345'); await price.press('Tab');
  const priceDisplay = await price.inputValue(); assert.equal(priceDisplay, '789.12');
  const guarded = await snapshots(); await chooseCalculator(page, 'Steel (board)');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('heading')).toHaveText('Unsaved Pricing Library');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('#view-pricing')).toBeVisible(); await expect(price).toHaveValue(priceDisplay); assert.deepEqual(await snapshots(), guarded);
  await chooseCalculator(page, 'Steel (board)'); await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await workbook('Steel (board)'); assert.deepEqual(await snapshots(), guarded);
  assert.ok(!requests.some(item => item.method !== 'GET' && /\/api\/(?:pricing|calculators)\/.+state$|\/api\/pricing$/.test(item.path)), 'Navigation must not save pricing or calculator defaults');
  evidence.pricingGuard = { cancelPreservesView: true, cancelPreservesPriceAndDrafts: true, continueKeepsUnsavedPrices: true };

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  for (const width of [1600, 1146, 825, 570, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.mouse.move(0, 0); await toggle.hover(); await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `Dropdown escaped viewport at ${width}: ${JSON.stringify(bounds)}`);
    await expect(menu.getByRole('button', { name: 'Ductwork (spray/wrap)', exact: true })).toBeVisible();
    if ([1146, 390].includes(width)) await page.screenshot({ path: path.join(output, `calculator-menu-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Home', exact: true }).click(); await expect(menu).toBeHidden();
  }
  evidence.viewports = [1600, 1146, 825, 570, 390];
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touch = await touchContext.newPage(); await monitor(touch); await touch.goto(`http://127.0.0.1:${info.port}/`); await idle(touch);
  await touch.getByRole('button', { name: 'Calculators', exact: true }).tap();
  const touchMenu = touch.getByRole('group', { name: 'Choose a calculator', exact: true }); await expect(touchMenu).toBeVisible();
  await touchMenu.getByRole('button', { name: 'Steel (board)', exact: true }).tap(); await expect(touch.locator('#calculator-title')).toHaveText('Steel (board)', { timeout: 60000 }); await expect(touch.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 }); await expect(touchMenu).toBeHidden();
  evidence.touch = { disclosureTap: true, chosenCalculator: 'Steel (board)' };
  assert.deepEqual(await touch.evaluate(() => window.qaCsp), []); await touchContext.close();
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, assetHashes, evidence, errors, csp: [] }, null, 2));
  console.log(`PASS: native calculator menu hover, keyboard, touch, all destinations, draft preservation and Pricing Library guard. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000)); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
