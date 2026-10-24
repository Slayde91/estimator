// Presentation-only cleanup against a disposable synthetic workbook fixture.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'), output=path.join(root,'.runtime/browser-qa',`calculator-cleanup-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'monokote_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error(logs)),120000);server.stdout.on('data',data=>{value+=data;if(value.includes('\n')){clearTimeout(timer);resolve(JSON.parse(value.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
async function idle(){await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');}
async function tab(name){await page.locator('#calculator-pages').getByRole('button',{name,exact:true}).click();await idle();}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:764}});page.setDefaultTimeout(60000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${info.port}/`);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
 await chooseCalculator(page,'Steel (spray)');await idle();const before=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
 // The marked START content is a virtual SETTINGS projection. Browser removals
 // leave original worksheet directions, retained neighbors and drafts intact.
 await expect(page.locator('#calculator-sheet-title')).toHaveText('START');
 const startResponse=await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/steel_vermiculite/worksheet`,{data:{sheet:'SETTINGS'}});assert.equal(startResponse.status(),200);
 const startRaw=await startResponse.json(),startCells=new Map(startRaw.rows.flatMap(row=>row.cells.map(cell=>[cell.address,cell]))),startChecks=[];
 for(const [address,prefix] of [['A292','SCHEDULE AND SORTING'],['A293','Sort or filter the entire SCHEDULE table'],['A308','PROJECT RELEASE'],['A309','Have the designer confirm'],['A312','SOURCE CONTROL AND QUALITY'],['A313','The workbook records the supplied report editions']]){
   assert.ok(startCells.get(address).value.startsWith(prefix),`${address}: original START source retained`);
   await expect(page.locator(`#calculator-grid [data-calculator-output="${address}"]`)).toHaveCount(0);
   startChecks.push({address,sourceRetained:true,browserSectionRemoved:true});
 }
 for(const [address,sourceFragment,removedFragment,retainedFragment] of [
   ['A7','SCHEDULE = take-off','SCHEDULE = take-off','SUMMARY = ordering'],
   ['A273','Use CALCULATOR for one member or SCHEDULE for up to 1,000 lines.','Use SCHEDULE for one member or SCHEDULE for up to 1,000 lines.','Select product, exposure, steel temperature and input method.'],
   ['A301','CAFCO uses an inherited assumption;','The original CAFCO workbook used an inherited assumption; new estimates use user-selected consumption settings.','The startup densities are estimating assumptions; verify product-specific site yield.']]){
   assert.ok(startCells.get(address).value.includes(sourceFragment),`${address}: original fragment retained in API`);
   const output=page.locator(`#calculator-grid [data-calculator-output="${address}"]`);await expect(output).toContainText(retainedFragment);await expect(output).not.toContainText(removedFragment);
   startChecks.push({address,sourceRetained:true,browserFragmentRemoved:true,remainingGuidanceRetained:true});
 }
 await expect(page.locator('#calculator-grid')).toContainText('QUANTITIES');await expect(page.locator('#calculator-grid')).toContainText('BAG YIELDS AND ORDERS');
 await page.screenshot({path:path.join(output,'spray-start-selected-text-removed.png'),fullPage:true});
 await expect(page.locator('#calculator-pages').getByRole('button',{name:'LOOKUP',exact:true})).toHaveCount(0);
 await tab('SCHEDULE');await expect(page.locator('#calculator-product-totals')).toHaveCount(0);
 await tab('SUMMARY');await expect(page.locator('#calculator-product-totals')).toContainText('PRODUCT SUMMARY');
 await expect(page.getByRole('table',{name:'PRODUCT ORDER SUMMARY',exact:true})).toHaveCount(0);
 await tab('SETTINGS');await expect(page.locator('#calculator-grid').getByRole('button',{name:'COMMON CALCULATION RULES',exact:true})).toHaveCount(0);
 await page.locator('#calculator-grid').getByRole('button',{name:'GLOBAL SETTINGS',exact:true}).click();
 const global=page.locator('#calculator-settings-steel_vermiculite-SETTINGS-A9');await expect(global).toContainText('COMMON CALCULATION RULES');await expect(global).toContainText('Lookup method');
 await page.screenshot({path:path.join(output,'global-settings.png'),fullPage:true});
 await chooseCalculator(page,'Steel (board)');await idle();await expect(page.locator('#calculator-pages').getByRole('button',{name:'EXTRA BOARDS',exact:true})).toHaveCount(0);
 await tab('SCHEDULE');await expect(page.locator('#calculator-product-totals')).toHaveCount(0);await expect(page.locator('#calculator-grid')).toContainText('STRUCTURAL STEEL BOARD SCHEDULE');
 await tab('BOARD SUMMARY');await expect(page.locator('#calculator-grid .calculator-overview')).toHaveCount(0);await expect(page.locator('#calculator-grid')).toContainText('Purchase sqm');
 const stock=page.getByRole('table',{name:'Board purchasing totals',exact:true});
 const headers=await stock.getByRole('columnheader').allTextContents();assert.equal(headers[headers.indexOf('Net Steel sqm')+1],'Purchase sqm');
 await expect(stock.locator('[data-board-steel-row]')).toHaveCount(18);
 assert.ok((await stock.locator('[data-board-steel-row]').allTextContents()).every(text=>text==='0.00'));
 await expect(page.locator('#calculator-board-steel-notes')).toContainText('total lineal metres');
 await page.screenshot({path:path.join(output,'board-summary.png'),fullPage:true});
 // The browser keeps product totals and concise operating settings. Complete
 // source/API tables, hidden assumptions and saved calculator inputs survive.
 await chooseCalculator(page,'Ductwork (spray/wrap)');await idle();await tab('SUMMARY');
 const worksheet=async sheet=>{const response=await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/ductwork/worksheet`,{data:{sheet}});assert.equal(response.status(),200);return response.json();};
 const rawSummary=await worksheet('SUMMARY'),summaryCells=new Map(rawSummary.rows.flatMap(row=>row.cells.map(cell=>[cell.address,cell]))),noteChecks=[];
 for(const [address,prefix] of [['A4','Totals include calculated quantities only.'],['A14','Both/Mixed uses the stricter covered case.'],['A35','Single rectangular steel ducts, protected on four sides only.'],['A43','Maxilite is a four-strip frame, not a full sheet.']]){
   assert.ok(summaryCells.get(address).value.startsWith(prefix),`${address}: original source note remains in the worksheet API`);
   await expect(page.locator(`#calculator-grid [data-calculator-output="${address}"]`)).toHaveCount(0);await expect(page.locator('#calculator-grid')).not.toContainText(prefix);
   noteChecks.push({sheet:'SUMMARY',address,sourceNoteRetained:true,browserNoteRemoved:true});
 }
 await expect(page.getByRole('table',{name:'Product totals',exact:true})).toHaveCount(1);
 for(const label of ['Penetration angle totals','Working yields','Maxilite cutting totals'])await expect(page.getByRole('table',{name:label,exact:true})).toHaveCount(0);
 await expect(page.locator('#calculator-grid [data-calculator-output="D9"]')).toHaveCount(1);
 for(const address of ['A17','A29','A38','D19','F40']){
   assert.ok(summaryCells.has(address),`${address}: hidden summary data remains in API`);
   await expect(page.locator(`#calculator-grid [data-calculator-output="${address}"]`)).toHaveCount(0);
 }
 await tab('PRODUCT SETTINGS');const rawSettings=await worksheet('PRODUCT SETTINGS');
 await expect(page.locator('[data-calculator-settings-section]')).toHaveCount(3);
 for(const id of ['J94','J115'])await expect(page.locator(`[data-calculator-settings-section="${id}"]`)).toHaveCount(0);
 for(const [id,prefix,adjacent] of [['A6','Use the assessed construction and fire direction.','[data-calculator-cell="B35"]'],['A48','Check the assessed duct size, steel, supports, wall and floor details.','[data-calculator-cell="B65"]'],['A94','Use matching barrier, gap and fixing details.','[data-calculator-cell="B96"]']]){
   const choice=page.locator(`[data-calculator-settings-section="${id}"]`);await choice.click();const panel=page.locator(`#${await choice.getAttribute('aria-controls')}`);await expect(panel).toBeVisible();
   const source=rawSettings.settings_sections.find(section=>section.id===id);
   assert.ok(source.note.startsWith(prefix),`${id}: the full technical note remains in API metadata`);
   await expect(panel.locator('.calculator-settings-note')).toHaveCount(0);await expect(panel).not.toContainText(prefix);await expect(panel.locator(adjacent)).toBeVisible();
   if(id==='A48'){
     const rows=await panel.locator('tr[data-source-row]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.sourceRow)));
     assert.deepEqual(rows,[48,49,65,73,90,91,92,163,164,68,69]);
     await page.screenshot({path:path.join(output,'duct-monokote-core-settings.png'),fullPage:true});
   }
   if(id==='A94'){
     const form=panel.getByRole('table',{name:'FYREWRAP',exact:true});
     const rows=await form.locator('tr[data-source-row]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.sourceRow)));
     assert.deepEqual(rows,[95,96,97,98,99,100,111,112]);
     await expect(panel.locator('[data-calculator-output="J94"]')).toHaveText('FYREWRAP APPLICATION TABLE');
     await expect(panel.locator('[data-calculator-output="J96"]')).toBeVisible();
     await expect(panel.locator('.calculator-projected-note.calculator-technical-note')).toHaveCount(0);
     for(const address of ['A101','A115','A117','J115','J117'])await expect(panel.locator(`[data-calculator-output="${address}"]`)).toHaveCount(0);
   }
   noteChecks.push({sheet:'PRODUCT SETTINGS',id,sourceNoteRetained:true,browserNoteRemoved:true,adjacentControlOrOutputVisible:true});
 }
 assert.ok(rawSettings.presentation_tables.find(table=>table.title_address==='J94').note.startsWith('FyreWrap application FRLs preserve directional requirements:'));
 assert.ok(rawSettings.settings_sections.find(section=>section.id==='J115').note.startsWith('Counts cover standard four-sided details:'));
 const settingsCells=new Map(rawSettings.rows.flatMap(row=>row.cells.map(cell=>[cell.address,cell])));
 for(const address of ['B50','B101','A115','A117','J115','J117'])assert.ok(settingsCells.has(address),`${address}: hidden settings remain in API`);
 await page.screenshot({path:path.join(output,'duct-fyrewrap-core-and-application.png'),fullPage:true});
 // SC902 uses the same compact pack form and shared product summary. Opening
 // either page leaves raw settings, retained legacy inputs and drafts intact.
 await chooseCalculator(page,'Steel (intumescent)');await idle();await tab('SETTINGS');
 const intumSettingsResponse=await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/steel_intumescent/worksheet`,{data:{sheet:'SETTINGS'}});assert.equal(intumSettingsResponse.status(),200);
 const intumSettings=await intumSettingsResponse.json(),intumSettingsRaw=JSON.stringify(intumSettings),intumCells=new Map(intumSettings.rows.flatMap(row=>row.cells.map(cell=>[cell.address,cell])));
 await page.locator('[data-calculator-settings-section="A4"]').click();
 const sc902=page.locator('#calculator-settings-steel_intumescent-SETTINGS-A4');await expect(sc902).toBeVisible();
 const sc902Form=sc902.getByRole('table',{name:'Nullifire SC902 settings',exact:true});
 const sc902Rows=await sc902Form.locator('tr[data-source-row]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.sourceRow)).filter(row=>row!==4));
 assert.deepEqual(sc902Rows,[9,24,14,16,17,25,10,11,21,22,23]);
 for(const address of ['D9','D24','D14','D16','D17','D25','D10','D11'])await expect(sc902.locator(`[data-calculator-cell="${address}"]`)).toBeVisible();
 for(const [address,label] of [['D21','Total Part A + B mass estimate (kg)'],['D22','Mixed pack volume used (L)'],['D23','Theoretical pack coverage (m² at 1 mm DFT)']]){
   await expect(sc902.locator(`[data-calculator-output="${address}"]`)).toBeVisible();await expect(sc902).toContainText(label);
 }
 for(const address of ['D6','D8','D12','D15']){
   assert.ok(intumCells.has(address),`${address}: SC902 legacy setting remains in API`);
   await expect(sc902.locator(`[data-calculator-cell="${address}"]`)).toHaveCount(0);
 }
 for(const address of ['A26','A27','A28','A29','A30'])await expect(sc902.locator(`[data-calculator-output="${address}"]`)).toHaveCount(0);
 await page.screenshot({path:path.join(output,'sc902-compact-pack-settings.png'),fullPage:true});
 assert.equal(JSON.stringify(intumSettings),intumSettingsRaw);
 await tab('SUMMARY');
 const intumSummary=page.getByRole('table',{name:'Intumescent product summary',exact:true});await expect(intumSummary).toBeVisible();
 await expect(page.locator('#calculator-grid table')).toHaveCount(1);await expect(intumSummary.getByRole('columnheader')).toHaveCount(15);await expect(intumSummary.locator('tbody tr')).toHaveCount(3);
 for(const product of ['Nullifire SC902','FIRETEX FX5090','FIRETEX FX6010'])await expect(intumSummary).toContainText(product);
 await page.screenshot({path:path.join(output,'intumescent-unified-product-summary.png'),fullPage:true});
 assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),before);assert.deepEqual(errors,[]);
 // Enter a new board schedule using public controls, including blank custom design selectors.
 await chooseCalculator(page,'Steel (board)');await idle();
 await tab('SCHEDULE');
 for(const [cell,value] of [['C9','PROMATECT-XS'],['D9','200UC46'],['G9','4'],['H9','120'],['I9','Column'],['J9','550']]) {
   const control=page.locator(`[data-calculator-cell="${cell}"]`);
   if(cell==='D9') {
     await expect(control).toHaveAttribute('role','combobox');
     await control.fill(value); await control.press('ArrowDown'); await control.press('Enter');
     await expect(control).toHaveValue(value); await idle(); continue;
   }
   await control.focus(); // Large retained choice lists populate on first focus.
   const choices=await control.locator('option').evaluateAll(options=>options.map(option=>option.value));
   if(choices.includes(value)) await control.selectOption(value);
   else {
     await control.selectOption({label:'Enter custom value…'});
     const custom=page.locator(`input[data-calculator-custom-cell="${cell}"]`);
     await custom.fill(value);await custom.press('Tab');
   }
   await idle();
 }
 await page.locator('input[data-calculator-cell="F9"]').fill('10');await page.locator('input[data-calculator-cell="F9"]').press('Tab');await idle();
 await tab('BOARD SUMMARY');
 const memberRow=stock.locator('tr').filter({has:page.locator('[data-calculator-output="A27"]')});
 // PROMATECT-XS 15 mm is row 27 in the retained stock catalogue.
 await expect(memberRow.locator('[data-board-steel-row]')).toHaveText('11.84');
 const filled=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
 await tab('SCHEDULE');await tab('BOARD SUMMARY');assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),filled);
 await page.screenshot({path:path.join(output,'net-steel-double-layer.png'),fullPage:true});assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,unchangedInputs:true,requestedSprayInstructions:startChecks,requestedDuctNotes:noteChecks,errors},null,2));console.log(`PASS calculator cleanup: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-3000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
