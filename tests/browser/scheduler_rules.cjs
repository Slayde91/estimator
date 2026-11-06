// Real UI coverage for project selection, custom pay rules and automatic breaks.
const {chromium,expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..');
const output = path.join(root,'.runtime/browser-qa',`scheduler-rules-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'scheduler_rules_fixture.py'),output],{cwd:root,windowsHide:true});
let logs = '',browser,page;
server.stderr.on('data',value => {logs += value;});
const ready = new Promise((resolve,reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data',value => {text += value; if(text.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0]));}});
  server.once('error',reject); server.once('exit',code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`));});
});
const errors = [];
async function api(route,payload) {
  return page.evaluate(async ({route,payload}) => {
    const response = await fetch('/api/'+route,payload === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  },{route,payload});
}
async function tab(name) {await page.locator('.scheduler-tabs').getByRole('button',{name,exact:true}).click();}
async function submit(name) {await page.locator('dialog[open]').getByRole('button',{name,exact:true}).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);}
(async () => {
  const info = await ready; assert.notEqual(info.port,8765);
  browser = await chromium.launch({headless:true}); page = await browser.newPage({viewport:{width:1500,height:1000}});
  page.setDefaultTimeout(30000); page.on('pageerror',error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);

  await page.locator('#scheduler-navigation').click();
  await page.getByLabel('Your name',{exact:true}).fill('Rules Admin');
  await page.locator('#scheduler-root').getByLabel('Email',{exact:true}).fill('rules@example.test');
  await page.getByLabel('Password',{exact:true}).fill('Rules-password-2026');
  await page.getByRole('button',{name:'Create administrator account'}).click();
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await expect(page.locator('.scheduler-projects-status')).toContainText('1 Accepted projects available');
  const projects = (await api('projects')).body.files;
  const accepted = projects.find(item => item.project_status === 'Accepted');
  const draft = projects.find(item => item.project_status === 'Draft');
  await page.getByRole('button',{name:'Add shift',exact:true}).click();
  let modal = page.locator('dialog[open]');
  await expect(modal.getByLabel('Job / project reference').locator('option')).toHaveCount(2);
  await modal.getByLabel('Title',{exact:true}).fill('Accepted job');
  await modal.getByLabel('Job / project reference').selectOption(accepted.id);
  await expect(modal.getByLabel('Location',{exact:true})).toHaveValue('12 Site Street');
  await modal.getByLabel('Location',{exact:true}).fill('12 Site Street, gate B');
  await submit('Save shift');
  const denied = await api('scheduler/shifts/save',{title:'Blocked draft',project_id:draft.id,start:'2026-11-02T07:00',end:'2026-11-02T15:00'});
  assert.equal(denied.status,400);
  const worker = (await api('scheduler/members/save',{name:'Worker',email:'worker@example.test',password:'Worker-password-2026',base_rate:'40'})).body;
  const initial = (await api('scheduler/state')).body;
  assert.equal((await api('scheduler/settings',{...initial.settings,overtime_rules:[],breaks:[]})).status,200);
  await page.evaluate(() => window.CeasefireScheduler.activate());
  await tab('Settings');
  const settingsActions=page.locator('.scheduler-settings-actions');
  await expect(settingsActions.getByRole('button',{name:'Save settings',exact:true})).toBeVisible();
  const discard=settingsActions.getByRole('button',{name:'Discard settings changes',exact:true});
  await expect(discard).toHaveText('');await expect(discard.locator('svg path')).toHaveCount(4);
  assert.deepEqual(await discard.locator('svg path').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d'))),await page.locator('#penetration-clear svg path').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d'))));
  await page.getByRole('button',{name:'Add overtime rule',exact:true}).click();
  await page.getByLabel('Rule name',{exact:true}).fill('After six hours');
  await page.getByLabel('Start after hours',{exact:true}).fill('6');
  await page.getByLabel('Rate multiplier',{exact:true}).fill('2');
  await page.getByLabel('Pay item label',{exact:true}).fill('Custom double time');
  await page.getByRole('button',{name:'Add break rule',exact:true}).click();
  await page.getByLabel('Break name',{exact:true}).fill('Meal');
  await page.getByLabel('Short code',{exact:true}).fill('MEAL');
  await page.getByLabel('Apply breaks automatically',{exact:true}).check();
  await page.getByLabel('Repeat',{exact:true}).check();
  await page.getByLabel('End automatically when its set length is reached',{exact:true}).check();
  await page.getByLabel('Require the full break duration before ending',{exact:true}).check();
  await page.getByLabel('Notify minutes before break ends',{exact:true}).fill('5');
  await page.screenshot({path:path.join(output,'rule-settings-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+2));
  await page.screenshot({path:path.join(output,'rule-settings-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1500,height:1000});
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(page.locator('.scheduler-notice')).toHaveText('Scheduler settings saved.');
  await tab('Time entries');
  await page.getByLabel('Week containing date').fill('2026-11-02'); await page.getByLabel('Week containing date').press('Tab');
  await page.getByRole('button',{name:'Add time entry',exact:true}).click(); modal = page.locator('dialog[open]');
  const fieldOrder=await modal.locator('.scheduler-form-fields > label > span').allTextContents();
  assert.deepEqual(fieldOrder.slice(0,4),['Team member','Start','Job / project reference','Finish']);
  await modal.getByLabel('Team member',{exact:true}).selectOption(worker.id);
  await modal.getByLabel('Start',{exact:true}).fill('2026-11-02T07:00');
  await modal.getByLabel('Finish',{exact:true}).fill('2026-11-02T15:00');
  await submit('Save time entry');
  await expect(page.locator('.scheduler-payroll')).toContainText('$360.00');
  await page.locator('.scheduler-payroll summary').click();
  await expect(page.locator('.scheduler-payroll')).toContainText('Custom double time');
  await page.getByText('Break details',{exact:true}).first().click();
  await expect(page.locator('.scheduler-break-summary').first()).toContainText('automatic');
  const saved = (await api('scheduler/state?start=2026-11-02&end=2026-11-09')).body;
  assert.equal(saved.entries[0].effective_breaks.length,2);
  assert.equal(saved.entries[0].breaks.length,0);
  assert.equal(saved.shifts[0].location,'12 Site Street, gate B');
  await page.screenshot({path:path.join(output,'automatic-breaks-pay.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['Accepted-only project selection','site address default and custom location','custom overtime editor','automatic recurring break editor','minimum and auto-end settings','responsive rules','effective breaks and pay-item breakdown']},null,2));
  console.log(`PASS Scheduler custom rules and project choices. ${output}`);
})().catch(async error => {console.error(error); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(() => {}); fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`); process.exitCode = 1;})
  .finally(async () => {if(browser) await browser.close(); server.kill();});
