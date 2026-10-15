// Full browser interactions against a disposable fixture; never port 8765.
const {chromium,expect}=require('@playwright/test');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'), output=path.join(root,'.runtime/browser-qa',`company-firestopping-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHashes=Object.fromEntries(['data/penetration.json.gz','estimator/penetration_calculator.py','estimator/penetration_entry.py'].map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
const assetHashes=Object.fromEntries(['static/app.js','static/penetration.js','static/index.html','static/styles.css'].map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page; server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[], evidence={};
async function idle(){await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;});}
async function penetrationSettled(){await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy','false');await idle();}
const field=column=>page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`);
async function inputs(){await penetrationSettled();return page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot().composer.rows[0].inputs);}
async function select(column,value){await field(column).selectOption(value);await penetrationSettled();}
async function inputGroup(group){await page.locator(`#penetration-input-groups [data-penetration-group="${group}"]`).click();await expect(page.getByRole('dialog')).toHaveCount(0);}
(async()=>{
  const fixture=await ready; assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1028,height:900}});page.setDefaultTimeout(45000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${fixture.port}/`,{waitUntil:'networkidle'});await idle();
  await expect(page.locator('#takeoff-navigation-toggle svg')).toHaveAttribute('data-lucide','scan-line');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.locator('#company-settings-save')).toBeEnabled();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  await page.locator('#company-name').fill('Fixture Company');await page.locator('#company-email').fill('pdf@example.test');await page.locator('#company-phone').fill('12345678');
  await page.locator('#company-logo').setInputFiles(path.join(root,'static/icons/takeoff-set-default.png'));
  await expect(page.locator('#company-settings-save')).toBeEnabled();await page.locator('#company-settings-save').click();
  await expect(page.locator('#company-settings-status')).toHaveText('Saved');
  const saved=await (await page.request.get(`http://127.0.0.1:${fixture.port}/api/company-settings`)).json();
  assert.equal(saved.email,'pdf@example.test');assert.ok(saved.logo.startsWith('data:image/png;base64,'));
  await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','midnight');
  await page.screenshot({path:path.join(output,'settings.png')});
  await page.reload({waitUntil:'networkidle'});await idle();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.locator('#company-email')).toHaveValue('pdf@example.test');
  evidence.companyRoundtrip=true;
  await chooseCalculator(page,'Firestopping');await idle();await expect(field('J')).toBeVisible();
  const paired=await page.locator('#penetration-row-fields').evaluate(el=>{
    const box=column=>{const b=el.querySelector(`[data-penetration-field="${column}"]`).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width};};
    return {orientation:box('M'),substrate:box('P'),type:box('L'),frl:box('N')};
  });
  assert.equal(paired.orientation.y,paired.substrate.y);assert.ok(Math.abs(paired.orientation.width-paired.substrate.width)<2);assert.equal(paired.type.y,paired.frl.y);
  evidence.pairedWidths=[];
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    const pair=await page.locator('#penetration-row-fields').evaluate(el=>['P','M'].map(column=>{
      const b=el.querySelector(`[data-penetration-field="${column}"]`).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width};
    }));
    assert.equal(pair[0].y,pair[1].y,'Paired input edges stay aligned when a label wraps');
    assert.ok(pair[1].x>pair[0].x);assert.ok(Math.abs(pair[0].width-pair[1].width)<2);
    evidence.pairedWidths.push({width,pair});
  }
  await page.setViewportSize({width:1028,height:900});
  // Original source defaults contain AY/BE only. A blank service must not
  // invent pipe or tray multipliers; choose actual source-backed service routes.
  const baseline=await inputs(),configuration=await page.evaluate(()=>window.CeasefireProject.configuration());
  const definitionReply=await page.request.post(`http://127.0.0.1:${fixture.port}/api/penetration/definition`,{data:{configuration}});assert.equal(definitionReply.status(),200);
  const definition=await definitionReply.json(),sourceDefaults=definition.defaults.rows[0].inputs;
  assert.deepEqual(baseline,sourceDefaults);assert.equal(sourceDefaults.AY,2);assert.equal(sourceDefaults.BE,2);
  await select('M',{label:'Vertical'});
  let current=await inputs();assert.equal(current.AN,sourceDefaults.AN);assert.equal(current.AT,sourceDefaults.AT);assert.equal(current.AY,2);assert.equal(current.BE,2);
  const services=definition.row_fields.find(value=>value.column==='K').options,routes=definition.defaults.globals.service_routes;
  const lagged=routes['Lagged Pipes'].find(value=>services.includes(value)&&!routes.Cabletrays.includes(value));
  const pipeOrBundleGroups=['Unlagged Pipes','Lagged Pipes','Plastic Pipes','Cables/Bundles'];
  const tray=routes.Cabletrays.find(value=>services.includes(value)&&!pipeOrBundleGroups.some(group=>routes[group].includes(value)));assert.ok(lagged);assert.ok(tray);
  await select('K',lagged);current=await inputs();assert.equal(current.AN,2);assert.equal(current.AT,undefined);
  await inputGroup('Lagged Pipes');await expect(field('AN')).toHaveValue('2.00');await inputGroup('Penetration');
  await select('M',{label:'Horizontal'});assert.equal((await inputs()).AN,1);
  await select('M',{label:'Vertical'});assert.equal((await inputs()).AN,2);
  await select('K',tray);current=await inputs();assert.equal(current.AT,2);assert.equal(current.AN,undefined);
  await inputGroup('Cabletrays');await expect(field('AT')).toHaveValue('2.00');await field('AT').fill('3.12345678901234');await field('AT').press('Tab');await penetrationSettled();
  await inputGroup('Penetration');await select('M',{label:'Horizontal'});current=await inputs();assert.equal(current.AT,3.12345678901234);assert.equal(current.AN,undefined);
  await select('M',{label:'Vertical'});assert.equal((await inputs()).AT,3.12345678901234);
  evidence.multiplierDefaults={sourceDefaultsRetained:true,blankServiceDoesNotInventUnusedInputs:true,laggedService:lagged,trayService:tray,vertical:2,horizontal:1,manualTrayPrecision:3.12345678901234};
  await page.locator('#penetration-settings').click();
  for(const column of ['J','K','L','M','N','P','V'])await expect(page.locator(`[data-penetration-detail-options="${column}"]`)).toBeVisible();
  const waste=await page.locator('[data-penetration-field^="waste_"]').evaluateAll(nodes=>nodes.map(node=>node.value));assert.equal(waste.length,9);assert.ok(waste.every(value=>Number(value)===30));
  await page.locator('[data-penetration-detail-options="L"]').fill('Core hole; Oversized; Fixture opening');await page.locator('[data-penetration-detail-options="L"]').press('Tab');
  await page.getByRole('tab',{name:'DETAILS',exact:true}).click();await expect(field('L').locator('option')).toHaveText(['Choose…','Core hole','Oversized','Fixture opening']);
  await field('L').selectOption('Fixture opening');await field('T').fill('Retain on Cancel');await field('T').press('Tab');await penetrationSettled();const beforeClear=await inputs();
  await page.locator('#penetration-clear').click();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(field('T')).toHaveValue('Retain on Cancel');
  assert.deepEqual(await inputs(),beforeClear);
  await page.locator('#penetration-clear').click();await page.getByRole('dialog').getByRole('button',{name:'Yes',exact:true}).click();await expect(field('T')).toHaveValue('');
  assert.deepEqual(await inputs(),{});await select('M',{label:'Horizontal'});current=await inputs();assert.equal(current.AN,undefined);assert.equal(current.AT,undefined);
  await select('K',lagged);assert.equal((await inputs()).AN,1);await select('M',{label:'Vertical'});assert.equal((await inputs()).AN,2);
  await select('M',{label:'Horizontal'});assert.equal((await inputs()).AN,1);assert.equal((await inputs()).AT,undefined);
  evidence.multiplierDefaults.clearCancelExact=true;evidence.multiplierDefaults.clearRemovesManualOverride=true;evidence.multiplierDefaults.horizontalNewService=1;
  await page.getByRole('tab',{name:'Products and labour',exact:true}).click();
  const mastic=await page.locator('#penetration-row-fields').evaluate(el=>{const a=el.querySelector('[data-penetration-field="AB"]').getBoundingClientRect(),b=el.querySelector('[data-penetration-field="AC"]').getBoundingClientRect();return {same:a.y===b.y,right:b.x>a.x};});assert.ok(mastic.same&&mastic.right);
  await field('AC').fill('2');await field('AC').press('Tab');
  await expect(page.locator('#penetration-add-to-schedule')).toBeDisabled();
  await page.screenshot({path:path.join(output,'firestopping.png')});evidence.firestopping={paired,mastic,waste};
  await chooseCalculator(page,'Steel (spray)');await idle();await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#calculator-save-status')).toHaveClass(/calculator-status/);await expect(page.locator('#calculator-save-status')).not.toContainText('use Save');
  await page.getByRole('button',{name:'Libraries',exact:true}).hover();await page.getByRole('group',{name:'Choose a library',exact:true}).getByRole('button',{name:'Pricing Library',exact:true}).click();await idle();
  await page.locator('#add-pricing-item').click();
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#pricing-body [data-price-id]')?.dataset.priceId?.startsWith('inv-user-')),true);
  assert.equal(await page.evaluate(()=>document.activeElement.value),'New pricing item');
  evidence.pricingFocus=true;
  const pdf=await page.request.post(`http://127.0.0.1:${fixture.port}/api/calculators/steel_vermiculite/report.pdf`,{data:{inputs:{}}});assert.equal(pdf.status(),200);fs.writeFileSync(path.join(output,'company-schedule.pdf'),await pdf.body());
  for(const [name,expected] of Object.entries(sourceHashes))assert.equal(hash(fs.readFileSync(path.join(root,name))),expected);
  for(const [name,expected] of Object.entries(assetHashes))assert.equal(hash(fs.readFileSync(path.join(root,name))),expected);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors,port:fixture.port,sourceHashes,assetHashes},null,2));console.log(`PASS company and Firestopping browser: ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
