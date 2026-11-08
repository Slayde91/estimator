// Contact links are selected from a disposable directory, never inferred by name.
const {chromium, expect: browserExpect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {openProjectSection, fillProjectDetails, clickProjectControl} = require('./project_actions.cjs');
const expect = browserExpect.configure({timeout:30000});
const root=path.resolve(__dirname,'../..'), output=path.join(root,'.runtime/browser-qa','contact-picker-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser;
server.stderr.on('data',chunk=>{logs+=chunk;});
const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(logs || 'Fixture startup timed out')),120000);
  server.once('error',error=>{clearTimeout(timer);reject(error);});
  server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+': '+logs));});
  server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});
});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1101,height:884}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(30000);
  const base=`http://127.0.0.1:${info.port}`;
  async function api(route,body){
    const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});
    const value=await response.json();assert.equal(response.status(),200,JSON.stringify(value));return value;
  }
  const directory=()=>api('/api/contacts/directory');
  async function create(fields){return api('/api/contacts/contacts',{version:(await directory()).version,fields});}
  const first=await create({name:'Alex Same',company:'Alpha Contact Company',phone:'111',email:'alpha@example.test'});
  const second=await create({name:'Alex Same',company:'Beta Contact Company',phone:'222',email:'beta@example.test'});
  const empty=await create({name:'Empty Details',company:'Empty Contact Company',phone:'',email:''});
  const idle=()=>page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);
  await page.goto(base+'/');await idle();
  await fillProjectDetails(page,{client:'Project Account', 'site-address':'1 Project Street'});
  await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();
  const original=await page.evaluate(()=>window.CeasefireProject.details()), baselineDirectory=await directory();
  const name=page.locator('#project-pane-contact-name'), phone=page.locator('#project-pane-contact-phone'), email=page.locator('#project-pane-contact-email');
  const options=page.locator('#project-contact-options');
  await name.focus();await name.fill('Alex');
  await expect(options.getByRole('option')).toHaveCount(2);
  await expect(options).toContainText('Alpha Contact Company');await expect(options).toContainText('Beta Contact Company');
  await options.getByRole('option',{name:'Alex Same · Beta Contact Company · 222 · beta@example.test',exact:true}).click();
  await expect(options).toBeHidden();await expect(phone).toHaveValue('222');await expect(email).toHaveValue('beta@example.test');
  let details=await page.evaluate(()=>window.CeasefireProject.details());
  assert.equal(details.contact_id,second.id);assert.equal(details.client,original.client);assert.equal(details.account_id,original.account_id);
  await phone.fill('Manual project phone');await email.fill('override@example.test');
  await page.locator('#project-details-close').click();
  let response=page.waitForResponse(r=>r.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page,'Save');const firstSaved=await response;assert.equal(firstSaved.status(),200,await firstSaved.text());await idle();
  let saved=JSON.parse(fs.readFileSync(info.project));
  assert.equal(saved.estimate.contact_id,second.id);assert.equal(saved.estimate.contact_phone,'Manual project phone');
  await page.reload();await idle();await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();
  await expect(name).toHaveValue('Alex Same');await expect(phone).toHaveValue('Manual project phone');await expect(email).toHaveValue('override@example.test');
  response=page.waitForResponse(r=>r.url().endsWith('/api/contacts/directory'));
  await name.focus();await response;await expect(options.getByRole('option')).toHaveCount(2);
  await name.press('Escape');await expect(options).toBeHidden();
  await expect(phone).toHaveValue('Manual project phone');assert.equal((await page.evaluate(()=>window.CeasefireProject.details())).contact_id,second.id);
  // Escape also cancels a popup whose directory lookup has not returned yet.
  await name.blur();let releaseEscape,enteredEscape,finishedEscape;
  const escapeHeld=new Promise(resolve=>{releaseEscape=resolve;}), escapeStarted=new Promise(resolve=>{enteredEscape=resolve;}), escapeCompleted=new Promise(resolve=>{finishedEscape=resolve;});
  await page.route('**/api/contacts/directory',async route=>{
    const value=await route.fetch();enteredEscape();await escapeHeld;
    try { await route.fulfill({response:value}); } finally { finishedEscape(); }
  });
  await name.focus();await escapeStarted;await name.press('Escape');releaseEscape();await escapeCompleted;
  await page.unroute('**/api/contacts/directory');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(options).toBeHidden();await expect(phone).toHaveValue('Manual project phone');
  // Keyboard selection with empty source values clears the previous person's data.
  await name.fill('Empty');await name.focus();await expect(options.getByRole('option')).toHaveCount(1);
  await name.press('ArrowDown');await name.press('Enter');await expect(options).toBeHidden();
  await expect(name).toHaveValue('Empty Details');await expect(phone).toHaveValue('');await expect(email).toHaveValue('');
  assert.equal((await page.evaluate(()=>window.CeasefireProject.details())).contact_id,empty.id);
  await name.fill('Unlisted manual person');await phone.fill('Manual 9');
  assert.equal((await page.evaluate(()=>window.CeasefireProject.details())).contact_id,'');
  await page.locator('#project-details-close').click();
  response=page.waitForResponse(r=>r.url().endsWith('/api/project/save'));
  await clickProjectControl(page,'Save');const manualSaved=await response;assert.equal(manualSaved.status(),200,await manualSaved.text());await idle();
  saved=JSON.parse(fs.readFileSync(info.project));assert.equal(saved.estimate.contact_id,'');assert.equal(saved.estimate.contact_name,'Unlisted manual person');
  // Editing another saved project's Contact cannot alter the open draft/file.
  await page.locator('#link-project-folder').click();await idle();
  const secondPath=path.join(info.directory,'second-contact-project.cf.json');fs.copyFileSync(info.project,secondPath);
  await page.locator('#refresh-quotes').click();await idle();
  const listing=await api('/api/projects'), other=listing.files.find(file=>path.resolve(file.path)===path.resolve(secondPath));assert.ok(other);
  const before=fs.readFileSync(info.project), active=await page.evaluate(()=>window.CeasefireProject.details());
  const toggle=page.locator(`[data-project-details-id="${other.id}"]`);await toggle.click();await idle();
  await name.focus();await name.fill('Alex');await expect(options.getByRole('option')).toHaveCount(2);
  await options.getByRole('option',{name:'Alex Same · Alpha Contact Company · 111 · alpha@example.test',exact:true}).click();
  response=page.waitForResponse(r=>r.url().endsWith('/api/projects/details/save'));
  await page.locator('#project-details-save').click();const otherSaved=await response;assert.equal(otherSaved.status(),200,await otherSaved.text());await idle();
  assert.equal(JSON.parse(fs.readFileSync(secondPath)).estimate.contact_id,first.id);assert.deepEqual(fs.readFileSync(info.project),before);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.details()),active);
  // A rejected write retains the linked identity and overrides for review.
  await page.route('**/api/projects/details/save',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic revision conflict'})}));
  await phone.fill('Unsaved conflict phone');response=page.waitForResponse(r=>r.url().endsWith('/api/projects/details/save'));
  await page.locator('#project-details-save').click();assert.equal((await response).status(),409);await idle();
  await expect(phone).toHaveValue('Unsaved conflict phone');await expect(name).toHaveValue('Alex Same');
  await page.locator('#project-details-close').click();
  const discard=page.getByRole('dialog',{name:'Discard unsaved project details?',exact:true});await discard.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(phone).toHaveValue('Unsaved conflict phone');await page.locator('#project-details-close').click();await discard.getByRole('button',{name:'Yes',exact:true}).click();
  await page.unroute('**/api/projects/details/save');
  // A directory reply from a closed pane cannot populate the next pane.
  await toggle.click();await idle();let release,entered,finished;
  const held=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{entered=resolve;}), completed=new Promise(resolve=>{finished=resolve;});let requestCount=0;
  await page.route('**/api/contacts/directory',async route=>{
    if(++requestCount!==1){await route.continue();return;}
    const value=await route.fetch();const stale=await value.json();stale.contacts.push({id:'10000000-0000-0000-0000-000000000099',name:'Alex Stale Ghost',phone:'999',email:'ghost@example.test',company:'Stale Company'});
    entered();await held;
    try { await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stale)}); }
    finally { finished(); }
  });
  await name.focus();await started;await page.locator('#project-details-close').click();
  await page.locator('#project-current-details').click();await name.focus();await name.fill('Alex');
  await expect(options.getByRole('option')).toHaveCount(2);release();await completed;
  await page.unroute('**/api/contacts/directory');await expect(options).not.toContainText('Stale Ghost');await expect(phone).toHaveValue('Manual 9');
  await page.setViewportSize({width:390,height:844});
  await name.scrollIntoViewIfNeeded();
  const bounds=await options.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390,JSON.stringify(bounds));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(output,'contact-picker-mobile.png')});
  assert.deepEqual(await directory(),baselineDirectory);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({passed:true,checks:['duplicate names by stable ID','mouse and keyboard selection','phone/email defaults including blanks','manual overrides and legacy names','save/reload identity','other saved file isolation','revision failure and discard','closed-pane async isolation','directory unchanged','mobile bounds'],errors},null,2));
  console.log('Project Contact picker browser passed: '+output);
})().catch(error=>{console.error(error);console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
