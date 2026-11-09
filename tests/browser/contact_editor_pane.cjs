// Saved Contact editing uses the existing guarded directory pane. All records
// and native Project saves live inside this fixture's private temporary folder.
const {chromium,expect:baseExpect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','contact-editor-pane-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page,releaseSave,releaseLinks;
server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture startup timed out')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const checks=[],errors=[],geometry=[];
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base='http://127.0.0.1:'+info.port;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  const api=async(route,body)=>{const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});assert.equal(response.status(),200,await response.text());return response.json();};
  const directory=()=>api('/api/contacts/directory');
  await api('/api/projects/link-folder',{});
  let state=await directory();const lead=await api('/api/contacts/leads',{version:state.version,fields:{name:'Pane Contact',company:'Pane Company',phone:'111',email:'pane@example.test',title:'Estimator',site_address:'Synthetic Contact site'}});
  state=await directory();const person=state.contacts.find(contact=>contact.id===state.leads.find(row=>row.id===lead.id).contact_id);assert.ok(person);
  await api('/api/contacts/leads/convert',{version:state.version,id:lead.id});
  state=await directory();const other=await api('/api/contacts/contacts',{version:state.version,fields:{name:'Second Contact',company:'Pane Company',phone:'222',email:'second@example.test'}});
  await expect.poll(async()=>{const catalog=await api('/api/contacts/contact-links?id='+person.id);return catalog.linked.projects.length;}).toBe(1);
  const beforeRead=await directory();
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  await page.locator('#contacts-navigation-toggle').click();const host=page.locator('#contacts-root');await host.locator('.contacts-tabs').getByRole('button',{name:'Contacts',exact:true}).click();
  const owner=host.locator('.contacts-results').getByRole('button',{name:person.name,exact:true});await owner.click();
  const pane=page.getByRole('complementary',{name:'Edit Contact',exact:true});await expect(pane).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(pane.getByLabel('Name',{exact:true})).toBeFocused();
  await expect(pane.locator('.contacts-links-group > summary')).toHaveText(['Companies (1)','Projects (1)']);await expect(pane.locator('.contacts-links')).toContainText('Synthetic Contact site');
  await expect(pane.locator('.contacts-links')).not.toContainText('Second Contact');await expect(pane.locator('.contacts-links input')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasUnsavedChanges()),false);assert.deepEqual(await directory(),beforeRead,'Opening and reading related records never writes the directory');
  const unchanged=await page.evaluate(()=>window.CeasefireProject.context());
  const activePane=host.locator('.contacts-contact-pane');
  for(const locale of ['zh-Hans','hi','es','ar','th','ko','tl','vi','fr','bn','ur']){
    await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);
    const translated=await page.evaluate(()=>Object.fromEntries(['Edit Contact','Saved records linked to this Contact are shown here.','Discard changes to this contact?','Cancel'].map(key=>[key,window.CeasefireI18n.translate(key)])));
    await expect(activePane.getByRole('heading',{name:translated['Edit Contact'],exact:true})).toBeVisible();
    await expect(activePane.getByText(translated['Saved records linked to this Contact are shown here.'],{exact:true})).toBeVisible();
    await activePane.locator('input[name=phone]').fill('Temporary language review');
    await activePane.getByRole('button',{name:translated.Cancel,exact:true}).click();
    const review=page.locator('#discard-dialog');await expect(review).toContainText(translated['Discard changes to this contact?']);
    await review.getByRole('button',{name:translated.Cancel,exact:true}).click();await expect(activePane.locator('input[name=phone]')).toHaveValue('Temporary language review');
    await activePane.locator('input[name=phone]').fill(person.phone);
  }
  await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
  assert.deepEqual(await directory(),beforeRead,'Localized Contact review never changes saved identity records');
  checks.push('All 11 translations render the Contact pane and discard confirmation while retaining canonical names and unsaved values');
  for(const width of [1915,1101,1000,825,571,570,390]){
    await page.setViewportSize({width,height:1000});
    const bounds=await host.evaluate(host=>{const pane=host.querySelector('.contacts-contact-pane').getBoundingClientRect(),list=host.querySelector('.contacts-workspace').getBoundingClientRect(),menu=host.querySelector('.contacts-document>summary').getBoundingClientRect(),create=host.querySelector('.contacts-controls>.primary').getBoundingClientRect();return{pane:pane.toJSON(),list:list.toJSON(),documentHeight:menu.height,createHeight:create.height,width:document.documentElement.scrollWidth,viewport:innerWidth};});
    assert.ok(bounds.width<=bounds.viewport,JSON.stringify(bounds));if(width>1000)assert.ok(bounds.pane.right<=bounds.list.left);else assert.ok(bounds.pane.bottom<=bounds.list.top);
    assert.ok(Math.abs(bounds.documentHeight-bounds.createHeight)<.5,JSON.stringify(bounds));geometry.push({width,...bounds});
    if([1915,390].includes(width))await page.screenshot({path:path.join(output,'pane-'+width+'.png'),fullPage:true});
  }
  checks.push('Saved Contact opens a labelled left pane; Company and actual Contact-linked Project are read-only related records; directory remains unchanged and Document/New buttons match at seven responsive widths');
  await page.setViewportSize({width:1915,height:1000});await pane.getByLabel('Phone',{exact:true}).fill('Changed phone');
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();const discard=page.locator('#discard-dialog');await expect(discard).toContainText('Discard changes to this contact?');await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(pane.getByLabel('Phone',{exact:true})).toHaveValue('Changed phone');
  await host.locator('.contacts-tabs').getByRole('button',{name:'Companies',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(pane).toBeVisible();
  await page.locator('.nav-button[data-view="home"]').click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#view-contacts')).toBeVisible();
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();await expect(discard).toBeVisible();await pane.getByLabel('Phone',{exact:true}).evaluate(input=>{input.value='Newer review edit';input.dispatchEvent(new Event('input',{bubbles:true}));});await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(pane).toBeVisible();await expect(pane.locator('[data-contacts-notice]')).toContainText('Contact changed during review');
  checks.push('Dirty Contact review blocks cancelled tab/global navigation and stale discard cannot erase newer values');
  let saveEntered;const entered=new Promise(resolve=>saveEntered=resolve),gate=new Promise(resolve=>releaseSave=resolve);
  await page.route('**/api/contacts/contacts',async route=>{const response=await route.fetch();saveEntered();await gate;await route.fulfill({response});});
  await pane.getByRole('button',{name:'Save',exact:true}).click();await entered;assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasPendingOperation()),true);await expect(pane.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
  await host.locator('.contacts-results').getByRole('button',{name:'Second Contact',exact:true}).click();await expect(pane.getByLabel('Name',{exact:true})).toHaveValue(person.name);await expect(pane.locator('[data-contacts-notice]')).toContainText('Finish the current Contact action');
  await page.locator('.nav-button[data-view="home"]').click();await expect(page.locator('#view-contacts')).toBeVisible();releaseSave();await expect(pane).toBeHidden();await page.unroute('**/api/contacts/contacts');
  assert.equal((await directory()).contacts.find(contact=>contact.id===person.id).phone,'Newer review edit');assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.context()),unchanged);
  await owner.click();await expect(pane.getByLabel('Phone',{exact:true})).toHaveValue('Newer review edit');await pane.getByLabel('Phone',{exact:true}).fill('Conflict draft');state=await directory();await api('/api/contacts/contacts',{version:state.version,fields:{name:'Competing Contact',company:'Competing Company',phone:'333',email:'competing@example.test'}});
  await pane.getByRole('button',{name:'Save',exact:true}).click();await expect(pane.locator('[data-contacts-notice]')).toContainText('Contacts have changed');await expect(pane.getByLabel('Phone',{exact:true})).toHaveValue('Conflict draft');assert.equal((await directory()).contacts.find(contact=>contact.id===person.id).phone,'Newer review edit');
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(pane).toBeHidden();await expect(owner).toBeVisible();await page.waitForFunction(()=>document.querySelector('#contacts-root').getAttribute('aria-busy')!=='true');
  checks.push('Held Save retains one editor and blocks replacement/navigation; concurrent directory changes retain a failed draft without mutating Project context');
  // A linked-record response from an old pane must not render into its replacement.
  let linksEntered,linksFinished;const oldLinkEntered=new Promise(resolve=>linksEntered=resolve),linkGate=new Promise(resolve=>releaseLinks=resolve),oldLinkFinished=new Promise(resolve=>linksFinished=resolve);
  await page.route('**/api/contacts/contact-links?*',async route=>{if(new URL(route.request().url()).searchParams.get('id')!==person.id)return route.continue();const response=await route.fetch();linksEntered();await linkGate;await route.fulfill({response});linksFinished();});
  await owner.click();await oldLinkEntered;await pane.getByRole('button',{name:'Close',exact:true}).click();await host.locator('.contacts-results').getByRole('button',{name:'Second Contact',exact:true}).click();await expect(pane.getByLabel('Name',{exact:true})).toHaveValue('Second Contact');await expect(pane.locator('.contacts-links-group > summary')).toHaveText(['Companies (1)']);releaseLinks();await oldLinkFinished;await page.unroute('**/api/contacts/contact-links?*');await expect(pane.locator('.contacts-links-group > summary')).toHaveText(['Companies (1)']);
  await pane.getByRole('button',{name:'Pane Company',exact:true}).click();const companyPane=page.getByRole('complementary',{name:'Edit Company',exact:true});await expect(companyPane).toBeVisible();await expect(companyPane.getByLabel('Company',{exact:true})).toHaveValue('Pane Company');await companyPane.getByRole('button',{name:'Second Contact',exact:true}).click();await expect(pane.getByLabel('Name',{exact:true})).toHaveValue('Second Contact');await pane.getByLabel('Name',{exact:true}).press('Escape');await expect(pane).toBeHidden();
  await host.getByRole('button',{name:'New Contact',exact:true}).click();const modal=page.getByRole('dialog',{name:'New Contact',exact:true});await expect(modal).toBeVisible();await modal.getByRole('button',{name:'Cancel',exact:true}).click();await expect(modal).toBeHidden();
  checks.push('Stale linked-record replies cannot replace a new Contact pane; related Company/Contact navigation is functional, Escape closes clean panes, and New Contact remains modal');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,geometry,errors},null,2));console.log('PASS Contact editor pane: '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#contacts-root').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{releaseSave?.();releaseLinks?.();await browser?.close();server.kill();});
