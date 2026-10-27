// Native explicit reference choices and navigation in an owned synthetic workspace.
const { chromium, expect } = require('@playwright/test');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `register-references-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sources = ['estimator/register_references.py','estimator/reference_library.py','estimator/takeoff_workspace.py','estimator/takeoff_http.py','static/register-references.js','static/takeoff-physical.js','static/takeoffs.js'];
const hash = value => createHash('sha256').update(value).digest('hex'), sourceHashes = Object.fromEntries(sources.map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'register_references_fixture.py'),'--directory',output], {cwd:root,windowsHide:true});
let logs='',browser,page,origin; server.stderr.on('data',value=>{logs+=value;});
const ready=new Promise((resolve,reject)=>{let raw='';const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${logs}`)),120000);server.stdout.on('data',value=>{raw+=value;if(raw.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(raw.split('\n')[0]));}catch(error){reject(error);}}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${logs}`));});});
const errors=[],evidence=[],requests=[];
async function json(url,data){const reply=await page.request[data===undefined?'get':'post'](origin+url,data===undefined?{}:{data});assert.equal(reply.status(),200,await reply.text());return reply.json();}
const idle=()=>expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy','true',{timeout:60000});
const snapshot=async()=>{const session=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());return(await json(`/api/takeoffs/sessions/${session}`)).snapshot;};
const row=id=>page.locator(`tr[data-physical-id="${id}"]`);
async function seed(scope){
  const session=await page.evaluate(()=>window.CeasefireTakeoffs.sessionId());let current=await snapshot();
  const ids={root:randomUUID(),linked:randomUUID(),empty:randomUUID(),filtered:randomUUID(),services:[randomUUID(),randomUUID(),randomUUID()]},commands=[];
  const entity=(id,fields,extra={})=>({id,fields,evidence:[],uncertainty:{state:'not_assessed',note:''},...extra});
  if(scope==='defect_reports')commands.push({op:'create',kind:'defect',entity:entity(ids.root,{label:'Synthetic issue'})});
  for(const[index,key]of['linked','empty','filtered'].entries()){
    commands.push({op:'create',kind:'barrier',entity:entity(ids[key],{label:key},scope==='defect_reports'?{defect_id:ids.root}:{})});
    commands.push({op:'create',kind:'service',entity:entity(ids.services[index],{service:'Electrical & Communications',service_type:'Conduits'},{barrier_id:ids[key],quantity:1})});
  }
  const preview=await json(`/api/takeoffs/sessions/${session}/physical/preview`,{scope,expected_revision:current.revision,commands});
  current=(await json(`/api/takeoffs/sessions/${session}/physical/apply`,{scope,expected_revision:current.revision,request_id:randomUUID(),preview_id:preview.preview_id})).snapshot;
  for(const[index,key,libraryId]of[[0,'linked','pkb-001'],[1,'empty','pkb-002']]){
    const library=await json(`/api/libraries/penetration/${libraryId}/takeoff`);
    current=(await json(`/api/takeoffs/sessions/${session}/commands`,{op:'draft_library_assignment',request_id:randomUUID(),expected_revision:current.revision,assignment:{id:randomUUID(),scope,library_id:libraryId,library_fingerprint:library.metadata_sha256,member_ids:[ids[key],ids.services[index]],installation:{id:randomUUID(),mode:'repeated_installations',note:'Synthetic explicit association'}}})).snapshot;
  }
  await page.evaluate(async value=>{const takeoffs=window.CeasefireTakeoffs;takeoffs.applyProject(await takeoffs.prepareProject(value,takeoffs.sessionId()));await takeoffs.open();},current);
  await chooseTakeoff(page,scope==='service_plans'?'Service Plans':'Defect Reports');await idle();return ids;
}
(async()=>{
  const info=await ready;origin=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1450,height:900}});
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/takeoffs/')&&request.method()==='POST')requests.push({url:new URL(request.url()).pathname,data:request.postDataJSON()});});
  await page.goto(origin);await expect(page.locator('#view-home')).toBeVisible();await expect(page.locator('html')).not.toHaveAttribute('aria-busy','true',{timeout:60000});
  await chooseTakeoff(page,'Service Plans');await idle();
  const source=fs.readFileSync(path.join(info.library,'library.json'));
  for(const scope of['service_plans','defect_reports']){
    const ids=await seed(scope),before=await snapshot(),calculators=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
    const report=row(ids.linked).locator('[data-reference-report-id]'),systems=row(ids.linked).locator('[data-reference-system-id]');
    await expect(report.getByRole('button',{name:'More reports (100 of 103)',exact:true})).toBeVisible();await expect(report.locator('a').first()).toHaveAttribute('href','https://tfire.com.au/documents/synthetic-report.pdf');
    assert.equal(await report.locator('a').count(),99);await report.getByRole('button',{name:'More reports (100 of 103)',exact:true}).click();await expect(report.locator('a')).toHaveCount(102);
    assert.equal((await report.innerText()).split('Private report').length,2);await expect(report.getByRole('button',{name:/More reports/})).toHaveCount(0);await expect(report.getByRole('button',{name:/Choose reports for/})).toHaveText('Change reports');
    await expect(row(ids.empty).locator('[data-reference-report-id]')).toContainText('Choose reports');await expect(row(ids.empty).locator('[data-reference-system-id]')).toHaveText('—');
    await expect(systems.getByRole('button',{name:'More systems (100 of 102)',exact:true})).toBeVisible();
    await systems.getByRole('button',{name:'More systems (100 of 102)',exact:true}).click();await expect(systems.locator('[data-technical-reference]')).toHaveCount(102);
    const content=await systems.innerText();assert.ok(!content.includes('Alpha-'));assert.ok(content.endsWith('101 | 102'),content);
    await expect(row(ids.filtered).locator('[data-reference-system-id]')).toHaveText('—');
    await expect(row(ids.filtered).locator('[data-reference-report-id]')).toContainText('Choose reports');
    const header=await page.locator('.takeoff-register-table thead th').allTextContents();assert.deepEqual(header.slice(-3),['Report','System','Delete']);assert.ok(!header.includes('Source evidence'));
    const start=requests.length;
    const detail=page.waitForResponse(response=>response.url().endsWith('/api/libraries/technical/synthetic-000'));
    await systems.locator('[data-technical-reference="synthetic-000"]').click();assert.equal((await detail).status(),200);
    await expect(page.locator('#technical-library-detail-heading')).toBeVisible();
    assert.deepEqual(await snapshot(),before);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
    assert.ok(requests.slice(start).every(request=>request.url.endsWith('/register-references')),'Reference navigation must create no Takeoff operation.');
    await chooseTakeoff(page,scope==='service_plans'?'Service Plans':'Defect Reports');await idle();
    assert.deepEqual(await snapshot(),before);
    const choose=row(ids.filtered).locator('[data-physical-references]');await choose.click();
    const picker=page.getByRole('dialog',{name:'Choose Technical Library references',exact:true});await expect(picker).toBeVisible();await expect(picker.locator('[data-penetration-reference-choice]:checked')).toHaveCount(0);await picker.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(await snapshot(),before);
    await choose.click();await expect(picker).toBeVisible();await picker.locator('[data-penetration-reference-choice="synthetic-001"]').check();await picker.getByRole('button',{name:'Use selected references',exact:true}).click();await expect(picker).toHaveCount(0);await idle();
    await expect(row(ids.filtered).locator('[data-reference-report-id]')).toContainText('SYN-001 Rev A');await expect(row(ids.filtered).locator('[data-physical-references]')).toHaveText('Change reports');
    const chosen=await snapshot(),key=scope==='service_plans'?'service_plans':'physical';assert.deepEqual(chosen[key].barriers.find(value=>value.id===ids.filtered).technical_reference_ids,['synthetic-001']);
    const roundtrip=JSON.parse(JSON.stringify(chosen));await page.evaluate(async value=>{const takeoffs=window.CeasefireTakeoffs;takeoffs.applyProject(await takeoffs.prepareProject(value,takeoffs.sessionId()));await takeoffs.open();},roundtrip);await chooseTakeoff(page,scope==='service_plans'?'Service Plans':'Defect Reports');await idle();
    assert.deepEqual((await snapshot())[key],chosen[key]);await expect(row(ids.filtered).locator('[data-physical-references]')).toHaveText('Change reports');
    evidence.push({scope,linkedSystems:102,linkedReports:103,reportPages:[100,3],manualCandidates:0,explicitEmptyWins:true,sequentialNumbersStable:true,reportCaptionsUnique:true,publicURL:true,privateCaption:true,navigationTarget:'synthetic-000',navigationDraftsUnchanged:true,chooseCancelUnchanged:true,selectedSystem:'synthetic-001',portableRoundtrip:true});
  }
  assert.deepEqual(fs.readFileSync(path.join(info.library,'library.json')),source);for(const[name,sha]of Object.entries(sourceHashes))assert.equal(hash(fs.readFileSync(path.join(root,name))),sha);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,port:info.port,evidence,sourceHashes,errors},null,2));console.log(`PASS: Linked references, explicit manual selection/cancel and portable roundtrip in both physical scopes; safe exact links, pagination and no navigation draft changes. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-3000));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.message,evidence,errors},null,2));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
