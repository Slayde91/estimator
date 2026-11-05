const {chromium, expect: defaultExpect} = require('@playwright/test');
const expect = defaultExpect.configure({timeout:30000});
const {spawn,execFileSync} = require('node:child_process');
const {clickProjectControl} = require('./project_actions.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `commercial-documents-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root,windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data',value => logs += value);
const ready = new Promise((resolve,reject) => {
  let data = '';
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data',value => {data += value; if(data.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);
  server.once('exit',code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}`));});
});
const errors = [], checks = [], files = [];
async function idle() {
  await page.waitForFunction(() => {const value=window.CeasefireDesktop?.status();return value?.ready && !value.busy;});
}
async function open(kind) {
  await page.locator('#projects-navigation-toggle').hover();
  await page.locator(`#projects-navigation-menu [data-project-section="${kind}"]`).click();
  await expect(page.locator(`#view-${kind}`)).toBeVisible();
}
async function save(host) {
  await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(host.locator('.commercial-message')).toContainText('Document saved.');
}
async function download(host) {
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/commercial/issue') && response.request().method()==='POST');
  await host.getByRole('button',{name:'Download PDF',exact:true}).click();
  const response=await responsePromise;
  const value=await response.json();
  assert.equal(response.status(),200,JSON.stringify(value));
  assert.equal(value.saved,true);
  assert.equal(fs.readFileSync(value.path).subarray(0,5).toString(),'%PDF-');
  files.push(value.path);
  await expect(host.locator('.commercial-message')).toContainText('PDF saved');
  await idle();
  return value;
}
(async()=>{
  const info=await ready;
  const seedCode = `import json,sys,uuid
from pathlib import Path
from estimator.storage import Store
from estimator.project_file import export_project
destination=Path(sys.argv[1])
store=Store(destination.parent/'commercial-seed.sqlite3')
def workspace(mark,adjustment):
    normalized=json.loads(export_project(store,{'estimate':{'title':'Commercial fixture','project_no':'COMM-1','client':'Example construction','site_address':'10 Example Street','inputs':{'B28':adjustment}},'calculators':{'steel_board':{'inputs':{'CALCULATOR':{'A9':mark}}}}}))
    return {'estimate':normalized['estimate'],'calculators':{key:{'inputs':value['inputs'],'schedule_rows':value['schedule_rows']} for key,value in normalized['calculators'].items()}}
first=workspace('SCOPE-ORIGINAL-123',10)
second=workspace('SCOPE-ADDITIONAL-456',20)
entries=[{'id':'estimate-1','name':'Original scope','workspace':first},{'id':'estimate-'+uuid.uuid4().hex,'name':'Additional scope','workspace':second}]
destination.write_bytes(export_project(store,{**first,'estimates':entries,'active_estimate_id':'estimate-1'}))
print(json.dumps({'ids':[entry['id'] for entry in entries],'prices':[store.prepare_quote(entry['workspace']['estimate'])['result']['summary']['total'] for entry in entries]}))`;
  const seeded=JSON.parse(execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c',seedCode,info.project],{cwd:root,encoding:'utf8',windowsHide:true}));
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1575,height:1000}});
  page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle();
  await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await idle();
  const upgradedProject=page.waitForResponse(response=>/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
  await clickProjectControl(page,'Save');
  const upgradeResponse=await upgradedProject;
  assert.equal(upgradeResponse.status(),200,await upgradeResponse.text());
  await idle();
  await open('quote');
  const quote=page.locator('#commercial-quote-root');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.locator('.commercial-message')).toBeHidden();
  await expect(quote.getByLabel('Client',{exact:true})).toHaveValue('Example construction');
  await expect(quote.getByLabel('Site address',{exact:true})).toHaveValue('10 Example Street');
  await quote.locator('.commercial-estimate-picker summary').click();
  await quote.getByRole('checkbox',{name:'Additional scope',exact:true}).check();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  await expect(quote.locator('.commercial-message')).toBeHidden();
  await expect(quote.getByRole('textbox',{name:'Scope preamble',exact:true})).toContainText('Additional scope');
  const prices=await quote.locator('.commercial-lines input[readonly]').evaluateAll(inputs=>inputs.map(input=>Number(input.value)));
  assert.deepEqual(prices,seeded.prices);
  await quote.getByLabel('Document title',{exact:true}).fill('QA quotation');
  await quote.locator('.commercial-lines tbody textarea').first().fill('Supply and install the selected system');
  await quote.locator('.commercial-lines tbody input').first().fill('2');
  await quote.getByRole('textbox',{name:'Allowances',exact:true}).fill('Client provides safe access.');
  await save(quote);
  // Editing after Save must still change the active document, not a detached object.
  await quote.getByLabel('Document title',{exact:true}).fill('QA quotation revised');
  await save(quote);
  await page.screenshot({path:path.join(output,'quote-editor.png'),fullPage:true});
  const first=await download(quote), second=await download(quote);
  assert.notEqual(first.filename,second.filename);
  const pdfText=execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c','from pypdf import PdfReader; import sys; print("\\n".join(page.extract_text() for page in PdfReader(sys.argv[1]).pages))',second.path],{encoding:'utf8',windowsHide:true});
  assert.ok(pdfText.replace(/\s+/g,'').includes('SCOPE-ORIGINAL-123'));
  assert.ok(pdfText.replace(/\s+/g,'').includes('SCOPE-ADDITIONAL-456'));
  checks.push('quote uses linked estimate totals, edited descriptions/quantities and a new number for each distinct PDF download');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await expect(quote.locator('.commercial-card')).toContainText('QA quotation revised');
  await open('work-orders');
  const work=page.locator('#commercial-work-order-root');
  await work.getByRole('button',{name:'New Work Order',exact:true}).click();
  await work.getByLabel('Document title',{exact:true}).fill('QA site installation');
  await work.getByLabel('Description of works',{exact:true}).fill('Install the scheduled passive fire systems.');
  await work.getByLabel('SWMS',{exact:true}).fill('Approved project SWMS revision 2');
  await save(work);
  await download(work);
  await work.getByRole('button',{name:'Back to Work Orders',exact:true}).click();
  await work.locator('.commercial-card').dragTo(work.getByRole('region',{name:'Review',exact:true}).or(work.locator('.commercial-column[aria-label="Review"]')));
  await expect(work.locator('.commercial-column[aria-label="Review"] .commercial-card')).toHaveCount(1);
  await page.screenshot({path:path.join(output,'work-order-board.png'),fullPage:true});
  checks.push('work order edits, PDF and persisted Kanban status');
  await open('purchase-orders');
  const purchase=page.locator('#commercial-purchase-order-root');
  await purchase.getByRole('button',{name:'New Purchase Order',exact:true}).click();
  await purchase.getByLabel('Document title',{exact:true}).fill('QA material order');
  await purchase.getByLabel('Supplier',{exact:true}).fill('Example supplier');
  await purchase.getByRole('button',{name:'Add line item',exact:true}).click();
  await purchase.locator('.commercial-lines tbody textarea').first().fill('Fire collar');
  await purchase.locator('.commercial-lines tbody input').nth(0).fill('1');
  await purchase.locator('.commercial-lines tbody input').nth(1).fill('-0.05');
  await expect(purchase.locator('.commercial-totals')).toContainText('-$0.06');
  await purchase.locator('.commercial-lines tbody input').nth(0).fill('10');
  await purchase.locator('.commercial-lines tbody input').nth(1).fill('25');
  await expect(purchase.locator('.commercial-totals')).toContainText('$275.00');
  await save(purchase);
  await download(purchase);
  await purchase.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();
  await expect(purchase.locator('.commercial-card')).toContainText('QA material order');
  checks.push('purchase order supplier, items, GST and PDF');
  await idle();
  const saved=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.equal(saved.commercial_documents.documents.length,3);
  assert.ok(saved.documentation,'Generated PDFs are captured in portable Documentation');
  await page.reload();
  await idle();
  await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await idle();
  await open('quote');
  await expect(quote.locator('.commercial-card')).toContainText('QA quotation revised');
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button',{name:'Open / Edit',exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  assert.deepEqual(await quote.locator('.commercial-lines input[readonly]').evaluateAll(inputs=>inputs.map(input=>Number(input.value))),seeded.prices);
  const restored=await page.evaluate(async()=>{const response=await fetch('/api/commercial/state?workspace='+window.CeasefireCertification.sessionId());return response.json();});
  assert.equal(restored.documents.length,3);
  assert.equal(restored.documents.find(document=>document.kind==='quote').fields.sources.length,2);
  checks.push('two named estimates, distinct linked prices, exact Full Schedule content from both estimates and project reload retain links and history');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,files,errors},null,2));
  console.log(`PASS commercial documents. ${output}`);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();});
