// Real authored exports and portable current-project history on private storage.
const {chromium,expect}=require('@playwright/test');
const {openProjectSection,clickProjectControl}=require('./project_actions.cjs');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`project-documentation-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'project_documentation_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,info,base;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture startup timeout')),120000);
  server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]));}catch(error){reject(error);}}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+': '+logs));});});
const errors=[],consoleErrors=[],checks=[],exportReceipts=[],sourceRequests=[],projectMutations=[];const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceFiles=['static/documentation.js','static/documentation.css','static/app.js','static/downloads.js','static/calculators.js','static/penetration.js','static/takeoffs.js',
  'static/libraries.js','static/library-editor.js','static/certification.js','static/index.html','estimator/server.py','estimator/project_documentation.py',
  'estimator/documentation_catalog.py','estimator/certification_projects.py','estimator/project_library.py','estimator/project_file.py','scripts/build_windows.py'];
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,digest(fs.readFileSync(path.join(root,file)))]));
const choose=file=>fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({file}));
async function idle(){await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;},null,{timeout:180000});}
async function api(route){const response=await page.request.get(base+route);assert.equal(response.status(),200,await response.text());return response.json();}
async function documentation(){await openProjectSection(page,'documentation');await expect(page.locator('#documentation-pdf-rows button')).not.toHaveCount(0,{timeout:30000});await idle();}
async function snapshots(){return page.evaluate(()=>({calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),
  configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));}
async function save(){const waiting=page.waitForResponse(response=>response.request().method()==='POST'&&/^\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname),{timeout:180000});
  waiting.catch(()=>{});await clickProjectControl(page,'Save');const response=await waiting;assert.equal(response.status(),200,await response.text());const result=await response.json();
  assert.equal(result.cancelled,false,JSON.stringify(result));assert.ok(result.file?.save_token);await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:180000});await idle();return {result,payload:response.request().postDataJSON()};}
async function oldFile(item,scope){const response=await page.request.get(base+'/api/documentation/'+item.id+'?workspace='+scope);assert.equal(response.status(),200,await response.text());
  const bytes=await response.body();assert.equal(digest(bytes),item.sha256);assert.equal(bytes.length,item.size);return bytes;}
async function holdFinalHistory(trigger){
  let release,entered,timer,heldRequest=Promise.resolve(),routeError=null;const gate=new Promise(resolve=>{release=resolve;}),arrival=new Promise(resolve=>{entered=resolve;}),matcher=/\/api\/documentation\?workspace=/;let held=false;
  await page.route(matcher,route=>{
    const first=!held;if(first)held=true;
    const handling=(async()=>{if(first){entered();await gate;}await route.continue();})().catch(error=>{routeError=error;});
    if(first)heldRequest=handling;return handling;
  });
  try{await trigger();await Promise.race([arrival,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The source export did not refresh its captured history.')),60000);})]);
    assert.equal(await page.evaluate(()=>window.CeasefireDocumentation.hasPendingOperation()),true);const mutations=projectMutations.length,scope=await page.evaluate(()=>window.CeasefireCertification.sessionId());
    await page.locator('#save-current-project').click();await expect(page.locator('#app-message')).toHaveText('Finish the current document download before saving the project.');
    await openProjectSection(page,'quotes');await page.locator('#new-quote').click();await expect(page.locator('#app-message')).toHaveText('Finish the current document download before replacing a project.');
    assert.equal(await page.evaluate(()=>window.CeasefireCertification.sessionId()),scope);assert.equal(projectMutations.length,mutations);await expect(page.locator('#client')).toHaveValue('SYNTHETIC DOCUMENTATION QA');
    checks.push('Save and New are blocked while the final captured history response is still pending, without replacing the project');
  }finally{clearTimeout(timer);release();await heldRequest;await page.unroute(matcher);}
  if(routeError)throw routeError;
}
async function download(kind,endpoint,{reviewPending=false}={}){await documentation();const before=await snapshots(),savedBefore=fs.readFileSync(info.project);
  const waiting=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===endpoint,{timeout:180000});waiting.catch(()=>{});
  const trigger=()=>page.locator(`button[data-document-kind="${kind}"]`).click();if(reviewPending)await holdFinalHistory(trigger);else await trigger();const response=await waiting;assert.equal(response.status(),200,await response.text());const saved=await response.json();
  assert.equal(saved.saved,true);assert.ok(saved.documentation?.item,JSON.stringify(saved));assert.equal(saved.documentation.item.kind,kind);
  const relative=path.relative(output,saved.path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Generated export stays inside private fixture');
  const bytes=fs.readFileSync(saved.path),item=saved.documentation.item;assert.equal(digest(bytes),item.sha256);
  assert.equal(bytes.subarray(0,kind.endsWith('.xlsx')?2:5).toString(),kind.endsWith('.xlsx')?'PK':'%PDF-');
  await expect(page.locator(`tr[data-document-kind="${kind}"] a`)).toHaveCount(item.revision,{timeout:30000});await idle();
  assert.deepEqual(await snapshots(),before,'An export retains all calculator inputs, price snapshots, schedule data and project details');
  assert.equal(digest(fs.readFileSync(info.project)),digest(savedBefore),'Generating a document does not silently overwrite the saved project');
  assert.deepEqual(await oldFile(item,saved.documentation.workspace_id),bytes);exportReceipts.push({kind,revision:item.revision,path:saved.path,sha256:item.sha256});return item;}
async function confirmIfNeeded(){const dialog=page.locator('#discard-dialog');if(await dialog.isVisible())await dialog.locator('[value="confirm"]').click();}
async function load(file){choose(file);await openProjectSection(page,'quotes');const waiting=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/open',{timeout:180000});waiting.catch(()=>{});
  await page.locator('#load-project').click();const response=await waiting;assert.equal(response.status(),200,await response.text());
  await expect(page.locator('#discard-dialog')).toBeVisible({timeout:180000});await confirmIfNeeded();await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:180000});await idle();}
function publicHistory(model){return model.items.map(({url,...item})=>item).sort((a,b)=>a.id.localeCompare(b.id));}
function checkCompanions(project,folder){
  const manifest=project.documentation;assert.ok(manifest);const documentRoot=path.join(folder,manifest.companion_folder),manifestPath=path.join(documentRoot,manifest.manifest_sha256+'.json');
  const bytes=fs.readFileSync(manifestPath);assert.equal(digest(bytes),manifest.manifest_sha256);assert.equal(bytes.length,manifest.manifest_size);
  const metadata=JSON.parse(bytes);assert.equal(metadata.workspace_revision,3);for(const item of metadata.revisions){const file=path.join(documentRoot,'blobs',item.sha256+(item.media_type==='application/pdf'?'.pdf':'.xlsx'));
    assert.equal(digest(fs.readFileSync(file)),item.sha256);}
  const certificates=project.certifications;assert.equal(certificates.document_count,1);assert.equal(certificates.revision_count,1);
  const archive=path.join(folder,certificates.companion_folder,certificates.archive_sha256+'.zip');assert.equal(digest(fs.readFileSync(archive)),certificates.archive_sha256);
}
(async()=>{
  info=await ready;assert.notEqual(info.port,8765);base='http://127.0.0.1:'+info.port;
  browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_EXECUTABLE?{executablePath:process.env.CEASEFIRE_BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{if(request.method()==='POST'&&/\/(?:report\.pdf|quote-report|template|item\.(?:pdf|xlsx)|register\.xlsx|revisions)$/.test(new URL(request.url()).pathname))sourceRequests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  page.on('request',request=>{if(request.method()==='POST'&&/^\/api\/(?:project\/(?:save|save-as|open)|certifications\/workspaces)$/.test(new URL(request.url()).pathname))projectMutations.push(new URL(request.url()).pathname);});
  await page.goto(base+'/');await idle();await page.locator('#estimate-navigation-toggle').click();
  await page.locator('#client').fill('SYNTHETIC DOCUMENTATION QA');await page.locator('#project-no').fill('DOC-PROJECT-A');await page.locator('#site-address').fill('Synthetic test address - no installation claim');
  choose('project-a.cf.json');await save();console.log('Project A saved on disposable storage.');const baseline=await snapshots();
  await documentation();const catalog=(await api('/api/documentation/catalog')).documents;
  const omittedPdfRows=new Set(['firestopping.current_item.pdf','library.technical.item.pdf','takeoff.pdf_tools.pdf']);
  await expect(page.locator('#documentation-pdf-rows tr')).toHaveCount(catalog.filter(row=>row.format==='pdf'&&!omittedPdfRows.has(row.id)).length);
  for(const kind of omittedPdfRows)await expect(page.locator(`tr[data-document-kind="${kind}"]`)).toHaveCount(0);
  await expect(page.locator('#documentation-xlsx-rows tr')).toHaveCount(catalog.filter(row=>row.format==='xlsx').length);
  assert.ok(catalog.some(row=>row.id==='firestopping.current_item.pdf'));assert.ok(!catalog.some(row=>row.id==='library.firestopping.item.pdf'));
  await expect(page.locator('#documentation-pdf-rows a,#documentation-xlsx-rows a')).toHaveCount(0);checks.push('PDF rows omit the three removed downloads while XLSX rows and server export identities remain available');
  const a=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  const estimateOne=await download('estimate.summary.pdf','/api/quote-report',{reviewPending:true});const firstBytes=await oldFile(estimateOne,a);
  const estimateTwo=await download('estimate.summary.pdf','/api/quote-report');assert.equal(estimateOne.revision,1);assert.equal(estimateTwo.revision,2);assert.notEqual(estimateOne.id,estimateTwo.id);
  const template=await download('calculator.steel_board.template.xlsx','/api/calculators/steel_board/template');assert.equal(template.revision,1);
  assert.deepEqual(await snapshots(),baseline);checks.push('Two real PDF revisions and one real XLSX use original validated exporters with all calculation data unchanged');

  // Certification is an existing validated preparation workflow, not a second
  // renderer or an unreviewed auto-filled compliance statement.
  await page.locator('button[data-document-kind="certification"]').click();await expect(page.locator('#view-certification')).toBeVisible();await idle();
  const required=['client','project','address','location_area','statement_of_compliance','australian_standards','ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers','fire_resistance_level'];
  for(const field of required)await page.locator('#certification-'+field).fill(field==='client'?'SYNTHETIC DOCUMENTATION QA':'N/A - synthetic browser fixture');
  await page.locator('#certification-generate').click();await expect(page.locator('#certification-status')).toContainText('Revision 1 saved',{timeout:60000});await idle();
  const certificateId=await page.locator('#certification-document').inputValue();assert.ok(certificateId);
  await documentation();await expect(page.locator('tr[data-document-kind="certification"] a')).toHaveCount(1);const historyA=await api('/api/documentation?workspace='+a);
  assert.equal(historyA.workspace_revision,3);assert.equal(historyA.items.length,4);assert.equal(historyA.items.filter(item=>item.kind==='certification').length,1);
  const readBefore=publicHistory(historyA);for(const item of historyA.items)await oldFile(item,a);
  assert.deepEqual(publicHistory(await api('/api/documentation?workspace='+a)),readBefore);assert.deepEqual(await oldFile(estimateOne,a),firstBytes);
  checks.push('Current-project certificate appears without copying it into a second store; opening old PDFs/XLSX adds no revision');

  const savedA=await save(),projectA=JSON.parse(fs.readFileSync(info.project));checkCompanions(projectA,output);assert.equal(projectA.documentation.revision_count,3);
  const originalHash=digest(fs.readFileSync(info.project));
  // Save As is a native API operation; the application intentionally has a
  // single Save button. Reuse its exact reviewed capture, with a second private
  // dialog destination, rather than inventing another snapshot implementation.
  const {save_token:_destination,...saveAsCapture}=savedA.payload;
  choose('portable/project-copy.cf.json');const copyReply=await page.request.post(base+'/api/project/save-as',{data:saveAsCapture});assert.equal(copyReply.status(),200,await copyReply.text());
  const copyReceipt=await copyReply.json();assert.equal(copyReceipt.cancelled,false);const copyPath=path.join(output,'portable','project-copy.cf.json');assert.ok(fs.existsSync(copyPath));
  const copied=JSON.parse(fs.readFileSync(copyPath));assert.deepEqual(copied.documentation,projectA.documentation);assert.deepEqual(copied.certifications,projectA.certifications);checkCompanions(copied,path.dirname(copyPath));
  const copiedHash=digest(fs.readFileSync(copyPath));const moved=path.join(output,'moved');fs.renameSync(path.join(output,'portable'),moved);checkCompanions(copied,moved);assert.equal(digest(fs.readFileSync(info.project)),originalHash);
  checks.push('Native Save and Save As publish exact hash-verified document/certificate companions, portable together to another folder');

  await openProjectSection(page,'quotes');await page.locator('#new-quote').click();await confirmIfNeeded();await expect(page.locator('#client')).toHaveValue('',{timeout:180000});await idle();await documentation();
  const b=await page.evaluate(()=>window.CeasefireCertification.sessionId());assert.notEqual(b,a);await expect(page.locator('#documentation-pdf-rows a,#documentation-xlsx-rows a')).toHaveCount(0);
  assert.deepEqual((await api('/api/documentation?workspace='+b)).items,[]);
  for(const item of historyA.items){const foreign=await page.request.get(base+'/api/documentation/'+item.id+'?workspace='+b);assert.equal(foreign.status(),404);}
  await openProjectSection(page,'certification');await expect(page.locator(`#certification-document option[value="${certificateId}"]`)).toHaveCount(0);
  checks.push('New Project B starts empty and cannot read any Project A document or certificate through its own scope');
  await load('moved/project-copy.cf.json');await expect(page.locator('#client')).toHaveValue('SYNTHETIC DOCUMENTATION QA');await documentation();
  const restored=await page.evaluate(()=>window.CeasefireCertification.sessionId());assert.notEqual(restored,a);assert.notEqual(restored,b);
  const after=await api('/api/documentation?workspace='+restored);assert.equal(after.project_id,historyA.project_id);assert.deepEqual(publicHistory(after),readBefore);
  await expect(page.locator('tr[data-document-kind="estimate.summary.pdf"] a')).toHaveCount(2);await expect(page.locator('tr[data-document-kind="calculator.steel_board.template.xlsx"] a')).toHaveCount(1);
  for(const item of after.items)await oldFile(item,restored);assert.deepEqual(await oldFile(estimateOne,restored),firstBytes);
  await openProjectSection(page,'certification');await expect(page.locator('#certification-document')).toHaveValue(certificateId);await expect(page.locator('#certification-revisions a')).toHaveCount(1);
  await documentation();assert.equal((await api('/api/documentation?workspace='+restored)).workspace_revision,3);assert.equal(digest(fs.readFileSync(path.join(moved,'project-copy.cf.json'))),copiedHash);
  checks.push('Loading the moved project restores all immutable links, revision numbers, exact file hashes and only its own certificate');
  for(const width of [1280,671,390]){await page.setViewportSize({width,height:1000});await expect(page.locator('#documentation-heading')).toBeVisible();
    await page.screenshot({path:path.join(output,'documentation-'+width+'.png'),fullPage:true});}
  // Cold calculator loads are allowed; each authored document invokes exactly
  // its existing source export once, and old-history reads invoke none.
  assert.equal(sourceRequests.filter(request=>request.path==='/api/quote-report').length,2);
  assert.equal(sourceRequests.filter(request=>request.path==='/api/calculators/steel_board/template').length,1);
  assert.equal(sourceRequests.filter(request=>/^\/api\/certifications\/.+\/revisions$/.test(request.path)).length,1);
  assert.deepEqual(Object.fromEntries(sourceFiles.map(file=>[file,digest(fs.readFileSync(path.join(root,file)))])),sourceHashes,'Production sources stayed fixed for this browser receipt');
  assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,exports:exportReceipts,sourceRequests,sourceHashes,project:info.project,movedProject:path.join(moved,'project-copy.cf.json'),errors,consoleErrors},null,2));
  console.log('PASS: Project Documentation real PDF/XLSX revisions, current-project isolation and native portable Save/Load. '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));console.error(await page.locator('#documentation-status').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),checks,exports:exportReceipts,sourceRequests,sourceHashes,errors,consoleErrors},null,2));process.exitCode=1;})
  .finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
