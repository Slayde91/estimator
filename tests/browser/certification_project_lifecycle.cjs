const {fillProjectDetails}=require('./project_actions.cjs');
const {generateCertificate,openCertificateEditor}=require('./certification_generation.cjs');
// Disposable project-only certificate and portable Save/New/Load coverage.
// Existing global history is a read-only negative control. New revisions remain in the private fixture.
const {chromium,expect}=require('@playwright/test');
const {openProjectSection,createNewProject}=require('./project_actions.cjs');
const {spawn,spawnSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
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
async function certification(){await openProjectSection(page,'certification');await openCertificateEditor(page);}
async function projects(){await openProjectSection(page,'quotes');}
async function continueDiscard(){await page.locator('#discard-dialog [value="confirm"]').click();}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  const names=['client','project','address','location_area','statement_of_compliance','australian_standards','ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers','fire_resistance_level','name','position','qualification','accreditation'];
  const fields={...Object.fromEntries(names.map(key=>[key,'N/A'])),client:'Older explicit client',project:'Older explicit project',address:'Example older address'};
  const seeded=spawnSync(process.env.CEASEFIRE_PYTHON||'python',['-c',
    'import json,sys; from pathlib import Path; from estimator.storage import Store; from estimator.certification import CertificationService; print(json.dumps(CertificationService(Store(Path(sys.argv[1]))).create(json.loads(sys.argv[2]))))',
    path.join(info.directory,'qa.sqlite3'),JSON.stringify(fields)],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);const original=JSON.parse(seeded.stdout),sourceStamp=JSON.stringify(original);
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_EXECUTABLE?{executablePath:process.env.CEASEFIRE_BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1084,height:900},hasTouch:true,deviceScaleFactor:2});page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/revisions')&&request.method()==='POST')generations.push(request.url());});
  await page.goto(base+'/');await idle();await page.locator('#estimate-navigation-toggle').click();
  await fillProjectDetails(page,{'client':'PROJECT A CLIENT'});await expect(page.locator('#project-no')).toHaveAttribute('readonly','');await fillProjectDetails(page,{'site-address':'Project A example address'});
  await page.locator('#save-current-project').click();await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:120000});await idle();await certification();
  const tokenA=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  await expect(page.locator(`#certification-document option[value="${original.id}"]`)).toHaveCount(0);
  await expect(page.locator('#certification-legacy-open')).toHaveCount(0);await expect(page.locator('#certification-legacy-dialog')).toHaveCount(0);
  await page.locator('#certification-location_area').fill('Keep this current draft');
  for(const name of names){const control=page.locator('#certification-'+name);if(!(await control.inputValue()).trim())await control.fill('N/A');}
  await expect(page.locator('#certification-client')).toHaveValue('PROJECT A CLIENT');
  checks.push('main selector excludes unassigned global records','older-certificate picker is absent','current project fields and draft remain intact');

  await page.locator('#certification-signature-use').click();
  const chooser=page.getByRole('dialog',{name:'Signatures',exact:true}), canvas=chooser.getByLabel('Signature drawing pad');await canvas.scrollIntoViewIfNeeded();const bounds=await canvas.boundingBox(),cdp=await page.context().newCDPSession(page);
  const touch=(x,y)=>[{x:bounds.x+bounds.width*x,y:bounds.y+bounds.height*y,radiusX:2,radiusY:2,force:.7,id:1}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touch(.12,.7)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(.34,.25)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touch(.58,.68)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(page.locator('#certification-signature-preview')).toBeHidden();await expect(chooser.getByRole('button',{name:'Insert signature'})).toBeEnabled();
  await chooser.getByRole('button',{name:'Insert signature'}).click();await expect(page.locator('#certification-signature-preview')).toBeVisible();
  const preferences=await (await fetch(base+'/api/certifications/defaults')).json();assert.equal(preferences.signature_image,null);
  const signatureHash=digest(await page.locator('#certification-signature-preview').getAttribute('src'));
  const unsavedStamp=await page.evaluate(()=>window.CeasefireCertification.projectFingerprint());
  const upperToolbar=page.getByRole('group',{name:'Certification',exact:true}),revisionsToolbar=page.getByRole('group',{name:'Certificate revisions',exact:true});
  for(const toolbar of [upperToolbar,revisionsToolbar]){
    for(const name of ['Documentation','Save draft','New','Generate Certificate'])await expect(toolbar.getByRole('button',{name,exact:true})).toBeEnabled();
    await expect(toolbar.getByRole('combobox',{name:'Workflow status'})).toHaveValue('Draft');
  }
  await revisionsToolbar.getByRole('button',{name:'Documentation',exact:true}).click();await expect(page.locator('#view-documentation')).toBeVisible();
  await certification();
  assert.equal(await page.evaluate(()=>window.CeasefireCertification.projectFingerprint()),unsavedStamp);
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await upperToolbar.getByLabel('Workflow status',{exact:true}).selectOption('Review');
  await expect(revisionsToolbar.getByLabel('Workflow status',{exact:true})).toHaveValue('Review');
  await revisionsToolbar.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.locator('#certification-status')).toContainText('Certification details saved.');
  await revisionsToolbar.getByLabel('Workflow status',{exact:true}).selectOption('Rejected');
  await expect(page.locator('#certification-workflow')).toHaveValue('Rejected');
  await expect(page.locator('#certification-save')).toHaveCount(0);await generateCertificate(page,1);
  const documentId=await page.locator('#certification-document').inputValue();assert.ok(documentId&&documentId!==original.id);
  await page.locator('#certification-location_area').fill('Updated before second generation');
  await generateCertificate(page,2,revisionsToolbar.getByRole('button',{name:'Generate Certificate',exact:true}));
  const revisionsCard=page.locator('section[aria-labelledby="certification-revisions-heading"]');
  await revisionsCard.scrollIntoViewIfNeeded();
  const toolbarBox=await revisionsToolbar.boundingBox(),cardBox=await revisionsCard.boundingBox();
  assert.ok(toolbarBox.y+toolbarBox.height<=cardBox.y && cardBox.y-toolbarBox.y-toolbarBox.height<40);
  await page.screenshot({path:path.join(output,'certificate-revision-toolbar.png')});
  const localized=await page.evaluate(()=>{
    const i18n=window.CeasefireI18n;
    i18n.setLanguage('ar',false);
    return Object.fromEntries(['Documentation','Save draft','New','Generate Certificate','Workflow status','Rejected'].map(key=>[key,i18n.translate(key)]));
  });
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  for(const toolbar of await page.locator('#certification-editor .certification-editor-toolbar').all()){
    for(const name of ['Documentation','Save draft','New','Generate Certificate'])await expect(toolbar.getByRole('button',{name:localized[name],exact:true})).toBeVisible();
    const status=toolbar.getByRole('combobox',{name:localized['Workflow status'],exact:true});
    await expect(status).toHaveValue('Rejected');await expect(status.locator('option:checked')).toHaveText(localized.Rejected);
  }
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
  checks.push('Both toolbars expose all five actions; editing either status selector updates the other and the lower toolbar saves and generates the next revision.');
  const listA=await (await fetch(base+'/api/certifications?workspace='+tokenA)).json();assert.equal(listA.items.length,1);
  const scoped=await (await fetch(base+'/api/certifications/'+documentId+'?workspace='+tokenA)).json();assert.equal(scoped.revisions.length,2);assert.equal(scoped.fields.location_area,'Updated before second generation');assert.equal(digest(scoped.options.signature_image),signatureHash);
  assert.equal(JSON.stringify(await (await fetch(base+'/api/certifications/'+original.id)).json()),sourceStamp);
  checks.push('native touch drawing requires explicit generation','drawn PNG accepted by server validation','two Generate actions retain one document and two immutable revisions','global history remains byte-for-byte equal as JSON');

  await page.locator('#save-current-project').click();await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:120000});await idle();
  const projectBytes=fs.readFileSync(info.project),project=JSON.parse(projectBytes);assert.equal(project.certifications.document_count,1);assert.equal(project.certifications.revision_count,2);
  const companion=path.join(path.dirname(info.project),project.certifications.companion_folder,project.certifications.archive_sha256+'.zip');assert.ok(fs.existsSync(companion));assert.equal(digest(fs.readFileSync(companion)),project.certifications.archive_sha256);
  await projects();
  const directory=await(await page.request.get(base+'/api/contacts/directory')).json();
  const account=await page.request.post(base+'/api/contacts/accounts',{data:{version:directory.version,fields:{company:'PROJECT B CLIENT'}}});assert.equal(account.status(),200);
  const saveTarget=path.join(info.directory,'save-dialog-target.json');fs.writeFileSync(saveTarget,JSON.stringify({file:'project-b.cf.json'}));
  try{await createNewProject(page,{client:'PROJECT B CLIENT','site-address':'Project B fixture address'});}finally{fs.unlinkSync(saveTarget);}
  assert.deepEqual(fs.readFileSync(info.project),projectBytes,'New Project saves to a distinct fixture destination');
  await expect(page.locator('#client')).toHaveValue('PROJECT B CLIENT',{timeout:120000});await idle();await certification();
  assert.notEqual(await page.evaluate(()=>window.CeasefireCertification.sessionId()),tokenA);await expect(page.locator(`#certification-document option[value="${documentId}"]`)).toHaveCount(0);await expect(page.locator(`#certification-document option[value="${original.id}"]`)).toHaveCount(0);
  await expect(page.locator('#certification-signature-preview')).toBeHidden();
  assert.equal((await (await fetch(base+'/api/certifications/defaults')).json()).signature_image,null);
  await page.locator('#certification-location_area').fill('Discard this Project B draft before loading Project A');
  await projects();await page.locator('#load-project').click();await expect(page.locator('#discard-dialog')).toBeVisible({timeout:120000});await continueDiscard();
  await expect(page.locator('#client')).toHaveValue('PROJECT A CLIENT',{timeout:120000});await idle();await certification();
  const restoredToken=await page.evaluate(()=>window.CeasefireCertification.sessionId());assert.notEqual(restoredToken,tokenA);
  await expect(page.locator('#certification-document')).toHaveValue(documentId);await expect(page.locator('#certification-client')).toHaveValue('PROJECT A CLIENT');
  await expect(page.locator('#certification-workflow')).toHaveValue('Rejected');
  await expect(page.locator('#certification-revisions a')).toHaveCount(2);
  await expect(revisionsToolbar.getByLabel('Workflow status',{exact:true})).toHaveValue('Rejected');
  await expect(page.locator('#certification-signature-preview')).toBeVisible();assert.equal(digest(await page.locator('#certification-signature-preview').getAttribute('src')),signatureHash);
  const restored=await (await fetch(base+'/api/certifications/'+documentId+'?workspace='+restoredToken)).json();
  const portable=value=>({...value,revisions:value.revisions.map(({pdf_url,...revision})=>revision)});
  assert.deepEqual(portable(restored),portable(scoped));
  for(const revision of restored.revisions){
    assert.equal(new URL(base+revision.pdf_url).searchParams.get('workspace'),restoredToken);
    const frozen=await fetch(base+revision.pdf_url);assert.equal(frozen.status,200);
    assert.equal(digest(Buffer.from(await frozen.arrayBuffer())),revision.sha256,'Native Load restores the exact frozen revision PDF bytes');
  }
  assert.equal(digest(fs.readFileSync(info.project)),digest(projectBytes));
  checks.push('native project Save writes bounded manifest plus verified companion','New project has an isolated empty certificate list','new certificate stays unsigned until explicit insertion','native Load restores project-specific document and its frozen signer artwork');
  for(const status of ['Draft','Review','Approved','Rejected']){
    const seeded=await page.request.post(base+'/api/certifications?workspace='+restoredToken,{data:{
      fields:{...fields,client:'Search '+status+' client',project:'Search project '+status,address:'Search site '+status},
      options:{cover_pdf:null,cover_pdf_name:'',scopes:[],workflow_status:status},request_id:randomUUID()}});
    assert.equal(seeded.status(),201,await seeded.text());
  }
  await page.evaluate(()=>window.CeasefireCertification.open());
  const saved=page.locator('#certification-document');
  await expect(saved.locator('option')).toHaveCount(5);
  const review=await saved.locator('option').filter({hasText:'Search Review client'}).getAttribute('value');
  await saved.selectOption(review);
  const discard=page.getByRole('button',{name:'Continue without saving',exact:true});if(await discard.isVisible())await discard.click();
  await expect(page.locator('#certification-client')).toHaveValue('Search Review client');
  for(const width of [1915,390]){
    await page.setViewportSize({width,height:884});await expect(saved).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  checks.push('Existing certificates of all stages reopen from the form at desktop and phone sizes.');
  assert.equal(generations.length,2);assert.deepEqual(errors,[]);
  const screenshot=path.join(output,'restored-project-certificate.png');await page.screenshot({path:screenshot,fullPage:true});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,generatedCertificateRevisions:generations.length,errors,project:info.project,screenshot},null,2));
  console.log('PASS: Certification touch signature, current-project-only picker and native Save/New/Load project isolation. '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));console.error(JSON.stringify(errors));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
