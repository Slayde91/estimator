// Brand-accent acceptance on disposable application data, never the live port.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseTakeoff,chooseLibrary}=require('./section_navigation.cjs');
const {assertPreviewHeaderIcons}=require('./preview_header_helpers.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`laser-accents-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const errors=[],evidence=[];
async function idle(){await page.waitForFunction(()=>{const value=window.CeasefireDesktop?.status();return value?.ready&&!value.busy;});}
function contrast(a,b){const lum=value=>{const match=value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);assert.ok(match,'Opaque painted surface: '+value);const c=match.slice(1).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
async function record(area){
  await idle();await page.mouse.move(0,0);
  const value=await page.evaluate(()=>{const visible=el=>!!el.getBoundingClientRect().width&&!el.closest('[hidden]');const paint=el=>{const css=getComputedStyle(el);return{label:el.textContent.trim().slice(0,80),color:css.color,background:css.backgroundColor,image:css.backgroundImage,top:css.borderTopColor,width:css.borderTopWidth};};return{headings:[...document.querySelectorAll('.view:not([hidden]) .page-heading h1,.view:not([hidden]) .page-heading h2,.view:not([hidden]) .takeoff-workspace-heading h1')].filter(visible).map(el=>({label:el.textContent.trim(),edge:getComputedStyle(el).borderInlineStartColor,width:getComputedStyle(el).borderInlineStartWidth})),cards:[...document.querySelectorAll('.view:not([hidden]) :is(.card,.summary-card,.home-card,.calculator-workspace,.library-result,.takeoff-physical-details,.takeoff-register:not(.takeoff-physical-register))')].filter(visible).map(paint),tabs:[...document.querySelectorAll('.view:not([hidden]) :is(.main-section-tab[aria-selected=true],.calculator-page[aria-pressed=true],.penetration-group[aria-selected=true],.penetration-group[aria-pressed=true],.tab.active)')].filter(visible).map(paint)};});
  assert.ok(value.headings.length||value.cards.length,area+' exposes a branded heading or card');
  for(const item of value.headings){assert.equal(item.edge,'rgb(237, 0, 27)',area+' title red');assert.equal(item.width,'3px');}
  for(const item of value.cards){assert.equal(item.top,'rgb(237, 0, 27)',area+' card red');assert.equal(item.width,'3px');}
  for(const item of value.tabs){const stops=item.image.match(/rgb\([^)]*\)/g)||[];assert.equal(stops.length,2,area+' selected tab has a red gradient');for(const stop of stops){const [r,g,b]=stop.match(/\d+/g).map(Number);assert.ok(r>g*2&&r>b*2);assert.ok(contrast(item.color,stop)>=4.5,area+' readable selected tab');}}
  evidence.push({area,...value});await page.screenshot({path:path.join(output,area+'.png')});
}
(async()=>{
  const fixture=await ready;assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(60000);
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>console.error('CSP '+e.effectiveDirective)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${fixture.port}/`);await idle();await assertPreviewHeaderIcons(page);await record('home');
  await page.locator('#estimate-navigation-toggle').click();await record('main');
  const before=await page.locator('#main-estimate-form :is(input,select,textarea)').evaluateAll(nodes=>nodes.map(el=>[el.id,el.value]));
  assert.ok(before.length>0,'Retained Main inputs are present before navigation');
  for(const selector of ['#main-tab-materials','#main-tab-labour-breakdown'])await page.locator(selector).click();
  for(const selector of ['#main-tab-materials','#main-tab-labour-breakdown']){const tab=page.locator(selector);await tab.hover();await expect(tab).toHaveAttribute('aria-selected','true');const paint=await tab.evaluate(el=>({color:getComputedStyle(el).color,image:getComputedStyle(el).backgroundImage})),stops=paint.image.match(/rgb\([^)]*\)/g)||[];assert.equal(stops.length,2,'Hovered selected tabs retain the red gradient');for(const stop of stops)assert.ok(contrast(paint.color,stop)>=4.5);}
  assert.deepEqual(await page.locator('#main-estimate-form :is(input,select,textarea)').evaluateAll(nodes=>nodes.map(el=>[el.id,el.value])),before);await record('main-selected-tabs');
  for(const title of ['Steel (spray)','Steel (board)','Ductwork (spray/wrap)','Firestopping']){await chooseCalculator(page,title);await record('calculator-'+title.split(' ')[0].toLowerCase()+(title.includes('board')?'-board':''));}
  for(const mode of ['Steel','Duct','Defect Reports','Service Plans','Walls/Floors']){await chooseTakeoff(page,mode);await record('takeoff-'+mode.toLowerCase().replaceAll(/[^a-z]+/g,'-'));}
  for(const kind of ['pricing','penetration','technical']){await chooseLibrary(page,kind);await record('library-'+kind);}
  for(const view of ['quotes','help','settings']){await page.locator(`nav [data-view="${view}"]`).click();await record(view);}
  await page.locator('#estimate-navigation-toggle').click();await idle();await page.emulateMedia({media:'print'});await expect(page.locator('#view-estimate .card').first()).toHaveCSS('background-color','rgb(255, 255, 255)');await page.emulateMedia({media:'screen'});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));console.log(`PASS: red headers/cards/selected tabs across ${evidence.length} full-app areas, preview icons and unchanged form inputs/print. ${output}`);
})().catch(async error=>{console.error(error);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
