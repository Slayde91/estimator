// Help and Main document access run against disposable production data only.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { clickProjectControl } = require('./project_actions.cjs');
const root = path.resolve(__dirname, '../..'), standard = process.argv.includes('--standard');
const output = path.join(root, '.runtime/browser-qa', `help-glossary-${standard ? 'standard' : 'full'}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, standard ? 'standard_fixture.py' : 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], failed = [], requests = [], csp = [], evidence = { standard, layouts: [] };
async function idle() { await page.waitForFunction(() => { const s = window.CeasefireDesktop?.status(); return s?.ready && !s.busy; }); }
async function snapshot() { await idle(); return page.evaluate(() => ({
  calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(),
  pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details(),
  takeoffs: window.CeasefireTakeoffs?.projectSnapshot() || null, dirty: window.CeasefireDesktop.status().dirty,
})); }
async function theme(id) { for (let index = 0; index < 5 && await page.locator('html').getAttribute('data-theme') !== id; index++) await page.locator('#theme-toggle').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', id); }
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failed.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) requests.push(new URL(request.url()).pathname); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  if (standard) fs.writeFileSync(path.join(output, 'dialog-mode.json'), '{}');
  const save = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project/save-as');
  await clickProjectControl(page, 'Save'); assert.equal((await save).status(), 200); await idle();
  const projectFile = standard ? path.join(output, 'standard-project.cf.json') : info.project;
  const savedBytes = fs.readFileSync(projectFile), before = await snapshot();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const glossary = page.locator('.help-glossary'); await expect(glossary.getByRole('heading', { name: 'Button symbols, functions and shortcuts', exact: true })).toBeVisible();
  const search = page.locator('#help-glossary-search'), category = page.locator('#help-glossary-category'), visibleRows = () => glossary.locator('.help-glossary-entry:visible');
  const total = await visibleRows().count(); assert.ok(total >= (standard ? 30 : 85)); evidence.entries = total;
  const requestCount = requests.length;
  if (!standard) {
    await search.fill('ctrl+F8'); await expect(visibleRows()).toHaveCount(1); await expect(visibleRows().first()).toHaveAttribute('data-glossary-name', 'Trace surface');
    await search.fill('Ctrl+C'); await expect(visibleRows().filter({ hasText: 'Copy / Paste drawing selection' })).toHaveCount(1);
    await search.fill('Cmd+V'); await expect(visibleRows()).toHaveCount(1);
    await search.fill('net sqm'); await expect(visibleRows()).toHaveCount(1);
    await search.fill('Signatures'); await expect(visibleRows()).toHaveCount(1); await expect(visibleRows().locator('.helper')).toHaveText('Button only');
    assert.equal(await visibleRows().locator('.help-signature-symbol').evaluate(el => getComputedStyle(el, '::before').maskImage.includes('signature.svg')), true);
    await glossary.screenshot({ path: path.join(output, 'signature-reference.png') });
  } else {
    assert.equal(await category.locator('option').filter({ hasText: 'Drawing tools' }).count(), 0);
    assert.equal(await glossary.locator('.help-signature-symbol').count(), 0);
  }
  await search.fill('download'); await category.selectOption('Documents'); assert.ok(await visibleRows().count() >= 4);
  await search.fill('<script>'); await expect(visibleRows()).toHaveCount(0); await expect(page.locator('#help-glossary-status')).toContainText('No matching controls');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click(); await expect(search).toBeFocused(); assert.equal(await visibleRows().count(), total);
  assert.deepEqual(await snapshot(), before, 'Help filtering changes no calculator, price, project or Takeoff draft'); assert.equal(requests.length, requestCount, 'Glossary controls make no mutation requests');
  const menu = page.locator('#firestopping-document-actions'), toggle = page.locator('[aria-controls="firestopping-document-actions"]'), summary = menu.locator('#download-quote-pdf');
  for (const themeId of ['ceasefire', 'midnight', 'ocean', 'forest', 'slate']) {
    await theme(themeId);
    for (const width of [1440, 825, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${themeId}/${width}: Help stays within viewport`);
      await page.getByRole('button', { name: 'Estimates', exact: true }).click(); await idle();
      const menuRequestCount = requests.length;
      await toggle.focus(); await toggle.press('ArrowDown'); await expect(summary).toBeFocused(); await expect(summary).toHaveAccessibleName('Download Estimate Summary');
      await expect(menu.getByRole('button')).toHaveCount(3); await expect(summary.locator('span').last()).toHaveText('Download Estimate Summary');
      const styles = await menu.locator('.calculator-document-action').evaluateAll(actions => actions.map(el => { const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor }; }));
      assert.deepEqual(styles[0], styles[1], 'Estimate Summary shares the existing menu-entry presentation'); assert.equal(styles[0].background, 'rgb(255, 255, 255)');
      const bounds = await menu.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${themeId}/${width}: Document stays within viewport`);
      if (width === 390) await menu.screenshot({ path: path.join(output, `${themeId}-summary-menu.png`) });
      await page.keyboard.press('End'); await expect(menu.getByRole('button').last()).toBeFocused(); await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(toggle).toBeFocused();
      assert.equal(requests.length, menuRequestCount, 'Opening and navigating Document requests no calculation or mutation');
      await page.getByRole('button', { name: 'Help', exact: true }).click(); await expect(glossary).toBeVisible();
      await page.screenshot({ path: path.join(output, `${themeId}-${width}.png`) }); evidence.layouts.push({ theme: themeId, width, summaryEntry: styles[0] });
    }
  }
  assert.deepEqual(await snapshot(), before);
  const navigationRequests = requests.slice(requestCount);
  assert.ok(navigationRequests.every(route => route === '/api/penetration/calculate'), 'Repeated Main navigation uses only its existing read-only Firestopping calculation');
  evidence.navigationCalculations = navigationRequests.length;
  await page.getByRole('button', { name: 'Estimates', exact: true }).click(); await idle(); await toggle.click();
  const download = page.waitForResponse(response => response.request().method() === 'POST' && (/^\/api\/quote-report$/.test(new URL(response.url()).pathname) || /^\/api\/quotes\/[^/]+\/report\.pdf$/.test(new URL(response.url()).pathname)));
  await summary.click(); const response = await download; assert.equal(response.status(), 200); const file = await response.json();
  assert.equal(file.saved, true); assert.equal(file.destination, 'project');
  const relative = path.relative(output, file.path); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(fs.readFileSync(file.path).subarray(0, 5).toString(), '%PDF-'); await idle(); await expect(menu).toBeHidden(); await expect(summary).toHaveAttribute('aria-label', 'Download Estimate Summary');
  assert.deepEqual(await snapshot(), before, 'Real summary download preserves current drafts and pricing'); assert.deepEqual(fs.readFileSync(projectFile), savedBytes, 'Download leaves the saved project untouched');
  evidence.summaryExport = { endpoint: new URL(response.url()).pathname, filename: file.filename, pdf: true };
  csp.push(...await page.evaluate(() => window.qaCsp)); assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, ...evidence, errors, failed, csp, draftsUnchanged: true, savedProjectUnchanged: true }, null, 2));
  console.log(`PASS ${standard ? 'Standard' : 'Full'} Help glossary: ${total} entries, search/keyboard, 15 theme layouts and real Main Estimate Summary export; drafts and saved project unchanged. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-4000)); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
