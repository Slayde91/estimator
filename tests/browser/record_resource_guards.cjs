'use strict';
// Focus the shared helper's conflict/identity/timeout behavior; backend persistence
// and real HTTP permissions are exercised by tests.test_record_resources.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.route('http://127.0.0.1:19876/',route=>route.fulfill({contentType:'text/html',body:'<main id="resources"></main>'}));
  await page.goto('http://127.0.0.1:19876/');
  await page.evaluate(()=>{
   window.ClassifireAccess={user:{id:'actor-a'},can:()=>true};
   window.testState={version:0,notes:[],files:[]};window.testRequests=[];window.testConfirms=[];window.confirmAnswers=[];
   window.CeasefireDialogs={confirm:async(...args)=>{testConfirms.push(args);return confirmAnswers.shift()??false;}};
   const nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===8000?50:ms,...args);
   window.fetch=async(url,options)=>{
    testRequests.push({url,body:options.body?JSON.parse(options.body):null});
    const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    if(!options.body){
     if(window.failRead)return respond({error:'The record resources are unavailable.'},400);
     if(window.holdRead)await new Promise((resolve,reject)=>{window.releaseRead=resolve;options.signal.addEventListener('abort',()=>{window.readAborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});});
     return respond(testState);
    }
    const data=JSON.parse(options.body);
    if(data.version!==testState.version)return respond({error:'Notes or Files changed. Refresh this section before trying again.'},409);
    testState={...testState,version:testState.version+1,notes:data.notes.map(row=>({...row,author:'Tester',updated_at:new Date().toISOString()}))};
    return respond(testState);
   };
  });
  await page.addScriptTag({path:path.resolve(__dirname,'../../static/record-resources.js')});
  const attach=()=>page.evaluate(()=>{window.helper?.close();window.helper=ClassifireRecordResources.attach(document.getElementById('resources'),{owner:{kind:'contacts',id:'a3318d52-adad-4176-9468-b4183ea00a6d'},canEdit:()=>true});});
  await attach();const host=page.locator('#resources'),create=host.getByRole('button',{name:'New note',exact:true});
  await expect(create).toBeEnabled();await create.click();
  const note=page.getByRole('dialog',{name:'New note',exact:true});
  await note.getByLabel('Note title',{exact:true}).fill('Unsaved local note');await note.getByLabel('Note',{exact:true}).fill('Keep this text through a conflict.');
  await page.evaluate(()=>{testState={version:1,notes:[{id:crypto.randomUUID(),title:'Concurrent note',body:'Other user saved this.',author:'Other',updated_at:new Date().toISOString()}],files:[]};});
  await note.getByRole('button',{name:'Save',exact:true}).click();
  await expect(note.locator('[role="status"]')).toContainText('Notes or Files changed.');await expect(note.getByLabel('Note',{exact:true})).toHaveValue('Keep this text through a conflict.');
  const writes=await page.evaluate(()=>testRequests.filter(row=>row.body).length);
  await note.getByRole('button',{name:'Save',exact:true}).click();assert.equal(await page.evaluate(()=>testRequests.filter(row=>row.body).length),writes,'Cancel review must not replay the write');await expect(note).toBeVisible();
  assert.equal(await page.evaluate(()=>testConfirms.at(-1)[0]),'Notes or Files changed. Save this note using the latest record?');
  await page.evaluate(()=>confirmAnswers.push(true));await note.getByRole('button',{name:'Save',exact:true}).click();await expect(note).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>testState.notes.map(row=>row.title).sort()),['Concurrent note','Unsaved local note']);
  await page.evaluate(()=>{window.failRead=true;});await attach();await expect(host.locator('[role="status"]')).toHaveText('The record resources are unavailable.');await expect(create).toBeDisabled();
  await page.evaluate(()=>{window.failRead=false;window.holdRead=true;window.readAborted=false;});await attach();await expect(host.locator('[role="status"]')).toHaveText('The request could not be completed.');await expect(create).toBeDisabled();assert.equal(await page.evaluate(()=>readAborted),true,'Timed out reads abort and retain disabled mutation controls');
  await page.evaluate(()=>{window.ClassifireAccess.user.id='actor-a';window.holdRead=true;window.releaseRead=null;});await attach();await page.waitForFunction(()=>typeof releaseRead==='function');
  await page.evaluate(()=>{ClassifireAccess.user.id='actor-b';releaseRead();});await page.waitForTimeout(70);
  await expect(create).toBeDisabled();await expect(host.locator('summary').first()).toHaveText('Notes (0)');assert.equal(await host.getByRole('button',{name:'Concurrent note',exact:true}).count(),0,'Old-account response must not repaint the new account');
  await page.evaluate(()=>helper.close());await expect(host.locator('details')).toHaveCount(0);
  console.log('PASS record resource helper: explicit conflict review preserves text/other notes; failed/timed-out reads disable mutations; late old-account responses are ignored; close cleans panels.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
