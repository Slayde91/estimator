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
 assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),before);assert.deepEqual(errors,[]);
 // Enter a new board schedule using public controls, including blank custom design selectors.
 await tab('SCHEDULE');
 for(const [cell,value] of [['C9','PROMATECT-XS'],['D9','200UC46'],['G9','4'],['H9','120'],['I9','Column'],['J9','550']]) {
   const control=page.locator(`select[data-calculator-cell="${cell}"]`);
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
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,unchangedInputs:true,errors},null,2));console.log(`PASS calculator cleanup: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-3000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
