const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const {chooseTakeoff}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','calculator-inspections-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'project_documentation_fixture.py'),'--directory',output,'--technical-fixture'],{cwd:root,windowsHide:true});
let browser,page,log='';server.stderr.on('data',data=>log+=data);
const ready=new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(Error('Fixture startup timed out')),120000);
  server.on('error',reject);server.on('exit',()=>{clearTimeout(timer);reject(Error(log));});
  server.stdout.on('data',data=>{buffer+=data;if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]));}});
});
const idle=()=>page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
const names={duct:'Duct Inspections',steel:'Structural Steel Inspections'};
const ids={duct:'duct-inspections',steel:'structural-steel-inspections'};
const files={duct:'duct_inspections.pdf',steel:'structural_steel_inspections.pdf'};
const reportUrls={
  duct:'https://tfire.com.au/documents/FyreWrap-external-fire-test-report',
  steel:'https://media.promat.com/cert_371267_au/original/2143168301/promatect-xs--as4100-2020--as1530.4-2014-fas230021-rir1.4.pdf?brand=promatconstruction&market=au',
};
const registers={duct:{id:'duct_register',title:'Duct Register'},steel:{id:'structural_steel_register',title:'Structural Steel Register'}};
const covers={duct:{file:'Duct cover.pdf',text:'DUCT INSPECTION TEST COVER'},steel:{file:'Steel cover.pdf',text:'STEEL INSPECTION TEST COVER'}};
const todayInSydney=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function documentRow(id){
  await openProjectSection(page,'documentation');
  const row=page.locator('tr[data-document-kind="'+id+'"]');await expect(row).toBeAttached();
  if(!await row.isVisible())await row.locator('xpath=preceding-sibling::tr[contains(@class,"documentation-group")][1]//button').click();
  return row;
}
async function installInspectionCovers(){
  const saved=[];
  for(const kind of ['duct','steel']){
    const row=await documentRow(files[kind]);
    const label='PDF cover sheet for '+names[kind];
    const input=row.getByLabel(label,{exact:true});
    await expect(row.getByText('Choose file',{exact:true})).toBeVisible();
    await expect(input).toBeEnabled();
    await input.setInputFiles(path.join(output,covers[kind].file));
    await expect(row.getByText(covers[kind].file,{exact:true})).toBeVisible();
    saved.push(page.waitForResponse(response=>response.request().method()==='POST' &&
      new URL(response.url()).pathname==='/api/pdf-covers/'+files[kind].replace('.pdf','')));
  }
  await page.locator('#header-project-actions').getByRole('button',{name:'Save',exact:true}).click();
  for(const response of await Promise.all(saved))assert.equal(response.status(),200,await response.text());
  await idle();
}
async function openInspection(kind){
  const row=await documentRow(files[kind]);
  await row.locator('button[data-document-kind]').click();await expect(page.locator('#view-'+ids[kind])).toBeVisible();await idle();
  return page.locator('#'+ids[kind]+'-root');
}
async function photos(form,photo,gaugeCount=0){
  for(const label of ['Before Photos','During Photos','After Photos']){
    await form.getByLabel(label,{exact:true}).setInputFiles(photo);await idle();
  }
  if(gaugeCount){
    const gauge=Array.from({length:gaugeCount},(_,index)=>({...photo,name:`gauge-${index+1}.png`}));
    await form.getByLabel('Photo of Gauge',{exact:true}).setInputFiles(gauge);await idle();
  }
  await expect(form.locator('figure img')).toHaveCount(3+gaugeCount);
}
async function setupSigner(){
  const url=new URL('/api/certifications/defaults',page.url()).href;
  const settings=await (await page.request.get(url)).json();
  const response=await page.request.post(url,{data:{fields:{...settings.fields,name:'Inspection signer'},expected_version:settings.version}});
  assert.ok(response.ok(),await response.text());
  await page.route('**/api/forms/signer',async route=>{
    const response=await route.fetch(),profile=await response.json();
    await route.fulfill({response,json:{...profile,at:'2026-01-01T15:10:00Z'}});
  });
}
async function signInspection(form,inspectionDate){
  await form.getByLabel('Inspection date',{exact:true}).fill(inspectionDate);
  await form.getByRole('button',{name:'Insert signature',exact:true}).click();
  const pad=page.getByLabel('Signature drawing pad');await expect(pad).toBeVisible();
  const box=await pad.boundingBox();
  await page.mouse.move(box.x+10,box.y+30);
  await page.mouse.down();await page.mouse.move(box.x+70,box.y+45,{steps:6});await page.mouse.up();
  await page.getByRole('dialog').getByRole('button',{name:'Insert signature',exact:true}).click();
  await expect(form.getByRole('img',{name:'Signature',exact:true})).toBeVisible();
  await expect(form.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Inspection signer');
  await expect(form.getByRole('textbox',{name:'Date',exact:true})).toHaveValue('02/01/2026');
}
async function pin(form,pageNumber){
  const plan=form.locator('.register-plan-location');
  const choice=plan.locator('[name=plan_source] option').filter({hasText:'Register plans.pdf'});await expect(choice).toHaveCount(1);
  await plan.getByLabel('Source document').selectOption(await choice.getAttribute('value'));
  await plan.getByLabel('Page number').selectOption(String(pageNumber));
  const sheet=plan.locator('.register-plan-sheet');await expect(sheet).toBeVisible({timeout:60000});
  const canvas=plan.getByRole('button',{name:'Place pin on plan'});await canvas.click({position:{x:100,y:100}});
  await expect(plan.getByRole('button',{name:'001',exact:true})).toBeVisible();
}
async function download(kind,form){
  const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/'+ids[kind]+'.pdf');
  await form.locator('.register-toolbar').getByRole('button',{name:'Download PDF',exact:true}).click();
  const response=await pending;assert.equal(response.status(),200,await response.text());
  const receipt=await response.json();assert.ok(receipt.documentation,JSON.stringify(receipt));assert.equal(receipt.documentation.item.kind,files[kind]);
  assert.ok(fs.readFileSync(receipt.path).subarray(0,5).equals(Buffer.from('%PDF-')));
  const pages=await pdfPages(receipt.documentation.item.url);
  assert.match(pages[0].text,new RegExp(covers[kind].text));
  assert.ok(pages[1].links.includes(reportUrls[kind]),'Inspection report links survive PDF covers and plan assembly');
  const text=pages.map(page=>page.text).join('\n');
  assert.match(text,new RegExp(names[kind]));assert.match(text,/001/);
  assert.match(text,kind==='steel' ? /Inspection ID\s+001\s+Date\s+30\/12\/2025/ : /Inspection ID\s+001\s+Date\s+31\/12\/2025/);
  assert.match(text,/Name\s+Inspection signer\s+Date signed\s+02\/01\/2026/);
  if(kind==='steel'){assert.match(text,/Number of Readings\s+2/i);assert.match(text,/Recorded Thickness \(mm\)\s+30/);}
  else {
    assert.match(text,/2 x 38mm/);
    assert.match(text,/Recorded Thickness \(mm\)\s+62\.97/);
    assert.match(text,/Number of Readings\s+2/i);
    assert.match(text,/Site address\s+1 Synthetic Project Street\s+Date\s+\d{2}\/\d{2}\/\d{4}/i);
    assert.doesNotMatch(text,/Photo of Gauge/);
  }
  await idle();
  const message=page.locator('#message-dialog');if(await message.isVisible())await message.getByRole('button',{name:'OK',exact:true}).click();
  return receipt;
}
async function pdfPages(url){
  return page.evaluate(async url=>{
    const lib=await import('/vendor/pdfjs/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.mjs';
    const loading=lib.getDocument({url});
    try {
      const pdf=await loading.promise,parts=[];
      for(let i=1;i<=pdf.numPages;i++) {
        const page=await pdf.getPage(i);
        const [content,annotations]=await Promise.all([page.getTextContent(),page.getAnnotations({intent:'display'})]);
        parts.push({text:content.items.map(item=>item.str).join(' '),links:annotations.filter(item=>item.subtype==='Link').map(item=>item.url)});
      }
      return parts;
    } finally {await loading.destroy();}
  },url);
}
async function downloadRegister(kind){
  const {id,title}=registers[kind],key=id+'.pdf',row=await documentRow(key);
  await expect(row.locator('td').first()).toHaveText(title);
  const editions=row.locator('button[data-revisions-kind]');await expect(editions).toHaveText('View Revisions (0)');
  const pending=page.waitForResponse(response=>response.request().method()==='POST' &&
    new URL(response.url()).pathname==='/api/project/'+id.replaceAll('_','-')+'.pdf');
  await row.locator('button[data-document-kind]').click();
  const response=await pending;assert.equal(response.status(),200,await response.text());
  const receipt=await response.json();assert.equal(receipt.documentation.item.kind,key);
  const pages=await pdfPages(receipt.documentation.item.url),summary=pages[0].text;
  assert.ok(pages[0].links.includes(reportUrls[kind]),'Register contains the manufacturer report link');
  assert.match(summary,new RegExp(title));
  assert.doesNotMatch(summary,/Calculator Register/i);
  assert.match(summary,/Site Address\s+1 Synthetic Project Street\s+Date\s+\d{2}\/\d{2}\/\d{4}/i);
  assert.match(summary,/\b001\b/);assert.doesNotMatch(summary,/\b002\b/);
  assert.match(summary,/Before Photos|Before/i);
  if(kind==='steel'){
    for(const expected of ['200UC46','PROMATECT-XS','30','Number of Readings'])assert.ok(summary.includes(expected),summary);
  }else {
    for(const expected of ['250x250','FyreWrap','2 x 38mm','Number of Readings'])assert.ok(summary.includes(expected),summary);
    assert.match(summary,/62\.97\s+2\b/);
  }
  if(kind==='steel')assert.ok(pages.length>1,'The register appends the pinned drawing');
  else assert.equal(pages.length,1,'The duct register exports without a plan pin');
  await expect(editions).toHaveText('View Revisions (1)');
  await idle();
  const message=page.locator('#message-dialog');if(await message.isVisible())await message.getByRole('button',{name:'OK',exact:true}).click();
  return receipt;
}
async function run(){
  const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});
  await require('./calculator_inspections_state.cjs').checkInspectionState(browser);
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(60000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+info.port);await idle();await createNewProject(page,{client:'Synthetic calculator inspections'});
  await installInspectionCovers();
  await setupSigner();
  await page.evaluate(async()=>{
    const calculators=await window.CeasefireCalculators.completeProjectSnapshot();
    calculators.ductwork={inputs:{CALCULATOR:{B11:'250x250',C11:'FyreWrap',D11:10,E11:'120/120/120',F11:0,G11:0,H11:'Stair pressurisation',I11:'Both',DA11:'Ground',CM11:1}},schedule_rows:[11]};
    calculators.steel_board={inputs:{CALCULATOR:{A9:'Member Test',B9:'Level 1',C9:'PROMATECT-XS',D9:'200UC46',F9:10,G9:4,H9:120,I9:'Column',J9:550,M9:'Standard',O9:'Auto',P9:'Published first',Q9:'Standard box',CJ9:1}},schedule_rows:[9]};
    window.CeasefireCalculators.applyProject(await window.CeasefireCalculators.prepareProject(calculators));
  });
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=20;return canvas.toDataURL('image/png').split(',')[1];});
  const photo={name:'inspection.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
  let duct=await openInspection('duct');await duct.getByLabel('Calculator register row').selectOption('1');
  await expect(duct.getByLabel('Inspection date',{exact:true})).toHaveValue(todayInSydney());
  for(const value of ['Ground','250x250','FyreWrap','2 x 38mm','FC17299-01-1'])await expect(duct.locator('tbody')).toContainText(value);
  await duct.getByLabel('Reading 1 (mm)',{exact:true}).fill('61.91');
  await duct.getByRole('button',{name:'Add reading',exact:true}).click();
  await duct.getByLabel('Reading 2 (mm)',{exact:true}).fill('64.02');
  await expect(duct.locator('tbody [data-inspection-average]')).toHaveText('62.97');
  await expect(duct.locator('tbody [data-inspection-count]')).toHaveText('2');
  await photos(duct,photo);
  await chooseTakeoff(page,'Defect Reports');await page.locator('#takeoff-upload').setInputFiles(path.join(output,'Register plans.pdf'));
  await expect(page.locator('.takeoff-document')).toHaveCount(1);await idle();
  duct=await openInspection('duct');await signInspection(duct,'2025-12-31');const ductReceipt=await download('duct',duct);
  await page.screenshot({path:path.join(output,'duct-desktop.png')});
  const steel=await openInspection('steel');await steel.getByRole('checkbox',{name:'Steel (board)',exact:true}).check();await idle();
  await steel.getByLabel('Calculator register row').selectOption('1');
  await expect(steel.getByLabel('Inspection date',{exact:true})).toHaveValue(todayInSydney());
  for(const value of ['Level 1','200UC46','PROMATECT-XS','FAS230021 RIR1.4'])await expect(steel.locator('tbody')).toContainText(value);
  await steel.getByLabel('Reading 1 (mm)',{exact:true}).fill('25');await steel.getByRole('button',{name:'Add reading',exact:true}).click();
  await steel.getByLabel('Reading 2 (mm)',{exact:true}).fill('35');
  await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('30');await expect(steel.locator('tbody [data-inspection-count]')).toHaveText('2');
  await photos(steel,photo,4);await pin(steel,2);await signInspection(steel,'2025-12-30');const steelReceipt=await download('steel',steel);
  await page.screenshot({path:path.join(output,'steel-desktop.png')});
  await page.setViewportSize({width:390,height:884});await page.screenshot({path:path.join(output,'steel-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  await steel.locator('.register-toolbar').getByRole('button',{name:'Add entry',exact:true}).click();
  await expect(steel.getByRole('combobox',{name:'Register entry'}).locator('option:checked')).toContainText('002');
  const ductRegister=await downloadRegister('duct'),steelRegister=await downloadRegister('steel');
  const save=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save');
  await page.locator('#header-project-actions').getByRole('button',{name:'Save',exact:true}).click();assert.equal((await save).status(),200);await idle();
  const project=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.deepEqual(project.calculator_inspections.steel.entries[0].readings,[25,35]);
  assert.deepEqual(project.calculator_inspections.duct.entries[0].readings,[61.91,64.02]);
  assert.equal(project.calculator_inspections.duct.entries[0].before.length,1);
  assert.deepEqual(project.calculator_inspections.duct.entries[0].gauge,[]);
  assert.deepEqual(project.calculator_inspections.duct.entries[0].plan_pins,[]);
  assert.equal(project.calculator_inspections.steel.entries[0].plan_pins.length,1);
  const signer=await page.evaluate(()=>window.ClassifireAccess.user.id);
  for(const [kind,date] of Object.entries({duct:'2025-12-31',steel:'2025-12-30'})){
    const entry=project.calculator_inspections[kind].entries[0];
    assert.equal(entry.inspection_date,date);
    assert.deepEqual(entry.signature_details,{member_id:signer,name:'Inspection signer',date:'2026-01-02'});
    assert.ok(entry.signature.strokes.length);
  }
  await openProjectSection(page,'quotes');await page.locator('#load-project').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  duct=await openInspection('duct');await expect(duct.getByLabel('Reading 2 (mm)',{exact:true})).toHaveValue('64.02');
  await expect(duct.locator('tbody [data-inspection-average]')).toHaveText('62.97');
  await expect(duct.getByLabel('Inspection date',{exact:true})).toHaveValue('2025-12-31');
  await openInspection('steel');await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('30');await expect(steel.locator('figure img')).toHaveCount(7);
  await expect(steel.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Inspection signer');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,project:info.project,pdfs:[ductReceipt.path,steelReceipt.path,ductRegister.path,steelRegister.path]},null,2));
  console.log('PASS: inspection covers and evidence, completed registers, Takeoff pins, PDF revisions and project save/reload. '+output);
}
run().catch(async error=>{console.error(error,log);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
