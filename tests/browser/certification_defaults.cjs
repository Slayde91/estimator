// Disposable lifecycle coverage. This fixture never generates a certificate PDF.
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa',`certification-defaults-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{
  let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});
});
const errors=[],generationRequests=[],evidence={checks:[],screenshots:[]};
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
async function certification(){await page.locator('#projects-navigation-toggle').click();await page.locator('#view-projects [data-project-section="certification"]').click();await expect(page.locator('#certification-client')).toBeEnabled();}
async function fresh(){await page.locator('#certification-document').selectOption('');const confirm=page.getByRole('button',{name:'Continue without saving',exact:true});if(await confirm.isVisible())await confirm.click();await expect(page.locator('#certification-document')).toHaveValue('__draft__');}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  // Seed an older draft and separate signer preferences; no PDF/revision is
  // produced. Entering Certification must not load the old document's fields.
  const created=await fetch(base+'/api/certifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{client:'Old saved client',project:'Old saved project',statement_of_compliance:'Old saved statement',name:'Upgrade signer'},request_id:randomUUID()})});
  assert.equal(created.status,201);const old=await created.json();
  const preferencesResponse=await fetch(base+'/api/certifications/defaults'),preferences=await preferencesResponse.json();
  const savedPreferences=await fetch(base+'/api/certifications/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{name:'Upgrade signer',position:'',qualification:'',accreditation:''},expected_version:preferences.version})});
  assert.equal(savedPreferences.status,200);
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_EXECUTABLE?{executablePath:process.env.CEASEFIRE_BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1084,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/certifications/*/revisions',async route=>{generationRequests.push(route.request().url());await route.abort();});
  await page.goto(base+'/');await idle();
  await page.locator('#estimate-navigation-toggle').click();
  await page.locator('#client').fill('Current estimate client');await page.locator('#site-address').fill('Current estimate address');await page.locator('#project-no').fill('CF-2042');
  await certification();
  await expect(page.locator('#certification-document')).toHaveValue('__draft__');
  await expect(page.locator('#certification-client')).toHaveValue('Current estimate client');
  await expect(page.locator('#certification-address')).toHaveValue('Current estimate address');
  await expect(page.locator('#certification-exclusions')).toHaveValue('Project No.: CF-2042');
  await expect(page.locator('#certification-name')).toHaveValue('Upgrade signer');
  await expect(page.locator('#certification-statement_of_compliance')).toHaveValue("This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule. All materials have been installed at the above location and comply with:");
  await expect(page.locator('#certification-new, #certification-reload')).toHaveCount(0);
  await expect(page.locator('#certification-cover-pdf')).toHaveCount(0);
  for(const name of ['approved_design','additional_standards','other_references']){
    await expect(page.locator('#certification-'+name)).toHaveValue('N/A');await expect(page.locator('#certification-'+name)).toHaveAttribute('rows','1');
  }
  await page.locator('#certification-location_area').fill('First current draft');await fresh();
  await expect(page.locator('#certification-location_area')).toHaveValue('');
  await page.locator('#certification-location_area').fill('Second current draft');await fresh();
  await expect(page.locator('#certification-location_area')).toHaveValue('');
  evidence.checks.push('Estimates/default literal prefill','no latest-document auto-load','repeated native New action','removed buttons','no certificate-local cover section','three fresh N/A fields remain multiline-capable');

  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const coverRow=kind=>page.locator('#cover-sheets-rows tr[data-cover-kind="'+kind+'"]');
  await expect(page.locator('#cover-sheets-rows tr')).toHaveCount(18);
  const kindsResponse=await fetch(base+'/api/pdf-covers'),kinds=await kindsResponse.json();
  assert.ok(kinds.items.every(item=>!Object.hasOwn(item,'cover_pdf')&&typeof item.has_cover==='boolean'));
  await expect(coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true})).toBeDisabled();
  await coverRow('certification').locator('input').setInputFiles(info.fixture);
  await expect(coverRow('certification')).toContainText('synthetic-drawings.pdf');
  await coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true}).click();
  await expect(coverRow('certification')).toContainText('Cover sheet saved.');
  await coverRow('takeoff_markups').locator('input').setInputFiles(info.board_fixture);
  await coverRow('takeoff_markups').getByRole('button',{name:'Save cover sheet for Takeoff markups',exact:true}).click();
  await expect(coverRow('takeoff_markups')).toContainText('Cover sheet saved.');
  const beforeConflict=await (await fetch(base+'/api/pdf-covers')).json(),certificationCover=beforeConflict.items.find(item=>item.kind==='certification');
  const otherWindow=await fetch(base+'/api/pdf-covers/certification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cover_pdf:'data:application/pdf;base64,'+fs.readFileSync(info.fixture).toString('base64'),cover_pdf_name:'Other window cover.pdf',expected_version:certificationCover.version})});
  assert.equal(otherWindow.status,200);await coverRow('certification').locator('input').setInputFiles(info.fixture);
  await coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true}).click();await expect(coverRow('certification')).toContainText('changed in another window');
  await coverRow('certification').getByRole('button',{name:'Delete cover sheet for Certification',exact:true}).click();await page.getByRole('dialog',{name:'Cover sheet changed',exact:true}).getByRole('button',{name:'Keep editing',exact:true}).click();
  await expect(coverRow('certification')).toContainText('Cover sheet: synthetic-drawings.pdf');await expect(coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true})).toBeEnabled();
  const afterCancel=await (await fetch(base+'/api/pdf-covers')).json();assert.equal(afterCancel.items.find(item=>item.kind==='certification').cover_pdf_name,'Other window cover.pdf');
  await coverRow('certification').getByRole('button',{name:'Save cover sheet for Certification',exact:true}).click();await page.getByRole('dialog',{name:'Cover sheet changed',exact:true}).getByRole('button',{name:'Apply cover-sheet change',exact:true}).click();await expect(coverRow('certification')).toContainText('Cover sheet saved.');
  await page.locator('#company-cover-pdf').setInputFiles(info.fixture);await page.locator('#company-settings-save').click();await expect(page.locator('#company-settings-status')).toHaveText('Saved');
  const initialCovers=await (await fetch(base+'/api/pdf-covers')).json();
  assert.equal(initialCovers.items.find(item=>item.kind==='certification').has_cover,true);
  assert.equal(initialCovers.items.find(item=>item.kind==='takeoff_markups').has_cover,true);
  evidence.checks.push('18 independent Settings cover rows','saved cover metadata excludes PDF bytes','main and specific covers saved independently','stale cover Save blocks silent overwrite','cancelled conflicted Trash retains selected file','explicit approved conflict retry uses current version');
  await certification();

  await page.locator('#certification-client').fill('Custom certificate client');
  await page.locator('#certification-statement_of_compliance').fill('Custom statement retained');
  await page.locator('#estimate-navigation-toggle').click();
  await page.locator('#client').fill('Changed estimate client');await page.locator('#site-address').fill('Changed estimate address');await page.locator('#project-no').fill('CF-2043');
  await certification();
  await expect(page.locator('#certification-client')).toHaveValue('Custom certificate client');
  await expect(page.locator('#certification-statement_of_compliance')).toHaveValue('Custom statement retained');
  await expect(page.locator('#certification-address')).toHaveValue('Changed estimate address');
  await expect(page.locator('#certification-exclusions')).toHaveValue('Project No.: CF-2043');
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
  const signaturePath=path.join(output,'synthetic-signature.png');
  const drawn=spawnSync(process.env.CEASEFIRE_PYTHON||'python',['-c',"from PIL import Image,ImageDraw;import sys;im=Image.new('RGB',(120,36),'white');ImageDraw.Draw(im).line([(7,26),(30,8),(25,28),(55,13),(76,24),(112,14)],fill='black',width=2);im.save(sys.argv[1])",signaturePath],{encoding:'utf8',windowsHide:true});
  assert.equal(drawn.status,0,drawn.stderr);
  await page.locator('#certification-signature-image').setInputFiles(signaturePath);
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await expect(page.locator('#certification-signer-status')).toHaveText('Signer details saved for future certificates.');
  await page.locator('#certification-approved_design').fill('First design line\nSecond design line');
  await page.locator('#certification-save').click();await expect(page.locator('#certification-status')).toHaveText('Certification details saved.');
  const id=await page.locator('#certification-document').inputValue();assert.notEqual(id,old.id);assert.notEqual(id,'__draft__');
  const savedResponse=await fetch(base+'/api/certifications/'+id);const saved=await savedResponse.json();
  assert.equal(saved.revisions.length,0);assert.equal(saved.options.scopes.length,4);assert.equal(saved.options.cover_pdf,null);assert.ok(saved.options.signature_image.startsWith('data:image/png;base64,'));
  assert.equal(saved.fields.approved_design,'First design line\nSecond design line');
  evidence.checks.push('only untouched defaults refresh','collapsible keyboard scope choices','literal deduplicated scope union','manual paragraph layout retained','signature defaults and document snapshot saved','single-row textarea retains multiline input','draft saved without a revision');

  await page.locator('#certification-name').fill('Future certificate signer');
  await page.locator('#certification-position').fill('Project manager');
  await page.locator('#certification-qualification').fill('Literal qualification');
  await page.locator('#certification-accreditation').fill('Literal accreditation');
  await expect(page.locator('#certification-signer-status')).toHaveText('Signer details saved for future certificates.');await idle();
  await fresh();await expect(page.locator('#certification-name')).toHaveValue('Future certificate signer');
  await expect(page.locator('#certification-client')).toHaveValue('Changed estimate client');
  await expect(page.locator('#certification-scope-service_penetrations')).not.toBeChecked();
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await page.locator('#certification-document').selectOption(id);await expect(page.locator('#certification-client')).toHaveValue('Custom certificate client');
  await expect(page.locator('#certification-name')).toHaveValue('Upgrade signer');
  await expect(page.locator('#certification-signature-preview')).toBeVisible();
  await page.locator('#certification-approved_design').fill('Unsaved design edit');
  // Dropdown reload recovers only the explicitly saved document text.
  await page.locator('#certification-document').selectOption('__reload__');
  await page.getByRole('button',{name:'Continue without saving',exact:true}).click();
  await expect(page.locator('#certification-approved_design')).toHaveValue('First design line\nSecond design line');
  evidence.checks.push('signer and signature defaults auto-save globally','New inherits signer image','older saved fields remain unchanged','saved document reload through dropdown');
  for(const width of [1084,390]){
    await page.setViewportSize({width,height:900});await page.locator('#certification-heading').scrollIntoViewIfNeeded();
    const filename=path.join(output,`certification-form-${width}.png`);await page.screenshot({path:filename,fullPage:true});evidence.screenshots.push(filename);
    await page.locator('#certification-scopes summary').click();
    const bounds=await page.locator('.certification-scope-choices').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    await page.locator('#certification-scope-service_penetrations').press('Escape');
  }
  await page.setViewportSize({width:1084,height:900});
  await page.locator('nav .nav-button[data-view="projects"]').click();await page.locator('#view-projects [data-project-section="quotes"]').click();
  await page.locator('#new-quote').click();await page.getByRole('dialog').getByRole('button',{name:'New project',exact:true}).click();await idle();
  await certification();await fresh();await expect(page.locator('#certification-signature-preview')).toBeVisible();await expect(page.locator('#certification-name')).toHaveValue('Future certificate signer');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(coverRow('certification')).toContainText('synthetic-drawings.pdf');await expect(coverRow('takeoff_markups')).toContainText('synthetic-board.pdf');
  for(const width of [1084,390]){
    await page.setViewportSize({width,height:900});await page.locator('#cover-sheets-heading').scrollIntoViewIfNeeded();
    const filename=path.join(output,`cover-sheets-${width}.png`);await page.screenshot({path:filename,fullPage:true});evidence.screenshots.push(filename);
    const bounds=await page.locator('.cover-sheets-table').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    const labels=await page.locator('#cover-sheets-rows th').evaluateAll(elements=>elements.map(element=>({width:element.clientWidth,scroll:element.scrollWidth,space:getComputedStyle(element).whiteSpace})));
    assert.ok(labels.every(label=>label.space==='normal'&&label.scroll<=label.width+1),'Every download name wraps within its own cell');
  }
  await page.setViewportSize({width:1084,height:900});
  await coverRow('certification').getByRole('button',{name:'Delete cover sheet for Certification',exact:true}).click();await expect(coverRow('certification')).toContainText('Cover sheet removed.');
  const afterTrash=await (await fetch(base+'/api/pdf-covers')).json();assert.equal(afterTrash.items.find(item=>item.kind==='certification').has_cover,false);assert.equal(afterTrash.items.find(item=>item.kind==='takeoff_markups').has_cover,true);
  const companyAfter=await (await fetch(base+'/api/company-settings')).json();assert.ok(companyAfter.cover_pdf);assert.equal(companyAfter.cover_pdf_name,'synthetic-drawings.pdf');
  evidence.checks.push('signer image and all cover defaults survive actual New project','Settings cover table fits desktop/mobile','Trash persists only the selected cover removal','main cover retained independently');
  assert.deepEqual(generationRequests,[]);assert.deepEqual(errors,[]);
  const listResponse=await fetch(base+'/api/certifications'),list=await listResponse.json();
  for(const item of list.items){const response=await fetch(base+'/api/certifications/'+item.id),doc=await response.json();assert.deepEqual(doc.revisions,[]);}
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({...evidence,passed:true,generatedCertificateRevisions:0,errors},null,2));
  console.log('PASS: Certification defaults, signature, scope union, Settings covers, New project preservation and viewport fit. '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
