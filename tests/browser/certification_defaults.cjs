const {fillProjectDetails}=require('./project_actions.cjs');
const {generateCertificate,openCertificateEditor}=require('./certification_generation.cjs');
// Disposable lifecycle coverage. Certificate PDFs are generated only in the private fixture.
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {openProjectSection,clickProjectControl,createNewProject}=require('./project_actions.cjs');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa',`certification-defaults-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{
  let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});
});
const errors=[],generationRequests=[],profileWrites=[],pendingRequests=new Map(),evidence={checks:[],screenshots:[]};
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
async function certification(){await openProjectSection(page,'certification');await openCertificateEditor(page);}
async function fresh(){await openCertificateEditor(page,{fresh:true});await expect(page.locator('#certification-document')).toHaveValue('');}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  // Seed an older draft and separate signer preferences; no PDF/revision is
  // produced. Entering Certification must not load the old document's fields.
  const oldFields={...Object.fromEntries(['client','project','address','location_area','statement_of_compliance','australian_standards','ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers','fire_resistance_level','name','position','qualification','accreditation'].map(key=>[key,'N/A'])),client:'Old saved client',project:'Old saved project',statement_of_compliance:'Old saved statement',name:'Upgrade signer'};
  // Seed historical global data directly in private fixture storage. New
  // unscoped Certificate API creation is intentionally prohibited now.
  const seeded=spawnSync(process.env.CEASEFIRE_PYTHON||'python',['-c',
    'import json,sys; from pathlib import Path; from estimator.storage import Store; from estimator.certification import CertificationService; print(json.dumps(CertificationService(Store(Path(sys.argv[1]))).create(json.loads(sys.argv[2]))))',
    path.join(info.directory,'qa.sqlite3'),JSON.stringify(oldFields)],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);const old=JSON.parse(seeded.stdout);
  const preferencesResponse=await fetch(base+'/api/certifications/defaults'),preferences=await preferencesResponse.json();
  const savedPreferences=await fetch(base+'/api/certifications/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{name:'Upgrade signer',position:'',qualification:'',accreditation:''},expected_version:preferences.version})});
  assert.equal(savedPreferences.status,200);
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_EXECUTABLE?{executablePath:process.env.CEASEFIRE_BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1084,height:900}});page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().includes('/api/'))pendingRequests.set(request,Date.now());if(new URL(request.url()).pathname==='/api/certifications/defaults'&&request.method()==='POST')profileWrites.push(request.postDataJSON());});
  for(const name of ['requestfinished','requestfailed'])page.on(name,request=>pendingRequests.delete(request));
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/revisions')&&request.method()==='POST')generationRequests.push(request.url());});
  await page.goto(base+'/');await idle();
  await page.locator('#estimate-navigation-toggle').click();
  await fillProjectDetails(page,{'client':'Current estimate client'});await fillProjectDetails(page,{'site-address':'Current estimate address'});await expect(page.locator('#project-no')).toHaveAttribute('readonly','');const firstSave=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await firstSave).status(),200);await idle();await expect(page.locator('#project-no')).toHaveValue('PN-01');
  await certification();
  await expect(page.locator('#certification-document')).toHaveValue('');
  const selector=page.locator('#certification-document');
  const compactSelector=await selector.boundingBox();
  assert.ok(compactSelector.width<400,'Certificate choices use their intrinsic width rather than the full card');
  await page.setViewportSize({width:390,height:900});
  await selector.evaluate(select=>{const option=document.createElement('option');option.value='qa-long-label';option.textContent='A deliberately long saved certificate description that must stay inside the card';select.append(option);});
  const boundedSelector=await selector.boundingBox();
  assert.ok(boundedSelector.x>=0&&boundedSelector.x+boundedSelector.width<=390,'Long certificate labels remain bounded on phones');
  await selector.evaluate(select=>select.querySelector('[value="qa-long-label"]').remove());
  await page.setViewportSize({width:1084,height:900});
  await expect(page.locator('#certification-client')).toHaveValue('Current estimate client');
  await expect(page.locator('#certification-address')).toHaveValue('Current estimate address');
  await expect(page.locator('#certification-exclusions')).toHaveValue('Project No.: PN-01');
  await expect(page.locator('#certification-name')).toHaveValue('');
  await expect(page.locator('#certification-statement_of_compliance')).toHaveValue("This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule.\n\nAll materials have been installed at the above location and comply with:");
  await expect(page.locator('#certification-back')).toBeVisible();await expect(page.locator('#certification-new')).toBeVisible();await expect(page.locator('#certification-reload')).toHaveCount(0);
  await expect(page.locator('#certification-cover-pdf')).toHaveCount(0);
  for(const name of ['approved_design','additional_standards','other_references']){
    await expect(page.locator('#certification-'+name)).toHaveValue('N/A');await expect(page.locator('#certification-'+name)).toHaveAttribute('rows','1');
  }
  await page.locator('#certification-location_area').fill('First current draft');await fresh();
  await expect(page.locator('#certification-location_area')).toHaveValue('');
  await page.locator('#certification-location_area').fill('Second current draft');await fresh();
  await expect(page.locator('#certification-location_area')).toHaveValue('');
  evidence.checks.push('Estimates/default literal prefill','no latest-document auto-load','repeated native New action','removed buttons','no certificate-local cover section','three fresh N/A fields remain multiline-capable');

  await openProjectSection(page,'documentation');
  const coverRow=kind=>page.locator('#documentation-pdf-rows tr[data-cover-kind="'+kind+'"]');
  await expect(page.locator('#documentation-pdf-rows tr[data-cover-kind]')).toHaveCount(18);
  for(const label of ['Schedules','Product summaries','Other documents'])await page.getByRole('button',{name:label,exact:true}).click();
  const kindsResponse=await fetch(base+'/api/pdf-covers'),kinds=await kindsResponse.json();
  assert.ok(kinds.items.every(item=>!Object.hasOwn(item,'cover_pdf')&&typeof item.has_cover==='boolean'));
  await expect(coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true})).toHaveCount(0);
  await coverRow('certification').locator('input').setInputFiles(info.fixture);
  await expect(coverRow('certification')).toContainText('synthetic-drawings.pdf');
  await clickProjectControl(page,'Save');
  await expect(coverRow('certification')).toContainText('Cover sheet saved.');
  await coverRow('takeoff_markups').locator('input').setInputFiles(info.board_fixture);
  await clickProjectControl(page,'Save');
  await expect(coverRow('takeoff_markups')).toContainText('Cover sheet saved.');
  const additionalCoverKinds=['steel_vermiculite_product_summary','steel_intumescent_product_summary','steel_board_product_summary','ductwork_product_summary','swms','quote','work_order','purchase_order'];
  const additionalBefore=await (await fetch(base+'/api/pdf-covers')).json();
  for(const kind of additionalCoverKinds){await expect(coverRow(kind).locator('input')).toHaveAttribute('type','file');await coverRow(kind).locator('input').setInputFiles(info.fixture);await expect(coverRow(kind)).toContainText('Unsaved changes');}
  const additionalStaged=await (await fetch(base+'/api/pdf-covers')).json();
  for(const kind of additionalCoverKinds)assert.deepEqual(additionalStaged.items.find(row=>row.kind===kind),additionalBefore.items.find(row=>row.kind===kind),'Uploads remain drafts until main Save');
  await clickProjectControl(page,'Save');
  for(const kind of additionalCoverKinds)await expect(coverRow(kind)).toContainText('Cover sheet saved.');
  const additionalSaved=await (await fetch(base+'/api/pdf-covers')).json();
  for(const kind of additionalCoverKinds){const row=additionalSaved.items.find(row=>row.kind===kind);assert.equal(row.has_cover,true);assert.equal(row.cover_pdf_name,'synthetic-drawings.pdf');}
  evidence.checks.push('All four product summaries and all four issued document kinds expose independent covers that remain drafts until main Save');
  const beforeConflict=await (await fetch(base+'/api/pdf-covers')).json(),certificationCover=beforeConflict.items.find(item=>item.kind==='certification');
  const otherWindow=await fetch(base+'/api/pdf-covers/certification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cover_pdf:'data:application/pdf;base64,'+fs.readFileSync(info.fixture).toString('base64'),cover_pdf_name:'Other window cover.pdf',expected_version:certificationCover.version})});
  assert.equal(otherWindow.status,200);await coverRow('certification').locator('input').setInputFiles(info.fixture);
  await clickProjectControl(page,'Save');await expect(coverRow('certification')).toContainText('changed in another window');
  await clickProjectControl(page,'Save');await page.getByRole('dialog',{name:'Cover sheet changed',exact:true}).getByRole('button',{name:'Keep editing',exact:true}).click();
  await expect(coverRow('certification')).toContainText('synthetic-drawings.pdf');await expect(page.locator('#save-current-project')).toBeEnabled();
  const afterCancel=await (await fetch(base+'/api/pdf-covers')).json();assert.equal(afterCancel.items.find(item=>item.kind==='certification').cover_pdf_name,'Other window cover.pdf');
  await clickProjectControl(page,'Save');await page.getByRole('dialog',{name:'Cover sheet changed',exact:true}).getByRole('button',{name:'Apply cover-sheet change',exact:true}).click();await expect(coverRow('certification')).toContainText('Cover sheet saved.');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('#company-cover-pdf').setInputFiles(info.fixture);await page.locator('#company-settings-save').click();await expect(page.locator('#company-settings-status')).toContainText('Saved');
  const initialCovers=await (await fetch(base+'/api/pdf-covers')).json();
  assert.equal(initialCovers.items.find(item=>item.kind==='certification').has_cover,true);
  assert.equal(initialCovers.items.find(item=>item.kind==='takeoff_markups').has_cover,true);
  evidence.checks.push('18 independent Documentation cover rows','saved cover metadata excludes PDF bytes','main and specific covers saved independently','stale cover Save blocks silent overwrite','cancelled conflicted main Save retains selected file','explicit approved conflict retry uses current version');
  await certification();

  await page.locator('#certification-client').fill('Custom certificate client');
  await page.locator('#certification-statement_of_compliance').fill('Custom statement retained');
  await page.locator('#estimate-navigation-toggle').click();
  await fillProjectDetails(page,{'client':'Changed estimate client'});await fillProjectDetails(page,{'site-address':'Changed estimate address'});await expect(page.locator('#project-no')).toHaveValue('PN-01');
  await certification();
  await expect(page.locator('#certification-client')).toHaveValue('Custom certificate client');
  await expect(page.locator('#certification-statement_of_compliance')).toHaveValue('Custom statement retained');
  await expect(page.locator('#certification-address')).toHaveValue('Changed estimate address');
  await expect(page.locator('#certification-exclusions')).toHaveValue('Project No.: PN-01');
  await page.locator('#certification-australian_standards').fill('Manual additional standard');
  await page.locator('#certification-ncc_clauses').fill('Manual first clause.\n\n  Manual second clause.');
  await page.locator('#certification-scopes summary').click();
  for(const scope of ['structural_steel','structural_steel_columns','ductwork','service_penetrations'])await page.locator('#certification-scope-'+scope).check();
  await expect(page.locator('#certification-scopes-summary')).toHaveText('Structural steel, Structural steel incl. columns, Ductwork, Service penetrations');
  const standards=(await page.locator('#certification-australian_standards').inputValue()).split('\n');
  assert.equal(standards.filter(line=>line==='AS 1530.4: 2014 Methods for fire tests on building materials, components & structures').length,1);
  assert.equal(standards.filter(line=>line==='AS 4072.1: 2005 Protection of openings in fire-resistant separating elements').length,1);
  const clauses=await page.locator('#certification-ncc_clauses').inputValue();assert.match(clauses,/C4D17 Columns protected/);assert.ok(clauses.endsWith('Manual first clause.\n\n  Manual second clause.'));
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('fr',false));
  const translatedSummary=await page.evaluate(()=>['Structural steel','Structural steel incl. columns','Ductwork','Service penetrations'].map(label=>window.CeasefireI18n.translate(label)).join(', '));
  await expect(page.locator('#certification-scopes-summary')).toHaveText(translatedSummary);
  assert.deepEqual((await page.locator('#certification-australian_standards').inputValue()).split('\n'),standards);
  await expect(page.locator('#certification-ncc_clauses')).toHaveValue(clauses);
  for(const scope of ['structural_steel','structural_steel_columns','ductwork','service_penetrations'])await expect(page.locator('#certification-scope-'+scope)).toBeChecked();
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
  await expect(page.locator('#certification-scopes-summary')).toHaveText('Structural steel, Structural steel incl. columns, Ductwork, Service penetrations');
  await page.locator('#certification-scope-service_penetrations').press('Escape');
  await expect(page.locator('#certification-scopes')).not.toHaveAttribute('open','');
  await expect(page.locator('#certification-scopes summary')).toBeFocused();
  const required=await page.locator('#certification-form textarea').evaluateAll(items=>items.map(item=>({id:item.id,required:item.required})));
  assert.equal(required.length,17);assert.ok(required.every(item=>item.required!==['certification-qualification','certification-accreditation'].includes(item.id)));
  await expect(page.locator('#certification-save')).toHaveCount(0);await page.locator('#certification-generate').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#certification-form').checkValidity()),false);
  for(const [key,value] of Object.entries({location_area:'Ground floor fixture',materials_manufacturers:'Example manufacturer',fire_resistance_level:'-/120/120',position:'Fixture position',qualification:'Fixture qualification',accreditation:'Fixture accreditation'}))await page.locator('#certification-'+key).fill(value);
  await page.locator('#certification-signature-use').click();
  const padDialog=page.getByRole('dialog',{name:'Signatures',exact:true}), canvas=padDialog.getByLabel('Signature drawing pad');
  const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.1,box.y+box.height*.7);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.3,box.y+box.height*.2);await page.mouse.move(box.x+box.width*.55,box.y+box.height*.7);await page.mouse.up();
  await expect(page.locator('#certification-signature-preview')).toBeHidden();
  await page.setViewportSize({width:390,height:900});
  await padDialog.getByRole('button',{name:'Insert signature'}).click();
  await page.setViewportSize({width:1084,height:900});
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await expect(page.locator('#certification-name')).toHaveValue('Upgrade signer');
  const signatureBounds=await page.locator('#certification-signature-preview').boundingBox(),buttonBounds=await page.locator('#certification-signature-use').boundingBox();
  assert.ok(signatureBounds.x+signatureBounds.width<=buttonBounds.x,'The signature preview appears left of its buttons');
  assert.equal(signatureBounds.y+signatureBounds.height/2,buttonBounds.y+buttonBounds.height/2);
  const signatureScreenshot=path.join(output,'certification-signature-controls.png');await page.locator('.certification-signature').screenshot({path:signatureScreenshot});evidence.screenshots.push(signatureScreenshot);
  async function insertAgain(){await page.locator('#certification-signature-use').click();const drawing=page.getByRole('dialog',{name:'Signatures',exact:true}),bounds=await drawing.getByLabel('Signature drawing pad').boundingBox();await page.mouse.move(bounds.x+30,bounds.y+60);await page.mouse.down();await page.mouse.move(bounds.x+90,bounds.y+20,{steps:4});await page.mouse.up();await drawing.getByRole('button',{name:'Insert signature',exact:true}).click();await expect(page.locator('#certification-signature-preview')).toBeVisible();}
  await expect(page.locator('#certification-signer-delete')).toHaveCount(0);
  await page.locator('#certification-signature-clear').click();await expect(page.locator('#certification-signature-preview')).toBeHidden();
  for(const key of ['name','position','qualification','accreditation'])await expect(page.locator('#certification-'+key)).toHaveValue('');
  await insertAgain();await expect(page.locator('#certification-name')).toHaveValue('Upgrade signer');
  for(const [key,value] of Object.entries({position:'Fixture position',qualification:'Fixture qualification',accreditation:'Fixture accreditation'}))await page.locator('#certification-'+key).fill(value);
  await page.locator('#certification-approved_design').fill('First design line\nSecond design line');
  await expect(page.locator('#certification-save')).toHaveCount(0);await generateCertificate(page,1);
  const id=await page.locator('#certification-document').inputValue();assert.notEqual(id,old.id);assert.notEqual(id,'');
  const workspaceA=await page.evaluate(()=>window.CeasefireCertification.sessionId());const savedResponse=await fetch(base+'/api/certifications/'+id+'?workspace='+workspaceA);const saved=await savedResponse.json();
  assert.equal(saved.revisions.length,1);assert.equal(saved.options.scopes.length,4);assert.equal(saved.options.cover_pdf,null);assert.ok(saved.options.signature_image.startsWith('data:image/png;base64,'));
  assert.equal(saved.fields.approved_design,'First design line\nSecond design line');
  evidence.checks.push('only untouched defaults refresh','collapsible keyboard scope choices','literal deduplicated scope union','manual paragraph layout retained','signature defaults and document snapshot saved','single-row textarea retains multiline input','Generate persists current details and creates one immutable revision');

  await page.locator('#certification-name').fill('Future certificate signer');
  await page.locator('#certification-position').fill('Project manager');
  await page.locator('#certification-qualification').fill('Literal qualification');
  await page.locator('#certification-accreditation').fill('Literal accreditation');
  await expect(page.locator('#certification-signer-status')).toBeHidden();await idle();
  await fresh();await expect(page.locator('#certification-name')).toHaveValue('');
  await expect(page.locator('#certification-client')).toHaveValue('Changed estimate client');
  await expect(page.locator('#certification-scope-service_penetrations')).not.toBeChecked();
  await expect(page.locator('#certification-signature-preview')).toBeHidden();
  await page.locator('#certification-document').selectOption(id);await expect(page.locator('#certification-client')).toHaveValue('Custom certificate client');
  await expect(page.locator('#certification-name')).toHaveValue('Upgrade signer');
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await page.locator('#certification-approved_design').fill('Unsaved design edit');
  // Dropdown reload recovers only the explicitly saved document text.
  await page.locator('#certification-document').selectOption(id);
  await page.getByRole('button',{name:'Continue without saving',exact:true}).click();
  await expect(page.locator('#certification-approved_design')).toHaveValue('First design line\nSecond design line');
  evidence.checks.push('new signer fields blank until explicit signature insertion','signing fills empty fields from saved Settings','preview left of signing and combined Clear controls','document edits never save Personal Details','New starts unsigned and saved document retains its signature','older saved fields remain unchanged','saved document reload through dropdown');
  for(const width of [1084,390]){
    await page.setViewportSize({width,height:900});await page.locator('#certification-heading').scrollIntoViewIfNeeded();
    const filename=path.join(output,`certification-form-${width}.png`);await page.screenshot({path:filename,fullPage:true});evidence.screenshots.push(filename);
    await page.locator('#certification-scopes summary').click();
    const bounds=await page.locator('.certification-scope-choices').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    await page.locator('#certification-scope-service_penetrations').press('Escape');
  }
  await page.setViewportSize({width:1084,height:900});
  await openProjectSection(page,'quotes');
  const directory=await(await page.request.get(base+'/api/contacts/directory')).json();
  const account=await page.request.post(base+'/api/contacts/accounts',{data:{version:directory.version,fields:{company:'Second certification project'}}});assert.equal(account.status(),200);
  const originalProject=fs.readFileSync(info.project),saveTarget=path.join(info.directory,'save-dialog-target.json');
  fs.writeFileSync(saveTarget,JSON.stringify({file:'second-certification-project.cf.json'}));
  try{await createNewProject(page,{client:'Second certification project','site-address':'Second fixture site'});}finally{fs.unlinkSync(saveTarget);}
  assert.deepEqual(fs.readFileSync(info.project),originalProject,'Creating the second Project keeps the original saved file unchanged');
  await expect(page.locator('#client')).toHaveValue('Second certification project',{timeout:90000});await page.waitForFunction(token=>window.CeasefireCertification.sessionId()!==token,workspaceA);await idle();
  await certification();assert.notEqual(await page.evaluate(()=>window.CeasefireCertification.sessionId()),workspaceA);await expect(page.locator('#certification-document option[value="'+id+'"]')).toHaveCount(0);await fresh();await expect(page.locator('#certification-signature-preview')).toBeHidden();await expect(page.locator('#certification-name')).toHaveValue('');
  await openProjectSection(page,'documentation');
  if(!await coverRow('certification').isVisible())await page.getByRole('button',{name:'Other documents',exact:true}).click();
  await expect(coverRow('certification')).toContainText('synthetic-drawings.pdf');await expect(coverRow('takeoff_markups')).toContainText('synthetic-board.pdf');
  for(const width of [1084,390]){
    await page.setViewportSize({width,height:900});await page.locator('#cover-sheets-heading').scrollIntoViewIfNeeded();
    const filename=path.join(output,`cover-sheets-${width}.png`);await page.screenshot({path:filename,fullPage:true});evidence.screenshots.push(filename);
    const bounds=await page.locator('#cover-sheets-settings .table-scroll').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    const labels=await page.locator('#documentation-pdf-rows tr[data-cover-kind] .documentation-name').evaluateAll(elements=>elements.map(element=>({width:element.clientWidth,scroll:element.scrollWidth,space:getComputedStyle(element).whiteSpace})));
    assert.ok(labels.every(label=>label.space==='normal'&&label.scroll<=label.width+1),'Every download name wraps within its own cell');
  }
  await page.setViewportSize({width:1084,height:900});
  await coverRow('certification').getByRole('button',{name:'Delete cover sheet for Certification',exact:true}).click();await expect(coverRow('certification')).toContainText('Unsaved changes');await clickProjectControl(page,'Save');await expect(coverRow('certification')).toContainText('Cover sheet removed.');
  const afterTrash=await (await fetch(base+'/api/pdf-covers')).json();assert.equal(afterTrash.items.find(item=>item.kind==='certification').has_cover,false);assert.equal(afterTrash.items.find(item=>item.kind==='takeoff_markups').has_cover,true);
  const companyAfter=await (await fetch(base+'/api/company-settings')).json();assert.ok(companyAfter.cover_pdf);assert.equal(companyAfter.cover_pdf_name,'synthetic-drawings.pdf');
  evidence.checks.push('signer image and all cover defaults survive actual New project','Settings cover table fits desktop/mobile','main Save persists only the staged cover removal','main cover retained independently');
  assert.equal(generationRequests.length,1);assert.deepEqual(errors,[]);assert.deepEqual(profileWrites,[]);
  const legacyAfter=await (await fetch(base+'/api/certifications/'+old.id)).json();assert.deepEqual(legacyAfter.revisions,[]);const listResponse=await fetch(base+'/api/certifications?workspace='+workspaceA),list=await listResponse.json();
  for(const item of list.items){
    const response=await fetch(base+'/api/certifications/'+item.id+'?workspace='+workspaceA),doc=await response.json();
    assert.equal(doc.revisions.length,1);
    const frozen=await fetch(base+doc.revisions[0].pdf_url);assert.equal(frozen.status,200);
    assert.equal(createHash('sha256').update(Buffer.from(await frozen.arrayBuffer())).digest('hex'),saved.revisions[0].sha256,'Clearing cover settings and changing projects retain the original generated PDF');
  }
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({...evidence,passed:true,generatedCertificateRevisions:generationRequests.length,errors},null,2));
  console.log('PASS: Certification defaults, signature, scope union, Settings covers, New project preservation and viewport fit. '+output);
})().catch(async error=>{console.error(error);console.error(logs);console.error(JSON.stringify([...pendingRequests].map(([request,start])=>({url:request.url(),elapsedMs:Date.now()-start}))));if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));console.error(JSON.stringify(errors));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
