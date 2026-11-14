// Native-dialog responses and directory data are isolated from the live app.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','project-new-popup-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page;
server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const errors=[],checks=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);}
async function oldDraft(){return page.evaluate(()=>({context:window.CeasefireProject.runtimeContext(),details:window.CeasefireProject.details(),file:window.CeasefireProject.context().project_path,inputs:[...document.querySelectorAll('#main-estimate-form input,#main-estimate-form select,#main-estimate-form textarea')].map(input=>[input.id,input.value])}));}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(45000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}`);await idle();
  await page.getByRole('button',{name:'Estimates',exact:true}).click();await page.locator('#input-B4').fill('3');await page.locator('#input-B4').press('Tab');await idle();
  const before=await oldDraft();await openProjectSection(page,'quotes');
  await page.locator('#new-quote').click();const modal=page.locator('#project-new-dialog');await expect(modal).toBeVisible();
  await expect(modal.locator('#project-pane-address')).toHaveJSProperty('tagName','TEXTAREA');await expect(modal.locator('#project-pane-address')).toHaveCSS('resize','vertical');
  await expect(page.locator('#view-quotes')).toBeVisible();assert.equal(await page.locator('#project-pane-client').count(),1);
  await page.locator('#project-pane-address').fill('Cancelled modal draft');await page.locator('#project-new-cancel').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();await expect(modal).toBeHidden();assert.deepEqual(await oldDraft(),before);
  checks.push('New opens a reusable modal in Projects; Cancel keeps every active input and context');
  await page.locator('#new-quote').click();await expect(modal).toBeVisible();await page.locator('#project-account-new').click();
  const account=page.getByRole('dialog',{name:'New Company',exact:true});await account.getByLabel('Company',{exact:true}).fill('Popup Account');await account.getByRole('button',{name:'Save',exact:true}).click();await expect(account).toBeHidden();
  await expect(page.locator('#project-pane-client')).toHaveValue('Popup Account');await page.locator('#project-pane-address').fill('12 Popup Road');
  await modal.getByLabel('Next action',{exact:true}).fill('Arrange initial inspection');
  await modal.getByLabel('Follow-up due',{exact:true}).fill('2028-02-29');
  assert.equal(await page.locator('#project-contact-new .button-symbol').innerHTML(),await page.locator('#project-account-new .button-symbol').innerHTML());
  await expect(page.locator('#project-contact-new .button-symbol')).toHaveText('+');
  await page.locator('#project-contact-new').click();const contact=page.getByRole('dialog',{name:'New Contact',exact:true});
  await expect(contact.getByLabel('Company',{exact:true})).toHaveValue('Popup Account');
  await contact.getByLabel('Name',{exact:true}).fill('Popup Contact');await contact.getByLabel('Phone',{exact:true}).fill('12345678');await contact.getByLabel('Email',{exact:true}).fill('popup@example.test');
  await contact.getByRole('button',{name:'Save',exact:true}).click();await expect(contact).toBeHidden();
  await expect(page.locator('#project-pane-contact-name')).toHaveValue('Popup Contact');await expect(page.locator('#project-pane-contact-phone')).toHaveValue('12345678');
  await page.locator('#project-pane-contact-phone').fill('Manual phone');await page.locator('#project-pane-contact-email').fill('manual@example.test');
  await page.locator('#project-pane-contact-name').focus();const box=await page.locator('#project-pane-contact-name').boundingBox();await page.mouse.click(box.x+box.width-24,box.y+box.height/2);
  await expect(page.locator('#project-pane-contact-name')).toHaveValue('');await expect(page.locator('#project-pane-contact-phone')).toHaveValue('');await expect(page.locator('#project-pane-contact-email')).toHaveValue('');
  await expect(page.locator('#project-pane-client')).toHaveValue('');assert.equal((await page.evaluate(()=>window.CeasefireProjectPane.fingerprint())).includes('Popup Account'),false);
  await page.locator('#project-pane-contact-name').fill('Popup');await page.locator('#project-contact-options').getByRole('option',{name:/Popup Contact/}).click();
  await expect(page.locator('#project-pane-contact-email')).toHaveValue('popup@example.test');
  await expect(page.locator('#project-pane-client')).toHaveValue('Popup Account');
  checks.push('Inline Contact + matches Company glyph, creates canonical linked defaults, native clear removes Client/overrides and reselection restores the linked Client');
  for(const width of [1915,1101,390]){
    await page.setViewportSize({width,height:1000});const geometry=await modal.evaluate(dialog=>({columns:getComputedStyle(dialog.querySelector('.project-pane-fields')).gridTemplateColumns.split(' ').length,width:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.equal(geometry.columns,2);assert.ok(geometry.width<=geometry.viewport);await page.screenshot({path:path.join(output,'modal-'+width+'.png')});
  }
  await page.setViewportSize({width:1915,height:1000});
  await page.locator('#project-details-save').click();await page.locator('#discard-dialog').getByRole('button',{name:'Keep editing',exact:true}).click();await expect(modal).toBeVisible();assert.deepEqual(await oldDraft(),before);assert.equal(fs.existsSync(info.project),false);
  let cancelOnce=true;await page.route('**/api/project/save-as',route=>{if(cancelOnce){cancelOnce=false;return route.fulfill({status:200,contentType:'application/json',body:'{"cancelled":true}'});}return route.continue();});
  await page.locator('#project-details-save').click();await page.locator('#discard-dialog').getByRole('button',{name:'New project',exact:true}).click();
  await expect(page.locator('#project-details-status')).toContainText('Save cancelled');await expect(modal).toBeVisible();await expect(page.locator('#project-pane-address')).toHaveValue('12 Popup Road');assert.deepEqual(await oldDraft(),before);assert.equal(fs.existsSync(info.project),false);
  await page.unroute('**/api/project/save-as');const response=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));
  await page.locator('#project-details-save').click();assert.equal((await response).status(),200);await expect(modal).toBeHidden();await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),true);await expect(page.locator('#view-quotes')).toBeVisible();
  const file=JSON.parse(fs.readFileSync(info.project));assert.equal(file.estimate.client,'Popup Account');assert.equal(file.estimate.contact_name,'Popup Contact');assert.equal(file.estimate.contact_phone,'12345678');assert.ok(file.estimate.contact_id);assert.match(file.estimate.project_no,/^PN-/);
  assert.equal(file.project_follow_up.actions.length,1);
  assert.deepEqual(file.project_follow_up.actions[0],{id: file.project_follow_up.actions[0].id,next_action:'Arrange initial inspection',follow_up_date:'2028-02-29',status:''});
  await openProjectSection(page,'documentation');await expect(page.locator('#view-documentation')).toBeVisible();
  checks.push('Dirty review and picker Cancel retain modal/draft; confirmed Save assigns a real usable Project before Documentation');
  // A new modal starts focused in Client. Use a complete, distinct project to
  // reach the file-save boundary and exercise a lost reply.
  const firstNumber=file.estimate.project_no, prior=await oldDraft();
  fs.renameSync(info.project,path.join(output,'first-project.cf.json'));
  await openProjectSection(page,'quotes');await page.locator('#new-quote').click();await expect(modal).toBeVisible();
  await expect(page.locator('#project-pane-client')).toBeFocused();await expect(page.locator('#project-account-options')).toBeVisible();
  await page.locator('#project-pane-contact-name').fill('Popup');
  await page.locator('#project-contact-options').getByRole('option',{name:/Popup Contact/}).click();
  await page.locator('#project-pane-address').fill('Second Popup Site');
  await page.locator('#project-pane-client').focus();
  let lost=true;
  await page.route('**/api/project/save-as',async route=>{
    if(lost){lost=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');}
    else await route.continue();
  });
  await page.locator('#project-details-save').click();
  const review=page.locator('#discard-dialog');
  await Promise.race([review.waitFor({state:'visible'}),page.locator('#project-details-status').filter({hasText:'could not be confirmed'}).waitFor()]);
  if(await review.isVisible())await review.getByRole('button',{name:'New project',exact:true}).click();
  await expect(page.locator('#project-details-status')).toContainText('could not be confirmed');
  assert.equal(fs.existsSync(info.project),true);assert.deepEqual(await oldDraft(),prior);
  await expect(page.locator('#project-new-cancel')).toBeDisabled();await expect(page.locator('#project-details-save')).toBeEnabled();
  const lostFile=JSON.parse(fs.readFileSync(info.project));assert.notEqual(lostFile.estimate.project_no,firstNumber);assert.equal(lostFile.estimate.client,'Popup Account');
  assert.equal(lostFile.estimate.site_address,'Second Popup Site');
  const recovering=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));
  await page.locator('#project-details-save').click();assert.equal((await recovering).status(),200);await expect(modal).toBeHidden();await idle();
  assert.equal(await page.locator('#project-no').inputValue(),lostFile.estimate.project_no);assert.equal(await page.locator('#client').inputValue(),'Popup Account');
  assert.equal(await page.locator('#project-contact-name').inputValue(),'Popup Contact');assert.deepEqual(JSON.parse(fs.readFileSync(info.project)),lostFile);
  await page.unroute('**/api/project/save-as');checks.push('Save survives Client blur; lost native Save response keeps active Project and exact retry recovers the single committed file');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS New Project popup: '+output);
})().catch(async error=>{console.error(error);console.error(logs);console.error(errors);if(page)console.error(await page.evaluate(()=>({pending:window.CeasefireProjectPane.hasPendingOperation(),fingerprint:window.CeasefireProjectPane.fingerprint(),status:document.querySelector('#project-details-status').textContent,contacts:typeof window.ClassifireContacts?.createAccount,dialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>[dialog.id,dialog.textContent.slice(0,150)])})).catch(()=>({})));await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
