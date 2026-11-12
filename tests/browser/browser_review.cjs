'use strict';
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,createNewProject}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`browser-review-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const errors=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);}
(async()=>{
  const info=await ready;browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(60000);
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  // Count burst nodes independently of animation duration and pointer geometry.
  await page.evaluate(()=>{window.qaSmoke=[];new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&node.parentElement?.classList.contains('click-smoke-layer'))window.qaSmoke.push(window.qaClick);
  }).observe(document.body,{childList:true,subtree:true});window.qaClick=0;});
  const heading=page.locator('#view-home h1');
  for(let i=1;i<=34;i++){await page.evaluate(i=>window.qaClick=i,i);await heading.click();}
  assert.deepEqual(await page.evaluate(()=>window.qaSmoke),[7,15,24,34]);
  await createNewProject(page,{client:'SYNTHETIC COVER REVIEW'});
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),true);
  await openProjectSection(page,'documentation');await idle();
  const upload=page.locator('#cover-sheet-full_schedule');
  for(const group of ['Schedules','Product summaries','Other documents'])
    await expect(page.getByRole('button',{name:group,exact:true})).toHaveAttribute('aria-expanded','false');
  await expect(upload).toBeHidden();await page.getByRole('button',{name:'Schedules',exact:true}).click();
  const picker=upload.locator('xpath=..'),caption=picker.locator('span'),filename=page.locator('#cover-sheet-full_schedule-name');
  await expect(caption).toHaveText('Choose file');await expect(filename).toBeEmpty();
  const pickerWidth=(await picker.boundingBox()).width,captionWidth=(await caption.boundingBox()).width;
  assert.ok(pickerWidth-captionWidth<=24 && pickerWidth>=captionWidth);
  await upload.setInputFiles(info.fixture);await expect(filename).toHaveText(path.basename(info.fixture));
  await expect.poll(()=>page.evaluate(()=>window.CeasefireCoverSheets.hasUnsavedChanges())).toBe(true);
  const row=upload.locator('xpath=ancestor::tr[1]');assert.equal(await row.locator('.cover-sheet-actions button').count(),1);
  await page.locator('.app-header [data-view="home"]').click();
  const dialog=page.getByRole('dialog',{name:'Unsaved changes',exact:true});await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#view-documentation')).toBeVisible();
  assert.equal(await page.evaluate(()=>window.CeasefireCoverSheets.hasUnsavedChanges()),true);
  await page.locator('.app-header [data-view="home"]').click();await dialog.getByRole('button',{name:'Yes',exact:true}).click();
  await expect(page.locator('#view-home')).toBeVisible();assert.equal(await page.evaluate(()=>window.CeasefireCoverSheets.hasUnsavedChanges()),false);
  await openProjectSection(page,'documentation');await idle();await upload.setInputFiles(info.fixture);
  await expect.poll(()=>page.evaluate(()=>window.CeasefireCoverSheets.hasUnsavedChanges())).toBe(true);
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/pdf-covers/full_schedule'&&r.request().method()==='POST');
  await page.locator('#save-current-project').click();assert.equal((await saved).status(),200);await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireCoverSheets.hasUnsavedChanges()),false);
  const covers=await (await page.request.get(`http://127.0.0.1:${info.port}/api/pdf-covers`)).json();
  assert.equal(covers.items.find(i=>i.kind==='full_schedule').has_cover,true);
  assert.ok(fs.existsSync(info.project));await page.screenshot({path:path.join(output,'documentation-main-save.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,smokeIntervals:[7,8,9,10],coverMainSave:true,cancelAndDiscard:true,errors},null,2));console.log(JSON.stringify({passed:true,output}));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
