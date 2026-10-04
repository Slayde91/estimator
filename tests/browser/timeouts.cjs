// Exercise the actual PDF deadline against an intercepted, stalled source read.
// The production server and PDF parser remain real; no application code is mocked.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime', 'browser-qa', `timeouts-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let serverErrors = '', browser, page;
server.stderr.on('data', data => { serverErrors = (serverErrors + data).slice(-8000); });
const ready = new Promise((resolve, reject) => {
  let text = '', settled = false;
  const timer = setTimeout(() => reject(new Error(`Disposable server startup timeout: ${serverErrors}`)), 120000);
  server.stdout.on('data', data => {
    if (settled) return;
    text += data;
    if (text.includes('\n')) { settled = true; clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } }
  });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); if (!settled) reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
});
const errors = [], warnings = [], heldRoutes = [];
async function run() {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (['warning', 'error'].includes(event.type())) warnings.push(event.text()); });
  await page.addInitScript(() => {
    window.timeoutQa = { activeWorkers: 0, terminatedWorkers: 0, violations: [] };
    document.addEventListener('securitypolicyviolation', event => window.timeoutQa.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) { super(url, options); this.observed = String(url).includes('takeoff-pdf-worker.mjs'); if (this.observed) window.timeoutQa.activeWorkers++; }
      terminate() { if (this.observed) { this.observed = false; window.timeoutQa.activeWorkers--; window.timeoutQa.terminatedWorkers++; } return super.terminate(); }
    };
  });
  const sourcePattern = '**/api/takeoffs/sessions/*/documents/*/file';
  await page.route(sourcePattern, route => { heldRoutes.push(route); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload PDFs', exact: true })).toBeVisible();
  const failureResponse = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === 'record_render' && response.request().postDataJSON()?.success === false, { timeout: 60000 });
  const start = Date.now();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 30000 });
  const failed = await (await failureResponse).json(), timeoutMs = Date.now() - start;
  assert.ok(heldRoutes.length > 0, 'The original PDF read was actually stalled');
  assert.ok(failed.snapshot.render_checks.some(check => check.page === 1 && check.success === false && check.warnings.some(warning => /timed out/.test(warning))));
  await expect(page.locator('.takeoff-empty')).toContainText('Drawing unavailable');
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('timed out');
  await expect.poll(() => page.evaluate(() => window.timeoutQa.activeWorkers), { timeout: 5000 }).toBe(0);
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: path.join(output, 'stalled-source-blocked.png'), fullPage: true });

  // A transport timeout is recoverable. Successful re-render clears the failed
  // proof, while any item approvals invalidated by that failure still need review.
  await page.unroute(sourcePattern);
  await Promise.allSettled(heldRoutes.map(route => route.abort()));
  const retryResponse = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === 'record_render' && response.request().postDataJSON()?.success === true);
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  const retried = await (await retryResponse).json();
  assert.ok(retried.snapshot.render_checks.some(check => check.page === 1 && check.success && check.warnings.length === 0));
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();
  await expect(page.locator('#takeoffs-workspace [role="alert"]')).toHaveCount(0);
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  const metrics = await page.evaluate(() => window.timeoutQa);
  assert.equal(metrics.terminatedWorkers, 1); assert.equal(metrics.activeWorkers, 1);
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []); assert.deepEqual(metrics.violations, []);
  await page.screenshot({ path: path.join(output, 'healthy-retry-rendered.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, timeoutMs, failedRenderProof: failed.snapshot.render_checks, recoveredRenderProof: retried.snapshot.render_checks, metrics, errors, warnings }, null, 2));
  console.log(`PASS: source read timed out visibly, recorded a failed proof, terminated its worker, and retried successfully. Evidence: ${output}`);
}
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('PDF timeout/retry browser test exceeded two minutes')), 120000); })])
  .catch(async error => {
    console.error(error); console.error(serverErrors);
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
    process.exitCode = 1;
  })
  .finally(async () => { clearTimeout(deadline); if (browser) await browser.close(); server.kill(); });
