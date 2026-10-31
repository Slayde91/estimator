const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const { waitForTakeoffDownload } = require('./native_download_helpers.cjs');
const { clickProjectControl, openProjectSection } = require('./project_actions.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `markup-downloads-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceFiles = ['static/takeoffs.js','static/takeoff-physical.js','static/takeoffs.css','static/downloads.js','static/app.js',
  'estimator/takeoff_markup_exports.py','estimator/takeoff_markup_pdf.py','estimator/takeoff_markup_pdf_worker.py',
  'estimator/takeoff_exports.py','estimator/takeoff_physical_markers.py','estimator/takeoff_workspace.py','estimator/takeoff_http.py',
  'estimator/download_files.py','estimator/download_progress.py','tests/test_takeoff_physical_ui.cjs',
  'tests/browser/markup_downloads.cjs','tests/browser/native_download_helpers.cjs','tests/browser/viewer_helpers.cjs',
  'tests/browser/settings_helpers.cjs','tests/browser/project_actions.cjs','tests/browser/section_navigation.cjs','tests/browser/fixtures.py',
  'static/fonts/Vera.ttf','static/fonts/VeraBd.ttf','data/calculator.json','data/penetration.json.gz'];
const beforeHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(root, file))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], { cwd:root, windowsHide:true });
let logs='', browser, page, origin, info, current;
server.stderr.on('data',value=>{ logs+=value; });
const ready = new Promise((resolve,reject)=>{ let text='';const timer=setTimeout(()=>reject(new Error(`Fixture startup timeout: ${logs}`)),120000);
  server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]));}catch(error){reject(error);}}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${logs}`));}); });
const errors=[], evidence={exports:[],menus:[],checks:[]};
async function idle(){await expect.poll(()=>page.evaluate(()=>window.CeasefireActivity.active)).toBe(false);await settingsSettled(page);}
async function snapshot(){await idle();return page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());}
async function command(op, values={}){
  const sid=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId()), reply=await page.request.post(`${origin}/api/takeoffs/sessions/${sid}/commands`,{data:{op,request_id:randomUUID(),expected_revision:current.revision,...values}});
  assert.equal(reply.status(),200,await reply.text());current=await reply.json();return current;
}
async function inspect(file){
  const result=spawnSync(process.env.CEASEFIRE_PYTHON||'python',['-B','-c',
    "import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1],strict=True)\nprint(json.dumps({'pages':len(r.pages),'text':[p.extract_text() or '' for p in r.pages],'dimensions':[[float(p.mediabox.width),float(p.mediabox.height)] for p in r.pages],'annots':any('/Annots' in p for p in r.pages),'actions':'/OpenAction' in r.trailer['/Root'] or '/Names' in r.trailer['/Root']}))",file],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
async function csvDownload(scope, action){
  const before=await snapshot(), pending=waitForTakeoffDownload(page);await action();const result=await pending;
  assert.ok(path.resolve(result.receipt.path).startsWith(path.resolve(output)+path.sep));assert.ok(result.receipt.filename.endsWith('.csv'));
  const file=path.join(output,`${scope}.csv`);await result.saveAs(file);
  const parsed=spawnSync(process.env.CEASEFIRE_PYTHON||'python',['-B','-c',"import csv,json,sys\nwith open(sys.argv[1],encoding='utf-8-sig',newline='') as f: print(json.dumps(list(csv.DictReader(f))))",file],{encoding:'utf8',windowsHide:true});
  assert.equal(parsed.status,0,parsed.stderr);assert.deepEqual(await snapshot(),before);
  const rows=JSON.parse(parsed.stdout);evidence.exports.push({scope,kind:'csv',path:file,sha256:hash(file),receipt:result.receipt,rows});return rows;
}
async function zoomTo(target, metadata){
  const width=(metadata.rotation===90||metadata.rotation===270?metadata.view[3]-metadata.view[1]:metadata.view[2]-metadata.view[0])*metadata.user_unit;
  const actual=()=>page.locator('.takeoff-viewport canvas').evaluate((canvas,width)=>parseFloat(canvas.style.width)/width,width);
  for(let attempt=0;attempt<10;attempt++){
    const current=await actual();if(Math.abs(current-target)<1e-8)return;
    const delta=Math.max(-300,Math.min(300,-Math.log(target/current)/.002));
    await renderDrawing(page,async()=>{const viewport=page.locator('.takeoff-viewport');await viewport.scrollIntoViewIfNeeded();const box=await viewport.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,delta);await page.keyboard.up('Control');},1);await idle();
  }
  assert.ok(Math.abs(await actual()-target)<1e-8,'Native Ctrl+wheel installs the requested displayed zoom');
}
async function download(kind, label, scope, held=false){
  const before=await snapshot(), pending=waitForTakeoffDownload(page);
  await openProjectSection(page,'documentation');
  const control=page.locator('button[data-document-kind="takeoff.markups.pdf"]');
  const trigger=async()=>{
    await control.click();const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Takeoff workspace',{exact:true}).selectOption(scope.startsWith('physical-')?scope.slice(9):scope==='wall'?'walls_floors':scope);
    await dialog.getByLabel('Markup document',{exact:true}).selectOption(kind);
    await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    if(kind.startsWith('current-')){await expect(dialog.getByRole('heading')).toHaveText('Choose markup Source Document');await dialog.getByRole('button',{name:'Download',exact:true}).click();}
  };
  let release, arrived, responseSeen;
  if(held){const gate=new Promise(resolve=>{release=resolve;});let rejectArrival;
    const reached=new Promise((resolve,reject)=>{arrived=resolve;rejectArrival=reject;});reached.catch(()=>{});
    const tasks=[],holdRoute=route=>{
      const task=(async()=>{const response=await route.fetch();responseSeen=await response.json();arrived();await gate;await route.fulfill({response});})();
      tasks.push(task);task.catch(rejectArrival);return task;
    };
    await page.route('**/export/markup-pdf',holdRoute);
    try{
      await trigger();await Promise.race([reached,pending]);
      assert.equal(responseSeen.saved,true);assert.ok(fs.statSync(responseSeen.path).size>0);
      const progress=page.locator('#view-documentation .document-download-progress progress');await expect(progress).toHaveCount(1);
      assert.equal(await page.evaluate(()=>window.CeasefireDocumentation.hasPendingOperation()),true);
      assert.ok(await progress.evaluate(el=>el.value)<100,'UI100 requires receipt delivery, even after server file save');
      release();await Promise.all(tasks);
    }finally{
      release();await Promise.allSettled(tasks);await page.unroute('**/export/markup-pdf',holdRoute);
    }
  }else await trigger();
  const result=await pending, request=result.response.request().postDataJSON();assert.equal(request.kind,kind);
  assert.ok(path.resolve(result.receipt.path).startsWith(path.resolve(output)+path.sep),'All actual native files stay in the disposable fixture');
  const file=path.join(output,`${scope}-${kind}.pdf`);await result.saveAs(file);const content=await inspect(file);
  assert.equal(content.annots,false);assert.equal(content.actions,false);
  assert.deepEqual(await snapshot(),before,'PDF download preserves exact source, markups, precision, confirmation and audit identities');
  const parsed={scope,kind,path:file,sha256:hash(file),receipt:result.receipt,request,content};evidence.exports.push(parsed);return parsed;
}
(async()=>{try{
  info=await ready;origin=`http://127.0.0.1:${info.port}`;evidence.port=info.port;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:1000}});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.__markupDownloadCsp=[];document.addEventListener('securitypolicyviolation',event=>window.__markupDownloadCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});await page.goto(origin);
  await chooseTakeoff(page,'Steel');await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture),1);await idle();
  const sid=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());current=await(await page.request.get(`${origin}/api/takeoffs/sessions/${sid}`)).json();
  const doc=current.snapshot.documents[0], originalHash=hash(info.fixture);evidence.original=originalHash;
  // Seed source-bound synthetic records through the unchanged public commands.
  await command('add_calibration',{calibration:{id:randomUUID(),document_id:doc.id,page:1,points:[[100,400],[500,400]],distance_m:10,uniform_scale:true}});
  await command('create_item',{item:{mode:'steel',quantity:2,geometry:{document_id:doc.id,page:1,points:[[100,400],[500,400]]},measurement:{method:'calibrated',calibration_id:current.snapshot.calibrations.at(-1).id},fields:{mark:'STEEL-COPY',section:'100UC15',member_type:'Beam',exposure:'Re-entrant - 3 sides',fire_period_min:120,critical_temperature:550,product:'CAFCO 300',sides:3},evidence:[]}});
  const steel=current.snapshot.items.at(-1);
  await command('update_item',{item_id:steel.id,changes:{appearance:{display_values:true},length_additions:Array.from({length:5},(_,index)=>({id:randomUUID(),kind:index%2?'drop':'riser',length_mm:1001.125+index,document_id:doc.id,page:1,anchor:{point_index:1,point:[500,400]}}))}});
  for(const [mode,number,text]of[['duct',2,'DUCT-COPY'],['wall',3,'WALL-COPY'],['slab',3,'FLOOR-COPY']]){
    await command('record_render',{document_id:doc.id,page:number,success:true,warnings:[]});
    await command('create_graphic',{graphic:{mode,document_id:doc.id,source_sha256:doc.sha256,page:number,kind:'textbox',geometry:{quad_pdf:[[40,120],[260,120],[260,40],[40,40]]},text,appearance:{}}});
  }
  await command('record_render',{document_id:doc.id,page:4,success:true,warnings:[]});
  for(const scope of['defect_reports','service_plans']){
    await command('create_signature',{signature:{mode:scope,document_id:doc.id,source_sha256:doc.sha256,page:4,quad_pdf:[[40,180],[220,180],[220,130],[40,130]],strokes:[[[0,0],[.2,.8],[.55,.3],[1,1]]],appearance:{}}});
    await command('create_graphic',{graphic:{mode:scope,document_id:doc.id,source_sha256:doc.sha256,page:4,kind:'textbox',geometry:{quad_pdf:[[40,120],[260,120],[260,40],[40,40]]},text:scope,appearance:{}}});
  }
  const seeded=current.snapshot;await renderDrawing(page,()=>page.evaluate(async value=>{const t=window.CeasefireTakeoffs;t.applyProject(await t.prepareProject(value,t.sessionId()));await t.open();},seeded),1);await idle();
  const calculatorsBefore=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  const kinds=[['current-all','Download Full Markup'],['current-marked','Download Markups Only'],['all-all','Download All Markups'],['all-marked','Download Full Markups Only']];
  for(const scope of['steel','duct','wall','physical-defect_reports','physical-service_plans']){
    await chooseTakeoff(page,scope.startsWith('physical-')?(scope.endsWith('service_plans')?'Service Plans':'Defect Reports'):scope);await idle();
    const toggle=page.locator('.takeoff-workspace-heading').getByRole('button',{name:scope.startsWith('physical-')?'Document':'Takeoff register document actions',exact:true});
    await toggle.click();const menu=page.locator('.takeoff-workspace-heading .calculator-document-actions').filter({visible:true});
    await expect(menu.getByRole('button')).toHaveCount(3);for(const[,label]of kinds)await expect(page.getByRole('button',{name:label,exact:true})).toHaveCount(0);
    await page.keyboard.press('End');await expect(menu.getByRole('button',{name:'All items',exact:true})).toBeFocused();await page.keyboard.press('Escape');evidence.menus.push({scope,markupActionsRemoved:true,documentationExportsRetained:true,keyboard:true});
    for(const[kind,label]of kinds){const result=await download(kind,label,scope,scope==='steel'&&kind==='current-all');const expected=kind==='current-all'?4:kind==='current-marked'?1:kind==='all-all'?20:5;
      assert.equal(result.content.pages,expected);const text=result.content.text.join('').replace(/\s/g,'');
      for(const marker of(kind.startsWith('all-')?['STEEL-COPY','DUCT-COPY','WALL-COPY','FLOOR-COPY','defect_reports','service_plans']:[scope==='steel'?'STEEL-COPY':scope==='duct'?'DUCT-COPY':scope==='wall'?'WALL-COPY':scope.slice(9)]))assert.ok(text.includes(marker),marker);
      if(scope==='steel'&&kind==='current-all')for(let index=0;index<5;index++)assert.ok(text.includes((1001.125+index).toLocaleString('en-AU',{maximumFractionDigits:3}).replace(/\s/g,'')));
    }
  }
  await chooseTakeoff(page,'Steel');await idle();
  for(const zoom of[.5,2]){if(await page.getByLabel('Page number',{exact:true}).inputValue()!=='1')await renderDrawing(page,()=>page.getByRole('button',{name:'First page',exact:true}).click(),1);await idle();await zoomTo(zoom,doc.pages[0]);
    const labels=await page.locator('.takeoff-rise-drop,.takeoff-value-label,.takeoff-label:not(.takeoff-rise-drop)').evaluateAll(elements=>elements.map(el=>({text:[...el.childNodes].filter(value=>value.nodeType===Node.TEXT_NODE).map(value=>value.textContent).join(''),font:getComputedStyle(el).fontFamily,weight:getComputedStyle(el).fontWeight,size:getComputedStyle(el).fontSize,x:Number(el.getAttribute('x')),y:Number(el.getAttribute('y')),glyph_start:el.getNumberOfChars()?{x:el.getStartPositionOfChar(0).x,y:el.getStartPositionOfChar(0).y}:null,bounds:{x:el.getBBox().x,y:el.getBBox().y,width:el.getBBox().width,height:el.getBBox().height}})));
    assert.ok(labels.length>=7);for(const label of labels){assert.ok(label.font.includes('CeasefireDrawing'));assert.equal(label.weight,'700');}
    await expect(page.locator('[data-addition-arrow="riser"]')).toHaveCount(6);await expect(page.locator('[data-addition-arrow="drop"]')).toHaveCount(4);
    await page.locator('.takeoff-rise-drop').first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`viewer-labels-${zoom}.png`)});
    const result=await download('current-all','Download Full Markup',`steel-zoom-${zoom}`);const actualZoom=result.request.rendering[doc.id].zoom;
    const physicalWidth=(doc.pages[0].view[2]-doc.pages[0].view[0])*doc.pages[0].user_unit;
    assert.ok(Math.abs(actualZoom-zoom)*physicalWidth<.01,'Native wheel zoom agrees with the rendered page within0.01CSSpx');
    evidence.checks.push({zoom:actualZoom,requestedZoom:zoom,fontAssets:{regular:beforeHashes['static/fonts/Vera.ttf'],bold:beforeHashes['static/fonts/VeraBd.ttf']},labels,pdf:result.path});
  }
  current=await(await page.request.get(`${origin}/api/takeoffs/sessions/${sid}`)).json();
  await command('review_items',{item_ids:[steel.id]});await command('confirm_items',{item_ids:[steel.id]});
  const defectId=randomUUID(),preview=await page.request.post(`${origin}/api/takeoffs/sessions/${sid}/physical/preview`,{data:{expected_revision:current.revision,commands:[{op:'create',kind:'defect',entity:{id:defectId,fields:{label:'=CSV-SAFE',frl:'120/120/120'},evidence:[],uncertainty:{state:'unresolved',note:'Synthetic CSV assertion'}}}]}});
  assert.equal(preview.status(),200,await preview.text());const proposed=await preview.json();
  const applied=await page.request.post(`${origin}/api/takeoffs/sessions/${sid}/physical/apply`,{data:{expected_revision:current.revision,request_id:randomUUID(),preview_id:proposed.preview_id}});assert.equal(applied.status(),200,await applied.text());current=await applied.json();
  await renderDrawing(page,()=>page.evaluate(async value=>{const t=window.CeasefireTakeoffs;t.applyProject(await t.prepareProject(value,t.sessionId()));await t.open();},current.snapshot),1);await idle();
  await page.locator(`tr[data-item-id="${steel.id}"]`).getByRole('checkbox',{name:'Select STEEL-COPY',exact:true}).check();
  const ordinaryCsv=await csvDownload('steel-register',()=>page.evaluate(()=>window.CeasefireTakeoffs.exportRegister('csv')));
  assert.equal(ordinaryCsv.length,1);assert.equal(ordinaryCsv[0]['Item ID'],steel.id);assert.equal(ordinaryCsv[0]['Quantity'],'2');
  assert.equal(Number(ordinaryCsv[0]['Length per item m']),15.015625);assert.equal(Number(ordinaryCsv[0]['Total length m']),30.03125);
  await chooseTakeoff(page,'Defect Reports');await idle();const physicalCsv=await csvDownload('physical-register',()=>page.evaluate(()=>window.CeasefireTakeoffs.exportPhysical('csv')));
  assert.equal(physicalCsv.length,1);assert.equal(physicalCsv[0].entity_id,defectId);assert.equal(physicalCsv[0].label,"'=CSV-SAFE");assert.equal(physicalCsv[0]['export_status [UNAPPROVED DRAFT]'],'UNAPPROVED DRAFT');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorsBefore);await chooseTakeoff(page,'Steel');await idle();
  evidence.checks.push('Public ordinary and physical CSV exports save real native files with exact unrounded quantity/length, formula-safe labels and unchanged drafts/calculators');
  const save=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));await clickProjectControl(page,'Save');assert.equal((await save).status(),200);await expect(page.locator('#project-save-state')).toHaveText('Saved project');const projectHash=hash(info.project), savedSnapshot=await snapshot();
  await clickProjectControl(page,'Load');await expect(page.getByRole('dialog',{name:'Load this project?',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();await chooseTakeoff(page,'Steel');await idle();
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible();await expect(page.locator('.takeoff-progress')).toContainText('Original source');assert.equal(hash(info.project),projectHash);assert.equal(hash(info.fixture),originalHash);
  assert.deepEqual((await snapshot()).items,savedSnapshot.items);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorsBefore);evidence.checks.push('Saved project reopens into a fresh available session and a full original-source bitmap');
  const active=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());assert.notEqual(active,sid);const beforeClosed=await snapshot();assert.equal((await page.request.post(`${origin}/api/takeoffs/sessions/${active}/close`,{data:{}})).status(),200);
  await page.getByRole('button',{name:'Last page',exact:true}).click();await expect(page.locator('#takeoffs-workspace [role="alert"]')).toContainText('The takeoff session is unavailable. Reopen the project to continue.');
  const reject=await page.request.post(`${origin}/api/takeoffs/sessions/${active}/commands`,{data:{op:'confirm_items',request_id:randomUUID(),expected_revision:beforeClosed.revision,item_ids:[steel.id]}});assert.equal(reject.status(),400);
  evidence.checks.push('Explicitly closed synthetic session fails rendering and confirmation closed; historical missing-session cause remains unproven');
  const notice=()=>page.locator('#takeoff-message');
  const noticeState=()=>notice().evaluate(el=>({hidden:el.hidden,text:el.textContent,role:el.getAttribute('role')}));
  evidence.closedSessionNotice=await noticeState();assert.equal(evidence.closedSessionNotice.hidden,false);assert.equal(evidence.closedSessionNotice.role,'alert');
  await page.screenshot({path:path.join(output,'closed-session-error.png'),fullPage:true});
  const reopening=page.waitForResponse(response=>response.url().endsWith('/api/project/open'));
  await clickProjectControl(page,'Load');assert.equal((await reopening).status(),200);
  await expect(page.getByRole('dialog',{name:'Load this project?',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await renderDrawing(page,()=>chooseTakeoff(page,'Steel'),1);await idle();
  const fresh=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());assert.notEqual(fresh,active);
  const reopened=await snapshot();assert.deepEqual(reopened.items,savedSnapshot.items);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorsBefore);
  evidence.reopenedSession={old:active,fresh,notice:await noticeState(),itemsExact:true,calculatorsExact:true,
    bitmap:await page.locator('.takeoff-viewport canvas').evaluate(canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>0&&(pixels[index]<245||pixels[index+1]<245||pixels[index+2]<245))ink++;return {width:canvas.width,height:canvas.height,ink};}),
    progress:await page.locator('.takeoff-progress').innerText()};
  assert.ok(evidence.reopenedSession.bitmap.width>0&&evidence.reopenedSession.bitmap.height>0&&evidence.reopenedSession.bitmap.ink>100);
  assert.ok(evidence.reopenedSession.progress.includes('Original source'));
  assert.deepEqual(evidence.reopenedSession.notice,{hidden:true,text:'',role:'status'},'Successful explicit project replacement retires only its old page error');
  await page.screenshot({path:path.join(output,'fresh-session-before-confirm.png'),fullPage:true});
  await page.locator(`tr[data-item-id="${steel.id}"]`).getByRole('checkbox',{name:/^Select /}).check();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'Confirm 1 items?',exact:true});await expect(confirmation).toBeVisible();
  const confirming=page.waitForResponse(response=>response.url().endsWith('/commands')&&response.request().postDataJSON()?.op==='confirm_items');
  await confirmation.getByRole('button',{name:'Confirm items',exact:true}).click();
  const response=await confirming,confirmed=await response.json();
  assert.equal(response.status(),200,JSON.stringify(confirmed));await idle();
  assert.equal((await snapshot()).items.find(item=>item.id===steel.id).state,'confirmed');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculatorsBefore);
  evidence.freshConfirmation={status:response.status(),item:steel.id,state:'confirmed',notice:await noticeState()};
  evidence.checks.push('Native reload after a closed session creates a fresh session and full original bitmap, clears its owned stale alert, and permits native confirmation; invalid old session still returns400');
  evidence.csp=await page.evaluate(()=>window.__markupDownloadCsp);assert.deepEqual(evidence.csp,[]);
  assert.equal(hash(info.project),projectHash);assert.equal(hash(info.fixture),originalHash);
  assert.deepEqual(errors,[]);const afterHashes=Object.fromEntries(sourceFiles.map(file=>[file,hash(path.join(root,file))]));assert.deepEqual(afterHashes,beforeHashes);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,errors,evidence,source_before:beforeHashes,source_after:afterHashes,test_sha:hash(__filename)},null,2));console.log(`Markup downloads browser acceptance passed: ${output}`);
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});const afterHashes=Object.fromEntries(sourceFiles.map(file=>[file,hash(path.join(root,file))]));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack||error),errors,evidence,source_before:beforeHashes,source_after:afterHashes,test_sha:hash(__filename)},null,2));console.error(error);process.exitCode=1;
}finally{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();}})();
