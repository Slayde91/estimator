// Decorative banners retain real controls, responsive flow and project drafts.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseTakeoff,chooseLibrary}=require('./section_navigation.cjs');
const followupRtlOnly=process.argv.includes('--rtl-header-followups-only');
const followupsOnly=followupRtlOnly||process.argv.includes('--header-followups-only');
const takeoffWidthOnly=process.argv.includes('--takeoff-width-only');
const rtlCalculatorMenusOnly=process.argv.includes('--rtl-calculator-menus-only');
const calculatorBannersOnly=process.argv.includes('--calculator-banners-only')||rtlCalculatorMenusOnly;
const runMode=takeoffWidthOnly?'takeoff-width-only':rtlCalculatorMenusOnly?'rtl-calculator-menus-only':calculatorBannersOnly?'calculator-banners-only':'complete-artwork';
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`workspace-art-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const evidence=[],errors=[],csp=[],assetEvidence=[];
const assetContract={
 '/projects-evidence-banner.png':{sha256:'abd1489d1a25aa81c19e03d881a0b0e5812b25e9eaee6f8e32f049a31c3cbdff',natural:[2172, 724]},
 '/header-projects.png':{sha256:'1a04d966cd48b61d77f28548344ca153d4f864f7c506dbe672dc2aa28fced31a',natural:[1254, 1254]},
 '/takeoff-header-service-plans.png':{sha256:'7e2c1c1a554201852151c27bc030624b9d7e63722c15c260d9f0f218ca6fbfea',natural:[2172,724]},
 '/header-steel-spray.png':{sha256:'291c15eb430d5fa3dfad5b05b1aacb3f0c49da30a841189fe3d7203afc7707a3',natural:[1254,1254]},
 '/header-steel-intumescent.png':{sha256:'c157e493d65964cda91344e4fb47c3eb628963fb4a0e475b97059aa9a056e164',natural:[1536,1024]},
 '/header-steel-board.png':{sha256:'c033e82dda0f1f82071eb600019423cb74dc562702abaaff9b50d09b32928bef',natural:[2172,724]},
 '/header-ductwork.png':{sha256:'3858a2d0997569021153c717f0cd74c57cf7b195ef838dbce48966fdf36c4a28',natural:[2172,724]},
 '/header-estimate.png':{sha256:'f0924181f62ff1ac5bab85f86d645d6516752e2f028467e1bd22ed627d151303',natural:[2172,724]},
 '/home-steel-frame.png':{sha256:'c50cd4ef38af99e5cc5d74abb77a9ddadc4eb2ac3ecaa0671075b1c53ef719b6',natural:[1122,1402]},
 '/header-firestopping.png':{sha256:'31e1f70d8966af0df4e9ca99a661fea3493bd8c9e026153b69553f87781c23e2',natural:[1122,1402]},
 '/takeoff-header-steel.png':{sha256:'6d484b95a0ecfcfb83b73dcd2f89d41cffe75516e7108840389e9d4ccaaf0577',natural:[2172,724]},
 '/takeoff-header-ductwork.png':{sha256:'9644a3ccad3749bfa595433cbe8366c9123005b748b4e8415b18d8692fb6cc42',natural:[1122,1402]},
 '/takeoff-header-physical.png':{sha256:'331ec375a7fafcfb1093934903a160d64b5566774a76b5a2f6d596979e7ef7c7',natural:[1054,1492]},
};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;},null,{timeout:60000});}
async function takeoffIdle(){await idle();await expect(page.locator('#takeoff-navigation-menu [data-mode]:disabled')).toHaveCount(0);}
async function snapshot(){await idle();return page.evaluate(()=>({details:window.CeasefireProject.details(),configuration:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),takeoffs:window.CeasefireTakeoffs.projectSnapshot()}));}
async function chooseEstimate(){await page.locator('#estimate-navigation-toggle').hover();const menu=page.locator('#estimate-navigation-menu');await expect(menu).toBeVisible();await menu.locator('[data-estimator-kind="estimate"]').click();await expect(menu).toBeHidden();await idle();}
async function translatedTakeoff(name){
 await page.locator('#takeoff-navigation-toggle').hover();const physical=['Defect Reports','Service Plans'].includes(name);if(physical)await page.locator('#penetration-navigation-toggle').hover();
 const choice=page.locator('#takeoff-navigation-menu '+(physical?`[data-physical-scope="${name==='Service Plans'?'service_plans':'defect_reports'}"]`:`[data-mode="${name==='Steel'?'steel':'duct'}"]`));
 await choice.click();await expect(choice).toHaveAttribute('aria-pressed','true');await page.mouse.move(0,0);await expect(page.locator('#takeoff-navigation-menu')).toBeHidden();await takeoffIdle();
}
async function translatedCalculator(id){
 await page.locator('#calculator-navigation-toggle').hover();const menu=page.locator('#calculator-navigation-menu');await expect(menu).toBeVisible();const steel=["steel_vermiculite","steel_intumescent","steel_board"].includes(id);if(steel)await page.locator('#steel-calculator-navigation-toggle').click();const choice=menu.locator(`[data-calculator-id="${id}"]`);await choice.click();await expect(choice).toHaveAttribute('aria-pressed','true');await page.mouse.move(0,0);await expect(menu).toBeHidden();await idle();
}
async function theme(id,name){
 if(await page.locator('html').getAttribute('data-theme')===id)return;
 await page.locator('nav [data-view="settings"]').click();await idle();
 for(let i=0;i<5&&await page.locator('html').getAttribute('data-theme')!==id;i++)await page.locator('#theme-toggle').click();
 await expect(page.locator('html')).toHaveAttribute('data-theme',id);
 if(name==='estimate')await chooseEstimate();
 else if(name==='firestopping')await chooseCalculator(page,'Firestopping');
 else if(name.startsWith('takeoff:'))await translatedTakeoff(name.slice(8));
 else await translatedCalculator(name);
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
 assert.equal(value.alt,'');assert.equal(value.hidden,'true');assert.match(value.mask,/linear-gradient.*transparent|linear-gradient.*rgba\(0, 0, 0, 0\)/);assert.match(value.composite,/intersect/);if(!['firestopping','steel_vermiculite','steel_board','ductwork'].includes(name))assert.ok(value.width>value.height*2,name+' uses a wide banner');
 if(header){
  assert.equal(value.position,'absolute');
  const sizes=await frame.evaluate(el=>{const parent=el.closest('.workspace-banner-heading,.penetration-banner-heading')||el.parentElement,a=parent.getBoundingClientRect().height,original=el.style.getPropertyValue('display'),priority=el.style.getPropertyPriority('display'),attribute=el.getAttribute('style');try{el.style.display='none';if(getComputedStyle(el).display!=='none')throw Error('Artwork was not hidden');return[a,parent.getBoundingClientRect().height];}finally{if(original)el.style.setProperty('display',original,priority);else el.style.removeProperty('display');if(attribute===null&&el.style.length===0){el.getAttribute('style');el.removeAttribute('style');}}});assert.equal(sizes[0],sizes[1],name+' retains existing header height');
  if(name!=='firestopping'){await page.locator('.workspace-banner-heading:visible :is(.actions,.calculator-header-actions) button').first().click();await page.keyboard.press('Escape');}
 }
 evidence.push({name,...value});await page.screenshot({path:path.join(output,name+'.png')});
}
async function framing(selector,name,firestopping=false){
 for(const themeId of ['ceasefire','midnight','ocean','forest','slate']){
 await theme(themeId,name);
 for(const width of [1384,825,390]){
  await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
  const value=await page.locator(selector).evaluate(frame=>{const image=frame.matches('img')?frame:frame.querySelector('img'),crop=frame.matches('img')?frame:frame.querySelector('.workspace-banner-crop'),heading=frame.closest(".workspace-banner-heading,.penetration-banner-heading"),box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},f=box(frame),c=box(crop),b=box(image),s=getComputedStyle(image),scale=(s.objectFit==='cover'?Math.max:Math.min)(b.width/image.naturalWidth,b.height/image.naturalHeight),position=s.objectPosition.split(' ').map(v=>parseFloat(v)/100),paint={x:b.x+(b.width-image.naturalWidth*scale)*position[0],y:b.y+(b.height-image.naturalHeight*scale)*position[1],width:image.naturalWidth*scale,height:image.naturalHeight*scale},left=Math.max(paint.x,f.x,c.x),right=Math.min(paint.x+paint.width,f.right,c.right),top=Math.max(paint.y,f.y,c.y),bottom=Math.min(paint.y+paint.height,f.bottom,c.bottom);let heightWithoutArt;const original=frame.style.getPropertyValue('display'),priority=frame.style.getPropertyPriority('display'),attribute=frame.getAttribute('style');try{frame.style.display='none';heightWithoutArt=heading.getBoundingClientRect().height;}finally{if(original)frame.style.setProperty('display',original,priority);else frame.style.removeProperty('display');if(attribute===null&&frame.style.length===0){frame.getAttribute('style');frame.removeAttribute('style');}}return{src:image.getAttribute('src'),frame:f,crop:c,image:b,paint,visiblePaint:{left,right,top,bottom,width:right-left,height:bottom-top},heading:box(heading),heightWithoutArt,title:box(heading.querySelector('h1,h2')),natural:[image.naturalWidth,image.naturalHeight],fit:s.objectFit,sourceCrop:{left:(left-paint.x)/scale,top:(top-paint.y)/scale,width:(right-left)/scale,height:(bottom-top)/scale,fraction:(right-left)*(bottom-top)/(paint.width*paint.height)},innerMask:getComputedStyle(crop).maskImage,innerComposite:getComputedStyle(crop).maskComposite,pointer:s.pointerEvents,overflow:document.documentElement.scrollWidth-innerWidth};});
  assert.deepEqual(value.natural,assetContract[value.src].natural);assert.equal(value.pointer,'none');assert.match(value.innerMask,/linear-gradient/);assert.ok(Math.abs(value.visiblePaint.left-value.crop.x)<.25&&Math.abs(value.visiblePaint.right-value.crop.right)<.25&&Math.abs(value.visiblePaint.top-value.crop.y)<.25&&Math.abs(value.visiblePaint.bottom-value.crop.bottom)<.25,'The fade frame follows all four visible painted edges');assert.equal(value.heading.height,value.heightWithoutArt,name+' artwork retains the original header height at every theme and viewport');assert.ok(value.overflow<=1);assert.ok(value.frame.x>=value.heading.x&&value.frame.right<=value.heading.right+.1&&value.frame.y>=value.heading.y&&value.frame.bottom<=value.heading.bottom+.1,'Decorative frame fits the original heading: '+JSON.stringify(value));
  if(firestopping){const adjacent=await page.locator(selector).evaluate(el=>{const heading=el.closest('.penetration-banner-heading'),slot=heading.querySelector('.calculator-heading-art-slot').getBoundingClientRect(),bolt=heading.querySelector('.calculator-heading-lightning'),art=el.getBoundingClientRect();return{gap:getComputedStyle(heading).direction==='rtl'?slot.right-art.right:art.left-slot.left,boltDisplay:getComputedStyle(bolt).display};});assert.equal(adjacent.boltDisplay,'none');assert.ok(Math.abs(adjacent.gap-18)<.1,'Firestopping art has one compact gap after the copy');assert.equal(value.fit,'cover');assert.ok(value.frame.width<=210.1,'Firestopping art stays compact beside the heading');}
  evidence.push({name:name+'-framing',theme:themeId,viewport:width,...value});await page.screenshot({path:path.join(output,`${name}-framing-${themeId}-${width}.png`)});
 }
 }
 if(!firestopping)await theme('ceasefire',name);
 await page.setViewportSize({width:1384,height:764});
}
async function followupBanners(themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,1020,825,390]){
 for(const themeId of themes){
  await theme(themeId,'estimate');await chooseEstimate();
  for(const workspace of ['estimate','projects','technical','penetration','pricing']){
   if(workspace==='projects'){await page.locator('nav [data-view="projects"]').click();if(await page.locator('#view-projects').isVisible())await page.locator('#view-projects [data-project-section="quotes"]').click();await idle();}
   else if(['technical','penetration','pricing'].includes(workspace)){await chooseLibrary(page,workspace);await idle();}
   const heading=page.locator(workspace==='estimate'?'.estimate-banner-heading':workspace==='projects'?'.project-banner-heading':`#library-${workspace} > .page-heading`);
   for(const width of widths){
    await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
    const data=await heading.evaluate(el=>{
     const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};},title=el.querySelector('h1,h2'),frame=el.querySelector('.workspace-header-art--estimate,.project-evidence-crop,.library-heading-art-slot img'),image=frame&&(frame.matches('img')?frame:frame.querySelector('img'));
     return{heading:box(el),title:box(title),font:getComputedStyle(title).fontSize,art:frame?box(frame):null,src:image?.getAttribute('src'),loaded:!image||image.complete&&image.naturalWidth>0,direction:getComputedStyle(el).direction,subtitle:el.querySelectorAll('.subtitle').length,overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.equal(data.loaded,true);assert.equal(data.subtitle,0);assert.ok(data.overflow<=1,JSON.stringify(data));
    if(workspace==='pricing')assert.equal(data.font,'28px');
    else{assert.ok(data.art.width>0&&data.art.height>0);assert.ok(data.direction==='rtl'?data.art.right<=data.title.x:data.art.x>=data.title.right,'Artwork follows the heading without overlap: '+JSON.stringify(data));assert.ok(data.art.x>=data.heading.x&&data.art.right<=data.heading.right+.1);}
    if(workspace==='technical'){assert.ok(data.art.width<=188.6&&data.art.height<=80.1,'Technical artwork fits 188.5 by 80');}if(workspace==='penetration'){assert.ok(data.art.width<=314.1&&data.art.height<=84.1,'Firestopping Library artwork fits 314 by 84');}
    if(workspace==='estimate'){const toggle=heading.locator('[data-document-menu-toggle]');await toggle.click({trial:true});}
    if(workspace==='projects'){
     for(const id of ['new-quote','load-project','link-project-folder','refresh-quotes'])await page.locator('#'+id).click({trial:true});
     const banner=await page.locator('.project-evidence-art').evaluate(el=>{const frame=el.querySelector('.project-evidence-crop'),image=el.querySelector('img'),r=el.getBoundingClientRect(),heading=el.closest('.project-banner-heading'),crop=frame.getBoundingClientRect(),height=heading.getBoundingClientRect().height,slot=el.parentElement;slot.style.display='none';const withoutArt=heading.getBoundingClientRect().height;slot.style.removeProperty('display');return{inside:crop.left>=r.left-.1&&crop.right<=r.right+.1,height,withoutArt,withinHeading:r.top>=heading.getBoundingClientRect().top-.1&&r.bottom<=heading.getBoundingClientRect().bottom+.1,src:image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0,mask:getComputedStyle(frame).maskImage,composite:getComputedStyle(frame).maskComposite,pointer:getComputedStyle(el).pointerEvents};});
     await expect(page.locator('#view-quotes img[src="/header-projects.png"]')).toHaveCount(0);await expect(page.locator('#view-quotes > .project-evidence-art')).toHaveCount(0);assert.equal(banner.src,'/projects-evidence-banner.png');assert.equal(banner.inside,true);assert.equal(banner.withinHeading,true);assert.equal(banner.height,banner.withoutArt,'Artwork does not stretch the heading row');assert.equal(banner.loaded,true);assert.match(banner.mask,/90deg/);assert.match(banner.composite,/intersect/);assert.equal(banner.pointer,'none');data.banner=banner;
    }
    evidence.push({name:'header-followup',workspace,theme:themeId,viewport:width,...data});await page.screenshot({path:path.join(output,`followup-${workspace}-${themeId}-${width}.png`)});
   }
  }
 }
 await page.locator('nav [data-view="projects"]').click();if(await page.locator('#view-projects').isVisible())await page.locator('#view-projects [data-project-section="quotes"]').click();await idle();await page.emulateMedia({media:'print'});await expect(page.locator('.project-evidence-art')).toBeHidden();await expect(page.locator('.project-heading-art-slot')).toBeHidden();await page.emulateMedia({media:'screen'});
 await theme('ceasefire','estimate');await page.setViewportSize({width:1384,height:764});
}
async function calculatorFraming(kind,name,themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,1146,825,390]){
 const heading=page.locator('.calculator-workspace-heading');
 for(const themeId of themes){
  await theme(themeId,name);
  for(const width of widths){
   await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
   const toggle=page.locator('#calculator-document-toggle');await toggle.click({trial:true});
   await expect(heading.locator('.calculator-heading-lightning')).toBeHidden();
   if(kind==='intumescent'&&width<=480){
    await expect(heading.locator('.workspace-header-art--intumescent')).toBeHidden();
    await toggle.click();const menu=page.locator('#calculator-document-menu');await expect(menu).toBeVisible();await menu.locator('button:visible').first().click({trial:true});await toggle.press('Escape');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth<=1),'Phone title and controls stay within the viewport');
    evidence.push({name:name+'-adjacent-framing',theme:themeId,viewport:width,decorativeArtHiddenForNarrowTitle:true,documentMenuReachable:true});await page.screenshot({path:path.join(output,`${name}-adjacent-${themeId}-phone-${width}.png`)});continue;
   }
   const value=await heading.evaluate(el=>{
    const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const copy=el.querySelector('.calculator-heading-copy'),text=el.querySelector('.calculator-heading-text'),slot=el.querySelector('.calculator-heading-art-slot'),bolt=slot.querySelector('svg'),frames=[...slot.querySelectorAll('.workspace-header-art')],frame=frames.find(n=>getComputedStyle(n).display!=='none'),img=frame.querySelector('img'),actions=el.querySelector('.calculator-header-actions'),title=el.querySelector('h2');
    const framing=()=>{const crop=frame.querySelector('.workspace-banner-crop'),f=box(frame),c=box(crop),b=box(img),s=getComputedStyle(img),scale=(s.objectFit==='cover'?Math.max:Math.min)(b.width/img.naturalWidth,b.height/img.naturalHeight),position=s.objectPosition.split(' ').map(v=>parseFloat(v)/100),paint={x:b.x+(b.width-img.naturalWidth*scale)*position[0],y:b.y+(b.height-img.naturalHeight*scale)*position[1],width:img.naturalWidth*scale,height:img.naturalHeight*scale},left=Math.max(paint.x,f.x,c.x),right=Math.min(paint.x+paint.width,f.right,c.right),top=Math.max(paint.y,f.y,c.y),bottom=Math.min(paint.y+paint.height,f.bottom,c.bottom);return{frame:f,crop:c,image:b,paint,scale,fit:s.objectFit,sourceCrop:{left:(left-paint.x)/scale,top:(top-paint.y)/scale,width:(right-left)/scale,height:(bottom-top)/scale,fraction:(right-left)*(bottom-top)/(paint.width*paint.height)},visiblePaint:{left,right,top,bottom,width:right-left,height:bottom-top}};};
    const geometry=()=>({heading:box(el),copy:box(text),title:box(title),actions:box(actions)}),layout=()=>({workspace:box(el.parentElement),pages:box(document.querySelector('#calculator-pages')),main:box(document.querySelector('main')),scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth});
    const html=el.outerHTML,actual=geometry(),actualLayout=layout(),art=framing(),copyStyle=copy.getAttribute('style'),textClass=text.getAttribute('class');let baseline;
    // Recover the shipped direct-child text/art/actions flow using the same
    // source nodes. Absolute artwork never contributed to the original height.
    try{copy.before(text);text.removeAttribute('class');for(const f of frames)actions.before(f);copy.style.setProperty('display','none','important');baseline={geometry:geometry(),layout:layout(),art:framing()};}
    finally{copy.insertBefore(text,slot);if(textClass===null)text.removeAttribute('class');else text.setAttribute('class',textClass);for(const f of frames)slot.append(f);if(copyStyle===null){copy.getAttribute('style');copy.removeAttribute('style');}else copy.setAttribute('style',copyStyle);}
    const css=getComputedStyle(frame),imageCSS=getComputedStyle(img),r=toggle=>{const b=toggle.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return!!hit&&(hit===toggle||toggle.contains(hit));};
    return{actual,actualLayout,baseline,...art,slot:box(slot),bolt:{...box(bolt),display:getComputedStyle(bolt).display,hidden:bolt.getAttribute('aria-hidden'),focusable:bolt.getAttribute('focusable')},src:img.getAttribute('src'),natural:[img.naturalWidth,img.naturalHeight],alt:img.alt,hidden:slot.getAttribute('aria-hidden'),pointer:css.pointerEvents,imagePointer:imageCSS.pointerEvents,mask:css.maskImage,composite:css.maskComposite,position:css.position,aspect:css.aspectRatio,direction:getComputedStyle(el).direction,restored:html===el.outerHTML,documentHit:r(el.querySelector('#calculator-document-toggle')),overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.equal(value.src,'/header-'+(kind==='spray'?'steel-spray':kind==='board'?'steel-board':kind==='intumescent'?'steel-intumescent':'ductwork')+'.png');assert.deepEqual(value.natural,assetContract[value.src].natural);assert.equal(value.alt,'');assert.equal(value.hidden,'true');assert.equal(value.pointer,'none');assert.equal(value.imagePointer,'none');assert.equal(value.position,'absolute');assert.match(value.mask,/linear-gradient/);assert.match(value.composite,/intersect/);assert.equal(value.fit,'cover');assert.equal(value.restored,true,'The shipped layout probe restores exact source nodes and inline markup');
   for(const part of ['heading','copy','title','actions'])for(const axis of ['x','y','width','height'])assert.ok(Math.abs(value.actual[part][axis]-value.baseline.geometry[part][axis])<.1,`${name}/${themeId}/${width} preserves original ${part}.${axis}: ${JSON.stringify(value)}`);
   assert.deepEqual(value.actualLayout,value.baseline.layout,'Moving artwork preserves the calculator, worksheet and full page flow');
   assert.equal(value.documentHit,true,'The real Document toggle receives native pointer input');assert.ok(value.overflow<=1);
   assert.equal(value.bolt.display,'none');assert.equal(value.bolt.width,0);assert.equal(value.bolt.height,0);assert.equal(value.bolt.hidden,'true');assert.equal(value.bolt.focusable,'false');
   assert.ok(Math.abs((value.direction==='rtl'?value.slot.right-value.frame.right:value.frame.x-value.slot.x)-18)<.1,'Artwork follows the title with one compact gap and no reserved lightning space');
   assert.ok(value.frame.width>0&&value.frame.height>0&&value.frame.x>=value.actual.heading.x&&value.frame.right<=value.actual.heading.right+.1&&value.frame.y>=value.actual.heading.y-.1&&value.frame.bottom<=value.actual.heading.bottom+.1,'The art stays inside the original heading');
   if(value.actual.actions.y<value.actual.title.bottom)assert.ok(value.direction==='rtl'?value.frame.x>=value.actual.actions.right:value.frame.right<=value.actual.actions.x,'The image leaves same-row controls clear');else assert.ok(value.frame.bottom<=value.actual.actions.y+.1,'Phone artwork stays above the original controls');
   assert.ok(Math.abs(value.visiblePaint.left-value.crop.x)<.25&&Math.abs(value.visiblePaint.right-value.crop.right)<.25&&Math.abs(value.visiblePaint.top-value.crop.y)<.25&&Math.abs(value.visiblePaint.bottom-value.crop.bottom)<.25,'The four-edge mask follows the actual clipped scene');
   if(kind==='spray'){assert.ok(value.sourceCrop.fraction>=.625-.001,'The square spray scene retains at least62.5percent of its source');assert.ok(value.sourceCrop.top<=400&&value.sourceCrop.top+value.sourceCrop.height>=1100,'Both beam flanges remain visible');}
   else if(kind==='intumescent'){assert.ok(value.sourceCrop.left>=-.25&&value.sourceCrop.left+value.sourceCrop.width<=value.natural[0]+.25,'New supplied scene stays within its source bounds');if(width>=1384)assert.ok(value.sourceCrop.fraction>.45,'Wide header retains the steel frame and its surroundings');}
   else{assert.ok(value.sourceCrop.left>=value.natural[0]*.399&&Math.abs(value.sourceCrop.left+value.sourceCrop.width-value.natural[0])<.25,'Only the useful right scene is retained after trimming at least40percent empty left canvas');if(width>760&&value.frame.width>=value.frame.height*2.7-.1)assert.ok(Math.abs(value.scale-value.baseline.art.scale)<.001,'Unconstrained cropping preserves the shipped useful-scene scale');}
   // Open the real disclosure in every theme/width, including RTL, and hit-test
   // its first native action above the artwork and later sticky worksheet cells.
   await toggle.click();const menu=page.locator('#calculator-document-menu');await expect(menu).toBeVisible();const first=menu.locator('button:visible').first();await first.click({trial:true});const menuHit=await first.evaluate(n=>{const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};},r=box(n),point={x:r.x+r.width/2,y:r.y+r.height/2},hit=document.elementFromPoint(point.x,point.y);return{reachable:!!hit&&(hit===n||n.contains(hit)),connected:n.isConnected,point,action:r,menu:box(n.closest('.calculator-document-actions')),workspace:box(n.closest('#calculator-workspace')),viewport:{width:innerWidth,clientWidth:document.documentElement.clientWidth,height:innerHeight},hit:hit?{tag:hit.tagName,id:hit.id,class:String(hit.className)}:null};});
   const diagnostic=JSON.stringify({name,theme:themeId,width,direction:value.direction,...menuHit});
   assert.ok(menuHit.menu.x>=menuHit.workspace.x-.1&&menuHit.menu.right<=menuHit.workspace.right+.1&&menuHit.menu.x>=0&&menuHit.menu.right<=menuHit.viewport.clientWidth+.1,'The complete native Document menu fits horizontally without card/viewport clipping: '+diagnostic);
   assert.equal(menuHit.reachable,true,'Native pointer reaches the actual action centre: '+diagnostic);await toggle.press('Escape');await expect(menu).toBeHidden();
   evidence.push({name:name+'-adjacent-framing',theme:themeId,viewport:width,...value,menuReachable:menuHit.reachable,menuHit});await page.screenshot({path:path.join(output,`${name}-adjacent-${themeId}-${value.direction}-${width}.png`)});
  }
 }
 await page.emulateMedia({media:'print'});await expect(heading.locator('.calculator-heading-art-slot')).toBeHidden();await page.emulateMedia({media:'screen'});await page.setViewportSize({width:1384,height:764});
}
async function takeoffHeading(name,route,themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,825,390]){
 const heading=page.locator('.takeoff-workspace-heading');
 for(const themeId of themes){
  await theme(themeId,'takeoff:'+name);
  for(const width of widths){
   await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
   await expect(heading.locator('.takeoff-heading-art:visible')).toHaveCount(1);
   const frame=heading.locator('.takeoff-heading-art:visible');
   await expect.poll(()=>frame.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
   const value=await heading.evaluate(el=>{
    const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const copy=el.querySelector('.takeoff-heading-copy'),title=el.querySelector('h1'),slot=el.querySelector('.takeoff-heading-art-slot'),actions=el.querySelector('.takeoff-document-tools'),frame=[...slot.children].find(n=>getComputedStyle(n).display!=='none'),img=frame.querySelector('img');
    // Layout can materialise an empty style attribute in Blink. It carries no
    // CSS; compare every real attribute, node and style value without treating
    // that serialization detail as a change to the restored heading.
    const markup=()=>el.outerHTML.replace(/ style=""/g,'');
    const restoreStyle=(node,value)=>{node.style.cssText=value||'';if(value===null){node.getAttribute('style');node.removeAttribute('style');}};
    const layout=()=>({workspace:box(el.parentElement),drawing:box(el.parentElement.querySelector('.takeoff-drawing-layout')),viewport:box(el.parentElement.querySelector('.takeoff-viewport')),toolbar:box(el.parentElement.querySelector('.takeoff-viewer-top')),main:box(document.querySelector('main')),scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth});
    const actual={heading:box(el),title:box(title),actions:box(actions)},actualLayout=layout(),html=markup(),actionStyle=actions.getAttribute('style'),copyStyle=copy.getAttribute('style'),titleNextSibling=title.nextSibling,frameStyle=frame.getAttribute('style');let baseline,previousArt;
    // The previously shipped artwork was exactly the copy row's height and
    // centred vertically. Probe those original CSS values on the same source
    // nodes without changing page flow, then restore their exact inline state.
    try{frame.style.setProperty('height','100%','important');frame.style.setProperty('inset-block','50% auto','important');previousArt={frame:box(frame),paint:box(img),layout:layout()};}
    finally{restoreStyle(frame,frameStyle);}
    // Restore the exact pre-art title/actions flow temporarily, then put the
    // original nodes and inline styles back. This measures the old contract,
    // rather than treating the new wrapper's layout as the baseline.
    // The old stylesheet used a physical left auto margin in both directions.
    // Keep that original rule in the baseline; the new logical-end RTL position
    // is checked separately rather than disguised as unchanged geometry.
    try{copy.before(title);copy.style.setProperty('display','none','important');actions.style.setProperty('margin','0 0 0 auto','important');baseline={heading:box(el),title:box(title),actions:box(actions)};}
    finally{copy.insertBefore(title,titleNextSibling);restoreStyle(actions,actionStyle);restoreStyle(copy,copyStyle);}
    const css=getComputedStyle(frame),imageCSS=getComputedStyle(img);
    const f=box(frame),paint=box(img),scale=paint.width/img.naturalWidth,left=Math.max(f.x,paint.x),right=Math.min(f.right,paint.right),top=Math.max(f.y,paint.y),bottom=Math.min(f.bottom,paint.bottom);
    const restoredHTML=markup();let markupDifference=null;
    if(html!==restoredHTML){let index=0;while(html[index]===restoredHTML[index]&&index<html.length)index++;markupDifference={index,before:html.slice(Math.max(0,index-80),index+220),after:restoredHTML.slice(Math.max(0,index-80),index+220)};}
    return{mode:el.dataset.takeoffMode,actual,actualLayout,previousArt,baseline,restored:html===restoredHTML&&title.parentElement===copy&&title.nextSibling===titleNextSibling,markupDifference,frame:f,slot:box(slot),src:img.getAttribute('src'),natural:[img.naturalWidth,img.naturalHeight],paint,sourceCrop:{left:(left-paint.x)/scale,top:(top-paint.y)/scale,width:(right-left)/scale,height:(bottom-top)/scale},alt:img.alt,hidden:slot.getAttribute('aria-hidden'),imageHidden:img.getAttribute('aria-hidden'),pointer:css.pointerEvents,imagePointer:imageCSS.pointerEvents,mask:css.maskImage,imageMask:imageCSS.maskImage,composite:css.maskComposite,position:css.position,objectPosition:imageCSS.objectPosition,direction:getComputedStyle(el).direction,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.equal(value.src,route);assert.deepEqual(value.natural,assetContract[route].natural);assert.equal(value.alt,'');assert.equal(value.hidden,'true');assert.equal(value.imageHidden,'true');assert.equal(value.pointer,'none');assert.equal(value.imagePointer,'none');assert.equal(value.position,'absolute');assert.match(value.mask,/linear-gradient/);assert.match(value.composite,/intersect/);assert.equal(value.restored,true,'Baseline probe restores the original nodes and exact inline markup: '+JSON.stringify({name,themeId,width,difference:value.markupDifference}));
   for(const part of ['heading','title','actions'])for(const axis of ['x','y','width','height'])if(!(value.direction==='rtl'&&part==='actions'&&axis==='x'))assert.ok(Math.abs(value.actual[part][axis]-value.baseline[part][axis])<.1,`${name}/${themeId}/${width} retains pre-art ${part}.${axis}: ${JSON.stringify(value)}`);
   if(value.direction==='rtl'){assert.ok(Math.abs(value.actual.actions.x-value.actual.heading.x)<.1,'RTL controls mirror to the logical end of the original row');value.rtlActionEndPlacement={originalPhysicalMarginX:value.baseline.actions.x,actualLogicalMarginX:value.actual.actions.x,intentional:true};}
   assert.deepEqual(value.actualLayout,value.previousArt.layout,'Wider art preserves workspace, drawing, canvas, toolbar and overall page geometry');
   const extraHeight=width<=570?40:48;
   assert.ok(Math.abs(value.frame.height-value.previousArt.frame.height-extraHeight)<.1,'Art borrows only existing vertical whitespace: '+JSON.stringify(value));
   assert.ok(Math.abs((value.frame.y+value.frame.height/2)-(value.previousArt.frame.y+value.previousArt.frame.height/2)+4)<.1,'The larger frame is centred four pixels above the original frame');
   assert.ok(value.frame.width>=value.previousArt.frame.width-.1,'Every Takeoffs image is at least as wide as the shipped framing');
   const availableArtWidth=Math.max(0,value.slot.width-8);
   if(width>570){const expectedWidth=Math.min(value.previousArt.frame.width*2,availableArtWidth);assert.ok(Math.abs(value.frame.width-expectedWidth)<.1,'Tablet/desktop artwork doubles its original width up to the available slot: '+JSON.stringify({name,themeId,width,actual:value.frame.width,expected:expectedWidth,availableArtWidth}));}
   assert.ok(value.direction==='rtl'?value.frame.right<=value.slot.right-7.9&&value.frame.x>=value.slot.x-.1:value.frame.x>=value.slot.x+7.9&&value.frame.right<=value.slot.right+.1,'Artwork retains its 8px logical inset inside the available slot: '+JSON.stringify(value));
   assert.ok(Math.abs(value.direction==='rtl'?value.actual.heading.right-value.actualLayout.viewport.right:value.actual.heading.x-value.actualLayout.viewport.x)<.1,'Heading remains aligned with the PDF viewport edge: '+JSON.stringify(value));
   assert.ok(value.frame.width>0&&value.frame.height>0&&value.frame.x>=value.slot.x-16.1&&value.frame.right<=value.slot.right+16.1&&value.frame.y>=value.actualLayout.main.y&&value.frame.bottom<=value.actualLayout.drawing.y+.1,'Image uses existing whitespace without entering the app header or drawing workspace');
   assert.ok(value.direction==='rtl'?value.frame.right<=value.actual.title.x+.1:value.frame.x>=value.actual.title.right-.1,'Artwork is beside the actual heading text');assert.ok(value.overflow<=1);
   if(value.actual.actions.y<value.actual.title.bottom)assert.ok(value.direction==='rtl'?value.frame.x>=value.actual.actions.right-.1:value.frame.right<=value.actual.actions.x+.1,'Artwork leaves the original controls clear on their shared row');
   else assert.ok(value.frame.bottom<=value.actual.actions.y+.1,'Wrapped phone art stays above the original controls');
   assert.match(value.imageMask,/linear-gradient/);assert.ok(Math.abs(value.paint.height-value.paint.width*value.natural[1]/value.natural[0])<.02,'Original pixels keep their natural aspect ratio within one layout subpixel: '+JSON.stringify(value));
   if(name==='Service Plans'){assert.ok(value.sourceCrop.width>=value.natural[0]-.5&&value.sourceCrop.height>=value.natural[1]-.5,'Service Plans retains the complete supplied landscape scene');}
   else if(name==='Steel'){assert.ok(value.sourceCrop.height>=723&&value.sourceCrop.left<=1000&&value.sourceCrop.left+value.sourceCrop.width>=2171,'The steel scene keeps its full height and the complete maquette after trimming empty left canvas');}
   else{assert.ok(value.sourceCrop.width>=value.natural[0]-.5&&value.sourceCrop.top<=560&&value.sourceCrop.top+value.sourceCrop.height>=1250,'Portrait framing keeps the complete object width and the recognizable lower scene, rather than a thin cover slice');}
   const menuChecks=[];
   for(const toggle of await heading.locator('.calculator-document-toggle:visible').all()){
    const label=(await toggle.textContent()).trim();await toggle.click();const list=page.locator('#'+await toggle.getAttribute('aria-controls'));await expect(list).toBeVisible();const items=list.locator('button:visible:not(:disabled)');assert.ok(await items.count()>0,'Native Takeoffs disclosure retains available actions');
    const item=items.first();await item.click({trial:true,timeout:5000});const reachable=await item.evaluate(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return!!hit&&(hit===n||n.contains(hit));});assert.equal(reachable,true,'Document and Tools actions remain above decorative art');menuChecks.push({label,reachable});await toggle.press('Escape');await expect(list).toBeHidden();
   }
   assert.equal(menuChecks.length,2,'Both original Document and Tools disclosures remain usable');
   evidence.push({name:'takeoff-'+name+'-framing',theme:themeId,viewport:width,...value,menuChecks});await page.screenshot({path:path.join(output,`takeoff-${name}-${themeId}-${value.direction}-${width}.png`)});
  }
 }
 await page.emulateMedia({media:'print'});await expect(heading.locator('.takeoff-heading-art-slot')).toBeHidden();await page.emulateMedia({media:'screen'});
 await page.setViewportSize({width:1384,height:764});
}
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:764}});page.setDefaultTimeout(60000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))csp.push(m.text());});
 await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();
 for(const [route,contract]of Object.entries(assetContract)){const response=await page.request.get(new URL(route,page.url()).href);assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/image\/png/);const bytes=await response.body(),sha256=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,contract.sha256,'Served artwork exactly matches the supplied or unchanged original');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static',route.slice(1)))).digest('hex'),sha256);assetEvidence.push({route,sha256,bytes:bytes.length,natural:contract.natural});}
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});
 if(followupsOnly){const before=await snapshot();if(followupRtlOnly){await page.locator('nav [data-view="settings"]').click();await idle();await page.locator('#application-language').selectOption('ar');}await chooseEstimate();await followupBanners(followupRtlOnly?['slate']:undefined,followupRtlOnly?[1020,390]:undefined);assert.deepEqual(await snapshot(),before,'Header artwork preserves every project draft');assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'header-followups-only',assets:assetEvidence,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS header followups: '+output);return;}
 await chooseTakeoff(page,'Steel');await takeoffIdle();await page.locator('#takeoff-upload').setInputFiles(fixture.fixture);
 await page.waitForFunction(()=>!window.CeasefireTakeoffs.hasPendingOperation()&&window.CeasefireTakeoffs.projectSnapshot()?.documents.length===1);
 // Upload metadata is accepted before automatic Fit has loaded and verified
 // the PDF. Wait for that actual first-page render before changing workspace.
 await page.waitForFunction(()=>{if(window.CeasefireTakeoffs.hasPendingOperation())return false;const s=window.CeasefireTakeoffs.projectSnapshot();return s?.render_checks?.some(check=>check.document_id===s.documents[0]?.id&&check.page===1&&check.success);});
 await expect(page.locator('.takeoff-page')).toBeVisible();await takeoffIdle();
 for(const name of ['Duct','Defect Reports','Service Plans','Walls/Floors','Steel']){await chooseTakeoff(page,name);await takeoffIdle();}
 const before=await snapshot();
 if(!takeoffWidthOnly&&!calculatorBannersOnly){
 await page.locator('nav [data-view="home"]').click();await idle();
 await art('.home-laser-art','home');
 await chooseEstimate();await art('.workspace-header-art--estimate','estimate',true);
 await followupBanners();
 await documentActions('[aria-controls="firestopping-document-actions"]',['download-full-schedule','download-full-product-summary'],'estimate');
 }
 if(!takeoffWidthOnly&&!rtlCalculatorMenusOnly){
 for(const [name,id,kind]of [['Steel (spray)','steel_vermiculite','spray'],['Steel (intumescent)','steel_intumescent','intumescent'],['Steel (board)','steel_board','board'],['Ductwork (spray/wrap)','ductwork','ductwork']]){
  await chooseCalculator(page,name);await idle();await expect(page.locator('#calculator-workspace')).toHaveAttribute('data-calculator-kind',id);
  await expect(page.locator('#calculator-workspace .workspace-header-art:visible')).toHaveCount(1);await art('.workspace-header-art--'+kind,id,true);
  await calculatorFraming(kind,id);
  await documentActions('#calculator-document-toggle',['calculator-excel','calculator-pdf','calculator-summary-pdf','calculator-template'],id);
  if(id==='ductwork'){
   await page.locator('#calculator-pages').getByRole('button',{name:'PRODUCT SETTINGS',exact:true}).click();await idle();
   const settingsNotes={E96:'Default is 38 mm per layer. Confirm the selected blanket detail before changing.',E97:'Choose 0.61 or 1.22 m. Roll width affects overlaps and roll count.',E98:'Default is 7.62 m. Enter the actual supplied roll length.',E99:'Default is 100 mm. Confirm the selected detail before changing.',E100:'A 5–10 mm sealed gap between board strips, not between the duct and opening.'};
   for(const[address,text]of Object.entries(settingsNotes))await expect(page.locator(`#calculator-grid [data-calculator-output="${address}"]`)).toHaveText(text);
   evidence.push({name:'ductwork-product-settings-notes',notes:settingsNotes});await page.screenshot({path:path.join(output,'ductwork-product-settings-notes.png')});
  }
 }
 }
 if(!takeoffWidthOnly&&!rtlCalculatorMenusOnly){
 await chooseCalculator(page,'Firestopping');await idle();await art('.penetration-workspace-art','firestopping',true);await framing('.penetration-workspace-art','firestopping',true);
 const order=await page.locator('.penetration-workspace-art').evaluate(el=>!!el.closest('#penetration-current-item-card > .penetration-banner-heading')&&el.closest('#penetration-current-item-card').firstElementChild.classList.contains('penetration-banner-heading'));assert.equal(order,true,'Artwork is the first row inside the current-item card');
 }
 if(!calculatorBannersOnly){
 for(const [name,route]of [['Steel','/takeoff-header-steel.png'],['Duct','/takeoff-header-ductwork.png'],['Defect Reports','/takeoff-header-physical.png'],['Service Plans','/takeoff-header-service-plans.png']]){await chooseTakeoff(page,name);await takeoffIdle();await takeoffHeading(name,route);}
 await chooseTakeoff(page,'Walls/Floors');await takeoffIdle();await expect(page.locator('.takeoff-heading-art:visible')).toHaveCount(0);evidence.push({name:'takeoff-walls-floors',artHidden:true});
 await page.locator('nav [data-view="settings"]').click();await idle();await page.locator('#application-language').selectOption('ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');
 for(const [name,route]of [['Steel','/takeoff-header-steel.png'],['Duct','/takeoff-header-ductwork.png'],['Defect Reports','/takeoff-header-physical.png'],['Service Plans','/takeoff-header-service-plans.png']]){await translatedTakeoff(name);await takeoffHeading(name,route,['slate'],[825,390]);}
 }
 if(!takeoffWidthOnly){
 await page.locator('nav [data-view="settings"]').click();await idle();await page.locator('#application-language').selectOption('ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');
 for(const [id,kind]of [['steel_vermiculite','spray'],['steel_board','board'],['ductwork','ductwork']]){await translatedCalculator(id);await calculatorFraming(kind,id,['slate'],[825,390]);}
 if(!calculatorBannersOnly)await followupBanners(['slate'],[1020,390]);
 }
 await page.locator('nav [data-view="settings"]').click();await idle();await page.locator('#application-language').selectOption('en');await expect(page.locator('html')).toHaveAttribute('dir','ltr');
 for(const width of [906,390]){await page.setViewportSize({width,height:764});await page.locator('nav [data-view="home"]').click();await idle();await expect(page.locator('.home-laser-art')).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await page.screenshot({path:path.join(output,'home-'+width+'.png')});}
 assert.deepEqual(await snapshot(),before,'Decorative images and navigation preserve project data');
 await page.emulateMedia({media:'print'});await expect(page.locator('.home-laser-art')).toBeHidden();await expect(page.locator('.workspace-header-art--estimate')).toHaveCSS('display','none');await page.emulateMedia({media:'screen'});
 assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,mode:runMode,assets:assetEvidence,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS workspace artwork: '+output);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,mode:runMode,error:String(error),evidence,errors,csp},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
