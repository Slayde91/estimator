// Exercise the real heading/tab controls against a disposable fixture only.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseLibrary,chooseTakeoff}=require('./section_navigation.cjs');
const {prepareProjectForSave,clickProjectControl,openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`workspace-headings-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,info;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',c=>{clearTimeout(timer);reject(Error(`Fixture exited ${c}: ${logs}`));});});
const errors=[],evidence={calculatorLayouts:[],libraryLayouts:[],takeoffLayouts:[],noteHovers:[],mobileMenus:[]};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function bounds(selector){return page.locator(selector).evaluate(el=>{const b=el.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};});}
async function noOverflow(context){const g=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,inner:innerWidth,scrollX}));assert.ok(g.document<=g.viewport+1&&g.inner<=g.viewport+1,`${context}: ${JSON.stringify(g)}`);}
async function headingBefore(heading,tabs){await expect(page.locator(heading)).toBeVisible();const h=await bounds(heading),t=await bounds(tabs);assert.ok(h.bottom<=t.y+1,`${heading} must precede ${tabs}: ${JSON.stringify({h,t})}`);assert.ok(Math.abs(h.x-t.x)<2,`${heading} aligns with its main tabs`);return{h,t};}
async function titleAndTabPositions(title,tabs){
 const view=await page.locator(title).evaluate(el=>el.closest('.workspace-view').getBoundingClientRect().top);
 const h=await bounds(title),t=await bounds(tabs);
 return {left:h.x,top:h.y-view,tabTop:t.y-view};
}
function assertAligned(actual,peer,context){
 for(const key of Object.keys(peer))assert.ok(Math.abs(actual[key]-peer[key])<=1,`${context} ${key}: ${actual[key]} vs ${peer[key]}`);
}
async function stateSnapshot(){return page.evaluate(()=>({calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));}
(async()=>{
 info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});
 page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',e=>window.qaCsp.push(e.effectiveDirective));});
 await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
 await page.locator('#calculator-navigation-toggle').click();await expect(page.locator('#estimator-penetration')).toBeVisible();
 await expect(page.locator('#calculator-steel-hub')).toHaveCount(0);await expect(page.locator('#calculator-kind-pages button').first()).toHaveText('Firestopping');
 await headingBefore('.penetration-banner-heading','#calculator-kind-pages');
 await prepareProjectForSave(page);const saving=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await saving).status(),200);await idle();
 const quotePositions=new Map(),firePositions=new Map();
 for(const section of ['quote','quotes']){
  await openProjectSection(page,section);
  for(const width of [1915,1011,631,390,320]){
   await page.setViewportSize({width,height:1000});
   const layout=await titleAndTabPositions(section==='quote'?'#commercial-quote-root h1':'#quotes-heading','#project-pages');
   if(section==='quote')quotePositions.set(width,layout);
   else assertAligned(layout,quotePositions.get(width),'Projects vs Quotes at '+width);
  }
  await page.setViewportSize({width:1915,height:1000});
 }
 await page.locator('#documents-navigation-toggle').click();await expect(page.locator('#view-documentation')).toBeVisible();await expect(page.locator('#view-documents')).toHaveCount(0);
 const calculators=['Firestopping','Duct','Steel (spray)','Steel (intumescent)','Steel (board)','Factor Calcs'];
 for(const title of calculators){await chooseCalculator(page,title);await idle();}
 const before=await stateSnapshot();
 for(const title of calculators){
  await chooseCalculator(page,title);await idle();
  const fire=title==='Firestopping',heading=fire?'.penetration-banner-heading':'.calculator-workspace-heading';
  for(const theme of ['ceasefire','midnight','ocean','forest','slate'])for(const width of [1915,1254,631,390,320]){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.mouse.move(0,0);await page.evaluate(()=>scrollTo(0,0));
   const geometry=await headingBefore(heading,'#calculator-kind-pages');await noOverflow(`${title}/${theme}/${width}`);
   if(fire||title==='Duct'){
    const layout=await titleAndTabPositions(fire?'#penetration-heading':'#calculator-title','#calculator-kind-pages'),key=theme+'/'+width;
    if(fire)firePositions.set(key,layout);
    else assertAligned(layout,firePositions.get(key),'Duct vs Firestopping at '+key);
   }
   if(fire){const toggle=page.locator('.penetration-banner-heading [data-document-menu-toggle]');await toggle.click();const menu=page.locator('#firestopping-item-document-actions');await expect(menu).toBeVisible();const box=await menu.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'Firestopping Document menu fits its relocated heading');await menu.getByRole('button').first().click({trial:true});await page.keyboard.press('Escape');}
   if(!fire){const status=await bounds('#calculator-save-status');assert.ok(status.right<=geometry.h.right+1&&Math.abs(status.y-geometry.h.y)<2,'Live save status is at the heading top-right');}
   if(!fire&&title!=='Factor Calcs'&&width>760){
    const actions=await bounds('#calculator-toolbar-actions'),tabs=await bounds('#calculator-pages');assert.ok(tabs.right<=actions.x+1&&actions.y<tabs.bottom&&tabs.y<actions.bottom,'Tools share the inner tab row, after the scroller');
    const columns=page.locator('#calculator-toolbar-actions .schedule-column-toggle');if(await columns.isVisible()){const c=await columns.boundingBox(),d=await bounds('#calculator-document-toggle');assert.ok(c.x+c.width<=d.x+1&&Math.abs(d.y-c.y)<8,'Columns remains left of Document');}
    for(const id of ['calculator-reset','calculator-recalculate']){const control=page.locator('#'+id),b=await control.boundingBox(),style=await control.evaluate(el=>{const s=getComputedStyle(el);return{border:s.borderTopStyle,width:parseFloat(s.borderTopWidth)};});assert.ok(b.x>=0&&b.x+b.width<=width+1&&b.y>=0&&b.y+b.height<=1000,'Existing calculator tool remains visible within the viewport: '+JSON.stringify({title,theme,width,id,box:b,style}));assert.equal(style.border,'solid');assert.ok(style.width>=1,'Calculator tool outline remains visible');}
   }
   evidence.calculatorLayouts.push({title,theme,width,geometry});
  }
  // Real notes (including blank report-note cells) keep their body surface on hover.
  await page.setViewportSize({width:1915,height:1000});
  const note=page.locator('#calculator-grid td.calculator-calculation-note').first();
  if(await note.count())for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.mouse.move(0,0);
   const style=()=>note.evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));const old=await style();await note.hover();assert.deepEqual(await style(),old,`${title}/${theme} note hover preserves surface and text contrast`);evidence.noteHovers.push({title,theme,style:old});
  }
 }
 assert.ok(evidence.noteHovers.length>=10,'Multiple actual workbook calculators expose calculation-note hover checks');
 assert.deepEqual(await stateSnapshot(),before,'Changing headings, themes and tabs preserves calculator inputs and exact drafts');
 for(const kind of ['pricing','penetration','technical']){
  await chooseLibrary(page,kind);await idle();
  for(const width of [1915,631,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));const geometry=await headingBefore(`#pricing-heading-slot [data-library-heading="${kind}"]`,'#library-pages');await noOverflow(`${kind}/${width}`);evidence.libraryLayouts.push({kind,width,geometry});}
 }
 for(const mode of ['Steel','Duct','Walls/Floors','Defect Reports','Service Plans']){
  await chooseTakeoff(page,mode);await idle();
  for(const width of [1915,631,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));const geometry=await headingBefore('.takeoff-workspace-heading','#takeoff-pages');await noOverflow(`${mode}/${width}`);evidence.takeoffLayouts.push({mode,width,geometry});}
 }
 // Reproduce the hosted navigation-stack overflow boundary with native touch hit testing.
 for(const width of [320,390,671]){
  const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:true});const mobile=await context.newPage();await mobile.goto(`http://127.0.0.1:${info.port}/`);await mobile.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  for(const [toggle,menu]of[['library','library'],['takeoff','takeoff']]){await mobile.locator(`#${toggle}-navigation-toggle`).tap();await expect(mobile.locator(`#${menu}-navigation-menu`)).toBeVisible();const g=await mobile.evaluate(()=>({viewport:document.documentElement.clientWidth,document:document.documentElement.scrollWidth,inner:innerWidth}));assert.ok(g.document<=width+1&&g.inner<=width+1,`Touch menu does not widen mobile layout: ${JSON.stringify({width,toggle,g})}`);evidence.mobileMenus.push({width,toggle,g});if(toggle==='library'){await mobile.locator('#library-navigation-menu [data-library-kind="technical"]').tap();await expect(mobile.locator('#library-technical')).toBeVisible();}}
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));console.log(JSON.stringify({passed:true,output,calculatorLayouts:evidence.calculatorLayouts.length,libraryLayouts:evidence.libraryLayouts.length,takeoffLayouts:evidence.takeoffLayouts.length,noteHovers:evidence.noteHovers.length,mobileMenus:evidence.mobileMenus.length}));
})().catch(async e=>{console.error(e);if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});console.error(JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.right>document.documentElement.clientWidth+1;}).slice(0,20).map(el=>({tag:el.tagName,id:el.id,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))).catch(()=>[])));}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
