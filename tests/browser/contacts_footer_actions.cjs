const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','contacts-footer-actions-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let browser,page,log='',release;
server.stderr.on('data',chunk=>log+=chunk);
const ready=new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error(log||'Fixture startup timed out')),120000);server.once('error',reject);server.once('exit',()=>{clearTimeout(timer);reject(Error(log));});server.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]));}});});
async function run(){
  const info=await ready;assert.notEqual(info.port,8765);const base='http://127.0.0.1:'+info.port;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
  const errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
  const api=async(route,body)=>{const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});assert.equal(response.status(),200,await response.text());return response.json();};
  let directory=await api('/api/contacts/directory');
  await api('/api/contacts/leads',{version:directory.version,fields:{name:'Footer Person',company:'Footer Company',phone:'0400000001',email:'footer@example.test',site_address:'Synthetic Footer Street'}});
  directory=await api('/api/contacts/directory');
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  await page.locator('#contacts-navigation-toggle').click();
  const host=page.locator('#contacts-root');
  const models=[{kind:'leads',tab:'Leads',title:'Lead',record:directory.leads[0],label:'Footer Person',field:'Description',key:'description'},
    {kind:'contacts',tab:'Contacts',title:'Contact',record:directory.contacts[0],label:'Footer Person',field:'Title',key:'title'},
    {kind:'accounts',tab:'Companies',title:'Company',record:directory.accounts[0],label:'Footer Company',field:'Billing address',key:'billing_address'}];
  for(const model of models){
    const open=async()=>{await host.locator('.contacts-tabs').getByRole('button',{name:model.tab,exact:true}).click();await host.locator('.contacts-results').getByRole('button',{name:model.label,exact:true}).click();const pane=page.getByRole('complementary',{name:'Edit '+model.title,exact:true});await expect(pane).toBeVisible();await expect(pane.locator('.contacts-record-actions-top').getByRole('button',{name:'Save',exact:true})).toBeEnabled();return pane;};
    let pane=await open();
    let top=pane.locator('.contacts-record-actions-top'),bottom=pane.locator('.contacts-record-actions-bottom');
    const buttons=locator=>locator.getByRole('button').evaluateAll(nodes=>nodes.map(node=>({name:node.getAttribute('aria-label')||node.textContent,title:node.title,type:node.type,classes:node.className})));
    assert.deepEqual(await buttons(bottom),await buttons(top));
    await expect(top.getByRole('button')).toHaveCount(3);await expect(bottom.getByRole('button')).toHaveCount(3);
    await expect(pane.getByRole('button',{name:'Cancel',exact:true})).toHaveCount(1);
    assert.equal(await bottom.evaluate(node=>node.previousElementSibling.classList.contains('contacts-record-details')),true);
    assert.equal(await pane.evaluate(node=>{const ids=[...node.querySelectorAll('[id]')].map(node=>node.id);return new Set(ids).size===ids.length;}),true);
    // Both action rows share one refresh lifetime and return to enabled together.
    let entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    const directoryRoute='**/api/contacts/directory'+(model.kind==='leads'?'?board=1':'');
    await page.route(directoryRoute,async route=>{entered();await gate;await route.continue();},{times:1});
    await bottom.getByRole('button',{name:'Refresh Records',exact:true}).click();await started;
    for(const row of [top,bottom])for(const control of await row.getByRole('button').all())await expect(control).toBeDisabled();
    assert.equal(await page.evaluate(()=>window.ClassifireContacts.hasPendingOperation()),true);
    release();release=null;
    await expect(bottom.getByRole('button',{name:'Refresh Records',exact:true})).toBeEnabled();await page.unroute(directoryRoute);
    for(const control of await top.getByRole('button').all())await expect(control).toBeEnabled();
    // The footer Back uses the same guarded discard path as the header Back.
    await pane.getByLabel(model.field,{exact:true}).fill('Unsaved '+model.title);
    await bottom.getByRole('button',{name:'Back to '+model.tab,exact:true}).click();
    const discard=page.locator('#discard-dialog');await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(pane.getByLabel(model.field,{exact:true})).toHaveValue('Unsaved '+model.title);
    // One footer submit uses the normal validated write, disables both rows,
    // and cannot be duplicated from the header while the response is pending.
    let saveEntered;const saveStarted=new Promise(resolve=>saveEntered=resolve),saveGate=new Promise(resolve=>release=resolve);let writes=0;
    const saveRoute='**/api/contacts/'+model.kind;
    await page.route(saveRoute,async route=>{writes++;const response=await route.fetch();saveEntered();await saveGate;await route.fulfill({response});});
    await bottom.getByRole('button',{name:'Save',exact:true}).click();await saveStarted;
    for(const row of [top,bottom])for(const control of await row.getByRole('button').all())await expect(control).toBeDisabled();
    await expect(pane.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
    await top.getByRole('button',{name:'Save',exact:true}).evaluate(node=>node.click());assert.equal(writes,1);
    release();release=null;await expect(pane).toHaveCount(0);await page.unroute(saveRoute);
    assert.equal((await api('/api/contacts/directory'))[model.kind].find(row=>row.id===model.record.id)[model.key],'Unsaved '+model.title);
    pane=await open();top=pane.locator('.contacts-record-actions-top');bottom=pane.locator('.contacts-record-actions-bottom');
    // A rejected refresh restores both action rows without closing the draft.
    await page.route(directoryRoute,route=>route.fulfill({status:500,json:{error:'Synthetic refresh failure'}}),{times:1});
    await bottom.getByRole('button',{name:'Refresh Records',exact:true}).click();
    await expect(pane.locator('[data-contacts-notice]')).toContainText('Synthetic refresh failure');
    await expect(top.getByRole('button',{name:'Refresh Records',exact:true})).toBeEnabled();await expect(bottom.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await page.unroute(directoryRoute);
    for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await bottom.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,model.kind+'-'+width+'.png')});}
    await page.setViewportSize({width:1440,height:1000});await bottom.getByRole('button',{name:'Back to '+model.tab,exact:true}).click();await expect(pane).toHaveCount(0);
    checks.push(model.title+': matching action rows, guarded Back, single save, shared busy state, refresh recovery, Cancel preserved, desktop/mobile layout');
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS CRM footer actions: '+output);
}
run().catch(async error=>{console.error(error,log);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{release?.();await browser?.close();server.kill();});
