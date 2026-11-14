const {checkRecordTrim}=require('./record_sidebar_trim.cjs');
'use strict';
// Real persisted Notes/Files and the existing Lead full-page edit contract.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','directory-record-workspaces-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page,releaseWrite,releaseRead;server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const checks=[],errors=[];
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);const base='http://127.0.0.1:'+fixture.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
 const api=async(route,body)=>{const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});assert.equal(response.status(),200,await response.text());return response.json();};
 let directory=await api('/api/contacts/directory');const created=await api('/api/contacts/leads',{version:directory.version,fields:{name:'Workspace Person',company:'Workspace Company',phone:'0400',email:'workspace@example.test',site_address:'Private fixture site'},region:'Retained legacy region'});
 directory=await api('/api/contacts/directory');const lead=directory.leads.find(item=>item.id===created.id),contact=directory.contacts.find(item=>item.id===lead.contact_id),account=directory.accounts.find(item=>item.id===lead.account_id);
 await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);await page.locator('#contacts-navigation-toggle').click();
 const host=page.locator('#contacts-root'),discard=page.locator('#discard-dialog');
 const open=async(kind,label)=>{await host.locator('.contacts-tabs').getByRole('button',{name:{accounts:'Companies',contacts:'Contacts',leads:'Leads'}[kind],exact:true}).click();await host.locator('.contacts-results').getByRole('button',{name:label,exact:true}).click();const pane=page.getByRole('complementary',{name:'Edit '+{accounts:'Company',contacts:'Contact',leads:'Lead'}[kind],exact:true});await expect(pane).toBeVisible();await expect(pane.getByRole('button',{name:'New note',exact:true})).toBeEnabled();return pane;};
 const owners=[['accounts',account.id,account.company],['contacts',contact.id,contact.name],['leads',lead.id,lead.name]];
 for(const [kind,id,label]of owners){
  let pane=await open(kind,label);const before=await api('/api/contacts/directory');
  await checkRecordTrim(page,pane,kind,output);
  const rail=pane.locator('.contacts-record-right'), refresh=pane.locator('.contacts-record-toolbar').getByRole('button',{name:'Refresh Records',exact:true});
  if(kind==='accounts'){
    await page.evaluate(()=>{
      const original=HTMLMediaElement.prototype.play;
      window.notificationSounds=0;
      HTMLMediaElement.prototype.play=function(){
        if(this.src.endsWith('/sounds/radiobleep.mp3')){window.notificationSounds++;return Promise.resolve();}
        return original.call(this);
      };
    });
    const activity=pane.locator('.crm-timeline');
    if(!await activity.evaluate(element=>element.open))await activity.locator('summary').click();
    const soundCount=()=>page.evaluate(()=>window.notificationSounds);
    const before=await soundCount();
    await activity.getByRole('button',{name:'Log activity',exact:true}).click();
    await expect(activity).toContainText('Enter activity details.');
    await expect.poll(soundCount).toBe(before+1);
    await page.route('**/api/record-resources/upload',route=>route.fulfill({
      status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic attachment failure'})
    }),{times:1});
    const beforeFile=await soundCount();
    await rail.locator('input[type=file]').setInputFiles({name:'retry.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
    await expect(rail.locator('.record-resource-status')).toHaveText('Synthetic attachment failure');
    await expect(pane.locator('[data-contacts-notice]')).toHaveText('Synthetic attachment failure');
    await expect.poll(soundCount).toBe(beforeFile+1);
  }
  await expect(rail.locator('details > summary')).toHaveText(['Notes (0)','Files (0)','Linked Quotes (0)','Linked Work Orders (0)','Linked Purchase Orders (0)','Linked Projects (0)']);
  const titleField=pane.getByLabel(kind==='accounts'?'Billing address':'Title',{exact:true});
  const original=await titleField.inputValue();
  await titleField.fill('Private in-progress edit');
  const outside={id:require('node:crypto').randomUUID(),title:'Saved by another user',body:'Legacy plain note with literal <b>text</b>'};
  const owner={kind,id};
  await api('/api/record-resources/notes',{owner,version:0,notes:[outside]});
  await refresh.click();
  await expect(rail.getByRole('button',{name:outside.title,exact:true})).toBeVisible();
  await expect(rail.locator('.record-resource-note')).toContainText(outside.body);
  await expect(titleField).toHaveValue('Private in-progress edit');await titleField.fill(original);
  await rail.getByRole('button',{name:outside.title,exact:true}).click();
  const legacy=page.getByRole('dialog',{name:'Edit note',exact:true});
  await expect(legacy.getByLabel('Compose text',{exact:true})).toContainText(outside.body);
  await legacy.getByRole('button',{name:'Cancel',exact:true}).click();await expect(legacy).toHaveCount(0);
  await api('/api/record-resources/notes',{owner,version:1,notes:[]});await refresh.click();
  await expect(rail.locator('.record-resource-note')).toHaveCount(0);
  await pane.getByRole('button',{name:'New note',exact:true}).click();const note=page.getByRole('dialog',{name:'New note',exact:true});await note.getByLabel('Note title',{exact:true}).fill('Saved '+kind+' note');
  await note.getByLabel('Compose text',{exact:true}).fill('First line\nSecond line <safe plain text>');
  await note.getByRole('button',{name:'Done',exact:true}).click();await expect(note).toHaveCount(0);await expect(pane.locator('.record-resource-note')).toContainText('Saved '+kind+' note');
  const file=pane.locator('.record-resource-panel input[type=file]');await file.setInputFiles({name:kind+' evidence.txt',mimeType:'text/plain',buffer:Buffer.from(kind+' private fixture evidence')});await expect(pane.locator('.record-resource-file a')).toHaveText(kind+' evidence.txt');
  const resource=await api('/api/record-resources?kind='+kind+'&id='+id);assert.equal(resource.notes.length,1);assert.equal(resource.notes[0].format,'rich');assert.equal(resource.files.length,1);assert.deepEqual(await api('/api/contacts/directory'),before,'Notes/Files keep directory version and values unchanged');
  const downloaded=await page.request.get(base+await pane.locator('.record-resource-file a').getAttribute('href'));assert.equal(downloaded.status(),200);assert.equal((await downloaded.body()).toString(),kind+' private fixture evidence');
  const back=pane.getByRole('button',{name:'Back to '+{accounts:'Companies',contacts:'Contacts',leads:'Leads'}[kind],exact:true});await back.click();await expect(pane).toHaveCount(0);pane=await open(kind,label);await expect(pane.locator('.record-resource-note')).toContainText('Second line <safe plain text>');await expect(pane.locator('.record-resource-file a')).toHaveText(kind+' evidence.txt');
  if(kind==='accounts')await pane.getByLabel('Billing address',{exact:true}).fill('Persisted billing address');
  else if(kind==='contacts')await pane.getByLabel('Title',{exact:true}).fill('Persisted Contact role');
  else {
   await expect(pane.getByLabel('Region',{exact:true})).toHaveCount(0);
   const next=pane.getByLabel('Next action',{exact:true}),due=pane.getByLabel('Follow-up date',{exact:true});
   const start=await next.boundingBox(); assert.equal(start.height,42);
   await next.fill(Array(12).fill('An action that remains part of the saved Lead').join('\n'));
   const end=await next.boundingBox(),date=await due.boundingBox();
   assert.ok(end.height>start.height && date.x>=end.x+end.width);
   assert.equal(date.y,end.y);assert.equal(date.height,42);
   await due.fill('2027-03-12');
  }
  await pane.getByRole('button',{name:'Save',exact:true}).click();await expect(pane).toHaveCount(0);pane=await open(kind,label);await expect(pane.locator('.record-resource-note')).toContainText('Saved '+kind+' note');await expect(pane.locator('.record-resource-file a')).toHaveText(kind+' evidence.txt');
  if(kind==='leads')assert.equal((await api('/api/contacts/directory')).leads.find(item=>item.id===id).region,'Retained legacy region');
  for(const width of [1915,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,kind+'-'+width+'.png'),fullPage:true});}await page.setViewportSize({width:1915,height:1000});
  await pane.getByRole('button',{name:'Back to '+{accounts:'Companies',contacts:'Contacts',leads:'Leads'}[kind],exact:true}).click();
 }
 checks.push('Company, Contact and Lead pages persist separate Notes/Files across Back/reopen and core form save, download exact bytes, preserve directory version, and fit desktop/mobile');
 let pane=await open('leads',lead.name);const next=pane.getByLabel('Next action',{exact:true}),savedNext=await next.inputValue();await next.fill('Unsaved Lead action');await pane.getByRole('button',{name:'Back to Leads',exact:true}).click();await expect(discard).toContainText('Discard changes to this lead?');await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(next).toHaveValue('Unsaved Lead action');await pane.getByRole('button',{name:'Back to Leads',exact:true}).click();await discard.getByRole('button',{name:'Yes',exact:true}).click();pane=await open('leads',lead.name);await expect(pane.getByLabel('Next action',{exact:true})).toHaveValue(savedNext);
 await pane.getByRole('button',{name:'New note',exact:true}).click();let note=page.getByRole('dialog',{name:'New note',exact:true});await note.getByLabel('Note title',{exact:true}).fill('Unsaved note');await page.evaluate(()=>{window.pendingDirectoryLeave=window.ClassifireContacts.leave();});await expect(discard).toContainText('Discard changes to this lead?');await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(note).toBeVisible();await expect(note.getByLabel('Note title',{exact:true})).toHaveValue('Unsaved note');await page.evaluate(()=>{window.pendingDirectoryLeave=window.ClassifireContacts.leave();});await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(note).toHaveCount(0);await expect(pane).toHaveCount(0);
 checks.push('Lead Back cancellation retains unsaved form and note values; confirmed discard closes its own note modal without saving');
 pane=await open('leads',lead.name);
 await checkRecordTrim(page,pane,'leads',output);
 const rows=pane.locator('.follow-up-action-row'),add=pane.getByRole('button',{name:'Add follow-up',exact:true});
 const first=rows.nth(0),second=rows.nth(1),third=rows.nth(2);
 await first.getByLabel('Next action',{exact:true}).fill('');await first.locator('input[type=date]').fill('');
 await pane.getByRole('button',{name:'Save',exact:true}).click();
 await expect(first.getByLabel('Next action',{exact:true})).toBeFocused();
 await first.getByLabel('Next action',{exact:true}).fill('Call installer');
 await first.locator('input[type=date]').fill('2027-03-12');
 await first.getByRole('combobox').selectOption('Completed');await expect(first.getByRole('combobox')).toBeDisabled();
 await add.click();await expect(second.getByLabel('Next action',{exact:true})).toBeFocused();await expect(second.getByRole('combobox')).toBeDisabled();
 await expect(second.locator('option:checked')).toHaveText('Pending');
 await second.getByLabel('Next action',{exact:true}).fill('Confirm plan');await second.getByRole('combobox').selectOption('Canceled');
 await add.click();await third.locator('input[type=date]').fill('2027-03-25');
 await add.click();await expect(rows).toHaveCount(4);
 await pane.getByRole('button',{name:'Save',exact:true}).click();await expect(pane).toHaveCount(0);
 const updated=(await api('/api/contacts/directory')).leads.find(item=>item.id===lead.id);
 assert.deepEqual(updated.follow_up_actions.map(row=>[row.next_action,row.status,row.follow_up_date]),[
   ['Call installer','Completed','2027-03-12'],['Confirm plan','Canceled',''],['','','2027-03-25']]);
 assert.equal(updated.follow_up_date,'2027-03-25');
 pane=await open('leads',lead.name);const stored=pane.locator('.follow-up-action-row');await expect(stored).toHaveCount(3);
 for(const index of [0,1]) {
   await expect(stored.nth(index).getByLabel('Next action',{exact:true})).not.toBeEditable();
   await expect(stored.nth(index).locator('input[type=date]')).not.toBeEditable();
   await expect(stored.nth(index).getByRole('combobox')).toBeDisabled();
 }
 await expect(stored.nth(2).getByLabel('Next action',{exact:true})).toBeEditable();
 const history=pane.locator('.crm-timeline');
 if(!await history.evaluate(el=>el.open)) await history.locator('summary').click();
 await expect(history.locator('li').filter({hasText:'Follow-up completed'})).toContainText('Call installer');
 await expect(history.locator('li').filter({hasText:'Follow-up canceled'})).toContainText('Confirm plan');
 for(const width of [1254,390]){
   await page.setViewportSize({width,height:884});
   await pane.locator('.contacts-follow-up').evaluate(el=>{
     el.scrollIntoView({block:'start',behavior:'instant'});
     window.scrollBy({top:-document.querySelector('.app-header').getBoundingClientRect().height-12,behavior:'instant'});
   });
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(output,'lead-follow-up-actions-'+width+'.png')});
 }
 await page.setViewportSize({width:1915,height:1000});await pane.getByRole('button',{name:'Back to Leads',exact:true}).click();
 checks.push('Lead follow-up editor grows, validates cleared saved actions, saves and locks completed and canceled actions, retains partial open actions, ignores unused placeholders, and reopens correctly');
 pane=await open('contacts',contact.name);let entered;const started=new Promise(resolve=>entered=resolve),writeGate=new Promise(resolve=>releaseWrite=resolve);await page.route('**/api/record-resources/notes',async route=>{const response=await route.fetch();entered();await writeGate;await route.fulfill({response});},{times:1});await pane.getByRole('button',{name:'New note',exact:true}).click();note=page.getByRole('dialog',{name:'New note',exact:true});await note.getByLabel('Note title',{exact:true}).fill('Pending original owner');await note.getByRole('button',{name:'Done',exact:true}).click();await started;assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasPendingOperation()),true);assert.equal(await page.evaluate(()=>window.ClassifireContacts.leave()),false);await expect(pane).toBeVisible();releaseWrite();await expect(note).toHaveCount(0);await expect(pane.locator('.record-resource-note').filter({hasText:'Pending original owner'})).toBeVisible();await pane.getByRole('button',{name:'Back to Contacts',exact:true}).click();
 checks.push('Pending resource save blocks navigation and completes only on its captured Contact');
 // External Project/Quote create and edit APIs retain their compact modal workflow.
 await page.evaluate(id=>{window.quickContact=window.ClassifireContacts.editContact(id);},contact.id);const quick=page.getByRole('dialog',{name:'Edit Contact',exact:true});await expect(quick).toBeVisible();await expect(quick.locator('.contacts-record-layout')).toHaveCount(0);await quick.getByRole('button',{name:'Cancel',exact:true}).click();await expect(quick).toHaveCount(0);
 await page.evaluate(id=>{window.quickNew=window.ClassifireContacts.createContact({account_id:id});},account.id);const create=page.getByRole('dialog',{name:'New Contact',exact:true});await expect(create.getByLabel('Company',{exact:true})).toHaveValue(account.company);await create.getByRole('button',{name:'Cancel',exact:true}).click();await expect(create).toHaveCount(0);
 checks.push('Project/Quote Contact edit and contextual create shortcuts retain their modal workflow and prefilled Company');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS Directory record workspaces: '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#contacts-root').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{releaseWrite?.();releaseRead?.();await browser?.close();server.kill();});
