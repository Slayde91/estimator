// Real DOM checks against an owned disposable server, never the live app.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'classifire-calculator-presentation-'));
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'monokote_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;const evidence={layouts:[],locales:[]},errors=[];
function sourceHashes(){
 const files=['tests/browser/calculator_presentation_followups.cjs','tests/browser/calculator_actions.cjs','tests/browser/monokote_fixture.py','tests/browser/standard_fixture.py','tests/test_monokote_hollow.py',...['package.json','package-lock.json','requirements.txt','requirements-dev.txt'].filter(name=>fs.existsSync(path.join(root,name)))];
 function walk(directory,include){for(const item of fs.readdirSync(path.join(root,directory),{withFileTypes:true})){const name=`${directory}/${item.name}`;if(item.isDirectory())walk(name,include);else if(item.isFile()&&include(name))files.push(name);}}
 walk('static',()=>true);walk('estimator',name=>name.endsWith('.py'));walk('data',()=>true);
 return Object.fromEntries(files.sort().map(name=>{const hash=createHash('sha256'),buffer=Buffer.alloc(65536),file=fs.openSync(path.join(root,name),'r');try{let read;while((read=fs.readSync(file,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,read));}finally{fs.closeSync(file);}return[name,hash.digest('hex')];}));
}
evidence.source_sha256=sourceHashes();
evidence.source_scope='All regular static assets, estimator Python, data files, five direct fixture/helper dependencies and dependency manifests';
evidence.toolchain={node:process.version,playwright:require('@playwright/test/package.json').version,python:process.env.CEASEFIRE_PYTHON||'python'};
server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error(logs)),120000);server.stdout.on('data',data=>{value+=data;if(value.includes('\n')){clearTimeout(timer);resolve(JSON.parse(value.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});});
async function idle(){await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',{timeout:60000});await page.waitForFunction(()=>!window.CeasefireActivity?.active);}
async function draft(){return page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());}
async function tab(label){await page.locator('#calculator-pages').getByRole('button',{name:label,exact:true}).click();await idle();}
async function screenshot(name){
 // Focused horizontal regions may scroll the page. Compose full-page evidence
 // from its real top so a sticky header is not painted over a middle section.
 await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo({top:0,left:0,behavior:'instant'});});
 await page.waitForFunction(()=>window.scrollY===0);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.screenshot({path:path.join(output,name),fullPage:true});
}
async function geometry(title,width){
 await page.setViewportSize({width,height:850});
 const result=await page.locator('#calculator-grid .calculator-schedule-table').evaluate(table=>{
  const scroll=table.closest('.calculator-table-scroll'),rect=table.getBoundingClientRect(),headers=[...table.querySelectorAll('thead th')],row=table.querySelector('tbody tr[data-source-row]');
  return {width:rect.width,declaredWidth:parseFloat(table.style.width),headers:headers.map(cell=>cell.textContent),widths:[...table.querySelectorAll('col')].map(col=>parseFloat(col.style.width)),columns:headers.length,cells:row?.children.length,
   scroll:{width:scroll.clientWidth,content:scroll.scrollWidth,tabIndex:scroll.tabIndex},controls:[...table.querySelectorAll('input,select,textarea')].filter(control=>control.getClientRects().length).map(control=>({cell:control.dataset.calculatorCell,width:control.getBoundingClientRect().width,height:control.getBoundingClientRect().height,cellWidth:control.closest('td').getBoundingClientRect().width})),
   headerWrap:headers.every(header=>getComputedStyle(header).whiteSpace==='normal')};
 });
 assert.equal(result.columns,result.cells);assert.equal(result.columns,result.widths.length);assert.ok(result.headerWrap);
 assert.ok(result.widths.every(value=>value<=224));assert.ok(result.widths.includes(144),'Virtual Report has a compact dedicated width');
 assert.ok(result.controls.length);for(const control of result.controls){assert.ok(control.width>=60,JSON.stringify(control));assert.ok(control.width<=control.cellWidth,JSON.stringify(control));assert.ok(control.height>=32,JSON.stringify(control));}
 assert.equal(result.scroll.tabIndex,0);if(width===390){assert.ok(result.scroll.content>result.scroll.width);const scroll=page.locator('#calculator-grid .calculator-table-scroll').filter({has:page.locator('.calculator-schedule-table')});await scroll.evaluate(el=>el.scrollLeft=0);await scroll.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>scroll.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);}
 evidence.layouts.push({title,viewport:width,...result});
 await screenshot(`${title.replace(/\W/g,'-')}-${width}.png`);
}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);evidence.fixturePort=info.port;
 browser=await chromium.launch({headless:true,...(process.env.CEASEFIRE_BROWSER_CHANNEL?{channel:process.env.CEASEFIRE_BROWSER_CHANNEL}:{})});evidence.toolchain.browser=browser.version();page=await browser.newPage({viewport:{width:1146,height:850}});page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${info.port}/`);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);await page.waitForFunction(()=>!window.CeasefireActivity?.active);
 await chooseCalculator(page,'Steel (spray)');await idle();await expect(page.locator('#calculator-sheet-title')).toHaveText('SCHEDULE');
 await expect(page.locator('#calculator-pages').getByRole('button',{name:'START',exact:true})).toHaveCount(0);await expect(page.locator('#calculator-pages').getByRole('button',{name:'Factor Calcs',exact:true})).toHaveCount(0);
 await tab('SETTINGS');await page.locator('[data-calculator-settings-section="A9"]').click();
 const hidden=await page.locator('#calculator-grid [data-calculator-cell],#calculator-grid [data-calculator-output]').evaluateAll(nodes=>nodes.map(node=>node.dataset.calculatorCell||node.dataset.calculatorOutput).filter(address=>/^[A-N](10|11|12|15|27)$/.test(address)));assert.deepEqual(hidden,[]);
 const guidance=page.locator('[data-calculator-output="D19"]');await expect(guidance).toBeVisible();const guidanceLayout=await guidance.evaluate(cell=>({table:cell.closest('table').className,align:getComputedStyle(cell).textAlign,last:getComputedStyle(cell).textAlignLast}));assert.ok(!guidanceLayout.table.includes('calculator-projection-table')&&!guidanceLayout.table.includes('calculator-responsive-form'));assert.equal(guidanceLayout.align,'left');assert.equal(guidanceLayout.last,'left');evidence.globalGuidance={cell:'D19',...guidanceLayout};
 await expect(page.locator('[data-calculator-cell="D13"]')).toBeVisible();const initial=await draft();
 await chooseCalculator(page,'Factor Calcs');await idle();await expect(page.locator('#calculator-title')).toHaveText('Factor Calcs');await expect(page.locator('#calculator-pages')).toBeHidden();
 await expect(page.locator('.calculator-settings-choice')).toHaveCount(2);await expect(page.locator('[data-calculator-settings-section="A370"]')).toHaveCount(0);await page.locator('[data-calculator-settings-section="A341"]').click();
 const factor=page.locator('[data-calculator-cell="D346"]');await expect(factor).toBeVisible();await factor.fill('4.56789123456789');await factor.press('Tab');await idle();const edited=await draft();
 assert.equal(edited.steel_vermiculite.inputs.SETTINGS.D346,4.56789123456789);const expected=structuredClone(initial);expected.steel_vermiculite.inputs.SETTINGS.D346=4.56789123456789;assert.deepEqual(edited,expected);
 await chooseCalculator(page,'Steel (spray)');await idle();await expect(page.locator('#calculator-sheet-title')).toHaveText('SETTINGS');await expect(page.locator('[data-calculator-settings-section="A9"]')).toHaveAttribute('aria-expanded','true');assert.deepEqual(await draft(),edited);
 await chooseCalculator(page,'Factor Calcs');await idle();await expect(page.locator('[data-calculator-settings-section="A341"]')).toHaveAttribute('aria-expanded','true');await expect(factor).toHaveValue('4.57');
 // Invalid in-progress helper input blocks this same calculator's route change.
 await factor.fill('invalid');await chooseCalculator(page,'Steel (spray)');await expect(page.locator('#calculator-title')).toHaveText('Factor Calcs');await factor.fill('4.56789123456789');await factor.press('Tab');await idle();
 await page.locator('[data-calculator-settings-section="A356"]').click();
 for(const language of ['en','zh-Hans','hi','es','ar','th','ko','tl','vi']){
  await page.evaluate(language=>window.CeasefireI18n.setLanguage(language,false),language);
  const labels=await page.evaluate(()=>({factor:window.CeasefireI18n.translate('Factor Calcs'),hollow:window.CeasefireI18n.translate('HOLLOW SECTIONS')}));
  if(language!=='en'){assert.notEqual(labels.factor,'Factor Calcs');assert.notEqual(labels.hollow,'HOLLOW SECTIONS');}
  await expect(page.locator('#calculator-title')).toHaveText(labels.factor);await expect(page.locator('[data-calculator-settings-section="A356"]')).toHaveText(labels.hollow);await expect(page.locator('[data-calculator-output="A356"]')).toHaveText(labels.hollow);
  await page.locator('#calculator-recalculate').click();await idle();await expect(page.locator('[data-calculator-output="A356"]')).toHaveText(labels.hollow);assert.deepEqual(await draft(),edited);evidence.locales.push({language,...labels});if(['en','ar'].includes(language))await screenshot(`Factor-Calcs-${language}.png`);
 }
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));evidence.factorDraftAndPagePreserved=true;
 for(const title of ['Steel (spray)','Steel (intumescent)','Steel (board)','Duct']){
  await chooseCalculator(page,title);await idle();if(title==='Steel (board)')await expect(page.locator('#calculator-pages').getByRole('button',{name:'START',exact:true})).toHaveCount(0);if(title==='Steel (intumescent)'){const response=await page.request.get(`http://127.0.0.1:${info.port}/api/calculators/steel_intumescent`);assert.equal(response.status(),200);const definition=await response.json(),hasStart=(definition.display_pages||definition.pages.map(id=>({id}))).some(item=>item.id==='START');await expect(page.locator('#calculator-pages').getByRole('button',{name:'START',exact:true})).toHaveCount(Number(hasStart));}
  await tab('SCHEDULE');for(const width of [1146,390])await geometry(title,width);assert.deepEqual(await draft(),edited);
 }
 await chooseCalculator(page,'Firestopping');await page.waitForFunction(()=>!window.CeasefireActivity?.active);
 const fireDraft=await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot());
 await page.evaluate(async()=>{const api=window.CeasefirePenetrations,snapshot=api.projectSnapshot(),row=structuredClone(snapshot.composer.rows[0]);row.id='presentation-layout-row';row.inputs.O=2.3456789012345;row.inputs.T='Presentation fixture only';snapshot.draft.rows=[row];api.applyProject(await api.prepareProject(snapshot));});
 const seededCalculation=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/penetration/calculate'&&response.request().method()==='POST'&&response.request().postDataJSON()?.draft?.rows?.some(row=>row.id==='presentation-layout-row'));
 await page.evaluate(()=>window.CeasefirePenetrationNavigation.showSchedule());const seededReply=await seededCalculation;assert.equal(seededReply.status(),200);await seededReply.finished();await page.waitForFunction(()=>!window.CeasefireActivity?.active);
 const populatedFireDraft=await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot());
 for(const width of [1146,390]){await page.setViewportSize({width,height:850});const table=page.locator('.penetration-schedule table:visible').first();await expect(table).toBeVisible();await expect(table.locator('input[data-penetration-field="O"]')).toBeVisible();const layout=await table.evaluate(table=>{const control=table.querySelector('input[data-penetration-field="O"]');return {tableWidth:table.getBoundingClientRect().width,layout:getComputedStyle(table).tableLayout,headers:[...table.querySelectorAll('th')].map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,whiteSpace:getComputedStyle(el).whiteSpace})),quantity:{width:control.getBoundingClientRect().width,height:control.getBoundingClientRect().height,cellWidth:control.closest('td').getBoundingClientRect().width}};});assert.equal(layout.layout,'fixed');assert.ok(layout.headers.every(header=>header.whiteSpace==='normal'));assert.ok(layout.quantity.width>=60&&layout.quantity.width<=layout.quantity.cellWidth);assert.ok(layout.quantity.height>=44);evidence.layouts.push({title:'Firestopping',viewport:width,...layout});await screenshot(`Firestopping-${width}.png`);assert.deepEqual(await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot()),populatedFireDraft);}
 await page.evaluate(async snapshot=>{const api=window.CeasefirePenetrations;api.applyProject(await api.prepareProject(snapshot));},fireDraft);assert.deepEqual(await page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot()),fireDraft);assert.deepEqual(await draft(),edited);assert.deepEqual(errors,[]);
 evidence.source_sha256_after=sourceHashes();assert.deepEqual(evidence.source_sha256_after,evidence.source_sha256);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,...evidence,errors},null,2));console.log(`PASS calculator presentation: ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),...evidence,errors},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
