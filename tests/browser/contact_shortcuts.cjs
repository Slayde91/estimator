// Disposable acceptance for canonical lookups, inline creation and lead conversion.
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`contact-shortcuts-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,releaseDirectory;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1101,height:884}});
  const errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
  const directory=async()=>{const response=await page.request.get(base+'/api/contacts/directory');assert.equal(response.status(),200);return response.json();};
  async function save(kind,fields,extra={}){const response=await page.request.post(base+'/api/contacts/'+kind,{data:{fields,version:(await directory()).version,...extra}});assert.equal(response.status(),200,await response.text());return response.json();}
  const first=(await save('accounts',{company:'First Company',abn_acn:'ABN-A',billing_address:'First HQ'})).account;
  const second=(await save('accounts',{company:'Second Client',abn_acn:'ABN-B',billing_address:'Second HQ'})).account;
  const original=(await save('contacts',{name:'Alex Same',company:first.company,phone:'111',email:'first@example.test',title:'Manager'})).contact;
  await save('contacts',{name:'Alex Same',company:second.company,phone:'222',email:'second@example.test'});
  const twins=[];for(let i=0;i<2;i++)twins.push((await save('contacts',{name:'Twin',company:first.company,phone:'333'})).contact);
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await page.locator('button[data-view="contacts"]').click();const host=page.locator('#contacts-root');await expect(host.getByRole('button',{name:'New Lead',exact:true})).toBeVisible();
  const beforeInline=await directory();
  await page.evaluate(()=>{window.contactResult=window.ClassifireContacts.createContact({name:'Canceled contact',company:'Untrusted company string'});});
  let dialog=page.getByRole('dialog',{name:'New Contact',exact:true});await expect(dialog.getByLabel('Company',{exact:true})).toHaveValue('');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.contactResult),null);assert.deepEqual(await directory(),beforeInline);
  await page.evaluate(account=>{window.contactResult=window.ClassifireContacts.createContact({name:'Inline Contact',account_id:account});},second.id);
  dialog=page.getByRole('dialog',{name:'New Contact',exact:true});await expect(dialog.getByLabel('Company',{exact:true})).toHaveValue(second.company);await dialog.getByLabel('Phone',{exact:true}).fill('444');await dialog.getByLabel('Email',{exact:true}).fill('inline@example.test');await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).not.toBeVisible();
  const inline=await page.evaluate(()=>window.contactResult);assert.equal(inline.account_id,second.id);assert.equal(inline.company,second.company);assert.equal(inline.phone,'444');assert.ok((await directory()).contacts.some(row=>row.id===inline.id));
  checks.push('Inline Contact creation returns the canonical record, prefills only an explicit Account, and Cancel writes nothing');
  await page.evaluate(()=>window.ClassifireContacts.activate('leads'));
  await host.getByRole('button',{name:'New Lead',exact:true}).click();dialog=page.getByRole('dialog',{name:'New Lead',exact:true});
  const company=dialog.getByRole('combobox',{name:'Company',exact:true}),name=dialog.getByRole('combobox',{name:'Name',exact:true});
  await company.fill('Second');await dialog.getByRole('option',{name:/Second Client/}).click();await expect(company).toHaveValue(second.company);await expect(dialog.getByLabel('ABN/ACN',{exact:true})).toHaveValue('ABN-B');await expect(dialog.getByLabel('Billing address',{exact:true})).toHaveValue('Second HQ');
  await name.fill('Twin');const twinOptions=dialog.getByRole('listbox',{name:'Matching records',exact:true}).getByRole('option');await expect(twinOptions).toHaveCount(2);const twinLabels=await twinOptions.allTextContents();assert.equal(new Set(twinLabels).size,2);for(const twin of twins)assert.ok(twinLabels.some(label=>label.endsWith(twin.id.slice(-8))));await name.press('Escape');await expect(name).toHaveAttribute('aria-expanded','false');await expect(dialog).toBeVisible();
  await name.fill('Alex');const options=await dialog.getByRole('listbox',{name:'Matching records',exact:true}).getByRole('option').allTextContents();const index=options.findIndex(value=>value.includes(first.company));assert.ok(index>=0);for(let n=0;n<=index;n++)await name.press('ArrowDown');await expect(name).toHaveAttribute('aria-activedescendant',/options-\d+$/);await name.press('Enter');await expect(name).toHaveAttribute('aria-expanded','false');
  await expect(dialog.getByLabel('Phone',{exact:true})).toHaveValue(original.phone);await expect(dialog.getByLabel('Email',{exact:true})).toHaveValue(original.email);await expect(company).toHaveValue(second.company);
  const canonicalBefore=(await directory()).contacts;
  await dialog.getByLabel('Phone',{exact:true}).fill('Lead phone override');await dialog.getByLabel('Email',{exact:true}).fill('lead@example.test');await dialog.getByLabel('Site address',{exact:true}).fill('Lead Site');assert.deepEqual((await directory()).contacts,canonicalBefore);
  await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).not.toBeVisible();
  const savedDirectory=await directory(),lead=savedDirectory.leads[0];assert.equal(lead.contact_id,original.id);assert.equal(lead.account_id,second.id);assert.equal(lead.company,second.company);assert.equal(lead.phone,'Lead phone override');assert.deepEqual(savedDirectory.contacts,canonicalBefore);
  const card=host.locator('.project-kanban-card').filter({hasText:original.name}),convert=card.locator('.contacts-lead-convert');await expect(convert).toBeVisible();await expect(convert).toBeEnabled();await page.mouse.move(0,0);
  const style=await convert.evaluate(button=>{const css=getComputedStyle(button),box=button.getBoundingClientRect();return {background:css.backgroundColor,border:css.borderColor,color:css.color,width:box.width,height:box.height,src:button.querySelector('img').getAttribute('src')};});assert.deepEqual(style,{background:'rgb(255, 221, 83)',border:'rgb(188, 0, 34)',color:'rgb(173, 0, 29)',width:48,height:48,src:'/icons/takeoff-transfer.png'});
  checks.push('Lead Company and Name search support keyboard selection, identical-name disambiguation, ABN defaults and per-lead overrides without canonical edits');
  await card.screenshot({path:path.join(output,'lead-convert-card.png')});
  // The same Contact cannot silently acquire a duplicate active Lead.
  await host.getByRole('button',{name:'New Lead',exact:true}).click();dialog=page.getByRole('dialog',{name:'New Lead',exact:true});await dialog.getByLabel('Company',{exact:true}).fill(second.company);await dialog.getByRole('option',{name:/Second Client/}).click();await dialog.getByLabel('Name',{exact:true}).fill('Alex');await dialog.getByRole('option',{name:new RegExp(first.company)}).click();await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog.locator('[data-contacts-notice]')).toContainText('already has a lead');assert.deepEqual(await directory(),savedDirectory);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  // A stale editor cannot overwrite either the Lead or the canonical Contact.
  await card.locator('summary').click();await card.getByRole('button',{name:'Edit',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit Lead',exact:true});await save('contacts',{name:original.name,company:original.company,phone:'Explicit canonical edit',email:original.email,title:original.title},{id:original.id});await dialog.getByLabel('Phone',{exact:true}).fill('Stale lead edit');await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog.locator('[data-contacts-notice]')).toContainText('Contacts have changed');
  // Closing a stale editor refreshes the directory asynchronously. The old
  // card already contains the retained override, so its text cannot prove that
  // the new directory version has reached the UI before Convert is clicked.
  let directoryStarted;const refreshing=new Promise(resolve=>directoryStarted=resolve),directoryGate=new Promise(resolve=>releaseDirectory=resolve);
  await page.route('**/api/contacts/directory',async route=>{const response=await route.fetch();directoryStarted();await directoryGate;await route.fulfill({response});},{times:1});
  const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/contacts/directory'&&response.request().method()==='GET');refreshed.catch(()=>{});
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await refreshing;
  await expect(host).toHaveAttribute('aria-busy','true');await expect(card).toContainText('Lead phone override');
  releaseDirectory();const refreshedDirectory=await refreshed;assert.equal(refreshedDirectory.status(),200,await refreshedDirectory.text());
  const refreshedVersion=(await refreshedDirectory.json()).version;assert.ok(refreshedVersion>savedDirectory.version);
  await expect(host).not.toHaveAttribute('aria-busy','true');await expect(card).toContainText('Lead phone override');
  checks.push('Duplicate existing-Contact leads and stale dialog versions fail without partial directory writes');
  checks.push('A held stale-editor refresh leaves the old card visible; Convert starts only after the new directory response and completed render');
  const linked=await page.request.post(base+'/api/projects/link-folder',{data:{}});assert.equal(linked.status(),200);
  let release,started;const held=new Promise(resolve=>started=resolve);let count=0;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/contacts/leads/convert')count++;});
  await page.route('**/api/contacts/leads/convert',async route=>{started();await new Promise(resolve=>release=resolve);await route.continue();},{times:1});
  const reply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/contacts/leads/convert');await convert.evaluate(button=>{button.click();button.click();});await held;await expect(convert).toBeDisabled();release();const response=await reply;assert.equal(response.status(),200,await response.text());assert.equal(response.request().postDataJSON().version,refreshedVersion);const receipt=await response.json();assert.equal(count,1);
  await expect(page.locator('#view-estimate')).toBeVisible();await expect(page.locator('#project-no')).toHaveValue(receipt.project_no);
  const project=JSON.parse(fs.readFileSync(receipt.path,'utf8'));assert.equal(project.estimate.client,second.company);assert.equal(project.estimate.contact_id,original.id);assert.equal(project.estimate.contact_phone,'Lead phone override');assert.equal(project.estimate.contact_email,'lead@example.test');
  const current=await directory();assert.equal(current.leads.length,0);assert.equal(current.contacts.find(row=>row.id===original.id).account_id,original.account_id);assert.equal(current.contacts.find(row=>row.id===original.id).phone,'Explicit canonical edit');
  const replay=await page.request.post(base+'/api/contacts/leads/convert',{data:{id:lead.id,version:savedDirectory.version}});assert.equal(replay.status(),200);assert.deepEqual(await replay.json(),receipt);
  checks.push('Explicit Convert icon shares the replayable conversion flow, blocks duplicate clicks and opens the saved Project using the Lead snapshot');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS Contact shortcuts. '+output);
})().catch(async error=>{console.error(error);console.error(logs);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});})
  .finally(async()=>{releaseDirectory?.();await browser?.close();server.kill();});
