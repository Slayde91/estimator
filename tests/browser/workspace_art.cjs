// Decorative banners retain real controls, existing header heights and drafts.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`workspace-art-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const evidence=[],errors=[],csp=[];
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;},null,{timeout:60000});}
async function snapshot(){await idle();return page.evaluate(()=>({details:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot()}));}
async function art(selector,name,header=false){
 const img=page.locator(selector);await expect(img).toBeVisible();await expect.poll(()=>img.evaluate(el=>el.complete&&el.naturalWidth>0),{timeout:30000}).toBe(true);
 const value=await img.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return{src:el.getAttribute('src'),alt:el.alt,hidden:el.getAttribute('aria-hidden')||el.parentElement.getAttribute('aria-hidden'),position:s.position,mask:s.maskImage,composite:s.maskComposite,pointer:s.pointerEvents,width:r.width,height:r.height};});
 assert.equal(value.alt,'');assert.equal(value.hidden,'true');assert.match(value.mask,/linear-gradient.*transparent|linear-gradient.*rgba\(0, 0, 0, 0\)/);assert.match(value.composite,/intersect/);assert.ok(value.width>value.height*2,name+' uses a wide banner');
 if(header){
  assert.equal(value.position,'absolute');
  const sizes=await img.evaluate(el=>{const parent=el.parentElement,a=parent.getBoundingClientRect().height;el.hidden=true;const b=parent.getBoundingClientRect().height;el.hidden=false;return[a,b];});assert.equal(sizes[0],sizes[1],name+' retains existing header height');
  await page.locator(selector+' ~ :is(.actions,.calculator-header-actions) button').first().click();await page.keyboard.press('Escape');
 }
 evidence.push({name,...value});await page.screenshot({path:path.join(output,name+'.png')});
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764}});page.setDefaultTimeout(60000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))csp.push(m.text());});
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});const before=await snapshot();
 await art('.home-laser-art','home');
 await page.locator('#estimate-navigation-toggle').click();await idle();await art('.workspace-header-art--estimate','estimate',true);
 for(const [name,id,kind]of [['Steel (spray)','steel_vermiculite','spray'],['Steel (board)','steel_board','board'],['Ductwork (spray/wrap)','ductwork','ductwork']]){
  await chooseCalculator(page,name);await idle();await expect(page.locator('#calculator-workspace')).toHaveAttribute('data-calculator-kind',id);
  await expect(page.locator('#calculator-workspace .workspace-header-art:visible')).toHaveCount(1);await art('.workspace-header-art--'+kind,id,true);
 }
 await chooseCalculator(page,'Firestopping');await idle();await art('.penetration-workspace-art img','firestopping');
 const order=await page.locator('.penetration-workspace-art').evaluate(el=>el.nextElementSibling.classList.contains('penetration-layout'));assert.equal(order,true,'Artwork is above the existing current-item layout');
 for(const width of [906,390]){await page.setViewportSize({width,height:764});await page.locator('nav [data-view="home"]').click();await idle();await expect(page.locator('.home-laser-art')).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await page.screenshot({path:path.join(output,'home-'+width+'.png')});}
 assert.deepEqual(await snapshot(),before,'Decorative images and navigation preserve project data');
 await page.emulateMedia({media:'print'});await expect(page.locator('.home-laser-art')).toBeHidden();await expect(page.locator('.workspace-header-art--estimate')).toHaveCSS('display','none');await page.emulateMedia({media:'screen'});
 assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS workspace artwork: '+output);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors,csp},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
