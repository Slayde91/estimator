// Verify the requested chrome on disposable data and browser state only.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseTakeoff,chooseLibrary}=require('./section_navigation.cjs');
const {assertPreviewHeaderIcons}=require('./preview_header_helpers.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`header-layout-followups-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[],evidence={layouts:[],views:[],languages:[]};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function snapshot(){await idle();return page.evaluate(()=>({project:window.CeasefireProject.details(),inputs:[...document.querySelectorAll('#main-estimate-form input,#main-estimate-form select,#main-estimate-form textarea')].map(el=>[el.id,el.value,el.checked]),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),configuration:window.CeasefireProject.configuration()}));}
async function dock(){
 const value=await page.locator('#header-project-actions').evaluate(el=>{const r=el.getBoundingClientRect();return{position:getComputedStyle(el).position,parent:el.parentElement.tagName,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],hit:[...el.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return b===hit||b.contains(hit);})};});
 assert.equal(value.position,'fixed');assert.equal(value.parent,'BODY');assert.ok(value.x>=0&&value.right<=value.viewport[0]);assert.ok(value.y>value.viewport[1]/2&&value.bottom<=value.viewport[1]);assert.ok(value.viewport[0]-value.right<=17&&value.viewport[1]-value.bottom<=17);assert.equal(value.hit,true,'Both existing controls are reachable');
 await expect(page.locator('#save-current-project')).toBeVisible();await expect(page.locator('#project-attachment-zone')).toBeVisible();return value;
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764}});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});await chooseTakeoff(page,'Steel');await idle();
 await page.locator('nav [data-view="estimate"]').click();await idle();await page.locator('#project-no').fill('HEADER-FIXTURE');await page.locator('#client').fill('Original <literal> client');await page.locator('#client').blur();await idle();const baseline=await snapshot();
 await assertPreviewHeaderIcons(page);
 for(const width of [1600,1384,1146,906,720,390,320]){
  await page.setViewportSize({width,height:764});await page.locator('nav [data-view="home"]').click();await idle();
  const layout=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return{header:box('.app-header'),brand:box('.brand-stack'),tagline:box('#header-tagline'),nav:box('.app-header nav'),overflow:document.documentElement.scrollWidth-innerWidth,labels:[...document.querySelectorAll('.app-header .nav-icon')].map(el=>{const icon=el.querySelector('svg').getBoundingClientRect(),label=el.querySelector('.nav-page-label'),r=label.getBoundingClientRect();return{text:label.textContent,display:getComputedStyle(label).display,width:r.width,height:r.height,y:r.y,iconBottom:icon.bottom};})};});
  assert.ok(layout.overflow<=1,JSON.stringify({width,layout}));assert.equal(layout.labels.length,8);
  for(const label of layout.labels){assert.notEqual(label.display,'none');assert.ok(label.width>0&&label.height>0&&label.y>=label.iconBottom,JSON.stringify({width,label}));}
  assert.ok(layout.tagline.x>=layout.brand.right,'Mascot and quote sit to the right of the logo');assert.ok(layout.nav.right<=width&&layout.header.bottom>=layout.nav.bottom);
  if(width>1150){assert.ok(width-layout.nav.right<=32,'Navigation occupies the far right');assert.ok(layout.tagline.right<=layout.nav.x);}
  evidence.layouts.push({width,...layout,dock:await dock()});await page.screenshot({path:path.join(output,`header-layout-${width}.png`)});
 }
 await page.setViewportSize({width:1384,height:764});
 const views=[...['home','estimate','quotes','help','settings'].map(id=>[id,()=>page.locator(`nav [data-view="${id}"]`).click()]),...['Steel (spray)','Steel (board)','Ductwork (spray/wrap)','Firestopping'].map(name=>[name,()=>chooseCalculator(page,name)]),...['Steel','Duct','Walls/Floors','Defect Reports','Service Plans'].map(name=>[name,()=>chooseTakeoff(page,name)]),...['pricing','penetration','technical'].map(kind=>['library-'+kind,()=>chooseLibrary(page,kind)])];
 for(const [name,open]of views){await open();await idle();const before=await dock();await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));const after=await dock();assert.equal(before.y,after.y);assert.equal(before.x,after.x);evidence.views.push({name,dock:after});}
 assert.deepEqual(await snapshot(),baseline,'Layout and navigation retain original drafts, inputs and calculator values');
 await page.locator('nav [data-view="settings"]').click();await idle();
 for(const locale of ['zh-Hans','hi','es','ar','th','en']){await page.locator('#application-language').selectOption(locale);await page.setViewportSize({width:390,height:764});const labels=await page.locator('.app-header .nav-page-label').allTextContents();for(const label of labels)assert.ok(label.trim());const visible=await page.locator('.app-header .nav-page-label').evaluateAll(nodes=>nodes.every(el=>{const r=el.getBoundingClientRect();const button=el.closest('button').getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=button.top&&r.bottom<=button.bottom;}));assert.equal(visible,true,locale+' labels remain visible on phones');evidence.languages.push({locale,labels,dock:await dock()});}
 assert.deepEqual(await snapshot(),baseline,'Translated labels preserve canonical values');
 // Native dialogs use the top layer. The dock is deliberately unavailable while
 // one is open, then resumes with its original controls when it closes.
 await page.evaluate(()=>{const d=document.createElement('dialog');d.id='header-modal-probe';d.textContent='Disposable modal test';document.body.append(d);d.showModal();});await expect(page.locator('#header-project-actions')).toBeHidden();await page.locator('#header-modal-probe').evaluate(el=>{el.close();el.remove();});await dock();
 await page.emulateMedia({media:'print'});await expect(page.locator('#header-project-actions')).toBeHidden();await page.emulateMedia({media:'screen'});await dock();assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,port:fixture.port,evidence,errors},null,2));console.log(`PASS header layout follow-ups: ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
