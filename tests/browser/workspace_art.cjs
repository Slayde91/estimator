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
async function documentActions(toggleSelector,ids,name){
 const checks=[];
 for(const width of [1146,906,825,390]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
  const toggle=page.locator(toggleSelector);await toggle.click();
  for(const id of ids){
   const action=page.locator('#'+id);
   // Native actionability catches a menu painted behind a later sticky card.
   // The unchanged project_reports/calculator_navigation journeys exercise
   // the real download handlers and verify actual exported document bytes.
   await action.click({trial:true,timeout:5000});
   const hit=await action.evaluate(el=>{const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{reachable:!!target&&(target===el||el.contains(target)),interceptedBy:target?.tagName,x:r.x,y:r.y,width:r.width,height:r.height};});
   assert.equal(hit.reachable,true,`${name}/${id}/${width} receives pointer input above later cards and tables`);checks.push({width,id,...hit});
  }
  await toggle.press('Escape');await expect(toggle).toHaveAttribute('aria-expanded','false');
 }
 evidence.push({name:name+'-document-actions',checks});await page.setViewportSize({width:1384,height:764});
}
async function art(selector,name,header=false){
 const frame=page.locator(selector);await expect(frame).toBeVisible();await expect.poll(()=>frame.evaluate(el=>{const image=el.matches('img')?el:el.querySelector('img');return image.complete&&image.naturalWidth>0;}),{timeout:30000}).toBe(true);
 const value=await frame.evaluate(el=>{const image=el.matches('img')?el:el.querySelector('img'),s=getComputedStyle(el),r=el.getBoundingClientRect();return{src:image.getAttribute('src'),alt:image.alt,hidden:el.getAttribute('aria-hidden')||el.parentElement.getAttribute('aria-hidden'),position:s.position,mask:s.maskImage,composite:s.maskComposite,pointer:s.pointerEvents,width:r.width,height:r.height};});
 assert.equal(value.alt,'');assert.equal(value.hidden,'true');assert.match(value.mask,/linear-gradient.*transparent|linear-gradient.*rgba\(0, 0, 0, 0\)/);assert.match(value.composite,/intersect/);if(name!=='firestopping')assert.ok(value.width>value.height*2,name+' uses a wide banner');
 if(header){
  assert.equal(value.position,'absolute');
  const sizes=await frame.evaluate(el=>{const parent=el.parentElement,a=parent.getBoundingClientRect().height,original=el.style.getPropertyValue('display'),priority=el.style.getPropertyPriority('display'),attribute=el.getAttribute('style');try{el.style.display='none';if(getComputedStyle(el).display!=='none')throw Error('Artwork was not hidden');return[a,parent.getBoundingClientRect().height];}finally{if(original)el.style.setProperty('display',original,priority);else el.style.removeProperty('display');if(attribute===null&&el.style.length===0){el.getAttribute('style');el.removeAttribute('style');}}});assert.equal(sizes[0],sizes[1],name+' retains existing header height');
  if(name!=='firestopping'){await page.locator(selector+' ~ :is(.actions,.calculator-header-actions) button').first().click();await page.keyboard.press('Escape');}
 }
 evidence.push({name,...value});await page.screenshot({path:path.join(output,name+'.png')});
}
async function framing(selector,name,firestopping=false){
 for(const width of [1384,825,390]){
  await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
  const value=await page.locator(selector).evaluate(frame=>{const image=frame.querySelector('img'),crop=frame.querySelector('.workspace-banner-crop'),heading=frame.parentElement,box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},f=box(frame),c=box(crop),b=box(image),s=getComputedStyle(image),scale=Math.min(b.width/image.naturalWidth,b.height/image.naturalHeight),paint={x:b.x+(b.width-image.naturalWidth*scale)/2,y:b.y+(b.height-image.naturalHeight*scale)/2,width:image.naturalWidth*scale,height:image.naturalHeight*scale},left=Math.max(paint.x,f.x,c.x),right=Math.min(paint.x+paint.width,f.right,c.right),top=Math.max(paint.y,f.y,c.y),bottom=Math.min(paint.y+paint.height,f.bottom,c.bottom);return{frame:f,crop:c,image:b,paint,heading:box(heading),title:box(heading.querySelector('h2')),natural:[image.naturalWidth,image.naturalHeight],fit:s.objectFit,sourceCrop:{left:(left-paint.x)/scale,top:(top-paint.y)/scale,width:(right-left)/scale,height:(bottom-top)/scale,fraction:(right-left)*(bottom-top)/(paint.width*paint.height)},innerMask:getComputedStyle(crop).maskImage,pointer:s.pointerEvents,overflow:document.documentElement.scrollWidth-innerWidth};});
  assert.equal(value.fit,'contain');assert.equal(value.pointer,'none');assert.match(value.innerMask,/linear-gradient/);assert.ok(Math.abs(value.paint.x-value.crop.x)<.25&&Math.abs(value.paint.x+value.paint.width-value.crop.right)<.25,'The fade frame follows both actual painted image edges');assert.ok(value.overflow<=1);assert.ok(value.frame.x>=value.heading.x&&value.frame.right<=value.heading.right+.1&&value.frame.y>=value.heading.y&&value.frame.bottom<=value.heading.bottom+.1,'Decorative frame fits the original heading');
  if(firestopping){assert.ok(value.frame.x>=value.title.right,'Firestopping art stays to the right of its heading');assert.ok(value.frame.width<value.heading.width*.4,'Firestopping art uses a compact heading column');}
  else{const originalWidth=value.heading.width*(width<=760?.8:width<=880?.7:.6),oldScale=Math.max(originalWidth/value.natural[0],value.heading.height/value.natural[1]),oldFraction=originalWidth*value.heading.height/(value.natural[0]*value.natural[1]*oldScale*oldScale);assert.ok(value.sourceCrop.fraction>oldFraction*1.03,'More source artwork is visible than the old cover crop');value.originalCoverSourceFraction=oldFraction;}
  evidence.push({name:name+'-framing',viewport:width,...value});await page.screenshot({path:path.join(output,`${name}-framing-${width}.png`)});
 }
 await page.setViewportSize({width:1384,height:764});
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764}});page.setDefaultTimeout(60000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))csp.push(m.text());});
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});const before=await snapshot();
 await art('.home-laser-art','home');
 await page.locator('#estimate-navigation-toggle').click();await idle();await art('.workspace-header-art--estimate','estimate',true);
 await documentActions('[aria-controls="firestopping-document-actions"]',['download-full-schedule','download-full-product-summary'],'estimate');
 for(const [name,id,kind]of [['Steel (spray)','steel_vermiculite','spray'],['Steel (board)','steel_board','board'],['Ductwork (spray/wrap)','ductwork','ductwork']]){
  await chooseCalculator(page,name);await idle();await expect(page.locator('#calculator-workspace')).toHaveAttribute('data-calculator-kind',id);
  await expect(page.locator('#calculator-workspace .workspace-header-art:visible')).toHaveCount(1);await art('.workspace-header-art--'+kind,id,true);
  await framing('.workspace-header-art--'+kind,id);
  await documentActions('#calculator-document-toggle',['calculator-excel','calculator-pdf','calculator-summary-pdf','calculator-template'],id);
 }
 await chooseCalculator(page,'Firestopping');await idle();await art('.penetration-workspace-art','firestopping',true);await framing('.penetration-workspace-art','firestopping',true);
 const order=await page.locator('.penetration-workspace-art').evaluate(el=>el.parentElement.classList.contains('penetration-banner-heading')&&!document.querySelector('#penetration-workspace .penetration-workspace-art'));assert.equal(order,true,'Artwork is in the heading row before the existing current-item layout');
 for(const width of [906,390]){await page.setViewportSize({width,height:764});await page.locator('nav [data-view="home"]').click();await idle();await expect(page.locator('.home-laser-art')).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await page.screenshot({path:path.join(output,'home-'+width+'.png')});}
 assert.deepEqual(await snapshot(),before,'Decorative images and navigation preserve project data');
 await page.emulateMedia({media:'print'});await expect(page.locator('.home-laser-art')).toBeHidden();await expect(page.locator('.workspace-header-art--estimate')).toHaveCSS('display','none');await page.emulateMedia({media:'screen'});
 assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS workspace artwork: '+output);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors,csp},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
