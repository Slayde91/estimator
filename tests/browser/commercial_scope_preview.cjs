// Historical Quote fields remain exact while their scope preview uses current columns.
const {chromium, expect: baseExpect} = require('@playwright/test');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {clickProjectControl} = require('./project_actions.cjs');
const {chooseLibrary} = require('./section_navigation.cjs');
const expect = baseExpect.configure({timeout:30000});
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `commercial-scope-preview-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data', value => logs += value);
const ready = new Promise((resolve, reject) => {
  let text = '';
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')), 120000);
  server.stdout.on('data', value => {
    text += value;
    if (text.includes('\n')) {
      clearTimeout(timer);
      resolve(JSON.parse(text.split('\n')[0]));
    }
  });
  server.once('error', reject);
  server.once('exit', code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}`));});
});
const errors = [], checks = [];
const headers = ['Line', 'Item / mark', 'Location', 'Product', 'Section', 'Design min / °C',
  'Board stack mm', 'Total thickness mm', 'Box ref. m²', 'Net board m²', 'With waste m²', 'Sheets / line', 'Report', 'Calculation Notes'];
async function idle() {
  await page.waitForFunction(() => {const value = window.CeasefireDesktop?.status(); return value?.ready && !value.busy;});
}
async function openQuotes() {
  await page.locator('#projects-navigation-toggle').hover();
  await page.locator('#projects-navigation-menu [data-project-section="quote"]').click();
  await expect(page.locator('#commercial-quote-root .commercial-board')).toBeVisible();
}
async function loadProject() {
  await clickProjectControl(page, 'Load');
  await page.locator('#discard-dialog').getByRole('button', {name:'Load Project', exact:true}).click();
  await idle();
}
async function saveProject() {
  const pending = page.waitForResponse(response => /\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
  await clickProjectControl(page, 'Save');
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  await idle();
}
async function editorFields() {
  return page.evaluate(() => JSON.parse(window.CeasefireCommercial.projectFingerprint()).editor.fields);
}
(async () => {
  const info = await ready;
  assert.notEqual(info.port, 8765);
  execFileSync(python, ['-c', `from pathlib import Path
import sys
from estimator.storage import Store
from estimator.project_file import export_project
path = Path(sys.argv[1])
store = Store(path.parent / 'preview-seed.sqlite3')
path.write_bytes(export_project(store, {'estimate': {'title': 'Scope preview fixture'}, 'calculators': {'steel_board': {'inputs': {'CALCULATOR': {'A9': 'SCOPE-PREVIEW-1'}}}}}))`, info.project], {cwd:root, windowsHide:true});
  browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1440, height:1000}});
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle();
  await loadProject();
  await openQuotes();
  const quote = page.locator('#commercial-quote-root');
  await quote.getByRole('button', {name:'New Quote', exact:true}).click();
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  await quote.getByLabel('Document title', {exact:true}).fill('Historical quote');
  await quote.locator('.commercial-editor-actions').getByRole('button', {name:'Save', exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  await saveProject();

  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  const historical = saved.commercial_documents.documents.find(document => document.kind === 'quote');
  historical.fields.scope_tables = [{title:'Old workbook columns', headers:['A', 'B'], rows:[['Legacy', 'Scope']]}];
  historical.fields.lines[0].unit_price = '12.34';
  historical.fields.lines[0].description = 'Historical agreed description';
  historical.fields.lines[0].quantity = '3';
  historical.fields.scope = '<p>Custom scope preamble retained.</p>';
  fs.writeFileSync(info.project, JSON.stringify(saved));
  await page.reload();
  await idle();
  await loadProject();
  await openQuotes();
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button', {name:'Open', exact:true}).click();
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  assert.deepEqual(await editorFields(), historical.fields);
  assert.deepEqual(await page.evaluate(() => ({changed:window.CeasefireCommercial.hasProjectChanges(), pending:window.CeasefireCommercial.hasPendingOperation()})), {changed:false, pending:false});
  await saveProject();
  const savedPreview = JSON.parse(fs.readFileSync(info.project, 'utf8')).commercial_documents.documents.find(document => document.id === historical.id);
  assert.deepEqual(savedPreview.fields, historical.fields);
  checks.push('historical scope opens with canonical columns while prices, quantities, descriptions, custom scope and source fingerprints remain exact and clean');

  await quote.locator('.commercial-editor-actions').getByRole('button', {name:'Save', exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  const refreshed = await editorFields();
  assert.deepEqual(refreshed.scope_tables[0].headers, headers);
  assert.notEqual(refreshed.lines[0].unit_price, '12.34');
  assert.equal(refreshed.lines[0].description, historical.fields.lines[0].description);
  assert.equal(refreshed.scope, historical.fields.scope);
  checks.push('explicit Quote Save adopts current prices and canonical scope');

  const appliedPricing = await page.evaluate(() => window.CeasefireProject.configuration());
  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click();
  await chooseLibrary(page, 'pricing');
  const price = page.locator('#pricing-body [data-price-field="supplier_price"]').first();
  await page.locator('#pricing-scope').selectOption('project');
  await expect(page.locator('#pricing-scope')).toHaveValue('project');
  const originalProjectPrice = await price.inputValue();
  await price.fill('123.45');
  await price.press('Tab');
  await page.locator('#pricing-scope').selectOption('library');
  await expect(page.locator('#pricing-scope')).toHaveValue('library');
  const originalLibraryPrice = await price.inputValue();
  await price.fill('987.65');
  await price.press('Tab');
  await page.locator('#projects-navigation-toggle').hover();
  await page.locator('#projects-navigation-menu [data-project-section="quote"]').click();
  await page.getByRole('dialog', {name:'Unsaved Pricing Library', exact:true}).getByRole('button', {name:'Continue', exact:true}).click();
  await expect(quote.locator('.commercial-board')).toBeVisible();
  const preview = page.waitForResponse(response => response.url().endsWith('/api/commercial/derive'));
  const pricingChoice = page.getByRole('dialog', {name:'Which prices should this project save?', exact:true});
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button', {name:'Open', exact:true}).click();
  const previewOutcome = await Promise.race([
    preview.then(() => 'preview'),
    pricingChoice.waitFor({state:'visible'}).then(() => 'pricing-choice')
  ]);
  assert.equal(previewOutcome, 'preview', 'Opening a scope preview must not ask which pricing draft to save');
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  await expect(pricingChoice).toBeHidden();
  assert.deepEqual(await editorFields(), refreshed);
  assert.deepEqual(await page.evaluate(() => window.CeasefireProject.configuration()), appliedPricing);
  await quote.locator('.commercial-editor-actions').getByRole('button', {name:'Save', exact:true}).click();
  await expect(pricingChoice).toBeVisible();
  await pricingChoice.getByRole('button', {name:'Cancel save', exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Save cancelled');
  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click();
  await chooseLibrary(page, 'pricing');
  await page.locator('#pricing-scope').selectOption('project');
  await page.getByRole('dialog', {name:'Unsaved Pricing Library', exact:true}).getByRole('button', {name:'Continue', exact:true}).click();
  await expect(page.locator('#pricing-scope')).toHaveValue('project');
  assert.equal(Number(await price.inputValue()), 123.45);
  await price.fill(originalProjectPrice);
  await price.press('Tab');
  await page.locator('#pricing-scope').selectOption('library');
  await expect(page.locator('#pricing-scope')).toHaveValue('library');
  assert.equal(Number(await price.inputValue()), 987.65);
  await price.fill(originalLibraryPrice);
  await price.press('Tab');
  await openQuotes();
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button', {name:'Open', exact:true}).click();
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  checks.push('scope preview skips pricing choices and preserves both conflicting drafts; explicit Save retains its pricing-choice guard');

  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click();
  let release, notifyHeld, notifyDelivered;
  const gate = new Promise(resolve => release = resolve);
  const held = new Promise(resolve => notifyHeld = resolve);
  const delivered = new Promise(resolve => notifyDelivered = resolve);
  let first = true;
  await page.route('**/api/commercial/derive', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    const body = await response.json();
    body.scope_tables = [{title:'Stale preview', headers:['STALE'], rows:[['Previous editor']]}];
    notifyHeld();
    await gate;
    await route.fulfill({response, json:body});
    notifyDelivered();
  });
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button', {name:'Open', exact:true}).click();
  await held;
  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click();
  await quote.getByRole('button', {name:'New Quote', exact:true}).click();
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  const replacement = await editorFields();
  release();
  await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.unroute('**/api/commercial/derive');
  await expect(quote.locator('.commercial-scope th')).toHaveText(headers);
  assert.deepEqual(await editorFields(), replacement);
  checks.push('a delayed scope preview cannot overwrite a different editor or its full refresh');
  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(output, 'canonical-scope.png'), fullPage:true});
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed:true, checks, errors}, null, 2));
  console.log(`PASS commercial scope preview: ${output}`);
})().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({path:path.join(output, 'failure.png'), fullPage:true}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  server.kill();
  fs.writeFileSync(path.join(output, 'server.log'), logs);
});
