const {showEstimateNotes}=require('./estimate_notes.cjs');
// Project metadata editing runs against disposable project files and directory data.
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {openProjectSection,fillProjectDetails} = require('./project_actions.cjs');
const root = path.resolve(__dirname,'../..'), output = path.join(root,'.runtime/browser-qa','project-pane-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',stdout='',browser;
server.stderr.on('data',chunk=>{logs+=chunk;});
const ready = new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(logs || 'Fixture startup timed out')),120000);
  server.on('error',error=>{clearTimeout(timer);reject(error);});
  server.on('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});
  server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});
});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1915,height:884}});page.setDefaultTimeout(30000);
  const errors=[],calls=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().endsWith('/api/projects/load'))calls.push(request.postDataJSON());});
  const idle=()=>page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  await fillProjectDetails(page,{client:'Pane Alpha Account','site-address':'10 Synthetic Street'});
  await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();
  const address=page.locator('#project-pane-address');await expect(address).toHaveJSProperty('tagName','TEXTAREA');
  await expect(address).toHaveAttribute('rows','1');await expect(address).toHaveAttribute('maxlength','400');
  const shortAddressHeight=(await address.boundingBox()).height;
  await address.fill('10 Synthetic Street\nLevel 2');
  assert.ok((await address.boundingBox()).height>shortAddressHeight,'Site address expands to fit a second line');
  await page.locator('#project-pane-contact-name').fill('Alpha Person');
  await page.locator('#project-pane-contact-phone').fill('0400000001');
  await page.locator('#project-pane-contact-email').fill('alpha@example.test');
  await page.locator('#project-pane-billing-address').fill('Project accounts\nPO Box 42');
  await page.locator('#project-pane-abn-acn').fill('Project ABN');
  await page.locator('#project-details-close').click();
  let response=page.waitForResponse(r=>r.url().endsWith('/api/project/save-as'));
  await page.locator('#save-current-project').click();const initialSave=await response;assert.equal(initialSave.status(),200,await initialSave.text());await idle();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.equal(JSON.parse(fs.readFileSync(info.project,'utf8')).estimate.billing_address,'Project accounts\nPO Box 42');
  assert.equal(JSON.parse(fs.readFileSync(info.project,'utf8')).estimate.site_address,'10 Synthetic Street\nLevel 2');
  assert.equal(JSON.parse(fs.readFileSync(info.project,'utf8')).estimate.abn_acn,'Project ABN');
  await page.locator('#link-project-folder').click();await idle();
  fs.copyFileSync(info.project,path.join(output,'second-project.cf.json'));
  await page.locator('#refresh-quotes').click();await idle();
  const listing=await (await page.request.get(new URL('/api/projects',page.url()).href)).json();assert.equal(listing.files.length,2);
  const first=listing.files.find(file=>path.resolve(file.path)===path.resolve(info.project));
  const second=listing.files.find(file=>file.id!==first.id);
  const toggle=file=>page.locator(`[data-project-details-id="${file.id}"]`);
  const saved=()=>page.waitForResponse(r=>r.url().endsWith('/api/projects/details/save'));
  await expect(toggle(first)).toHaveCSS('color','rgb(208, 0, 27)');
  // Clean active-project metadata saves stay clean and rotate its writable target.
  await toggle(first).click();await idle();await expect(toggle(first)).toHaveText('>');
  await expect(toggle(first)).toHaveCSS('color','rgb(255, 221, 83)');
  const plusStyles = await page.evaluate(() => ['project-estimate-new','project-account-new'].map(id => {
    const style=getComputedStyle(document.getElementById(id));
    return Object.fromEntries(['backgroundColor','color','fontFamily','fontSize','fontWeight','width','height','borderTopWidth','borderRadius'].map(key=>[key,style[key]]));
  }));
  assert.deepEqual(plusStyles[0],plusStyles[1]);
  assert.equal(plusStyles[0].backgroundColor,'rgba(0, 0, 0, 0)');
  await expect(page.locator('#project-tools')).toBeHidden();
  const symbols=await page.locator('#project-estimate-new .add-symbol,#project-account-new .add-symbol').evaluateAll(nodes=>nodes.map(node=>node.innerHTML.trim()));
  assert.equal(symbols.length,2);assert.equal(symbols[0],symbols[1]);
  const firstRow=toggle(first).locator('xpath=ancestor::article');
  await firstRow.locator('summary').click();await firstRow.getByRole('button',{name:'Browse files',exact:true}).click();await idle();
  await expect(page.locator('#project-browser')).toBeVisible();await expect(page.locator('#project-details-pane')).toBeVisible();
  for(const width of [1915,1101,800,390]){
    await page.setViewportSize({width,height:884});
    const boxes=await page.evaluate(()=>({pane:document.querySelector('#project-details-pane').getBoundingClientRect().toJSON(),browser:document.querySelector('#project-browser').getBoundingClientRect().toJSON(),heading:document.querySelector('#project-browser>.section-heading').getBoundingClientRect().toJSON(),back:document.querySelector('#project-browser-close').getBoundingClientRect().toJSON(),inside:!!document.querySelector('.project-workspace-main>#project-browser'),width:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(boxes.inside);assert.ok(boxes.width<=boxes.viewport,JSON.stringify(boxes));
    if(width>900)assert.ok(boxes.pane.right<=boxes.browser.left,JSON.stringify(boxes));
    else assert.ok(boxes.pane.bottom<=boxes.browser.top,JSON.stringify(boxes));
    assert.ok(boxes.back.top>=boxes.heading.bottom);assert.ok(boxes.back.left<boxes.browser.left+35);
    await page.screenshot({path:path.join(output,`browser-pane-${width}.png`),fullPage:true});
  }
  await expect(page.locator('#project-browser-close')).toHaveText('←');
  await expect(page.locator('#project-browser-close')).toHaveAttribute('aria-label','Back to Projects');
  await page.setViewportSize({width:1915,height:884});await page.locator('#project-browser-close').click();
  await expect(page.locator('#project-list-card')).toBeVisible();await expect(page.locator('#project-details-pane')).toBeVisible();assert.equal(calls.length,0);
  await page.locator('.nav-button[data-view="estimate"]').click();
  await expect(page.locator('#project-tools')).toBeHidden();await expect(page.locator('.estimate-heading-art-slot')).toHaveCount(0);
  const estimateControls=page.locator('.project-estimate-controls');
  await expect(estimateControls.locator(':scope > .calculator-document-menu')).toHaveCount(1);
  await expect(estimateControls.locator('#project-estimate-create,#project-estimate-quote,#project-estimate-swms')).toHaveCount(0);
  const plusBox=await page.locator('#project-estimate-new').evaluate(button=>{const b=button.getBoundingClientRect(),s=button.querySelector('.add-symbol').getBoundingClientRect();return {offset:Math.abs((b.top+b.bottom)/2-(s.top+s.bottom)/2),left:b.left,select:document.querySelector('#project-estimate-select').getBoundingClientRect().left};});
  assert.ok(plusBox.offset<=1.1,JSON.stringify(plusBox));assert.ok(plusBox.left<plusBox.select+5);
  await openProjectSection(page,'quotes');
  await toggle(first).click();await idle();
  await page.locator('#project-pane-contact-name').fill('Updated Alpha Person');
  response=saved();await page.locator('#project-details-save').click();assert.equal((await response).status(),200);await idle();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  assert.equal((await page.evaluate(()=>window.CeasefireProject.details())).contact_name,'Updated Alpha Person');
  // A confirmed Account change in the active saved pane rebases the Current
  // opener's old validation baseline and remains valid for the next main Save.
  await page.locator('#project-pane-client').fill('Pane Gamma Account');await page.locator('#project-account-new').click();
  const activeAccount=page.getByRole('dialog',{name:'New Company',exact:true});
  await activeAccount.getByRole('button',{name:'Save',exact:true}).click();await expect(activeAccount).not.toBeVisible();
  response=saved();await page.locator('#project-details-save').click();const activeMetadata=await response;assert.equal(activeMetadata.status(),200,await activeMetadata.text());await idle();
  assert.equal((await page.evaluate(()=>window.CeasefireProject.details())).client,'Pane Gamma Account');
  response=page.waitForResponse(r=>r.url().endsWith('/api/project/save'));
  await page.locator('#save-current-project').click();const afterMetadataSave=await response;assert.equal(afterMetadataSave.status(),200,await afterMetadataSave.text());await idle();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await toggle(first).click();await expect(page.locator('#project-details-pane')).toBeHidden();await expect(toggle(first)).toHaveText('<');
  await expect(toggle(first)).toHaveCSS('color','rgb(208, 0, 27)');
  // Editing another file cannot replace the open estimate or its unsaved notes.
  await page.locator('.nav-button[data-view="estimate"]').click();await showEstimateNotes(page);await page.locator('#measurements').fill('Unsaved active estimate note');
  await openProjectSection(page,'quotes');await idle();
  const active=await page.evaluate(()=>window.CeasefireProject.projectPaneSnapshot());
  const original=fs.readFileSync(info.project);
  await toggle(second).click();await idle();
  await expect(page.locator('#project-pricing-context')).toHaveText(active.file.title);
  const pane=page.locator('#project-details-pane');
  const geometry={pane:await pane.boundingBox(),list:await page.locator('#project-list-card').boundingBox()};
  assert.ok(geometry.pane.x+geometry.pane.width<=geometry.list.x);
  const companyPanel=pane.locator('details').filter({has:page.locator('#project-company-participants')});
  const contactPanel=pane.locator('details').filter({has:page.locator('#project-contact-participants')});
  await expect(companyPanel.locator(':scope > summary')).toHaveText('Companies');
  await expect(contactPanel.locator(':scope > summary')).toHaveText('Contacts');
  const metadataOrder=await pane.locator('#project-details-form > .project-pane-fields').evaluateAll(groups=>
    groups.flatMap(group=>[...group.querySelectorAll('input[id],textarea[id]')].map(control=>control.id)));
  assert.deepEqual(metadataOrder,['project-pane-number','project-pane-address','project-pane-client','project-pane-billing-address',
    'project-pane-abn-acn','project-pane-contact-name','project-pane-contact-email','project-pane-contact-phone']);
  for(const panel of [companyPanel,contactPanel]){
    await expect(panel.locator('details')).toHaveCount(0);
    await panel.locator(':scope > summary').click();
    for(const id of ['project-pane-client','project-pane-billing-address','project-pane-abn-acn',
      'project-pane-contact-name','project-pane-contact-email','project-pane-contact-phone'])await expect(pane.locator('#'+id)).toBeVisible();
    await panel.locator(':scope > summary').click();
  }
  await page.locator('#project-pane-address').fill('20 Other Project Road');
  await page.locator('#project-pane-contact-name').fill('Other Project Person');
  response=saved();await page.locator('#project-details-save').click();assert.equal((await response).status(),200);await idle();
  await expect(page.locator('#project-pricing-context')).toHaveText(active.file.title);
  assert.deepEqual(fs.readFileSync(info.project),original);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.details()),active.details);
  assert.equal(await page.locator('#measurements').inputValue(),'Unsaved active estimate note');
  await expect(page.locator('#project-save-state')).toHaveText('Unsaved changes');assert.equal(calls.length,0);
  // Account search is canonical; the inline plus opens a real Accounts popup.
  const client=page.locator('#project-pane-client');await client.fill('Alpha');await client.focus();
  await expect(page.locator('#project-account-options').getByRole('option',{name:'Pane Alpha Account',exact:true})).toBeVisible();
  await page.locator('#project-account-options').getByRole('option',{name:'Pane Alpha Account',exact:true}).click();
  await page.locator('#project-pane-billing-address').fill('');await page.locator('#project-pane-abn-acn').fill('');
  await client.fill('Pane Beta Account');await page.locator('#project-account-new').click();
  const account=page.getByRole('dialog',{name:'New Company',exact:true});await expect(account).toBeVisible();
  await expect(account.getByLabel('Company',{exact:true})).toHaveValue('Pane Beta Account');
  await account.getByLabel('ABN/ACN',{exact:true}).fill('12 345 678 901');
  await account.getByLabel('Billing address',{exact:true}).fill('Company accounts\nPO Box 7');
  await account.getByRole('button',{name:'Save',exact:true}).click();await expect(account).not.toBeVisible();
  await expect(page.locator('#project-pane-billing-address')).toHaveValue('Company accounts\nPO Box 7');
  await expect(page.locator('#project-pane-abn-acn')).toHaveValue('12 345 678 901');
  response=saved();await page.locator('#project-details-save').click();assert.equal((await response).status(),200);await idle();
  const detail=(await (await page.request.post(new URL('/api/projects/details',page.url()).href,{data:{id:second.id}})).json()).details;
  assert.equal(detail.client,'Pane Beta Account');assert.match(detail.account_id,/^[0-9a-f-]{36}$/);
  assert.equal(detail.billing_address,'Company accounts\nPO Box 7');assert.equal(detail.abn_acn,'12 345 678 901');
  assert.deepEqual(fs.readFileSync(info.project),original);assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.details()),active.details);
  await page.screenshot({path:path.join(output,'pane-desktop.png'),fullPage:true});
  // A failed conditional save keeps edits and review on navigation is cancellable.
  const secondBefore=fs.readFileSync(second.path);
  await page.route('**/api/projects/details/save',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'The project changed. Refresh and open its details again.'})}));
  await page.locator('#project-pane-contact-name').fill('Unsaved conflict person');
  response=saved();await page.locator('#project-details-save').click();assert.equal((await response).status(),409);await idle();
  await expect(page.locator('#project-details-status')).toContainText('project changed');
  assert.deepEqual(fs.readFileSync(second.path),secondBefore);
  await page.locator('.nav-button[data-view="home"]').click();
  const discard=page.getByRole('dialog',{name:'Discard unsaved project details?',exact:true});await expect(discard).toBeVisible();
  await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#view-quotes')).toBeVisible();
  await page.locator('#project-details-close').click();await discard.getByRole('button',{name:'Yes',exact:true}).click();
  await page.unroute('**/api/projects/details/save');
  await toggle(second).click();await idle();
  for(const width of [1101,800,390]){
    await page.setViewportSize({width,height:884});
    const box=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,columns:getComputedStyle(document.querySelector('.project-pane-fields')).gridTemplateColumns.split(' ').length,pane:document.querySelector('#project-details-pane').getBoundingClientRect().toJSON(),list:document.querySelector('#project-list-card').getBoundingClientRect().toJSON()}));
    assert.ok(box.width<=box.viewport,JSON.stringify(box));assert.equal(box.columns,2);
    const numberWidth=(await page.locator('#project-pane-number').boundingBox()).width;
    assert.ok((await page.locator('#project-pane-address').boundingBox()).width >= numberWidth*2);
    const fields=await page.evaluate(()=>{
      const ids=['project-pane-number','project-pane-address','project-pane-client','project-pane-billing-address','project-pane-abn-acn',
        'project-pane-contact-name','project-pane-contact-email','project-pane-contact-phone'];
      return Object.fromEntries(ids.map(id=>[id,document.getElementById(id).getBoundingClientRect().toJSON()]));
    });
    const [number,addressBox,client,billing,abn,primary,email,phone]=Object.values(fields);
    assert.ok(client.top>=Math.max(number.bottom,addressBox.bottom) && billing.top>=client.bottom &&
      abn.top>=billing.bottom && primary.top>=abn.bottom && email.top>=primary.bottom && phone.top>=primary.bottom,JSON.stringify(fields));
    assert.ok(Math.abs(client.width-billing.width)<1 && Math.abs(billing.width-abn.width)<1 &&
      Math.abs(primary.width-client.width)<1,JSON.stringify(fields));
    for(const control of Object.values(fields))assert.ok(control.left>=box.pane.left && control.right<=box.pane.right,JSON.stringify(fields));
    if(width===800)assert.ok(box.pane.bottom<=box.list.top);
    await page.screenshot({path:path.join(output,`pane-${width}.png`),fullPage:true});
  }
  await expect(toggle(second)).toHaveAttribute('aria-expanded','true');
  // Fresh metadata must not grant write access to a stale open workspace.
  await page.setViewportSize({width:1915,height:884});await page.locator('#project-details-close').click();
  const external=JSON.parse(fs.readFileSync(info.project,'utf8'));
  external.estimate.measurements='External saved estimate note';
  external.estimates.find(entry=>entry.id===external.active_estimate_id).workspace.estimate.measurements='External saved estimate note';
  fs.writeFileSync(info.project,JSON.stringify(external,null,2));
  const externalBytes=fs.readFileSync(info.project);
  await toggle(first).click();await idle();
  await expect(page.locator('#project-details-status')).toContainText('changed outside this open estimate');
  await expect(page.locator('#project-details-save')).toBeDisabled();
  assert.equal((await page.evaluate(()=>window.CeasefireProject.projectPaneSnapshot())).file.save_token,active.file.save_token);
  await page.locator('#project-details-close').click();await page.locator('#project-current-details').click();
  await expect(page.locator('#project-pane-client')).toBeEnabled();await expect(page.locator('#project-pane-contact-name')).toBeEnabled();
  await page.locator('#project-details-close').click();
  response=page.waitForResponse(r=>r.url().endsWith('/api/project/save'));
  await page.locator('#save-current-project').click();assert.ok((await response).status()>=400);await idle();
  assert.deepEqual(fs.readFileSync(info.project),externalBytes);
  assert.equal((await page.evaluate(()=>window.CeasefireProject.projectPaneSnapshot())).file.save_token,active.file.save_token);
  assert.equal(calls.length,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({checks:['clean active metadata save','active metadata Account change remains valid for main Save','dirty active draft preserved','other file only updated','canonical account search and popup','conditional failure retains edit','Cancel and Yes discard review','desktop and mobile geometry','stale active workspace cannot acquire capability or overwrite external edits','blocked pane recovers current inputs'],geometry,errors},null,2));
  console.log('Project details pane browser checks passed: '+output);
})().catch(error=>{console.error(error);console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
