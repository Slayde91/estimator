const {chromium,expect:baseExpect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,fillProjectDetails,clickProjectControl}=require('./project_actions.cjs');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa',`commercial-project-workflows-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});});
const errors=[],checks=[],writes=[];
async function idle(){await page.waitForFunction(()=>{const value=window.CeasefireDesktop?.status();return value?.ready&&!value.busy;});}
async function save(host){await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();await expect(host.locator('.commercial-message')).toContainText('Document saved.');await idle();}
async function state(){const id=await page.evaluate(()=>window.CeasefireCertification.sessionId());return (await page.request.get(new URL('/api/commercial/state?workspace='+id,page.url()).href)).json();}
(async()=>{
  const info=await ready;browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  for(const [section,name] of [['quote','Quote'],['work-orders','Work Order'],['purchase-orders','Purchase Order']]){
    await openProjectSection(page,section);const before=writes.length;
    await page.getByRole('button',{name:'New '+name,exact:true}).click();
    await expect(page.locator('#app-message')).toContainText('Create or load a project before creating documents.');
    assert.equal(writes.length,before,'Blocked creation makes no document/default POST request');
    await expect(page.locator('.commercial-editor')).toHaveCount(0);
  }
  checks.push('all commercial New actions notify without creating drafts or making mutation/default requests when no project exists');
  await fillProjectDetails(page,{client:'Procurement receiver','site-address':'17 Procurement Road'});
  await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();
  for(const [id,value] of Object.entries({'project-pane-contact-name':'Project Contact','project-pane-contact-phone':'0400 123 456',
    'project-pane-contact-email':'project-contact@example.test','project-pane-billing-address':'Billing floor 2\nSynthetic company office','project-pane-abn-acn':'ABN 12 345'}))await page.locator('#'+id).fill(value);
  await page.locator('#project-details-close').click();
  const projectSave=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page,'Save');assert.equal((await projectSave).status(),200);await idle();
  await openProjectSection(page,'quote');const quote=page.locator('#commercial-quote-root'),card=quote.locator('.commercial-card');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await quote.getByRole('button',{name:'Create WO',exact:true}).click();
  await expect(quote.locator('.commercial-message')).toHaveText('Save this Quote before creating a Work Order.');
  assert.equal((await state()).documents.filter(doc=>doc.kind==='work_order').length,0);
  const identityBoxes=await Promise.all(['Document date','Site address','Client','Client contact'].map(label=>quote.locator('.commercial-details').getByLabel(label,{exact:true}).boundingBox()));
  assert.ok(Math.abs(identityBoxes[0].y-identityBoxes[1].y)<2 && identityBoxes[1].x>identityBoxes[0].x);
  assert.ok(identityBoxes[2].y>identityBoxes[0].y && Math.abs(identityBoxes[2].y-identityBoxes[3].y)<2);
  for(const [label,value] of [['Client','Procurement receiver'],['Client contact','Project Contact'],['Client phone','0400 123 456'],
    ['Client email','project-contact@example.test'],['Site address','17 Procurement Road']]){
    const projectField=quote.locator('.commercial-details').getByLabel(label,{exact:true});
    await expect(projectField).toHaveValue(value);await expect(projectField).toHaveAttribute('readonly','');
  }
  assert.equal(await quote.getByLabel('Document date',{exact:true}).getAttribute('readonly'),null);
  await expect(quote.locator('.commercial-sidebar').first()).toContainText('Billing floor 2');await expect(quote.locator('.commercial-sidebar').first()).toContainText('ABN 12 345');
  checks.push('Quote Project identity/contact fields follow all saved Project values and are readonly; Document date stays editable and Company pane uses Project billing/ABN');
  await quote.getByLabel('Introduction',{exact:true}).fill('Procurement source quote');
  await quote.locator('.commercial-estimate-picker summary').click();
  const add=quote.getByRole('button',{name:'Add custom row',exact:true});
  for(const token of ['button','primary','icon-only','penetration-new-item-action'])assert.ok((await add.getAttribute('class')).split(/\s+/).includes(token));
  await expect(add.locator('.button-symbol')).toHaveText('+');await add.click();await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  await quote.getByRole('button',{name:'Remove row',exact:true}).click();
  for(const action of ['Save','Download PDF']){
    const beforeCapture=writes.length,editorVersion=await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()).editor.version);
    await page.evaluate(()=>{
      window.__qaOriginalCapture=window.CeasefireEstimates.capture;
      window.CeasefireEstimates.capture=async(...args)=>{
        const result=await window.__qaOriginalCapture(...args);window.__qaCaptureDetails=window.CeasefireProject.details;
        window.CeasefireProject.details=()=>({...window.__qaCaptureDetails(),contact_name:'Changed during async estimate capture'});
        return result;
      };
    });
    await quote.locator('.commercial-editor-actions').getByRole('button',{name:action,exact:true}).click();
    await expect(quote.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await expect(quote.locator('.commercial-message')).toHaveText('The Project details changed while saving. Reopen this document to use the current Project details.');
    assert.equal(writes.slice(beforeCapture).filter(write=>['/api/commercial/save','/api/commercial/issue'].includes(write.path)).length,0,action+' rejects changed Project data before saving or issuing');
    assert.equal(await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()).editor.version),editorVersion);
    await expect(quote.getByLabel('Introduction',{exact:true})).toHaveValue('Procurement source quote');
    await page.evaluate(()=>{window.CeasefireEstimates.capture=window.__qaOriginalCapture;window.CeasefireProject.details=window.__qaCaptureDetails;delete window.__qaOriginalCapture;delete window.__qaCaptureDetails;});
  }
  checks.push('Save and Download capture Project ownership before asynchronous estimate capture; changes during capture make no Save/Issue request and preserve the document draft');
  await save(quote);
  const issue=page.waitForResponse(response=>response.url().endsWith('/api/commercial/issue'));
  await quote.getByRole('button',{name:'Download PDF',exact:true}).click();assert.equal((await issue).status(),200);await expect(quote.locator('.commercial-message')).toContainText('PDF saved');await idle();
  const sourceQuote=(await state()).documents.find(doc=>doc.kind==='quote');
  async function deferWorkOrderDefaults(){
    let resolveHeld,held;const ready=new Promise(resolve=>resolveHeld=resolve);
    await page.route('**/api/commercial/defaults',async route=>{
      if(route.request().postDataJSON()?.kind!=='work_order'){await route.continue();return;}
      const response=await route.fetch();held={route,response};resolveHeld();
    });
    return {ready,async reject(){await held.route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic Work Order defaults failure.'})});await page.unroute('**/api/commercial/defaults');}};
  }
  let deferred=await deferWorkOrderDefaults(),intentWrites=writes.length;
  await quote.getByRole('button',{name:'Create WO',exact:true}).click();await deferred.ready;
  for(const label of ['Create WO','Save','Back to Quotes'])await expect(quote.getByRole('button',{name:label,exact:true})).toBeDisabled();
  await expect(quote.getByLabel('Introduction',{exact:true})).toBeDisabled();
  await quote.getByRole('button',{name:'Create WO',exact:true}).evaluate(button=>{button.click();button.click();});
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).evaluate(button=>button.click());
  await page.evaluate(()=>window.CeasefireCommercial.activate('work_order'));
  await expect(quote.getByLabel('Introduction',{exact:true})).toHaveValue('Procurement source quote');
  assert.equal(writes.slice(intentWrites).filter(write=>write.path==='/api/commercial/defaults'&&write.body.kind==='work_order').length,1);
  await deferred.reject();await expect(quote.locator('.commercial-message')).toHaveText('Synthetic Work Order defaults failure.');
  await expect(quote.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await expect(quote.getByLabel('Introduction',{exact:true})).toBeEnabled();
  await expect(quote.getByLabel('Introduction',{exact:true})).toHaveValue('Procurement source quote');assert.equal((await state()).documents.filter(doc=>doc.kind==='work_order').length,0);
  checks.push('Deferred toolbar Create WO holds its editor and disables editing/Back; repeated clicks/navigation make one defaults request, rejection preserves entered text and releases controls');
  // A second real saved Quote makes the board ownership check meaningful.
  const workspace=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  const capturedForOther=await page.evaluate(()=>window.CeasefireEstimates.capture({readOnly:true,commercial:true}));
  const otherQuoteResponse=await page.request.post(new URL('/api/commercial/save',page.url()).href,{data:{...capturedForOther,workspace_id:workspace,id:require('node:crypto').randomUUID(),version:0,kind:'quote',status:'Draft',fields:{...sourceQuote.fields,introduction:'Another saved Quote'}}});
  assert.equal(otherQuoteResponse.status(),200,await otherQuoteResponse.text());const otherQuote=await otherQuoteResponse.json();
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();await page.evaluate(()=>window.CeasefireCommercial.activate('quote'));
  const sourceCard=quote.locator(`[data-document-id="${sourceQuote.id}"]`),otherCard=quote.locator(`[data-document-id="${otherQuote.id}"]`);
  await expect(otherCard).toBeVisible();deferred=await deferWorkOrderDefaults();intentWrites=writes.length;
  await sourceCard.locator('.commercial-card-menu>summary').click();await sourceCard.getByRole('button',{name:'Create WO',exact:true}).click();await deferred.ready;
  await otherCard.locator('.project-title-button').click();await sourceCard.locator('.commercial-menu-options button').filter({hasText:/^Create WO$/}).evaluate(button=>button.click());
  await expect(quote.locator('.commercial-editor')).toHaveCount(0);assert.equal(writes.slice(intentWrites).filter(write=>write.path==='/api/commercial/defaults'&&write.body.kind==='work_order').length,1);
  await deferred.reject();await expect(quote.locator('.commercial-message')).toHaveText('Synthetic Work Order defaults failure.');
  assert.equal((await state()).documents.filter(doc=>doc.kind==='work_order').length,0);
  const deleted=await page.request.post(new URL('/api/commercial/delete',page.url()).href,{data:{workspace_id:workspace,id:otherQuote.id,version:otherQuote.version}});assert.equal(deleted.status(),200,await deleted.text());
  await page.evaluate(()=>window.CeasefireCommercial.activate('quote'));await quote.locator(`[data-document-id="${sourceQuote.id}"] .project-title-button`).click();
  await expect(quote.getByLabel('Introduction',{exact:true})).toHaveValue('Procurement source quote');
  checks.push('Deferred board Create WO reserves the original Quote; another saved Quote and repeated derivation cannot steal the target; failed read creates no Work Order');
  await quote.locator('.commercial-editor-actions').getByRole('button',{name:'Create WO',exact:true}).click();
  const work=page.locator('#commercial-work-order-root');await expect(work.getByRole('button',{name:'Create PO',exact:true})).toBeVisible();
  await expect(work.getByLabel('Linked Quote',{exact:true})).toHaveValue(sourceQuote.id);
  await expect(work.getByLabel('Client contact',{exact:true})).toHaveValue('Project Contact');await expect(work.getByLabel('Client email',{exact:true})).toHaveValue('project-contact@example.test');
  await expect(work.getByLabel('Document title',{exact:true})).toHaveCount(0);
  await work.getByLabel('Description of works',{exact:true}).fill('Manual works description');await work.getByLabel('Estimated cost (AUD)',{exact:true}).fill('987');
  let before=writes.length;await work.getByRole('button',{name:'Create PO',exact:true}).click();
  await expect(work.locator('.commercial-message')).toHaveText('Save this Work Order before creating a Purchase Order.');assert.equal(writes.length,before);
  await expect(work.getByLabel('Description of works',{exact:true})).toHaveValue('Manual works description');await save(work);
  const firstWork=(await state()).documents.find(doc=>doc.kind==='work_order'),workTitle=firstWork.reference+': '+firstWork.fields.details.client;assert.ok(firstWork.reference);assert.equal(firstWork.last_number,'');
  await work.getByLabel('Description of works',{exact:true}).fill('Uncommitted manual works change');before=writes.length;
  await work.getByRole('button',{name:'Create PO',exact:true}).click();await expect(work.locator('.commercial-message')).toHaveText('Save this Work Order before creating a Purchase Order.');assert.equal(writes.length,before);
  await expect(work.getByLabel('Description of works',{exact:true})).toHaveValue('Uncommitted manual works change');
  assert.equal((await state()).documents.filter(doc=>doc.kind==='purchase_order').length,0);
  await save(work);
  const stale=(await state()).documents.find(doc=>doc.kind==='work_order');
  const externalFields=JSON.parse(JSON.stringify(stale.fields));externalFields.order.description='A newer saved Work Order scope';
  externalFields.lines=[{estimate_id:'',description:'Copied supplier equipment',quantity:'3',unit_price:'800',size:'Large',comments:'Manual procurement instruction'}];
  const external=await page.request.post(new URL('/api/commercial/save',page.url()).href,{data:{workspace_id:await page.evaluate(()=>window.CeasefireCertification.sessionId()),
    id:stale.id,version:stale.version,kind:stale.kind,status:stale.status,fields:externalFields}});assert.equal(external.status(),200);
  const staleRequest=page.waitForResponse(response=>response.url().endsWith('/api/commercial/purchase-order-defaults'));
  await work.getByRole('button',{name:'Create PO',exact:true}).click();assert.equal((await staleRequest).status(),409);
  await expect(work.locator('.commercial-message')).toContainText('changed');await expect(work.getByLabel('Description of works',{exact:true})).toHaveValue('Uncommitted manual works change');
  assert.equal((await state()).documents.filter(doc=>doc.kind==='purchase_order').length,0);
  await work.getByRole('button',{name:'Back to Work Orders',exact:true}).click();await openProjectSection(page,'quote');await openProjectSection(page,'work-orders');
  await work.getByRole('button',{name:workTitle,exact:true}).click();
  const source=(await state()).documents.find(doc=>doc.kind==='work_order'),sourceFile=fs.readFileSync(info.project,'utf8');
  const poDefaults=page.waitForResponse(response=>response.url().endsWith('/api/commercial/purchase-order-defaults'));
  await work.getByRole('button',{name:'Create PO',exact:true}).click();assert.equal((await poDefaults).status(),200);
  const purchase=page.locator('#commercial-purchase-order-root');await expect(purchase.getByLabel('Linked Work Order',{exact:true})).toHaveValue(source.id);
  await expect(purchase.locator('.commercial-work-layout>.commercial-sidebar')).toHaveCount(2);
  for(const title of ['Notes (0)','Files (0)','Linked Work Orders (1)','Linked Quotes (1)'])await expect(purchase.locator('.commercial-sidebar summary').filter({hasText:title})).toHaveCount(1);
  await expect(purchase.locator('.commercial-sidebar').first().locator('summary')).toHaveText(['Company Details','Linked Contacts']);
  await expect(purchase.locator('.commercial-details [data-project-detail=site_address]')).toHaveCount(0);
  await expect(purchase.getByRole('combobox',{name:'Site contact',exact:true})).toHaveValue('Project Contact');await expect(purchase.getByLabel('Site contact number',{exact:true})).toHaveValue('0400 123 456');await expect(purchase.getByLabel('Ship to address',{exact:true})).toHaveValue('17 Procurement Road');
  for(const label of ['Supplier','Supplier email','Supplier contact','Payment terms','Requested by name'])await expect(purchase.getByLabel(label,{exact:true})).toHaveValue('');
  await expect(purchase.getByLabel('Purchase Order No.',{exact:true})).toHaveValue('');
  assert.equal(fs.readFileSync(info.project,'utf8'),sourceFile,'Creating the PO draft leaves the source project file unchanged');
  assert.deepEqual((await state()).documents.find(doc=>doc.id===source.id),source);assert.equal((await state()).documents.filter(doc=>doc.kind==='purchase_order').length,0);
  const information=purchase.locator('.commercial-order-fields').filter({has:page.getByRole('heading',{name:'Purchase order information',exact:true})});
  assert.equal(await information.evaluate(section=>section.nextElementSibling.className),'commercial-lines');
  const expense=purchase.getByLabel('Type of expense',{exact:true});assert.equal(await expense.evaluate(control=>control.tagName),'SELECT');
  await expect(expense.locator('option')).toHaveText(['','Labour','Materials','Services','Hire','Other']);await expense.selectOption('Hire');
  const sections=purchase.locator('.commercial-order-fields');
  for(const width of [1915,1011]){
    await page.setViewportSize({width,height:1000});
    const requestBox=await purchase.locator('.commercial-purchase-request').boundingBox(),totalBox=await purchase.locator('.commercial-totals').boundingBox();
    assert.ok(Math.abs(requestBox.y-totalBox.y)<2 && requestBox.x+requestBox.width<=totalBox.x,'Request signature remains left of totals in the same row');
    const projectBox=await purchase.getByLabel('Project number',{exact:true}).boundingBox(),linkedBox=await purchase.getByLabel('Linked Work Order',{exact:true}).boundingBox();
    assert.ok(projectBox.x<linkedBox.x && Math.abs(projectBox.y-linkedBox.y)<2,'Project number precedes Linked Work Order');
  }
  await page.setViewportSize({width:1600,height:1000});
  await expect(sections.locator('h2')).toHaveText(['Purchase order information','Request','Approval','Sent by','Procurement verification']);
  for(const [title,fields] of [['Request',['requested_by','requested_date']],['Approval',['approval','rejection_reason','reviewed_by','review_date']],['Sent by',['sent_by','sent_date']],['Procurement verification',['verification','verified_by','verified_date']]]) {
    const section=sections.filter({has:page.getByRole('heading',{name:title,exact:true})});
    assert.deepEqual(await section.locator('[data-order-field]').evaluateAll(controls=>controls.map(control=>control.dataset.orderField)),fields);
  }
  const item=purchase.locator('.commercial-lines tbody tr');await expect(item).toHaveCount(1);
  await expect(item.locator('.commercial-line-description')).toHaveValue('Copied supplier equipment');await expect(item.locator('input[type="number"]').first()).toHaveValue('3');
  await expect(item.locator('input[type="number"]').last()).toHaveValue('0');await expect(purchase.locator('.commercial-message')).toContainText('Enter supplier prices');
  await item.locator('input[type="number"]').last().fill('25');await expect(item.locator('.commercial-line-total')).toHaveText('$75.00');
  for(const width of [1600,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`purchase-draft-${width}.png`),fullPage:true});}
  await page.setViewportSize({width:1600,height:1000});await save(purchase);
  const persisted=await state(),po=persisted.documents.find(doc=>doc.kind==='purchase_order');assert.equal(po.reference,'PO-01');assert.equal(po.last_number,'');assert.equal(po.fields.order.work_order_id,source.id);assert.equal(po.fields.order.work_order_reference,source.reference);assert.equal(po.fields.order.expense_type,'Hire');
  await purchase.getByRole('button',{name:'New note',exact:true}).click();const note=page.getByRole('dialog',{name:'Purchase Order note',exact:true});
  await note.getByLabel('Note title',{exact:true}).fill('Owned PO note');await note.locator('[contenteditable=true]').fill('PO-specific note content');
  await note.getByRole('button',{name:'Done',exact:true}).click();await expect(note).toBeHidden();await idle();
  await purchase.locator('input[type=file]').setInputFiles(info.fixture);await expect(purchase.locator('.commercial-sidebar summary').filter({hasText:'Files (1)'})).toHaveCount(1);await save(purchase);
  const withEvidence=await state(),evidence=withEvidence.documents.find(doc=>doc.id===po.id);assert.equal(evidence.fields.notes[0].title,'Owned PO note');assert.equal(evidence.fields.files.length,1);
  assert.equal(withEvidence.documents.find(doc=>doc.id===source.id).fields.notes,undefined,'PO notes remain confined to their owning document');
  await purchase.getByLabel('Supplier',{exact:true}).fill('Save race supplier');
  const editorBeforeRace=await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()).editor),fileBeforeRace=fs.readFileSync(info.project,'utf8');
  await page.route('**/api/commercial/save',async route=>{
    const response=await route.fetch();
    await page.evaluate(()=>{window.__qaProjectDetails=window.CeasefireProject.details;window.CeasefireProject.details=()=>({...window.__qaProjectDetails(),contact_name:'A concurrently changed Project contact'});});
    await route.fulfill({response});
  });
  await purchase.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(purchase.locator('.commercial-message')).toHaveText('The Project details changed while saving. Reopen this document to use the current Project details.');
  assert.equal((await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()).editor)).version,editorBeforeRace.version,'A stale Project snapshot response is not adopted as the current editor');
  assert.equal(fs.readFileSync(info.project,'utf8'),fileBeforeRace,'A changed Project snapshot prevents publishing the stale document to its project file');
  await page.unroute('**/api/commercial/save');await page.evaluate(()=>{window.CeasefireProject.details=window.__qaProjectDetails;delete window.__qaProjectDetails;});
  await purchase.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();
  await page.getByRole('dialog',{name:'Discard the current purchase order?',exact:true}).getByRole('button',{name:'Yes',exact:true}).click();
  await openProjectSection(page,'quote');await openProjectSection(page,'purchase-orders');
  await purchase.locator(`.commercial-card[data-document-id="${po.id}"] .project-title-button`).click();
  await expect(purchase.getByRole('combobox',{name:'Site contact',exact:true})).toHaveValue('Project Contact');
  checks.push('A changed Project snapshot while Save is in flight leaves the editor unadopted, keeps the project file intact, and recovers after explicit reopen');
  assert.deepEqual(persisted.documents.find(doc=>doc.id===source.id),source);
  checks.push('Create PO preserves unsaved source edits, then creates a linked unnumbered draft; explicit Save assigns PO reference without issuing or changing the source Work Order');
  checks.push('Purchase Order retains Notes/Files/actual linked Work Order and Quote panes without a Company/Contact sidebar, preserving bounded attachments and CAS-autosaved notes');
  await purchase.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();await openProjectSection(page,'work-orders');
  await work.getByRole('button',{name:workTitle,exact:true}).click();await expect(work.locator('summary').filter({hasText:'Linked Purchase Orders (1)'})).toHaveCount(1);
  checks.push('PO Request summary follows information, expense categories use a dropdown, and the saved relationship appears in the Work Order reverse list');
  await page.screenshot({path:path.join(output,'work-order-linked-purchase.png'),fullPage:true});
  const quoteOwner=(await state()).documents.find(doc=>doc.kind==='quote'),projectDetails=await page.evaluate(()=>window.CeasefireProject.details());
  const directDefaults=await page.request.post(new URL('/api/commercial/defaults',page.url()).href,{data:{workspace_id:await page.evaluate(()=>window.CeasefireCertification.sessionId()),kind:'purchase_order',project_details:projectDetails}});
  assert.equal(directDefaults.status(),200);const directFields=(await directDefaults.json()).fields;directFields.title='Direct Quote-linked PO';directFields.order.quote_id=quoteOwner.id;
  const directReply=await page.request.post(new URL('/api/commercial/save',page.url()).href,{data:{workspace_id:await page.evaluate(()=>window.CeasefireCertification.sessionId()),kind:'purchase_order',status:'Draft',fields:directFields,project_details:projectDetails}});
  assert.equal(directReply.status(),200);const directPurchase=await directReply.json();
  const unrelatedFields=JSON.parse(JSON.stringify(directFields));unrelatedFields.title='Same Company unrelated PO';unrelatedFields.order.quote_id='';
  const unrelated=await page.request.post(new URL('/api/commercial/save',page.url()).href,{data:{workspace_id:await page.evaluate(()=>window.CeasefireCertification.sessionId()),kind:'purchase_order',status:'Draft',fields:unrelatedFields,project_details:projectDetails}});
  assert.equal(unrelated.status(),200);
  await work.getByRole('button',{name:'Back to Work Orders',exact:true}).click();await openProjectSection(page,'quote');
  await card.locator('.project-title-button').click();
  const relatedPurchases=quote.locator('.commercial-side-panel').filter({has:page.locator('summary').filter({hasText:'Linked Purchase Orders (2)'})});
  await expect(relatedPurchases).toHaveCount(1);await expect(relatedPurchases.getByRole('button')).toHaveCount(2);await expect(relatedPurchases).not.toContainText('Same Company unrelated PO');
  await relatedPurchases.getByRole('button').filter({hasText:directPurchase.reference}).click();
  await expect(purchase.locator('.commercial-side-panel summary').filter({hasText:'Linked Work Orders (0)'})).toHaveCount(1);await expect(purchase.locator('.commercial-side-panel summary').filter({hasText:'Linked Quotes (1)'})).toHaveCount(1);
  await purchase.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();await openProjectSection(page,'quote');await card.locator('.project-title-button').click();
  await relatedPurchases.getByRole('button').filter({hasText:'PO-01'}).click();await expect(purchase.getByLabel('Purchase Order No.',{exact:true})).toHaveValue('PO-01');
  await expect(purchase.locator('.commercial-sidebar summary').filter({hasText:'Notes (1)'})).toHaveCount(1);await expect(purchase.locator('.commercial-sidebar summary').filter({hasText:'Files (1)'})).toHaveCount(1);
  checks.push('Quote Linked Purchase Orders follows the exact Quote→Work Order→Purchase Order chain or explicit direct Quote ID, excludes same-Company unrelated POs, and opens the owner with saved notes/files');
  // New Project now stages a popup and preserves the active Project on Cancel.
  // A fresh tab represents a separate user workspace with no active Project.
  const previousPage=page;
  page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();await previousPage.close();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),false);
  const sourceWork=page.locator('#commercial-work-order-root'),sourcePurchase=page.locator('#commercial-purchase-order-root');
  await openProjectSection(page,'work-orders');await sourceWork.getByRole('button',{name:workTitle,exact:true}).click();
  const ownerFile=fs.readFileSync(info.project,'utf8'),nativeDefaults=page.waitForResponse(response=>response.url().endsWith('/api/commercial/saved-purchase-order-defaults'));
  await sourceWork.getByRole('button',{name:'Create PO',exact:true}).click();assert.equal((await nativeDefaults).status(),200);
  await expect(sourcePurchase.getByLabel('Linked Work Order',{exact:true})).toHaveValue(source.id);
  await expect(sourcePurchase.getByRole('combobox',{name:'Site contact',exact:true})).toHaveValue('Project Contact');
  await expect(sourcePurchase.getByLabel('Ship to address',{exact:true})).toHaveValue('17 Procurement Road');
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),null,'Native saved-source creation does not replace the active unsaved Project');
  assert.equal(fs.readFileSync(info.project,'utf8'),ownerFile,'Native source creation leaves owner file unchanged until Save');
  checks.push('a verified native saved-source Project can prepare its own PO with no active global Project, without changing owner file or replacing active workspace');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,sourceId:source.id,purchaseId:po.id,errors},null,2));console.log('PASS commercial project workflows. '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();});
