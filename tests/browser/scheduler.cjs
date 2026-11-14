// Exercise the actual Scheduler UI and server using a disposable application.
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `scheduler-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output,'--real-auth'], {cwd:root,windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data',value => logs += value);
const ready = new Promise((resolve,reject) => {
  let data = '';
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data',value => {data += value; if (data.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);
  server.once('exit',code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}`));});
});
const errors = [], csp = [], checks = [];
const password = 'Disposable-QA-password-2026';
async function scheduler() {
  // The hidden Scheduler can already contain a calendar. Wait for the state
  // refresh triggered by navigation before inspecting the replacement controls.
  const previous=await page.locator('.scheduler-tabs').elementHandles();
  const refreshed=page.waitForResponse(response=>response.url().includes('/api/scheduler/state?') && response.ok());
  await page.locator('#scheduler-navigation').click();
  await (await refreshed).finished();
  if (previous.length) await page.waitForFunction(nav=>!nav.isConnected,previous[0]);
  await expect(page.locator('#scheduler-root')).toBeVisible();
}
async function tab(name) {
  const control=page.locator('.scheduler-tabs').getByRole('button',{name,exact:true});
  if(name==='Settings') {
    await expect(control).toHaveAttribute('title','Settings');
    await expect(control.locator('svg')).toHaveCount(1);
  }
  await control.click();
}
async function openAdd(label) {
  const action=page.getByRole('button',{name:label,exact:true});
  for (const width of [1915,631,390]) {
    await page.setViewportSize({width,height:970});
    await expect(action).toHaveText('+'); await expect(action).toHaveAttribute('title',label);
    const box=await action.boundingBox();
    assert.ok(box.width>=44 && box.width===box.height && box.x>=0 && box.x+box.width<=width);
    assert.equal(await action.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(208, 0, 27)');
  }
  await page.setViewportSize({width:1915,height:970}); await action.click();
}
async function submit(name) {await page.locator('dialog[open]').getByRole('button',{name,exact:true}).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);}
async function api(route) {return page.evaluate(async route => {const response = await fetch('/api/scheduler'+route); return response.json();},route);}
function readSchedulerClock(clock, timezone) {
  const timestamp=Date.parse(clock.dateTime);
  // A hidden Scheduler render can create its <time> before the first visible
  // tick. Poll that actual readiness state without throwing from Intl.format.
  if(!Number.isFinite(timestamp))return null;
  const date=new Date(timestamp);
  if(date.toISOString()!==clock.dateTime)return null;
  const display=new Intl.DateTimeFormat('en-AU',{timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);
  return clock.textContent===display+' · '+timezone ? {timestamp,text:clock.textContent} : null;
}
// Boundary fixtures keep the read guard strict: empty/malformed clocks and
// incorrect zone text are unready; a real UTC instant remains observable.
assert.equal(readSchedulerClock({dateTime:'',textContent:''},'UTC'),null);
assert.equal(readSchedulerClock({dateTime:'invalid',textContent:'00:00:00 · UTC'},'UTC'),null);
assert.equal(readSchedulerClock({dateTime:'2026-11-08T00:00:00.000Z',textContent:'00:00:00 · Asia/Kathmandu'},'UTC'),null);
assert.deepEqual(readSchedulerClock({dateTime:'2026-11-08T00:00:00.000Z',textContent:'00:00:00 · UTC'},'UTC'),{timestamp:Date.UTC(2026,10,8),text:'00:00:00 · UTC'});
(async () => {
  const info = await ready; assert.notEqual(info.port,8765);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1575,height:884},permissions:['geolocation'],geolocation:{latitude:-33.8688,longitude:151.2093,accuracy:10}});
  page = await context.newPage();
  // Street imagery is mocked: these tests never send even synthetic coordinates to OSM.
  await page.route('**/api/scheduler/map-tile?*',route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"Offline map fixture"}'}));
  page.setDefaultTimeout(15000);
  page.on('pageerror',error => errors.push(error.message));
  await page.exposeFunction('captureSchedulerCsp',directive => csp.push(directive));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation',event => window.captureSchedulerCsp(event.effectiveDirective)));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  let releaseProjects, projectRequests = 0, projectsDelivered = false;
  const projectGate = new Promise(resolve => {releaseProjects = resolve;});
  await page.route('**/api/scheduler/work-orders?offset=*',async route => {
    projectRequests++;
    const response = await route.fetch();
    await projectGate;
    await route.fulfill({response});
    projectsDelivered = true;
  });
  await expect(page.getByLabel('Name',{exact:true})).toBeVisible({timeout:2500});
  assert.equal(projectRequests,0,'Work Order choices are not requested before staff sign in');
  await page.getByLabel('Name',{exact:true}).fill('Scheduler Admin');
  await page.getByLabel('Email',{exact:true}).fill('scheduler-admin@example.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create administrator account'}).click();
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await scheduler();
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  const previousViewport=page.viewportSize(),tabs=page.locator('.scheduler-tabs');
  await expect(tabs).toHaveCSS('background-color','rgb(9, 11, 14)');
  for(const width of [1254,320]){
    await page.setViewportSize({width,height:900});
    const gear=tabs.getByRole('button',{name:'Settings',exact:true});
    await tabs.getByRole('button',{name:'Team members',exact:true}).focus();await page.keyboard.press('Tab');
    await expect(gear).toBeFocused();
    await expect(gear).toBeInViewport({ratio:0.99});
    await expect(tabs).toHaveCSS('box-shadow',/0px 1px 0px 0px/);
    await expect(tabs.locator('[aria-pressed=true]')).toHaveCSS('border-bottom-color','rgb(255, 255, 255)');
    await expect.poll(()=>page.evaluate(()=>{
      const nav=document.querySelector('.scheduler-tabs');
      return nav ? Math.abs(nav.getBoundingClientRect().right-nav.lastElementChild.getBoundingClientRect().right) : null;
    })).toBeLessThan(1);
    await page.screenshot({path:path.join(output,'scheduler-tab-rule-'+width+'.png')});
  }
  await page.setViewportSize(previousViewport);checks.push('Scheduler underline ends at the settings gear on desktop and after keyboard scrolling on mobile');
  assert.ok((await context.cookies()).some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict'));
  checks.push('administrator setup through UI with HttpOnly session');
  await tab('Team members');
  await openAdd('Add team member');
  let modal = page.locator('dialog[open]');
  await modal.getByLabel('Name',{exact:true}).fill('Jordan QA');
  assert.equal(projectRequests,1,'Overlapping Scheduler activation shares one background Work Order request');
  releaseProjects();
  await expect.poll(() => projectsDelivered).toBe(true);
  await expect(modal.getByLabel('Name',{exact:true})).toHaveValue('Jordan QA');
  await page.unroute('**/api/scheduler/work-orders?offset=*');
  checks.push('Work Order listing requires sign-in and does not delay the calendar and late choices preserve the open form');
  await modal.getByLabel('Email / sign-in').fill('jordan@example.test');
  await modal.getByLabel('Password',{exact:true}).fill(password);
  await modal.getByLabel('Base hourly rate (AUD)').fill('40');
  await submit('Save member');
  await expect(page.locator('.scheduler-team')).toContainText('Jordan QA');
  checks.push('create team member and saved base rate');
  await tab('Schedule');
  await page.getByLabel('Week containing date').fill('2026-11-02');
  await page.getByLabel('Week containing date').press('Tab');
  await openAdd('Add shift');
  modal = page.locator('dialog[open]');
  const palette=modal.getByRole('radiogroup',{name:'Colour'});
  for(const name of ['Blue','Red','Green','Purple','Grey']) await expect(palette.getByRole('radio',{name,exact:true})).toHaveCount(1);
  await expect(palette.getByRole('radio',{name:'Blue'})).toBeChecked();
  await expect(modal.getByRole('checkbox',{name:'Published'})).toHaveCount(0);
  await modal.getByRole('button',{name:'Create draft',exact:true}).click();
  assert.equal(await modal.getByLabel('Title',{exact:true}).evaluate(n=>n.validity.valueMissing),true);
  await expect(modal).toBeVisible();
  await modal.getByLabel('Title',{exact:true}).fill('Site installation');
  await modal.getByLabel('Start',{exact:true}).fill('2026-11-02T07:00');
  await modal.getByLabel('End',{exact:true}).fill('2026-11-02T15:30');
  await modal.getByLabel('Jordan QA',{exact:true}).check();
  await palette.getByRole('radio',{name:'Blue'}).focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect(palette.getByRole('radio',{name:'Green'})).toBeChecked();
  await expect(palette.locator('input:checked + .scheduler-colour-swatch .scheduler-colour-check')).toBeVisible();
  await modal.getByLabel('Location',{exact:true}).fill('Sydney site');
  for(const width of [1915,631,390]) {
    await page.setViewportSize({width,height:970});
    const primary=modal.getByRole('button',{name:'Publish shift',exact:true}), draft=modal.getByRole('button',{name:'Create draft',exact:true});
    assert.deepEqual(await modal.locator('.scheduler-dialog-actions>button').allTextContents(),['Cancel','Create draft','Publish shift']);
    const p=await primary.boundingBox(),d=await draft.boundingBox(),c=await modal.getByRole('button',{name:'Cancel',exact:true}).boundingBox();
    const precedes=(a,b)=>a.y<b.y || Math.abs(a.y-b.y)<1 && a.x<b.x;
    assert.ok(precedes(c,d)&&precedes(d,p),'Draft lies between Cancel and Publish in responsive reading order');
    assert.equal(await primary.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(208, 0, 27)');
    assert.ok(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Shift form fits on screen');
    await page.screenshot({path:path.join(output,`shift-editor-${width}.png`)});
  }
  await page.setViewportSize({width:1915,height:970});
  let releaseSave;
  await page.route('**/api/scheduler/shifts/save',async route => {
    const response = await route.fetch();
    await new Promise(resolve => {releaseSave = resolve;});
    await route.fulfill({response});
  });
  await modal.getByRole('button',{name:'Create draft',exact:true}).click();
  await expect.poll(() => typeof releaseSave).toBe('function');
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
  await expect(modal.getByRole('button',{name:'Publish shift',exact:true})).toBeDisabled();
  releaseSave();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.unroute('**/api/scheduler/shifts/save');
  await expect(page.locator('.scheduler-shift')).toContainText('Draft');
  const draftStyle=()=>page.locator('.scheduler-shift').evaluate(node=>{if(!node.isConnected)return null;const css=getComputedStyle(node);return {background:css.backgroundColor,border:css.borderTopColor,width:css.borderTopWidth,style:css.borderTopStyle,text:css.color};});
  await expect.poll(draftStyle,{timeout:30000}).toEqual({background:'rgb(255, 255, 255)',border:'rgb(23, 115, 73)',width:'4px',style:'solid',text:'rgb(23, 33, 43)'});
  const staff=await browser.newContext(), staffApi='http://127.0.0.1:'+info.port+'/api/scheduler';
  const stateWeek='/state?start=2026-11-02&end=2026-11-09';
  assert.equal((await staff.request.post(staffApi+'/login',{data:{email:'jordan@example.test',password}})).status(),200);
  const staffShifts=async()=>(await (await staff.request.get(staffApi+stateWeek)).json()).shifts;
  assert.deepEqual(await staffShifts(),[]);
  const [draftShift]=(await api(stateWeek)).shifts;
  assert.equal(draftShift.published,false);assert.equal(draftShift.color,'#177349');
  await page.locator('.scheduler-shift').click();
  await expect(palette.getByRole('radio',{name:'Green'})).toBeChecked();
  await modal.getByLabel('Title',{exact:true}).press('Enter');
  await modal.locator('form').evaluate(form=>form.requestSubmit());
  await expect(modal).toBeVisible();
  assert.equal((await api(stateWeek)).shifts[0].version,draftShift.version);
  assert.deepEqual(await staffShifts(),[]);
  await modal.getByRole('button',{name:'Publish shift',exact:true}).press('Enter');
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.scheduler-shift')).not.toContainText('Draft');
  assert.equal(await page.locator('.scheduler-shift').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(23, 115, 73)');
  const [published]=await staffShifts();
  assert.equal(published.id,draftShift.id);assert.equal(published.version,draftShift.version+1);assert.equal(published.published,true);
  await page.locator('.scheduler-shift').click(); await submit('Cancel');
  assert.equal((await staffShifts())[0].version,published.version);
  await page.locator('.scheduler-shift').click();
  await modal.getByRole('button',{name:'Create draft',exact:true}).press('Space');
  await expect(modal).toHaveCount(0);
  assert.equal((await api(stateWeek)).shifts.length,1);assert.deepEqual(await staffShifts(),[]);
  await page.locator('.scheduler-shift').click(); await submit('Publish shift');
  const [republished]=await staffShifts();assert.equal(republished.id,draftShift.id);
  // A different manager can change this record while the drawer is open. A stale
  // draft action must not withdraw their published shift or replace its custom colour.
  await page.locator('.scheduler-shift').click();
  const {id,version,title,start,end,member_ids,location,notes,published:visible}=republished;
  const edited=await context.request.post(staffApi+'/shifts/save',{data:{id,version,title,start,end,
    member_ids,location,notes,published:visible,color:'#648A79'}});
  assert.equal(edited.status(),200,await edited.text());
  await modal.getByRole('button',{name:'Create draft',exact:true}).click();
  await expect(modal.getByRole('alert')).toContainText('changed in another session');
  assert.equal((await staffShifts())[0].color,'#648A79');
  await submit('Cancel');
  await page.evaluate(()=>window.CeasefireScheduler.activate());
  await page.locator('.scheduler-shift').click();
  await expect(palette.getByRole('radio',{name:'Current colour'})).toBeChecked();
  await modal.getByLabel('Notes',{exact:true}).fill('An unrelated note');
  await submit('Publish shift');
  const [preserved]=await staffShifts();
  assert.equal(preserved.id,id);assert.equal(preserved.color,'#648A79');assert.equal(preserved.notes,'An unrelated note');
  assert.equal(await page.locator('.scheduler-shift').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(23, 103, 178)','Published custom colours retain their previous fallback rendering');
  await page.locator('.scheduler-shift').click();await submit('Create draft');
  const customDraft=()=>page.locator('.scheduler-shift').evaluate(node=>{if(!node.isConnected)return null;const css=getComputedStyle(node);return [css.backgroundColor,css.borderTopColor,css.borderTopWidth];});
  await expect.poll(customDraft,{timeout:30000}).toEqual(['rgb(255, 255, 255)','rgb(100, 138, 121)','4px']);
  await page.locator('.scheduler-shift').click();await submit('Publish shift');
  await staff.close();
  checks.push('draft and published states on the same shift control visibility for assigned staff; cancel preserves the version');
  for (const width of [1575,390]) {
    await page.setViewportSize({width,height:1000});
    await page.screenshot({path:path.join(output,`schedule-${width}.png`),fullPage:true});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth+2),'Grid scrolls inside the page at each viewport');
  }
  await page.setViewportSize({width:1575,height:884});
  await tab('Time entries');
  await openAdd('Add time entry');
  modal = page.locator('dialog[open]');
  await modal.getByLabel('Team member',{exact:true}).selectOption({label:'Jordan QA'});
  await modal.getByLabel('Start',{exact:true}).fill('2026-11-02T07:00');
  await modal.getByLabel('Finish',{exact:true}).fill('2026-11-02T19:00');
  await expect(modal.getByRole('button',{name:'Save time entry',exact:true})).toHaveCSS('background-color','rgb(208, 0, 27)');
  await submit('Save time entry');
  await expect(page.locator('.scheduler-payroll')).toContainText('$600.00');
  await page.locator('.scheduler-payroll summary').click();
  await expect(page.locator('.scheduler-payroll')).toContainText('2×');
  checks.push('manual 12-hour entry gives eight ordinary, two 1.5x, two 2x hours and $600 total');
  await tab('Reports');
  const reports=page.locator('.scheduler-reports');
  await expect(reports.getByRole('heading',{name:'Payroll Report'})).toBeVisible();
  await reports.getByLabel('Team member',{exact:true}).selectOption({label:'Jordan QA'});
  const summary=reports.getByRole('table',{name:'Payroll hours'});
  await expect(summary.getByText('Total overtime',{exact:true}).locator('..')).toContainText('4.00');
  await expect(reports.getByLabel('Start date',{exact:true})).toHaveValue('02:11:26');
  await expect(reports.getByLabel('End date',{exact:true})).toHaveValue('08:11:26');
  await expect(reports).toContainText('02:11:26 – 08:11:26');
  await expect(reports.getByRole('img',{name:'Regular vs overtime',exact:true})).toBeVisible();
  await expect(reports.locator('.scheduler-report-pie path')).toHaveCount(2);
  await expect(reports.locator('.scheduler-report-legend li').filter({hasText:'Regular'})).toContainText('66.7%8h 00m');
  const rules=['Daily overtime after 8 hours (1.5×)','Daily overtime after 10 hours (2×)'];
  for (const rule of rules) {
    await expect(summary.getByText(rule,{exact:true}).locator('..')).toContainText('2.00');
  }
  const memberRegular=reports.locator('.scheduler-member-rates .pay-regular');
  await expect(memberRegular).toHaveText('8.00'); await expect(memberRegular).toHaveAttribute('title','Regular · 8h 00m');
  await memberRegular.focus();
  assert.equal(await memberRegular.evaluate(el=>getComputedStyle(el,'::after').content),'"Regular · 8h 00m"');
  await reports.locator('.scheduler-report-detail summary').click();
  await expect(reports.getByText('Daily total',{exact:true})).toHaveCSS('background-color','rgb(185, 10, 21)');
  await expect(reports.getByRole('cell',{name:'02:11:26 07:00+11:00',exact:true})).toBeVisible();
  for (const rule of rules) {
    await expect(reports.getByRole('columnheader',{name:rule,exact:true})).toHaveCSS('background-color','rgb(255, 255, 255)');
  }
  const downloadPromise=page.waitForEvent('download');
  await reports.getByRole('button',{name:'Download CSV'}).click();
  const download=await downloadPromise, csvPath=path.join(output,download.suggestedFilename());
  await download.saveAs(csvPath);
  const csvLines=fs.readFileSync(csvPath,'utf8').trim().split('\r\n');
  assert.match(csvLines[1],/^"02:11:26".*Jordan QA.*02:11:26 07:00:00\+11:00.*02:11:26 19:00:00\+11:00/);
  assert.ok(csvLines[0].endsWith(rules.map(rule=>'"'+rule+' (hours)"').join(',')));
  assert.ok(csvLines[1].endsWith('"2.0000","2.0000"'));
  await reports.screenshot({path:path.join(output,'payroll-report.png')});
  await reports.getByRole('button',{name:'Project Report'}).click();
  await expect(reports.locator('.scheduler-report-chart')).toHaveCount(3);
  for (const name of ['Jobs','Projects','Team members']) await expect(reports.getByRole('img',{name,exact:true})).toBeVisible();
  await expect(reports.locator('.scheduler-report-chart').filter({has:page.getByRole('heading',{name:'Team members'})})).toContainText('Jordan QA100%12h 00m');
  await page.emulateMedia({media:'print'});await expect(reports.getByRole('heading',{name:'Project Report'})).toBeVisible();
  await expect(reports.getByRole('button',{name:'Run report'})).toBeHidden();await page.emulateMedia({media:'screen'});
  await reports.screenshot({path:path.join(output,'project-report.png')});
  checks.push('Recorded hours and configured overtime agree with the payroll report; project charts, CSV and readable print layout are available');
  await tab('Settings');
  const originalSettings=(await api('/state')).settings;
  const overtimePicker=page.getByRole('combobox',{name:'Overtime and penalty rules',exact:true});
  const breakPicker=page.getByRole('combobox',{name:'Break rules',exact:true});
  const visibleOvertimeName=page.locator('.scheduler-rule-editor:visible').getByLabel('Rule name',{exact:true});
  const visibleBreakName=page.locator('.scheduler-rule-editor:visible').getByLabel('Break name',{exact:true});
  const overtimeRule=originalSettings.overtime_rules.at(-1),breakRule=originalSettings.breaks.at(-1);
  await overtimePicker.selectOption(overtimeRule.id);
  await breakPicker.selectOption(breakRule.id);
  await expect(page.locator('.scheduler-rule-editor:visible')).toHaveCount(2);
  await expect(visibleOvertimeName).toHaveValue(overtimeRule.name);
  await expect(visibleBreakName).toHaveValue(breakRule.name);
  assert.equal(await page.evaluate(() => window.CeasefireScheduler.hasPendingOperation()),false,'Selecting a saved rule does not create unsaved settings');
  await tab('Schedule');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  checks.push('Settings gear keeps its accessible name; selecting overtime and break rules displays only those panes without unsaved changes');

  await tab('Settings');
  await page.getByLabel('Timesheet rounding',{exact:true}).selectOption('5');
  await visibleOvertimeName.fill('Unsaved overtime rule');
  await tab('Schedule');
  const settingsReview=page.getByRole('dialog',{name:'Discard unsaved Scheduler settings changes?',exact:true});
  await expect(settingsReview).toBeVisible();
  await expect(page.locator('.scheduler-settings')).toBeVisible();
  assert.equal(await page.evaluate(() => window.CeasefireScheduler.hasPendingOperation()),true);
  await settingsReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue('5');
  await expect(visibleOvertimeName).toHaveValue('Unsaved overtime rule');
  await tab('Schedule');
  await settingsReview.getByRole('button',{name:'Discard',exact:true}).click();
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  assert.equal(await page.evaluate(() => window.CeasefireScheduler.hasPendingOperation()),false);
  await tab('Settings');
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue(String(originalSettings.rounding_minutes));
  await expect(visibleOvertimeName).toHaveValue(overtimeRule.name);
  assert.equal((await api('/state')).settings.version,originalSettings.version,'Discarding navigation never writes settings');
  checks.push('Dirty internal Scheduler navigation asks to discard; Cancel preserves rounding and rule edits, Discard restores saved settings and changes tab');

  await page.getByLabel('Timesheet rounding',{exact:true}).selectOption('6');
  await page.locator('.nav-button[data-view="home"]').click();
  await expect(settingsReview).toBeVisible();
  await settingsReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#view-scheduler')).toBeVisible();
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue('6');
  await page.locator('.nav-button[data-view="home"]').click();
  await settingsReview.getByRole('button',{name:'Discard',exact:true}).click();
  await expect(page.locator('#view-home')).toBeVisible();
  assert.equal(await page.evaluate(() => window.CeasefireScheduler.hasPendingOperation()),false);
  await scheduler();
  await tab('Settings');
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue(String(originalSettings.rounding_minutes));
  checks.push('Global header navigation shares the settings discard dialog; Cancel stays on Scheduler and Discard opens the requested page');

  await page.getByLabel('Timesheet rounding',{exact:true}).selectOption('10');
  const settingsToggle=page.locator('#settings-navigation-toggle');
  const signOutChoice=page.locator('#settings-navigation-menu').getByRole('button',{name:'Sign out',exact:true});
  const signOutDialog=page.getByRole('dialog',{name:'Sign out',exact:true});
  await settingsToggle.hover();await signOutChoice.click();
  await expect(signOutDialog).toContainText('Scheduler Admin');
  await signOutDialog.getByRole('button',{name:'Close',exact:true}).click();await expect(settingsToggle).toBeFocused();
  await settingsToggle.press('ArrowUp');await expect(signOutChoice).toBeFocused();await signOutChoice.press('Enter');
  await signOutDialog.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(settingsReview).toBeVisible();
  await settingsReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(signOutDialog).toContainText('Scheduler Admin');
  await expect(signOutDialog.getByRole('button',{name:'Close',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(signOutDialog).toHaveCount(0);
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue('10');
  await page.getByRole('button',{name:'Discard settings changes',exact:true}).click();
  await expect(page.getByLabel('Timesheet rounding',{exact:true})).toHaveValue(String(originalSettings.rounding_minutes));
  checks.push('Cancelling sign-out preserves the signed-in account and settings draft');
  await page.getByLabel('Timesheet rounding',{exact:true}).selectOption('5');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(page.locator('.scheduler-notice')).toHaveText('Scheduler settings saved.');
  await tab('Schedule');
  const openClock = page.getByRole('button',{name:'Open time clock',exact:true});
  await expect(openClock).toBeHidden();
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await expect(page.locator('dialog[open]')).toContainText('Location is required');
  await submit('Clock in');
  await expect(page.locator('.scheduler-clock')).toContainText('You are clocked in');
  let model = await api('/state');
  const activeId = model.active_entry.id;
  await context.setGeolocation({latitude:-33.8688,longitude:151.2093,accuracy:10});
  await expect.poll(async () => (await api('/locations?entry_id='+activeId)).locations.length).toBeGreaterThan(0);
  assert.deepEqual(await page.evaluate(async()=>({secure:isSecureContext,allowed:document.featurePolicy.allowsFeature('geolocation'),permission:(await navigator.permissions.query({name:'geolocation'})).state})),{secure:true,allowed:true,permission:'granted'});
  const shiftPins=(await api('/locations?entry_id='+activeId)).locations.length;
  await expect(page.getByRole('button',{name:'Check location now'})).toHaveCount(0);
  assert.equal((await api('/locations?entry_id='+activeId)).locations.length,shiftPins);
  await page.reload();
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready);
  await scheduler();
  const clock=page.locator('.scheduler-clock');
  await expect(clock).toContainText('You are clocked in');
  await expect(clock).not.toContainText(/Location recording is (on|required)/);
  await expect(page.locator('#scheduler-root .scheduler-account')).toHaveCount(0);
  await expect(clock.locator('time')).toBeVisible();
  await expect(page.locator('#scheduler-root').getByRole('button',{name:'Sign out'})).toHaveCount(0);
  const controlGeometry=[];
  for (const width of [1915,943,390]) {
    await page.setViewportSize({width,height:884});
    const bounds = await clock.boundingBox();
    const navigation = await page.locator('.scheduler-tabs').boundingBox();
    const clockOutBox = await clock.getByRole('button',{name:'Clock out'}).boundingBox();
    const shownTime = await clock.locator('time').boundingBox();
    const tabs = await page.locator('.scheduler-tabs button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().height));
    const clockOut=(await clock.getByRole('button',{name:'Clock out',exact:true}).boundingBox()).height;
    const date=(await page.getByLabel('Week containing date').boundingBox()).height;
    const arrows=await page.locator('.scheduler-week-arrow').evaluateAll(buttons=>buttons.map(button=>{
      const box=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();
      return {size:icon.width,x:(icon.left+icon.right-box.left-box.right)/2,y:(icon.top+icon.bottom-box.top-box.bottom)/2};
    }));
    assert.deepEqual(tabs,[42,42,42,42,42]);assert.equal(clockOut,42);assert.equal(date,42);
    assert.deepEqual(arrows,[{size:22,x:0,y:0},{size:22,x:0,y:0}]);
    controlGeometry.push({width,tabs,clockOut,date,arrows});
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
    assert.ok(shownTime.y>=clockOutBox.y+clockOutBox.height);
    if (width===1915) {
      assert.ok(bounds.x>=navigation.x+navigation.width && bounds.x<width*0.4);
      assert.ok(bounds.y<=navigation.y && bounds.height<=172);
    }
    await page.screenshot({path:path.join(output,`active-clock-${width}.png`)});
  }
  await tab('Settings');
  await expect(page.getByRole('button',{name:'Save settings',exact:true})).toHaveCSS('height','42px');
  await tab('Schedule');
  fs.writeFileSync(path.join(output,'scheduler-control-geometry.json'),JSON.stringify({controlGeometry,saveSettings:42},null,2));
  await page.setViewportSize({width:1575,height:884});
  await page.locator('.nav-button[data-view="home"]').click();
  await expect(openClock).toBeVisible();
  const shortcutBounds = await openClock.boundingBox(), saveBounds = await page.locator('#save-current-project').boundingBox();
  assert.ok(shortcutBounds.x+shortcutBounds.width<=saveBounds.x && Math.abs(shortcutBounds.y-saveBounds.y)<1);
  await expect(openClock.locator('svg')).toHaveCount(1);
  await expect(page.locator('.scheduler-tracking-banner')).toHaveCount(0);
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await openClock.click();
  await expect(page.locator('#view-scheduler')).toBeVisible();
  await expect(clock).toBeFocused();
  await expect.poll(async()=>{
    const clockBounds=await clock.boundingBox(),headerBounds=await page.locator('.app-header').boundingBox();
    return Boolean(clockBounds && headerBounds && clockBounds.y>=headerBounds.y+headerBounds.height && clockBounds.y<884);
  },{message:'Open time clock scrolls the live clock below the header'}).toBe(true);
  await page.locator('#library-navigation-toggle').click();
  await page.locator('#pricing-scope').selectOption('library');
  const editedPrice=page.locator('#pricing-body [data-price-field="supplier_price"]').first();
  await editedPrice.fill('987.65');await editedPrice.press('Tab');
  await expect(page.locator('#pricing-status')).toHaveText('Unsaved pricing changes');
  await openClock.click();
  const pricingReview=page.getByRole('dialog',{name:'Unsaved Pricing Library',exact:true});
  await expect(pricingReview).toBeVisible();
  await pricingReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#library-pricing')).toBeVisible();
  await expect(editedPrice).toHaveValue('987.65');
  await openClock.click();await pricingReview.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.locator('#view-scheduler')).toBeVisible();await expect(clock).toBeFocused();
  checks.push('The clock fits the annotated desktop area and narrow screens. The active-shift icon beside Save opens and focuses it while respecting unsaved pricing edits.');
  const stateRoute = '**/api/scheduler/state*';
  const hideManualBreaks = async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.settings.breaks = data.settings.breaks.map(rule => ({...rule,manual:false}));
    await route.fulfill({response,json:data});
  };
  await page.route(stateRoute,hideManualBreaks);
  await page.reload(); await scheduler();
  await expect(page.getByRole('button',{name:'Clock out',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start break',exact:true})).toHaveCount(0);
  await page.unroute(stateRoute,hideManualBreaks);
  await page.reload(); await scheduler();
  await page.getByRole('button',{name:'Start break',exact:true}).click();
  await submit('Start break');
  await page.waitForTimeout(1200); // Stored clock timestamps have one-second precision.
  await page.getByRole('button',{name:'End break',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start break',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clock out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Clock in',exact:true})).toBeVisible();
  await expect(openClock).toBeHidden();
  await tab('Time entries');
  await page.getByRole('button',{name:/Locations for Scheduler Admin/}).first().click();
  await expect.poll(() => page.locator('.scheduler-location-map svg circle').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.scheduler-selected-location')).toContainText('-33.86880, 151.20930');
  await page.screenshot({path:path.join(output,'location-history.png'),fullPage:true});
  await page.locator('dialog[open]').getByRole('button',{name:'Close',exact:true}).click();
  checks.push('clock in, consented GPS pin, reload recovery, unpaid break, clock out and personal location history');
  await settingsToggle.hover();await page.locator('#settings-navigation-menu').getByRole('button',{name:'Settings',exact:true}).click();
  const zoneForm = page.locator('#organization-timezone-form');
  await expect(zoneForm.getByLabel('Organization time zone')).toHaveValue('Australia/Sydney');
  const touchContext=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844},storageState:await context.storageState()});
  const touchPage=await touchContext.newPage();await touchPage.goto(`http://127.0.0.1:${info.port}/`);
  await touchPage.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  const touchToggle=touchPage.locator('#settings-navigation-toggle'),touchMenu=touchPage.locator('#settings-navigation-menu');
  await touchToggle.tap();await expect(touchMenu).toBeVisible();await expect(touchPage.locator('#view-home')).toBeVisible();
  await touchMenu.getByRole('button',{name:'Sign out',exact:true}).tap();
  const touchDialog=touchPage.getByRole('dialog',{name:'Sign out',exact:true});await expect(touchDialog).toContainText('Scheduler Admin');
  await touchDialog.getByRole('button',{name:'Close',exact:true}).tap();
  await touchToggle.tap();await touchMenu.getByRole('button',{name:'Settings',exact:true}).tap();
  await expect(touchPage.locator('#view-settings')).toBeVisible();await touchContext.close();
  checks.push('Touch Settings opens the menu from Home, allows closing the account dialog, and navigates to the existing Settings page');
  await zoneForm.getByLabel('Organization time zone').selectOption('Asia/Kathmandu');
  await page.route('**/api/scheduler/state*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic Scheduler refresh failure'})}));
  await zoneForm.getByRole('button',{name:'Save'}).click();
  await expect(zoneForm.getByRole('status')).toContainText('Time zone saved. All team members use this time zone.');
  await page.unroute('**/api/scheduler/state*');
  await scheduler();
  let previousClock;
  await expect.poll(async () => {
    const value=await page.locator('#scheduler-local-time').evaluate(readSchedulerClock,'Asia/Kathmandu');
    if(value)previousClock=value;
    return Boolean(value);
  }).toBe(true);
  await expect.poll(async () => {
    const value=await page.locator('#scheduler-local-time').evaluate(readSchedulerClock,'Asia/Kathmandu');
    return Boolean(value && value.timestamp>previousClock.timestamp && value.text!==previousClock.text);
  }).toBe(true);
  const localized = await api('/state');
  assert.equal(localized.settings.timezone,'Asia/Kathmandu');
  assert.ok(localized.members.every(member=>member.timezone==='Asia/Kathmandu'));
  checks.push('Application Settings zone changes every team member and the live local clock with seconds');
  await settingsToggle.hover();await signOutChoice.click();
  await signOutDialog.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.locator('#staff-login').getByLabel('Email',{exact:true}).fill('jordan@example.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('#staff-portal-sign-out').click();await expect(signOutDialog).toContainText('Jordan QA');
  await signOutDialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.locator('.scheduler-tabs').getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);
  const denied = await page.evaluate(async id => (await fetch('/api/scheduler/locations?entry_id='+id)).status,activeId);
  assert.equal(denied,403);
  checks.push('worker sign-in hides admin controls and cannot read another member location history');
  assert.deepEqual(errors,[]); assert.deepEqual(csp,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors,csp},null,2));
  console.log(`PASS Scheduler UI, pay, clock, location privacy and responsive layout. ${output}`);
})().catch(async error => {console.error(error); console.error(errors); console.error(logs); if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); process.exitCode=1;})
.finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs); await browser?.close();server.kill();});
