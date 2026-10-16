// Rendered appearance contracts on a disposable application. No live data is used.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseTakeoff}=require('./section_navigation.cjs');
const {seedRegisterParity,assertRegisterControlParity}=require('./register_control_parity.cjs');
const {assertReadableControl}=require('./physical_tools_helpers.cjs');
const alignmentOnly=process.argv.includes('--alignment-only');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`appearance-theme-followups-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exit ${code}: ${logs}`));});});
const errors=[],evidence=[];
async function idle(){await expect.poll(()=>page.evaluate(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;}),{timeout:30000}).toBe(true);}
const snapshot=()=>page.evaluate(async()=>({project:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration(),calculators:await window.CeasefireCalculators.completeProjectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),takeoffs:window.CeasefireTakeoffs.projectSnapshot()}));
async function settings(){await page.locator('nav [data-view=settings]').click();await idle();}
async function theme(id){await settings();for(let i=0;i<5&&await page.locator('html').getAttribute('data-theme')!==id;i++)await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme',id);}
async function main(){await page.locator('#estimate-navigation-toggle').hover();if(!await page.locator('#estimate-navigation-menu').isVisible())await page.locator('#estimate-navigation-toggle').click();await page.locator('#estimate-navigation-menu [data-estimator-kind=estimate]').click();await page.mouse.move(0,0);await idle();}
function lum(value){const c=value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
function contrast(a,b){const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
async function tabs(selector){const values=await page.locator(selector).evaluateAll(nodes=>nodes.map(el=>{const c=getComputedStyle(el);return{text:el.textContent.trim(),border:c.borderBottomColor,shadow:c.boxShadow};}));assert.ok(values.length,`No selected tab: ${selector}`);for(const value of values){assert.equal(value.border,'rgb(255, 255, 255)',JSON.stringify(value));assert.match(value.shadow,/inset.*rgb\(255, 255, 255\)|rgb\(255, 255, 255\).*inset/);}return values;}
async function colors(selector){return page.locator(selector).first().evaluate(el=>{const c=getComputedStyle(el);return{background:c.backgroundColor,color:c.color};});}
async function mainEstimateAppearance(expectedDays){
 await expect(page.locator('#main-input-heading')).toBeVisible();
 const headingFont=await page.locator('#main-input-heading').evaluate(el=>getComputedStyle(el).fontSize);assert.equal(headingFont,'20px');
 const previousOutput=await page.locator('#main-output-tabs [aria-selected=true]').getAttribute('id');
 await page.locator('#main-tab-labour-breakdown').click();await expect(page.locator('#labour-breakdown')).toHaveAttribute('aria-busy','false');
 const cells=page.locator('.labour-table tr.labour-total > :is(th,td)');await expect(cells).toHaveCount(2);await expect(cells.first()).toBeVisible();
 const totalCells=await cells.evaluateAll(nodes=>nodes.map(el=>{const c=getComputedStyle(el);return{tag:el.tagName,text:el.textContent.trim(),background:c.backgroundColor,image:c.backgroundImage,color:c.color,border:c.borderTopColor,borderWidth:c.borderTopWidth,borderStyle:c.borderTopStyle};}));
 assert.deepEqual(totalCells.map(value=>value.tag),['TH','TD']);
 for(const value of totalCells){assert.equal(value.background,'rgb(185, 10, 21)',JSON.stringify(value));assert.equal(value.image,'none');assert.equal(value.color,'rgb(255, 255, 255)',JSON.stringify(value));assert.equal(value.border,'rgb(237, 0, 27)',JSON.stringify(value));assert.equal(value.borderWidth,'2px');assert.equal(value.borderStyle,'solid');assert.ok(contrast(value.color,value.background)>=4.5,JSON.stringify(value));}
 assert.equal(totalCells[1].text,expectedDays,'Themes and presentation preserve the calculated project-day total');
 assert.equal((await page.locator('#sum-days').textContent()).trim(),expectedDays,'Labour total still reconciles to the estimate summary');
 if(previousOutput!=='main-tab-labour-breakdown')await page.locator('#'+previousOutput).click();
 return{headingFont,totalCells,days:totalCells[1].text};
}
// Scope distinguishes column headings from product row headings and line values.
async function calculatorHeaders(){
 const values=await page.locator('#calculator-grid :is(thead th,th[scope="col"],.calculator-source-heading,.calculator-role-column_header,.calculator-section-anchor,.calculator-role-title,.calculator-role-section,.calculator-role-compact_title,.calculator-role-compact_summary_title,.calculator-overview h3,.calculator-overview-section,.calculator-product-totals h4)').evaluateAll(nodes=>{
  const probe=document.createElement('span');probe.style.color='var(--red)';document.documentElement.append(probe);const red=getComputedStyle(probe).color;probe.remove();
  return nodes.filter(el=>el.getClientRects().length).map(el=>{const c=getComputedStyle(el);return{text:el.textContent.trim().slice(0,90),classes:el.className,scope:el.getAttribute('scope'),section:el.matches('.calculator-section-anchor,.calculator-role-title,.calculator-role-section,.calculator-role-compact_title,.calculator-role-compact_summary_title,.calculator-overview h3,.calculator-overview-section,.calculator-product-totals h4'),background:c.backgroundColor,image:c.backgroundImage,color:c.color,bottom:c.borderBottomColor,bottomWidth:c.borderBottomWidth,red};});
 });
 assert.ok(values.length,'Real calculator has rendered headers');
 for(const value of values){assert.equal(value.background,'rgb(255, 255, 255)',JSON.stringify(value));assert.equal(value.color,'rgb(0, 0, 0)',JSON.stringify(value));assert.equal(value.image,'none',JSON.stringify(value));assert.equal(value.bottom,value.red,JSON.stringify(value));if(value.section)assert.equal(value.bottomWidth,'4px',JSON.stringify(value));else assert.ok(['1px','2px'].includes(value.bottomWidth),JSON.stringify(value));}
 return values;
}
async function formAlignment(){
 const forms=['.calculator-responsive-form','.calculator-settings-panel .calculator-form-table:not(.calculator-projection-table)'];
 const selectors=['#calculator-grid input:not([type="checkbox"]):not([type="radio"])','#calculator-grid select','#calculator-grid textarea',...forms.flatMap(form=>[`#calculator-grid ${form} td[data-calculator-value]`,`#calculator-grid ${form} td[data-calculator-value] *`])];
 const values=await page.locator(selectors.join(',')).evaluateAll(nodes=>nodes.map(el=>{const c=getComputedStyle(el);return{tag:el.tagName,cell:el.dataset.calculatorCell||el.dataset.calculatorCustomCell||el.dataset.calculatorOutput||el.closest('[data-calculator-output]')?.dataset.calculatorOutput||'',control:el.matches('input,select,textarea'),align:c.textAlign,last:c.textAlignLast,text:el.value??el.textContent.trim().slice(0,50)};}));
 for(const value of values){assert.equal(value.align,'left',JSON.stringify(value));if(value.control)assert.equal(value.last,'left',JSON.stringify(value));}
 const controls=values.filter(value=>value.control),readonly=values.filter(value=>!value.control);return{controls:controls.length,readonlyValues:readonly.length,tags:[...new Set(controls.map(value=>value.tag))],examples:[...controls.slice(0,3),...readonly.slice(0,3)]};
}
async function publishedNumericAlignment(required=false){
 const values=await page.locator('#calculator-grid :is(.calculator-projection-table:not(.calculator-responsive-form),.calculator-comparison-table,.calculator-order-table,.calculator-centered-data-table) td.calculator-number').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length&&!el.querySelector('input,select,textarea')).map(el=>({cell:el.dataset.calculatorOutput||'',text:el.textContent.trim(),align:getComputedStyle(el).textAlign,expected:el.closest('.calculator-centered-data-table')||el.matches('.calculator-align-center')?'center':el.matches('.calculator-align-left')?'left':'right',table:el.closest('table').getAttribute('aria-label')||el.closest('table').className})));
 if(required)assert.ok(values.length,'A real summary/purchasing table exposes numeric values');
 for(const value of values)assert.equal(value.align,value.expected,JSON.stringify(value));
 return{count:values.length,examples:values.slice(0,4)};
}
async function readonlyAlignmentViewports(tolerance=false,summary=false){
 const original=page.viewportSize(),evidence=[];
 try{for(const viewport of [{width:1384,height:825},{width:1280,height:720},{width:825,height:764},{width:390,height:700}]){
  await page.setViewportSize(viewport);
  const values=await page.locator('#calculator-grid .calculator-settings-panel .calculator-form-table:not(.calculator-projection-table) td[data-calculator-value]').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>({cell:el.dataset.calculatorOutput||'',text:el.textContent.trim(),align:getComputedStyle(el).textAlign,last:getComputedStyle(el).textAlignLast,table:el.closest('table').className})));
  for(const value of values){assert.equal(value.align,'left',JSON.stringify({viewport,...value}));assert.equal(value.last,'left',JSON.stringify({viewport,...value}));}
  if(tolerance){const d15=values.find(value=>value.cell==='D15');assert.ok(d15,'Visible Global Settings includes its actual Comparison tolerance D15 output');assert.ok(!d15.table.includes('calculator-projection-table'));assert.ok(!d15.table.includes('calculator-responsive-form'),'D15 exercises the ordinary wide form omitted by the former selector');}
  evidence.push({viewport,readonlyValues:values.length,tolerance:values.find(value=>value.cell==='D15'),examples:values.slice(0,4),publishedNumeric:await publishedNumericAlignment(summary)});
 }}finally{await page.setViewportSize(original);}
 return evidence;
}
async function scheduleLines(){
 const values=await page.locator('#calculator-grid .calculator-schedule-table tbody td.calculator-line-number').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length).map(el=>{let adjacent=el.nextElementSibling;while(adjacent&&(!adjacent.getClientRects().length||adjacent.matches('.calculator-row-action')))adjacent=adjacent.nextElementSibling;const c=getComputedStyle(el),next=adjacent&&getComputedStyle(adjacent);return{text:el.textContent.trim(),background:c.backgroundColor,color:c.color,adjacentBackground:next?.backgroundColor,adjacentText:adjacent?.textContent.trim().slice(0,40)};}));
 assert.ok(values.length,'Schedule keeps its native Line values after removing the redundant Row column');for(const value of values){assert.equal(value.background,value.adjacentBackground,JSON.stringify(value));assert.ok(contrast(value.color,value.background)>=4.5,JSON.stringify(value));}return{count:values.length,first:values[0]};
}
async function productRows(){
 const values=await page.locator('#calculator-product-totals tbody th[scope="row"]').evaluateAll(nodes=>nodes.map(el=>{const c=getComputedStyle(el),adjacent=getComputedStyle(el.nextElementSibling);return{product:el.textContent,background:c.backgroundColor,color:c.color,adjacentBackground:adjacent.backgroundColor,adjacentColor:adjacent.color};}));
 assert.ok(values.length,'Spray summary exposes product rows');for(const value of values){assert.equal(value.background,value.adjacentBackground,JSON.stringify(value));assert.ok(contrast(value.color,value.background)>=4.5,JSON.stringify(value));}return values;
}
async function calculatorPage(label){await page.locator('#calculator-pages').getByRole('button',{name:label,exact:true}).click();await idle();await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');}
async function calculatorAppearance(id,name){
 await chooseCalculator(page,name);await idle();const result={id,name};const labels=await page.locator('#calculator-pages button').allTextContents();
 if(!alignmentOnly){
 if(labels.includes('START')){await calculatorPage('START');result.startHeaders=await calculatorHeaders();result.startAlignment=await formAlignment();if(id==='steel_board')await expect(page.locator('#calculator-section-steel_board-START-A8')).toHaveCSS('border-bottom-width','4px');}
 await calculatorPage('SCHEDULE');result.scheduleHeaders=await calculatorHeaders();result.scheduleAlignment=await formAlignment();assert.ok(result.scheduleAlignment.controls>0,`${name} has actual schedule fields`);result.lines=await scheduleLines();
 }
 for(const label of labels.filter(value=>/SETTINGS/.test(value))){
  await calculatorPage(label);const choices=page.locator('.calculator-settings-choice');if(await choices.count()){
   const global=page.locator('[aria-controls="calculator-settings-steel_vermiculite-SETTINGS-A9"]');const choice=await global.count()?global:choices.first();if(await choice.getAttribute('aria-expanded')!=='true')await choice.click();await idle();result.settingTabs=await tabs('.calculator-settings-choice[aria-expanded=true]');
  }
  const setting={page:label,headers:await calculatorHeaders(),alignment:await formAlignment(),sections:[]};
  for(const choice of await choices.all()){
   if(await choice.getAttribute('aria-expanded')!=='true')await choice.click();await idle();
   const global=await choice.getAttribute('aria-controls')==='calculator-settings-steel_vermiculite-SETTINGS-A9';
   setting.sections.push({name:await choice.innerText(),tabs:await tabs('.calculator-settings-choice[aria-expanded=true]'),viewports:await readonlyAlignmentViewports(global)});
  }
  if(!await choices.count())setting.viewports=await readonlyAlignmentViewports();
  (result.settings||=[]).push(setting);
 }
 if(id==='steel_vermiculite'){await calculatorPage('SUMMARY');result.summaryHeaders=await calculatorHeaders();result.products=await productRows();}
 if(id==='steel_board'){
  await calculatorPage('BOARD SUMMARY');const heading=page.getByRole('table',{name:'Board purchasing totals',exact:true}).getByRole('columnheader',{name:'Net Steel sqm',exact:true});await expect(heading).toHaveCount(1);await expect(heading).toHaveAttribute('scope','col');await expect(heading).toHaveCSS('background-color','rgb(255, 255, 255)');await expect(heading).toHaveCSS('color','rgb(0, 0, 0)');result.summaryHeaders=await calculatorHeaders();
 }
 if(id==='ductwork')await calculatorPage('SUMMARY');
 result.numericSummary=await readonlyAlignmentViewports(false,true);
 return result;
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 // Initialize each real workspace once before checking that theme changes do not alter models.
 await main();await chooseCalculator(page,'Steel (spray)');await idle();await chooseCalculator(page,'Firestopping');await idle();await chooseTakeoff(page,'physical');await idle();if(!alignmentOnly)await seedRegisterParity(page,fixture);
 let mainDaysBefore;if(!alignmentOnly){await main();await expect(page.locator('#labour-breakdown')).toHaveAttribute('aria-busy','false');mainDaysBefore=(await page.locator('.labour-table tr.labour-total > td').textContent()).trim();}
 await settings();const before=await snapshot();
 for(const id of ['ceasefire','midnight','ocean','forest','slate']){
  await theme(id);const item={id};
  if(!alignmentOnly){
  item.logo=await colors('#company-logo-preview');assert.equal(item.logo.background,'rgba(0, 0, 0, 0)');await expect(page.locator('#company-logo-preview')).toHaveJSProperty('complete',true);item.logoPixels=await page.locator('#company-logo-preview').evaluate(el=>{const canvas=document.createElement('canvas');canvas.width=el.naturalWidth;canvas.height=el.naturalHeight;const c=canvas.getContext('2d');c.drawImage(el,0,0);return{src:el.getAttribute('src'),width:el.naturalWidth,height:el.naturalHeight,cornerAlpha:c.getImageData(0,0,1,1).data[3]};});assert.equal(item.logoPixels.src,'/classifire-logo.png');assert.equal(item.logoPixels.cornerAlpha,0);
  item.file=await page.locator('#company-logo').evaluate(el=>{const c=getComputedStyle(el,'::file-selector-button');return{background:c.backgroundColor,color:c.color};});assert.deepEqual(item.file,{background:'rgb(255, 255, 255)',color:'rgb(0, 0, 0)'});
  item.save=await colors('#company-settings-save');assert.equal(item.save.background,'rgb(185, 10, 21)');assert.ok(contrast(item.save.color,item.save.background)>=4.5);const originalDisabled=await page.locator('#company-settings-save').isDisabled();await page.locator('#company-settings-save').evaluate(el=>el.disabled=true);item.disabledSave=await colors('#company-settings-save');assert.ok(contrast(item.disabledSave.color,item.disabledSave.background)>=4.5);await page.locator('#company-settings-save').evaluate((el,value)=>el.disabled=value,originalDisabled);
  await main();item.inputTabs=await tabs('#main-section-tabs [aria-selected=true]');item.outputTabs=await tabs('.main-output-tabs [aria-selected=true]');item.mainEstimate=await mainEstimateAppearance(mainDaysBefore);
  }
  item.calculators=[];for(const [calculator,name] of [['steel_vermiculite','Steel (spray)'],['steel_board','Steel (board)'],['ductwork','Ductwork (spray/wrap)']])item.calculators.push(await calculatorAppearance(calculator,name));
  if(!alignmentOnly){
  item.calculatorTabs=await tabs('#calculator-pages [aria-pressed=true]');
  await chooseCalculator(page,'Firestopping');await idle();item.itemTabs=await tabs('.penetration-group[aria-selected=true],.penetration-group[aria-pressed=true]');item.diagram=await colors('#penetration-diagram');const expected=await page.locator('html').evaluate(el=>{const probe=document.createElement('div');probe.style.background='var(--theme-raised)';probe.style.color='var(--ink)';el.append(probe);const c=getComputedStyle(probe),v={background:c.backgroundColor,color:c.color};probe.remove();return v;});assert.deepEqual(item.diagram,expected);assert.ok(contrast(item.diagram.color,item.diagram.background)>=4.5);
  await chooseTakeoff(page,'physical');await idle();item.physical=await colors('.takeoff-physical-register');const surface=await page.locator('html').evaluate(el=>{const probe=document.createElement('div');probe.style.background='var(--theme-surface)';probe.style.color='var(--ink)';el.append(probe);const c=getComputedStyle(probe),v={background:c.backgroundColor,color:c.color};probe.remove();return v;});assert.deepEqual(item.physical,surface);item.physicalHeader=await colors('.takeoff-physical-register thead th');assert.ok(contrast(item.physicalHeader.color,item.physicalHeader.background)>=4.5);item.physicalUndo=await assertReadableControl(page.locator('.takeoff-physical-register .takeoff-undo-button'));
  item.registerControls=await assertRegisterControlParity(page);
  await page.locator('.takeoff-physical-register').screenshot({path:path.join(output,`physical-${id}.png`)});
  }
  assert.deepEqual(await snapshot(),before,`Theme/navigation preserved all canonical inputs: ${id}`);evidence.push(item);
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,mode:alignmentOnly?'readonly-and-published-table-alignment':'complete-appearance',fixturePort:fixture.port,evidence,errors},null,2));console.log(`PASS ${alignmentOnly?'readonly and published table alignment':'appearance theme followups'}: ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
