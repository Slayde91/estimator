// Owned disposable application. Never visits the live port or existing tabs.
const {chromium,expect}=require('@playwright/test'),{spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {cycleTheme}=require('./theme_navigation.cjs');
const root=path.resolve(__dirname,'../..'),parent=path.join(root,'.runtime/browser-qa');fs.mkdirSync(parent,{recursive:true});
const output=process.env.CEASEFIRE_COLUMNS_OUTPUT||path.join(parent,`schedule-columns-${Date.now()}`);fs.mkdirSync(output,{recursive:false});
function sourceHashes(){
 const files=['tests/browser/schedule_columns.cjs','tests/browser/calculator_actions.cjs','tests/browser/theme_navigation.cjs','tests/browser/monokote_fixture.py','tests/browser/standard_fixture.py','tests/test_monokote_hollow.py','package.json','package-lock.json','requirements.txt','requirements-dev.txt'].filter(name=>fs.existsSync(path.join(root,name)));
 function walk(directory,include){for(const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true})){const name=`${directory}/${entry.name}`;if(entry.isDirectory())walk(name,include);else if(entry.isFile()&&include(name))files.push(name);}}
 walk('static',()=>true);walk('estimator',name=>name.endsWith('.py'));walk('data',()=>true);
 return Object.fromEntries(files.sort().map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
}
const evidence={source_sha256:sourceHashes(),registers:[],locales:[],themes:[],served_css:[],calculation_requests:[],errors:[]},cssResponses=[];let logs='',browser,page,base,calculations=0;
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'monokote_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error(logs||'Fixture startup timed out')),120000);server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error(`Fixture exited ${code}: ${logs}`));});});
async function idle(){await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',{timeout:60000});await page.waitForFunction(()=>!window.CeasefireActivity?.active);}
async function fireIdle(){
 // Applying a Firestopping draft schedules the Main estimate after 180 ms.
 // Activity covers fetches, so it can be idle while that timer is pending.
 for(const id of ['penetration-recalculate','penetration-schedule-recalculate','main-estimate-summary'])await expect(page.locator('#'+id)).toHaveAttribute('aria-busy','false',{timeout:60000});
 await page.waitForFunction(()=>!window.CeasefireActivity?.active);
}
async function snapshot(){return page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());}
async function boot(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&window.ClassifireBoot?.state==='ready');await page.waitForFunction(()=>!window.CeasefireActivity?.active);}
async function chooser(){const button=page.locator('#calculator-pages .schedule-column-toggle');await button.click();const panel=page.locator('#'+await button.getAttribute('aria-controls'));await expect(panel).toBeVisible();return panel;}
const nativeCell=(id)=>page.locator(`.calculator-schedule-table thead [data-schedule-column="${id}"]`);
const removedBoardColumns='MNOPQRSTU'.split(''),retainedBoardInputs={M9:'Standard',N9:null,O9:'Auto',P9:'Published first',Q9:'Standard box',R9:203.123456789012,S9:203.234567890123,T9:58.1234567890123,U9:46.1234567890123};
async function assertBoardColumnsRemoved(panel){
 for(const column of removedBoardColumns){await expect(nativeCell(`column:${column}`)).toHaveCount(0);if(panel)await expect(panel.locator(`[data-schedule-column-choice="column:${column}"]`)).toHaveCount(0);}
}
async function selectAll(panel,checked){
 const all=panel.locator('[data-schedule-select-all]');
 // Native mixed checkboxes have checked=false. setChecked(false) would do
 // nothing, so perform the actual select-all action before deselecting it.
 if(!checked&&await all.evaluate(input=>input.indeterminate))await all.check();
 await all.setChecked(checked);await expect(all).toHaveJSProperty('indeterminate',false);
}
async function screenshot(name){await page.screenshot({path:path.join(output,name),fullPage:true});}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);base=`http://127.0.0.1:${info.port}`;evidence.fixturePort=info.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:850}});page.setDefaultTimeout(30000);
 page.on('pageerror',error=>evidence.errors.push(error.message));page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(request.method()==='POST'&&/\/(worksheet|calculate)$/.test(pathname)){calculations++;evidence.calculation_requests.push(pathname);}});
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===base&&['/calculators.css','/penetration.css'].includes(url.pathname))cssResponses.push((async()=>{assert.equal(response.status(),200);const bytes=await response.body();evidence.served_css.push({url:response.url(),source:`static${url.pathname}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});})().catch(error=>evidence.errors.push(String(error))));});
 for(const [id,inputs,row]of [
   ['steel_board',{CALCULATOR:{A9:'Column chooser precise fixture',C9:'TRAFALGAR COREX',D9:'200UC46',F9:1.23456789012345,G9:4,H9:120,I9:'Column',J9:550,...retainedBoardInputs}},9],
  ['ductwork',{CALCULATOR:{B11:'300 x 200',C11:'CAFCO 300',D11:1.23456789012345,E11:'120/120/120',F11:1,G11:0,H11:'Internal',I11:'Horizontal'}},11],
  ['steel_vermiculite',{SCHEDULE:{A10:'Spray fixture',B10:'CAFCO 300',J10:1.23456789012345,I10:2}},10],
  ['steel_intumescent',{SCHEDULE:{A10:'Intumescent fixture',B10:'SC902',J10:1.23456789012345,I10:2}},10],
 ]){const reply=await page.request.put(`${base}/api/calculators/${id}/state`,{data:{inputs,schedule_rows:[row]}});assert.equal(reply.status(),200);}
 await page.addInitScript(()=>localStorage.setItem('ceasefire.scheduleColumns.v1.steel_vermiculite:SCHEDULE',JSON.stringify({version:1,hidden:['column:X']})));
 await page.goto(base);await boot();
 for(const [id,title]of [['steel_vermiculite','Steel (spray)'],['steel_intumescent','Steel (intumescent)'],['steel_board','Steel (board)'],['ductwork','Duct']]){
  await chooseCalculator(page,title);await idle();
  const response=await page.request.get(`${base}/api/calculators/${id}`);assert.equal(response.status(),200);const definition=await response.json(),sheet=definition.sheets.find(sheet=>sheet.name===definition.schedule.sheet),expected=sheet.register_columns;
  assert.ok(expected.length>20);const table=page.locator('.calculator-schedule-table');await expect(table).toBeVisible();
  const headers=await table.locator('thead [data-schedule-column]').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.scheduleColumn,label:node.textContent})));
  const native=headers.filter(column=>column.id.startsWith('column:')).map(column=>column.id.slice(7));
  const number=column=>[...column].reduce((sum,letter)=>sum*26+letter.charCodeAt(0)-64,0);
  const removedSources=[...definition.schedule.columns.filter(column=>/^thickness source$/i.test(column.label.trim())).map(column=>number(column.column)),...(id==='ductwork'?[42,43]:[])];
  const browserOmissions=id==='steel_board'?removedBoardColumns.map(number):[];
  assert.deepEqual(native.map(number).sort((a,b)=>a-b),expected.filter(column=>!removedSources.includes(column)&&!browserOmissions.includes(column)).sort((a,b)=>a-b));
  assert.ok(headers.every(column=>!/^thickness source$/i.test(column.label.trim())));
  if(['steel_vermiculite','steel_intumescent'].includes(id)){
   const reportIndex=headers.findIndex(column=>column.id==='virtual:report');
   assert.equal(headers[reportIndex-1].id,'column:J');assert.equal(headers[reportIndex+1].id,'column:Y');
  }
  assert.equal(new Set(headers.map(column=>column.id)).size,headers.length);assert.ok(headers.some(column=>column.id==='virtual:report'));assert.ok(headers.some(column=>column.id==='virtual:actions'));
  const before=await snapshot(),requests=calculations,panel=await chooser();
  const choices=panel.locator('[data-schedule-column-choice]');assert.equal(await choices.count(),headers.length);
  // Spray has a deliberately retained version-1 preference above; it overrides
  // new defaults. The other fresh profiles use only the requested hidden IDs.
  const expectedHidden=id==='ductwork'?['V','W','X','AA','AB','AC','AD']:id==='steel_intumescent'?['G','K','L','M','N','Q','T']:[];
  const initiallyHidden=await choices.evaluateAll(nodes=>nodes.filter(node=>!node.checked).map(node=>node.dataset.scheduleColumnChoice));
  assert.deepEqual(initiallyHidden.slice().sort(),expectedHidden.map(column=>'column:'+column).sort());
  if(['ductwork','steel_vermiculite'].includes(id))await expect(page.locator('#calculator-grid > .calculator-schedule-guidance')).toHaveCount(0);
  if(id==='steel_vermiculite')assert.equal(headers.find(column=>column.id==='column:O').label,'DFT (mm)');
  if(id==='ductwork'){
   const note=page.locator('.calculator-schedule-tools .calculator-schedule-overview-note');
   await expect(note).toHaveText('For FyreWrap, Internal, External and Both use the exhaust application rules. Select pressurisation separately.');
   assert.equal(await note.evaluate(node=>node.previousElementSibling.classList.contains('calculator-schedule-help')),true);
  }
  if(id==='steel_board'){
   await assertBoardColumnsRemoved(panel);for(const column of removedBoardColumns)assert.ok(expected.includes(number(column)),'Source API retains optional inputs');
   for(const column of ['L','V','W','X','Y','AA','AC','AD'])await expect(panel.locator(`[data-schedule-column-choice="column:${column}"]`)).toBeChecked();
   for(const [address,value]of Object.entries(retainedBoardInputs))assert.equal(before.steel_board.inputs.CALCULATOR[address],value);
  }
  for(const header of headers){const checkbox=panel.locator(`[data-schedule-column-choice="${header.id}"]`);await checkbox.check();await expect(nativeCell(header.id)).toBeVisible();await checkbox.uncheck();await expect(nativeCell(header.id)).toBeHidden();await checkbox.check();await expect(nativeCell(header.id)).toBeVisible();}
  await selectAll(panel,false);await expect(table).toBeHidden();await expect(page.locator('#calculator-grid .schedule-columns-empty')).toBeVisible();await selectAll(panel,true);await expect(table).toBeVisible();
   if(id==='steel_board')await assertBoardColumnsRemoved(panel);
  await panel.press('Escape');await expect(panel).toBeHidden();await expect(page.locator('#calculator-pages .schedule-column-toggle')).toBeFocused();
  assert.deepEqual(await snapshot(),before);assert.equal(calculations,requests,'Column choices must not calculate');
  evidence.registers.push({id,columns:headers,removedDisplaySources:removedSources,initiallyHidden,reportReplacesThicknessSource:['steel_vermiculite','steel_intumescent'].includes(id),allColumnsIndividuallyToggle:true,selectAllAndNone:true,inputsUnchanged:true,noCalculationRequests:true});
  console.log(`PASS column choices: ${id} (${headers.length})`);
 }
  // Column changes retain unsaved text/selection and all removed optional values.
 await chooseCalculator(page,'Steel (board)');await idle();const before=await snapshot(),draftField=page.locator('[data-calculator-cell="A9"]'),handle=await draftField.elementHandle();
 await draftField.fill('Uncommitted exact text · 1.123456789012345');await draftField.evaluate(node=>node.setSelectionRange(3,12));
  const panel=await chooser();await panel.locator('[data-schedule-column-choice="column:V"]').uncheck();await panel.press('Escape');
 assert.equal(await draftField.evaluate((node,original)=>node===original,handle),true);await expect(draftField).toHaveValue('Uncommitted exact text · 1.123456789012345');await idle();
 const edited=await snapshot();assert.equal(edited.steel_board.inputs.CALCULATOR.A9,'Uncommitted exact text · 1.123456789012345');
  const preferenceKey='ceasefire.scheduleColumns.v1.steel_board:CALCULATOR';assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),preferenceKey),{version:1,hidden:['column:V']});
 // Cached navigation, real recalculation, locale changes and reload preserve choices.
  await page.locator('#calculator-pages').getByRole('button',{name:'BOARD SUMMARY',exact:true}).click();await idle();await page.locator('#calculator-pages').getByRole('button',{name:'SCHEDULE',exact:true}).click();await idle();await expect(nativeCell('column:V')).toBeHidden();await assertBoardColumnsRemoved();
  const recalculated=page.waitForRequest(request=>request.method()==='POST'&&request.url()===`${base}/api/calculators/steel_board/worksheet`);
  await page.locator('#calculator-recalculate').click();const calculationInputs=(await recalculated).postDataJSON().inputs.CALCULATOR;
  for(const [address,value]of Object.entries(retainedBoardInputs))assert.equal(calculationInputs[address],value);
  await idle();await expect(nativeCell('column:V')).toBeHidden();await assertBoardColumnsRemoved();assert.deepEqual(await snapshot(),edited);
 // Rebuilt virtual rows use the same hidden IDs and exact visible colspan.
 await page.evaluate(async()=>{const api=window.CeasefireCalculators,copy=await api.completeProjectSnapshot();copy.steel_board.schedule_rows=Array.from({length:101},(_,index)=>index+9);api.applyProject(await api.prepareProject(copy));});
 await chooseCalculator(page,'Steel (board)');await idle();const virtualBefore=await snapshot();await expect(page.locator('.calculator-virtual-schedule')).toBeVisible();
 const virtualPanel=await chooser();await virtualPanel.locator('[data-schedule-column-choice="virtual:report"]').uncheck();await virtualPanel.press('Escape');
 const scrolled=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${base}/api/calculators/steel_board/worksheet`&&response.request().postDataJSON()?.schedule_view?.offset>0);
 await page.locator('[data-schedule-viewport]').evaluate(node=>node.scrollTop=6500);const virtualResponse=await scrolled;assert.equal(virtualResponse.status(),200);await virtualResponse.finished();await idle();
  const virtualShape=await page.locator('.calculator-virtual-schedule').evaluate(table=>({columns:table.querySelectorAll('thead th:not([hidden])').length,spacers:[...table.querySelectorAll('[data-schedule-spacer]')].map(cell=>cell.colSpan),hidden:[...table.querySelectorAll('[data-schedule-column="column:V"],[data-schedule-column="virtual:report"]')].every(cell=>cell.hidden)}));
  await assertBoardColumnsRemoved();
 assert.ok(virtualShape.hidden);assert.ok(virtualShape.spacers.every(span=>span===virtualShape.columns));assert.deepEqual(await snapshot(),virtualBefore);evidence.virtualRows={...virtualShape,exactDraftUnchanged:true};
 const virtualTop=await page.locator('[data-schedule-viewport]').evaluate(node=>node.scrollTop),virtualRequests=calculations,allVirtual=await chooser();
 await selectAll(allVirtual,false);await expect(page.locator('.calculator-virtual-schedule')).toBeHidden();await expect(allVirtual).toBeVisible();
 await page.waitForTimeout(250);assert.equal(calculations,virtualRequests,'Visibility-induced scroll clamping must not request another window');
 await selectAll(allVirtual,true);await expect(page.locator('.calculator-virtual-schedule')).toBeVisible();await expect(page.locator('[data-schedule-viewport]')).toHaveJSProperty('scrollTop',virtualTop);
  await assertBoardColumnsRemoved(allVirtual);await allVirtual.locator('[data-schedule-column-choice="column:V"]').uncheck();await allVirtual.press('Escape');assert.equal(calculations,virtualRequests);assert.deepEqual(await snapshot(),virtualBefore);
 evidence.virtualRows.allHiddenNoCalculation=true;evidence.virtualRows.restoredScrollTop=virtualTop;
 console.log('PASS virtual columns: no calculation on all-hidden, exact draft and scroll restored');
 await page.evaluate(async copy=>{const api=window.CeasefireCalculators;api.applyProject(await api.prepareProject(copy));},edited);await chooseCalculator(page,'Steel (board)');await idle();
 const reportRestore=await chooser();await reportRestore.locator('[data-schedule-column-choice="virtual:report"]').check();await reportRestore.press('Escape');
 for(const language of ['en','zh-Hans','hi','es','ar','th','ko','tl','vi'])for(const width of [1146,390]){
  await page.setViewportSize({width,height:850});await page.evaluate(language=>window.CeasefireI18n.setLanguage(language,false),language);
  const panel=await chooser(),labels=await page.evaluate(()=>['Columns','Visible columns','Select all'].map(label=>window.CeasefireI18n.translate(label)));
  await expect(page.locator('#calculator-pages .schedule-column-toggle')).toHaveText(labels[0]);assert.equal(await panel.getAttribute('aria-label'),labels[1]);await expect(panel.locator('.schedule-column-all span')).toHaveText(labels[2]);
   const rect=await panel.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0);assert.ok(rect.height<=850);await expect(panel.locator('[data-schedule-column-choice="column:V"]')).not.toBeChecked();await assertBoardColumnsRemoved(panel);
  assert.deepEqual(await snapshot(),edited);evidence.locales.push({language,width,labels,rect});if(['en','ar'].includes(language))await screenshot(`columns-${language}-${width}.png`);await panel.press('Escape');
 }
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await page.setViewportSize({width:1146,height:850});
 console.log('PASS column chooser: all9 languages at desktop and narrow widths');
 for(const title of ['Steel (spray)','Steel (intumescent)','Steel (board)','Duct']){
  await chooseCalculator(page,title);await idle();const cell=page.locator('.calculator-report-column[data-calculator-reports]').first(),basis=page.locator('.calculator-basis-preview').first();await expect(basis).toBeVisible();assert.doesNotMatch(await basis.textContent(),/\[object Object\]/);
  for(let theme=0;theme<5;theme++){
   const name=await page.locator('html').getAttribute('data-theme');await page.mouse.move(1,1);await cell.evaluate(node=>node.blur());
   const normalReport=await cell.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
   const neighbor=cell.locator('xpath=preceding-sibling::td[1]');await neighbor.hover();
   const rowHoveredReport=await cell.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color,rowHovered:node.closest('tr').matches(':hover'),directHovered:node.matches(':hover')}));
   assert.ok(rowHoveredReport.rowHovered&&!rowHoveredReport.directHovered);assert.deepEqual({background:rowHoveredReport.background,color:rowHoveredReport.color},normalReport);
   assert.notEqual(normalReport.background,'rgba(0, 0, 0, 0)','Report must have an opaque body surface');
   await cell.hover();const report=await cell.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
   if(theme===0)await cell.screenshot({path:path.join(output,`${title.replace(/\W/g,'-')}-report-red.png`)});
   await basis.hover();const hover=await basis.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));if(theme===0)await basis.screenshot({path:path.join(output,`${title.replace(/\W/g,'-')}-basis-red.png`)});
   await page.mouse.move(1,1);await page.keyboard.press('Tab');await basis.focus();assert.equal(await basis.evaluate(node=>node.matches(':focus-visible')),true);const focus=await basis.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
   for(const style of [report,hover,focus])assert.deepEqual(style,{background:'rgb(163, 18, 34)',color:'rgb(255, 255, 255)'});
   evidence.themes.push({title,name,normalReport,rowHoveredReport,report,hover,focus});await cycleTheme(page);
  }
 }
  await chooseCalculator(page,'Steel (board)');await idle();const reloadReview=async dialog=>{assert.equal(dialog.type(),'beforeunload');await dialog.accept();};page.once('dialog',reloadReview);await page.reload();page.off('dialog',reloadReview);await boot();await chooseCalculator(page,'Steel (board)');await idle();await expect(nativeCell('column:V')).toBeHidden();
  const restoredPanel=await chooser();await selectAll(restoredPanel,true);await assertBoardColumnsRemoved(restoredPanel);await restoredPanel.press('Escape');await expect(nativeCell('column:V')).toBeVisible();
 // Firestopping has two projections of the same schedule and preference.
 await chooseCalculator(page,'Firestopping');await fireIdle();
 const setupEstimate=page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${base}/api/calculate`&&response.request().postDataJSON()?.penetration?.draft?.rows?.some(row=>row.id==='column-choices-fire'));
 await page.evaluate(async()=>{const api=window.CeasefirePenetrations,snapshot=api.projectSnapshot(),row=structuredClone(snapshot.composer.rows[0]);row.id='column-choices-fire';row.inputs.O=2.3456789012345;row.inputs.T='Column fixture';snapshot.draft.rows=[row];api.applyProject(await api.prepareProject(snapshot));await window.CeasefirePenetrationNavigation.showSchedule();});await fireIdle();
 const setupResponse=await setupEstimate;assert.equal(setupResponse.status(),200);await setupResponse.finished();evidence.firestopping_setup={mainEstimateCompleted:true,requestPath:new URL(setupResponse.url()).pathname};
 const fireBefore=await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot()),fireRequests=calculations;
 const toggle=page.locator('#penetration-schedule-workspace .schedule-column-toggle');await toggle.click();const firePanel=page.locator('#'+await toggle.getAttribute('aria-controls'));
 assert.equal(await firePanel.locator('[data-schedule-column-choice]').count(),11);
 await firePanel.locator('[data-schedule-column-choice="diagram"]').uncheck();await firePanel.locator('[data-schedule-column-choice="actions"]').uncheck();await firePanel.locator('[data-schedule-column-choice="delete"]').uncheck();
 for(const id of ['penetration-schedule-body','penetration-estimator-schedule-body'])assert.deepEqual(await page.locator('#'+id).evaluate(body=>[...body.children[0].children].filter(cell=>cell.hidden).map(cell=>cell.dataset.scheduleColumn)),['diagram','actions','delete']);
 await selectAll(firePanel,false);await expect(page.locator('#penetration-schedule-body').locator('xpath=ancestor::table')).toBeHidden();await expect(firePanel).toBeVisible();await selectAll(firePanel,true);await firePanel.press('Escape');assert.deepEqual(await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot()),fireBefore);assert.equal(calculations,fireRequests);
 await chooseCalculator(page,'Firestopping');await fireIdle();
 const secondRequests=calculations,secondToggle=page.locator('.penetration-estimator-schedule .schedule-column-toggle');await secondToggle.click();const secondPanel=page.locator('#'+await secondToggle.getAttribute('aria-controls'));
 assert.equal(await secondPanel.locator('[data-schedule-column-choice]').count(),11);for(const box of await secondPanel.locator('[data-schedule-column-choice]').all())await expect(box).toBeChecked();
 await secondPanel.locator('[data-schedule-column-choice="total"]').uncheck();for(const id of ['penetration-schedule-body','penetration-estimator-schedule-body'])await expect(page.locator('#'+id+' [data-schedule-column="total"]')).toBeHidden();
 await selectAll(secondPanel,false);await expect(page.locator('#penetration-estimator-schedule-body').locator('xpath=ancestor::table')).toBeHidden();await expect(secondPanel).toBeVisible();await selectAll(secondPanel,true);await secondPanel.press('Escape');assert.deepEqual(await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot()),fireBefore);assert.equal(calculations,secondRequests);
 evidence.firestopping={bothViewsSharePreference:true,bothViewsExercised:true,all11Choices:true,precisionAndDraftUnchanged:true,noCalculationRequests:true};
 await Promise.all(cssResponses);for(const source of ['static/calculators.css','static/penetration.css']){const served=evidence.served_css.filter(row=>row.source===source);assert.ok(served.length>0);assert.ok(served.every(row=>row.sha256===evidence.source_sha256[source]));}
 evidence.source_sha256_after=sourceHashes();assert.deepEqual(evidence.source_sha256_after,evidence.source_sha256);assert.deepEqual(evidence.errors,[]);evidence.passed=true;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));console.log(`PASS schedule columns: ${output}`);
})().catch(async error=>{evidence.passed=false;evidence.failure=String(error.stack||error);evidence.source_sha256_after=sourceHashes();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));console.error(error);console.error(logs.slice(-5000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
