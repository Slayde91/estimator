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
const errors=[], journeys=[];
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
  const initial=await page.goto(`http://127.0.0.1:${info.port}/`);assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));await expect(page.locator('#project-tools')).toBeVisible();
  await page.getByRole('button',{name:'Quote',exact:true}).click();
  await page.getByLabel('Project No.',{exact:true}).fill(fixture.synthetic?'SYNTHETIC-MONOKOTE-QA':'PRIVATE-MONOKOTE-QA');
  await page.getByRole('button',{name:'Calculators',exact:true}).click();
  await expect(page.locator('#calculator-title')).toHaveText('Steel (spray)');await idle();
  await expect(rendered('A285')).toContainText('FAR4856 Issue 2 governs thickness');
  await expect(rendered('A285')).toContainText('Hp/A and ESA/M');
  await expect(rendered('A289')).toContainText('columns only');
  await tab('LOOKUP');
  console.log(`Rendered lookup ready (${fixture.evidence_mode}).`);
  const thickness=fixture.named_case_thickness;
  const products=[['MONOKOTE MK-6 HY',21.8,344],['MONOKOTE Z106',22.2,325]];
  for(const [product,mass,density] of products){
    await fill('CALCULATOR',{D6:product,D7:'Hollow - 4 sides',D8:550,D9:'Section',D10:'100X100X9SHS',D12:120,D14:2,D15:3});
    const result=await recalculate('CALCULATOR');
    closeNumber(result.H6,thickness,'published thickness');closeNumber(result.K14,thickness,'estimating thickness');
    closeNumber(result.K13,125,'upper factor');closeNumber(result.K16,2*3*result.K15,'quantity × length × girth');
    closeNumber(result.K17,result.K16*thickness/1000,'coating volume');closeNumber(result.K18,result.K17/(mass/density),'net bags');
    assert.match(result.H9,/ESTIMATE - UPPER ASSESSMENT ROW/);assert.match(result.H20,/QUANTIFIED/);assert.match(result.H23,/FAR4856 Issue2 p12 Table 4/);
    await expect(rendered('H23')).toBeVisible();await expect(rendered('H23')).toContainText('Fully exposed');
    await expect(rendered('H9')).not.toContainText('CALCULATION ERROR');
    journeys.push({product,thickness,netBags:result.K18,lookup:true});
    console.log(`Verified lookup and bags: ${product}.`);
  }
  await screenshot('lookup.png',fixture);
  await fill('CALCULATOR',{D9:'Hp/A',D11:250,D8:650,D12:240});
  const blocked=await recalculate('CALCULATOR');
  for(const address of ['H6','K14','K17','K18']) assert.equal(blocked[address],'',`blocked ${address}`);
  assert.match(blocked.H9,/BLOCKED - SOURCE REVIEW/);await expect(rendered('H23')).toContainText('No thickness or quantities');
  await screenshot('blocked.png',fixture);
  console.log('Verified blocked lookup withholds quantities.');
  await tab('SCHEDULE');
  for(const [index,[product,mass,density]] of products.entries()){
    const row=index+10;if(index) await page.getByRole('button',{name:'Add row',exact:true}).click();
    await fill('SCHEDULE',{[`A${row}`]:`SYNTHETIC-${index+1}`,[`B${row}`]:product,[`C${row}`]:'Hollow - 4 sides',[`D${row}`]:550,[`E${row}`]:'Section',[`F${row}`]:'100X100X9SHS',[`H${row}`]:120,[`I${row}`]:2,[`J${row}`]:3});
    const result=await recalculate('SCHEDULE');
    closeNumber(result[`P${row}`],thickness,'schedule thickness');closeNumber(result[`S${row}`],result[`R${row}`]*thickness/1000,'schedule volume');closeNumber(result[`T${row}`],result[`S${row}`]/(mass/density),'schedule bags');assert.equal(result[`U${row}`],Math.ceil(result[`T${row}`]));assert.match(result[`W${row}`],/QUANTIFIED/);
    console.log(`Verified schedule: ${product}.`);
  }
  await page.getByRole('button',{name:'Add row',exact:true}).click();
  await fill('SCHEDULE',{A12:'SYNTHETIC-BLOCKED',B12:'MONOKOTE Z106',C12:'Hollow - 4 sides',D12:650,E12:'Hp/A',G12:250,H12:240,I12:1,J12:1,K12:1});
  const scheduled=await recalculate('SCHEDULE');
  for(const address of ['O12','P12','S12','T12','U12']) assert.equal(scheduled[address],'',`blocked schedule ${address}`);
  assert.match(scheduled.V12,/BLOCKED - SOURCE REVIEW/);await expect(rendered('Y12')).toContainText('BLOCKED - SOURCE REVIEW');
  await screenshot('schedule.png',fixture);
  await apiReply(()=>page.getByRole('button',{name:'Save As',exact:true}).click(),'/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved=JSON.parse(fs.readFileSync(path.join(output,'standard-project.json'),'utf8'));
  const before=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({open:'saved'}));
  await apiReply(()=>page.getByRole('button',{name:'Load',exact:true}).click(),'/api/project/open');
  await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),before);
  assert.equal(saved.version,1);
  await page.getByRole('button',{name:'Calculators',exact:true}).click();await tab('SCHEDULE');
  const reopened=await recalculate('SCHEDULE');
  for(const address of ['P10','T10','P11','T11','P12','T12','V12']) assert.deepEqual(reopened[address],scheduled[address],`reopened ${address}`);
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
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,...fixture,journeys,blockedQuantitiesWithheld:true,schedule:true,saveReopen:true,valuesOnlyExport:true,errors,csp:[]},null,2));
  console.log(`PASS: ${fixture.evidence_mode}; MONOKOTE lookup, bags, blocked source, schedule, save/reopen and values-only XLSX. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));if(page)await screenshot('failure.png',fixtureInfo || {synthetic:!privateEvidence}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
