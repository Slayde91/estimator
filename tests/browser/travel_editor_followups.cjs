// Disposable data only. Google replies and GPS are synthetic; no paid calls.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chooseCalculator}=require('./calculator_actions.cjs'),{chooseTakeoff}=require('./section_navigation.cjs');
const {renderDrawing}=require('./viewer_helpers.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`travel-editor-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true,env:{...process.env,CEASEFIRE_GOOGLE_MAPS_API_KEY:''}});
let logs='',browser,page;server.stderr.on('data',d=>logs+=d);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Fixture startup: '+logs)),120000);server.stdout.on('data',d=>{text+=d;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.on('error',reject);server.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+logs));});});
const errors=[],evidence={};
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function snapshot(){return page.evaluate(()=>({details:window.CeasefireProject.details(),pricing:window.CeasefireProject.configuration(),calculators:window.CeasefireCalculators.projectSnapshot(),firestopping:window.CeasefirePenetrations.projectSnapshot()}));}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1384,height:900},permissions:['geolocation'],geolocation:{latitude:-33.86,longitude:151.2}});page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
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
  const headings=page.locator('.penetration-settings-subheading');assert.equal(await headings.count(),3);
  for(const heading of await headings.all()){await expect(heading).toHaveCSS('background-color','rgb(255, 224, 102)');await expect(heading).toHaveCSS('color','rgb(0, 0, 0)');}
 }
 await page.locator('html').evaluate(el=>el.dataset.theme='ceasefire');await page.locator('#penetration-settings').click();
 await page.mouse.move(241,173);await expect(page.locator('#cursor-position')).toHaveText('X241Y173');await expect(page.locator('#cursor-position')).toHaveCSS('color','rgb(255, 0, 0)');
 await page.screenshot({path:path.join(output,'firestopping-first-row.png')});
 await page.locator('nav [data-view="settings"]').click();await idle();
 for(const width of [1384,1020,390]){await page.setViewportSize({width,height:900});const cards=await page.locator('.settings-preferences-grid > .card').all(),a=await cards[0].boundingBox(),b=await cards[1].boundingBox();if(width>=800){assert.ok(Math.abs(a.y-b.y)<1);assert.ok(a.x+a.width<=b.x);}else assert.ok(a.y+a.height<=b.y);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await page.screenshot({path:path.join(output,`settings-${width}.png`)});}
 await page.setViewportSize({width:1384,height:900});
 await page.getByRole('button',{name:'Estimates',exact:true}).click();await idle();await page.locator('#site-address').fill('Fixture Project Road, Sydney NSW');
 await page.locator('#travel-current-location').fill('Fixture Origin Road, Sydney NSW');await page.locator('#travel-calculate').click();await expect(page.locator('#travel-status')).toContainText('not configured');await expect(page.locator('#travel-distance')).toHaveText('—');
 const link=page.locator('#travel-project-map');assert.equal(new URL(await link.getAttribute('href')).searchParams.get('query'),'Fixture Project Road, Sydney NSW');await expect(page.locator('.travel-project-empty')).toBeHidden();
 await page.route('**/api/travel/status',r=>r.fulfill({json:{configured:true,provider:'Google Maps'}}));
 await page.locator('nav [data-view="settings"]').click();await page.locator('#google-maps-refresh').click();await expect(page.locator('#google-maps-status')).toHaveText('Google Maps is configured.');
 await page.getByRole('button',{name:'Estimates',exact:true}).click();await idle();
 const before=await snapshot();let bodies=[];
 await page.route('**/api/travel/route',r=>{bodies.push(r.request().postDataJSON());return r.fulfill({json:{provider:'Google Maps',distance_meters:12345,duration_seconds:1800,summary:'Home'}});});
 await page.locator('#travel-calculate').click();await expect(page.locator('#travel-distance')).toHaveText('12.3 km');await expect(page.locator('#travel-duration')).toHaveText('30 min');
 assert.deepEqual(bodies[0],{origin:{address:'Fixture Origin Road, Sydney NSW'},destination:'Fixture Project Road, Sydney NSW'});
 await link.hover();await expect(page.locator('#travel-project-info')).toContainText('12.3 km · 30 min by car');await expect(page.locator('.google-route-attribution')).toBeVisible();
 assert.deepEqual(await snapshot(),before,'Route lookup does not change formulas, prices, inputs or project snapshots');await page.locator('#project-travel').screenshot({path:path.join(output,'travel-synthetic-route.png')});await link.press('Escape');await expect(page.locator('#travel-project-info')).toBeHidden();
 const routeRequests=bodies.length;
 for(const locale of ['zh-Hans','hi','es','ar','th','ko','tl','vi']){
  await page.locator('nav [data-view="settings"]').click();await page.locator('#application-language').selectOption(locale);
  await expect(page.locator('#google-maps-status')).not.toHaveText('Google Maps is configured.');
  await page.locator('nav [data-view="estimate"]').click();await idle();
  await expect(page.locator('#travel-calculate')).not.toHaveText('Check driving route');
  await expect(page.locator('#travel-current-location')).not.toHaveAttribute('placeholder','Enter your current address');
  await expect(page.locator('#travel-current-location')).toHaveValue('Fixture Origin Road, Sydney NSW');
  await expect(link).toHaveText('Fixture Project Road, Sydney NSW');
  await expect(page.locator('.google-route-summary')).toHaveText('Home');
  await link.hover();await expect(page.locator('#travel-project-info p').last(),'provider summary matching an English UI term stays literal').toHaveText('Home');
  await expect(page.locator('#travel-project-info')).not.toContainText('by car');await link.press('Escape');
  assert.deepEqual(await snapshot(),before,'Travel translation preserves source addresses, pricing and calculator data');
  assert.equal(bodies.length,routeRequests,'Language switches do not send route lookups');
 }
 await page.locator('nav [data-view="settings"]').click();await page.locator('#application-language').selectOption('en');await page.locator('nav [data-view="estimate"]').click();await idle();
 evidence.travelLanguages=8;evidence.providerSummaryOwnership=true;
 await page.locator('#travel-use-location').click();await expect(page.locator('#travel-current-location')).toHaveValue('-33.86000, 151.20000');await page.locator('#travel-calculate').click();await expect(page.locator('#travel-duration')).toHaveText('30 min');assert.deepEqual(bodies.at(-1).origin,{latitude:-33.86,longitude:151.2});assert.deepEqual(await snapshot(),before,'GPS stays outside saved project data');
 await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=(_success,error)=>error({code:1,message:'Synthetic permission denial'});});await page.locator('#travel-use-location').click();await expect(page.locator('#travel-status')).toContainText('could not be read');
 await page.locator('#travel-current-location').fill('Fixture origin after denied GPS');
 await page.unroute('**/api/travel/route');let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 await page.route('**/api/travel/route',async r=>{entered();await gate;await r.fulfill({json:{distance_meters:9999,duration_seconds:999,summary:'Stale fixture'}}).catch(()=>{});});
 await page.locator('#travel-calculate').click();await started;await page.locator('#site-address').fill('Different fixture destination');release();await expect(page.locator('#travel-distance')).toHaveText('—');await expect(page.locator('#travel-status')).toContainText('address changed');
 await page.unroute('**/api/travel/route');await page.route('**/api/travel/route',r=>r.fulfill({status:502,json:{error:'Synthetic provider unavailable'}}));await page.locator('#travel-calculate').click();await expect(page.locator('#travel-status')).toHaveText('Synthetic provider unavailable');await expect(page.locator('#travel-distance')).toHaveText('—');
 await chooseTakeoff(page,'Steel');await renderDrawing(page,()=>page.locator('#takeoff-upload').setInputFiles(info.fixture));
 await expect(page.locator('#view-takeoffs')).toHaveCSS('cursor',/cursors\/pointer\.png/);
 await expect(page.locator('main')).toHaveCSS('cursor',/cursors\/pointer\.png/);
 await expect(page.locator('#takeoffs-workspace > .takeoff-workspace-heading')).toHaveCSS('cursor',/cursors\/pointer\.png/);
 await expect(page.locator('.takeoff-workspace-heading .calculator-document-toggle').first()).toHaveCSS('cursor',/cursors\/link\.png/);
 await expect(page.locator('#view-takeoffs input[type="checkbox"]').first()).toHaveCSS('cursor',/cursors\/link\.png/);
 await expect(page.locator('#view-takeoffs input[type="search"]').first()).toHaveCSS('cursor',/cursors\/text\.png/);
 await page.getByRole('button',{name:'Filter Confirmation',exact:true}).click();
 const filterDialog=page.getByRole('dialog',{name:'Filter Confirmation',exact:true});
 await expect(filterDialog).toHaveCSS('cursor',/cursors\/pointer\.png/);
 await expect(filterDialog.getByRole('button',{name:'Apply filter',exact:true})).toHaveCSS('cursor',/cursors\/link\.png/);
 await expect(filterDialog.getByRole('searchbox')).toHaveCSS('cursor',/cursors\/text\.png/);
 await expect(filterDialog.getByRole('checkbox',{name:'Select all values',exact:true})).toHaveCSS('cursor',/cursors\/unavailable\.png/);
 await filterDialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
 const drawing=page.locator('#takeoff-viewport'),box=await drawing.boundingBox();await page.mouse.click(box.x+70,box.y+140);await expect(page.locator('.click-smoke-puff')).toHaveCount(0);
 await expect(drawing).toHaveCSS('cursor',/cursors\/pointer\.png.*6 2, default/);
 for(const [name,asset]of[['Pan','move'],['Select PDF text','text']]){await page.getByRole('button',{name,exact:true}).click();await expect(drawing).toHaveCSS('cursor',new RegExp('cursors/'+asset+'\\.png'));await expect(page.locator('.click-smoke-puff')).toHaveCount(0);}
 await page.locator('.takeoff-markup-rail').getByRole('button',{name:'Rectangle',exact:true}).click();await expect(drawing).toHaveCSS('cursor',/cursors\/precision\.png/);await expect(page.locator('.takeoff-overlay')).toHaveCSS('cursor',/cursors\/precision\.png/);await page.screenshot({path:path.join(output,'pdf-cursor-tools.png')});
 await page.getByRole('button',{name:'Home',exact:true}).click();await expect(page.locator('.click-smoke-puff')).toHaveCount(0);
 await page.getByRole('button',{name:'Home',exact:true}).click();await expect(page.locator('.click-smoke-puff')).toHaveCount(4);await expect(page.locator('.click-smoke-layer')).toHaveCount(0);
 assert.deepEqual(errors,[]);evidence.googleRequests='Synthetic only';evidence.geolocation='Synthetic only';evidence.projectSnapshotsUnchanged=true;evidence.pdfSmokeDisabled=true;evidence.rolesAndHotspotsVerified=true;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));console.log('PASS travel/editor follow-ups: '+output);
})().catch(async e=>{console.error(e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
