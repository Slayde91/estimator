// Standalone Account creation must retain the project and save links atomically.
const {chromium, expect: browserExpect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
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
  const linkedGroups = dialog.locator('.contacts-links');
  const search = dialog.getByLabel('Find records to link');
  const matching = dialog.locator('.contacts-link-search-results');
  await expect(dialog.getByRole('button', {name:'Save', exact:true})).toBeEnabled();
  await expect(linkedGroups.locator('input[type=checkbox]')).toHaveCount(0);
  await expect(linkedGroups).toHaveText('No linked records.');
  await expect(matching).toBeHidden();
  await search.fill('Link Person');
  const foundPerson = matching.getByRole('checkbox', {name: /Link Link Person/});
  await expect(foundPerson).toBeVisible();
  await search.press('ArrowDown');
  await expect(foundPerson).toBeFocused();
  await foundPerson.press('Space');
  await expect(foundPerson).toBeChecked();
  await expect(foundPerson).toBeFocused();
  const contactLink = linkedGroups.getByRole('checkbox', {name: /Link Link Person/});
  await expect(contactLink).toBeChecked();
  await expect(dialog).toContainText('Saving will move this contact from Original Company.');
  await search.fill(project.project_no);
  const foundProject = matching.getByRole('checkbox', {name: new RegExp('Link ' + project.project_no)});
  await foundProject.click();
  await expect(foundProject).toBeChecked();
  await expect(contactLink).toBeVisible();
  await foundProject.press('Escape');
  await expect(matching).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  // Unlinking removes the main row; searching permits checking it again.
  await contactLink.click();
  await expect(linkedGroups.locator('[data-link-group="contacts"]')).toHaveCount(0);
  await search.fill('Link Person');
  await expect(foundPerson).not.toBeChecked();
  await foundPerson.click();
  await expect(foundPerson).toBeChecked();
  await foundPerson.press('Escape');
  await search.fill('Does not match either selected record');
  await expect(matching).toContainText('No matching records.');
  await search.press('Escape');
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

  // Refresh retires obsolete automatic links without inventing manual ones.
  state = await directory();
  const sourceAccount=state.accounts.find(item=>item.company==='Source Company');
  await page.locator('#contacts-navigation-toggle').click();
  await page.locator('#contacts-root .contacts-tabs').getByRole('button',{name:'Accounts',exact:true}).click();
  await page.locator('#contacts-root').getByRole('button',{name:'Source Company',exact:true}).click();
  const sourceEditor=page.getByRole('dialog',{name:'Edit Account',exact:true});
  await expect(sourceEditor.locator('.contacts-links [data-link-group="projects"] input')).toBeDisabled();
  const projectFile=(await api('/api/projects')).files.find(item=>path.resolve(item.path)===path.resolve(project.path));
  async function primaryAccount(target) {
    const current=await api('/api/projects/details',{id:projectFile.id});
    await api('/api/projects/details/save',{id:projectFile.id,revision:current.revision,request_id:randomUUID(),
      details:{...current.details,client:target.company,account_id:target.id}});
    const response=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/contacts/account-links' && new URL(reply.url()).searchParams.get('id')===sourceAccount.id);
    await sourceEditor.getByRole('button',{name:'Refresh linked records',exact:true}).click();
    assert.equal((await response).status(),200);
    await expect(sourceEditor.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  }
  await primaryAccount(account);
  await expect(sourceEditor.locator('.contacts-links [data-link-group="projects"]')).toHaveCount(0);
  await sourceEditor.getByRole('button',{name:'Save',exact:true}).click();
  await expect(sourceEditor).toBeHidden();
  assert.equal((await api('/api/contacts/account-links?id='+sourceAccount.id)).linked.projects.length,0);
  // An explicit manual selection survives briefly becoming automatic and back.
  await page.locator('#contacts-root').getByRole('button',{name:'Source Company',exact:true}).click();
  await sourceEditor.getByLabel('Find records to link').fill(project.project_no);
  const sourceResult=sourceEditor.locator('.contacts-link-search-results').getByRole('checkbox',{name:new RegExp('Link '+project.project_no)});
  await sourceResult.click(); await expect(sourceResult).toBeChecked(); await sourceResult.press('Escape');
  await primaryAccount(sourceAccount);
  await expect(sourceEditor.locator('.contacts-links [data-link-group="projects"] input')).toBeDisabled();
  await primaryAccount(account);
  await expect(sourceEditor.locator('.contacts-links [data-link-group="projects"] input')).toBeEnabled();
  await expect(sourceEditor.locator('.contacts-links [data-link-group="projects"] input')).toBeChecked();
  await sourceEditor.getByRole('button',{name:'Save',exact:true}).click();
  await expect(sourceEditor).toBeHidden();
  assert.equal((await api('/api/contacts/account-links?id='+sourceAccount.id)).linked.projects[0].manual,true);

  // Missing saved links remain visible and selected, even when absent from search.
  await page.route('**/api/contacts/account-links?*', async route => {
    if (new URL(route.request().url()).searchParams.get('id') !== account.id) return route.continue();
    const response = await route.fetch(), catalog = await response.json();
    catalog.linked.projects = catalog.linked.projects.map(item => ({...item, available:false, automatic:false}));
    catalog.choices.projects = [];
    catalog.error_count = 1;
    catalog.errors = [{name:'Unavailable fixture project'}];
    await route.fulfill({response, json:catalog});
  });
  await page.locator('#contacts-root').getByRole('button',{name:'New Company',exact:true}).click();
  const edit = page.getByRole('dialog',{name:'Edit Account',exact:true});
  await expect(edit).toBeVisible();
  await expect(edit).toContainText('Unavailable saved record. Clear the selection to remove this link.');
  await expect(edit.locator('.contacts-links-group > summary')).toHaveText(['Contacts (1)','Projects (1)']);
  await edit.getByLabel('Find records to link').fill('No matching record');
  await expect(edit.locator('.contacts-link-search-results')).toContainText('No matching records.');
  await edit.getByLabel('Find records to link').press('Escape');
  await expect(edit.locator('.contacts-links [data-link-group="projects"] input')).toBeChecked();
  let retained;
  await page.route('**/api/contacts/accounts', async route => {
    retained=route.request().postDataJSON();
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Retry retained links'})});
  });
  await edit.getByRole('button',{name:'Save',exact:true}).click();
  await expect(edit).toContainText('Retry retained links');
  assert.deepEqual(retained.links.projects,[linked.linked.projects[0].id]);
  await expect(edit.locator('.contacts-links [data-link-group="projects"] input')).toBeChecked();
  await edit.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.unroute('**/api/contacts/account-links?*');
  await page.unroute('**/api/contacts/accounts');

  // A true competing directory write leaves the complete form draft visible.
  await page.evaluate(() => { window.cancelledAccount = window.ClassifireContacts.createAccount({company: 'Conflict Company'}); });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('ABN/ACN', {exact: true}).fill('Keep this draft');
  await expect(dialog.getByRole('button', {name: 'Save', exact: true})).toBeEnabled();
  await search.fill('Link Person');
  await foundPerson.click();
  await expect(foundPerson).toBeChecked();
  await foundPerson.press('Escape');
  state = await directory();
  await api('/api/contacts/contacts', {version: state.version, fields: {name: 'Competing contact'}});
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog.locator('[data-contacts-notice]')).toContainText(/changed|reload/i);
  await expect(dialog.getByLabel('Company', {exact: true})).toHaveValue('Conflict Company');
  await expect(dialog.getByLabel('ABN/ACN', {exact: true})).toHaveValue('Keep this draft');
  await expect(contactLink).toBeChecked();
  assert.equal((await directory()).contacts.find(item=>item.id===person.id).account_id,account.id);
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
  await search.fill('Link Person');
  await expect(foundPerson).toBeVisible();
  const popupBounds=await matching.boundingBox();
  assert.ok(popupBounds.x>=0 && popupBounds.x+popupBounds.width<=390,JSON.stringify(popupBounds));
  await page.screenshot({path: path.join(output, 'account-dialog-mobile.png')});
  await page.evaluate(() => window.CeasefireI18n.setLanguage('es', false));
  const translatedDialog = page.getByRole('dialog', {name: 'Nueva cuenta', exact: true});
  await expect(translatedDialog).toBeVisible();
  await expect(translatedDialog.getByRole('heading', {name: 'Registros vinculados'})).toBeVisible();
  await expect(translatedDialog.locator('input[name="company"]')).toHaveValue('Mobile Company');
  await expect(translatedDialog.getByRole('checkbox', {name: /Vincular Link Person · New Company/})).toBeVisible();
  await translatedDialog.locator('input[type=search]').press('Escape');
  await expect(translatedDialog).toBeVisible();
  await translatedDialog.press('Escape');
  assert.equal(await page.evaluate(() => window.mobileAccount), null);
  assert.deepEqual(errors, []);
  console.log('Account links and standalone creation browser acceptance passed. '+output);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); server.kill(); });
