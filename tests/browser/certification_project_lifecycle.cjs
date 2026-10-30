// Disposable project-only certificate and portable Save/New/Load coverage.
// Existing global history is a read-only negative control. No PDF is generated.
const {chromium,expect}=require('@playwright/test');
const {openProjectSection}=require('./project_actions.cjs');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`certification-project-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[],generations=[],checks=[];
const digest=value=>createHash('sha256').update(value).digest('hex');
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;},null,{timeout:120000});}
async function certification(){await openProjectSection(page,'certification');await expect(page.locator('#certification-client')).toBeEnabled({timeout:30000});}
async function projects(){await openProjectSection(page,'quotes');}
async function continueDiscard(){await page.locator('#discard-dialog [value="confirm"]').click();}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  const names=['client','project','address','location_area','statement_of_compliance','australian_standards','ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers','fire_resistance_level'];
  const fields={...Object.fromEntries(names.map(key=>[key,'N/A'])),client:'Older explicit client',project:'Older explicit project',address:'Example older address'};
  const created=await fetch(base+'/api/certifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields,request_id:randomUUID()})});
  assert.equal(created.status,201);const original=await created.json(),sourceStamp=JSON.stringify(original);
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_EXECUTABLE?{executablePath:process.env.CEASEFIRE_BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1084,height:900},hasTouch:true,deviceScaleFactor:2});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/certifications/*/revisions*',async route=>{generations.push(route.request().url());await route.abort();});
  await page.goto(base+'/');await idle();await page.locator('#estimate-navigation-toggle').click();
  await page.locator('#client').fill('PROJECT A CLIENT');await page.locator('#project-no').fill('PROJECT-A');await page.locator('#site-address').fill('Project A example address');await certification();
  const tokenA=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  await expect(page.locator(`#certification-document option[value="${original.id}"]`)).toHaveCount(0);
  await expect(page.locator('#certification-legacy-open')).toHaveCount(0);await expect(page.locator('#certification-legacy-dialog')).toHaveCount(0);
  await page.locator('#certification-location_area').fill('Keep this current draft');
  for(const name of names){const control=page.locator('#certification-'+name);if(!(await control.inputValue()).trim())await control.fill('N/A');}
  await expect(page.locator('#certification-client')).toHaveValue('PROJECT A CLIENT');
  checks.push('main selector excludes unassigned global records','older-certificate picker is absent','current project fields and draft remain intact');

  const canvas=page.locator('#certification-signature-canvas');await canvas.scrollIntoViewIfNeeded();const bounds=await canvas.boundingBox(),cdp=await page.context().newCDPSession(page);
  const touch=(x,y)=>[{x:bounds.x+bounds.width*x,y:bounds.y+bounds.height*y,radiusX:2,radiusY:2,force:.7,id:1}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touch(.12,.7)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(.34,.25)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(.58,.68)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(page.locator('#certification-signature-preview')).toBeHidden();await expect(page.locator('#certification-signature-save')).toBeEnabled();
  await page.locator('#certification-signature-save').click();await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await expect(page.locator('#certification-signer-status')).toHaveText('Signer details saved for future certificates.');
  const preferences=await (await fetch(base+'/api/certifications/defaults')).json();assert.ok(preferences.signature_image.startsWith('data:image/png;base64,'));const signatureHash=digest(preferences.signature_image);
  await page.locator('#certification-save').click();await expect(page.locator('#certification-status')).toHaveText('Certification details saved.');
  const documentId=await page.locator('#certification-document').inputValue();assert.ok(documentId&&documentId!==original.id);
  await page.locator('#certification-save').click();await expect(page.locator('#certification-status')).toHaveText('Certification details saved.');
  const listA=await (await fetch(base+'/api/certifications?workspace='+tokenA)).json();assert.equal(listA.items.length,1);
  const scoped=await (await fetch(base+'/api/certifications/'+documentId+'?workspace='+tokenA)).json();assert.deepEqual(scoped.revisions,[]);assert.equal(digest(scoped.options.signature_image),signatureHash);
  assert.equal(JSON.stringify(await (await fetch(base+'/api/certifications/'+original.id)).json()),sourceStamp);
  checks.push('native touch drawing requires explicit Save','drawn PNG accepted by server validation','repeat Save retains one project document','global history remains byte-for-byte equal as JSON');

  await page.locator('#save-current-project').click();await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:120000});await idle();
  const projectBytes=fs.readFileSync(info.project),project=JSON.parse(projectBytes);assert.equal(project.certifications.document_count,1);assert.equal(project.certifications.revision_count,0);
  const companion=path.join(path.dirname(info.project),project.certifications.companion_folder,project.certifications.archive_sha256+'.zip');assert.ok(fs.existsSync(companion));assert.equal(digest(fs.readFileSync(companion)),project.certifications.archive_sha256);
  await projects();await page.locator('#new-quote').click();const confirm=page.locator('#discard-dialog');if(await confirm.isVisible())await continueDiscard();
  await expect(page.locator('#client')).toHaveValue('',{timeout:120000});await idle();await certification();
  assert.notEqual(await page.evaluate(()=>window.CeasefireCertification.sessionId()),tokenA);await expect(page.locator(`#certification-document option[value="${documentId}"]`)).toHaveCount(0);await expect(page.locator(`#certification-document option[value="${original.id}"]`)).toHaveCount(0);
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await page.locator('#certification-signature-delete').click();await expect(page.locator('#certification-signer-status')).toHaveText('Signer details saved for future certificates.');
  assert.equal((await (await fetch(base+'/api/certifications/defaults')).json()).signature_image,null);
  await projects();await page.locator('#load-project').click();await expect(page.locator('#discard-dialog')).toBeVisible({timeout:120000});await continueDiscard();
  await expect(page.locator('#client')).toHaveValue('PROJECT A CLIENT',{timeout:120000});await idle();await certification();
  const restoredToken=await page.evaluate(()=>window.CeasefireCertification.sessionId());assert.notEqual(restoredToken,tokenA);
  await expect(page.locator('#certification-document')).toHaveValue(documentId);await expect(page.locator('#certification-client')).toHaveValue('PROJECT A CLIENT');
  await expect(page.locator('#certification-signature-preview')).toBeVisible();assert.equal(digest(await page.locator('#certification-signature-preview').getAttribute('src')),signatureHash);
  const restored=await (await fetch(base+'/api/certifications/'+documentId+'?workspace='+restoredToken)).json();assert.deepEqual(restored,scoped);
  assert.equal(digest(fs.readFileSync(info.project)),digest(projectBytes));
  checks.push('native project Save writes bounded manifest plus verified companion','New project has an isolated empty certificate list','global signature removal persists for future certificates','native Load restores project-specific document and its frozen signer artwork');
  assert.deepEqual(generations,[]);assert.deepEqual(errors,[]);
  const screenshot=path.join(output,'restored-project-certificate.png');await page.screenshot({path:screenshot,fullPage:true});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,generatedCertificateRevisions:0,errors,project:info.project,screenshot},null,2));
  console.log('PASS: Certification touch signature, current-project-only picker and native Save/New/Load project isolation. '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));console.error(JSON.stringify(errors));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
