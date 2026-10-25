const { clickProjectControl } = require('./project_actions.cjs');
const { chooseCalculator } = require('./calculator_actions.cjs');
// Rendered manual-input regression. Default evidence is wholly synthetic.
const {chromium, expect} = require('@playwright/test');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sourcePaths = ['static/calculators.js', 'data/calculators/index.json', 'data/calculators/steel_vermiculite.json.gz',
  'estimator/workbook_calculators.py', 'estimator/workbook_runtime.py', 'estimator/calculator_defaults.py',
  'estimator/excel_engine.py', 'estimator/calculator_register.py', 'estimator/schedule_workbook.py'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const sourceBefore = sourceHashes();
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
let schedulePresentation, applicationBasis;
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
function savedCalculatorRows() {
  const result=spawnSync(python,['-c','import json,sqlite3,sys;db=sqlite3.connect(sys.argv[1]);print(json.dumps(db.execute("SELECT * FROM calculator_states ORDER BY id").fetchall()))',path.join(output,'qa.sqlite3')],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
async function selectBasis(product, address, wasteRow, mode) {
  await tab('SETTINGS');await page.getByRole('button',{name:product,exact:true}).click();
  const select=control('SETTINGS',address);await expect(select).toBeVisible();
  await expect(select).toHaveJSProperty('tagName','SELECT');
  await expect(select.locator('option')).toHaveText(['Injected','Uninjected']);
  assert.deepEqual(await select.locator('option').evaluateAll(options=>options.map(option=>option.value)),['Injected','Uninjected']);
  const placement=await select.evaluate(element=>({row:element.closest('tr').dataset.sourceRow,
    previous:element.closest('tr').previousElementSibling?.dataset.sourceRow,
    label:element.closest('tr').textContent}));
  assert.equal(placement.row,address.slice(1));assert.equal(placement.previous,String(wasteRow));
  assert.match(placement.label,/Spray application basis/);
  await select.focus();await select.selectOption(mode);await idle();await expect(select).toHaveValue(mode);
  const result=await recalculate('SETTINGS'),used=address==='D569'?'D238':'D565';await expect(rendered(used)).toBeVisible();
  closeNumber(result[used],(address==='D569'?21.8/344:22.2/325)*(address==='D569' && mode==='Injected'?40/27:1),'selected method yield');
  return {...placement,mode,yield:result[used]};
}
async function screenshot(name,fixture) {
  if(fixture.synthetic) await page.evaluate(()=>{document.title='SYNTHETIC TEST DATA — NOT FOR DESIGN';let label=document.getElementById('synthetic-qa-label');if(!label){label=document.createElement('p');label.id='synthetic-qa-label';label.textContent='SYNTHETIC TEST DATA — NOT FOR DESIGN';document.body.prepend(label);}});
  await page.screenshot({path:path.join(output,name),fullPage:true});
}
(async()=>{
  const info=await ready,fixture=JSON.parse(fs.readFileSync(path.join(output,'monokote-fixture.json'),'utf8'));fixtureInfo=fixture;
  assert.ok(Number.isInteger(info.port) && info.port>0 && info.port!==8765,'Monokote browser uses an isolated ephemeral port');
  assert.equal(fixture.synthetic,!privateEvidence);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',event=>window.qaCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  const initial=await page.goto(`http://127.0.0.1:${info.port}/`);assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await page.getByLabel('Project No.',{exact:true}).fill(fixture.synthetic?'SYNTHETIC-MONOKOTE-QA':'PRIVATE-MONOKOTE-QA');
  await chooseCalculator(page,'Steel (spray)');
  await expect(page.locator('#calculator-title')).toHaveText('Steel (spray)');await idle();
  // START is intentionally hidden; its complete operating rules still exist
  // in the worksheet response and must retain the reviewed hollow scope.
  const coverageReply=await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/steel_vermiculite/worksheet`,{data:{sheet:'SETTINGS'}});
  assert.equal(coverageReply.status(),200);const coverage=(await coverageReply.json()).display_text;
  assert.match(coverage.A285,/FAR4856 Issue 2 governs thickness/);assert.match(coverage.A285,/Hp\/A and ESA\/M/);assert.match(coverage.A289,/columns only/);
  for(const address of ['A285','A289'])await expect(rendered(address)).toHaveCount(0);
  await expect(page.locator('#calculator-pages').getByRole('button',{name:'START',exact:true})).toHaveCount(0);
  await expect(page.locator('#calculator-pages').getByRole('button',{name:'LOOKUP',exact:true})).toHaveCount(0);
  const thickness=fixture.named_case_thickness;
  const products=[['MONOKOTE MK-6 HY',21.8,344],['MONOKOTE Z106',22.2,325]];
  await tab('SCHEDULE');
  const sourceDefinition = await (await page.request.get(`http://127.0.0.1:${info.port}/api/calculators/steel_vermiculite`)).json();
  const sourceSheet = sourceDefinition.sheets.find(sheet => sheet.name === 'SCHEDULE');
  const sourceColumn = number => number === 27 ? 'AA' : String.fromCharCode(64 + number);
  const displayColumns = ['Z','AA','A','E','F','C','D','B','H','I','J','G','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y'];
  const scheduleTable = page.locator('#calculator-grid .calculator-schedule-table');
  const fieldLabels = Object.fromEntries(sourceDefinition.schedule.columns.map(field => [field.column, field.label]));
  const reportIndex = displayColumns.indexOf('V');
  await expect(scheduleTable.locator('thead th')).toHaveText([...displayColumns.slice(0,reportIndex).map(column => fieldLabels[column]), 'Report', ...displayColumns.slice(reportIndex).map(column => fieldLabels[column]), 'Actions']);
  const rowAddresses = await scheduleTable.locator('tbody tr[data-source-row="10"] td').evaluateAll(cells => cells
    .map(cell => cell.querySelector('[data-calculator-cell]')?.dataset.calculatorCell || cell.dataset.calculatorOutput).filter(Boolean));
  assert.deepEqual(rowAddresses, displayColumns.map(column => `${column}10`));
  const originalOrder = sourceSheet.display_column_order.map(sourceColumn);
  assert.deepEqual(originalOrder, ['Z','AA',...Array.from({length:25},(_,index) => sourceColumn(index+1))]);
  schedulePresentation = {originalOrder, displayColumns, sourceWorkbook:sourceDefinition.source, sourceSchema:sourceDefinition.schedule.columns.map(({column,label,editable}) => ({column,label,editable})), rowAddresses};
  for(const [index,[product,mass,density]] of products.entries()){
    const row=index+10;if(index) await page.getByRole('button',{name:'Add row',exact:true}).click();
    await fill('SCHEDULE',{[`A${row}`]:`SYNTHETIC-${index+1}`,[`B${row}`]:product,[`C${row}`]:'Hollow - 4 sides',[`D${row}`]:550,[`E${row}`]:'Section',[`F${row}`]:'100X100X9SHS',[`H${row}`]:120,[`I${row}`]:2,[`J${row}`]:3});
    const result=await recalculate('SCHEDULE');
    closeNumber(result[`P${row}`],thickness,'schedule thickness');closeNumber(result[`S${row}`],result[`R${row}`]*thickness/1000,'schedule volume');closeNumber(result[`T${row}`],result[`S${row}`]/(mass/density),'schedule bags');assert.equal(result[`U${row}`],Math.ceil(result[`T${row}`]));assert.match(result[`W${row}`],/QUANTIFIED/);
    journeys.push({product,thickness,netBags:result[`T${row}`],schedule:true});
    console.log(`Verified schedule: ${product}.`);
  }
  // Save the uninjected baseline, then export a genuinely unsaved Injected
  // draft. All files remain in the disposable project's own directory.
  const baseline=await recalculate('SCHEDULE');
  await apiReply(()=>clickProjectControl(page,'Save'),'/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const savedPath=path.join(output,'standard-project.cf.json'),savedBytes=fs.readFileSync(savedPath),savedRows=savedCalculatorRows();
  const placements=[];
  placements.push(await selectBasis('MONOKOTE MK-6 HY','D569',237,'Injected'));
  placements.push(await selectBasis('MONOKOTE Z106','D570',564,'Injected'));
  await tab('SCHEDULE');const injected=await recalculate('SCHEDULE');
  closeNumber(injected.T10,baseline.T10*27/40,'MK6 injected bags');
  for(const address of ['O10','P10','R10','S10','V10','W10','X10','P11','R11','S11','T11','U11','V11','W11','X11']) assert.deepEqual(injected[address],baseline[address],`basis preserves ${address}`);
  const draft=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  assert.equal(draft.steel_vermiculite.inputs.SETTINGS.D569,'Injected');assert.equal(draft.steel_vermiculite.inputs.SETTINGS.D570,'Injected');
  await expect(page.locator('#project-save-state')).not.toHaveText('Saved project');
  const exportedDrafts=[];
  for(const [id,suffix,magic] of [['calculator-pdf','report.pdf','%PDF'],['calculator-summary-pdf','summary.pdf','%PDF'],['calculator-excel','register.xlsx','PK']]) {
    await page.getByRole('button',{name:'Document',exact:true}).click();
    const pending=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith(`/steel_vermiculite/${suffix}`));
    const exported=await apiReply(()=>page.locator(`#${id}`).click(),`/${suffix}`),request=await pending;
    assert.equal(exported.saved,true);assert.equal(exported.destination,'project');assert.ok(within(output,path.resolve(exported.path)));
    assert.ok(fs.readFileSync(exported.path).subarray(0,4).toString().startsWith(magic));
    assert.equal(request.postDataJSON().inputs.SETTINGS.D569,'Injected');assert.equal(request.postDataJSON().inputs.SETTINGS.D570,'Injected');
    assert.deepEqual(fs.readFileSync(savedPath),savedBytes,'draft export does not save the selected project');assert.deepEqual(savedCalculatorRows(),savedRows,'draft export does not save calculator state');
    exportedDrafts.push({suffix,path:exported.path});
  }
  const inspection=spawnSync(python,['-c','import json,sys;from openpyxl import load_workbook;from pypdf import PdfReader;w=load_workbook(sys.argv[1],data_only=False);print(json.dumps({"formulas":sum(c.data_type=="f" for s in w for r in s for c in r),"summary":list(w["Summary"].values),"pdf":" ".join(p.extract_text() or "" for p in PdfReader(sys.argv[2]).pages)}))',exportedDrafts[2].path,exportedDrafts[1].path],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(inspection.status,0,inspection.stderr);const draftFiles=JSON.parse(inspection.stdout);assert.equal(draftFiles.formulas,0);
  const mk6Order=draftFiles.summary.find(row=>row[0]==='MONOKOTE MK-6 HY'),z106Order=draftFiles.summary.find(row=>row[0]==='MONOKOTE Z106');
  assert.ok(mk6Order && z106Order);assert.equal(mk6Order[6],Math.ceil(injected.T10));assert.equal(z106Order[6],Math.ceil(injected.T11));
  assert.match(draftFiles.pdf,/MONOKOTE MK-6 HY/);assert.match(draftFiles.pdf,new RegExp(`\\b${Math.ceil(injected.T10)}(?:\\.00)?\\b`));
  await apiReply(()=>clickProjectControl(page,'Save'),'/api/project/save');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const savedInjected=JSON.parse(fs.readFileSync(savedPath,'utf8'));assert.equal(savedInjected.calculators.steel_vermiculite.inputs.SETTINGS.D569,'Injected');assert.equal(savedInjected.calculators.steel_vermiculite.inputs.SETTINGS.D570,'Injected');
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({open:'saved'}));
  await apiReply(()=>clickProjectControl(page,'Load'),'/api/project/open');await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),draft);
  await chooseCalculator(page,'Steel (spray)');
  await selectBasis('MONOKOTE MK-6 HY','D569',237,'Uninjected');await selectBasis('MONOKOTE Z106','D570',564,'Uninjected');
  // Restore the initially collapsed Settings chooser as well as both values,
  // so the original later first-visit panel checks retain their exact setup.
  await page.getByRole('button',{name:'MONOKOTE Z106',exact:true}).click();
  await expect(page.getByRole('button',{name:'MONOKOTE Z106',exact:true})).toHaveAttribute('aria-expanded','false');
  await tab('SCHEDULE');const restored=await recalculate('SCHEDULE');
  for(const address of ['O10','P10','S10','T10','U10','P11','S11','T11','U11']) assert.deepEqual(restored[address],baseline[address],`uninjected restored ${address}`);
  applicationBasis={placements,choices:['Injected','Uninjected'],mk6Factor:40/27,z106Factor:1,baselineBags:[baseline.T10,baseline.T11],injectedBags:[injected.T10,injected.T11],draftExports:exportedDrafts,savedProjectRoundtrip:true,noImplicitSave:true,restoredUninjected:true};
  console.log('Verified exact basis selectors below Waste, MK6 40/27, independent Z106, unsaved draft PDF/XLSX and saved-project roundtrip.');
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
  await expect(rendered('G570')).toBeVisible();
  await expect(rendered('G570')).toContainText('does not increase yield');
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
  await apiReply(()=>clickProjectControl(page, 'Save'),'/api/project/save');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved=JSON.parse(fs.readFileSync(path.join(output,'standard-project.cf.json'),'utf8'));
  const before=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  fs.writeFileSync(path.join(output,'dialog-mode.json'),JSON.stringify({open:'saved'}));
  await apiReply(()=>clickProjectControl(page, 'Load'),'/api/project/open');
  await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),before);
  assert.equal(saved.version,1);
  assert.equal(saved.calculators.steel_vermiculite.inputs.SETTINGS.D569,'Uninjected');assert.equal(saved.calculators.steel_vermiculite.inputs.SETTINGS.D570,'Uninjected');
  await chooseCalculator(page,'Steel (spray)');await tab('SCHEDULE');
  const reopened=await recalculate('SCHEDULE');
  for(const address of ['P10','T10','P11','T11','P12','T12','V12','O13','P13','S13','T13','V13','W13','X13']) assert.deepEqual(reopened[address],scheduled[address],`reopened ${address}`);
  await page.getByRole('button',{name:'Document',exact:true}).click();
  const exported=await apiReply(()=>page.locator('#calculator-excel').click(),'/register.xlsx');
  assert.equal(exported.saved,true);assert.equal(exported.destination,'project');
  assert.ok(within(output,path.resolve(exported.path)));
  const inspected=spawnSync(python,['-c','import json,sys;from openpyxl import load_workbook;w=load_workbook(sys.argv[1],data_only=False);print(json.dumps({"rows":{s.title:list(s.values) for s in w},"formulas":sum(c.data_type=="f" for s in w for row in s for c in row)}))',exported.path],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(inspected.status,0,inspected.stderr);const workbook=JSON.parse(inspected.stdout);
  assert.equal(workbook.formulas,0);const exportText=JSON.stringify(workbook.rows);assert.match(exportText,/FAR4856 Issue2/);assert.match(exportText,/BLOCKED - SOURCE REVIEW/);assert.match(exportText,/MONOKOTE Z106/);
  const originalExportHeaders = ['Line','Location','Mark','Product','Section','Quantity','Length (m)','Published thickness (mm)',
    'Spray surface (m²)','Report','Status'];
  assert.deepEqual(workbook.rows.Schedule[4], originalExportHeaders, 'XLSX exports the requested schedule columns');
  schedulePresentation.exportHeaders = originalExportHeaders;
  for(const index of [0,1]) {
    const row=workbook.rows.Schedule.find(row=>row[2]===`SYNTHETIC-${index+1}`);
    assert.ok(row);closeNumber(row[7],thickness,'exported published thickness');closeNumber(row[8],scheduled[`R${index+10}`],'exported spray surface');
    assert.equal(row[9],'FAR4856 Issue 2 (https://tfire.com.au/documents/Internal-Fire-Hollow-Steel-Sections-FAR4856)');assert.match(row[10],/FAR4856 Issue2 p12 Table 4/);
  }
  const blockedRow=workbook.rows.Schedule.find(row=>row[2]==='SYNTHETIC-BLOCKED');assert.ok(blockedRow);
  assert.equal(blockedRow[7],null,'blocked published thickness');
  const pfcRow=workbook.rows.Schedule.find(row=>row[2]==='SYNTHETIC-PFC');assert.ok(pfcRow);
  closeNumber(pfcRow[7],19,'exported PFC published thickness');closeNumber(pfcRow[8],scheduled.R13,'exported PFC spray surface');
  assert.equal(pfcRow[9],'FAR4853 Issue 3 (https://tfire.com.au/documents/Monokote-Internal-Fire-Solid-Steel-Sections-FAR4853)');assert.match(pfcRow[10],/MK6-030521 p15/);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);assert.deepEqual(sourceHashes(),sourceBefore);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,...fixture,sourceHashes:sourceBefore,schedulePresentation,applicationBasis,journeys,pfcJourneys,blockedQuantitiesWithheld:true,schedule:true,pfcSchedule:true,pfcSaveReopen:true,pfcExport:true,allSixProductTotals:true,z106SummaryCentered:true,z106SettingsLeftAligned:true,hollowAssessmentCoverage:true,pfcNamedOnlyCoverage:true,saveReopen:true,valuesOnlyExport:true,errors,csp:[]},null,2));
  console.log(`PASS: ${fixture.evidence_mode}; MONOKOTE hollow/PFC schedule, bags, blocked source, schedule, save/reopen and values-only XLSX. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-5000));if(page)await screenshot('failure.png',fixtureInfo || {synthetic:!privateEvidence}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
