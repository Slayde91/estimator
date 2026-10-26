// Presentation-only acceptance against a disposable server, never port 8765.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `themes-${Date.now()}`);
fs.mkdirSync(output, { recursive:true });
const measureAsset='static/icons/takeoff-measure.png',measureSha256='fc053970adcdb00965ae9aba71063f1b659a2391f57a39f8301ed0573f1d8130';
const soundPaths=new Set(['/sounds/type.mp3','/sounds/flame-whoosh.wav','/sounds/mgs1-menu-move.mp3','/sounds/mgs-confirm2.mp3','/sounds/hover.mp3','/sounds/select.mp3','/sounds/select-2.mp3','/sounds/checkpoint.ogg','/sounds/loading.mp3']);
const assets = ['tests/browser/themes.cjs','static/theme.js','static/theme.css','static/index.html','static/app.js','static/calculators.js','static/takeoffs.js','static/takeoff-physical.js','static/takeoffs.css','static/header-menu-sounds.js','static/icons/document.png','static/icons/takeoff-transfer.png','static/icons/takeoff-visibility.png','static/icons/takeoff-callout.png','static/icons/takeoff-legend.png','static/icons/takeoff-colour-wheel.png','static/ceasefire-logo.png',measureAsset,...[...soundPaths].map(source=>'static'+source)];
const hashes = () => Object.fromEntries(assets.map(name => [name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const assetHashes = hashes();
assert.equal(assetHashes[measureAsset],measureSha256,'Measure retains the exact original user image bytes');
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], { cwd:root, windowsHide:true });
let logs='', browser, page, serverExit=null;
server.once('exit',(code,signal) => { serverExit={code,signal}; });
server.stderr.on('data', value => { logs+=value; });
const ready = new Promise((resolve,reject) => {
  let text=''; const timer=setTimeout(() => reject(Error(`Fixture startup timeout: ${logs}`)),120000);
  server.stdout.on('data', value => { text+=value; if(text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch(error) { reject(error); } } });
  server.once('error',reject); server.once('exit',code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors=[], networkFailures=[], evidence={ themes:[], layouts:[], iconToolbars:[], reloadBoundaries:[], audioDocuments:[], keyboard:false, persistence:false, deniedStorage:false, calculator:false, drawings:false }, mutationRequests=[];
const pendingRequests=new Set(), requestIds=new WeakMap(), requestDocuments=new WeakMap(), intentionalReloadRequests=new WeakMap();let nextRequestId=0,documentGeneration=-1;
const deliberateReloadLabels=new Set(['theme-preference-persistence','denied-storage-fallback']);
function cancellationClass(row,origin) {
  if(row.failure?.errorText!=='net::ERR_ABORTED'||!Number.isSafeInteger(row.requestId)||row.requestId<=0||!Number.isSafeInteger(row.documentGeneration)||row.documentGeneration<0)return null;
  // A browser may stop fetching media without a decode error. Keep this narrow
  // transport class separate from the independently proven document reloads.
  if(row.method==='GET'&&row.resourceType==='media'&&[...soundPaths].some(sound=>row.url===origin+sound))return 'known-media-cancellation';
  if(row.method==='POST'&&row.resourceType==='fetch'&&row.url===origin+'/api/calculate'&&deliberateReloadLabels.has(row.reloadBoundary?.label)&&row.reloadBoundary.requestId===row.requestId&&row.reloadBoundary.documentGeneration===row.documentGeneration)return 'intentional-reload-calculation-cancellation';
  return null;
}
function checkCancellationGate() {
  const origin='http://127.0.0.1:43210', media={requestId:1,documentGeneration:0,url:origin+'/sounds/loading.mp3',method:'GET',resourceType:'media',failure:{errorText:'net::ERR_ABORTED'},reloadBoundary:null};
  const calculate={...media,url:origin+'/api/calculate',method:'POST',resourceType:'fetch',reloadBoundary:{label:'theme-preference-persistence',requestId:1,documentGeneration:0,markedAt:1}};
  const mediaAccepted=[...soundPaths].map(sound=>({...media,url:origin+sound}));
  const calculationAccepted=[...deliberateReloadLabels].map(label=>({...calculate,reloadBoundary:{...calculate.reloadBoundary,label}}));
  calculationAccepted.push({...calculate,scenario:'late-terminal-event',failedAt:3,reloadBoundary:{...calculate.reloadBoundary,completedAt:2}});
  const rejected=[
    {...calculate,scenario:'unmarked-old-document-calculation',reloadBoundary:null},
    {...calculate,scenario:'new-document-calculation-while-reload-awaits',requestId:2,reloadBoundary:null},
    {...calculate,reloadBoundary:{...calculate.reloadBoundary,requestId:2}},
    {...calculate,reloadBoundary:{...calculate.reloadBoundary,documentGeneration:1}},
    {...calculate,reloadBoundary:{...calculate.reloadBoundary,label:'ordinary-navigation'}},
    {...calculate,url:calculate.url+'?unexpected=1'}, {...calculate,resourceType:'xhr'},
    {...media,requestId:undefined}, {...media,requestId:0}, {...media,requestId:Number.MAX_SAFE_INTEGER+1},
    {...media,documentGeneration:undefined}, {...media,documentGeneration:-1},
    {...media,failure:{errorText:'net::ERR_CONNECTION_RESET'}},
    {...media,resourceType:'fetch'}, {...media,method:'POST'},
    {...media,url:origin+'/sounds/unknown.mp3'}, {...media,url:'http://127.0.0.1:43211/sounds/loading.mp3'},
    {...media,url:media.url+'?unexpected=1'}, {...media,url:origin+'/api/calculate'},
  ];
  for(const row of mediaAccepted)assert.equal(cancellationClass(row,origin),'known-media-cancellation',JSON.stringify(row));
  for(const row of calculationAccepted)assert.equal(cancellationClass(row,origin),'intentional-reload-calculation-cancellation',JSON.stringify(row));
  for(const row of rejected)assert.equal(cancellationClass(row,origin),null,JSON.stringify(row));
  return {accepted:mediaAccepted.length+calculationAccepted.length,mediaAccepted:mediaAccepted.length,calculationAccepted:calculationAccepted.length,rejected:rejected.length,requestIdentityBinding:'Calculation cancellations require a Request pending immediately before a deliberate reload; known media cancellations are classified separately.'};
}
evidence.cancellationGate=checkCancellationGate();
async function idle() { await page.waitForFunction(() => { const s=window.CeasefireDesktop?.status(); return s?.ready&&!s.busy; }); }
async function snapshot() {
  return page.evaluate(() => ({ calculators:window.CeasefireCalculators.projectSnapshot(), penetration:window.CeasefirePenetrations.projectSnapshot(), pricing:window.CeasefireProject.configuration(), takeoffs:window.CeasefireTakeoffs.projectSnapshot(), dirty:window.CeasefireDesktop.status().dirty,
    inputs:[...document.querySelectorAll('#view-estimate input,#view-estimate textarea,#view-estimate select')].map(el => [el.id,el.value,el.selectionStart,el.selectionEnd]) }));
}
function requestDetails(r) { return {requestId:requestIds.get(r),documentGeneration:requestDocuments.get(r),url:r.url(),method:r.method(),resourceType:r.resourceType()}; }
function watch(target) {
  target.on('pageerror',e => errors.push({message:e.message}));
  target.on('console',m => { if(m.type()==='error') errors.push({message:m.text(),location:m.location()}); });
  target.on('request',r => {
    if(r.isNavigationRequest()&&r.frame()===target.mainFrame())documentGeneration++;
    requestIds.set(r,++nextRequestId);requestDocuments.set(r,documentGeneration);pendingRequests.add(r);
    if(!['GET','HEAD'].includes(r.method()))mutationRequests.push({method:r.method(),url:r.url()});
  });
  target.on('requestfinished',r => pendingRequests.delete(r));
  target.on('requestfailed',r => {
    networkFailures.push({...requestDetails(r),failure:r.failure(),failedAt:Date.now(),reloadBoundary:intentionalReloadRequests.get(r)||null});
    pendingRequests.delete(r);
  });
}
async function deliberateReload(label) {
  assert.ok(deliberateReloadLabels.has(label));
  await checkAudioErrors();
  const boundary={label,documentGeneration,markedAt:Date.now(),pending:[...pendingRequests].map(requestDetails)};
  // Bind actual old-document Request identities before reload, with no await in
  // between. Late terminal events keep their marker; new requests never get it.
  for(const request of pendingRequests)if(!intentionalReloadRequests.has(request))intentionalReloadRequests.set(request,{label,markedAt:boundary.markedAt,requestId:requestIds.get(request),documentGeneration:requestDocuments.get(request)});
  evidence.reloadBoundaries.push(boundary);
  try { await page.reload({waitUntil:'networkidle'}); }
  finally { boundary.completedAt=Date.now(); }
  await observeAudioDocument(label);
}
async function checkAudioErrors() {
  const current=await page.evaluate(()=>window.themeAudioErrors);
  const document=evidence.audioDocuments.find(row=>row.generation===documentGeneration);
  if(document){document.errors=current;document.errorsObservedAt=Date.now();}
  assert.deepEqual(current,[],'Native audio errors must not be hidden by transport cancellation classification');
}
async function observeAudioDocument(label) {
  await page.waitForFunction(()=>window.themeAudioErrors.length>0||(window.themeAudio.length===9&&window.themeAudio.every(audio=>audio.readyState>=2&&!audio.error&&Number.isFinite(audio.duration)&&audio.duration>0)),null,{timeout:30000});
  const state=await page.evaluate(()=>({timeOrigin:performance.timeOrigin,observedAt:Date.now(),errors:window.themeAudioErrors,media:window.themeAudio.map(audio=>({source:new URL(audio.currentSrc||audio.src).pathname,url:audio.currentSrc||audio.src,readyState:audio.readyState,duration:audio.duration,error:audio.error?.code||null,preload:audio.preload}))}));
  evidence.audioDocuments.push({generation:documentGeneration,label,...state});
  assert.deepEqual(state.media.map(row=>row.source).sort(),[...soundPaths].sort(),'All nine real audio elements must be observed');
  assert.deepEqual(state.errors,[]);
  assert.ok(state.media.every(row=>row.readyState>=2&&row.error===null&&Number.isFinite(row.duration)&&row.duration>0&&row.preload==='auto'),'Every real clip must decode successfully');
}
async function settings() { await page.locator('nav [data-view="settings"]').click(); await idle(); }
async function theme(id) {
  const view = await page.locator('.view:not([hidden])').getAttribute('id');
  await settings();
  await page.waitForLoadState('networkidle');
  const beforeThemeRequests = mutationRequests.length;
  for(let i=0;i<5 && await page.locator('html').getAttribute('data-theme')!==id;i++) await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',id);
  assert.equal(mutationRequests.length, beforeThemeRequests, 'The theme control itself sends no mutation request');
  if(view !== 'view-settings') {
    const destination=page.locator(`nav [data-view="${view.replace('view-','')}"]`);
    await destination.click();
    // Returning through a header disclosure opens its foreground menu. Dismiss
    // it before the next Settings click, including when the header has two rows.
    if(await destination.getAttribute('aria-expanded')==='true') await destination.press('Escape');
    await page.mouse.move(0,0);
  }
  await idle();
}
function luminance(rgb) { const c=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4); return .2126*c[0]+.7152*c[1]+.0722*c[2]; }
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
async function colors(selector) { return page.locator(selector).first().evaluate(el => { const s=getComputedStyle(el); return { color:s.color,background:s.backgroundColor,border:s.borderColor }; }); }
async function controlAppearance(control) {
  return control.evaluate(button => {
    const css=getComputedStyle(button), image=button.querySelector('img'), svg=button.querySelector('svg');
    const value={color:css.color,background:css.backgroundColor,disabled:button.disabled,filter:css.filter,opacity:css.opacity,svgStroke:svg?getComputedStyle(svg).stroke:null};
    if(image) {
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let opaque=0,nonBlackOpaque=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]===255){opaque++;if(pixels[i]||pixels[i+1]||pixels[i+2])nonBlackOpaque++;}
      value.image={src:image.getAttribute('src'),width:image.naturalWidth,height:image.naturalHeight,filter:getComputedStyle(image).filter,blend:getComputedStyle(image).mixBlendMode,opaque,nonBlackOpaque};
    }
    return value;
  });
}
async function readableMidnightIcon(control) {
  await expect(control).toBeVisible();await expect(control.locator('img')).toHaveJSProperty('complete',true);
  const value=await controlAppearance(control);assert.equal(value.image.width,512);assert.equal(value.image.height,512);assert.ok(value.image.opaque>0);assert.equal(value.image.nonBlackOpaque,0);
  assert.equal(value.filter,'none');assert.equal(value.image.filter,'brightness(0) invert(1)');assert.ok(contrast('rgb(255,255,255)',value.background)>=3,'white icon must contrast with its dark control');assert.ok(contrast(value.color,value.background)>=4.5,'control text must remain readable');
  await control.hover();const hover=await controlAppearance(control);assert.equal(hover.image.filter,'brightness(0) invert(1)');assert.ok(contrast('rgb(255,255,255)',hover.background)>=3,'hover must preserve white icon contrast');assert.ok(contrast(hover.color,hover.background)>=4.5);
  await page.mouse.move(1,1);return {normal:value,hover};
}
(async () => {
  const fixture=await ready; assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({ headless:true });
  const context=await browser.newContext({ viewport:{ width:1146,height:1000 }, reducedMotion:'reduce' });
  await context.addInitScript(paths => {
    window.themeCsp=[];document.addEventListener('securitypolicyviolation',e=>window.themeCsp.push(e.effectiveDirective));
    window.themeAudio=[];window.themeAudioErrors=[];
    const load=HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load=function(...args) {
      if(paths.some(source=>this.src===location.origin+source)&&!window.themeAudio.includes(this)) {
        window.themeAudio.push(this);
        this.addEventListener('error',()=>window.themeAudioErrors.push({source:this.currentSrc||this.src,code:this.error?.code||null,message:this.error?.message||''}));
      }
      return Reflect.apply(load,this,args);
    };
  },[...soundPaths]);
  page=await context.newPage(); watch(page);
  await page.goto(`http://127.0.0.1:${fixture.port}`,{waitUntil:'networkidle'}); await idle();await observeAudioDocument('initial');
  await settings(); await expect(page.locator('#theme-toggle')).toHaveAccessibleName('Theme: CLASSIFIRE. Next theme: Midnight.');
  await page.getByRole('button',{name:'Estimates',exact:true}).click(); await idle();
  await expect(page.locator('#project-no')).toBeVisible();
  await page.locator('#project-no').fill('THEME-DRAFT-UNCHANGED'); await page.locator('#measurements').fill('Pending notes are preserved across every theme.');
  await page.locator('#measurements').press('Tab'); await idle(); await page.waitForLoadState('networkidle');
  const before=await snapshot(), requestCount=mutationRequests.length, buttonColors=new Set(), footerText=await page.locator('footer').innerText();
  for(const id of ['ceasefire','midnight','ocean','forest','slate']) {
    await theme(id); const button=await colors('#theme-toggle'), card=await colors('#view-estimate .card'), input=await colors('#project-no'), text=await colors('#view-estimate .card .helper');
    assert.ok(contrast(button.color,button.background)>=4.5,id+' button contrast'); assert.ok(contrast(card.color,card.background)>=4.5,id+' card contrast'); assert.ok(contrast(input.color,input.background)>=4.5,id+' input contrast'); assert.ok(contrast(text.color,card.background)>=4.5,id+' helper contrast'); buttonColors.add(button.background);
    if(id!=='ceasefire') assert.ok(contrast(input.border,input.background)>=3,id+' input boundary');
    for(const width of [1146,752,720]) {
      await page.setViewportSize({width,height:1000});
      const geometry=await page.evaluate(() => { const box=s => { const r=document.querySelector(s).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; }; return {header:box('.app-header'),nav:box('.app-header nav'),actions:box('#header-project-actions'),actionsPosition:getComputedStyle(document.querySelector('#header-project-actions')).position,viewportHeight:innerHeight,theme:box('#theme-toggle'),overflow:document.documentElement.scrollWidth-innerWidth}; });
      assert.ok(geometry.overflow<=1,`${id}/${width} page overflow`); assert.ok(geometry.nav.right<=width,`${id}/${width} navigation fits`);assert.equal(geometry.actionsPosition,'fixed');assert.ok(geometry.actions.right<=width,`${id}/${width} floating actions fit`);assert.ok(geometry.actions.bottom<=geometry.viewportHeight,`${id}/${width} floating actions stay in viewport`); assert.equal(geometry.theme.width,0,"Theme control belongs to the hidden Settings view");
      const screenshot=path.join(output,`${id}-${width}.png`); await page.screenshot({path:screenshot}); evidence.layouts.push({id,width,geometry,screenshot});
    }
    const footer=await page.locator('footer').evaluate(el => {
      let background=getComputedStyle(el).backgroundColor,parent=el;
      while(['rgba(0, 0, 0, 0)','transparent'].includes(background)&&parent.parentElement){parent=parent.parentElement;background=getComputedStyle(parent).backgroundColor;}
      return {color:getComputedStyle(el).color,noticeColor:getComputedStyle(el.querySelector('.estimating-notice')).color,background};
    });
    assert.ok(contrast(footer.color,footer.background)>=4.5,id+' footer contrast');assert.ok(contrast(footer.noticeColor,footer.background)>=4.5,id+' estimating notice contrast');assert.equal(await page.locator('footer').innerText(),footerText,'Themes preserve the disclaimer wording');
    evidence.themes.push({id,button,card,input,helper:text,footer});
    assert.deepEqual(await snapshot(),before,id+' must preserve draft/project/calculator snapshots');
  }
  assert.equal(buttonColors.size,5);
  assert.ok(mutationRequests.slice(requestCount).every(request => /\/api\/(?:penetration\/)?calculate$/.test(new URL(request.url).pathname)), 'Returning from Settings may only recalculate the retained estimate');
  await theme('midnight'); await page.emulateMedia({media:'print'}); const print=await colors('#view-estimate .card'); assert.equal(print.background,'rgb(255, 255, 255)'); assert.equal(print.color,'rgb(43, 37, 42)'); await expect(page.locator('#theme-toggle')).toBeHidden();await expect(page.locator('footer')).toBeHidden(); await page.emulateMedia({media:'screen'}); evidence.print=print;
  await theme('slate');
  await settings(); await page.locator('#theme-toggle').focus(); await page.keyboard.press('Enter'); await expect(page.locator('html')).toHaveAttribute('data-theme','ceasefire'); await expect(page.locator('#theme-toggle')).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.keyboard=true;
  await deliberateReload('theme-preference-persistence'); await idle(); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.persistence=true;
  await chooseCalculator(page,'Steel (spray)'); await idle(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',{timeout:60000});
  const calculatorBefore=await snapshot(); await theme('forest'); await theme('midnight'); assert.deepEqual(await snapshot(),calculatorBefore); const grid=await colors('.calculator-grid'); assert.ok(contrast(grid.color,grid.background)>=4.5); evidence.calculator={preserved:true,grid};
  await page.locator('#calculator-pages').getByRole('button',{name:'SCHEDULE',exact:true}).click(); await idle(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');
  const calculatorInput=page.locator('.calculator-grid input:not([readonly])').first();
  await calculatorInput.evaluate(el=>el.setAttribute('aria-invalid','true')); const invalid=await colors('.calculator-grid input[aria-invalid=true]'); assert.ok(contrast(invalid.color,invalid.background)>=4.5); assert.equal(invalid.background,'rgb(255, 242, 242)'); await calculatorInput.evaluate(el=>el.removeAttribute('aria-invalid')); evidence.calculator.invalid=invalid;
  evidence.calculator.document=await readableMidnightIcon(page.locator('#calculator-document-toggle'));
  const scheduleUndo=await controlAppearance(page.locator('[data-schedule-undo]').filter({visible:true}).first());
  await chooseTakeoff(page,'Steel'); await idle();
  for(const view of ['Steel','Walls/Floors','Defect Reports','Service Plans']) {
    await chooseTakeoff(page,view);await idle();
    for(const width of [1146,764]) {
      await page.setViewportSize({width,height:1000});
      const physical=view==='Defect Reports'||view==='Service Plans',register=page.locator(physical?'.takeoff-physical-register':'.takeoff-register').filter({visible:true}).first();
      const documentControl=page.locator(physical?'.takeoff-workspace-heading .takeoff-physical-document-host':'.takeoff-workspace-heading').getByRole('button',{name:physical?'Document':'Takeoff register document actions',exact:true});
      await documentControl.scrollIntoViewIfNeeded();const document=await readableMidnightIcon(documentControl);
      const transfer=register.getByRole('button',{name:physical?'Transfer to Firestopping Schedule':'Preview transfer',exact:true});
      const transferAppearance=await transfer.isVisible()?await readableMidnightIcon(transfer):null;
      // Both draft and ordinary register chrome follow the selected theme.
      const undo=await controlAppearance(register.getByRole('button',{name:'Undo last edit',exact:true}));
      let physicalPalette;
      if(physical) {
        physicalPalette=await register.evaluate(el=>{const css=getComputedStyle(el),heading=getComputedStyle(el.querySelector('thead th'));return {background:css.backgroundColor,color:css.color,headingBackground:heading.backgroundColor,headingColor:heading.color};});
        assert.equal(physicalPalette.background,grid.background);assert.equal(physicalPalette.color,grid.color);
        assert.ok(contrast(physicalPalette.headingColor,physicalPalette.headingBackground)>=4.5,'Physical heading contrast');
        assert.equal(undo.background,scheduleUndo.background);assert.equal(undo.color,scheduleUndo.color);assert.ok(contrast(undo.color,undo.background)>=4.5,'Physical Undo contrast');
      } else { assert.equal(undo.background,scheduleUndo.background);assert.equal(undo.color,scheduleUndo.color); }
      const adjacent=[];
      for(const name of ['Update linked rows',physical?'Unlink from Firestopping Schedule':'Detach links']) {
        const control=register.getByRole('button',{name,exact:true,includeHidden:true});if(!await control.isVisible())continue;
        const value=await controlAppearance(control);assert.ok(contrast(value.svgStroke,value.background)>=3,name+' SVG contrast');adjacent.push({name,...value});
      }
      for(const value of adjacent) {
        if(physical) { assert.equal(value.background,document.normal.background);assert.ok(contrast(value.color,value.background)>=4.5,'Physical adjacent control text contrast'); }
        else { assert.equal(document.normal.background,value.background,'Document shares adjacent control surface');assert.equal(document.normal.color,value.color,'Document shares adjacent control text color'); }
        if(transferAppearance){assert.equal(transferAppearance.normal.background,value.background,'Transfer shares adjacent control surface');assert.equal(transferAppearance.normal.color,value.color,'Transfer shares adjacent control text color');}
      }
      const rail=[];
      for(const control of await page.locator('.takeoff-tool-rail button,.takeoff-markup-rail button').all()) {
        if(!await control.isVisible()) continue;
        const image=control.locator('img');if(await image.count())await expect(image).toHaveJSProperty('complete',true);
        const value=await controlAppearance(control);const name=await control.getAttribute('aria-label');
        if(value.image){
          const measure=value.image.src==='/icons/takeoff-measure.png';
          assert.equal(value.image.filter,measure?'invert(1)':'brightness(0) invert(1)',name+' white raster icon');
          if(measure){assert.equal(name,'Measure');assert.equal(value.image.blend,'screen');assert.equal(value.image.width,1430);assert.equal(value.image.height,1044);assert.ok(value.image.opaque>0);assert.ok(value.image.nonBlackOpaque>0,'Original opaque white background is retained and blended with the control');}
          assert.ok(contrast('rgb(255,255,255)',value.background)>=3,name+' icon contrast');
        }
        if(value.svgStroke)assert.ok(contrast(value.svgStroke,value.background)>=3,name+' SVG contrast');
        rail.push({name,...value});
      }
      const railScreenshot=path.join(output,'midnight-'+view.toLowerCase().replace(/[^a-z]+/g,'-')+'-rail-'+width+'.png');await page.locator('.takeoff-tool-rail').screenshot({path:railScreenshot});
      const markupRailScreenshot=path.join(output,'midnight-'+view.toLowerCase().replace(/[^a-z]+/g,'-')+'-markup-rail-'+width+'.png');await page.locator('.takeoff-markup-rail').screenshot({path:markupRailScreenshot});
      const beforeDocument=await snapshot(),beforeRequests=mutationRequests.length;
      await documentControl.focus();await page.keyboard.press('ArrowDown');await expect(documentControl).toHaveAttribute('aria-expanded','true');await page.keyboard.press('Escape');await expect(documentControl).toHaveAttribute('aria-expanded','false');await expect(documentControl).toBeFocused();
      assert.deepEqual(await snapshot(),beforeDocument,'Document open/dismiss preserves project/draft');assert.equal(mutationRequests.length,beforeRequests);
      const screenshot=path.join(output,'midnight-'+view.toLowerCase().replace(/[^a-z]+/g,'-')+'-'+width+'.png');await page.screenshot({path:screenshot});
      evidence.iconToolbars.push({view,width,document,transfer:transferAppearance,undo,physicalPalette,adjacent,rail,railScreenshot,markupRailScreenshot,screenshot});
    }
  }
  // Only chrome artwork is tinted; the retained drawing canvas and overlay stay unfiltered.
  const pageStyles=await page.locator('.takeoff-viewer').evaluate(el => ({filter:getComputedStyle(el).filter,drawingFilters:[...el.querySelectorAll('canvas,.takeoff-overlay,.takeoff-page img')].map(child=>getComputedStyle(child).filter)})); assert.equal(pageStyles.filter,'none');assert.ok(pageStyles.drawingFilters.every(value=>value==='none')); evidence.drawings=pageStyles;
  await theme('ocean');
  const lightFilters=await page.locator('.takeoff-tool-rail img,.takeoff-markup-rail img,.takeoff-document-menu .calculator-document-icon').evaluateAll(images=>images.map(image=>getComputedStyle(image).filter));assert.ok(lightFilters.length>0);assert.ok(lightFilters.every(value=>value==='none'),'light themes retain original icon colors');await theme('midnight');evidence.lightIconFilters=lightFilters;
  // Like retained header-controls acceptance, 320px covers the header rather
  // than forcing a data register's minimum workspace width into that viewport.
  await page.getByRole('button',{name:'Home',exact:true}).click(); await idle();
  await settings();
  for(const width of [390,320]) { await page.setViewportSize({width,height:1000}); const b=await page.locator('#theme-toggle').boundingBox(); assert.ok(b.width>=40&&b.height>=40&&b.x+b.width<=width); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1)); }
  assert.deepEqual(await page.evaluate(() => window.themeCsp),[]);
  // A fresh document with denied storage exercises the real fallback, including
  // an existing saved preference that is inaccessible to the controller.
  await page.addInitScript(() => Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Denied','SecurityError');}}));
  await deliberateReload('denied-storage-fallback'); await expect(page.locator('html')).toHaveAttribute('data-theme','ceasefire'); await settings(); await page.locator('#theme-toggle').click(); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.deniedStorage=true;
  assert.deepEqual(hashes(),assetHashes,'Source assets must remain unchanged during QA'); assert.deepEqual(errors,[]);
  await checkAudioErrors();
  assert.deepEqual(evidence.audioDocuments.map(row=>row.generation),[0,1,2],'All three real documents must have error-free decoded media');
  const decodedDocuments=new Set(evidence.audioDocuments.map(row=>row.generation));
  evidence.cancellationClassifications=networkFailures.map(row=>({requestId:row.requestId,documentGeneration:row.documentGeneration,classification:cancellationClass(row,`http://127.0.0.1:${fixture.port}`)}));
  const rejectedFailures=networkFailures.filter((row,index)=>!evidence.cancellationClassifications[index].classification||!decodedDocuments.has(row.documentGeneration));
  assert.deepEqual(rejectedFailures,[],'Only exact known media cancellations with decoded audio, or proven reload calculation cancellations, are permitted. Actual failures: '+JSON.stringify(networkFailures));
  console.log(JSON.stringify({cancellationGate:evidence.cancellationGate,cancellationCount:networkFailures.length,cancellationClassifications:evidence.cancellationClassifications.slice(0,32),cancelledRequests:networkFailures.slice(0,32),audioDocuments:evidence.audioDocuments.map(row=>({generation:row.generation,label:row.label,decoded:row.media.length,errors:row.errors}))}));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,assetHashes,evidence,errors,networkFailures,mutationRequests,fixturePort:fixture.port},null,2)); console.log(`PASS themes: ${output}`);
})().catch(async error => { console.error(error); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),assetHashes,evidence,errors,networkFailures,serverExit},null,2)); process.exitCode=1; }).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
