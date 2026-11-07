// Exercise the Contacts directory with the full browser and a disposable server.
const {chromium, expect} = require('@playwright/test');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cwd = path.resolve(__dirname, '../..');
const tmp = path.join(cwd, '.runtime/browser-qa', 'contacts-' + Date.now());
fs.mkdirSync(tmp, {recursive: true});
const py = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(py, [path.join(__dirname, 'fixtures.py'), '--directory', tmp], {cwd, windowsHide: true});
let logs = '', stdout = '', browser;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error(logs || 'Fixture timed out')), 120000);
  server.once('error', error => { clearTimeout(timeout); reject(error); });
  server.once('exit', code => { clearTimeout(timeout); reject(Error('Fixture exited ' + code + ' ' + logs)); });
  server.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(stdout.split('\n')[0])); }
  });
});

(async () => {
  const {port} = await ready;
  assert.notEqual(port, 8765);
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1101, height: 884}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + port + '/');
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await page.locator('button[data-view="contacts"]').click();
  const root=page.locator('#contacts-root');
  await expect(root.getByRole('heading',{name:'Leads',exact:true})).toBeVisible();
  await root.getByRole('button',{name:'New Lead',exact:true}).click();
  const dlg=page.getByRole('dialog');
  await dlg.getByLabel('Name',{exact:true}).fill('Robin Sample');
  await dlg.getByLabel('Company',{exact:true}).fill('Sample Company');
  await dlg.getByLabel('Billing address').fill('Demo Billing Street');
  await dlg.getByRole('button',{name:'Save',exact:true}).click();
  const card=root.locator('.project-kanban-card').filter({hasText:'Robin Sample'});
  await expect(card).toBeVisible();
  await card.dragTo(root.locator('.project-kanban-column[data-status="Qualified"]'));
  await expect(root.locator('.project-kanban-column[data-status="Qualified"]')).toContainText('Robin Sample');
  await root.getByRole('button',{name:'Accounts',exact:true}).click();
  await root.getByRole('button',{name:'Sample Company',exact:true}).click();
  await expect(dlg.getByLabel('Billing address')).toHaveValue('Demo Billing Street');
  await dlg.getByRole('button',{name:'Robin Sample'}).click();
  await expect(dlg.getByLabel('Name',{exact:true})).toHaveValue('Robin Sample');
  await dlg.getByRole('button',{name:'Cancel'}).click();
  const doc=root.locator('.contacts-document');
  await doc.locator('summary').click();
  const download=page.waitForEvent('download');
  await doc.getByText('Export Template').click();
  const file=await download;
  if (!file.suggestedFilename().includes('Contacts-Template.xlsx')) throw Error(file.suggestedFilename());
  const template=path.join(tmp,'template.xlsx');
  await file.saveAs(template);
  execFileSync(py,['-c',"from openpyxl import load_workbook; import sys; book=load_workbook(sys.argv[1]); book.active.append(['Imported Sample','04080','Sample Company','Assistant','sample@example.test']); book.save(sys.argv[1])",template],{cwd,windowsHide:true});
  await doc.locator('summary').click();
  const fileChooser = page.waitForEvent('filechooser');
  await doc.getByRole('button',{name:'Import Template'}).click();
  await (await fileChooser).setFiles(template);
  await expect(root.getByRole('button',{name:'Imported Sample',exact:true})).toBeVisible();
  await root.getByRole('button',{name:'Accounts',exact:true}).click();
  await root.getByRole('button',{name:'Sample Company',exact:true}).click();
  await expect(dlg.getByRole('button',{name:'Imported Sample'})).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Contacts browser acceptance passed.');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); server.kill(); });
