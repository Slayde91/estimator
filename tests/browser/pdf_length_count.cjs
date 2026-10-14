"use strict";
// Drawing-only trace/count tools on disposable PDFs; no live app state.
const { chromium, expect } = require('@playwright/test');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), python = process.env.CEASEFIRE_PYTHON || 'python';
const output = path.join(root, '.runtime/browser-qa', `pdf-length-count-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='', browser, page; const errors=[], checks=[];
server.stderr.on('data',chunk=>{logs+=chunk;});
const ready = new Promise((resolve,reject)=>{
  let text=''; const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${logs}`)),120000);
  server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]));}catch(error){reject(error);}}});
  server.once('error',error=>{clearTimeout(timer);reject(error);});
});
const rail=()=>page.getByRole('toolbar',{name:'Drawing tools',exact:true});
const snapshot=async()=>{await settingsSettled(page);return page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());};
async function command(action,op){const pending=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.op===op);pending.catch(()=>{});await action();const reply=await pending;assert.equal(reply.status(),200,await reply.text());await settingsSettled(page);return reply.json();}
async function chooseDrawingTool(name,tool){await rail().getByRole('button',{name,exact:true}).click();await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool',tool);}
async function clickPoint(x,y,options){const overlay=page.locator('.takeoff-overlay');await overlay.scrollIntoViewIfNeeded();await overlay.evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-180));const box=await overlay.boundingBox();await page.mouse.click(box.x+x/842*box.width,box.y+(1-y/595)*box.height,options);}
function invariant(current,before){for(const key of ['items','physical','service_plans','calibrations','transfers','documents'])assert.deepEqual(current[key],before[key],`${key} unchanged`);}
async function length(mm,reuse=false){const modal=page.getByRole('dialog');await expect(modal.getByRole('heading',{name:'Counted member length',exact:true})).toBeVisible();await modal.getByLabel('Manual Length (mm)',{exact:true}).fill(mm);if(reuse)await modal.getByLabel('Use this length for additional counts').check();await modal.getByRole('button',{name:'Place marker',exact:true}).click();await modal.waitFor({state:'detached'});}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:1000}});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',e=>window.qaCsp.push(e.effectiveDirective));});
  await page.goto(`http://127.0.0.1:${info.port}/`);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture),1);
  await page.evaluate(async()=>{
    const app=window.CeasefireTakeoffs, value=app.projectSnapshot(),sid=app.sessionId(),doc=value.documents[0];
    const reply=await fetch(`/api/takeoffs/sessions/${sid}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'add_calibration',request_id:crypto.randomUUID(),expected_revision:value.revision,calibration:{id:crypto.randomUUID(),document_id:doc.id,page:1,name:'Fixture scale',points:[[100,100],[200,100]],distance_m:10,uniform_scale:true}})});
    if(!reply.ok)throw new Error(await reply.text());const result=await reply.json();app.applyProject(await app.prepareProject(result.snapshot,sid));
  });
  await renderDrawing(page,()=>page.getByRole('button',{name:'Fit page',exact:true}).click(),1);
  const before=await snapshot(), calculators=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  for(const mode of ['duct','Walls/Floors','Defect Reports','Service Plans']){
    await chooseTakeoff(page,mode);await settingsSettled(page);
    const visible=await rail().getByRole('button').evaluateAll(buttons=>buttons.filter(b=>b.getClientRects().length).map(b=>b.getAttribute('aria-label')));
    const callout=visible.indexOf('Call-out'), countIndex=visible.findIndex(label=>label==='Count'||label==='Count steel lengths');
    assert.ok(callout>countIndex && countIndex>=0,`${mode}: Call-out follows Count in left rail`);
    await expect(page.getByRole('toolbar',{name:'PDF markup tools',exact:true}).getByRole('button',{name:'Call-out',exact:true})).toHaveCount(0);
    if(mode==='duct')continue;
    assert.deepEqual(visible.slice(visible.indexOf('Measure'),visible.indexOf('Measure')+4),['Measure','Trace length','Count','Call-out']);
    await chooseDrawingTool('Trace length','graphic-measure');
    const traced=await command(async()=>{await clickPoint(100,300);await clickPoint(200,300);await page.locator('.takeoff-viewport').press('Enter');},'create_graphic');
    assert.equal(traced.snapshot.graphics.records.at(-1).kind,'measure');assert.equal(traced.pdf_measure_results.at(-1).status,'current');
    await chooseDrawingTool('Count','pdf-count');await clickPoint(300,300);await length('1234.56789012345',true);
    await clickPoint(400,300); // The same manual length is reused without a second dialog.
    const counted=await command(()=>page.locator('.takeoff-viewport').press('Enter'),'create_graphic');
    let count=counted.snapshot.graphics.records.at(-1);assert.equal(count.kind,'count');assert.equal(count.geometry.points.length,2);assert.deepEqual(count.geometry.lengths_m,[1.23456789012345,1.23456789012345]);
    await page.getByRole('button',{name:'Edit marker length',exact:true}).click();let modal=page.getByRole('dialog');await modal.getByLabel('Marker number',{exact:true}).fill('2');await modal.getByLabel('Marker number',{exact:true}).press('Tab');await modal.getByLabel('Manual Length (mm)',{exact:true}).fill('4500');
    const changed=await command(()=>modal.getByRole('button',{name:'Apply length',exact:true}).click(),'update_graphic');count=changed.snapshot.graphics.records.find(r=>r.id===count.id);assert.deepEqual(count.geometry.lengths_m,[1.23456789012345,4.5]);
    invariant(await snapshot(),before);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
    const savedCount=(await snapshot()).graphics.records.length;
    await chooseDrawingTool('Count','pdf-count');await clickPoint(500,300);await length('2000',true);await page.locator('.takeoff-viewport').press('Escape');assert.equal((await snapshot()).graphics.records.length,savedCount);
    // Double-click finishes without retaining the endpoint click as another marker.
    await chooseDrawingTool('Count','pdf-count');await clickPoint(500,300);await length('2000',true);
    const doubled=await command(()=>clickPoint(550,300,{clickCount:2}),'create_graphic');assert.equal(doubled.snapshot.graphics.records.at(-1).geometry.points.length,1);
    const pending=page.waitForEvent('download');await page.evaluate(()=>window.CeasefireTakeoffs.downloadDrawing());const pdf=path.join(output,`${mode.replaceAll('/','-').replaceAll(' ','-')}.pdf`);await(await pending).saveAs(pdf);
    const text=spawnSync(python,['-X','utf8','-B','-c',"from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))",pdf],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(text.status,0,text.stderr);assert.match(text.stdout,/4\.50 m/);assert.match(text.stdout,/2\.00 m/);
    await page.screenshot({path:path.join(output,`${mode.replaceAll('/','-').replaceAll(' ','-')}.png`)});checks.push(`${mode}: trace, counts, reuse, exact manual lengths, edit, cancellation, double-click and PDF; no register mutation`);console.log(checks.at(-1));
  }
  const saved=await snapshot();await clickProjectControl(page,'Save');await expect(page.locator('#project-save-state')).toHaveText('Saved project');await clickProjectControl(page,'Load');await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();await expect(page.locator('#project-save-state')).toHaveText('Saved project');await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  assert.deepEqual((await snapshot()).graphics.records,saved.graphics.records);invariant(await snapshot(),before);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,saveReopen:true,errors},null,2));console.log(`PASS: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-2000));if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
