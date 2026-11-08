// Account edits remain beside their directory, with explicit save/discard and
// the existing atomic linked-record contract. All writes use private fixtures.
const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','account-editor-pane-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page,releaseSave;
server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture startup timed out')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const checks=[],errors=[],geometry=[];
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base='http://127.0.0.1:'+info.port;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  const api=async(route,body)=>{const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});assert.equal(response.status(),200,await response.text());return response.json();};
  const directory=()=>api('/api/contacts/directory');
  let state=await directory();const first=await api('/api/contacts/accounts',{version:state.version,fields:{company:'Pane Account',billing_address:'Original address\r\nSecond line'}});
  state=await directory();await api('/api/contacts/accounts',{version:state.version,fields:{company:'Second Account'}});
  state=await directory();const person=await api('/api/contacts/contacts',{version:state.version,fields:{name:'Pane Link Contact',email:'pane@example.test'}});
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  await page.locator('#contacts-navigation-toggle').click();const host=page.locator('#contacts-root');await host.locator('.contacts-tabs').getByRole('button',{name:'Companies',exact:true}).click();
  const owner=host.locator('.contacts-results').getByRole('button',{name:'Pane Account',exact:true});await owner.click();
  const pane=page.getByRole('complementary',{name:'Edit Company',exact:true});await expect(pane).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(pane.getByLabel('Company',{exact:true})).toBeFocused();
  await expect(pane.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasUnsavedChanges()),false,'Rendering imported CRLF addresses does not create an unsaved edit');
  const unchanged=await page.evaluate(()=>window.CeasefireProject.context());
  for(const width of [1915,1101,825,390]){
    await page.setViewportSize({width,height:1000});const bounds=await page.evaluate(()=>{const pane=document.querySelector('.contacts-account-pane').getBoundingClientRect(),list=document.querySelector('.contacts-workspace').getBoundingClientRect();return{pane:pane.toJSON(),list:list.toJSON(),width:document.documentElement.scrollWidth,viewport:innerWidth};});
    assert.ok(bounds.width<=bounds.viewport,JSON.stringify(bounds));if(width>1000)assert.ok(bounds.pane.right<=bounds.list.left);else assert.ok(bounds.pane.bottom<=bounds.list.top);geometry.push({width,...bounds});await page.screenshot({path:path.join(output,'pane-'+width+'.png'),fullPage:true});
  }
  checks.push('Edit Account opens a labelled left pane with the main list accessible; existing layout stacks at1000px without page overflow');
  await page.setViewportSize({width:1915,height:1000});
  await pane.getByLabel('ABN/ACN',{exact:true}).fill('12 345 678 901');await pane.getByLabel('Billing address',{exact:true}).fill('Changed address');
  assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasUnsavedChanges()),true);
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();const discard=page.locator('#discard-dialog');await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(pane.getByLabel('Billing address')).toHaveValue('Changed address');
  await page.locator('#contacts-navigation-toggle').click();await expect(discard).toBeHidden();await expect(pane).toBeVisible();
  await host.locator('.contacts-tabs').getByRole('button',{name:'Contacts',exact:true}).click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(host.locator('.contacts-tabs').getByRole('button',{name:'Companies',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.locator('.nav-button[data-view="home"]').click();await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#view-contacts')).toBeVisible();await expect(pane).toBeVisible();
  // A changed draft while the review is open must not be discarded by an old
  // confirmation, even if a background caller changes it programmatically.
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();await expect(discard).toBeVisible();await pane.getByLabel('Billing address').evaluate(input=>{input.value='Concurrent review edit';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(pane).toBeVisible();await expect(pane.locator('[data-contacts-notice]')).toContainText('changed during review');
  checks.push('Cancel, same Contacts header and cancelled internal/global navigation keep the draft; stale discard review cannot clear newer values');
  const find=pane.getByLabel('Find records to link');await find.fill('Pane Link Contact');const option=pane.locator('.contacts-link-search-results').getByRole('checkbox',{name:/Link Pane Link Contact/});await option.check();await option.press('Escape');
  await expect(pane.locator('.contacts-links').getByRole('checkbox',{name:/Link Pane Link Contact/})).toBeChecked();
  let saveEntered;const entered=new Promise(resolve=>saveEntered=resolve),gate=new Promise(resolve=>releaseSave=resolve);
  await page.route('**/api/contacts/accounts',async route=>{const response=await route.fetch();saveEntered();await gate;await route.fulfill({response});});
  await pane.getByRole('button',{name:'Save',exact:true}).click();await entered;assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasPendingOperation()),true);await expect(pane.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
  await host.locator('.contacts-results').getByRole('button',{name:'Second Account',exact:true}).click();await expect(pane.getByLabel('Company')).toHaveValue('Pane Account');await expect(pane.locator('[data-contacts-notice]')).toContainText('Finish the current Company action');
  await page.locator('.nav-button[data-view="home"]').click();await expect(page.locator('#view-contacts')).toBeVisible();
  releaseSave();await expect(pane).toBeHidden();await page.unroute('**/api/contacts/accounts');await expect(host.locator('.contacts-results')).toContainText('12 345 678 901');
  state=await directory();const saved=state.accounts.find(item=>item.id===first.id);assert.equal(saved.billing_address,'Concurrent review edit');assert.equal(state.contacts.find(item=>item.id===person.id).account_id,first.id);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.context()),unchanged);
  checks.push('A held Save blocks replacement/navigation and retains one editor; the same atomic save persists Account values and linked Contact without altering the Project');
  await owner.click();await expect(pane).toBeVisible();await expect(pane.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await expect(pane.getByLabel('ABN/ACN')).toHaveValue('12 345 678 901');
  await pane.getByLabel('Billing address').fill('Conflict draft');state=await directory();await api('/api/contacts/contacts',{version:state.version,fields:{name:'Competing Contact'}});
  await pane.getByRole('button',{name:'Save',exact:true}).click();await expect(pane.locator('[data-contacts-notice]')).toContainText(/changed|reload/i);await expect(pane.getByLabel('Billing address')).toHaveValue('Conflict draft');assert.equal((await directory()).accounts.find(item=>item.id===first.id).billing_address,'Concurrent review edit');
  await pane.getByRole('button',{name:'Cancel',exact:true}).click();await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(pane).toBeHidden();
  await expect(host.locator('.contacts-results').getByRole('button',{name:'Pane Account',exact:true})).toBeVisible();await page.waitForFunction(()=>document.querySelector('#contacts-root').getAttribute('aria-busy')!=='true');
  await owner.click();await expect(pane.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await pane.getByLabel('Company').press('Escape');await expect(pane).toBeHidden();await expect(owner).toBeFocused();
  await host.getByRole('button',{name:'New Company',exact:true}).click();const modal=page.getByRole('dialog',{name:'New Company',exact:true});await expect(modal).toBeVisible();await modal.getByRole('button',{name:'Cancel',exact:true}).click();await expect(modal).toBeHidden();
  checks.push('Directory conflicts retain the complete draft, explicit discard reloads current records, Escape restores focus, and New Account retains its modal workflow');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,geometry,errors},null,2));console.log('PASS Account editor pane: '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#contacts-root').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{releaseSave?.();await browser?.close();server.kill();});
