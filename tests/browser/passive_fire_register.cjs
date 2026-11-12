const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createNewProject, openProjectSection} = require('./project_actions.cjs');

const root = path.resolve(__dirname,'../..');
const output = path.join(root,'.runtime/browser-qa','passive-fire-register-' + Date.now());
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',
  [path.join(__dirname,'project_documentation_fixture.py'),'--directory',output], {cwd:root,windowsHide:true});
let browser, page, log = '';
server.stderr.on('data',data => log += data);
const ready = new Promise((resolve,reject) => {
  let line = '';
  const timer = setTimeout(() => reject(Error('Fixture startup timed out')),120000);
  server.on('error',reject);
  server.on('exit',() => {clearTimeout(timer);reject(Error(log));});
  server.stdout.on('data',data => {
    line += data;
    if (line.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(line.split('\n')[0]));}
  });
});
const idle = () => page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready && !window.CeasefireDesktop.status().busy);
async function register() {
  await openProjectSection(page,'documentation');
  const button = page.locator('button[data-document-kind="passive_fire_register.pdf"]');
  await button.waitFor({state:'attached'});
  if (!await button.isVisible()) await page.locator('#documentation-pdf-rows').getByRole('button',{name:'Schedules',exact:true}).click();
  await expect(button).toHaveAccessibleName('Download Passive Fire Register');
  await expect(page.locator('tr[data-document-kind="passive_fire_register.pdf"] #cover-sheet-passive_fire_register')).toHaveCount(1);
  assert.equal(await button.locator('xpath=ancestor::tr/preceding-sibling::tr[1]').getAttribute('data-document-kind'),'firestopping.schedule.pdf');
  await button.click();
  await expect(page.locator('#view-passive-fire-register')).toBeVisible();
  await idle();
}
async function run() {
  const info = await ready;
  assert.notEqual(info.port,8765);
  browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.setDefaultTimeout(30000);
  await page.goto('http://127.0.0.1:' + info.port);
  await idle();
  await createNewProject(page,{client:'Synthetic fire register'});
  await register();
  const form = page.locator('#passive-register-root');
  await form.getByLabel('Level/Location').fill('North wall, Level 2');
  await form.getByLabel('Seal Type',{exact:true}).selectOption('Fire Seal');
  await form.getByLabel('FRL',{exact:true}).selectOption('-/120/120');
  await form.getByLabel('Substrate').selectOption('Masonry');
  await form.getByLabel('Orientation').selectOption('Vertical');
  await form.getByLabel('Installation Type').selectOption('Service Penetration');
  await form.getByLabel('Cable bundle',{exact:true}).check();
  await form.getByLabel('Fire Rated Batt',{exact:true}).check();
  await form.getByLabel('Manufacturer').selectOption('FIREFLY');
  await form.getByLabel('Report/Assessment').selectOption('Firefly Core Holes: FAS190236');
  await form.getByLabel('ID Number').fill('QA-01');
  const savedDraft = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save');
  await page.locator('#save-current-project').click();
  assert.equal((await savedDraft).status(),200);
  await idle();
  assert.equal(JSON.parse(fs.readFileSync(info.project)).passive_fire_register.entries[0].location,'North wall, Level 2');
  const access = form.getByLabel('Is the other side accessible?');
  await access.selectOption('No');
  await expect(form.getByLabel('Comments')).toBeVisible();
  await access.selectOption('Yes');
  await expect(form.getByRole('heading',{name:'Side 2'})).toBeVisible();
  await access.selectOption('NA');
  await expect(form.getByRole('heading',{name:'Side 2'})).toHaveCount(0);
  await form.getByLabel('Solution').selectOption('Topside only');
  for (const phase of ['Before Photo','During Photo','After Photo','Label Photo']) {
    const pixels = await page.evaluate(label => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 135;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c2ced2'; ctx.fillRect(0,0,400,135);
      ctx.fillStyle = '#1f2526'; ctx.font = '24px sans-serif'; ctx.fillText('Synthetic ' + label,20,80);
      return canvas.toDataURL('image/png').split(',')[1];
    },phase);
    await form.getByLabel(phase,{exact:true}).setInputFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from(pixels,'base64')});
    await expect(form.getByRole('img',{name:phase + ' 1',exact:true})).toBeVisible();
  }
  await form.getByRole('button',{name:'Insert signature'}).click();
  const pad = page.getByLabel('Signature drawing pad');
  const box = await pad.boundingBox();
  await page.mouse.move(box.x+10,box.y+30);
  await page.mouse.down(); await page.mouse.move(box.x+70,box.y+45,{steps:6}); await page.mouse.up();
  await page.getByRole('dialog').getByRole('button',{name:'Insert signature'}).click();
  await expect(form.getByRole('img',{name:'Signature',exact:true})).toBeVisible();
  const exportReceipt = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/passive-fire-register.pdf');
  await form.getByRole('button',{name:'Download PDF'}).click();
  const response = await exportReceipt;
  assert.equal(response.status(),200,await response.text());
  const receipt = await response.json();
  assert.equal(receipt.documentation.item.kind,'passive_fire_register.pdf');
  assert.equal(fs.readFileSync(receipt.path).subarray(0,5).toString(),'%PDF-');
  await idle();
  const savedFinal = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save');
  await page.locator('#save-current-project').click();
  assert.equal((await savedFinal).status(),200);
  assert.equal(JSON.parse(fs.readFileSync(info.project)).documentation.revision_count,1);
  await idle();
  await page.setViewportSize({width:390,height:884});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({path:path.join(output,'register-mobile.png')});
  await page.setViewportSize({width:1280,height:900});
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({file:'project-b.cf.json'}));
  await createNewProject(page,{client:'Synthetic second register'});
  await register();
  await expect(form.getByLabel('Level/Location')).toHaveValue('');
  await expect(form.getByRole('img')).toHaveCount(0);
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({file:'project-a.cf.json'}));
  await openProjectSection(page,'quotes');
  await page.locator('#load-project').click();
  await page.locator('#discard-dialog [value="confirm"]').click();
  await expect(page.locator('#client')).toHaveValue('Synthetic fire register');
  await idle(); await register();
  await expect(form.getByLabel('Level/Location')).toHaveValue('North wall, Level 2');
  await expect(form.getByRole('img')).toHaveCount(5);
  await form.getByRole('button',{name:'Add entry'}).click();
  await form.getByLabel('Level/Location').fill('South wall');
  await form.getByRole('button',{name:'Remove entry'}).click();
  await page.locator('#discard-dialog [value="confirm"]').click();
  await expect(form.getByLabel('Level/Location')).toHaveValue('North wall, Level 2');
  await page.screenshot({path:path.join(output,'register-desktop.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,pdf:receipt.path,project:info.project},null,2));
  console.log('PASS: portable draft, conditional evidence, signed PDF revision and project isolation. ' + output);
}
run().catch(async error => {
  console.error(error,log);
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); server.kill(); });
