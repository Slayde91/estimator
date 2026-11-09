'use strict';
const {chromium,expect:baseExpect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','crm-activity-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let browser,page,stdout='',stderr='';
server.stderr.on('data',chunk=>stderr+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'Fixture timeout')),120000);
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});
  server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
(async()=>{
  const fixture=await ready;assert.notEqual(fixture.port,8765);const base='http://127.0.0.1:'+fixture.port;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const api=async(route,data)=>{const reply=data===undefined?await page.request.get(base+route):await page.request.post(base+route,{data});
    assert.equal(reply.status(),200,await reply.text());return reply.json();};
  const name='Case owner',email='staff@example.test',password='Synthetic-owner-password';
  await api('/api/scheduler/setup',{name,email,password});
  await api('/api/access/login',{email,password});
  const session=await api('/api/access/session');
  if(!session.enabled){
    const configured=await page.request.post(base+'/api/access/settings',{data:{enabled:true,version:session.version},headers:{'X-CRM-Member':session.user.id}});
    assert.equal(configured.status(),200,await configured.text());
  }
  assert.equal((await api('/api/access/session')).enabled,true);
  const staff=(await api('/api/contacts/staff')).staff;assert.equal(staff.length,1);assert.deepEqual(Object.keys(staff[0]).sort(),['id','name']);
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await page.locator('#contacts-navigation-toggle').click();const host=page.locator('#contacts-root');
  await host.getByRole('button',{name:'New Lead',exact:true}).click();let dialog=page.getByRole('dialog',{name:'New Lead',exact:true});
  await dialog.getByLabel('Name',{exact:true}).fill('Builder contact');await dialog.getByLabel('Company',{exact:true}).fill('Builder');
  await dialog.getByLabel('Region',{exact:true}).fill('Northern NSW');await dialog.getByLabel('Owner',{exact:true}).selectOption({label:name});
  await dialog.getByLabel('Status',{exact:true}).selectOption('Negotiating');await dialog.getByRole('button',{name:'Save',exact:true}).click();
  const card=host.locator('[data-status="Negotiating"] .project-kanban-card');await expect(card).toContainText('Northern NSW');await expect(card).toContainText(name);
  await card.getByRole('button',{name:'Builder contact',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Edit',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Edit Lead',exact:true});
  await dialog.locator('.crm-timeline > summary').click();const timeline=dialog.locator('.crm-timeline');
  await expect(timeline.locator('.crm-event-list')).toContainText('Created');
  await timeline.getByLabel('Activity type',{exact:true}).selectOption('Call');
  await timeline.getByLabel('Activity details',{exact:true}).fill('Discussed access times');
  await timeline.getByRole('button',{name:'Log activity',exact:true}).click();
  await expect(timeline.locator('.crm-event-list')).toContainText('Discussed access times');
  await timeline.getByLabel('Activity type',{exact:true}).selectOption('Task');
  await timeline.getByLabel('Activity details',{exact:true}).fill('Confirm site access');
  await timeline.getByLabel('Activity owner',{exact:true}).selectOption(staff[0].id);
  await timeline.getByLabel('Due date',{exact:true}).fill('2027-02-11');
  await timeline.getByRole('button',{name:'Log activity',exact:true}).click();
  const task=timeline.locator('.crm-event-list li').filter({hasText:'Confirm site access'});
  await expect(task).toContainText('2027-02-11');await task.getByRole('button',{name:'Complete task',exact:true}).click();
  await expect(task.getByRole('button')).toHaveCount(0);
  await dialog.getByLabel('Status',{exact:true}).selectOption('Won');await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(host.locator('[data-status="Won"] article')).toContainText('Builder contact');
  const dir=await api('/api/contacts/directory'),lead=dir.leads[0];
  assert.equal(lead.owner_id,staff[0].id);assert.ok(lead.last_interaction_at);assert.equal(lead.region,'Northern NSW');
  for(const [kind,id] of [['leads',lead.id],['accounts',lead.account_id],['contacts',lead.contact_id]]){
    const events=(await api('/api/contacts/activity?kind='+kind+'&id='+id)).events;
    for(const name of ['Call','Task','Task completed','Stage changed'])assert.ok(events.some(e=>e.event_type===name && e.actor_id===staff[0].id));
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,actor:name,stage:lead.status,checks:['owner/region','timestamped attributed activities','task due and completion','linked histories','stage without conversion']},null,2));
  console.log('PASS local CRM activity journal: '+output);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
  .finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),stderr);await browser?.close();server.kill();});
