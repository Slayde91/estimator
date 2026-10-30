// Disposable data only. Google API replies are synthetic; no paid calls.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chooseCalculator}=require('./calculator_actions.cjs'),{chooseTakeoff}=require('./section_navigation.cjs');
const {renderDrawing}=require('./viewer_helpers.cjs');
const root=path.resolve(__dirname,'../..'),output=process.env.CEASEFIRE_BROWSER_OUTPUT||path.join(root,'.runtime/browser-qa',`travel-editor-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true,env:{...process.env,CEASEFIRE_GOOGLE_MAPS_API_KEY:''}});
let logs='',browser,page;server.stderr.on('data',d=>logs+=d);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Fixture startup: '+logs)),120000);server.stdout.on('data',d=>{text+=d;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.on('error',reject);server.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+logs));});});
const errors=[],evidence={};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function snapshot(){return page.evaluate(()=>({details:window.CeasefireProject.details(),pricing:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),firestopping:window.CeasefirePenetrations.projectSnapshot()}));}
async function mapsSettingsHidden(){await expect(page.locator('#view-settings [aria-labelledby="google-maps-heading"]')).toHaveAttribute('hidden','');for(const selector of ['#google-maps-heading','#google-maps-status','#google-maps-refresh','#view-settings a[href="/maps-setup.html"]'])await expect(page.locator(selector)).toBeHidden();}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1384,height:900}});page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
 const status=await page.request.get(new URL('/api/travel/status',page.url()).href);assert.deepEqual(await status.json(),{configured:false,provider:'Google Maps'});
 const noKey=await page.request.post(new URL('/api/travel/route',page.url()).href,{data:{origin:{address:'Fixture origin'},destination:'Fixture project'}});assert.equal(noKey.status(),503);
 const hostile=await page.request.post(new URL('/api/travel/route',page.url()).href,{headers:{Origin:'https://example.invalid'},data:{origin:{address:'Fixture origin'},destination:'Fixture project'}});assert.equal(hostile.status(),403);
 assert.equal((await page.request.get(new URL('/maps-setup.html',page.url()).href)).status(),200);
 for(const role of ['pointer','precision','move','text','handwriting','link','resize-nwse','resize-nesw','resize-horizontal','resize-vertical','unavailable']){const response=await page.request.get(new URL(`/cursors/${role}.png`,page.url()).href);assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/image\/png/);const data=await response.body();assert.equal(data.readUInt32BE(16),32);assert.equal(data.readUInt32BE(20),32);}
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});
 await chooseCalculator(page,'Firestopping');await idle();
 assert.equal(await page.locator('#penetration-current-item-card').evaluate(el=>el.firstElementChild.classList.contains('penetration-banner-heading')),true);
 assert.equal(await page.locator('#penetration-clear svg').innerHTML(),await page.locator('#calculator-reset svg').innerHTML());
 for(const width of [1384,1020,825,390]){
  await page.setViewportSize({width,height:900});
  const positions=await page.locator('.penetration-banner-heading').evaluate(el=>{
   const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
   return{header:box(el),title:box(el.querySelector('#penetration-heading')),clear:box(el.querySelector('#penetration-clear')),document:box(el.querySelector('.calculator-document-toggle')),library:box(el.querySelector('#penetration-add-to-library'))};
  });
  assert.ok(positions.document.right<=positions.clear.x&&positions.clear.right<=positions.library.x);assert.ok(Math.abs(positions.clear.y-positions.document.y)<1);
  assert.ok(positions.library.bottom<=positions.header.bottom&&positions.clear.x>=positions.header.x);
  if(width>=825)assert.ok(positions.clear.y<positions.title.bottom&&positions.clear.bottom>positions.title.y,'Controls share the title row at '+width+': '+JSON.stringify(positions));
  assert.equal(await page.locator('.penetration-item-heading #penetration-clear,.penetration-item-heading .penetration-library-actions').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);
 }
 await page.setViewportSize({width:1384,height:900});
 await page.locator('.penetration-banner-heading .calculator-document-toggle').click();await expect(page.locator('#firestopping-item-document-actions')).toBeVisible();await page.keyboard.press('Escape');
 await page.locator('#penetration-settings').click();
 for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
  await page.locator('html').evaluate((el,theme)=>el.dataset.theme=theme,theme);
  const headings=page.locator('.penetration-settings-subheading');await expect(headings).toHaveText(['SERVICE-TAB ROUTING','PRECALCULATED TASK-HOUR BANDS']);
  await expect(page.locator('[data-penetration-detail-options]')).toHaveCount(0);
  for(const heading of await headings.all()){await expect(heading).toHaveCSS('background-color','rgb(255, 224, 102)');await expect(heading).toHaveCSS('color','rgb(0, 0, 0)');}
 }
 await page.locator('html').evaluate(el=>el.dataset.theme='ceasefire');await page.locator('#penetration-settings').click();
 await page.mouse.move(241,173);await expect(page.locator('#cursor-position')).toHaveText('X241Y173');await expect(page.locator('#cursor-position')).toHaveCSS('color','rgb(255, 0, 0)');
 await page.screenshot({path:path.join(output,'firestopping-first-row.png')});
 await page.locator('nav [data-view="settings"]').click();await idle();
 await mapsSettingsHidden();
 for(const width of [1384,1020,390]){await page.setViewportSize({width,height:900});const cards=await page.locator('.settings-preferences-grid > .card').all(),a=await cards[0].boundingBox(),b=await cards[1].boundingBox();if(width>=800){assert.ok(Math.abs(a.y-b.y)<1);assert.ok(a.x+a.width<=b.x);}else assert.ok(a.y+a.height<=b.y);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await page.screenshot({path:path.join(output,`settings-${width}.png`)});}
 await page.setViewportSize({width:1384,height:900});
 await page.getByRole('button',{name:'Estimates',exact:true}).click();await idle();await page.locator('#site-address').fill('Fixture Project Road, Sydney NSW');
 await expect(page.locator('#project-travel')).toHaveCount(0);
 const routeRequests=[];
 await page.route('**/api/travel/route',r=>{routeRequests.push(r.request().postDataJSON());return r.fulfill({status:503,json:{error:'Unexpected route lookup in panel-removal test'}});});
 for(const cell of ['B2','B3','B5','B6','B7']){
  const control=page.locator(`#input-${cell}`),value=await control.locator('option').evaluateAll(options=>options.find(option=>option.value&&option.value.trim().toLowerCase()!=='n/a')?.value);
  assert.ok(value,`Existing ${cell} cost control still has a priced option`);await control.selectOption(value);
 }
 await page.locator('#input-B4').fill('3');await page.locator('#input-B4').press('Tab');
 const costCells=['B2','B3','B4','B5','B6','B7'];
 const costInputs=()=>page.locator('#main-panel-access-travel [data-cell]').evaluateAll((controls,cells)=>Object.fromEntries(controls.filter(control=>cells.includes(control.dataset.cell)).map(control=>[control.dataset.cell,control.value])),costCells);
 const costsBefore=await costInputs();assert.deepEqual(Object.keys(costsBefore),costCells);
 const before=await snapshot();
 await page.locator('nav [data-view="settings"]').click();await mapsSettingsHidden();
 const retainedStatus=await page.request.get(new URL('/api/travel/status',page.url()).href);assert.equal(retainedStatus.status(),200);assert.deepEqual(await retainedStatus.json(),{configured:false,provider:'Google Maps'});
 await page.getByRole('button',{name:'Estimates',exact:true}).click();await idle();
 await expect(page.locator('#project-travel')).toHaveCount(0);
 assert.deepEqual(await costInputs(),costsBefore,'Navigation preserves all existing Access & Travel cost values');
 assert.deepEqual(await snapshot(),before,'Navigation preserves project details, prices and calculator snapshots');
 const originalCostControl=await page.locator('#input-B4').elementHandle();
 await page.locator('#main-tab-teams-crews').click();await page.locator('#input-D7').dispatchEvent('input');
 assert.equal(await originalCostControl.evaluate(control=>control.isConnected),false,'The existing input editor actually rerendered');await originalCostControl.dispose();
 await page.locator('#main-tab-access-travel').click();
 await expect(page.locator('#project-travel')).toHaveCount(0);
 assert.deepEqual(await costInputs(),costsBefore,'Input rerender preserves all existing Access & Travel cost values');
 assert.deepEqual(await snapshot(),before,'Input rerender preserves project details, prices and calculator snapshots');
 await page.locator('#main-panel-access-travel').screenshot({path:path.join(output,'project-travel-removed.png')});
 for(const locale of ['zh-Hans','hi','es','ar','th','ko','tl','vi']){
  await page.locator('nav [data-view="settings"]').click();await page.locator('#application-language').selectOption(locale);
  await mapsSettingsHidden();
  await page.locator('nav [data-view="estimate"]').click();await idle();
  await expect(page.locator('#project-travel')).toHaveCount(0);
  assert.deepEqual(await costInputs(),costsBefore,`${locale} preserves the existing Access & Travel cost values`);
  assert.deepEqual(await snapshot(),before,'Language changes preserve source addresses, pricing and calculator data');
  assert.deepEqual(routeRequests,[],'Navigation, input rerender and language changes do not send route lookups');
 }
 await page.locator('nav [data-view="settings"]').click();await page.locator('#application-language').selectOption('en');await mapsSettingsHidden();await page.locator('nav [data-view="estimate"]').click();await idle();
 await expect(page.locator('#project-travel')).toHaveCount(0);assert.deepEqual(await costInputs(),costsBefore);assert.deepEqual(await snapshot(),before);assert.deepEqual(routeRequests,[]);
 evidence.travelLanguages=8;evidence.googleMapsSettingsHidden=true;evidence.googleMapsStatusApiRetained=true;evidence.projectTravelRemoved=true;evidence.existingTravelCostInputsPreserved=true;evidence.inputRerenderPreserved=true;evidence.routeRequests=routeRequests.length;
 await chooseTakeoff(page,'Steel');await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture));
 await expect(page.locator('#view-takeoffs')).toHaveCSS('cursor',/^default$/);
 await expect(page.locator('main')).toHaveCSS('cursor',/^default$/);
 await expect(page.locator('#takeoffs-workspace > .takeoff-workspace-heading')).toHaveCSS('cursor',/^default$/);
 await expect(page.locator('.takeoff-workspace-heading .calculator-document-toggle').first()).toHaveCSS('cursor',/^pointer$/);
 await expect(page.locator('#view-takeoffs input[type="checkbox"]').first()).toHaveCSS('cursor',/^pointer$/);
 await expect(page.locator('#view-takeoffs input[type="search"]').first()).toHaveCSS('cursor',/^text$/);
 await page.getByRole('button',{name:'Filter Confirmation',exact:true}).click();
 const filterDialog=page.getByRole('dialog',{name:'Filter Confirmation',exact:true});
 await expect(filterDialog).toHaveCSS('cursor',/^default$/);
 await expect(filterDialog.getByRole('button',{name:'Apply filter',exact:true})).toHaveCSS('cursor',/^pointer$/);
 await expect(filterDialog.getByRole('searchbox')).toHaveCSS('cursor',/^text$/);
 await expect(filterDialog.getByRole('checkbox',{name:'Select all values',exact:true})).toHaveCSS('cursor',/^not-allowed$/);
 await filterDialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
 const drawing=page.locator('#takeoff-viewport'),box=await drawing.boundingBox();await page.mouse.click(box.x+70,box.y+140);await expect(page.locator('.click-smoke-puff')).toHaveCount(0);
 await expect(drawing).toHaveCSS('cursor',/^default$/);
 for(const [name,asset]of[['Pan','move'],['Select PDF text','text']]){await page.getByRole('button',{name,exact:true}).click();await expect(drawing).toHaveCSS('cursor',new RegExp('^'+(asset==='move'?'grab':'text')+'$'));await expect(page.locator('.click-smoke-puff')).toHaveCount(0);}
 await page.locator('.takeoff-markup-rail').getByRole('button',{name:'Rectangle',exact:true}).click();await expect(drawing).toHaveCSS('cursor',/^crosshair$/);await expect(page.locator('.takeoff-overlay')).toHaveCSS('cursor',/^crosshair$/);await page.screenshot({path:path.join(output,'pdf-cursor-tools.png')});
 await page.getByRole('button',{name:'Home',exact:true}).click();await expect(page.locator('.click-smoke-puff')).toHaveCount(0);
 await page.getByRole('button',{name:'Home',exact:true}).click();await expect(page.locator('.click-smoke-puff')).toHaveCount(4);await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
 assert.deepEqual(errors,[]);evidence.googleRequests='Synthetic API checks only';evidence.projectSnapshotsUnchanged=true;evidence.pdfSmokeDisabled=true;evidence.rolesAndHotspotsVerified=true;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));console.log('PASS travel/editor follow-ups: '+output);
})().catch(async e=>{console.error(e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
