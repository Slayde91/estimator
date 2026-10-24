// Owned disposable server: member quantity, required-review and compact explanations.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'classifire-schedule-members-'));
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'monokote_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,base;server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error(logs)),120000);server.stdout.on('data',data=>{value+=data;if(value.includes('\n')){clearTimeout(timer);resolve(JSON.parse(value.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
async function idle(){await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',{timeout:60000});}
async function tab(name){await page.locator('#calculator-pages').getByRole('button',{name,exact:true}).click();await idle();}
async function edit(address,value,id){
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===`${base}/api/calculators/${id}/worksheet`);
 const field=page.locator(`[data-calculator-cell="${address}"]`);await field.focus();
 if(await field.getAttribute('role')==='combobox') {await field.fill(String(value));await field.press('ArrowDown');await field.press('Enter');}
 else if(await field.evaluate(node=>node.tagName)==='SELECT') {
  const choices=await field.locator('option').evaluateAll(options=>options.map(option=>option.value));
  if(choices.includes(String(value)))await field.selectOption(String(value));
  else {await field.selectOption({label:'Enter custom value…'});const custom=page.locator(`[data-calculator-custom-cell="${address}"]`);await custom.fill(String(value));await custom.press('Tab');}
 } else {await field.fill(String(value));await field.press('Tab');}
 assert.equal((await response).status(),200);await idle();
}
async function snapshot(){return page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);base=`http://127.0.0.1:${info.port}`;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:764}});page.setDefaultTimeout(60000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const boardLegacy={CALCULATOR:{A9:'LEGACY',C9:'TRAFALGAR COREX',D9:'200UC46',F9:10,G9:4,H9:120,I9:'Column',J9:550}};
 const ductLegacy={CALCULATOR:{B11:'300 x 200',C11:'CAFCO 300',D11:10,E11:'120/120/120',F11:1,G11:0,H11:'Internal',I11:'Horizontal'}};
 for(const [id,inputs,row]of [['steel_board',boardLegacy,9],['ductwork',ductLegacy,11]]){
  const seeded=await page.request.put(`${base}/api/calculators/${id}/state`,{data:{inputs,schedule_rows:[row]}});assert.equal(seeded.status(),200);
 }
 await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
 await chooseCalculator(page,'Steel (board)');await idle();await tab('SCHEDULE');
 await expect(page.locator('[data-calculator-cell="CJ9"]')).toHaveValue('1.00');
 const legacyBefore=await snapshot();assert.equal(Object.hasOwn(legacyBefore.steel_board.inputs.CALCULATOR,'CJ9'),false);
 const headings=await page.locator('.calculator-schedule-table thead th').allTextContents();
 assert.equal(headings[headings.indexOf('Lineal metres')+1],'Quantity');
 assert.match(headings[headings.indexOf('Family (ESA input)')+1],/^ESA\/M input/);
 const originalStatus=page.locator('[data-calculator-output="AI9"] .calculator-basis-preview');await expect(originalStatus).toBeVisible();
 const raw=await page.request.post(`${base}/api/calculators/steel_board/worksheet`,{data:{sheet:'CALCULATOR',inputs:boardLegacy,schedule_view:{rows:[9],offset:0,limit:1}}});assert.equal(raw.status(),200);
 const source=(await raw.json()).rows.find(row=>row.row===9).cells.find(cell=>cell.address==='AI9').value;
 const sections=page.locator('[data-calculator-cell="D9"]');await sections.focus();await sections.fill('[P100]');
 await expect(page.locator('.searchable-choice-list [role="option"]')).toHaveCount(0);
 await sections.fill('CHS');await expect(page.getByRole('option').filter({hasText:'CHS'}).first()).toBeVisible();
 const chsAlias=await page.getByRole('option').filter({hasText:'CHS'}).first().textContent();assert.ok(!chsAlias.includes('[P100]'));
 await sections.press('Escape');await sections.fill('200UC46');await sections.press('Escape');
 await originalStatus.click();await expect(page.locator('#calculator-basis-full')).toContainText(source);await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
 assert.deepEqual(await snapshot(),legacyBefore);
 const addResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===`${base}/api/calculators/steel_board/worksheet`);
 await page.getByRole('button',{name:'Add row',exact:true}).click();await addResponse;await idle();
 await edit('C10','TRAFALGAR COREX','steel_board');
 await expect(page.locator('[data-calculator-cell="CJ10"]')).toHaveValue('');await expect(page.locator('[data-calculator-cell="CJ10"]')).toHaveClass(/calculator-required-missing/);
 assert.equal((await snapshot()).steel_board.inputs.CALCULATOR.CJ10,null);
 await expect(page.locator('[data-calculator-output="AI10"] .calculator-basis-preview')).toContainText('Review required');
 await page.screenshot({path:path.join(output,'board-new-required-quantity.png'),fullPage:true});
 for(const [cell,value]of [['D10','200UC46'],['F10',7.25],['G10',4],['H10',120],['I10','Column'],['J10',550],['CJ10',3]])await edit(cell,value,'steel_board');
 await edit('D10',chsAlias,'steel_board');await expect(page.locator('[data-calculator-cell="D10"]')).toHaveValue(chsAlias);
 await edit('D10','200UC46','steel_board');
 await expect(page.locator('[data-calculator-cell="F10"]')).toHaveValue('7.25');await expect(page.locator('[data-calculator-cell="CJ10"]')).toHaveValue('3.00');
 await expect(page.locator('[data-calculator-cell="CJ10"]')).not.toHaveClass(/calculator-required-missing/);
 await page.screenshot({path:path.join(output,'board-complete-quantity-layout.png'),fullPage:true});
 await chooseCalculator(page,'Ductwork (spray/wrap)');await idle();await tab('SCHEDULE');
 const ductHeadings=await page.locator('.calculator-schedule-table thead th').allTextContents();assert.equal(ductHeadings[ductHeadings.indexOf('Length (m)')+1],'Quantity');
 const beforeDuct=await snapshot();assert.equal(Object.hasOwn(beforeDuct.ductwork.inputs.CALCULATOR,'CM11'),false);
 const guide=page.locator('[data-calculator-output="AM11"] .calculator-basis-preview');await expect(guide).toBeVisible();
 const guideRow=await guide.locator('xpath=ancestor::tr').boundingBox();assert.ok(guideRow.height<140,`Compact guide row grew to ${guideRow.height}`);
 await guide.click();await expect(page.locator('#calculator-basis-full')).toContainText('Use the pin and mesh details');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();assert.deepEqual(await snapshot(),beforeDuct);
 await tab('PRODUCT SETTINGS');await page.locator('[data-calculator-settings-section="A6"]').click();
 const cafco=page.locator('#calculator-settings-ductwork-PRODUCT-SETTINGS-A6');
 const rows=await cafco.locator('tr[data-source-row]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.sourceRow)));
 assert.deepEqual(rows.filter(row=>row!==6&&row!==7),[35,44,45,46,161,162,25]);
 await expect(cafco.locator('[data-calculator-output="A26"]')).toHaveCount(0);await expect(cafco.locator('[data-calculator-cell="B44"]')).toBeVisible();
 await page.screenshot({path:path.join(output,'cafco-seven-settings.png'),fullPage:true});
 await chooseCalculator(page,'Steel (intumescent)');await idle();await tab('SCHEDULE');
 await edit('B10','Nullifire SC902','steel_intumescent');await edit('L10',3.5,'steel_intumescent');
 for(const cell of ['I10','J10']){await expect(page.locator(`[data-calculator-cell="${cell}"]`)).toHaveAttribute('aria-required','false');await expect(page.locator(`[data-calculator-cell="${cell}"]`)).not.toHaveClass(/calculator-required-missing/);}
 for(const cell of ['B10','C10','D10','E10','H10'])await expect(page.locator(`[data-calculator-cell="${cell}"]`)).toHaveAttribute('aria-required','true');
 await chooseCalculator(page,'Steel (spray)');await idle();await tab('SCHEDULE');
 for(const cell of ['B10','C10','D10','E10','H10','I10','J10'])await expect(page.locator(`[data-calculator-cell="${cell}"]`)).toHaveAttribute('aria-required','true');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({result:'PASS',legacyMapsUnchanged:true,newProductKeepsQuantityBlank:true,dialogFullSourceRetained:true,boardEsaBesideFamily:true,quantityBesideLength:true,cafcoRows:rows,areaOverrideException:true,errors},null,2));
 console.log(`PASS schedule member followups: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
