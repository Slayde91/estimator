// Manufacturer metadata is tested through real UI, native files and disposable storage.
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chooseLibrary}=require('./section_navigation.cjs');
const {clickProjectControl}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),python=process.env.CEASEFIRE_PYTHON||'python';
const output=path.join(root,'.runtime/browser-qa',`pricing-manufacturers-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sources=['static/app.js','estimator/catalog.py','estimator/pricing_workbook.py','estimator/pricing_manufacturers.py','data/pricing_manufacturers.json'];
const sourceHashes=Object.fromEntries(sources.map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
const server=spawn(python,[path.join(__dirname,'project_library_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,info,owner,base,projectBytes,frozen,canonicalBefore,canonicalImported;
server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[],consoleErrors=[],evidence={layouts:[],checkpoints:[]};
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;},null,{timeout:120000});}
async function api(route){const reply=await page.request.get(base+route);assert.equal(reply.status(),200,await reply.text());return reply.json();}
async function projectState(){await idle();return page.evaluate(()=>({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),inputs:[...document.querySelectorAll('#main-estimate-form input,#main-estimate-form select,#main-estimate-form textarea')].map(node=>[node.id,node.type,node.value,node.checked]),totals:[...document.querySelectorAll('[id^="sum-"]')].map(node=>[node.id,node.textContent])}));}
function analyze(configuration,label){
  const file=path.join(output,`${label}-configuration.json`);fs.writeFileSync(file,JSON.stringify(configuration));
  const reply=spawnSync(python,['-c',`import json,sys
from estimator.catalog import effective_catalog
c=effective_catalog(json.load(open(sys.argv[1],encoding='utf-8')))
def clean(value):
 if isinstance(value,list):return [clean(item) for item in value]
 if isinstance(value,dict):
  result={key:clean(item) for key,item in value.items() if key!='manufacturer'}
  if isinstance(result.get('source'),dict):result['source'].pop('manufacturer_assignment',None)
  return result
 return value
owner=next(item for item in c['inventory'] if item['id']==sys.argv[2])
linked=[dict(group=group,**rate) for group,rates in c['rate_groups'].items() for rate in rates if rate.get('inventory_id')==sys.argv[2]]
print(json.dumps(dict(canonical=clean(c),owner=owner,linked=linked)))`,file,owner.id],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(reply.status,0,`${reply.stdout}\n${reply.stderr}`);return JSON.parse(reply.stdout);
}
async function checkpoint(label,manufacturer,configuration,expected=canonicalBefore){
  const current=analyze(configuration||await api('/api/configuration'),label);
  assert.deepEqual(current.canonical,expected,'Every identity, price, markup, rate, yield, property and unrelated source value remains exact');
  assert.equal(current.owner.manufacturer,manufacturer);assert.ok(current.linked.length>0);
  for(const rate of current.linked)assert.equal(rate.manufacturer,manufacturer,'Linked use follows its one inventory owner');
  assert.deepEqual(await projectState(),frozen,'Global metadata edits never alter the frozen current project or calculator drafts/totals');
  assert.deepEqual(fs.readFileSync(info.project),projectBytes,'Global metadata edits never rewrite the saved project file');
  evidence.checkpoints.push({label,manufacturer,linkedUses:current.linked.map(rate=>({id:rate.id,group:rate.group})),numericAndProjectStateUnchanged:true});return current;
}
const row=()=>page.locator(`#pricing-body tr[data-price-kind="inventory"][data-price-id="${owner.id}"]`);
const field=()=>row().locator('[data-price-field="Manufacturer"]');
async function findOwner(){await page.locator('#rate-group').selectOption('');await page.locator('#pricing-search').fill(owner.name);await expect(row()).toHaveCount(1);}
async function editManufacturer(value){await field().fill(value);await field().press('Tab');await expect(field()).toHaveValue(value);}
async function saveLibrary(){
  await page.locator('#save-pricing').click();const dialog=page.getByRole('dialog',{name:'Save Pricing Library?',exact:true});await expect(dialog).toBeVisible();
  const pending=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/configuration'&&reply.request().method()==='PUT');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();const reply=await pending;assert.equal(reply.status(),200,await reply.text());
  await expect(page.locator('#save-pricing')).toBeEnabled();await expect(page.locator('#app-message')).toContainText('Pricing library saved.');await idle();return reply.request().postDataJSON();
}
async function reloadFrozenProject(){
  await page.reload();await idle();
  const pending=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/project/open');await clickProjectControl(page,'Load');const reply=await pending;assert.equal(reply.status(),200,await reply.text());
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await expect(page.locator('#project-save-state')).toHaveText('Saved project',{timeout:120000});await idle();
  assert.deepEqual(await projectState(),frozen,'Reloading the original project restores its exact frozen prices and drafts');
  await chooseLibrary(page,'pricing');await page.locator('#pricing-scope').selectOption('library');await expect(page.locator('#pricing-scope')).toHaveValue('library');await findOwner();
}
async function importWorkbook(file,accept){
  await page.locator('[aria-controls="pricing-document-actions"]').click();const choosing=page.waitForEvent('filechooser');await page.locator('#import-pricing').click();const chooser=await choosing;
  const pending=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/pricing/import');await chooser.setFiles(file);const reply=await pending;assert.equal(reply.status(),200,await reply.text());
  const preview=await reply.json();await expect(page.getByRole('dialog',{name:'Review imported pricing',exact:true})).toBeVisible();
  const analyzed=analyze(preview.configuration,accept?'excel-accepted-preview':'excel-cancelled-preview');assert.deepEqual(analyzed.canonical,canonicalImported);assert.equal(analyzed.owner.manufacturer,'QA Excel manufacturer');
  for(const rate of analyzed.linked)assert.equal(rate.manufacturer,'QA Excel manufacturer');
  await page.getByRole('dialog',{name:'Review imported pricing',exact:true}).getByRole('button',{name:accept?'Apply to draft':'Keep editing',exact:true}).click();
  await expect(page.locator('#import-pricing')).toBeEnabled();await findOwner();return preview;
}
(async()=>{
  info=await ready;assert.notEqual(info.port,8765);base=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:900}});
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.goto(base+'/');await idle();
  const bootstrap=await api('/api/bootstrap'),linkedIds=new Set(Object.values(bootstrap.catalog.rate_groups).flat().map(rate=>rate.inventory_id));
  owner=bootstrap.catalog.inventory.find(item=>item.manufacturer&&item.manufacturer!=='N/A'&&item.source?.manufacturer_assignment&&linkedIds.has(item.id));
  assert.ok(owner,'Disposable bootstrap includes a genuine source-reviewed branded inventory owner with linked uses');
  evidence.owner={id:owner.id,name:owner.name,manufacturer:owner.manufacturer,source:owner.source.manufacturer_assignment};
  evidence.disposableSeedCoverage={branded:bootstrap.catalog.inventory.filter(item=>item.manufacturer&&item.manufacturer!=='N/A').length,notApplicable:bootstrap.catalog.inventory.filter(item=>item.manufacturer==='N/A').length,unknown:bootstrap.catalog.inventory.filter(item=>!Object.hasOwn(item,'manufacturer')).length};
  canonicalBefore=analyze(bootstrap.configuration,'initial').canonical;
  const saving=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await saving).status(),200);await idle();
  projectBytes=fs.readFileSync(info.project);frozen=await projectState();assert.ok(frozen.configuration.catalog,'Current project owns a frozen catalogue');
  await chooseLibrary(page,'pricing');await expect(page.locator('#pricing-scope')).toHaveValue('library');
  await expect(page.locator('#pricing-head th')).toHaveText(['Product/Service','Manufacturer','Supplier price','Markup %','Sell price','Main Estimator groups','Firestopping Estimator groups','Yield','Actions']);
  await page.locator('#pricing-search').fill(owner.manufacturer);await expect(row()).toBeVisible();await expect(field()).toHaveValue(owner.manufacturer);
  await findOwner();await expect(field()).toHaveAttribute('maxlength','200');await expect(field()).toHaveAccessibleName(owner.name+': Manufacturer');await field().scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'manufacturer-desktop.png')});evidence.layouts.push({width:1146,visible:true,editable:true});
  await editManufacturer('QA desktop manufacturer');await page.locator('#pricing-search').fill('QA desktop manufacturer');await expect(row()).toHaveCount(1);await expect(page.locator('#pricing-body tr')).toHaveCount(1);
  // Cancelling the native Save confirmation keeps the edited field and all shared data.
  await page.locator('#save-pricing').click();await page.getByRole('dialog',{name:'Save Pricing Library?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
  assert.deepEqual(await api('/api/configuration'),bootstrap.configuration);await expect(field()).toHaveValue('QA desktop manufacturer');
  const edited=await saveLibrary();assert.equal(edited.inventory[owner.id].manufacturer,'QA desktop manufacturer');await checkpoint('desktop-saved','QA desktop manufacturer');
  await reloadFrozenProject();await expect(field()).toHaveValue('QA desktop manufacturer');await checkpoint('desktop-reloaded','QA desktop manufacturer');
  await page.setViewportSize({width:390,height:900});await field().scrollIntoViewIfNeeded();await expect(field()).toBeVisible();await expect(field()).toBeEditable();
  await page.screenshot({path:path.join(output,'manufacturer-mobile.png')});evidence.layouts.push({width:390,visible:true,editable:true});
  await editManufacturer('');const cleared=await saveLibrary();assert.equal(cleared.inventory[owner.id].manufacturer,'');await checkpoint('explicit-blank-saved','');
  await reloadFrozenProject();await expect(field()).toHaveValue('');await checkpoint('explicit-blank-reloaded','');
  await page.setViewportSize({width:1146,height:900});
  await page.locator('[aria-controls="pricing-document-actions"]').click();const exporting=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/pricing/export');await page.locator('#export-pricing').click();const exportReply=await exporting;assert.equal(exportReply.status(),200,await exportReply.text());
  const saved=await exportReply.json();assert.equal(saved.saved,true);const relative=path.relative(output,saved.path);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));assert.equal(fs.readFileSync(saved.path).subarray(0,2).toString(),'PK');
  const changed=path.join(output,'manufacturer-roundtrip.xlsx');
  const editedBook=spawnSync(python,['-c',`import csv,json,sys
from openpyxl import load_workbook
b=load_workbook(sys.argv[1]);s=b['Inventory & Rates'];h={c.value:c.column for c in s[1]}
assert 'Manufacturer' in h and not s.column_dimensions[s.cell(1,h['Manufacturer']).column_letter].hidden
rows=[n for n in range(2,s.max_row+1) if str(s.cell(n,h['Inventory ID']).value)==sys.argv[3]]
assert len(rows)==1
n=rows[0];assert s.cell(n,h['Manufacturer']).value is None
linked=next(csv.reader([str(s.cell(n,h['Rate ID']).value)],delimiter=';'))
assert linked and all(value for value in linked)
s.cell(n,h['Manufacturer'],'QA Excel manufacturer');b.save(sys.argv[2]);b.close()
print(json.dumps(dict(manufacturer_column=h['Manufacturer'],owner_id=sys.argv[3],linked_rate_ids=linked,exported_explicit_blank=True)))`,saved.path,changed,owner.id],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(editedBook.status,0,`${editedBook.stdout}\n${editedBook.stderr}`);evidence.workbook=JSON.parse(editedBook.stdout);
  // Import adds this exact audit record. Preserve and verify it explicitly;
  // no source fields or numeric values are omitted from the comparison.
  canonicalImported=JSON.parse(JSON.stringify(canonicalBefore));canonicalImported.sources.pricing_import={filename:path.basename(changed),sha256:hash(fs.readFileSync(changed))};
  evidence.workbook.importProvenance=canonicalImported.sources.pricing_import;
  const sharedBlank=await api('/api/configuration');await importWorkbook(changed,false);await expect(field()).toHaveValue('');assert.deepEqual(await api('/api/configuration'),sharedBlank);await checkpoint('excel-preview-cancelled','');
  const preview=await importWorkbook(changed,true);await expect(field()).toHaveValue('QA Excel manufacturer');assert.deepEqual(await api('/api/configuration'),sharedBlank,'Excel preview changes only its local draft before Save');
  assert.equal(preview.summary.inventory.added,0);assert.equal(preview.summary.inventory.removed,0);assert.equal(preview.summary.rates.added,0);assert.equal(preview.summary.rates.removed,0);
  await saveLibrary();await checkpoint('excel-roundtrip-saved','QA Excel manufacturer',undefined,canonicalImported);await reloadFrozenProject();await expect(field()).toHaveValue('QA Excel manufacturer');await checkpoint('excel-roundtrip-reloaded','QA Excel manufacturer',undefined,canonicalImported);
  assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);for(const[name,expected]of Object.entries(sourceHashes))assert.equal(hash(fs.readFileSync(path.join(root,name))),expected,'Production source remained fixed: '+name);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,port:info.port,sourceHashes,...evidence,exportedWorkbook:saved.path,importedWorkbook:changed,frozenProjectAndSavedBytesUnchanged:true,errors,consoleErrors},null,2));
  console.log('PASS: Manufacturer desktop/mobile edits, explicit clear, brand search, native Save/reload, Excel import preview and linked ownership; every numeric value and frozen project unchanged. '+output);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,...evidence,errors,consoleErrors},null,2));if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}process.exitCode=1;})
  .finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
