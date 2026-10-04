const { clickProjectControl } = require('./project_actions.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
// Real selection, appearance, movement and draft drawing/report exports on disposable sources.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime', 'browser-qa', `markups-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root,windowsHide:true});
let browser,page,logs='';server.stderr.on('data',data=>{logs+=data;});
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${logs}`)),120000);server.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]));}catch(error){reject(error);}}});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${logs}`));});});
const errors=[],requests=[],evidence={};
const idle=()=>expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy','true');
async function command(action,op,status=200){const pending=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().postDataJSON()?.op===op);await action();const response=await pending,body=await response.json();assert.equal(response.status(),status,JSON.stringify(body));await idle();return body;}
async function dialog(title,values,action){const modal=page.getByRole('dialog');await expect(modal.getByRole('heading',{name:title,exact:true})).toBeVisible({timeout:30000});for(const [label,value]of Object.entries(values)){const field=modal.getByLabel(label,{exact:true});if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));else await field.fill(String(value));}await modal.getByRole('button',{name:action,exact:true}).click();}
async function snapshot(){await idle();return page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());}
async function screen([x,y]){const overlay=page.locator('.takeoff-overlay');await overlay.scrollIntoViewIfNeeded();const box=await overlay.boundingBox();return[box.x+(y-30)/540*box.width,box.y+(x-20)/780*box.height];}
async function draw(points){for(const point of points)await page.mouse.click(...await screen(point));await page.locator('.takeoff-viewport').press('Enter');}
async function drag(from,to){await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded();const box=await page.locator('.takeoff-overlay').boundingBox(),at=([x,y])=>[box.x+(y-30)/540*box.width,box.y+(x-20)/780*box.height],a=at(from),b=at(to);await page.mouse.move(...a);await page.mouse.down();const start=await page.locator('.takeoff-overlay').boundingBox();await page.mouse.move(...b,{steps:12});const end=await page.locator('.takeoff-overlay').boundingBox();await page.mouse.up();(evidence.drags||=[]).push({from,to,box,start,end,a,b});fs.writeFileSync(path.join(output,'drags.json'),JSON.stringify(evidence.drags,null,2));}
async function selectIds(ids){await page.getByRole('checkbox',{name:'Select all matching items',exact:true}).check();await page.getByRole('checkbox',{name:'Select all matching items',exact:true}).uncheck();for(const id of ids)await page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox',{name:/^Select /}).check();}
async function settings(){const panel=page.locator('.takeoff-markup-settings');if(!await panel.isVisible())await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(panel).toBeVisible();return panel;}
async function applySettings(panel){await page.keyboard.press('Tab');await expect.poll(async()=>{try{await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());return true;}catch{return false;}}).toBe(true);return page.evaluate(async()=>(await fetch('/api/takeoffs/sessions/'+window.CeasefireTakeoffs.sessionId())).json());}
async function confirm(count){await page.getByRole('button',{name:'Confirm',exact:true}).click();return command(()=>dialog(`Confirm ${count} items?`,{},'Confirm items'),'confirm_items');}
async function download(label){
  // Attach rejection handlers immediately: a missing request must reach the outer
  // failure capture, rather than terminate Node through an unhandled waiter.
  const pending=page.waitForEvent('download');pending.catch(()=>{});
  const responseWait=page.waitForResponse(r=>r.url().endsWith(label==='Download PDF'?'/export/marked-pdf':'/export/schedule-xlsx'));responseWait.catch(()=>{});
  const [response]=await Promise.all([responseWait,page.getByRole('button',{name:label,exact:true}).click()]);
  if(!response.ok()){const current=await page.evaluate(async()=>{const id=window.CeasefireTakeoffs.sessionId();return(await fetch('/api/takeoffs/sessions/'+id)).json();});throw new Error(JSON.stringify({export:response.request().postDataJSON(),error:await response.json(),currentRevision:current.revision,localRevision:await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot().revision)}));}
  const result=await pending,target=path.join(output,result.suggestedFilename());await result.saveAs(target);return {path:target,request:response.request().postDataJSON()};
}
async function focusRow(item,document){
  await page.locator(`tr[data-item-id="${item.id}"] .takeoff-row-link`).click();
  await expect(page.locator('.takeoff-viewport')).toBeFocused();
  await expect(page.locator('.takeoff-progress')).toHaveText(`${document.name} \u00b7 Page ${item.geometry.page} \u00b7 Original source`);
  await idle();await expect(page.locator('.takeoff-page')).toBeVisible();
}

async function save(){const pending=page.waitForResponse(r=>r.url().endsWith('/api/project/save-as'));await clickProjectControl(page, 'Save As');assert.equal((await pending).status(),200);await expect(page.locator('#project-save-state')).toHaveText('Saved project');}
async function load(){const pending=page.waitForResponse(r=>r.url().endsWith('/api/project/open'));await clickProjectControl(page, 'Load');assert.equal((await pending).status(),200);await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();await expect(page.locator('#project-save-state')).toHaveText('Saved project');await command(()=>page.getByRole('button',{name:'Takeoffs',exact:true}).click(),'record_render');}
(async()=>{
  const info=await ready;browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/commands'))requests.push(request.postDataJSON());});
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',event=>window.qaCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  const response=await page.goto(`http://127.0.0.1:${info.port}/`);assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();await page.locator('#takeoff-upload').setInputFiles(info.fixture);await expect(page.locator('.takeoff-document')).toHaveCount(1,{timeout:60000});await idle();
  await command(async()=>{await page.getByLabel('Page number',{exact:true}).fill('3');await page.getByLabel('Page number',{exact:true}).press('Tab');},'record_render');
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  await page.getByRole('button',{name:'Scale',exact:true}).click();await page.getByLabel('Drawing calibration',{exact:true}).selectOption('scale:100');await command(()=>dialog('Apply drawing scale 1:100?',{},'Apply scale'),'add_calibration');
  // Test-only retained metadata represents imported legacy fields that no longer have editing controls.
  await page.route('**/commands',route=>{const body=route.request().postDataJSON();if(body.op==='create_item'){Object.assign(body.item.fields,{zone:`Retained zone ${body.item.fields.mark}`,group:'Retained group',notes:`=Retained notes ${body.item.fields.mark}`});return route.continue({postData:JSON.stringify(body)});}return route.continue();});
  let state;const definitions=[['QA-MATCH-FIRST','L01',120,1,[[100,150],[200,150]]],['QA-MATCH-SECOND','L02',90,2,[[100,250],[250,250]]],['QA-OTHER-THIRD','L03',60,3,[[400,500],[600,500]]]];
  for(const[mark,level,period,quantity,points]of definitions){await page.getByRole('button',{name:'Trace length',exact:true}).click();await draw(points);state=await command(()=>dialog('Add steel object',{'Member mark':mark,'Level':level,'Member type':'Beam','Steel section':'100UC15','Product':'CAFCO 300','Fire period (min)':period,'Crit. Temp (\u00b0C)':550,'Exposure':'Re-entrant - 3 sides','Count/QTY':quantity},'Add item'),'create_item');}
  await page.unroute('**/commands');const[a,b,c]=definitions.map(([mark])=>state.snapshot.items.find(item=>item.fields.mark===mark));
  const before=JSON.parse(JSON.stringify(state.snapshot.items)),lengths=Object.fromEntries(state.item_results.map(item=>[item.id,item.length_m]));
  await expect(page.locator('.takeoff-register-editor')).toHaveCount(0);
  const selectAll=page.getByRole('checkbox',{name:'Select all matching items',exact:true}),hideAll=page.getByRole('checkbox',{name:'Hide all matching items',exact:true});
  await selectAll.check();for(const item of[a,b,c])await expect(page.locator(`tr[data-item-id="${item.id}"]`).getByRole('checkbox',{name:/^Select /})).toBeChecked();
  await page.getByLabel('Filter register',{exact:true}).fill('QA-MATCH-');await hideAll.check();
  await expect(page.locator(`.takeoff-hit[data-item-id="${a.id}"]`)).toHaveCount(0);await expect(page.locator(`.takeoff-hit[data-item-id="${b.id}"]`)).toHaveCount(0);await expect(page.locator(`.takeoff-hit[data-item-id="${c.id}"]`)).toHaveCount(0);
  await page.getByLabel('Filter register',{exact:true}).fill('');await expect(page.locator('.takeoff-hit[data-item-id]')).toHaveCount(1);assert.equal(await hideAll.evaluate(el=>el.indeterminate),true);await hideAll.check();await expect(page.locator('.takeoff-hit[data-item-id]')).toHaveCount(0);await hideAll.uncheck();await expect(page.locator('.takeoff-hit[data-item-id]')).toHaveCount(3);
  await selectIds([b.id,a.id]);let panel=await settings();await expect(panel.getByLabel('Level',{exact:true})).toHaveValue('L02');await expect(panel.getByLabel('Fire period (min)',{exact:true})).toHaveValue('90');await expect(panel.getByLabel('Count/QTY',{exact:true})).toHaveValue('2');
  for(const label of['Zone','Group','Notes'])await expect(panel.getByLabel(label,{exact:true})).toHaveCount(0);await expect(panel.getByLabel('Exposed sides',{exact:true})).toBeHidden();
  await expect(panel.getByRole('button',{name:/Apply settings|Discard settings/})).toHaveCount(0);
  await page.route('**/commands',route=>route.request().postDataJSON()?.op==='bulk_update'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic stale settings revision'})}):route.continue());
  try{await command(async()=>{await panel.getByLabel('Level',{exact:true}).fill('SHARED');await panel.getByLabel('Level',{exact:true}).press('Tab');},'bulk_update',409);await expect(panel.getByLabel('Level',{exact:true})).toHaveValue('SHARED');await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('Synthetic stale settings revision');}finally{await page.unroute('**/commands');}
  await panel.getByLabel('Level',{exact:true}).fill('SHARED');state=await applySettings(panel);
  const patch=requests.at(-1);assert.deepEqual(patch.changes,{fields:{level:'SHARED'}});assert.deepEqual(new Set(patch.item_ids),new Set([a.id,b.id]));
  for(const item of[a,b]){const changed=state.snapshot.items.find(value=>value.id===item.id);assert.equal(changed.fields.level,'SHARED');assert.equal(changed.fields.fire_period_min,item.fields.fire_period_min);assert.equal(changed.quantity,item.quantity);assert.equal(changed.fields.notes,item.fields.notes);assert.equal(changed.fields.zone,item.fields.zone);}
  await panel.getByRole('button',{name:'Close settings',exact:true}).click();await selectAll.uncheck();await page.getByRole('button',{name:'Select',exact:true}).click();await drag([80,120],[280,300]);
  for(const item of[a,b])await expect(page.locator(`tr[data-item-id="${item.id}"]`).getByRole('checkbox',{name:/^Select /})).toBeChecked();await expect(page.locator(`tr[data-item-id="${c.id}"]`).getByRole('checkbox',{name:/^Select /})).not.toBeChecked();
  state=await confirm(2);const confirmations=Object.fromEntries(state.snapshot.items.filter(item=>[a.id,b.id].includes(item.id)).map(item=>[item.id,item.confirmation]));
  const previewWait=page.waitForResponse(r=>r.url().endsWith('/transfer-preview'));await page.getByRole('button',{name:'Preview transfer',exact:true}).click();assert.equal((await previewWait).status(),200);const transferWait=page.waitForResponse(r=>r.url().endsWith('/transfer-apply'));await dialog('Transfer 2 confirmed items?',{},'Add to schedule');const transferred=await transferWait;assert.equal(transferred.status(),200);const transferredState=await transferred.json();await idle();
  const calculatorBefore=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  panel=await settings();await panel.getByLabel('Stroke colour',{exact:true}).fill('#a020f0');await panel.getByLabel('Stroke Width',{exact:true}).fill('3.75');await applySettings(panel);
  let release,arrive;const held=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{arrive=resolve;});let captured=false;
  await page.route('**/commands',async route=>{if(route.request().postDataJSON()?.op==='bulk_update'&&!captured){captured=true;const response=await route.fetch();arrive();await held;await route.fulfill({response});}else await route.continue();});
  try{await panel.getByLabel('Opacity',{exact:true}).fill('0.65');await panel.getByLabel('Opacity',{exact:true}).press('Tab');await reached;await panel.getByLabel('Opacity',{exact:true}).fill('0.45');release();state=await applySettings(panel);await expect(panel.getByLabel('Opacity',{exact:true})).toHaveValue('0.45');}finally{release();await page.unroute('**/commands');}
  for(const item of[a,b]){const styled=state.snapshot.items.find(value=>value.id===item.id);assert.equal(styled.appearance.stroke_color.toLowerCase(),'#a020f0');assert.equal(styled.appearance.stroke_width,3.75);assert.equal(styled.appearance.opacity,.45);assert.deepEqual(styled.confirmation,confirmations[item.id]);assert.equal(styled.version,transferredState.snapshot.items.find(value=>value.id===item.id).version);}
  assert.deepEqual(state.snapshot.transfers,transferredState.snapshot.transfers);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorBefore);
  await page.setViewportSize({width:1600,height:2200});await page.evaluate(()=>window.scrollTo(0,0));await panel.screenshot({path:path.join(output,'settings-panel.png')});await page.screenshot({path:path.join(output,'multi-settings-style.png'),fullPage:true});await panel.getByRole('button',{name:'Close settings',exact:true}).click();await page.setViewportSize({width:1600,height:1100});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometryBefore=Object.fromEntries(state.snapshot.items.map(item=>[item.id,item.geometry]));state=await command(()=>drag([150,150],[180,170]),'move_items');
  const movement=requests.at(-1).delta_pdf;assert.ok(Math.abs(movement[0]-30)<1,JSON.stringify(movement));assert.ok(Math.abs(movement[1]-20)<1,JSON.stringify(movement));
  for(const item of[a,b]){const moved=state.snapshot.items.find(value=>value.id===item.id);assert.equal(moved.confirmation,null);assert.deepEqual(moved.evidence,before.find(value=>value.id===item.id).evidence);assert.ok(Math.abs(state.item_results.find(value=>value.id===item.id).length_m-lengths[item.id])<1e-10);for(let n=0;n<moved.geometry.points.length;n++)for(let axis=0;axis<2;axis++)assert.ok(Math.abs(moved.geometry.points[n][axis]-geometryBefore[item.id].points[n][axis]-movement[axis])<1e-10);assert.equal(state.snapshot.transfers.find(binding=>binding.item_id===item.id).status,'stale');}
  assert.deepEqual(state.snapshot.items.find(item=>item.id===c.id),before.find(item=>item.id===c.id));assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorBefore);
  const beforeRejectedMove=await snapshot();const rejected=await command(()=>drag([180,170],[10,40]),'move_items',400);assert.match(rejected.error,/crop|page|bound/i);assert.deepEqual(await snapshot(),beforeRejectedMove);
  await page.locator(`tr[data-item-id="${c.id}"]`).getByRole('checkbox',{name:/^Hide /}).check();await page.getByLabel('Filter register',{exact:true}).fill('QA-MATCH-');
  await save();const saved=JSON.parse(fs.readFileSync(info.project));await load();const reopened=await snapshot();for(const item of[a,b])assert.deepEqual(reopened.items.find(value=>value.id===item.id).appearance,saved.takeoffs.items.find(value=>value.id===item.id).appearance);
  await page.getByLabel('Filter register',{exact:true}).fill('QA-MATCH-');
  await page.locator(`tr[data-item-id="${b.id}"]`).getByRole('checkbox',{name:/^Hide /}).check();
  const {path:xlsx}=await download('Download XLSX');evidence.xlsx=xlsx;
  const check=spawnSync(python,['-c',"import json,sys\nfrom openpyxl import load_workbook\nw=load_workbook(sys.argv[1],data_only=False)\nprint(json.dumps({**{s.title:list(s.values) for s in w},'__formulas__':[c.coordinate for s in w for row in s for c in row if c.data_type=='f']}))",xlsx],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(check.status,0,check.stderr);const workbook=JSON.parse(check.stdout),text=JSON.stringify(workbook);assert.deepEqual(workbook.__formulas__,[]);for(const item of[a,b,c]){assert.ok(text.includes(item.id));assert.ok(text.includes(item.fields.notes));assert.ok(text.includes(item.fields.zone));}assert.ok(text.toLowerCase().includes('unconfirmed'));evidence.xlsxSheets=Object.keys(workbook);
  let releaseRender;
  const renderHeld=new Promise(resolve=>{releaseRender=resolve;});
  let renderCaptured=false,renderHeldReady=false,focusComplete=false;
  await page.route('**/commands',async route=>{
    if(route.request().postDataJSON()?.op==='record_render'&&!renderCaptured){renderCaptured=true;const response=await route.fetch();renderHeldReady=true;await renderHeld;await route.fulfill({response});}
    else await route.continue();
  });
  try{
    const focusing=focusRow(a,reopened.documents[0]).then(()=>{focusComplete=true;});focusing.catch(()=>{});
    await expect.poll(()=>renderHeldReady,{timeout:30000}).toBe(true);assert.equal(focusComplete,false,'Row focus must wait for source rendering, not just its first idle instant');
    const pdfRequests=[];const observe=request=>{if(request.url().endsWith('/export/marked-pdf'))pdfRequests.push(request);};page.on('request',observe);
    try{
      await page.getByRole('button',{name:'Download PDF',exact:true}).click();
      await expect(page.locator('#takeoffs-workspace .message')).toContainText('Finish the current takeoff operation before downloading.');
      assert.equal(pdfRequests.length,0,'A still-rendering row must not submit a premature export');
    }finally{page.off('request',observe);releaseRender();}
    await focusing;evidence.exportReadiness={heldRenderRejectedPrematureExport:true,completedFocusedRowBeforeExport:true};
  }finally{releaseRender();await page.unroute('**/commands');}
  const {path:pdf,request:pdfBody}=await download('Download PDF');assert.equal(pdfBody.mode,'steel');assert.equal(pdfBody.document_id,reopened.documents[0].id);assert.deepEqual(pdfBody.item_ids,[a.id]);evidence.pdf=pdf;
  const inspected=spawnSync(python,['-c',"import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nprint(json.dumps({'pages':[{'width':float(p.mediabox.width),'height':float(p.mediabox.height),'rotation':p.rotation,'user_unit':p.user_unit,'text':p.extract_text()} for p in r.pages]}))",pdf],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(inspected.status,0,inspected.stderr);
  const document=JSON.parse(inspected.stdout),pdfText=document.pages.map(value=>value.text).join('\n');assert.ok(document.pages.length>=4);assert.equal(document.pages[2].width,1080);assert.ok(document.pages[2].height>=1685);assert.equal(document.pages[2].rotation,0);assert.equal(document.pages[2].user_unit,1);assert.ok(pdfText.includes('QA-MATCH-FIRST'));assert.ok(!pdfText.includes('QA-MATCH-SECOND'));assert.ok(!pdfText.includes('QA-OTHER-THIRD'));assert.ok(/unconfirmed|draft/i.test(pdfText));assert.ok(pdfText.includes('SYNTHETIC TAKEOFF DRAWING'));assert.ok(pdfText.includes('Rotated crop with UserUnit 2'));evidence.pdfPages=document.pages.map(({text,...metadata})=>metadata);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(info.fixture)).digest('hex'),reopened.documents[0].sha256);
  fs.writeFileSync(path.join(output,'pdf-inspection.json'),JSON.stringify(document,null,2));
  evidence.ids={a:a.id,b:b.id,c:c.id};evidence.move=movement;evidence.sourceUnchanged=true;evidence.calculatorInputsUnchanged=true;
  await page.locator('.takeoff-register').screenshot({path:path.join(output,'register-selection.png')});assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,evidence,errors,csp:[],requests},null,2));console.log(`PASS: selection/hiding, first-selected changed-only settings, appearance authority, PDF-space movement, stale links, save/reopen, draft XLSX and scoped marked PDF. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),await page.locator('body').innerText().catch(()=>''));}process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
