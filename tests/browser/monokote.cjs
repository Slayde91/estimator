const { clickProjectControl } = require('./project_actions.cjs');
// Rendered manual-input regression. Default evidence is wholly synthetic.
const {chromium, expect} = require('@playwright/test');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const privateEvidence = Boolean(process.env.CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY);
const output = path.resolve(process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(privateEvidence ? os.tmpdir() : path.join(root, '.runtime/browser-qa'), `monokote-${Date.now()}`));
function within(folder, target) {const relative=path.relative(folder,target);return relative==='' || relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);}
if (privateEvidence && within(root,output)) throw new Error('Private evidence QA output must remain outside the source checkout.');
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname, 'monokote_fixture.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs = '', browser, page, fixtureInfo;
server.stderr.on('data', data => {logs += data;});
const ready = new Promise((resolve, reject) => {
  let stdout=''; const timer=setTimeout(()=>reject(new Error(`Startup timeout: ${logs}`)),120000);
  server.stdout.on('data', data=>{stdout+=data;if(stdout.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(stdout.split('\n')[0]));}catch(error){reject(error);}}});
  server.once('exit', code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${logs}`));});
});
const errors=[], journeys=[], pfcJourneys=[];
const control = (sheet,address) => page.locator(`[data-calculator-sheet="${sheet}"][data-calculator-cell="${address}"]`);
const rendered = address => page.locator(`[data-calculator-output="${address}"]`);
const values = result => Object.fromEntries(result.rows.flatMap(row=>row.cells.map(cell=>[cell.address,cell.value])));
function closeNumber(actual, expected, name) {assert.equal(typeof actual,'number',name);assert.ok(Math.abs(actual-expected)<1e-9,`${name}: ${actual} != ${expected}`);}
async function idle() {await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');await expect(page.locator('#calculator-calculation-status')).toBeHidden();}
async function tab(name) {await page.locator('#calculator-pages').getByRole('button',{name,exact:true}).click();await expect(page.locator('#calculator-sheet-title')).toHaveText(name);await idle();}
async function fill(sheet, fields) {
  for(const [address,value] of Object.entries(fields)){
    const field=control(sheet,address);
    if(await field.evaluate(element=>element.tagName)==='SELECT') {await field.focus();await field.selectOption(String(value));} else await field.fill(String(value));
  }
}
async function recalculate(sheet) {
  const pending=page.waitForResponse(response=>response.url().endsWith('/steel_vermiculite/worksheet') && response.request().postDataJSON()?.sheet===sheet);
  await page.locator('#calculator-recalculate').click();const response=await pending;
  assert.equal(response.status(),200);const result=await response.json();await idle();return values(result);
}
async function apiReply(action,suffix) {
  const pending=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(suffix));
  await action();const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));return body;
}
async function screenshot(name,fixture) {
  if(fixture.synthetic) await page.evaluate(()=>{document.title='SYNTHETIC TEST DATA — NOT FOR DESIGN';let label=document.getElementById('synthetic-qa-label');if(!label){label=document.createElement('p');label.id='synthetic-qa-label';label.textContent='SYNTHETIC TEST DATA — NOT FOR DESIGN';document.body.prepend(label);}});
  await page.screenshot({path:path.join(output,name),fullPage:true});
}
(async()=>{
  const info=await ready,fixture=JSON.parse(fs.readFileSync(path.join(output,'monokote-fixture.json'),'utf8'));fixtureInfo=fixture;
  assert.equal(fixture.synthetic,!privateEvidence);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',event=>window.qaCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  const initial=await page.goto(`http://127.0.0.1:${info.port}/`);assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await page.getByLabel('Project No.',{exact:true}).fill(fixture.synthetic?'SYNTHETIC-MONOKOTE-QA':'PRIVATE-MONOKOTE-QA');
  await page.getByRole('button',{name:'Calculators',exact:true}).click();
  await expect(page.locator('#calculator-title')).toHaveText('Steel (spray)');await idle();
  await expect(rendered('A285')).toContainText('FAR4856 Issue 2 governs thickness');
  await expect(rendered('A285')).toContainText('Hp/A and ESA/M');
  await expect(rendered('A289')).toContainText('columns only');
  await expect(page.locator('#calculator-pages').getByRole('button',{name:'LOOKUP',exact:true})).toHaveCount(0);
  const thickness=fixture.named_case_thickness;
  const products=[['MONOKOTE MK-6 HY',21.8,344],['MONOKOTE Z106',22.2,325]];
  await tab('SCHEDULE');
  for(const [index,[product,mass,density]] of products.entries()){
    const row=index+10;if(index) await page.getByRole('button',{name:'Add row',exact:true}).click();
    await fill('SCHEDULE',{[`A${row}`]:`SYNTHETIC-${index+1}`,[`B${row}`]:product,[`C${row}`]:'Hollow - 4 sides',[`D${row}`]:550,[`E${row}`]:'Section',[`F${row}`]:'100X100X9SHS',[`H${row}`]:120,[`I${row}`]:2,[`J${row}`]:3});
    const result=await recalculate('SCHEDULE');
    closeNumber(result[`P${row}`],thickness,'schedule thickness');closeNumber(result[`S${row}`],result[`R${row}`]*thickness/1000,'schedule volume');closeNumber(result[`T${row}`],result[`S${row}`]/(mass/density),'schedule bags');assert.equal(result[`U${row}`],Math.ceil(result[`T${row}`]));assert.match(result[`W${row}`],/QUANTIFIED/);
    journeys.push({product,thickness,netBags:result[`T${row}`],schedule:true});
    console.log(`Verified schedule: ${product}.`);
  }
  await page.getByRole('button',{name:'Add row',exact:true}).click();
  await fill('SCHEDULE',{A12:'SYNTHETIC-BLOCKED',B12:'MONOKOTE Z106',C12:'Hollow - 4 sides',D12:650,E12:'Hp/A',G12:250,H12:240,I12:1,J12:1,K12:1});
  let scheduled=await recalculate('SCHEDULE');
  for(const address of ['O12','P12','S12','T12','U12']) assert.equal(scheduled[address],'',`blocked schedule ${address}`);
  assert.match(scheduled.V12,/BLOCKED - SOURCE REVIEW/);await expect(rendered('Y12')).toContainText('BLOCKED - SOURCE REVIEW');
  await page.getByRole('button',{name:'Add row',exact:true}).click();
  for(const [product,mass,density] of products) {
    await fill('SCHEDULE',{A13:'SYNTHETIC-PFC',B13:product,C13:'PFC web to slab - 3 sides',D13:620,E13:'Section',F13:'250X90PFC',H13:120,I13:2,J13:3});
    scheduled=await recalculate('SCHEDULE');
    closeNumber(scheduled.O13,19,'PFC published thickness');closeNumber(scheduled.P13,19,'PFC estimating thickness');
    closeNumber(scheduled.S13,scheduled.R13*19/1000,'PFC volume');closeNumber(scheduled.T13,scheduled.S13/(mass/density),'PFC bags');
    assert.equal(scheduled.V13,'PUBLISHED - TABLE LOOKUP');assert.equal(scheduled.W13,'QUANTIFIED - ESTIMATE');assert.equal(scheduled.X13,'MK6-030521 p15');
    await fill('SCHEDULE',{H13:30});const unsupported=await recalculate('SCHEDULE');
    for(const address of ['O13','P13','S13','T13','U13']) assert.equal(unsupported[address],'',`unsupported PFC ${address}`);
    assert.equal(unsupported.V13,'NO GENERIC FACTOR TABLE');assert.equal(unsupported.W13,'THICKNESS NOT AVAILABLE');
    pfcJourneys.push({product,thickness:19,netBags:scheduled.T13,source:scheduled.X13,unsupported30MinutesWithheld:true});
    await fill('SCHEDULE',{H13:120});scheduled=await recalculate('SCHEDULE');
  }
  await expect(rendered('Y13')).not.toContainText('CALCULATION ERROR');
  await screenshot('schedule.png',fixture);
  const orderProducts=['CAFCO 300','MANDOLITE CP2','FENDOLITE MII','PERLIFOC HP ECO+','MONOKOTE MK-6 HY','MONOKOTE Z106'];
  await expect(page.locator('#calculator-product-totals')).toHaveCount(0);
  await tab('SUMMARY');
  await expect(page.locator('#calculator-product-totals tbody th')).toHaveText(orderProducts);
  await expect(page.getByRole('table',{name:'PRODUCT ORDER SUMMARY',exact:true})).toHaveCount(0);
  await expect(page.locator('#calculator-product-totals')).toContainText('PRODUCT SUMMARY');
  const metrics=page.locator('#calculator-product-totals .calculator-summary-metric');
  assert.equal(await metrics.count(),3);
  await screenshot('summary-alignment.png',fixture);
  await tab('SETTINGS');
  await page.getByRole('button',{name:'MONOKOTE Z106',exact:true}).click();
  for(const row of [561,562,563,564]) {
    await expect(control('SETTINGS',`D${row}`)).toBeVisible();
    await expect(control('SETTINGS',`D${row}`)).toHaveCSS('text-align','left');
  }
  await expect(rendered('D565')).toBeVisible();await expect(rendered('D565')).toHaveCSS('text-align','left');
  await expect(rendered('D568')).toContainText('FAR4856 Issue 2');
  await screenshot('z106-settings-alignment.png',fixture);
  await page.getByRole('button',{name:'MONOKOTE MK-6 HY',exact:true}).click();
  for(const [address,text] of Object.entries({D261:'350–750 (discrete)',E261:'30',F261:'365',G261:'30, 60, 90, 120, 180, 240',J261:'FAR4856 Issue 2; Hp/A / converted'})) {
    await expect(rendered(address)).toBeVisible();await expect(rendered(address)).toHaveText(text);
  }
  await expect(rendered('A262')).toHaveText('PFC web to slab - 3 sides');
  await expect(rendered('E262')).toHaveText('Named only');await expect(rendered('F262')).toHaveText('Named only');
  await expect(rendered('L262')).toContainText('no generic factor table');
  await screenshot('monokote-coverage.png',fixture);
  console.log('Verified all six order products, Z106 alignment, hollow coverage and named-only PFC coverage.');
  await apiReply(()=>clickProjectControl(page, 'Save'),'/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved=JSON.parse(fs.readFileSync(path.join(output,'standard-project.json'),'utf8'));
  const before=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({open:'saved'}));
  await apiReply(()=>clickProjectControl(page, 'Load'),'/api/project/open');
  await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),before);
  assert.equal(saved.version,1);
  await page.getByRole('button',{name:'Calculators',exact:true}).click();await tab('SCHEDULE');
  const reopened=await recalculate('SCHEDULE');
  for(const address of ['P10','T10','P11','T11','P12','T12','V12','O13','P13','S13','T13','V13','W13','X13']) assert.deepEqual(reopened[address],scheduled[address],`reopened ${address}`);
  const exported=await apiReply(()=>page.locator('#calculator-excel').click(),'/register.xlsx');
  assert.equal(exported.saved,true);assert.equal(exported.destination,'project');
  assert.ok(within(output,path.resolve(exported.path)));
  const inspected=spawnSync(python,['-c','import json,sys;from openpyxl import load_workbook;w=load_workbook(sys.argv[1],data_only=False);print(json.dumps({"rows":{s.title:list(s.values) for s in w},"formulas":sum(c.data_type=="f" for s in w for row in s for c in row)}))',exported.path],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(inspected.status,0,inspected.stderr);const workbook=JSON.parse(inspected.stdout);
  assert.equal(workbook.formulas,0);const exportText=JSON.stringify(workbook.rows);assert.match(exportText,/FAR4856 Issue2/);assert.match(exportText,/BLOCKED - SOURCE REVIEW/);assert.match(exportText,/MONOKOTE Z106/);
  for(const index of [0,1]) {
    const row=workbook.rows.Schedule.find(row=>row[2]===`SYNTHETIC-${index+1}`);
    assert.ok(row);closeNumber(row[7],thickness,'exported published thickness');closeNumber(row[8],thickness,'exported estimating thickness');closeNumber(row[10],scheduled[`T${index+10}`],'exported bags');assert.match(row[12],/FAR4856 Issue2 p12 Table 4/);
  }
  const blockedRow=workbook.rows.Schedule.find(row=>row[2]==='SYNTHETIC-BLOCKED');assert.ok(blockedRow);
  for(const index of [7,8,10,11]) assert.equal(blockedRow[index],null,`blocked export column ${index}`);
  const pfcRow=workbook.rows.Schedule.find(row=>row[2]==='SYNTHETIC-PFC');assert.ok(pfcRow);
  closeNumber(pfcRow[7],19,'exported PFC published thickness');closeNumber(pfcRow[8],19,'exported PFC estimating thickness');closeNumber(pfcRow[10],scheduled.T13,'exported PFC bags');assert.match(pfcRow[12],/MK6-030521 p15/);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,...fixture,journeys,pfcJourneys,blockedQuantitiesWithheld:true,schedule:true,pfcSchedule:true,pfcSaveReopen:true,pfcExport:true,allSixProductTotals:true,z106SummaryCentered:true,z106SettingsLeftAligned:true,hollowAssessmentCoverage:true,pfcNamedOnlyCoverage:true,saveReopen:true,valuesOnlyExport:true,errors,csp:[]},null,2));
  console.log(`PASS: ${fixture.evidence_mode}; MONOKOTE hollow/PFC schedule, bags, blocked source, schedule, save/reopen and values-only XLSX. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));if(page)await screenshot('failure.png',fixtureInfo || {synthetic:!privateEvidence}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
