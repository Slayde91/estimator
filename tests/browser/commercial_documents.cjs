const {chromium, expect: defaultExpect} = require('@playwright/test');
const expect = defaultExpect.configure({timeout:30000});
const {spawn,execFileSync} = require('node:child_process');
const {clickProjectControl,fillProjectDetails,createNewProject} = require('./project_actions.cjs');
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
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1575,height:1000}});
  page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle();
  assert.equal(await page.evaluate(() => window.CeasefireCertification.sessionId()), null);
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await expect(page.locator('#project-no')).toHaveAttribute('readonly','');
  await fillProjectDetails(page, {client:'Unsaved project client', 'site-address':'25 Current Estimate Street'});
  await page.locator('#view-estimate').getByRole('button',{name:'Document',exact:true}).click();
  await page.locator('#estimate-open-quote').click();
  await expect(page.locator('#view-estimate')).toBeVisible();
  await expect(page.locator('#app-message')).toContainText('Create or load a project before creating documents.');
  const initialSave=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');
  await clickProjectControl(page,'Save');assert.equal((await initialSave).status(),200);await idle();
  const projectNumber=await page.locator('#project-no').inputValue();
  await page.locator('#view-estimate').getByRole('button',{name:'Document',exact:true}).click();
  await page.locator('#estimate-open-quote').click();
  const quote=page.locator('#commercial-quote-root');
  await expect(quote.getByLabel('Client',{exact:true})).toHaveValue('Unsaved project client');
  await expect(quote.getByLabel('Site address',{exact:true})).toHaveValue('25 Current Estimate Street');
  await expect(quote.getByLabel('Project number',{exact:true})).toHaveValue(projectNumber);
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  const introBox = await quote.getByLabel('Introduction',{exact:true}).boundingBox();
  const detailBox = await quote.locator('.commercial-details').boundingBox();
  assert.ok(Math.abs(introBox.width-detailBox.width)<2,'Introduction spans the Project details width');
  assert.ok((await quote.getByLabel('Status',{exact:true}).boundingBox()).width<=220);
  const shortDescription=quote.locator('.commercial-line-description').first();
  await expect(shortDescription).toHaveJSProperty('rows',1);
  assert.ok((await shortDescription.boundingBox()).height<60,'short description uses one row');
  const summaryBox=await quote.locator('.commercial-lines').boundingBox(),totalsBox=await quote.locator('.commercial-totals').boundingBox(),scopeBox=await quote.locator('.commercial-scope').boundingBox();
  assert.ok(totalsBox.y>=summaryBox.y+summaryBox.height && totalsBox.y+totalsBox.height<=scopeBox.y,'Totals immediately follow summary before scope');
  assert.equal(await page.evaluate(() => window.CeasefireProject.context().project_path), info.project);
  await quote.getByLabel('Document title',{exact:true}).fill('Quote prepared after first project save');
  await save(quote);
  const firstSave=page.waitForResponse(response=>/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
  await clickProjectControl(page,'Save');
  const firstSaveResponse=await firstSave;
  assert.equal(firstSaveResponse.status(),200,await firstSaveResponse.text());
  await idle();
  const firstSaved=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.equal(firstSaved.commercial_documents.documents[0].fields.title,'Quote prepared after first project save');
  assert.equal(firstSaved.estimate.client,'Unsaved project client');
  await expect(quote.getByLabel('Project number',{exact:true})).toHaveValue(firstSaved.estimate.project_no);
  await download(quote);
  checks.push('unsaved Estimate Document → Quote is blocked until native Project Save; the new quote then inherits details and retains its saved draft and PDF');
  let releaseState, notifyStateHeld, notifyStateCompleted;
  const stateRelease=new Promise(resolve=>releaseState=resolve);
  const stateHeld=new Promise(resolve=>notifyStateHeld=resolve);
  const stateCompleted=new Promise(resolve=>notifyStateCompleted=resolve);
  await page.route('**/api/commercial/state?*',async route=>{
    const response=await route.fetch();
    notifyStateHeld();
    await stateRelease;
    await route.fulfill({response});
    notifyStateCompleted();
  });
  await open('work-orders');
  await stateHeld;
  const previousWorkspace=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  await open('quotes');
  const originalProject=fs.readFileSync(info.project),saveTarget=path.join(info.directory,'save-dialog-target.json');
  fs.writeFileSync(saveTarget,JSON.stringify({file:'replacement-state-project.cf.json'}));
  try{await createNewProject(page);}finally{fs.unlinkSync(saveTarget);}
  assert.deepEqual(fs.readFileSync(info.project),originalProject,'The replacement Project has its own saved file');
  await page.waitForFunction(previous=>window.CeasefireCertification.sessionId()!==previous,previousWorkspace);
  await idle();
  releaseState();
  await stateCompleted;
  await page.unroute('**/api/commercial/state?*');
  const replacement=await page.evaluate(()=>({workspace:window.CeasefireCertification.sessionId(),commercial:JSON.parse(window.CeasefireCommercial.projectFingerprint())}));
  assert.equal(replacement.commercial.workspace,replacement.workspace);
  assert.equal(replacement.commercial.documents,undefined);
  assert.equal(replacement.commercial.editor,undefined);
  checks.push('a delayed commercial state response cannot replace the new project workspace');
  const seeded=JSON.parse(execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c',seedCode,info.project],{cwd:root,encoding:'utf8',windowsHide:true}));
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  await page.locator('#measurements').fill('Discard this replacement Project draft before loading the fixture');
  await page.locator('#measurements').blur();
  await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await idle();
  const upgradedProject=page.waitForResponse(response=>/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
  await clickProjectControl(page,'Save');
  const upgradeResponse=await upgradedProject;
  assert.equal(upgradeResponse.status(),200,await upgradeResponse.text());
  await idle();
  await open('quote');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.locator('.commercial-message')).toBeHidden();
  await expect(quote.getByLabel('Client',{exact:true})).toHaveValue('Example construction');
  await expect(quote.getByLabel('Site address',{exact:true})).toHaveValue('10 Example Street');
  await quote.locator('.commercial-estimate-picker summary').click();
  await quote.getByRole('checkbox',{name:'Additional scope',exact:true}).check();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  await expect(quote.locator('.commercial-message')).toBeHidden();
  await expect(quote.getByRole('textbox',{name:'Scope preamble',exact:true})).toHaveCount(0);
  for (const label of ['Allowances', 'Terms & Conditions']) {
    const section=quote.locator('details.commercial-rich>summary').filter({hasText:label}).locator('..');
    await expect(section).not.toHaveAttribute('open','');
  }
  const samePairRow = async (leftLabel,rightLabel) => {
    const left=quote.getByLabel(leftLabel,{exact:true}),right=quote.getByLabel(rightLabel,{exact:true});
    const leftBox=await left.boundingBox(),rightBox=await right.boundingBox();
    assert.ok(rightBox.x>leftBox.x && Math.abs(rightBox.y-leftBox.y)<2,`${leftLabel} and ${rightLabel} share a row`);
    assert.equal(await left.evaluate((el,label)=>el.closest('.commercial-field-pair')===document.querySelector(`[aria-label="${label}"]`)?.closest('.commercial-field-pair'),rightLabel),true);
  };
  await samePairRow('Document date','Project number');
  await samePairRow('Client','Client contact');
  await samePairRow('Client phone','Client email');
  const prices=await quote.locator('.commercial-lines input[readonly]').evaluateAll(inputs=>inputs.map(input=>Number(input.value)));
  assert.deepEqual(prices,seeded.prices);
  await quote.getByLabel('Document title',{exact:true}).fill('QA quotation');
  await quote.locator('.commercial-lines tbody textarea').first().fill('Supply and install the selected system');
  await quote.locator('.commercial-lines tbody input').first().fill('2');
  await quote.locator('details.commercial-rich>summary').filter({hasText:'Allowances'}).click();
  await expect(quote.getByRole('textbox',{name:'Allowances',exact:true})).toContainText('N / A');
  await quote.getByRole('textbox',{name:'Allowances',exact:true}).fill('Client provides safe access.');
  await save(quote);
  // Editing after Save must still change the active document, not a detached object.
  await quote.getByLabel('Document title',{exact:true}).fill('QA quotation revised');
  await save(quote);
  await page.screenshot({path:path.join(output,'quote-editor.png'),fullPage:true});
  const first=await download(quote), second=await download(quote);
  assert.notEqual(first.filename,second.filename);
  const quoteTotal = async () => (await quote.locator('.commercial-totals p').filter({hasText:'Grand total'}).locator('span').innerText()).replace(/[$,]/g,'');
  const originalTotal = await quoteTotal();
  const pdfText=execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c','from pypdf import PdfReader; import sys; print("\\n".join(page.extract_text() for page in PdfReader(sys.argv[1]).pages))',second.path],{encoding:'utf8',windowsHide:true});
  assert.ok(pdfText.replace(/\s+/g,'').includes('SCOPE-ORIGINAL-123'));
  assert.ok(pdfText.replace(/\s+/g,'').includes('SCOPE-ADDITIONAL-456'));
  checks.push('quote uses linked estimate totals, edited descriptions/quantities and a new number for each distinct PDF download');
  await quote.locator('.commercial-lines tbody input').first().fill('3');
  await save(quote);
  assert.notEqual(await quoteTotal(),originalTotal,'The saved quote edit has a different total to the issued PDF');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await expect(quote.locator('.commercial-card')).toContainText('QA quotation revised');
  assert.deepEqual(await quote.locator('.commercial-card').first().locator('.commercial-card-info dt').allTextContents(),
    ['Client','Contact','Address','Quote No.','Total','Updated']);
  await open('work-orders');
  const work=page.locator('#commercial-work-order-root');
  const boardBefore=await work.locator('.commercial-board').boundingBox();
  await work.locator('.commercial-columns-menu summary').click();
  const boardAfter=await work.locator('.commercial-board').boundingBox();
  assert.deepEqual(boardAfter,boardBefore,'Columns menu overlays the unchanged board');
  await page.keyboard.press('Escape');
  await work.getByRole('button',{name:'New Work Order',exact:true}).click();
  await work.getByLabel('Document title',{exact:true}).fill('QA site installation');
  await work.getByLabel('Linked Quote',{exact:true}).selectOption({label:await work.getByLabel('Linked Quote',{exact:true}).locator('option').nth(1).textContent()});
  const cost = work.getByLabel('Estimated cost (AUD)',{exact:true});
  await expect(cost).toHaveValue(originalTotal);
  await cost.fill('125.25');
  const linkedQuote = work.getByLabel('Linked Quote',{exact:true});
  const quoteId = await linkedQuote.inputValue();
  await linkedQuote.selectOption('');
  await linkedQuote.selectOption(quoteId);
  await expect(cost).toHaveValue('125.25');
  await work.getByLabel('Description of works',{exact:true}).fill('Install the scheduled passive fire systems.');
  await expect(work.getByLabel('SWMS',{exact:true})).toHaveCount(0);
  await work.getByLabel('Category / urgency',{exact:true}).selectOption('High Priority');
  await work.getByLabel('Approval',{exact:true}).selectOption('Approved');
  await page.evaluate(()=>localStorage.setItem('ceasefire.takeoff-signature.v1',JSON.stringify({version:1,ratio:2,strokes:[[[0,.3],[.5,1],[1,0]]]})));
  for(const label of ['Reviewed by','Prepared by','Approved by']) {
    await work.getByRole('button',{name:'Sign '+label,exact:true}).click();
    await expect(work.getByRole('img',{name:label+' signature',exact:true})).toBeVisible();
  }
  await work.getByRole('button',{name:'Change Reviewed by',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  for(const panel of ['Account Details','Contact Details','Notes','Files','Linked Quotes','Linked Purchase Orders']) await expect(work.locator('.commercial-side-panel summary').filter({hasText:panel})).toBeVisible();
  const startBounds=await work.getByLabel('Proposed start date').boundingBox(), endBounds=await work.getByLabel('Proposed end date').boundingBox();
  assert.ok(endBounds.x>startBounds.x && Math.abs(startBounds.y-endBounds.y)<2,'Proposed dates share a row within one column');
  await work.getByRole('button',{name:'New note'}).click();
  const note=page.getByRole('dialog',{name:'Work Order note'});
  await note.getByLabel('Note title').fill('Site observation');
  await note.getByRole('textbox',{name:'Compose text'}).fill('Test the access route.');
  await note.getByRole('button',{name:'Done'}).click();
  await expect(work.locator('.commercial-note-card')).toContainText('Site observation');
  await work.getByLabel('Attach files',{exact:true}).setInputFiles({name:'qa-field-record.bin',mimeType:'application/octet-stream',buffer:Buffer.from('QA portable original')});
  await expect(work.locator('.commercial-attached-file')).toContainText('qa-field-record.bin');
  await expect(work.getByLabel('Proposed start date',{exact:true})).toHaveAttribute('type','date');
  const titleBox=await work.getByLabel('Document title',{exact:true}).boundingBox(),statusBox=await work.getByLabel('Status',{exact:true}).boundingBox();
  assert.ok(statusBox.x>titleBox.x && Math.abs(statusBox.y-titleBox.y)<2,'Status aligns to the right of title');
  await save(work);
  const assignedReference=await work.getByLabel('Work order reference',{exact:true}).inputValue();
  assert.match(assignedReference,/^WO-\d{2,}$/);
  await expect(cost).toHaveValue('125.25');
  await expect(work.getByLabel('Work order reference',{exact:true})).toHaveAttribute('readonly','');
  const workPdf=await download(work);
  const attachmentProof=execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c',
    'from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); assert r.attachments["qa-field-record.bin"][0]==b"QA portable original"; print(len(r.pages))',workPdf.path],{encoding:'utf8'});
  assert.ok(Number(attachmentProof)>1);
  await work.getByRole('button',{name:'Back to Work Orders',exact:true}).click();
  await work.locator('.commercial-card').dragTo(work.getByRole('region',{name:'Review',exact:true}).or(work.locator('.commercial-column[aria-label="Review"]')));
  await expect(work.locator('.commercial-column[aria-label="Review"] .commercial-card')).toHaveCount(1);
  assert.deepEqual(await work.locator('.commercial-card').first().locator('.commercial-card-info dt').allTextContents(),
    ['Client','Contact','Address','WO No.','Total','Updated']);
  await page.screenshot({path:path.join(output,'work-order-board.png'),fullPage:true});
  checks.push('work order edits, PDF and persisted Kanban status');
  await open('purchase-orders');
  const purchase=page.locator('#commercial-purchase-order-root');
  await purchase.getByRole('button',{name:'New Purchase Order',exact:true}).click();
  for(const label of ['Client','Client contact','Client phone','Client email']) await expect(purchase.getByLabel(label,{exact:true})).toHaveCount(0);
  await purchase.getByLabel('Linked Work Order',{exact:true}).selectOption({label:await purchase.getByLabel('Linked Work Order',{exact:true}).locator('option').nth(1).textContent()});
  await expect(purchase.getByLabel('Purchase Order No.',{exact:true})).toHaveValue('');
  await expect(purchase.getByLabel('Linked Work Order',{exact:true}).locator('option:checked')).toContainText(assignedReference);
  await expect(purchase.getByLabel('Purchase Order No.',{exact:true})).toHaveAttribute('readonly','');
  await purchase.getByLabel('Document title',{exact:true}).fill('QA material order');
  await purchase.getByLabel('Supplier',{exact:true}).fill('Example supplier');
  await purchase.getByRole('button',{name:'Add line item',exact:true}).click();
  const catalog=await page.evaluate(async()=> (await fetch('/api/commercial/supplier-products?workspace='+window.CeasefireCertification.sessionId()).then(r=>r.json())).products);
  const supplierProduct=catalog.find(item=>item.supplier_price>0 && catalog.filter(x=>x.label===item.label).length===1);
  assert.ok(supplierProduct);
  await purchase.getByLabel('Product / Service 1').fill(supplierProduct.label);
  await expect(purchase.locator('.commercial-lines tbody input[type=number]').nth(1)).toHaveValue(String(supplierProduct.supplier_price));
  await purchase.getByLabel('Comments 1').fill('Deliver to the site store.');
  await expect(purchase.getByRole('button',{name:'Remove line item'})).toBeVisible();
  await purchase.locator('.commercial-lines tbody input[type=number]').nth(0).fill('1');
  await purchase.locator('.commercial-lines tbody input[type=number]').nth(1).fill('-0.05');
  await expect(purchase.locator('.commercial-totals')).toContainText('-$0.06');
  await purchase.locator('.commercial-lines tbody input[type=number]').nth(0).fill('10');
  await purchase.locator('.commercial-lines tbody input[type=number]').nth(1).fill('25');
  await expect(purchase.locator('.commercial-totals')).toContainText('$275.00');
  await save(purchase);
  await expect(purchase.getByLabel('Purchase Order No.',{exact:true})).toHaveValue(/^PO-\d{2,}$/);
  await download(purchase);
  await purchase.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();
  await expect(purchase.locator('.commercial-card')).toContainText('QA material order');
  checks.push('purchase order supplier, items, GST and PDF');
  await open('quote');
  await quote.getByRole('button',{name:'QA quotation revised',exact:true}).click();
  await download(quote);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await idle();
  const saved=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.equal(saved.commercial_documents.documents.length,3);
  assert.ok(saved.documentation,'Generated PDFs are captured in portable Documentation');
  // Open a project saved by the previous release with an empty work order cost.
  const savedWork = saved.commercial_documents.documents.find(item=>item.kind==='work_order');
  const oldReference = [savedWork.fields.details.project_no, savedWork.fields.order.quote_reference, '01'].join('-');
  delete savedWork.reference;
  delete saved.commercial_documents.documents.find(item=>item.kind==='purchase_order').reference;
  savedWork.fields.order.estimated_cost = '';
  savedWork.fields.order.work_order_reference = oldReference;
  saved.commercial_documents.documents.find(item=>item.kind==='purchase_order').fields.order.work_order_reference = oldReference;
  fs.writeFileSync(info.project,JSON.stringify(saved));
  await page.reload();
  await idle();
  await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await idle();
  await open('work-orders');
  await work.getByRole('button',{name:'QA site installation',exact:true}).click();
  await expect(work.getByLabel('Work order reference',{exact:true})).toHaveValue(assignedReference);
  await expect(cost).toHaveValue(originalTotal);
  await work.getByRole('button',{name:'Back to Work Orders',exact:true}).click();
  checks.push('legacy saved work order opens with compact reference and its original issued quote total after a later issue');
  await open('quote');
  await expect(quote.locator('.commercial-card')).toContainText('QA quotation revised');
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button',{name:'Open',exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  assert.deepEqual(await quote.locator('.commercial-lines input[readonly]').evaluateAll(inputs=>inputs.map(input=>Number(input.value))),seeded.prices);
  const restored=await page.evaluate(async()=>{const response=await fetch('/api/commercial/state?workspace='+window.CeasefireCertification.sessionId());return response.json();});
  assert.equal(restored.documents.length,3);
  assert.equal(restored.documents.find(document=>document.kind==='quote').fields.sources.length,2);
  checks.push('two named estimates, distinct linked prices, exact Full Schedule content from both estimates and project reload retain links and history');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  // Two independently saved files may have the same portable document IDs.
  // Edit the second file from the register while the original remains active.
  const otherPath = path.join(info.directory, 'other-project.cf.json');
  const clone = structuredClone(saved);
  const clonedQuote = clone.commercial_documents.documents.find(document => document.kind === 'quote');
  clonedQuote.fields.title = 'Other project quote';
  clone.commercial_documents.documents.find(doc=>doc.kind==='work_order').fields.title='Other site order';
  clone.commercial_documents.documents.find(doc=>doc.kind==='purchase_order').fields.title='Other purchase order';
  fs.writeFileSync(otherPath, JSON.stringify(clone));
  await open('quotes');
  await page.locator('#refresh-quotes').click();
  // Project rows show readable titles; relative filenames were intentionally
  // removed from this list. The two document owners and the empty replacement
  // Project created through the New popup are all real saved files.
  await expect(page.locator('#project-list .project-list-row')).toHaveCount(3);
  await open('quote');
  await expect(quote.locator('.commercial-card')).toHaveCount(2);
  const otherCard = quote.locator('.commercial-card').filter({hasText:'Other project quote'});
  await otherCard.getByRole('button',{name:'Other project quote'}).click();
  for (const label of ['Project number','Site address','Client']) await expect(quote.getByLabel(label,{exact:true})).toHaveAttribute('readonly','');
  await quote.locator('.commercial-estimate-picker summary').click();
  await quote.getByRole('button',{name:'Add custom row'}).click();
  const custom = quote.locator('.commercial-lines tbody tr').last();
  await custom.getByRole('textbox').fill('Custom commissioning');
  await custom.locator('input').first().fill('3');
  await custom.locator('input').last().fill('140.50');
  await expect(custom.locator('.commercial-line-total')).toHaveText('$421.50');
  await quote.getByRole('checkbox',{name:'Additional scope',exact:true}).uncheck();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  await save(quote);
  const owner = () => JSON.parse(fs.readFileSync(otherPath,'utf8')).commercial_documents.documents;
  const ownerQuote = () => owner().find(doc=>doc.kind==='quote');
  assert.equal(ownerQuote().fields.lines.at(-1).unit_price,'140.50');
  const issue = page.waitForResponse(response=>response.url().endsWith('/api/commercial/saved-issue'));
  await quote.getByRole('button',{name:'Download PDF'}).click();
  const issueResponse = await issue;
  assert.equal(issueResponse.status(),200,await issueResponse.text());
  await expect(quote.locator('.commercial-message')).toContainText('PDF saved');
  const otherPdf = (await issueResponse.json()).result.path;
  const otherText = execFileSync(process.env.CEASEFIRE_PYTHON || 'python',['-c','from pypdf import PdfReader; import sys; print(chr(10).join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))',otherPdf],{encoding:'utf8'});
  assert.ok(otherText.includes('Custom commissioning'));
  assert.ok(otherText.includes('$421.50'));
  const otherTotal = await quoteTotal();
  await quote.locator('.commercial-lines tbody tr').last().locator('input').first().fill('4');
  await save(quote);
  assert.notEqual(await quoteTotal(),otherTotal);
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),info.project);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await otherCard.locator('summary').click();
  await otherCard.getByRole('button',{name:'Create WO'}).click();
  await expect(work.getByLabel('Linked Quote',{exact:true})).toHaveValue(clonedQuote.id);
  await expect(work.getByLabel('Description of works',{exact:true})).toHaveValue(/Custom commissioning/);
  await expect(cost).toHaveValue(otherTotal);
  await save(work);
  assert.ok(owner().some(doc=>doc.kind==='work_order' && doc.fields.order.quote_reference===ownerQuote().last_number
    && doc.fields.order.estimated_cost === otherTotal && /^WO-\d{2,}$/.test(doc.fields.order.work_order_reference)));
  assert.deepEqual(JSON.parse(fs.readFileSync(info.project,'utf8')).commercial_documents.documents,saved.commercial_documents.documents);
  checks.push('global register edits, prices, exports and creates a numbered work order in the correct saved file while another project is open');

  // Opening the directory with a fresh tab creates an empty active workspace.
  // Board actions must still address the saved file selected on the card.
  await page.reload(); await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path), null);
  for(const [route,host,title,target] of [
    ['work-orders',work,'Other site order','Client Approval'],
    ['purchase-orders',purchase,'Other purchase order','Requested']
  ]){
    await open(route);
    const card=host.locator('.commercial-card').filter({hasText:title});
    await expect(card).toHaveCount(1);
    await expect(card.locator('dl')).toContainText('Total');
    await card.locator('summary').click();
    await card.getByRole('combobox',{name:'Move to'}).selectOption(target);
    await expect(host.locator(`.commercial-column[aria-label="${target}"] .commercial-card`).filter({hasText:title})).toHaveCount(1);
    assert.equal(owner().find(d=>d.fields.title===title).status,target);
    assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),null);
    await card.getByRole('button',{name:title,exact:true}).click();
    const formTitle=host.getByLabel('Document title',{exact:true});
    await formTitle.fill('Unsaved text');
    await page.locator('nav [data-view="home"]').click();
    const prompt=page.locator('#discard-dialog');
    await prompt.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(formTitle).toHaveValue('Unsaved text');
    await expect(page.locator('#app-message')).toContainText('Save or discard the current commercial document edit');
    await page.locator('nav [data-view="home"]').click();
    await prompt.getByRole('button',{name:'Yes',exact:true}).click();
    await expect(page.locator('#view-home')).toBeVisible();
    assert.equal(owner().find(d=>d.fields.title===title).status,target);
  }
  checks.push('all three boards work with no open project, linked Work Orders and Purchase Orders move from their cards and retain drafts on cancel');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,files,errors},null,2));
  console.log(`PASS commercial documents. ${output}`);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();});
