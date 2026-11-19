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
async function openInspection(kind){
  await openProjectSection(page,'documentation');
  const download=page.locator('button[data-document-kind="'+files[kind]+'"]');await expect(download).toBeAttached();
  if(!await download.isVisible())await download.locator('xpath=ancestor::tr/preceding-sibling::tr[contains(@class,"documentation-group")][1]//button').click();
  await download.click();await expect(page.locator('#view-'+ids[kind])).toBeVisible();await idle();
  return page.locator('#'+ids[kind]+'-root');
}
async function photos(form,photo){
  for(const label of ['Before Photos','During Photos','After Photos','Photo of Gauge']){
    await form.getByLabel(label,{exact:true}).setInputFiles(photo);await idle();
  }
  await expect(form.locator('figure img')).toHaveCount(4);
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
  const text=await page.evaluate(async url=>{
    const lib=await import('/vendor/pdfjs/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.mjs';
    const loading=lib.getDocument({url});try{const pdf=await loading.promise,parts=[];for(let i=1;i<=pdf.numPages;i++){parts.push((await(await pdf.getPage(i)).getTextContent()).items.map(item=>item.str).join(' '));}return parts.join('\n');}finally{await loading.destroy();}
  },receipt.documentation.item.url);
  assert.match(text,new RegExp(names[kind]));assert.match(text,/001/);
  if(kind==='steel'){assert.match(text,/Number of Readings\s+2/i);assert.match(text,/Recorded Thickness \(mm\)\s+30/);}
  else assert.match(text,/2 x 38mm/);
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
  await page.evaluate(async()=>{
    const calculators=await window.CeasefireCalculators.completeProjectSnapshot();
    calculators.ductwork={inputs:{CALCULATOR:{B11:'250x250',C11:'FyreWrap',D11:10,E11:'120/120/120',F11:0,G11:0,H11:'Stair pressurisation',I11:'Both',DA11:'Ground',CM11:1}},schedule_rows:[11]};
    calculators.steel_board={inputs:{CALCULATOR:{A9:'Member Test',B9:'Level 1',C9:'PROMATECT-XS',D9:'200UC46',F9:10,G9:4,H9:120,I9:'Column',J9:550,M9:'Standard',O9:'Auto',P9:'Published first',Q9:'Standard box',CJ9:1}},schedule_rows:[9]};
    window.CeasefireCalculators.applyProject(await window.CeasefireCalculators.prepareProject(calculators));
  });
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=20;return canvas.toDataURL('image/png').split(',')[1];});
  const photo={name:'inspection.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
  let duct=await openInspection('duct');await duct.getByLabel('Calculator register row').selectOption('1');
  for(const value of ['Ground','250x250','FyreWrap','2 x 38mm','FC17299-01-1'])await expect(duct.locator('tbody')).toContainText(value);
  await duct.getByLabel('Recorded Thickness (mm)',{exact:true}).fill('76');await photos(duct,photo);
  await chooseTakeoff(page,'Defect Reports');await page.locator('#takeoff-upload').setInputFiles(path.join(output,'Register plans.pdf'));
  await expect(page.locator('.takeoff-document')).toHaveCount(1);await idle();
  duct=await openInspection('duct');await pin(duct,1);const ductReceipt=await download('duct',duct);
  await page.screenshot({path:path.join(output,'duct-desktop.png')});
  const steel=await openInspection('steel');await steel.getByRole('checkbox',{name:'Steel (board)',exact:true}).check();await idle();
  await steel.getByLabel('Calculator register row').selectOption('1');
  for(const value of ['Level 1','200UC46','PROMATECT-XS','FAS230021 RIR1.4'])await expect(steel.locator('tbody')).toContainText(value);
  await steel.getByLabel('Reading 1 (mm)',{exact:true}).fill('25');await steel.getByRole('button',{name:'Add reading',exact:true}).click();
  await steel.getByLabel('Reading 2 (mm)',{exact:true}).fill('35');
  await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('30');await expect(steel.locator('tbody [data-inspection-count]')).toHaveText('2');
  await photos(steel,photo);await pin(steel,2);const steelReceipt=await download('steel',steel);
  await page.screenshot({path:path.join(output,'steel-desktop.png')});
  await page.setViewportSize({width:390,height:884});await page.screenshot({path:path.join(output,'steel-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  const save=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save');
  await page.locator('#header-project-actions').getByRole('button',{name:'Save',exact:true}).click();assert.equal((await save).status(),200);await idle();
  const project=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.deepEqual(project.calculator_inspections.steel.entries[0].readings,[25,35]);
  assert.equal(project.calculator_inspections.duct.entries[0].before.length,1);
  assert.equal(project.calculator_inspections.steel.entries[0].plan_pins.length,1);
  await openProjectSection(page,'quotes');await page.locator('#load-project').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  await openInspection('steel');await expect(steel.locator('tbody [data-inspection-average]')).toHaveText('30');await expect(steel.locator('figure img')).toHaveCount(4);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,project:info.project,pdfs:[ductReceipt.path,steelReceipt.path]},null,2));
  console.log('PASS: normal Documents entry, calculator imports, evidence, Takeoff pins, PDF revisions and project save/reload. '+output);
}
run().catch(async error=>{console.error(error,log);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
