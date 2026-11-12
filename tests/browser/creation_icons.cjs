'use strict';
// Exercise real controls and exporters on private synthetic storage only.
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createNewProject,openProjectSection,clickProjectControl}=require('./project_actions.cjs');
const {chooseLibrary}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','creation-icons-'+Date.now());fs.mkdirSync(output,{recursive:true});
const fixture=path.join(__dirname,'project_library_fixture.py'),python=process.env.CEASEFIRE_PYTHON||'python';
const server=spawn(python,[fixture,'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,info,base;server.stderr.on('data',x=>logs+=x);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
 server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});
 server.stdout.on('data',x=>{text+=x;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});});
const checks=[],errors=[],exportReceipts=[],sha=value=>createHash('sha256').update(value).digest('hex');
const owned=['contacts.js','commercial-documents.js','commercial-panels.js','swms.js','documentation.js'];
const sources=Object.fromEntries(owned.map(file=>[file,sha(fs.readFileSync(path.join(root,'static',file)))]));
async function idle(target=page){await target.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);await target.evaluate(()=>window.ClassifireAccess.ready);}
async function contacts(target,kind){await target.locator('#contacts-navigation-toggle').hover();await target.locator(`#contacts-navigation-menu [data-contacts-section="${kind}"]`).click();await expect(target.locator('#contacts-root .contacts-controls')).toBeVisible();}
async function plus(control,name,{disabled=false,size=48}={}){
 await expect(control).toHaveAttribute('aria-label',name);await expect(control).toHaveAttribute('title',name);
 await expect(control.locator('.button-symbol[aria-hidden="true"]')).toHaveText('+');
 assert.equal(await control.getAttribute('data-i18n'),null,'Translation never replaces the visible plus');
 // The directory refresh can replace the control between locating it and measuring it.
 await expect.poll(()=>control.evaluate(button=>{
   if(!button.isConnected)return false;
   const reference=document.getElementById('penetration-estimator-add');
   const appearance=node=>{
     const icon=getComputedStyle(node.firstElementChild);
     return [getComputedStyle(node).borderRadius,icon.fontFamily,icon.fontSize,icon.fontWeight,icon.lineHeight];
   };
   const box=button.getBoundingClientRect(),symbol=button.firstElementChild.getBoundingClientRect();
   return {styleMatches:appearance(button).every((value,index)=>value===appearance(reference)[index]),
     centredX:Math.abs(symbol.x+symbol.width/2-box.x-box.width/2)<=1,centredY:Math.abs(symbol.y+symbol.height/2-box.y-box.height/2)<=1};
 }),{message:name}).toEqual({styleMatches:true,centredX:true,centredY:true});
 const box=await control.boundingBox();assert.equal(box.width,size);assert.equal(box.height,size);
 if(disabled)await expect(control).toBeDisabled();else await expect(control).toBeEnabled();
}
async function cancelDraft(host,back){await host.getByRole('button',{name:back,exact:true}).first().click();const confirm=page.locator('#discard-dialog');if(await confirm.isVisible())await confirm.locator('[value="confirm"]').click();}
async function breakdownButton(control,disabled=false){
 await expect(control).toHaveAccessibleName('Download Breakdown');await expect(control).toHaveAttribute('title','Download Breakdown');
 await expect(control.locator('.download-format-icon[aria-hidden="true"]')).toHaveText('⇩PDF');
 const box=await control.boundingBox();assert.equal(box.width,52);assert.equal(box.height,44);
 if(disabled)await expect(control).toBeDisabled();else await expect(control).toBeEnabled();
}
function libraryStorage(){const reply=spawnSync(python,[fixture,'--snapshot-database',info.database],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(reply.status,0,reply.stderr);return Object.fromEntries(Object.entries(JSON.parse(reply.stdout)).filter(([name])=>name==='settings'||name.startsWith('firestopping_')||name.startsWith('technical_')));}
function libraryFiles(){const directory=path.dirname(path.dirname(info.diagram)),files={};function visit(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const target=path.join(folder,entry.name);if(entry.isDirectory())visit(target);else if(entry.isFile())files[path.relative(directory,target)]=sha(fs.readFileSync(target));}}visit(directory);return files;}
(async()=>{
 info=await ready;assert.notEqual(info.port,8765);base='http://127.0.0.1:'+info.port;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1915,height:1000}});page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 const read=async route=>{const r=await context.request.get(base+route);assert.equal(r.status(),200,await r.text());return r.json();};
 async function post(route,data){const session=await read('/api/access/session'),headers=session.user?{'X-CRM-Member':session.user.id}:{};const r=await context.request.post(base+route,{data,headers});assert.equal(r.status(),200,await r.text());return r.json();}
 await page.goto(base);await idle();
 await chooseLibrary(page,'pricing');await plus(page.locator('#add-pricing-item'),'+ Add item');
 await chooseLibrary(page,'technical');await plus(page.getByRole('button',{name:'Add Technical Library item',exact:true}),'Add Technical Library item');
 const originalDirectory=await read('/api/contacts/directory');
 for(const [kind,name] of [['leads','New Lead'],['contacts','New Contact'],['accounts','New Company']]){
  await contacts(page,kind);const control=page.locator('#contacts-root .contacts-controls .add-icon-action');await plus(control,name);await control.click();
  const dialog=page.getByRole('dialog',{name,exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
 }
 assert.deepEqual(await read('/api/contacts/directory'),originalDirectory);
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('es',false));
 const translated=page.locator('#contacts-root .contacts-controls .add-icon-action');await expect(translated.locator('.button-symbol')).toHaveText('+');assert.notEqual(await translated.getAttribute('aria-label'),'New Company');
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await plus(translated,'New Company');
 checks.push('All three directory creation controls are accessible red plus buttons; real cancelled dialogs create no records and language changes retain the glyph.');
 const sections=[['quote','New Quote','#commercial-quote-root','Back to Quotes'],['work-orders','New Work Order','#commercial-work-order-root','Back to Work Orders'],['purchase-orders','New Purchase Order','#commercial-purchase-order-root','Back to Purchase Orders']];
 let defaults=0;const countDefaults=request=>{if(request.method()==='POST'&&/\/api\/(?:commercial|swms)\/defaults$/.test(new URL(request.url()).pathname))defaults++;};page.on('request',countDefaults);
 for(const [section,name,selector] of sections){await openProjectSection(page,section);const host=page.locator(selector),control=host.getByRole('button',{name,exact:true});await plus(control,name,{size:42});
  const sort=host.getByLabel("Sort by",{exact:true});assert.equal((await sort.boundingBox()).height,(await control.boundingBox()).height);await control.click();await expect(page.locator('#app-message')).toContainText('Create or load a project');await expect(host.locator('.commercial-editor')).toHaveCount(0);}
 await openProjectSection(page,'swms');await plus(page.getByRole('button',{name:'New SWMS',exact:true}),'New SWMS');await page.getByRole('button',{name:'New SWMS',exact:true}).click();assert.equal(defaults,0);page.off('request',countDefaults);
 checks.push('Commercial and SWMS creation buttons retain their unsaved-project guard and start no defaults/export operation without a Project.');
 const create=async(kind,fields)=>post('/api/contacts/'+kind,{version:(await read('/api/contacts/directory')).version,fields});
 const company=(await create('accounts',{company:'Icon Fixture Builder',billing_address:'Private fixture office',abn_acn:'ICON'})).account;
 const primary=(await create('contacts',{name:'Icon Primary',company:company.company,phone:'111',email:'primary@example.test'})).contact;
 const participant=(await create('contacts',{name:'Icon Participant',company:company.company,phone:'222',email:'participant@example.test'})).contact;
 await createNewProject(page,{client:company.company,contact_name:primary.name,contact_phone:primary.phone,contact_email:primary.email});
 await page.getByRole('button',{name:'Libraries',exact:true}).click();await chooseLibrary(page,'penetration');await page.locator(`[data-library-edit="${info.item_id}"]`).first().click();await expect(page.locator('#firestopping-library-editor')).toBeVisible();
 await page.locator('[data-library-editor-field="T"]').fill('Icon Project local record with original PNG');
 const localSave=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/project/save');await clickProjectControl(page,'Save');const localSaved=await localSave;assert.equal(localSaved.status(),200,await localSaved.text());await idle();
 const portable=JSON.parse(fs.readFileSync(info.project)),localRecords=portable.library_drafts;assert.equal(localRecords.records.length,1);assert.equal(localRecords.records[0].id,info.item_id);assert.equal(localRecords.records[0].draft.rows[0].inputs.T,'Icon Project local record with original PNG');assert.deepEqual(Buffer.from(localRecords.records[0].diagram.content_base64,'base64'),fs.readFileSync(info.diagram));
 checks.push('A real Library edit and Project Save capture one valid project-local record with its exact original PNG and captured pricing.');
 await openProjectSection(page,'certification');const certificate=page.locator('#certification-new');await expect(certificate).toHaveText('New');await expect(certificate).toHaveAccessibleName('New');await certificate.click();await expect(page.locator('#certification-editor')).toBeVisible();await page.locator('#certification-back').click();await expect(page.locator('#view-documentation')).toBeVisible();
 checks.push('New opens the certificate form. Back returns to Documentation.');
 for(const [section,name,selector,back] of sections){await openProjectSection(page,section);const host=page.locator(selector);await host.getByRole('button',{name,exact:true}).click();await expect(host.locator('.commercial-editor')).toBeVisible();await cancelDraft(host,back);}
 await openProjectSection(page,'swms');await page.getByRole('button',{name:'New SWMS',exact:true}).click();await expect(page.locator('#swms-root .swms-workflow')).toBeVisible();await cancelDraft(page.locator('#swms-root'),'Back to statements');
 checks.push('The same plus controls open and discard the correct Quote, Work Order, Purchase Order and SWMS editors after a real numbered Project exists.');
 await openProjectSection(page,'quote');const quote=page.locator('#commercial-quote-root');await quote.getByRole('button',{name:'New Quote',exact:true}).click();
 const left=quote.locator('.commercial-sidebar').first();await left.getByRole('combobox',{name:'Name',exact:true}).fill(primary.name);await left.getByRole('option',{name:primary.name,exact:true}).click();
 const saved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/commercial/save');await quote.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);await idle();
 const projectBefore=fs.readFileSync(info.project),directoryBefore=await read('/api/contacts/directory'),identity=await page.evaluate(()=>window.CeasefireProject.context()),selector='native:'+identity.project_token;
 const record=await read('/api/crm/project-participants?project='+encodeURIComponent(selector));await post('/api/crm/project-participants',{project:selector,project_revision:record.project_revision,version:record.version,site_id:null,participants:[{id:participant.id,kind:'contacts',role:'consultant'}]});
 const refresh=left.getByRole('button',{name:'Refresh linked contacts',exact:true});await expect(refresh).toHaveAttribute('title','Refresh linked contacts');
 const paths=await refresh.locator('svg path').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d'))),reference=await page.locator('#reset-pricing svg path').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d')));assert.deepEqual(paths,reference);assert.equal(paths.length,4);
 await refresh.click();await expect(left.locator(`.commercial-linked-contact[data-contact-id="${participant.id}"]`)).toContainText(participant.name);
 assert.deepEqual(await read('/api/contacts/directory'),directoryBefore);assert.deepEqual(fs.readFileSync(info.project),projectBefore);
 checks.push('The outlined refresh SVG matches the existing reset icon; clicking it reads newly linked Contacts without changing directory records or the saved Project.');
 const quotePdf=await quote.locator('.commercial-download-pdf .download-format-icon').innerHTML();
 await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();await openProjectSection(page,'documentation');
 await page.locator('#documentation-pdf-rows').getByRole('button',{name:'Other documents',exact:true}).click();
 const breakdown=page.locator('button[data-document-kind="estimate.summary.pdf"]');await breakdownButton(breakdown);
 assert.equal(await breakdown.locator('.download-format-icon').innerHTML(),quotePdf);
 const snapshot=()=>page.evaluate(()=>({calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));const before=await snapshot();
 const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/quote-report');await breakdown.click();const reply=await receipt;assert.equal(reply.status(),200,await reply.text());const result=await reply.json();assert.equal(result.saved,true);assert.equal(result.documentation.item.kind,'estimate.summary.pdf');
 const relative=path.relative(output,result.path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));const bytes=fs.readFileSync(result.path);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(sha(bytes),result.documentation.item.sha256);await idle();
 await expect(page.locator('button[data-revisions-kind="estimate.summary.pdf"]')).toHaveText('View Revisions (1)');assert.deepEqual(await snapshot(),before);assert.deepEqual(fs.readFileSync(info.project),projectBefore);exportReceipts.push({path:result.path,sha256:sha(bytes),kind:result.documentation.item.kind});
 checks.push('Download Breakdown keeps its accessible name and real PDF exporter/history while showing the Quote download icon; each table uses its matching format and all saved Project/input bytes stay unchanged.');
 for(const width of [1915,1101,390]){await page.setViewportSize({width,height:1000});await breakdownButton(breakdown);await breakdown.screenshot({path:path.join(output,'breakdown-icon-'+width+'.png')});}await page.setViewportSize({width:1915,height:1000});
 await post('/api/scheduler/setup',{name:'Icon Admin',email:'admin@example.test',password:'Fixture-admin-password'});const viewer=await post('/api/scheduler/members/save',{name:'Icon Viewer',email:'viewer@example.test',password:'Fixture-viewer-password',role:'worker',active:true,base_rate:'0'});
 await post('/api/access/login',{email:'admin@example.test',password:'Fixture-admin-password'});await post('/api/access/roles',{member_id:viewer.id,role:'viewer',version:0});const access=await read('/api/access/session');await post('/api/access/settings',{enabled:true,version:access.version});
 const masterLibraryBefore=libraryStorage(),sourceLibraryBefore=libraryFiles(),configurationBefore=(await read('/api/bootstrap')).configuration;
 const viewerContext=await browser.newContext({viewport:{width:1915,height:1000}}),view=await viewerContext.newPage();view.setDefaultTimeout(45000);view.on('pageerror',e=>errors.push(e.message));await view.goto(base);await view.getByLabel('Email',{exact:true}).fill('viewer@example.test');await view.getByLabel('Password',{exact:true}).fill('Fixture-viewer-password');await view.getByRole('button',{name:'Sign in',exact:true}).click();await idle(view);
 for(const [kind,name] of [['leads','New Lead'],['contacts','New Contact'],['accounts','New Company']]){await contacts(view,kind);await plus(view.locator('#contacts-root .contacts-controls .add-icon-action'),name,{disabled:true});}
 for(const [section,name,selector] of sections){await openProjectSection(view,section);await plus(view.locator(selector).getByRole('button',{name,exact:true}),name,{disabled:true});}
 await openProjectSection(view,'swms');await plus(view.getByRole('button',{name:'New SWMS',exact:true}),'New SWMS',{disabled:true});
 const load=view.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/open');await clickProjectControl(view,'Load');assert.equal((await load).status(),200);
 const review=view.locator('#discard-dialog');await Promise.race([review.waitFor({state:'visible'}),view.waitForFunction(client=>window.CeasefireProject?.details?.().client===client,company.company)]);if(await review.isVisible())await review.locator('[value="confirm"]').click();await idle(view);assert.equal(await view.evaluate(()=>window.CeasefireProject.details().client),company.company);await openProjectSection(view,'documentation');
 assert.deepEqual(await view.evaluate(()=>window.CeasefireLibraryEditor.projectSnapshot()),localRecords);assert.deepEqual(libraryStorage(),masterLibraryBefore);assert.deepEqual(libraryFiles(),sourceLibraryBefore);assert.deepEqual((await read('/api/bootstrap')).configuration,configurationBefore);
 await view.locator('#documentation-pdf-rows').getByRole('button',{name:'Other documents',exact:true}).click();
 const viewerBreakdown=view.locator('button[data-document-kind="estimate.summary.pdf"]');await breakdownButton(viewerBreakdown,true);let viewerExports=0;view.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/quote-report')viewerExports++;});await viewerBreakdown.evaluate(b=>b.click());assert.equal(viewerExports,0);
 const denied=await view.evaluate(async()=>{const response=await fetch('/api/contacts/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return response.status;});assert.equal(denied,403);
 assert.deepEqual(fs.readFileSync(info.project),projectBefore);assert.deepEqual(await read('/api/contacts/directory'),directoryBefore);
 checks.push('Named viewers load the exact saved nonempty local Library record/PNG/pricing without changing source Library files, shared Library DB rows, master configuration or Project bytes; creation/generation stays disabled and writes are denied.');
 assert.deepEqual(Object.fromEntries(owned.map(file=>[file,sha(fs.readFileSync(path.join(root,'static',file)))])),sources);assert.deepEqual(errors,[]);
 const libraryPreservation={record_id:localRecords.records[0].id,project_sha256:sha(projectBefore),snapshot_sha256:sha(JSON.stringify(localRecords)),diagram_sha256:sha(Buffer.from(localRecords.records[0].diagram.content_base64,'base64')),captured_configuration_sha256:sha(JSON.stringify(localRecords.records[0].configuration)),master_library_tables:masterLibraryBefore,source_library_files:sourceLibraryBefore,master_configuration_sha256:sha(JSON.stringify(configurationBefore))};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,exports:exportReceipts,sourceHashes:sources,libraryPreservation,errors},null,2));console.log('PASS Creation action icons: '+output);
})().catch(async error=>{console.error(error);console.error(logs);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),checks,sourceHashes:sources,errors},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
