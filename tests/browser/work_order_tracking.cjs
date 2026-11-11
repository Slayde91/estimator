// Portable Work Order tracking is exercised through real controls and private files.
const {chromium, expect: baseExpect} = require('@playwright/test');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createNewProject, openProjectSection, clickProjectControl} = require('./project_actions.cjs');
const expect = baseExpect.configure({timeout:30000}), root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `work-order-tracking-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const servers = [], checks = [], errors = [], failedRequests = [], evidence = {};
let browser, page, info, stage = 'startup';

async function fixture(folder) {
  fs.mkdirSync(folder, {recursive:true});
  const process = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', folder], {cwd:root, windowsHide:true});
  const entry = {process, logs:'', folder}; servers.push(entry);
  process.stderr.on('data', value => entry.logs += value);
  const value = await new Promise((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => reject(Error(entry.logs || 'Fixture timeout')), 120000);
    process.once('error', reject);
    process.once('exit', code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${entry.logs}`));});
    process.stdout.on('data', value => {
      data += value;
      if (data.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0]));}
    });
  });
  assert.notEqual(value.port, 8765, 'The real application is never used for writes');
  return value;
}
async function idle() {
  await page.waitForFunction(() => {
    const desktop = window.CeasefireDesktop?.status();
    return desktop?.ready && !window.CeasefireProject.hasPendingOperation()
      && !document.querySelector('dialog[open],.commercial-editor-actions button:disabled');
  });
}
async function openPage(fixtureInfo) {
  page = await browser.newPage({viewport:{width:1515, height:1000}});
  page.setDefaultTimeout(60000); page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failedRequests.push({url:request.url(), error:request.failure()?.errorText}));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`http://127.0.0.1:${fixtureInfo.port}/`); await idle();
}
async function saveDocument(host) {
  await host.locator('.commercial-editor-actions').getByRole('button', {name:'Save', exact:true}).click();
  await expect(host.locator('.commercial-message')).toContainText('Document saved.'); await idle();
}
async function saveProject() {
  const response = page.waitForResponse(value => /\/api\/project\/save(?:-as)?$/.test(new URL(value.url()).pathname));
  await clickProjectControl(page, 'Save'); const reply = await response;
  assert.equal(reply.status(), 200, await reply.text()); await idle(); return reply.json();
}
async function loadProject() {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/project/open');
  // A reload can retain the pointer over the header without a new mouseenter.
  // Leave the old hit target before exercising its real disclosure again.
  await page.mouse.move(0, 0);
  response.catch(() => {});
  await clickProjectControl(page, 'Load');
  const confirmation = page.locator('#discard-dialog');
  // The native picker response supplies the preview before the app decides
  // whether to request replacement confirmation or finish a clean first load.
  const reply = await response; assert.equal(reply.status(), 200, await reply.text());
  const result = await Promise.race([
    confirmation.waitFor({state:'visible'}).then(() => 'confirmation'),
    page.waitForFunction(() => !window.CeasefireProject.hasPendingOperation()).then(() => 'loaded')
  ]);
  if (result === 'confirmation') await confirmation.getByRole('button', {name:'Load Project', exact:true}).click();
  await idle();
}
const stored = fixtureInfo => JSON.parse(fs.readFileSync(fixtureInfo.project, 'utf8'));
const documents = fixtureInfo => stored(fixtureInfo).commercial_documents.documents;
const ownedWork = fixtureInfo => documents(fixtureInfo).find(value => value.kind === 'work_order');
const trackingRows = (host, key) => host.locator(`[data-tracking-field="${key}"] tbody tr`);
async function openDocument(kind, title) {
  await page.mouse.move(0, 0);
  await openProjectSection(page, kind); const host = page.locator(kind === 'quote' ? '#commercial-quote-root' : '#commercial-work-order-root');
  await host.locator('.commercial-card').getByRole('button', {name:title, exact:true}).click(); await idle(); return host;
}
async function assertTracking(host, expected, percentages) {
  for (const key of ['completed_percent', 'claimed_percent']) {
    const rows = trackingRows(host, key); await expect(rows).toHaveCount(expected.length);
    const values = await rows.evaluateAll(rows => rows.map(row => ({
      id:row.dataset.trackingLine, description:row.cells[0].textContent,
      quantity:row.cells[1].textContent, third:row.cells[2].querySelector('textarea')?.value ?? row.cells[2].textContent,
      percent:row.querySelector('input').value
    })));
    assert.deepEqual(values.map(({description, quantity}) => ({description, quantity})), expected.map(({description, quantity})=>({description,quantity})));
    assert.deepEqual(values.map(value=>value.third), expected.map(value=>key==='completed_percent' ? value.notes || '' : new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(Number(value.price))));
    assert.equal(new Set(values.map(value => value.id)).size, expected.length, 'Duplicate descriptions retain distinct row identities');
    assert.deepEqual(values.map(value => value.percent), percentages[key]);
  }
}
async function download(host) {
  const done = page.waitForResponse(response => /\/api\/commercial\/(?:saved-)?issue$/.test(new URL(response.url()).pathname));
  await host.getByRole('button', {name:'Download PDF', exact:true}).click();
  const response = await done, value = await response.json(); assert.equal(response.status(), 200, JSON.stringify(value));
  assert.equal(value.saved, true); await idle(); return value;
}

(async () => {
  info = await fixture(path.join(output, 'warm')); browser = await chromium.launch({headless:true}); await openPage(info);
  await createNewProject(page, {client:'Portable tracking QA', 'site-address':'10 Private Fixture Lane'});
  stage = 'creating the issued Quote source';
  await openProjectSection(page, 'quote'); let quote = page.locator('#commercial-quote-root');
  await quote.getByRole('button', {name:'New Quote', exact:true}).click(); await idle();
  const quoteTitle = 'Q-01: Portable tracking QA';let workTitle;
  await expect(quote.getByLabel('Document title', {exact:true})).toHaveCount(0);
  // New Quote loads the active estimate asynchronously. Wait for that owned
  // line before clearing the selection for this four-row tracking fixture.
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await quote.locator('.commercial-estimate-picker summary').click();
  for (const checkbox of await quote.locator('.commercial-estimate-options input[type=checkbox]').all()) {
    if (await checkbox.isChecked()) {await checkbox.uncheck(); await idle();}
  }
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(0);
  const expected = [
    {description:'Paid fixture row', quantity:'2', price:'125.25'},
    {description:'Free fixture row', quantity:'1', price:'0'},
    {description:'Credit fixture row', quantity:'1', price:'-5'},
    {description:'Paid fixture row', quantity:'2', price:'125.25'}
  ];
  for (const row of expected) {
    await quote.getByRole('button', {name:'Add custom row', exact:true}).click();
    const current = quote.locator('.commercial-lines tbody tr').last();
    await current.locator('textarea').fill(row.description); await current.locator('input').first().fill(row.quantity);
    await current.locator('input').last().fill(row.price);
  }
  await saveDocument(quote); await download(quote); await saveProject();
  const originalQuote = documents(info).find(value => value.kind === 'quote');
  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click(); await openProjectSection(page, 'work-orders');
  let work = page.locator('#commercial-work-order-root'); await work.getByRole('button', {name:'New Work Order', exact:true}).click(); await idle();
  await expect(work.getByLabel('Document title', {exact:true})).toHaveCount(0);
  await work.getByLabel('Linked Quote', {exact:true}).selectOption(originalQuote.id);
  await work.getByLabel('Proposed start date', {exact:true}).fill('2026-11-10');
  await work.getByLabel('Category / urgency', {exact:true}).selectOption('Medium Priority');
  await work.getByLabel('Description of works', {exact:true}).fill('Synthetic tracking fixture installation');
  const directory=async()=>(await page.request.get(new URL('/api/contacts/directory',page.url()).href)).json();
  const billing=work.locator('[data-claim-billing]'), initialDirectory=await directory();
  await expect(billing.locator('input,textarea')).toHaveCount(5);
  assert.ok(await billing.evaluate(el=>el.getBoundingClientRect().bottom <= el.parentElement.querySelector('[data-tracking-field=claimed_percent]').getBoundingClientRect().top));
  await billing.getByLabel('Billing address',{exact:true}).fill('Level 2, 40 Claim Street');
  await billing.getByLabel('ABN/ACN',{exact:true}).fill('ABN 11 111 111 111');
  await billing.getByLabel('Accounts name',{exact:true}).fill('Accounts Example');
  await billing.getByLabel('Accounts email',{exact:true}).fill('accounts@example.test');
  await billing.getByLabel('Accounts phone',{exact:true}).fill('0400 111 222');
  await billing.getByLabel('Accounts phone',{exact:true}).blur();
  for(const width of [1515,390]){
    await page.setViewportSize({width,height:940});
    // Crop just the claim card; exclude the sticky application chrome from this capture.
    await billing.locator('..').screenshot({path:path.join(output,'billing-claim-'+width+'.png'),
      style:'.app-header,.skip-link,.commercial-editor-actions,.commercial-panel-actions,.project-floating-actions{visibility:hidden!important}'});
  }
  await page.setViewportSize({width:1515,height:1000});
  assert.equal((await directory()).version,initialDirectory.version,'Typing never modifies the directory');
  const percentages = {completed_percent:['', '1', '37.5', '100'], claimed_percent:['100', '', '1', '37.5']};
  for (const [key, values] of Object.entries(percentages)) {
    const rows = trackingRows(work, key); await expect(rows).toHaveCount(4);
    for (const [index, value] of values.entries()) await rows.nth(index).locator('input').fill(value);
  }
  for(const [index,row] of expected.entries()) {
    row.notes=['Paid progress note','Free progress note','Credit progress note','Duplicate progress note'][index];
    await trackingRows(work,'completed_percent').nth(index).locator('textarea').fill(row.notes);
  }
  const noteWidths=await work.locator('[data-tracking-field=completed_percent] th').evaluateAll(headers=>headers.slice(2).map(header=>header.getBoundingClientRect().width));
  assert.ok(Math.abs(noteWidths[0]-noteWidths[1])<2,'Notes and % completed share equal column widths');
  const certification = work.getByLabel('Certification details', {exact:true}), completion = work.getByLabel('Completion', {exact:true});
  assert.deepEqual(await certification.locator('option').allTextContents(), ['', 'Certification issued', 'Certification not issued']);
  assert.deepEqual(await completion.locator('option').allTextContents(), ['', 'Completed', 'Ongoing', 'On hold', 'Not completed']);
  await certification.selectOption('Certification issued'); await completion.selectOption('Ongoing');
  await assertTracking(work, expected, percentages); await saveDocument(work);
  const newlySavedBilling=ownedWork(info).fields.billing;
  const immediateContact=work.locator(`.commercial-linked-contact[data-contact-id="${newlySavedBilling.contact_id}"]`);
  const immediateButton=immediateContact.getByRole('button',{name:'Accounts Example',exact:true});
  await expect(immediateButton).toBeVisible();
  const newDirectoryContact=(await directory()).contacts.find(person=>person.id===newlySavedBilling.contact_id);
  assert.equal(newDirectoryContact.account_id,newlySavedBilling.account_id);
  const billingSnapshot=structuredClone(ownedWork(info).fields.billing);
  await immediateButton.click();
  const contactDialog=page.getByRole('dialog',{name:'Edit Contact',exact:true});await expect(contactDialog).toBeVisible();
  await contactDialog.getByLabel('Title',{exact:true}).fill('Accounts coordinator');
  await contactDialog.getByRole('button',{name:'Save',exact:true}).click();await expect(contactDialog).toBeHidden();
  await expect(immediateContact).toContainText('Accounts coordinator');
  const editedDirectoryContact=(await directory()).contacts.find(person=>person.id===newlySavedBilling.contact_id);
  assert.equal(editedDirectoryContact.title,'Accounts coordinator');assert.equal(editedDirectoryContact.account_id,newlySavedBilling.account_id);
  assert.deepEqual(ownedWork(info).fields.billing,billingSnapshot,'Editing the linked directory Contact does not rewrite the saved Work Order billing snapshot');
  await saveProject();
  checks.push('New billing Contact is clickable immediately after Save without Refresh; exact-ID/company popup Title edit saves and refreshes while the Work Order billing snapshot stays unchanged');
  const linkedBilling=ownedWork(info).fields.billing, afterBilling=await directory();
  const billingPerson=afterBilling.contacts.find(person=>person.id===linkedBilling.contact_id);
  assert.equal(billingPerson.name,'Accounts Example');assert.equal(billingPerson.account_id,linkedBilling.account_id);
  const billingCompany=afterBilling.accounts.find(row=>row.id===linkedBilling.account_id);
  assert.equal(billingCompany.billing_address,'Level 2, 40 Claim Street');
  assert.equal(billingCompany.abn_acn,'ABN 11 111 111 111');
  assert.equal(billingCompany.billing_contact_id,linkedBilling.contact_id);
  assert.deepEqual(afterBilling.accounts.filter(row=>row.id!==billingCompany.id),
                   initialDirectory.accounts.filter(row=>row.id!==billingCompany.id),'Other companies retain their details');
  stage = 'editing another percentage after saving without reopening';
  percentages.claimed_percent[1] = '25';
  await trackingRows(work, 'claimed_percent').nth(1).locator('input').fill('25');
  expected[2].notes='Credit progress note updated\nSecond line';
  await trackingRows(work,'completed_percent').nth(2).locator('textarea').fill(expected[2].notes);
  await saveDocument(work); await saveProject();
  assert.equal(ownedWork(info).fields.work_tracking.rows[1].claimed_percent, '25', 'A second percentage edit in the same open editor survives another Save');
  assert.equal((await directory()).contacts.filter(person=>person.name==='Accounts Example').length,1,'Resaving the same claim keeps its single billing contact');
  assert.equal(ownedWork(info).fields.work_tracking.rows[2].notes,expected[2].notes,'A later Notes edit in the same open editor survives another Save');
  const initialWork = ownedWork(info), baseline = initialWork.fields.work_tracking;workTitle=initialWork.reference+': '+initialWork.fields.details.client;
  assert.equal(baseline.project_id, stored(info).commercial_documents.project_id);
  assert.equal(baseline.quote_id, originalQuote.id); assert.equal(baseline.quote_reference, originalQuote.last_number);
  checks.push('All issued rows and independent percentages, including free/credit/duplicates, persist with selected certification/completion and their owning Project/Quote IDs');

  stage = 'live language binding and canonical source preservation';
  const lineIds = await trackingRows(work, 'completed_percent').evaluateAll(rows => rows.map(row => row.dataset.trackingLine));
  evidence.languages = [];
  for (const language of ['zh-Hans', 'ar', 'en']) {
    await work.locator('.commercial-editor-actions button').first().click();
    await page.locator('nav [data-view="settings"]').click(); await idle();
    await page.locator('#application-language-toggle').click();
    await page.locator(`#application-language-menu [data-language-code="${language}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language === 'en' ? 'en-AU' : language);
    work = await openDocument('work-orders', workTitle); await assertTracking(work, expected, percentages);
    assert.deepEqual(await trackingRows(work, 'completed_percent').evaluateAll(rows => rows.map(row => row.dataset.trackingLine)), lineIds);
    await expect(work.locator('[data-order-field=certification]')).toHaveValue('Certification issued');
    await expect(work.locator('[data-order-field=completion]')).toHaveValue('Ongoing');
    const labels = await work.locator('[data-tracking-field=completed_percent]').evaluate(host => {
      const signature = host.parentElement.querySelector('[data-signature-field=progress_by] button');
      return {headers:[...host.querySelectorAll('th')].map(value => value.textContent), heading:host.parentElement.querySelector('h2').textContent,
        headingSource:window.CeasefireI18n.source(host.parentElement.querySelector('h2')),
        action:signature.title, actionSource:window.CeasefireI18n.source(signature, 'title')};
    });
    assert.equal(labels.headingSource, 'Works in Progress'); assert.equal(labels.actionSource, 'Sign Progress signed by');
    const english = ['Product / Service', 'Quantity', 'Notes', '% completed'];
    if (language === 'en') {assert.deepEqual(labels.headers, english); assert.equal(labels.heading, 'Works in Progress'); assert.equal(labels.action, labels.actionSource);}
    else {assert.ok(labels.headers.every((value, index) => value !== english[index]), JSON.stringify(labels)); assert.notEqual(labels.heading, 'Works in Progress'); assert.notEqual(labels.action, labels.actionSource);}
    evidence.languages.push({language, ...labels});
  }
  checks.push('Chinese and Arabic controls/headings translate on real language-menu navigation while canonical descriptions, identities, percentages and enum values stay unchanged; reopening in English restores the original UI labels');

  stage = 'issued source remains immutable after an unissued Quote edit';
  await work.getByRole('button', {name:'Back to Work Orders', exact:true}).click(); quote = await openDocument('quote', quoteTitle);
  await quote.locator('.commercial-lines tbody tr').first().locator('textarea').fill('Unissued changed Quote row'); await saveDocument(quote);
  await quote.getByRole('button', {name:'Back to Quotes', exact:true}).click(); work = await openDocument('work-orders', workTitle);
  await assertTracking(work, expected, percentages); await saveDocument(work); await saveProject();
  assert.deepEqual(ownedWork(info).fields.work_tracking, baseline);
  assert.equal(documents(info).find(value => value.kind === 'quote').fields.lines[0].description, 'Unissued changed Quote row');
  checks.push('An edited but unissued Quote draft cannot replace the Work Order original issued row snapshot');

  stage = 'main Project save and reload';
  await loadProject(); work = await openDocument('work-orders', workTitle);
  await assertTracking(work, expected, percentages);
  await expect(work.getByLabel('Certification details', {exact:true})).toHaveValue('Certification issued');
  await expect(work.getByLabel('Completion', {exact:true})).toHaveValue('Ongoing');
  await page.screenshot({path:path.join(output, 'reopened-tracking.png'), fullPage:true});
  checks.push('Main Project Save and native Load reopen the exact row percentages and selected enum values');

  stage = 'prefilling a new claim from its client and designated accounts contact';
  await work.getByRole('button', {name:'Back to Work Orders', exact:true}).click();
  await work.getByRole('button', {name:'New Work Order',exact:true}).click();
  await idle();
  const newBilling=work.locator('[data-claim-billing]');
  await expect(newBilling.getByLabel('Billing address',{exact:true})).toHaveValue(billingCompany.billing_address);
  await expect(newBilling.getByLabel('ABN/ACN',{exact:true})).toHaveValue(billingCompany.abn_acn);
  await expect(newBilling.getByLabel('Accounts name',{exact:true})).toHaveValue(billingPerson.name);
  await expect(newBilling.getByLabel('Accounts email',{exact:true})).toHaveValue(billingPerson.email);
  await expect(newBilling.getByLabel('Accounts phone',{exact:true})).toHaveValue(billingPerson.phone);
  checks.push('A new claim prefills the exact billing company address, ABN and its designated accounts contact');

  stage = 'saved-board billing contact retry';
  await page.close();await openPage(info);
  assert.equal((await page.evaluate(()=>window.CeasefireProject.context())).project_token,null);
  work=await openDocument('work-orders',workTitle);
  const boardClaim=work.locator('[data-claim-billing]');
  await boardClaim.getByLabel('Accounts name',{exact:true}).fill('Board accounts');
  await boardClaim.getByLabel('Accounts email',{exact:true}).fill('board.accounts@example.test');
  await boardClaim.getByLabel('Accounts phone',{exact:true}).fill('0400 333 444');
  await work.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(boardClaim.getByRole('button',{name:'Apply billing choices',exact:true})).toBeVisible();
  await boardClaim.getByRole('button',{name:'Create a separate Contact',exact:true}).click();
  await page.route('**/api/commercial/complete-billing',route=>route.fulfill({status:503,
    contentType:'application/json',body:JSON.stringify({error:'Temporary accounts directory failure'})}));
  const savedBoard=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/commercial/saved-save');
  await work.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await savedBoard).status(),200);
  await expect(work.locator('.commercial-message')).toContainText('Temporary accounts directory failure');
  await expect(boardClaim).toContainText('Accounts contact link pending');
  assert.equal((await directory()).contacts.filter(person=>person.name==='Board accounts').length,0);
  const staged=ownedWork(info).fields.billing;
  assert.equal(staged.name,'Board accounts');assert.ok(staged.new_contact_key);
  await page.unroute('**/api/commercial/complete-billing');
  await saveDocument(work);
  assert.equal((await directory()).contacts.filter(person=>person.id===staged.contact_id).length,1);
  await expect(work.locator(`.commercial-linked-contact[data-contact-id="${staged.contact_id}"]`).getByRole('button',{name:'Board accounts',exact:true})).toBeVisible();
  assert.equal(ownedWork(info).fields.billing.new_contact_key,staged.new_contact_key);
  checks.push('A saved-board work order retains its pending billing details through a directory failure, then links exactly one contact on explicit retry');

  stage = 'portable cold cache';
  const coldFolder = path.join(output, 'cold'); fs.mkdirSync(coldFolder, {recursive:true});
  fs.copyFileSync(info.project, path.join(coldFolder, 'browser-project.cf.json'));
  fs.cpSync(path.join(info.directory, '.ceasefire-evidence'), path.join(coldFolder, '.ceasefire-evidence'), {recursive:true});
  const cold = await fixture(coldFolder); await page.close(); await openPage(cold); await loadProject(); work = await openDocument('work-orders', workTitle);
  const database = path.join(cold.directory, 'commercial-documents', 'documents.sqlite3');
  const issuedCount = Number(execFileSync(python, ['-c', 'import sqlite3,sys;db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(db.execute("SELECT count(*) FROM commercial_issued").fetchone()[0]);db.close()', database], {encoding:'utf8', windowsHide:true}));
  assert.equal(issuedCount, 0, 'The portable reopen has no warm issued-document cache');
  await assertTracking(work, expected, percentages); assert.deepEqual(ownedWork(cold).fields.work_tracking, baseline);
  await expect(work.locator('[data-claim-billing]')).toContainText('The billing Company is unavailable in this directory');
  await trackingRows(work, 'claimed_percent').nth(2).locator('input').fill('100');
  await work.getByLabel('Completion', {exact:true}).selectOption('On hold'); await saveDocument(work); await saveProject();
  const coldWork = ownedWork(cold); assert.equal(coldWork.id, initialWork.id); assert.equal(coldWork.fields.work_tracking.source_hash, baseline.source_hash);
  assert.deepEqual(coldWork.fields.billing,staged);assert.equal((await directory()).contacts.length,0);
  assert.equal(coldWork.fields.work_tracking.rows[2].claimed_percent, '100'); assert.equal(coldWork.fields.order.completion, 'On hold');
  const issued = await download(work), text = execFileSync(python, ['-c', 'from pypdf import PdfReader;import sys;print("\\n".join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))', issued.path], {encoding:'utf8', windowsHide:true});
  for (const value of ['Paid fixture row', 'Free fixture row', 'Credit fixture row', 'Paid progress note', 'Free progress note', 'Credit progress note updated', '37.5', '100', 'On hold', 'Certification issued','$125.25','-$5.00']) assert.ok(text.replace(/\s+/g,' ').includes(value), value);
  await saveProject(); evidence.coldPdf = issued.path; evidence.ownership = {project:baseline.project_id, quote:baseline.quote_id, workOrder:coldWork.id};
  checks.push('A second private server restores the portable baseline with no issued cache, saves new percentages in the same owner, and emits a real PDF containing original rows and updated values');

  stage = 'legacy narrative preservation';
  const legacy = stored(cold), legacyWork = legacy.commercial_documents.documents.find(value => value.id === initialWork.id);
  delete legacyWork.fields.work_tracking;
  legacyWork.fields.order.progress = 'Historic progress narrative must stay unchanged'; legacyWork.fields.order.claim = 'Historic claim narrative must stay unchanged';
  legacyWork.fields.order.certification = 'Historical certification narrative'; legacyWork.fields.order.completion = 'Historical completion narrative';
  for (const key of ['progress_by', 'progress_date', 'closed_date']) delete legacyWork.fields.order[key];
  fs.writeFileSync(cold.project, JSON.stringify(legacy)); await loadProject(); work = await openDocument('work-orders', workTitle);
  const notes = work.locator('details.commercial-tracking-legacy'); await expect(notes).toHaveCount(2);
  for (const disclosure of await notes.all()) {await disclosure.locator('summary').click(); await expect(disclosure.locator('p')).toBeVisible(); await expect(disclosure.locator('textarea,input,[contenteditable]')).toHaveCount(0);}
  await expect(notes.nth(0)).toContainText(legacyWork.fields.order.progress); await expect(notes.nth(1)).toContainText(legacyWork.fields.order.claim);
  await expect(work.getByLabel('Certification details', {exact:true})).toHaveValue('Historical certification narrative');
  await expect(work.getByLabel('Completion', {exact:true})).toHaveValue('Historical completion narrative');
  await expect(work.locator('[data-tracking-field="completed_percent"]')).toContainText('The original issued Quote rows are unavailable.');
  await work.getByLabel('Description of works', {exact:true}).fill('Unrelated safe edit to an old Work Order'); await saveDocument(work); await saveProject();
  const preserved = ownedWork(cold).fields;
  for (const key of ['progress', 'claim', 'certification', 'completion']) assert.equal(preserved.order[key], legacyWork.fields.order[key]);
  assert.equal(Object.hasOwn(preserved, 'work_tracking'), false, 'A legacy cold-cache Work Order never invents issued rows');
  await page.screenshot({path:path.join(output, 'legacy-narrative.png'), fullPage:true});
  checks.push('Old narrative values appear in read-only disclosures, remain unchanged after an unrelated save, and unavailable legacy source rows are not invented');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed:true, checks, evidence, errors, failedRequests}, null, 2));
  console.log('PASS Work Order tracking lifecycle: ' + output);
})().catch(async error => {
  console.error(stage + ': ' + error.stack); process.exitCode = 1;
  if (page) {console.error(await page.locator('.commercial-message').allTextContents().catch(() => [])); await page.screenshot({path:path.join(output, 'failure.png'), fullPage:true}).catch(() => {});}
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed:false, stage, error:String(error), checks, evidence, errors, failedRequests}, null, 2));
}).finally(async () => {
  await browser?.close();
  for (const entry of servers) {fs.writeFileSync(path.join(entry.folder, 'server.log'), entry.logs); entry.process.kill();}
});
