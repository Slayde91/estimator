// Decorative banners retain real controls, existing header heights and drafts.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chooseCalculator}=require('./calculator_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`workspace-art-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const evidence=[],errors=[],csp=[],assetEvidence=[];
const assetContract={
 '/header-steel-spray.png':{sha256:'cb193551522f9a366d1ebcf548b1a34c98c63941816eeefec10484598eaaa07f',natural:[1536,1024]},
 '/header-steel-board.png':{sha256:'c033e82dda0f1f82071eb600019423cb74dc562702abaaff9b50d09b32928bef',natural:[2172,724]},
 '/header-ductwork.png':{sha256:'3858a2d0997569021153c717f0cd74c57cf7b195ef838dbce48966fdf36c4a28',natural:[2172,724]},
 '/header-estimate.png':{sha256:'f0924181f62ff1ac5bab85f86d645d6516752e2f028467e1bd22ed627d151303',natural:[2172,724]},
 '/home-steel-frame.png':{sha256:'c50cd4ef38af99e5cc5d74abb77a9ddadc4eb2ac3ecaa0671075b1c53ef719b6',natural:[1122,1402]},
 '/header-firestopping.png':{sha256:'31e1f70d8966af0df4e9ca99a661fea3493bd8c9e026153b69553f87781c23e2',natural:[1122,1402]},
};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;},null,{timeout:60000});}
async function snapshot(){await idle();return page.evaluate(()=>({details:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot()}));}
async function chooseEstimate(){await page.locator('#estimate-navigation-toggle').hover();const menu=page.locator('#estimate-navigation-menu');await expect(menu).toBeVisible();await menu.locator('[data-estimator-kind="estimate"]').click();await expect(menu).toBeHidden();await idle();}
async function theme(id,name){
 if(await page.locator('html').getAttribute('data-theme')===id)return;
 await page.locator('nav [data-view="settings"]').click();await idle();
 for(let i=0;i<5&&await page.locator('html').getAttribute('data-theme')!==id;i++)await page.locator('#theme-toggle').click();
 await expect(page.locator('html')).toHaveAttribute('data-theme',id);
 if(name==='estimate')await chooseEstimate();
 else await chooseCalculator(page,{'steel_vermiculite':'Steel (spray)','steel_board':'Steel (board)','ductwork':'Ductwork (spray/wrap)'}[name]);
 await idle();
}
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
 for(const themeId of firestopping?['ceasefire']:['ceasefire','midnight','ocean','forest','slate']){
 if(!firestopping)await theme(themeId,name);
 for(const width of [1384,825,390]){
  await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
  const value=await page.locator(selector).evaluate(frame=>{const image=frame.matches('img')?frame:frame.querySelector('img'),crop=frame.matches('img')?frame:frame.querySelector('.workspace-banner-crop'),heading=frame.parentElement,box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},f=box(frame),c=box(crop),b=box(image),s=getComputedStyle(image),scale=(s.objectFit==='cover'?Math.max:Math.min)(b.width/image.naturalWidth,b.height/image.naturalHeight),paint={x:b.x+(b.width-image.naturalWidth*scale)/2,y:b.y+(b.height-image.naturalHeight*scale)/2,width:image.naturalWidth*scale,height:image.naturalHeight*scale},left=Math.max(paint.x,f.x,c.x),right=Math.min(paint.x+paint.width,f.right,c.right),top=Math.max(paint.y,f.y,c.y),bottom=Math.min(paint.y+paint.height,f.bottom,c.bottom);let heightWithoutArt;const original=frame.style.getPropertyValue('display'),priority=frame.style.getPropertyPriority('display'),attribute=frame.getAttribute('style');try{frame.style.display='none';heightWithoutArt=heading.getBoundingClientRect().height;}finally{if(original)frame.style.setProperty('display',original,priority);else frame.style.removeProperty('display');if(attribute===null&&frame.style.length===0){frame.getAttribute('style');frame.removeAttribute('style');}}return{src:image.getAttribute('src'),frame:f,crop:c,image:b,paint,visiblePaint:{left,right,top,bottom,width:right-left,height:bottom-top},heading:box(heading),heightWithoutArt,title:box(heading.querySelector('h1,h2')),natural:[image.naturalWidth,image.naturalHeight],fit:s.objectFit,sourceCrop:{left:(left-paint.x)/scale,top:(top-paint.y)/scale,width:(right-left)/scale,height:(bottom-top)/scale,fraction:(right-left)*(bottom-top)/(paint.width*paint.height)},innerMask:getComputedStyle(crop).maskImage,innerComposite:getComputedStyle(crop).maskComposite,pointer:s.pointerEvents,overflow:document.documentElement.scrollWidth-innerWidth};});
  assert.deepEqual(value.natural,assetContract[value.src].natural);assert.equal(value.pointer,'none');assert.match(value.innerMask,/linear-gradient/);assert.ok(Math.abs(value.visiblePaint.left-value.crop.x)<.25&&Math.abs(value.visiblePaint.right-value.crop.right)<.25&&Math.abs(value.visiblePaint.top-value.crop.y)<.25&&Math.abs(value.visiblePaint.bottom-value.crop.bottom)<.25,'The fade frame follows all four visible painted edges');assert.equal(value.heading.height,value.heightWithoutArt,name+' artwork retains the original header height at every theme and viewport');assert.ok(value.overflow<=1);assert.ok(value.frame.x>=value.heading.x&&value.frame.right<=value.heading.right+.1&&value.frame.y>=value.heading.y&&value.frame.bottom<=value.heading.bottom+.1,'Decorative frame fits the original heading');
  if(firestopping){assert.equal(value.fit,'contain');assert.ok(value.frame.x>=value.title.right,'Firestopping art stays to the right of its heading');assert.ok(value.frame.width<value.heading.width*.4,'Firestopping art uses a compact heading column');}
  else{assert.equal(value.fit,width<=760&&name!=='steel_vermiculite'?'contain':'cover');assert.match(value.innerMask,/90deg/);assert.match(value.innerComposite,/intersect/);assert.ok(value.sourceCrop.width/value.natural[0]>.999,'The complete horizontal scene is retained');if(name==='steel_vermiculite')assert.ok(value.sourceCrop.fraction>.62&&value.sourceCrop.fraction<.63,'Spray frame keeps the full beam width and central62.5percent source height');else assert.ok(value.sourceCrop.fraction>(width<=760?.999:.65),'Wide landscapes retain at least65percent source height and the complete scene on phones');if(name!=='estimate'){const oldPaintWidth=Math.min(value.frame.width,value.heading.height*(width<=760?1122/1402:1.44));assert.ok(value.visiblePaint.width>=oldPaintWidth-.25,'Landscape paint does not shrink into the old portrait window');if(width>760)assert.ok(value.visiblePaint.width>oldPaintWidth*1.5,'The supplied artwork uses a substantially wider banner than the old portrait');value.originalPortraitPaintWidth=oldPaintWidth;}}
  if(name==='estimate'&&width<=760){const copy=await page.locator(selector).evaluate(frame=>{const heading=frame.parentElement,title=heading.querySelector('h1'),range=document.createRange();range.selectNodeContents(title);const ink=range.getBoundingClientRect(),subtitle=heading.querySelector('.subtitle').getBoundingClientRect(),r=frame.getBoundingClientRect();return{direction:getComputedStyle(heading).direction,titleInk:{left:ink.left,right:ink.right},subtitleTop:subtitle.top,art:{left:r.left,right:r.right,bottom:r.bottom}};});assert.ok(copy.direction==='rtl'?copy.art.right<=copy.titleInk.left:copy.art.left>=copy.titleInk.right,'Phone estimate artwork leaves the title ink clear');assert.ok(copy.art.bottom<=copy.subtitleTop,'Phone estimate artwork stays above the subtitle');value.mobileCopyBounds=copy;}
  evidence.push({name:name+'-framing',theme:themeId,viewport:width,...value});await page.screenshot({path:path.join(output,`${name}-framing-${themeId}-${width}.png`)});
 }
 }
 if(!firestopping)await theme('ceasefire',name);
 await page.setViewportSize({width:1384,height:764});
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764}});page.setDefaultTimeout(60000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))csp.push(m.text());});
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 for(const [route,contract]of Object.entries(assetContract)){const response=await page.request.get(new URL(route,page.url()).href);assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/image\/png/);const bytes=await response.body(),sha256=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,contract.sha256,'Served artwork exactly matches the supplied or unchanged original');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static',route.slice(1)))).digest('hex'),sha256);assetEvidence.push({route,sha256,bytes:bytes.length,natural:contract.natural});}
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});const before=await snapshot();
 await art('.home-laser-art','home');
 await chooseEstimate();await art('.workspace-header-art--estimate','estimate',true);
 await framing('.workspace-header-art--estimate','estimate');
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
 assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,assets:assetEvidence,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS workspace artwork: '+output);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors,csp},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
