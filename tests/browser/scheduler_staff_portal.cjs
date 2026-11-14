// Scheduler-only staff, using the global login and their own disposable workspace.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),folder=path.join(root,'.runtime/browser-qa','scheduler-staff-'+Date.now());
fs.mkdirSync(folder,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'scheduler_rules_fixture.py'),folder],{cwd:root,windowsHide:true});
let logs='',browser;server.stderr.on('data',d=>logs+=d);
const ready=new Promise((resolve,reject)=>{let buffer='';server.on('exit',()=>reject(Error(logs)));server.on('error',reject);
  server.stdout.on('data',d=>{buffer+=d;if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]));});});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const origin='http://127.0.0.1:'+info.port;
  browser=await chromium.launch({headless:true});const admin=await browser.newContext(),staff=await browser.newContext();
  async function post(ctx,route,data,headers={}){
    const res=await ctx.request.post(origin+route,{data,headers});assert.equal(res.status(),200,await res.text());return res.json();
  }
  const manager={name:'Scheduler admin',email:'scheduler-test@example.test',password:'Scheduler QA password'};
  const worker={name:'Site worker',email:'worker-test@example.test',password:'Worker QA password'};
  const user=(await post(admin,'/api/scheduler/setup',manager)).user;
  const member=await post(admin,'/api/scheduler/members/save',{...worker,role:'worker',active:true,base_rate:'0'});
  let listing;
  await expect.poll(async()=>{
    const response=await admin.request.get(origin+'/api/scheduler/work-orders');
    assert.equal(response.status(),200,await response.text());
    listing=await response.json();
    return listing.scan_pending;
  },{timeout:30000}).toBe(false);
  assert.equal(listing.error_count,0);
  assert.deepEqual(listing.orders.map(item=>[item.reference,item.status]),[['WO-02','In progress'],['WO-03','Completed'],['WO-04','Draft']]);
  const [order]=listing.orders;
  const zone=(await (await admin.request.get(origin+'/api/scheduler/bootstrap')).json()).timezone;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const base={start:today+'T09:00',end:today+'T10:00',work_order:{id:order.id,revision:order.revision}};
  for(const [employee,title] of [[member,'Worker installation'],[user,'Private admin work']]){
    await post(admin,'/api/scheduler/shifts/save',{...base,title,member_ids:[employee.id],published:true});
    await post(admin,'/api/scheduler/entries/save',{...base,member_id:employee.id,notes:title});
  }
  const credentials=person=>({email:person.email,password:person.password});
  await post(admin,'/api/access/login',credentials(manager));await post(admin,'/api/access/settings',{enabled:true,version:1},{'X-CRM-Member':user.id});
  await post(staff,'/api/access/login',credentials(worker));
  const page=await staff.newPage();await page.goto(origin);
  await expect(page.locator('.scheduler-shift')).toHaveCount(1);
  assert.deepEqual(await page.locator('.scheduler-tabs button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().height)),[42,42,42]);
  const title=page.locator('#staff-scheduler-page .workspace-title-row h1');
  for(const width of [1254,390,320]){
    await page.setViewportSize({width,height:884});
    await expect(title).toBeVisible();
    const box=await title.boundingBox();
    assert.equal(box.height,22);
    const header=await page.locator('.staff-portal-account').boundingBox();
    assert.equal(box.y,header.height+(width===320?8:18));
  }
  await page.setViewportSize({width:1254,height:884});
  await expect(page.locator('.scheduler-shift')).toContainText('Worker installation');
  await expect(page.locator('.scheduler-shift')).toContainText('WO-02');
  await page.getByRole('button',{name:'Time entries',exact:true}).click();
  const state=await (await staff.request.get(origin+'/api/scheduler/state')).json();
  assert.deepEqual(state.entries.map(x=>x.member_id),[member.id]);
  assert.equal(state.entries[0].work_order.document_id,order.document_id);
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Payroll Report'})).toBeVisible();
  await expect(page.locator('.scheduler-report-detail summary')).toContainText(member.name);
  await expect(page.locator('.scheduler-reports')).not.toContainText(user.name);
  const reports=page.locator('.scheduler-reports');
  await reports.getByRole('button',{name:'Project Report',exact:true}).click();
  await reports.getByLabel('Job',{exact:true}).selectOption({label:order.reference});
  const jobsChart=reports.locator('.scheduler-report-chart').filter({has:page.getByRole('heading',{name:'Jobs',exact:true})});
  await expect(jobsChart.getByRole('img',{name:'Jobs',exact:true})).toBeVisible();
  const selectedJob=jobsChart.getByRole('listitem').filter({hasText:order.reference});
  await expect(selectedJob).toContainText('100%');
  await reports.getByLabel('Reporting period',{exact:true}).selectOption('custom');
  await reports.getByLabel('Start date',{exact:true}).fill('2000-01-01');
  await reports.getByLabel('End date',{exact:true}).fill('2000-01-02');
  await reports.getByRole('button',{name:'Run report',exact:true}).click();
  await expect(reports.getByText('No completed time entries match these filters.')).toBeVisible();
  assert.equal((await staff.request.get(origin+'/api/contacts/directory')).status(),403);
  assert.equal((await staff.request.get(origin+'/api/scheduler/shift-site-contacts?'+new URLSearchParams({id:order.id,revision:order.revision}))).status(),403);
  assert.equal((await staff.request.post(origin+'/api/scheduler/shifts/save',{data:{...base,title:'Unauthorised'}})).status(),403);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Sign out',exact:true});
  await expect(dialog).toContainText(worker.name);
  await dialog.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.locator('#staff-login')).toBeVisible();
  assert.equal((await staff.request.get(origin+'/api/scheduler/work-orders')).status(),401);
  console.log('PASS Scheduler-only staff see their own published shifts and time, not other staff or CRM records; global logout clears access.');
})().catch(error=>{console.error(error,logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
