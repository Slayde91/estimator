// Retained artwork and simplified headers preserve controls, responsive flow and drafts.
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
  if(name!=='firestopping'){
   const calculator=await frame.evaluate(el=>Boolean(el.closest('#calculator-workspace')));
   const actionHost=page.locator(calculator?'#calculator-toolbar-actions':'.workspace-banner-heading:visible');
   await actionHost.locator(':is(.actions,.calculator-header-actions) button').first().click();await page.keyboard.press('Escape');
  }
 }
 evidence.push({name,...value});await page.screenshot({path:path.join(output,name+'.png')});
}
async function openProjectsList(){
 const toggle=page.locator('#projects-navigation-toggle');
 await toggle.click();await idle();
 // The Projects hover menu overlays the next navigation row on narrow screens.
 // Move off its trigger and dismiss it before using the hub or changing media.
 await page.mouse.move(0,0);await toggle.press('Escape');await expect(page.locator('#projects-navigation-menu')).toBeHidden();
 await expect(page.locator('#view-quotes')).toBeVisible();await idle();
}
async function followupBanners(themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,1020,825,390]){
 for(const themeId of themes){
  await theme(themeId,'estimate');await chooseEstimate();
  for(const workspace of ['estimate','projects','technical','penetration','pricing']){
   if(workspace==='projects')await openProjectsList();
   else if(['technical','penetration','pricing'].includes(workspace)){await chooseLibrary(page,workspace);await idle();}
   const heading=page.locator(workspace==='estimate'?'.estimate-banner-heading':workspace==='projects'?'.project-banner-heading':`#pricing-heading-slot [data-library-heading="${workspace}"]`);
   for(const width of widths){
    await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
    const data=await heading.evaluate(el=>{
     const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};},title=el.querySelector('h1,h2'),frame=el.querySelector('.workspace-header-art--estimate,.project-evidence-crop,.library-heading-art-slot img'),image=frame&&(frame.matches('img')?frame:frame.querySelector('img'));
     return{heading:box(el),title:box(title),font:getComputedStyle(title).fontSize,art:frame?box(frame):null,src:image?.getAttribute('src'),loaded:!image||image.complete&&image.naturalWidth>0,direction:getComputedStyle(el).direction,subtitle:el.querySelectorAll('.subtitle').length,overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.equal(data.loaded,true);assert.equal(data.subtitle,0);assert.ok(data.overflow<=1,JSON.stringify(data));
    assert.equal(data.art,null,workspace+' heading has no artwork');
    if(workspace!=='estimate')assert.equal(data.font,'18px');
    if(workspace==='estimate'){const toggle=page.locator('#view-estimate [data-document-menu-toggle][aria-controls="firestopping-document-actions"]');await toggle.click({trial:true});}
    if(workspace==='projects'){
     for(const id of ['new-quote','load-project','link-project-folder','refresh-quotes'])await page.locator('#'+id).click({trial:true});
     await expect(heading.locator('.eyebrow')).toHaveCount(0);await expect(page.locator('.project-evidence-art,.project-heading-art-slot')).toHaveCount(0);
     const tabs=page.locator('#project-pages');await expect(tabs).toBeVisible();await expect(tabs.locator('button')).toHaveCount(4);
     const tabBox=await tabs.boundingBox();assert.ok(tabBox.x>=0&&tabBox.x+tabBox.width<=width+1,'Project tabs stay within the viewport');
    }
    evidence.push({name:'header-followup',workspace,theme:themeId,viewport:width,...data});await page.screenshot({path:path.join(output,`followup-${workspace}-${themeId}-${width}.png`)});
   }
  }
 }
 await openProjectsList();await page.emulateMedia({media:'print'});await expect(page.locator('.project-evidence-art,.project-heading-art-slot')).toHaveCount(0);await page.emulateMedia({media:'screen'});
 await theme('ceasefire','estimate');await page.setViewportSize({width:1384,height:764});
}
async function calculatorFraming(kind,name,themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,1146,825,390]){
 const heading=page.locator('.calculator-workspace-heading');
 for(const themeId of themes){
  await theme(themeId,name);
  if(name==='ductwork')await page.locator('#calculator-pages button').first().click();
  for(const width of widths){
   await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
   await expect(heading.locator('.eyebrow,.calculator-heading-art-slot,.workspace-header-art')).toHaveCount(0);
   await expect(page.locator('#calculator-title')).toBeVisible();
   const value=await heading.evaluate(el=>{
    const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    return{heading:box(el),title:box(el.querySelector('h2')),actions:box(el.closest('#view-calculators').querySelector('#calculator-toolbar-actions .calculator-header-actions')),direction:getComputedStyle(el).direction,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.ok(value.title.width>0&&value.title.x>=0&&value.title.right<=width+1);assert.ok(value.overflow<=1);
   assert.ok(value.actions.x>=0&&value.actions.right<=width+1&&value.actions.y>=value.heading.bottom-.1,'Moved calculator actions stay below the heading and inside the viewport');
   const toggle=page.locator('#calculator-document-toggle');await toggle.click();const menu=page.locator('#calculator-document-menu');await expect(menu).toBeVisible();const first=menu.locator('button:visible').first();await first.click({trial:true});
   const menuHit=await first.evaluate(n=>{const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};},r=box(n),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),menu=n.closest('.calculator-document-actions'),m=box(menu),edges=[m.x+1,m.right-1].map(x=>{const target=document.elementFromPoint(x,m.y+20);return{x,y:m.y+20,reachable:!!target&&(target===menu||menu.contains(target)),interceptedBy:target?.tagName};});return{reachable:!!hit&&(hit===n||n.contains(hit)),menu:m,edges,workspace:box(n.closest('#calculator-workspace')),viewport:{width:innerWidth,clientWidth:document.documentElement.clientWidth}};});
   const diagnostic=JSON.stringify({name,theme:themeId,width,...menuHit});
   assert.ok(menuHit.menu.x>=menuHit.workspace.x-.1&&menuHit.menu.right<=menuHit.workspace.right+.1&&menuHit.menu.x>=0&&menuHit.menu.right<=menuHit.viewport.clientWidth+.1,'The native Document menu fits horizontally: '+diagnostic);
   assert.ok(menuHit.edges.every(edge=>edge.reachable),'Both native Document menu edges remain visible above the clipping card: '+diagnostic);
   assert.equal(menuHit.reachable,true,'Native pointer reaches the document action: '+diagnostic);await toggle.press('Escape');await expect(menu).toBeHidden();
   if(name==='ductwork'){
    const title=page.locator('#calculator-grid h3.calculator-overview-title').first();await expect(title).toBeVisible();
    value.overview=await title.evaluate(el=>({font:getComputedStyle(el).fontSize,height:el.getBoundingClientRect().height,lineHeight:getComputedStyle(el).lineHeight}));
    assert.equal(value.overview.font,'14px');assert.ok(value.overview.height>=58&&value.overview.height<=80,'Duct heading remains compact while allowing wrapped translations');
   }
   evidence.push({name:name+'-header',theme:themeId,viewport:width,...value,menuHit});await page.screenshot({path:path.join(output,`${name}-header-${themeId}-${value.direction}-${width}.png`)});
  }
 }
 await page.setViewportSize({width:1384,height:764});
}
async function firestoppingHeader(){
 for(const themeId of ['ceasefire','midnight','ocean','forest','slate']){
  await theme(themeId,'firestopping');
  for(const width of [1384,825,390]){
   await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
   const heading=page.locator('.penetration-banner-heading');
   await expect(heading.locator('.eyebrow,.calculator-heading-art-slot,.penetration-workspace-art')).toHaveCount(0);
   await expect(page.locator('#penetration-heading')).toBeVisible();
   const toggle=heading.locator('[aria-controls="firestopping-item-document-actions"]');await toggle.click();const menu=page.locator('#firestopping-item-document-actions');await expect(menu).toBeVisible();await menu.locator('button:visible').first().click({trial:true});await toggle.press('Escape');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth<=1));
   evidence.push({name:'firestopping-header',theme:themeId,viewport:width,documentMenuReachable:true});await page.screenshot({path:path.join(output,`firestopping-header-${themeId}-${width}.png`)});
  }
 }
 await page.setViewportSize({width:1384,height:764});
}
async function takeoffHeading(name,route,themes=['ceasefire','midnight','ocean','forest','slate'],widths=[1384,825,390]){
 const heading=page.locator('.takeoff-workspace-heading');
 for(const themeId of themes){
  await theme(themeId,'takeoff:'+name);
  for(const width of widths){
   await page.setViewportSize({width,height:764});await page.evaluate(()=>scrollTo(0,0));
   await expect(heading.locator('img[src*="takeoff-header-"]')).toHaveCount(0);
   await expect(heading.locator('h1')).toBeVisible();
   const value=await heading.evaluate(el=>({direction:getComputedStyle(el).direction,overflow:document.documentElement.scrollWidth-innerWidth}));
   assert.ok(value.overflow<=1,'Takeoff header fits the viewport');
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
 await chooseEstimate();await expect(page.locator('.workspace-header-art--estimate')).toHaveCount(0);
 await followupBanners();
 await documentActions('[aria-controls="firestopping-document-actions"]',['download-full-schedule','download-full-product-summary'],'estimate');
 }
 if(!takeoffWidthOnly&&!rtlCalculatorMenusOnly){
 for(const [name,id,kind]of [['Steel (spray)','steel_vermiculite','spray'],['Steel (intumescent)','steel_intumescent','intumescent'],['Steel (board)','steel_board','board'],['Ductwork (spray/wrap)','ductwork','ductwork']]){
  await chooseCalculator(page,name);await idle();await expect(page.locator('#calculator-workspace')).toHaveAttribute('data-calculator-kind',id);
  await expect(page.locator('#calculator-workspace .workspace-header-art')).toHaveCount(0);
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
 await chooseCalculator(page,'Factor Calcs');await idle();await expect(page.locator('#calculator-title')).toHaveText('Factor Calcs');await expect(page.locator('.calculator-workspace-heading .eyebrow,.calculator-workspace-heading .workspace-header-art')).toHaveCount(0);
 await chooseCalculator(page,'Firestopping');await idle();await firestoppingHeader();
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
 await page.emulateMedia({media:'print'});await expect(page.locator('.home-laser-art')).toBeHidden();await expect(page.locator('.workspace-header-art--estimate')).toHaveCount(0);await page.emulateMedia({media:'screen'});
 assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,mode:runMode,assets:assetEvidence,evidence,draftsUnchanged:true,errors,csp},null,2));console.log('PASS workspace artwork: '+output);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,mode:runMode,error:String(error),evidence,errors,csp},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
