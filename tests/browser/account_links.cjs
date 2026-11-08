// Standalone Account creation must retain the project and save links atomically.
const {chromium, expect: browserExpect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const expect = browserExpect.configure({timeout: 30000});
const cwd = path.resolve(__dirname, '../..');
const output = path.join(cwd, '.runtime/browser-qa', 'account-links-' + Date.now());
fs.mkdirSync(output, {recursive: true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd, windowsHide: true});
let logs = '', stdout = '', browser;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timed out')), 120000);
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + ' ' + logs)); });
  server.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); }
  });
});

(async () => {
  const {port} = await ready;
  assert.notEqual(port, 8765);
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1101, height: 884}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = 'http://127.0.0.1:' + port;
  async function api(route, payload) {
    const response = payload === undefined ? await page.request.get(base + route) : await page.request.post(base + route, {data: payload});
    const value = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(value));
    return value;
  }
  const directory = () => api('/api/contacts/directory');
  await api('/api/projects/link-folder', {});
  let state = await directory();
  const person = await api('/api/contacts/contacts', {version: state.version, fields: {name: 'Link Person', company: 'Original Company'}});
  state = await directory();
  const lead = await api('/api/contacts/leads', {version: state.version, fields: {name: 'Project Contact', company: 'Source Company', site_address: '10 Test Street'}});
  state = await directory();
  const project = await api('/api/contacts/leads/convert', {version: state.version, id: lead.id});
  await expect.poll(async () => {
    const catalog = await api('/api/contacts/account-links');
    fs.writeFileSync(path.join(output, 'catalog.json'), JSON.stringify({project, catalog}, null, 2));
    return catalog.choices.projects.some(item => item.label.includes(project.project_no));
  }).toBe(true);
  await page.goto(base + '/');
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  const context = await page.evaluate(() => window.CeasefireProject.context());
  await page.evaluate(() => { window.accountResult = window.ClassifireContacts.createAccount({company: 'New Company'}); });
  const dialog = page.getByRole('dialog', {name: 'New Account', exact: true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Company', {exact: true})).toHaveValue('New Company');
  await dialog.getByLabel('ABN/ACN', {exact: true}).fill('12 345 678 901');
  await dialog.getByLabel('Billing address').fill('20 Billing Street');
  const contactLink = dialog.getByRole('checkbox', {name: /Link Link Person/});
  await contactLink.check();
  await expect(contactLink).toBeFocused();
  await expect(dialog).toContainText('Saving will move this contact from Original Company.');
  await dialog.locator('[data-link-group="projects"] > summary').click();
  await dialog.getByRole('checkbox', {name: new RegExp('Link ' + project.project_no)}).check();
  await dialog.getByLabel('Find records to link').fill('Link Person');
  await expect(dialog.locator('.contacts-link-controls button')).toBeEnabled();
  await expect(contactLink).toBeChecked();
  await expect(dialog.locator('[data-link-group="projects"] > summary')).toHaveText('Projects (1)');
  let submitted;
  await page.route('**/api/contacts/accounts', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'The directory is temporarily unavailable.'})});
  });
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).toContainText('The directory is temporarily unavailable.');
  await expect(dialog.getByLabel('ABN/ACN', {exact: true})).toHaveValue('12 345 678 901');
  await expect(contactLink).toBeChecked();
  assert.deepEqual(submitted.links.contacts, [person.id]);
  assert.equal(submitted.links.projects.length, 1);
  assert.deepEqual(submitted.links.quotes, []);
  assert.deepEqual(submitted.links.work_orders, []);
  assert.deepEqual(submitted.links.purchase_orders, []);
  await page.unroute('**/api/contacts/accounts');
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).not.toBeVisible();
  const account = await page.evaluate(() => window.accountResult);
  assert.equal(account.company, 'New Company');
  assert.equal(account.abn_acn, '12 345 678 901');
  assert.ok(account.id);
  assert.deepEqual(await page.evaluate(() => window.CeasefireProject.context()), context);
  state = await directory();
  assert.equal(state.accounts.filter(item => item.company === 'New Company').length, 1);
  assert.equal(state.contacts.find(item => item.id === person.id).account_id, account.id);
  const linked = await api('/api/contacts/account-links?id=' + account.id);
  assert.equal(linked.linked.projects.length, 1);
  assert.equal(linked.linked.contacts[0].id, person.id);
  assert.ok(linked.linked.projects[0].label.includes(project.project_no));

  // A true competing directory write leaves the complete form draft visible.
  await page.evaluate(() => { window.cancelledAccount = window.ClassifireContacts.createAccount({company: 'Conflict Company'}); });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('ABN/ACN', {exact: true}).fill('Keep this draft');
  await expect(dialog.getByRole('button', {name: 'Save', exact: true})).toBeEnabled();
  state = await directory();
  await api('/api/contacts/contacts', {version: state.version, fields: {name: 'Competing contact'}});
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog.locator('[data-contacts-notice]')).toContainText(/changed|reload/i);
  await expect(dialog.getByLabel('Company', {exact: true})).toHaveValue('Conflict Company');
  await expect(dialog.getByLabel('ABN/ACN', {exact: true})).toHaveValue('Keep this draft');
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  assert.equal(await page.evaluate(() => window.cancelledAccount), null);
  assert.deepEqual(await page.evaluate(() => window.CeasefireProject.context()), context);

  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => { window.mobileAccount = window.ClassifireContacts.createAccount({company: 'Mobile Company'}); });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Save', exact: true})).toBeEnabled();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  assert.ok(bounds.height <= 844 * 0.85 + 2, JSON.stringify(bounds));
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await page.screenshot({path: path.join(output, 'account-dialog-mobile.png')});
  await page.evaluate(() => window.CeasefireI18n.setLanguage('es', false));
  const translatedDialog = page.getByRole('dialog', {name: 'Nueva cuenta', exact: true});
  await expect(translatedDialog).toBeVisible();
  await expect(translatedDialog.getByRole('heading', {name: 'Registros vinculados'})).toBeVisible();
  await expect(translatedDialog.locator('input[name="company"]')).toHaveValue('Mobile Company');
  await expect(translatedDialog.getByRole('checkbox', {name: /Vincular Link Person · New Company/})).toBeVisible();
  await translatedDialog.press('Escape');
  assert.equal(await page.evaluate(() => window.mobileAccount), null);
  assert.deepEqual(errors, []);
  console.log('Account links and standalone creation browser acceptance passed.');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); server.kill(); });
