'use strict';
// UI contract for supplemental read-only associations. Real saved-file and
// companion ownership/integrity is covered by test_directory_related_documents.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','directory-related-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page;server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exit '+code));});server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const checks=[],errors=[];
(async()=>{
 const fixture=await ready;assert.notEqual(fixture.port,8765);const base='http://127.0.0.1:'+fixture.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.on('pageerror',error=>errors.push(error.message));
 const api=async(route,body)=>{const response=body===undefined?await page.request.get(base+route):await page.request.post(base+route,{data:body});assert.equal(response.status(),200,await response.text());return response.json();};
 let directory=await api('/api/contacts/directory');
 const created=await api('/api/contacts/leads',{version:directory.version,fields:{name:'Related Person',company:'Related Company',phone:'0400',email:'related@example.test',site_address:'Private fixture site'}});
 directory=await api('/api/contacts/directory');const lead=directory.leads.find(row=>row.id===created.id),person=directory.contacts.find(row=>row.id===lead.contact_id),company=directory.accounts.find(row=>row.id===person.account_id);
 const owner=randomUUID(),entry=(label)=>({id:owner+':'+randomUUID(),label,available:true,automatic:true});
 const commercial={quotes:[entry('Related Quote')],work_orders:[entry('Related Work Order')],purchase_orders:[entry('Related Purchase Order')]};
 let refreshes=0;
 await page.route('**/api/contacts/account-links*',async route=>{
  const response=await route.fetch(),catalog=await response.json();refreshes++;
  catalog.related={certifications:[entry('Related Certificate')],swms:[entry('Related SWMS')]};
  for(const [key,rows]of Object.entries(commercial)){catalog.linked[key]=rows;catalog.choices[key]=rows;}
  await route.fulfill({response,json:catalog});
 });
 await page.route('**/api/contacts/contact-links*',async route=>{
  const response=await route.fetch(),catalog=await response.json();for(const [key,rows]of Object.entries(commercial))catalog.linked[key]=rows;
  await route.fulfill({response,json:catalog});
 });
 await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
 await page.locator('#contacts-navigation-toggle').click();const host=page.locator('#contacts-root');await host.locator('.contacts-tabs').getByRole('button',{name:'Companies',exact:true}).click();
 await host.locator('.contacts-results').getByRole('button',{name:company.company,exact:true}).click();const pane=page.getByRole('complementary',{name:'Edit Company',exact:true});await expect(pane).toBeVisible();
 for(const [key,label]of Object.entries({quotes:'Quotes',work_orders:'Work Orders',purchase_orders:'Purchase Orders',certifications:'Certification',swms:'SWMS'}))await expect(pane.locator(`[data-link-group="${key}"] > summary`)).toHaveText(label+' (1)');
 await expect(pane.locator('[data-link-group="certifications"] input,[data-link-group="swms"] input')).toHaveCount(0);
 await expect(pane.locator('[data-link-group="quotes"] input')).toBeDisabled();
 const before=refreshes;await pane.getByRole('button',{name:'Refresh linked records',exact:true}).click();await expect.poll(()=>refreshes).toBeGreaterThan(before);await expect(pane.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
 for(const width of [1915,1213,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'company-related-'+width+'.png'),fullPage:true});}
 checks.push('Company panes display Quote/WO/PO, Certification and SWMS associations; supplemental documents remain read-only and survive refresh at desktop/tablet/mobile widths');
 await pane.getByRole('button',{name:'Cancel',exact:true}).click();await host.locator('.contacts-tabs').getByRole('button',{name:'Contacts',exact:true}).click();await host.locator('.contacts-results').getByRole('button',{name:person.name,exact:true}).click();const contact=page.getByRole('complementary',{name:'Edit Contact',exact:true});
 await expect(contact.locator('[data-link-group="leads"] > summary')).toHaveText('Leads (1)');
 for(const [key,label]of Object.entries({quotes:'Quotes',work_orders:'Work Orders',purchase_orders:'Purchase Orders'}))await expect(contact.locator(`[data-link-group="${key}"] > summary`)).toHaveText(label+' (1)');
 await contact.locator('[data-link-group="leads"]').getByRole('button',{name:lead.name,exact:true}).click();const editor=page.getByRole('dialog',{name:'Edit Lead',exact:true});await expect(editor).toBeVisible();await expect(editor.getByLabel('Name',{exact:true})).toHaveValue(person.name);await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 checks.push('Contact panes display exact linked Lead plus Quote/WO/PO; clicking Lead opens that directory record without creating or changing a document');
 assert.deepEqual(await api('/api/contacts/directory'),directory);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS directory related records: '+output);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close();server.kill();});
