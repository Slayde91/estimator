"use strict";
// All records, database files, chooser DOM and browser state are disposable.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {chooseLibrary}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`library-filter-groups-${Date.now()}`);
const locales=['en','zh-Hans','hi','es','ar','th','ko','tl','vi'];
const base=JSON.parse(fs.readFileSync(path.join(root,'static/locales/library-filter-groups.json'),'utf8'));
const extra=JSON.parse(fs.readFileSync(path.join(root,'static/locales/additions/library-filter-groups.json'),'utf8'));
const translated=(source,locale,args=[])=>String(locale==='en'?source:[...base[source],...extra[source]][locales.indexOf(locale)-1]).replace(/\{(\d+)\}/g,(_,n)=>args[n]);
// Independently specified contracts: Technical reference pickers expose the 45
// approved descriptions; the calculator's pricing inputs keep their original 30.
const technicalServiceGroups = [
 ['Electrical & communications',['Busbar Trunking','Cable Bundles','Cable Trays','Coaxial Cables','Conduits','D1 Power Cables','D2 Comms Cables','Data Cables','Downlights','Fibre Optic','Fire Resistant Cables','Power Cables','Single Cables','TPS & Fire Alarm Cables','Communications Cables','Wall Sockets','Smoke Sampling Tubes']],
 ['Mechanical',['Pair Coils','Beverage / Beer Lines','Insulated Gas Lines']],
 ['HVAC',['Fire Dampers','Flexible Ducts','Air Transfer Grilles']],
 ['Plastic pipes',['uPVC pipe','uPVC floorwaste','PEX pipe','HDPE pipe','PP pipe','CPVC pipe','Raupiano Plus pipe','dBlue pipe','PU air line','Concentric plastic pipe','ABS pipe','PB pipe','Kelox / KeKilit pipe']],
 ['Lagged metal pipes',['Lagged Copper Pipes','Lagged Steel Pipes','Lagged Iron Pipes']],
 ['Unlagged metal pipes',['Copper Pipes','Steel Pipes','Unlagged Iron Pipes','Unlagged Brass Pipes']],
];
const technicalServices = ['N/A','Mixed Services',...technicalServiceGroups.flatMap(([,values])=>values)];
const serviceGroups=['Electrical & communications','Mechanical','HVAC','Plastic pipes','Lagged metal pipes','Unlagged metal pipes'];
const sourceFiles=['estimator/library_filter_groups.py','estimator/reference_library.py','estimator/firestopping_library.py','estimator/technical_service_options.py','static/libraries.js','static/libraries.css','static/theme.css','static/laser.css','static/penetration-references.js','static/takeoff-library-links.js','static/language-catalog.js','static/locales/library-filter-groups.json','static/locales/additions/library-filter-groups.json','tests/browser/library_link_picker_fixture.py','tests/browser/library_filter_groups.cjs'];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),bindings=()=>Object.fromEntries(sourceFiles.map(file=>[file,hash(path.join(root,file))]));
const sourceBefore=bindings(),server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'library_link_picker_fixture.py'),'--directory',output,'--filter-groups'],{cwd:root,windowsHide:true});
let logs='',browser,page,info;const evidence={synthetic:true,locales:[],layouts:[],page_errors:[],blocked_requests:[],sourceBefore,original_tabs_accessed:false,takeoff_sessions_created:false};
server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let raw='';const timer=setTimeout(()=>reject(Error(`Fixture startup: ${logs}`)),120000);server.stdout.on('data',value=>{raw+=value;if(raw.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(raw.split('\n')[0]));}catch(error){reject(error);}}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exit ${code}: ${logs}`));});});
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function snapshot(){await idle();return page.evaluate(()=>({calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details(),dirty:window.CeasefireDesktop.status().dirty}));}
const main=()=>page.locator('#technical-library-workspace'),picker=()=>page.locator('.library-link-picker:visible');
async function groupLabels(scope,key,attribute='data-library-filter'){return scope.locator(`select[${attribute}="${key}"] optgroup`).evaluateAll(nodes=>nodes.map(node=>node.label));}
async function checkGroups(scope,locale,attribute){
 assert.deepEqual(await groupLabels(scope,'services',attribute),serviceGroups.map(name=>translated(name,locale)));
 assert.deepEqual(await groupLabels(scope,'frl',attribute),[30,60,90,120,180,240,300].map(value=>translated('{0} minutes',locale,[String(value)])));
 assert.deepEqual(await groupLabels(scope,'report',attribute),['BOSS','Firefly','Promat','Trafalgar']);
 const values=await scope.locator(`select[${attribute}="services"]`).evaluate(node=>[...node.options].map(option=>option.value));
 assert.equal(values.length,46);assert.equal(new Set(values).size,46);assert.deepEqual(values,['',...technicalServices]);
 const groups=await scope.locator(`select[${attribute}="services"] optgroup`).evaluateAll(nodes=>nodes.map(group=>[group.label,[...group.children].map(option=>option.value)]));
 assert.deepEqual(groups,technicalServiceGroups.map(([label,options])=>[translated(label,locale),options]));
 const standalone=await scope.locator(`select[${attribute}="services"] > option`).evaluateAll(nodes=>nodes.map(node=>node.value));assert.deepEqual(standalone,['','N/A','Mixed Services']);
}
async function layout(scope,label,locale,width){
 await page.setViewportSize({width,height:900});await scope.scrollIntoViewIfNeeded();
 const geometry=await scope.evaluate(root=>({overflow:document.documentElement.scrollWidth-innerWidth,controls:[...root.querySelectorAll('select')].map(node=>{const b=node.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width};})}));
 assert.ok(geometry.overflow<=1,`${label}/${locale}/${width}: no viewport overflow`);assert.ok(geometry.controls.every(box=>box.left>=-1&&box.right<=width+1),`${label}/${locale}/${width}: native controls fit`);
 evidence.layouts.push({label,locale,width,...geometry});
 if(['en','ar'].includes(locale))await page.screenshot({path:path.join(output,`${label}-${locale}-${width}.png`),fullPage:true});
}
async function setFilter(scope,key,value,attribute='data-library-filter',limit='50'){
 const waiting=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/libraries/technical'&&(value?url.searchParams.get(key)===value:!url.searchParams.has(key))&&url.searchParams.get('limit')===limit;});
 await scope.locator(`select[${attribute}="${key}"]`).selectOption(value);const response=await waiting;assert.equal(response.status(),200);const data=await response.json();
 await expect(scope.locator(attribute==='data-library-filter'?'.library-results':'.library-link-results')).toHaveAttribute('aria-busy','false');return data;
}
async function activeFilterPaint(scope,key,attribute='data-library-filter'){
 const control=scope.locator(`select[${attribute}="${key}"]`),read=()=>control.evaluate(node=>{const s=getComputedStyle(node);return{border:s.borderColor,shadow:s.boxShadow,focused:document.activeElement===node};});
 const checks=[];
 for(const theme of [null,'ceasefire','midnight','ocean','forest','slate']){
  await page.locator('html').evaluate((node,theme)=>{if(theme===null)node.removeAttribute('data-theme');else node.dataset.theme=theme;},theme);
  await control.focus();await expect(control).toHaveCSS('border-color','rgb(241, 13, 27)');await expect(control).toHaveCSS('box-shadow',/241, 13, 27/);checks.push({theme,focused:await read()});
  await control.press('Tab');await expect(control).not.toBeFocused();await expect(control).toHaveCSS('border-color','rgb(241, 13, 27)');await expect(control).toHaveCSS('box-shadow',/241, 13, 27/);checks.push({theme,unfocused:await read()});
 }
 await page.locator('html').evaluate(node=>node.dataset.theme='ceasefire');return checks;
}
(async()=>{
 info=await ready;assert.notEqual(info.port,8765);assert.equal(path.resolve(info.directory),output);const index=path.join(info.library,'library.json'),indexBefore=hash(index),origin=`http://127.0.0.1:${info.port}`;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(60000);
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url()),method=request.method(),pure=method==='POST'&&(['/api/calculate','/api/penetration/calculate','/api/penetration/definition','/api/penetration/references'].includes(url.pathname)||/^\/api\/calculators\/(?:steel_vermiculite|steel_board|steel_intumescent|ductwork)\/(?:worksheet|calculate)$/.test(url.pathname));if(url.origin===origin&&(['GET','HEAD'].includes(method)||pure))return route.continue();evidence.blocked_requests.push({method,path:url.pathname});return route.abort('blockedbyclient');});
 page.on('pageerror',error=>evidence.page_errors.push(error.message));await page.goto(origin);await expect(page.locator('#view-home')).toBeVisible();await idle();await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});
 const before=await snapshot();await chooseLibrary(page,'technical');await expect(main().locator('[data-library-filter="report"]')).toBeVisible();
 for(const locale of locales){await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);await checkGroups(main(),locale,'data-library-filter');for(const width of [1146,390])await layout(main(),'main',locale,width);assert.deepEqual(await snapshot(),before);evidence.locales.push(locale);}
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await page.setViewportSize({width:1146,height:900});
 evidence.mainFilterGrid=await main().locator('.library-filters').evaluate(node=>{const s=getComputedStyle(node);return{display:s.display,columns:s.gridTemplateColumns,width:node.getBoundingClientRect().width};});assert.equal(evidence.mainFilterGrid.display,'grid');
 // The Firestopping schedule reference picker uses the same renderer and exact
 // authoritative choices. No schedule selection is applied by this check.
 const referenceKeys=['report','substrate','services','frl'],choices=control=>control.locator('option').evaluateAll(nodes=>nodes.filter(node=>node.value).map(node=>({value:node.value,label:node.textContent,group:node.parentElement.tagName==='OPTGROUP'?node.parentElement.label:''})));
 const initialFilters=Object.fromEntries(await Promise.all(referenceKeys.map(async key=>[key,(await choices(main().locator(`[data-library-filter="${key}"]`))).find(option=>option.group).value])));
 await page.evaluate(initial_filters=>{window.__referenceGroupPicker=window.CeasefirePenetrationReferences.open({reference:{systems:[],initial_filters},apply:async()=>{throw Error('This read-only group fixture must never apply a reference');}});},initialFilters);
 const references=page.locator('.penetration-reference-picker');await expect(references.locator('[data-penetration-reference-apply]')).toBeEnabled();
 for(const locale of locales){
  await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);
  for(const key of referenceKeys){
   const control=references.locator(`[data-penetration-reference-filter="${key}"]`),expected=await choices(main().locator(`[data-library-filter="${key}"]`));
   assert.deepEqual(await choices(control),expected,`${key}/${locale}: reference picker matches main Library values, labels, groups and order`);await expect(control).toHaveValue(initialFilters[key]);
   assert.ok(await control.locator('optgroup').count()>0,`${key}/${locale}: native option groups remain present`);
  }
  if(['en','ar'].includes(locale))for(const width of [1146,390])await layout(references,'references',locale,width);
 }
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await references.getByRole('button',{name:'Cancel',exact:true}).click();await page.evaluate(()=>window.__referenceGroupPicker);assert.deepEqual(await snapshot(),before);evidence.referencePickerMatchesAllGroupedFacets=true;
 await page.setViewportSize({width:1146,height:900});
 await setFilter(main(),'services','Pair Coils');await expect(main().locator('[data-library-record]')).toHaveCount(0);
 evidence.activeFilterPaint=await activeFilterPaint(main(),'services');await setFilter(main(),'services','');
 await expect(main().locator('[data-library-filter="services"]')).not.toHaveClass(/library-filter-active/);await expect(main().locator('[data-library-filter="services"]')).not.toHaveCSS('border-color','rgb(241, 13, 27)');
 await setFilter(main(),'report','Promat synthetic report');const queried=await setFilter(main(),'frl','-/90/60');assert.equal(queried.total,2);await expect(main().locator('[data-library-record]')).toHaveCount(2);assert.deepEqual(await main().locator('[data-library-record]').evaluateAll(nodes=>nodes.map(node=>node.dataset.libraryRecord)),queried.items.map(item=>item.id));
 await main().locator('[data-library-record]').first().click();await main().getByRole('button',{name:'Back to results',exact:true}).click();await expect(main().locator('[data-library-filter="report"]')).toHaveValue('Promat synthetic report');await expect(main().locator('[data-library-filter="frl"]')).toHaveValue('-/90/60');
 evidence.exactGroupedQueriesAndBack=true;
 // Numeric supplier selector IDs are hidden; actual technical IDs are retained,
 // including Promat and Trafalgar records. All API identities remain exact.
 for(const [id,hidden]of [['technical-001',true],['technical-002',true],['technical-003',false],['technical-004',false],['technical-005',false],['technical-006',false]]){
  const response=await page.request.get(`${origin}/api/libraries/technical/${id}`);assert.equal(response.status(),200);const data=await response.json();assert.equal(data.id,id);assert.ok(data.fields.some(field=>field.label==='ID'));
  await page.evaluate(id=>window.CeasefireLibraries.open('technical',id),id);await expect(main().locator('h3')).toHaveText(data.title);
  const field=main().locator('.library-record-field').filter({has:page.locator('dt').filter({hasText:/^ID$/})});
  await expect(field).toHaveCount(hidden?0:1);if(!hidden)await expect(field.locator('dd')).toHaveText(data.fields.find(field=>field.label==='ID').value);
 }
 evidence.technicalIDFieldOnlyOmission=true;
 await chooseLibrary(page,'penetration');const penetration=page.locator('#penetration-library-workspace');
 await expect(penetration.locator('[data-library-filter="service_type"]')).toBeVisible();
 evidence.firestoppingFilterGrid=await penetration.locator('.library-filters').evaluate(node=>{const s=getComputedStyle(node);return{display:s.display,columns:s.gridTemplateColumns,width:node.getBoundingClientRect().width};});assert.deepEqual(evidence.firestoppingFilterGrid,evidence.mainFilterGrid,'Both eight-filter bars use the same responsive grid');
 await penetration.locator('[data-library-filter="service_type"]').selectOption('Pair Coils');await expect(penetration.locator('[data-library-filter="service_type"]')).toHaveClass(/library-filter-active/);evidence.firestoppingActiveFilterPaint=await activeFilterPaint(penetration,'service_type');
 await penetration.locator('[data-library-filter="service_type"]').selectOption('');await expect(penetration.locator('[data-library-filter="service_type"]')).not.toHaveClass(/library-filter-active/);
 await penetration.locator(`[data-library-link="${info.item_id}"]`).click();await expect(picker().locator('.library-link-results')).toHaveAttribute('aria-busy','false');
 for(const locale of locales){await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);await checkGroups(picker(),locale,'data-library-link-filter');for(const width of [1146,390])await layout(picker(),'picker',locale,width);assert.deepEqual(await snapshot(),before);}
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));await page.setViewportSize({width:1146,height:900});const selected=await setFilter(picker(),'report','Promat synthetic report','data-library-link-filter','20');await expect(picker().locator('[data-library-link-choice]')).toHaveCount(selected.items.length);evidence.pickerActiveFilterPaint=await activeFilterPaint(picker(),'report','data-library-link-filter');evidence.canonicalReportPickerQueries=true;
 await picker().getByRole('button',{name:'Cancel',exact:true}).click();
 // Exercise the production shared Firestopping chooser renderer in an owned
 // DOM mount, cancelling without a Takeoff session or an import command.
 await page.evaluate(()=>{
  window.__groupMount=document.createElement('section');window.__groupMount.id='synthetic-shared-chooser';document.querySelector('#penetration-library-workspace').append(window.__groupMount);
  window.__groupChooser=window.CeasefireTakeoffLibraryLinks.choose({ask:async(title,fields,message,submit,setup)=>{
   const controls=fields.map(field=>{const label=document.createElement('label'),control=document.createElement(field[0]==='search'?'input':'select');label.className='field';control.name=field[0];label.append(control);window.__groupMount.append(label);return{control};});
   await setup(controls,()=>{});window.__groupChooserReady=true;return await new Promise(resolve=>{window.__cancelGroupChooser=()=>resolve(null);});
  }},true);
 });
 await page.waitForFunction(()=>window.__groupChooserReady===true);const shared=page.locator('#synthetic-shared-chooser');
 const response=await page.request.get(`${origin}/api/libraries/penetration`),data=await response.json(),apiOptions=data.filters.find(field=>field.key==='service_type').options;
 assert.deepEqual(apiOptions.map(option=>option.value).sort(),[...technicalServices].sort(),'Firestopping Library chooser matches the 45 approved Technical Library descriptions; calculator pricing routes remain separate');
 assert.deepEqual(await shared.locator('[data-library-filter="service_type"]').evaluate(node=>[...node.options].slice(1).map(option=>({value:option.value,group:option.parentElement.tagName==='OPTGROUP'?option.parentElement.label:null}))),apiOptions.map(option=>({value:option.value,group:option.group||null})));
 for(const locale of locales){await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);assert.deepEqual(await groupLabels(shared,'service_type'),serviceGroups.map(name=>translated(name,locale)));}
 await page.evaluate(async()=>{window.__cancelGroupChooser();await window.__groupChooser;window.__groupMount.remove();window.CeasefireI18n.setLanguage('en',false);});evidence.sharedChooserGroupsAndLocaleRebinding=true;
 assert.deepEqual(await snapshot(),before);assert.equal(hash(index),indexBefore);assert.deepEqual(bindings(),sourceBefore);assert.deepEqual(evidence.page_errors,[]);assert.deepEqual(evidence.blocked_requests,[]);
 evidence.result='PASS';evidence.sourceIndexUnchanged=true;evidence.draftsUnchanged=true;evidence.sourceAfter=bindings();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({result:'PASS',output,locales:locales.length,layouts:evidence.layouts.length,draftsUnchanged:true}));
})().catch(async error=>{fs.mkdirSync(output,{recursive:true});if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({...evidence,error:String(error),logs},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'server.log'),logs);});
