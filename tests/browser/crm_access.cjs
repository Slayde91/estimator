'use strict';
// Test mandatory staff access and one-time provisioning on a disposable site.
const {chromium,expect}=require('@playwright/test'),{spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'.runtime/browser-qa','crm-access-'+Date.now());fs.mkdirSync(out,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',out,'--real-auth'],{cwd:root,windowsHide:true});
let logs='',text='',browser;server.stderr.on('data',x=>logs+=x);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',x=>{text+=x;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',x=>{clearTimeout(timer);reject(Error('Fixture exited '+x));});});
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);const base='http://127.0.0.1:'+info.port;
 browser=await chromium.launch({headless:true});const admin=await browser.newContext(),page=await admin.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(45000);
 async function post(context,route,data){let headers={};if(['/api/access/settings','/api/access/roles'].includes(route)){const session=await(await context.request.get(base+'/api/access/session')).json();if(session.user)headers={'X-CRM-Member':session.user.id};}const r=await context.request.post(base+route,{data,headers});assert.equal(r.status(),200,await r.text());return r.json();}
 await page.goto(base);await expect(page.getByRole('heading',{name:'Create administrator account'})).toBeVisible();
 for(const path of ['/api/bootstrap','/api/contacts/directory','/api/scheduler/organization','/api/projects']){
   assert.equal((await admin.request.get(base+path)).status(),401,path);
 }
 await page.getByLabel('Name',{exact:true}).fill('CRM Manager');
 await page.getByLabel('Email',{exact:true}).fill('manager@example.test');
 await page.getByLabel('Password',{exact:true}).fill('Fixture-manager-password');
 await page.getByRole('button',{name:'Create administrator account'}).click();
 await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 assert.equal((await admin.request.post(base+'/api/access/setup',{data:{name:'Second',email:'second@example.test',password:'Fixture-admin-password'}})).status(),409);
 const worker=await post(admin,'/api/scheduler/members/save',{name:'CRM Viewer',email:'viewer@example.test',password:'Fixture-viewer-password',role:'worker',active:true,base_rate:'0'});
 await post(admin,'/api/access/roles',{member_id:worker.id,role:'viewer',version:0});
 const identity=await(await admin.request.get(base+'/api/access/session')).json();
 assert.equal((await admin.request.post(base+'/api/access/settings',{headers:{'X-CRM-Member':identity.user.id},data:{enabled:false,version:identity.version}})).status(),403);
 await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 await page.locator('nav [data-view=settings]').click();const access=page.locator('#staff-access-settings');
 await expect(access.getByRole('heading',{name:'Staff access'})).toBeVisible();await expect(access).toContainText('CRM Manager');
 await expect(access.getByRole('checkbox')).toHaveCount(0);
 await expect(access.locator(':scope > button')).toHaveCount(0);
 await expect(access.getByRole('combobox',{name:'CRM Viewer CRM access'})).toHaveValue('viewer');
 await page.evaluate(()=>{
   const original=HTMLMediaElement.prototype.play;
   window.roleErrorBleeps=0;
   HTMLMediaElement.prototype.play=function(){
     if(this.src.endsWith('/sounds/radiobleep.mp3')){window.roleErrorBleeps++;return Promise.resolve();}
     return original.call(this);
   };
 });
 await page.route('**/api/access/roles',route=>route.fulfill({status:409,contentType:'application/json',
   body:JSON.stringify({error:'Synthetic role conflict'})}),{times:1});
 await access.getByRole('row').filter({hasText:'CRM Viewer'}).getByRole('button',{name:'Save'}).click();
 await expect(access.getByRole('status')).toHaveText('Synthetic role conflict');
 await expect.poll(()=>page.evaluate(()=>window.roleErrorBleeps)).toBe(1);
 assert.ok((await admin.cookies()).find(c=>c.name==='classifire_access').httpOnly);
 assert.ok(!await page.evaluate(()=>document.cookie.includes('classifire_access')));
 const saved=await page.evaluate(async()=>{const directory=await(await fetch('/api/contacts/directory')).json();const r=await fetch('/api/contacts/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:directory.version,fields:{company:'Named Access QA',billing_address:'',abn_acn:''}})});return {status:r.status,body:await r.json()};});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const directory=await(await admin.request.get(base+'/api/contacts/directory')).json();
 assert.ok(directory.accounts.some(item=>item.company==='Named Access QA'),'A real named write succeeds through the current-member guard');
 const reminder=await admin.request.post(base+'/api/contacts/leads',{headers:{'X-CRM-Member':identity.user.id},data:{
   version:directory.version,fields:{name:'View-only reminder',company:'Reminder QA',next_action:'Check site',follow_up_date:'2001-01-01'}}});
 assert.equal(reminder.status(),200,await reminder.text());
 await page.screenshot({path:path.join(out,'staff-settings.png'),fullPage:true});
 const viewers=await browser.newContext({viewport:{width:390,height:844}}),view=await viewers.newPage();view.setDefaultTimeout(45000);
 view.on('pageerror',e=>errors.push(e.message));const requests=[];
 view.on('response',r=>{if(r.status()>=400)requests.push({path:new URL(r.url()).pathname,status:r.status()});});
 await view.goto(base);await expect(view.getByRole('heading',{name:'Staff sign in'})).toBeVisible();
 await view.screenshot({path:path.join(out,'staff-signin-phone.png'),fullPage:true});
 assert.ok(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await view.getByLabel('Email',{exact:true}).fill('viewer@example.test');await view.getByLabel('Password',{exact:true}).fill('Fixture-viewer-password');
 await view.getByRole('button',{name:'Sign in',exact:true}).click();
 await view.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready,{timeout:45000});
 await expect(view.getByText('View-only access. An editor is required to save changes.',{exact:true})).toBeVisible();
 await view.locator('nav [data-view=contacts]').click();
 const due=view.getByRole('button',{name:'Follow-up due',exact:true});
 await due.click();
 const review=view.getByRole('dialog',{name:'Follow-up actions'});
 await expect(review.getByRole('textbox',{name:'Next action'})).toHaveValue('Check site');
 await expect(review.getByRole('textbox',{name:'Next action'})).not.toBeEditable();
 await expect(review.getByRole('combobox',{name:'Follow-up status'})).toBeDisabled();
 await expect(review.getByRole('button',{name:'Save',exact:true})).toHaveCount(0);
 await review.getByRole('button',{name:'Close',exact:true}).click();await expect(due).toBeFocused();
 const denied=await view.evaluate(async()=>{const r=await fetch('/api/contacts/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return {status:r.status,body:await r.json()};});
 assert.equal(denied.status,403);assert.match(denied.body.error,/view-only/);
 await post(admin,'/api/access/roles',{member_id:worker.id,role:'none',version:1});await view.reload();
 await expect(view.locator('#scheduler-root').getByRole('heading',{name:'Scheduler',exact:true})).toBeVisible();
 await view.locator('#staff-portal-sign-out').click();
 const signOut=view.getByRole('dialog',{name:'Sign out',exact:true});await expect(signOut).toContainText('CRM Viewer');
 await signOut.getByRole('button',{name:'Close',exact:true}).click();
 assert.equal((await viewers.request.get(base+'/api/contacts/directory')).status(),403);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,manager_id:identity.user.id,errors,viewer_responses:requests,checks:['first-run project data gate and one-time setup','mandatory sign-in without an opt-out control','real sign-in','HttpOnly root cookie','staff roles','viewer boot','server mutation denial','role revocation','phone layout']},null,2));console.log('PASS CRM access '+out);
})().catch(e=>{console.error(e);console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});

