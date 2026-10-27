// Selected tool styling and calculator headers without lightning, on disposable data.
const {chromium,expect}=require('@playwright/test');
const {chooseTakeoff}=require('./section_navigation.cjs'),{chooseCalculator}=require('./calculator_actions.cjs');
const {renderDrawing}=require('./viewer_helpers.cjs');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`active-tools-lightning-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let browser,page,logs='';server.stderr.on('data',b=>logs+=b);
const ready=new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',b=>{value+=b;if(value.includes('\n')){clearTimeout(timer);resolve(JSON.parse(value.split('\n')[0]));}});server.on('error',reject);});
const errors=[],evidence=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);}
const paint=locator=>locator.evaluate(el=>{const c=getComputedStyle(el),r=el.getBoundingClientRect();return{border:c.borderColor,shadow:c.boxShadow,width:r.width,height:r.height};});
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:900}});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${info.port}/`);await idle();await chooseTakeoff(page,'Steel');
 await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture));await idle();
 const before=await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot());
 for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
  await page.locator('nav [data-view="settings"]').click();await idle();
  for(let i=0;i<5&&await page.locator('html').getAttribute('data-theme')!==theme;i++)await page.locator('#theme-toggle').click();
  await chooseTakeoff(page,'Steel');await idle();
  for(const width of [1384,390]){
   await page.setViewportSize({width,height:900});
   const select=page.locator('#takeoffs-workspace button[data-tool="select"]'),rectangle=page.locator('.takeoff-markup-rail button[data-tool="graphic-rectangle"]');
   await select.click();await expect(rectangle).not.toHaveCSS('border-color','rgb(255, 224, 102)');const inactive=await paint(rectangle);
   await rectangle.click();await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool','graphic-rectangle');await rectangle.hover();
   await expect(rectangle).toHaveCSS('border-color','rgb(255, 224, 102)');const active=await paint(rectangle);assert.match(active.shadow,/255, 224, 102/);assert.equal(active.width,inactive.width);assert.equal(active.height,inactive.height);assert.notEqual((await paint(select)).border,'rgb(255, 224, 102)','Previous tool loses the yellow outline');
   const visibility=page.locator('.takeoff-tool-rail').getByRole('button',{name:'Visibility',exact:true});await visibility.click();await expect(visibility).toHaveAttribute('aria-pressed','true');await expect(visibility).toHaveCSS('border-color','rgb(255, 224, 102)');await visibility.click();
   evidence.push({theme,width,active});if(theme==='ceasefire'&&width===1384)await page.screenshot({path:path.join(output,'selected-yellow-tool.png')});
  }
 }
 await page.setViewportSize({width:1384,height:900});
 for(const [name,selector] of [['Steel (spray)','.calculator-workspace-heading'],['Steel (intumescent)','.calculator-workspace-heading'],['Steel (board)','.calculator-workspace-heading'],['Ductwork (spray/wrap)','.calculator-workspace-heading'],['Factor Calcs','.calculator-workspace-heading'],['Firestopping','.penetration-banner-heading']]){
  await chooseCalculator(page,name);await idle();
  if(name==='Firestopping')await expect(page.locator('#penetration-heading')).toHaveCSS('font-size','23px');
  for(const width of [1384,390]){
   await page.setViewportSize({width,height:900});
   const value=await page.locator(selector).evaluate(el=>{const bolt=el.querySelector('.calculator-heading-lightning'),r=bolt.getBoundingClientRect(),slot=el.querySelector('.calculator-heading-art-slot').getBoundingClientRect(),art=[...el.querySelectorAll('.workspace-header-art,.penetration-workspace-art')].find(n=>getComputedStyle(n).display!=='none'),a=art?.getBoundingClientRect();return{display:getComputedStyle(bolt).display,width:r.width,height:r.height,artGap:a?getComputedStyle(el).direction==='rtl'?slot.right-a.right:a.left-slot.left:null};});
   assert.equal(value.display,'none','Calculator lightning is hidden');assert.equal(value.width,0);assert.equal(value.height,0);if(value.artGap!==null)assert.ok(Math.abs(value.artGap-18)<.1,'Artwork follows the copy without the former bolt gap');evidence.push({name,width,...value});
  }
 }
 assert.deepEqual(await page.evaluate(()=>window.CeasefireTakeoffs.projectSnapshot()),before,'Visual selection and calculator navigation preserve the drawing');assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));console.log('PASS active tools/lightning: '+output);
})().catch(async e=>{console.error(e);process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
