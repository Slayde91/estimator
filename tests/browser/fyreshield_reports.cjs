"use strict";
// Real browser controls over invented records; no supplier library or live draft.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { chooseLibrary } = require('./section_navigation.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `fyreshield-reports-${Date.now()}`);
const fixture = path.join(__dirname, 'fyreshield_reports_fixture.py'), python = process.env.CEASEFIRE_PYTHON || 'python';
const sourceFiles = ['static/libraries.js', 'static/library-detail-text.js', 'estimator/reference_library.py', 'estimator/technical_catalog_policy.py', 'estimator/library_report_links.py', 'estimator/technical_fields.py', 'tests/browser/fyreshield_reports.cjs', 'tests/browser/fyreshield_reports_fixture.py'];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(root, file))]));
const evidence = { passed: false, source_before: sourceHashes(), checks: {}, errors: [], csp: [], blocked_requests: [], api_details: [] };
const server = spawn(python, ['-B', fixture, '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page, info, origin;
server.stderr.on('data', data => logs += data);
const ready = new Promise((resolve, reject) => {
  let line = ''; const timer = setTimeout(() => reject(Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { line += data; if (line.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(line.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
function diskSnapshot() {
  const reply = spawnSync(python, ['-B', fixture, '--directory', output, '--snapshot'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(reply.status, 0, reply.stderr); return JSON.parse(reply.stdout);
}
async function api(resource, status = 200) {
  const response = await page.request.get(origin + resource);
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
async function drafts() {
  return page.evaluate(async () => {
    await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]);
    return { calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(),
      pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details(), dirty: window.CeasefireDesktop.status().dirty };
  });
}
async function settled(scope, selector = '.library-results') { await expect(scope.locator(selector)).toHaveAttribute('aria-busy', 'false'); }
async function filter(scope, key, value, picker = false) {
  const attribute = picker ? 'data-library-link-filter' : 'data-library-filter';
  const reply = page.waitForResponse(response => { const u = new URL(response.url()); return u.pathname === '/api/libraries/technical' && u.searchParams.get('limit') === (picker ? '20' : '50') && u.searchParams.get(key) === value; });
  reply.catch(() => {});
  await scope.locator(`[${attribute}="${key}"]`).selectOption(value);
  const response = await reply; assert.equal(response.status(), 200, await response.text());
  await settled(scope, picker ? '.library-link-results' : '.library-results'); return response.json();
}
async function search(scope, value) {
  const reply = page.waitForResponse(response => { const u = new URL(response.url()); return u.pathname === '/api/libraries/technical' && (u.searchParams.get('search') || '') === value && u.searchParams.get('limit') === '50'; });
  reply.catch(() => {}); await scope.getByLabel('Search Technical Library', { exact: true }).fill(value);
  const response = await reply; assert.equal(response.status(), 200); await settled(scope); return response.json();
}
async function reportLink(scope, label, url) {
  const field = scope.locator('.library-record-field').filter({ has: page.locator('dt').filter({ hasText: /^Report Number$/ }) });
  await expect(field).toHaveCount(1);
  const link = field.getByRole('link', { name: label, exact: true });
  await expect(link).toHaveAttribute('href', url); await expect(link).toHaveAttribute('target', '_blank');
  assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['noopener', 'noreferrer']);
  return { text: await link.textContent(), href: await link.getAttribute('href') };
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); assert.equal(path.resolve(info.directory), output); origin = `http://127.0.0.1:${info.port}`;
  const familyIds = Object.values(info.family_ids).flat(); assert.equal(familyIds.length, 60);
  const raw = JSON.parse(fs.readFileSync(path.join(info.library, 'library.json'), 'utf8'));
  for (const item of raw.libraries.technical.items.filter(item => familyIds.includes(item.id))) {
    assert.equal(item.fields.some(field => field.label === 'Report Number'), false, 'Report metadata must come from production policy, not fixture assignment');
    assert.equal(item.filter_values.document, undefined);
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1146, height: 900 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.addInitScript(() => { window.fyreCsp = []; document.addEventListener('securitypolicyviolation', event => window.fyreCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const calculations = request.method() === 'POST' && (url.pathname === '/api/calculate' || /^\/api\/calculators\/[^/]+\/(?:worksheet|calculate)$/.test(url.pathname) || /^\/api\/penetration\/(?:definition|calculate|references)$/.test(url.pathname));
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) && !calculations) {
      evidence.blocked_requests.push({ method: request.method(), url: request.url() }); await route.abort(); return;
    }
    await route.continue();
  });
  await page.goto(origin); await page.waitForFunction(() => { const state = window.CeasefireDesktop?.status(); return state?.ready && !state.busy; });
  const beforeDrafts = await drafts(), beforeDisk = diskSnapshot(), beforeSave = await page.locator('#project-save-state').textContent();
  assert.equal(beforeDisk.raw_record_ids.length, info.raw_count); for (const id of info.removed_ids) assert.ok(beforeDisk.raw_record_ids.includes(id));
  const all = await api('/api/libraries/technical?limit=100');
  assert.equal(all.total, info.public_count); assert.equal(all.counts.total, info.public_count);
  assert.deepEqual(all.items.map(item => item.id).sort(), [...familyIds, ...Object.keys(info.controls)].sort());
  for (const id of info.removed_ids) await api(`/api/libraries/technical/${id}`, 404);
  assert.equal((await api('/api/libraries/technical?search=FRSS')).total, 0);
  for (const id of familyIds) {
    const detail = await api(`/api/libraries/technical/${id}`);
    const report = detail.fields.find(field => field.label === 'Report Number');
    assert.equal(report.value, info.report); assert.deepEqual(report.report_links, [{ label: info.report, url: info.report_url }]);
    const source = raw.libraries.technical.items.find(item => item.id === id);
    assert.deepEqual(detail.technical_basis.source_fields, source.fields, 'Projected report must not rewrite source fields');
    evidence.api_details.push({ id, report: report.value, url: report.report_links[0].url });
  }
  for (const [id, original] of Object.entries(info.controls)) {
    const control = await api(`/api/libraries/technical/${id}`);
    assert.equal(control.fields.find(field => field.label === 'Report Number').value, original);
  }
  evidence.checks.sixtyAssignedReportsAndUnchangedLookalikes = true;
  await chooseLibrary(page, 'technical'); const technical = page.locator('#technical-library-workspace'); await settled(technical);
  const reportOption = technical.locator('[data-library-filter="document"] optgroup[label="Trafalgar"] option').filter({ hasText: new RegExp(`^${info.report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  await expect(reportOption).toHaveCount(1); await expect(reportOption).toHaveAttribute('value', info.report);
  const hidden = await search(technical, 'FRSS'); assert.equal(hidden.total, 0); await expect(technical.locator('[data-library-record]')).toHaveCount(0);
  await search(technical, ''); const filtered = await filter(technical, 'document', info.report); assert.equal(filtered.total, 60);
  await expect(technical.locator('[data-library-record]')).toHaveCount(50);
  evidence.checks.nativeReportGroupFilterAndFrssSearch = true; evidence.checks.familyLinks = [];
  for (const [family, ids] of Object.entries(info.family_ids)) {
    await technical.locator(`[data-library-record="${ids[0]}"]`).click();
    const detail = technical.locator('[data-library-detail="technical"]'); await expect(detail).toBeVisible();
    evidence.checks.familyLinks.push({ family, id: ids[0], ...await reportLink(detail, info.report, info.report_url) });
    await page.screenshot({ path: path.join(output, `family-${evidence.checks.familyLinks.length}.png`) });
    await detail.getByRole('button', { name: 'Back to results', exact: true }).click(); await settled(technical);
    await expect(technical.locator('[data-library-filter="document"]')).toHaveValue(info.report);
  }
  await chooseLibrary(page, 'penetration'); const penetration = page.locator('#penetration-library-workspace'); await settled(penetration);
  await penetration.locator(`[data-library-link="${info.penetration_id}"]`).click(); const picker = penetration.locator('.library-link-picker:visible');
  await settled(picker, '.library-link-results');
  const pickerReport = picker.locator('[data-library-link-filter="document"] optgroup[label="Trafalgar"] option[value="' + info.report + '"]');
  await expect(pickerReport).toHaveCount(1);
  const pickerData = await filter(picker, 'document', info.report, true);
  assert.equal(pickerData.total, 60); await expect(picker.locator('[data-library-link-choice]')).toHaveCount(20);
  const pickedIds = pickerData.items.map(item => item.id);
  assert.ok(pickerData.items.every(item => familyIds.includes(item.id)));
  for (const offset of [20, 40]) {
    const next = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/libraries/technical' && url.searchParams.get('document') === info.report && url.searchParams.get('offset') === String(offset) && url.searchParams.get('limit') === '20'; });
    next.catch(() => {}); await picker.getByRole('button', { name: 'Next', exact: true }).click();
    const reply = await next; assert.equal(reply.status(), 200); const values = await reply.json();
    assert.equal(values.total, 60); await settled(picker, '.library-link-results');
    assert.deepEqual(await picker.locator('[data-library-link-choice]').evaluateAll(choices => choices.map(choice => choice.value)), values.items.map(item => item.id));
    pickedIds.push(...values.items.map(item => item.id));
  }
  assert.deepEqual(pickedIds.sort(), [...familyIds].sort());
  await page.screenshot({ path: path.join(output, 'report-picker.png') });
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(picker).toHaveCount(0);
  evidence.checks.linkPickerUsesSameAssignedReport = true;
  assert.deepEqual(await drafts(), beforeDrafts); assert.equal(await page.locator('#project-save-state').textContent(), beforeSave);
  assert.deepEqual(diskSnapshot(), beforeDisk); evidence.checks.draftsDatabaseProjectAndRawSourcesUnchanged = true;
  evidence.csp = await page.evaluate(() => window.fyreCsp); assert.deepEqual(evidence.csp, []); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blocked_requests, []);
  evidence.source_after = sourceHashes(); assert.deepEqual(evidence.source_after, evidence.source_before);
  evidence.limits = ['All 67 source records, source documents and diagrams are invented disposable fixtures; no installed library or existing browser tab is opened.', 'The exact external report URL is checked without fetching the supplier page or inferring tested applicability.', 'Native exports are covered separately by the policy integration tests.'];
  evidence.passed = true; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ passed: true, output, port: info.port, reports: evidence.api_details.length, checks: evidence.checks }));
})().catch(async error => {
  evidence.failure = String(error.stack || error); evidence.source_after = sourceHashes(); fs.mkdirSync(output, { recursive: true });
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'server.log'), logs); });
