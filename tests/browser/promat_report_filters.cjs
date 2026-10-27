"use strict";
// Native Report controls over invented records, with no installed data access.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { chooseLibrary } = require('./section_navigation.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `promat-report-filters-${Date.now()}`);
const fixture = path.join(__dirname, 'promat_report_filters_fixture.py'), python = process.env.CEASEFIRE_PYTHON || 'python';
const sourceFiles = ['static/libraries.js', 'static/library-detail-text.js', 'estimator/reference_library.py', 'estimator/firestopping_library.py', 'estimator/technical_catalog_policy.py', 'estimator/library_report_links.py', 'estimator/library_filter_groups.py', 'estimator/technical_fields.py', 'tests/browser/promat_report_filters.cjs', 'tests/browser/promat_report_filters_fixture.py'];
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(root, file))]));
const evidence = { passed: false, source_before: sourceHashes(), checks: {}, errors: [], csp: [], blocked_requests: [], details: [], queries: [] };
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
async function api(resource) {
  const response = await page.request.get(origin + resource);
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function drafts() {
  return page.evaluate(async () => {
    await Promise.all([window.CeasefireCalculators.completeProjectSnapshot(), window.CeasefirePenetrations.completeProjectSnapshot()]);
    return { calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(),
      pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details(), dirty: window.CeasefireDesktop.status().dirty };
  });
}
async function settled(scope, selector = '.library-results') { await expect(scope.locator(selector)).toHaveAttribute('aria-busy', 'false'); }
async function reportFilter(scope, picker = false) {
  const attribute = picker ? 'data-library-link-filter' : 'data-library-filter';
  const reply = page.waitForResponse(response => { const u = new URL(response.url()); return u.pathname === '/api/libraries/technical' && u.searchParams.get('document') === info.report && u.searchParams.get('limit') === (picker ? '20' : '50'); });
  reply.catch(() => {}); await scope.locator(`[${attribute}="document"]`).selectOption(info.report);
  const response = await reply; assert.equal(response.status(), 200, await response.text());
  const query = Object.fromEntries(new URL(response.url()).searchParams); assert.equal(query.manufacturer, undefined, 'Report selection alone must find all 18 records');
  evidence.queries.push(query); await settled(scope, picker ? '.library-link-results' : '.library-results'); return response.json();
}
async function existingReportLink(scope, id) {
  const field = scope.locator('.library-record-field').filter({ has: page.locator('dt').filter({ hasText: /^Report Number$/ }) });
  await expect(field).toHaveCount(1);
  const link = field.getByRole('link', { name: info.report, exact: true });
  await expect(link).toHaveAttribute('href', info.report_url); await expect(link).toHaveAttribute('target', '_blank');
  assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['noopener', 'noreferrer']);
  return { id, text: await link.textContent(), href: await link.getAttribute('href') };
}
(async () => {
  info = await ready; assert.notEqual(info.port, 8765); assert.equal(path.resolve(info.directory), output); origin = `http://127.0.0.1:${info.port}`;
  const expected = [...info.missing_ids, info.assigned_id]; assert.equal(info.missing_ids.length, 17); assert.equal(expected.length, 18);
  const raw = JSON.parse(fs.readFileSync(path.join(info.library, 'library.json'), 'utf8'));
  for (const item of raw.libraries.technical.items.filter(item => info.missing_ids.includes(item.id))) {
    assert.deepEqual(item.filter_values.document, [], 'The fixture must begin with the 17 assignments missing');
    assert.deepEqual(item.fields.find(field => field.label === 'Report Number'), { label: 'Report Number', value: info.report, report_links: [{ label: info.report, url: info.report_url }] });
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1146, height: 900 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.addInitScript(() => { window.promatCsp = []; document.addEventListener('securitypolicyviolation', event => window.promatCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const calculation = request.method() === 'POST' && (url.pathname === '/api/calculate' || /^\/api\/calculators\/[^/]+\/(?:worksheet|calculate)$/.test(url.pathname) || /^\/api\/penetration\/(?:definition|calculate|references)$/.test(url.pathname));
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) && !calculation) {
      evidence.blocked_requests.push({ method: request.method(), url: request.url() }); await route.abort(); return;
    }
    await route.continue();
  });
  await page.goto(origin); await page.waitForFunction(() => { const state = window.CeasefireDesktop?.status(); return state?.ready && !state.busy; });
  const beforeDrafts = await drafts(), beforeDisk = diskSnapshot(), beforeSave = await page.locator('#project-save-state').textContent();
  const all = await api('/api/libraries/technical?limit=100'); assert.equal(all.total, info.raw_count);
  const option = all.filters.find(field => field.key === 'document');
  assert.deepEqual(option.options.map(value => value.value).sort(), [info.report, 'SYN-KEEP Rev A'].sort(), 'Placeholders and another supplier must not gain report choices');
  assert.deepEqual(option.options.find(value => value.value === info.report), { value: info.report, label: info.report, group: 'Promat' });
  const reportOnly = await api(`/api/libraries/technical?document=${info.report}&limit=100`);
  assert.equal(reportOnly.total, 18); assert.deepEqual(reportOnly.items.map(item => item.id).sort(), [...expected].sort());
  const preserved = await api('/api/libraries/technical?document=SYN-KEEP%20Rev%20A'); assert.deepEqual(preserved.items.map(item => item.id), [info.preserved_id]);
  for (const source of raw.libraries.technical.items) {
    const detail = await api(`/api/libraries/technical/${source.id}`), original = source.fields.find(field => field.label === 'Report Number');
    assert.deepEqual(detail.technical_basis.source_fields, source.fields, 'Report-facet repair must preserve immutable source fields');
    const projected = detail.fields.find(field => field.label === 'Report Number');
    // Existing presentation may omit empty/punctuation-only placeholders.
    // Their immutable source and lack of a report assignment remain checked.
    if (projected || !info.placeholder_ids.includes(source.id)) assert.equal(projected?.value, original.value, 'Existing report text stays unchanged');
    assert.deepEqual(projected?.report_links || [], original.report_links || [], 'Existing report links stay unchanged');
    evidence.details.push({ id: source.id, report: original.value, source_preserved: true });
  }
  evidence.checks.exact17RecoveredAndExistingAssignmentPreserved = true;
  evidence.checks.foreignPlaceholderAndAssignedOtherFacetUnchanged = true;
  await chooseLibrary(page, 'technical'); const technical = page.locator('#technical-library-workspace'); await settled(technical);
  const grouped = technical.locator('[data-library-filter="document"] optgroup[label="Promat"] option[value="148393"]'); await expect(grouped).toHaveCount(1);
  await expect(technical.locator('[data-library-filter="manufacturer"]')).toHaveValue('');
  const filtered = await reportFilter(technical); assert.equal(filtered.total, 18);
  assert.deepEqual(await technical.locator('[data-library-record]').evaluateAll(buttons => buttons.map(button => button.dataset.libraryRecord).sort()), [...expected].sort());
  evidence.checks.nativePromatGroupAndReportOnlyFilter = true; evidence.checks.nativeLinks = [];
  for (const id of [info.missing_ids[0], info.missing_ids.at(-1), info.assigned_id]) {
    await technical.locator(`[data-library-record="${id}"]`).click();
    const detail = technical.locator('[data-library-detail="technical"]'); await expect(detail).toBeVisible();
    evidence.checks.nativeLinks.push(await existingReportLink(detail, id));
    await page.screenshot({ path: path.join(output, `report-link-${evidence.checks.nativeLinks.length}.png`) });
    await detail.getByRole('button', { name: 'Back to results', exact: true }).click(); await settled(technical);
    await expect(technical.locator('[data-library-filter="document"]')).toHaveValue(info.report);
  }
  await chooseLibrary(page, 'penetration'); const penetration = page.locator('#penetration-library-workspace'); await settled(penetration);
  await penetration.locator(`[data-library-link="${info.penetration_id}"]`).click(); const picker = penetration.locator('.library-link-picker:visible'); await settled(picker, '.library-link-results');
  await expect(picker.locator('[data-library-link-filter="document"] optgroup[label="Promat"] option[value="148393"]')).toHaveCount(1);
  await expect(picker.locator('[data-library-link-filter="manufacturer"]')).toHaveValue('');
  const choices = await reportFilter(picker, true); assert.equal(choices.total, 18);
  assert.deepEqual(await picker.locator('[data-library-link-choice]').evaluateAll(inputs => inputs.map(input => input.value).sort()), [...expected].sort());
  await page.screenshot({ path: path.join(output, 'report-only-picker.png') });
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(picker).toHaveCount(0);
  evidence.checks.pickerReportOnlyReturnsExact18 = true;
  const afterDrafts = await drafts(), afterDisk = diskSnapshot();
  assert.deepEqual(afterDrafts, beforeDrafts); assert.deepEqual(afterDisk, beforeDisk); assert.equal(await page.locator('#project-save-state').textContent(), beforeSave);
  evidence.preservation = { drafts_sha256: digest(JSON.stringify(beforeDrafts)), database_sha256: beforeDisk.database_sha256,
    database_rows_sha256: digest(JSON.stringify(beforeDisk.database_rows)), library_files: beforeDisk.library_files, project_files: beforeDisk.project_files };
  evidence.checks.draftsProjectDatabaseAndRawSourcesUnchanged = true;
  evidence.csp = await page.evaluate(() => window.promatCsp); assert.deepEqual(evidence.csp, []); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.blocked_requests, []);
  evidence.source_after = sourceHashes(); assert.deepEqual(evidence.source_after, evidence.source_before);
  evidence.limits = ['All records, source documents and report URLs are synthetic; no installed library or existing browser tab is opened.', 'The retained report URL is validated as a native hyperlink without fetching a supplier report or inferring applicability.', 'This journey changes no substrate data and exercises only read-only library navigation and local calculation snapshots.'];
  evidence.passed = true; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ passed: true, output, port: info.port, missing: info.missing_ids.length, reportMatches: reportOnly.total, checks: evidence.checks }));
})().catch(async error => {
  evidence.failure = String(error.stack || error); evidence.source_after = sourceHashes(); fs.mkdirSync(output, { recursive: true });
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'server.log'), logs); });
