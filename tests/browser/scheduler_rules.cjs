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
  browser = await chromium.launch({headless:true}); page = await browser.newPage({viewport:{width:1500,height:1000},hasTouch:true});
  page.setDefaultTimeout(30000); page.on('pageerror',error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);

  await page.locator('#scheduler-navigation').click();
  await page.getByLabel('Your name',{exact:true}).fill('Rules Admin');
  await page.locator('#scheduler-root').getByLabel('Email',{exact:true}).fill('rules@example.test');
  await page.getByLabel('Password',{exact:true}).fill('Rules-password-2026');
  await page.getByRole('button',{name:'Create administrator account'}).click();
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    const chrome=await page.locator('.scheduler-tabs').evaluate(nav=>{
      const inactive=nav.querySelector('[aria-pressed="false"]');
      return {nav:getComputedStyle(nav).backgroundColor,background:getComputedStyle(inactive).backgroundColor,text:getComputedStyle(inactive).color};
    });
    assert.deepEqual(chrome,{nav:'rgb(9, 11, 14)',background:'rgba(0, 0, 0, 0)',text:'rgb(227, 231, 238)'},theme+' retains a readable scoped Scheduler navigation');
  }
  await page.screenshot({path:path.join(output,'scheduler-slate-navigation.png')});
  await page.evaluate(()=>{document.documentElement.dataset.theme='ceasefire';});
  await expect(page.locator('.scheduler-projects-status')).toContainText('1 Work Orders available');
  const projects = (await api('projects')).body.files;
  const [order] = (await api('scheduler/work-orders')).body.orders;
  assert.equal(order.status,'Draft');assert.equal(order.reference,'WO-02');
  const draft = projects.find(item => item.project_status === 'Draft');
  // Synthetic role-safe listing rows exercise list bounds and identical labels.
  // Only the genuine server-resolvable second row is ever assigned or saved.
  const copiedOrder={...order,id:'f'.repeat(64)+':'+order.project_id+':'+order.document_id};
  const manyOrders=[copiedOrder,order,...Array.from({length:84},(_,i)=>({...order,
    id:i.toString(16).padStart(64,'0')+':'+order.project_id+':'+order.document_id,
    reference:'WO-QA-'+i,client:'Other client '+i,site_address:'Other location'}))];
  await page.route('**/api/scheduler/work-orders?offset=*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({orders:manyOrders,matched:manyOrders.length,scan_pending:false,error_count:0})}));
  await page.getByRole('button',{name:'Refresh Work Order choices',exact:true}).click();
  await expect(page.locator('.scheduler-projects-status')).toHaveText('86 Work Orders available');
  await page.getByRole('button',{name:'Add shift',exact:true}).click();
  let modal = page.locator('dialog[open]');
  const orderSearch=modal.getByRole('combobox',{name:'Work Order',exact:true});
  await expect(orderSearch).toHaveAttribute('placeholder','Search Work Orders');
  const showChoices=modal.getByRole('button',{name:'Show Work Order choices',exact:true});
  await showChoices.click();await expect(orderSearch).toHaveAttribute('aria-expanded','true');
  const choices=modal.getByRole('listbox');await choices.scrollIntoViewIfNeeded();
  const scrollBox=await choices.boundingBox(),touch=await page.context().newCDPSession(page);
  const touchX=scrollBox.x+scrollBox.width/2,touchY=scrollBox.y+Math.min(scrollBox.height-15,150);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchX,y:touchY}]});
  for(const distance of [15,40,70,100])await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchX,y:touchY-distance}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>choices.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await expect(orderSearch).toHaveValue('');
  await expect(orderSearch).toHaveAttribute('aria-expanded','true');
  await choices.evaluate(node=>{node.scrollTop=0;});
  await modal.getByRole('option').nth(2).evaluate(node=>node.click());
  await expect(orderSearch).toHaveValue(/WO-02/);await expect(orderSearch).toHaveAttribute('aria-expanded','false');
  await orderSearch.fill('');
  await expect(modal.getByRole('option')).toHaveCount(80);
  await showChoices.click();await expect(orderSearch).toHaveAttribute('aria-expanded','false');
  await showChoices.click();await expect(orderSearch).toHaveAttribute('aria-expanded','true');
  await expect(modal.getByRole('status')).toHaveText('87 matches. Type more to narrow the list.');
  await orderSearch.fill('nothing matches');
  await expect(modal.getByRole('status')).toContainText('No matching Work Orders.');
  assert.equal(await orderSearch.evaluate(node=>node.validity.valid),false,'Typed text is not an assignment');
  await orderSearch.press('Escape');await expect(orderSearch).toHaveValue('');
  await modal.getByLabel('Title',{exact:true}).fill('Draft Work Order job');
  // The payroll assertions below use a fixed week. A new shift otherwise
  // defaults to today's date and falls outside that week as the clock advances.
  await modal.getByLabel('Start',{exact:true}).fill('2026-11-02T07:00');
  await modal.getByLabel('End',{exact:true}).fill('2026-11-02T15:00');
  await orderSearch.fill('Site Street');
  await expect(modal.getByRole('option')).toHaveCount(2);
  const duplicateLabels=await modal.getByRole('option').allTextContents();assert.equal(duplicateLabels[0],duplicateLabels[1]);
  for(const width of [1254,390]){
    await page.setViewportSize({width,height:884});
    const bounds=await modal.locator('.scheduler-order-choice').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    assert.ok(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.screenshot({path:path.join(output,'work-order-search-'+width+'.png')});
  }
  await page.setViewportSize({width:1500,height:1000});
  await orderSearch.press('ArrowDown');await orderSearch.press('ArrowDown');await orderSearch.press('Enter');
  await orderSearch.fill('Site Street');await modal.getByRole('option').nth(1).click();
  await orderSearch.fill('Site Street');
  const touchOption=modal.getByRole('option').nth(1);await touchOption.scrollIntoViewIfNeeded();
  const touchChoice=await touchOption.boundingBox();await page.touchscreen.tap(touchChoice.x+touchChoice.width/2,touchChoice.y+touchChoice.height/2);
  await expect(orderSearch).toHaveAttribute('aria-expanded','false');
  await expect(orderSearch).toHaveValue(/WO-02/);
  await expect(modal.getByLabel('Location',{exact:true})).toHaveValue('12 Site Street');
  await modal.getByLabel('Location',{exact:true}).fill('12 Site Street, gate B');
  await orderSearch.fill('unlisted text');
  await modal.getByRole('button',{name:'Publish shift',exact:true}).click();
  await expect(modal).toBeVisible();
  assert.equal(await orderSearch.evaluate(node=>node.validity.customError),true);
  assert.equal((await api('scheduler/state?start=2026-11-02&end=2026-11-09')).body.shifts.length,0);
  await orderSearch.press('Escape');await expect(orderSearch).toHaveValue(/WO-02/);
  const savingShift=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/scheduler/shifts/save'&&response.request().method()==='POST');
  await submit('Publish shift');
  const shiftResponse=await savingShift;assert.equal(shiftResponse.status(),200,await shiftResponse.text());
  const createdShift=await shiftResponse.json();
  assert.ok(createdShift.id);assert.equal(createdShift.work_order.id,order.id);assert.equal(createdShift.published,true);
  assert.equal(createdShift.work_order.revision,order.revision);assert.equal(createdShift.work_order.document_id,order.document_id);
  assert.equal(createdShift.location,'12 Site Street, gate B');
  // Clearing is deliberate but Cancel must retain the saved assignment.
  await page.getByLabel('Week containing date').fill('2026-11-02');await page.getByLabel('Week containing date').press('Tab');
  await page.locator('.scheduler-shift').click();await orderSearch.fill('');await submit('Cancel');
  assert.equal((await api('scheduler/state?start=2026-11-02&end=2026-11-09')).body.shifts[0].work_order.id,order.id);
  await page.unroute('**/api/scheduler/work-orders?offset=*');
  await page.route('**/api/scheduler/work-orders?offset=*',route=>route.fulfill({status:200,contentType:'application/json',body:'{"orders":[],"matched":0,"scan_pending":false,"error_count":0}'}));
  await page.getByRole('button',{name:'Refresh Work Order choices',exact:true}).click();
  await expect(page.locator('.scheduler-projects-status')).toHaveText('0 Work Orders available');
  await page.locator('.scheduler-shift').click();await expect(orderSearch).toHaveValue(/saved assignment/);
  const retainedSave=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/scheduler/shifts/save'&&request.method()==='POST');
  await submit('Publish shift');
  assert.ok(!Object.hasOwn((await retainedSave).postDataJSON(),'work_order'),'Unchanged saved/unavailable assignment is not replaced');
  assert.equal((await api('scheduler/state?start=2026-11-02&end=2026-11-09')).body.shifts[0].work_order.id,order.id);
  await page.unroute('**/api/scheduler/work-orders?offset=*');
  await page.getByRole('button',{name:'Refresh Work Order choices',exact:true}).click();
  await expect(page.locator('.scheduler-projects-status')).toHaveText('1 Work Orders available');
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
  assert.deepEqual(fieldOrder.slice(0,4),['Team member','Start','Work Order','Finish']);
  await modal.getByLabel('Team member',{exact:true}).selectOption(worker.id);
  await modal.getByLabel('Start',{exact:true}).fill('2026-11-02T07:00');
  await modal.getByLabel('Finish',{exact:true}).fill('2026-11-02T15:00');
  await submit('Save time entry');
  await expect(page.locator('.scheduler-payroll')).toContainText('$360.00');
  await page.locator('.scheduler-payroll summary').click();
  await expect(page.locator('.scheduler-payroll')).toContainText('Custom double time');
  await page.getByText('Break details',{exact:true}).first().click();
  await expect(page.locator('.scheduler-break-summary').first()).toContainText('automatic');
  const savedResponse=await api('scheduler/state?start=2026-11-02&end=2026-11-09');assert.equal(savedResponse.status,200);
  const saved=savedResponse.body;
  assert.equal(saved.entries[0].effective_breaks.length,2);
  assert.equal(saved.entries[0].breaks.length,0);
  assert.equal(saved.shifts.length,1);
  const savedShift=saved.shifts.find(shift=>shift.id===createdShift.id);
  assert.ok(savedShift,'The explicitly dated shift must be present in the fixed payroll week');
  for(const key of ['start','end','project_id','location'])assert.equal(savedShift[key],createdShift[key]);
  await page.screenshot({path:path.join(output,'automatic-breaks-pay.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['An unissued Work Order can be assigned from a Draft Project','exact chosen identity and revision despite identical labels','search bound80 and no-match validation','toggle, keyboard, assistive click and mouse selection','touch scrolling does not commit an assignment','saved assignment retained when source is absent from the listing','clear and Cancel preserve saved assignment','responsive search and dialog overflow','scoped readable dark navigation across five themes','site address default and custom location','explicit fixed-week dates and persisted shift receipt identity','custom overtime editor','automatic recurring break editor','minimum and auto-end settings','responsive rules','effective breaks and pay-item breakdown']},null,2));
  console.log(`PASS Scheduler custom rules and project choices. ${output}`);
})().catch(async error => {console.error(error); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(() => {}); fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`); process.exitCode = 1;})
  .finally(async () => {if(browser) await browser.close(); server.kill();});
