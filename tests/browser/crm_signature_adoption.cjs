'use strict';
const {chromium,expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs'),path = require('node:path');

const root = path.resolve(__dirname,'../..'),out = path.join(root,'.runtime/browser-qa','crm-signature-adoption-'+Date.now());
fs.mkdirSync(out,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--real-auth','--directory',out],{cwd:root,windowsHide:true});
let browser,logs='',stdout='';
server.stderr.on('data',chunk=>logs+=chunk);
const fixture = new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});
});

(async()=>{
  const {port}=await fixture;assert.notEqual(port,8765);
  const base='http://127.0.0.1:'+port;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext(),page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  async function post(route,data,headers={}) {
    const result=await context.request.post(base+'/api/'+route,{data,headers});
    assert.equal(result.status(),200,await result.text());return result.json();
  }
  const admin={email:'manager@example.test',password:'Isolated-manager-signature'};
  const editor={email:'editor@example.test',password:'Isolated-editor-signature'};
  const manager=await post('scheduler/setup',{...admin,name:'Manager'});
  const worker=await post('scheduler/members/save',{...editor,name:'Editor',role:'worker',active:true,base_rate:'0'});
  const member=manager.user.id, headers={'X-CRM-Member':member};
  await post('access/login',admin);
  await post('access/roles',{member_id:worker.id,role:'editor',version:0},headers);
  await post('access/settings',{enabled:true,version:1},headers);
  const key='ceasefire.takeoff-signature.v1', ink={version:1,ratio:2,strokes:[[[.1,.2],[.6,.9]]]};
  const bytes=JSON.stringify(ink,null,2);
  const saved=k=>page.evaluate(k=>localStorage.getItem(k),k);
  const settings=async()=>{await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await page.locator('nav [data-view=settings]').click();};
  const open=async()=>{await page.locator('#personal-signature-set').click();await expect(dialog).toBeVisible();};
  const dialog=page.getByRole('dialog',{name:'Personal signature',exact:true});
  const review=dialog.getByRole('button',{name:'Review previous local signature',exact:true});
  const use=dialog.getByRole('button',{name:'Use saved signature',exact:true});
  const confirm=dialog.getByRole('button',{name:'Save',exact:true});
  await settings();
  await page.evaluate(([key,bytes])=>localStorage.setItem(key,bytes),[key,bytes]);
  // Both document insertion and the public automatic read see only today's member.
  assert.equal(await page.evaluate(()=>window.ClassifirePersonalSignature.saved()),null);
  await page.evaluate(()=>{window.ClassifirePersonalSignature.choose();});
  const doc=page.getByRole('dialog',{name:'Signatures'});
  await expect(doc.getByRole('img')).toHaveCount(0);
  await expect(doc.getByRole('button',{name:'Review previous local signature'})).toHaveCount(0);
  await doc.getByRole('button',{name:'Cancel'}).click();
  await open();await expect(dialog.getByRole('img')).toHaveCount(0);
  await review.click();await expect(dialog.getByRole('img',{name:'Saved signature preview'})).toBeVisible();
  await use.click();await expect(confirm).toBeEnabled();await dialog.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await saved(key+'.'+member),null);assert.equal(await saved(key),bytes);
  await open();await review.click();await use.click();await expect(confirm).toBeEnabled();
  const raced=JSON.stringify({version:1,ratio:1,strokes:[[[.1,.3],[.4,.5]]]});
  await page.evaluate(([key,ink])=>localStorage.setItem(key,ink),[key+'.'+member,raced]);
  await confirm.click();await expect(dialog.getByRole('status')).toContainText('profile changed');
  assert.equal(await saved(key+'.'+member),raced);
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await page.evaluate(key=>localStorage.removeItem(key),key+'.'+member);
  await open();await review.click();await use.click();await expect(confirm).toBeEnabled();
  await post('access/login',editor);await confirm.click();
  await expect(dialog.getByRole('status')).toContainText(/profile changed|Could not load/);
  assert.equal(await saved(key+'.'+member),null);assert.equal(await saved(key+'.'+worker.id),null);
  await settings();await open();await expect(review).toHaveCount(0);
  await expect(dialog.getByRole('img')).toHaveCount(0);await dialog.getByRole('button',{name:'Cancel'}).click();
  await post('access/login',admin);await settings();await open();await review.click();await use.click();
  assert.equal(await saved(key+'.'+member),null);await confirm.click();await expect(dialog).toHaveCount(0);
  assert.deepEqual(JSON.parse(await saved(key+'.'+member)),ink);assert.equal(await saved(key),bytes);
  await open();await expect(review).toHaveCount(0);await expect(dialog.getByRole('img')).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await post('access/login',editor);await settings();
  assert.equal(await page.evaluate(()=>window.ClassifirePersonalSignature.saved()),null);
  assert.equal(await saved(key+'.'+worker.id),null);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks:['blank automatic read','document guard',
    'review and cancel','concurrent personal signature','account switch','non-admin isolation','explicit personal save','original bytes retained']}));
  console.log('PASS signature adoption: '+out);
})().catch(error=>{console.error(error);console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
