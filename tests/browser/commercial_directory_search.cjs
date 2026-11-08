'use strict';
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`commercial-directory-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{
  let data='';const timeout=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error(`Fixture exited ${code}`));});
});
const errors=[],checks=[],requests=[];
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label+' timed out')),30000))]);}finally{clearTimeout(timer);}}
function checked(text){checks.push(text);fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify({checks,requests},null,2));}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  const directory=async()=>{const response=await page.request.get(base+'/api/contacts/directory');assert.equal(response.status(),200);return response.json();};
  async function create(kind,fields,extra={}){const response=await page.request.post(base+'/api/contacts/'+kind,{data:{version:(await directory()).version,fields,...extra}});assert.equal(response.status(),200,await response.text());return response.json();}
  await create('accounts',{company:'Primary Project',billing_address:'Project HQ',abn_acn:'ABN-PRIMARY'});
  const beta=(await create('accounts',{company:'Beta Company',billing_address:'Beta HQ',abn_acn:'ABN-BETA'})).account;
  const person=(await create('contacts',{name:'Beta Contact',company:beta.company,phone:'222',email:'beta@example.test',title:'Beta Manager'})).contact;
  await create('contacts',{name:'Unrelated Contact',company:'Primary Project',phone:'111',email:'primary@example.test'});
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  await createNewProject(page,{client:'Primary Project','site-address':'Canonical Project Site'});
  const projectBefore=await page.evaluate(()=>window.CeasefireProject.details());
  await openProjectSection(page,'quote');let quote=page.locator('#commercial-quote-root');await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  const left=quote.locator('.commercial-sidebar').first();
  const company=left.getByRole('combobox',{name:'Company',exact:true}),name=left.getByRole('combobox',{name:'Name',exact:true});
  await company.fill('Beta');await left.getByRole('option',{name:'Beta Company',exact:true}).click();await expect(company).toHaveValue('Beta Company');
  await expect(left).toContainText('Beta HQ');await expect(left).toContainText('ABN-BETA');await expect(left).not.toContainText('Project HQ');
  await name.fill('');await name.focus();await expect(left.getByRole('option')).toHaveText(['Beta Contact']);
  await left.getByRole('option',{name:'Beta Contact',exact:true}).click();await expect(name).toHaveValue('Beta Contact');
  await expect(left).toContainText('Beta Manager');await expect(left).toContainText('beta@example.test');await expect(left).toContainText('222');
  await left.getByLabel('Site address',{exact:true}).fill('Document-only Site');
  await quote.getByLabel('Document title',{exact:true}).fill('Override Quote');
  async function save(root){const reply=page.waitForResponse(r=>/\/api\/commercial\/(?:saved-)?save$/.test(new URL(r.url()).pathname));await root.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();const response=await reply;assert.equal(response.status(),200,await response.text());await expect(root.locator('.commercial-message')).toContainText('Document saved.');await page.waitForFunction(()=>!window.CeasefireDesktop.status().busy);return response.json();}
  await save(quote);
  await left.getByLabel('Site address',{exact:true}).fill('Document-only Site second save');await save(quote);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireProject.details()),projectBefore);
  let file=JSON.parse(fs.readFileSync(info.project,'utf8'));
  assert.equal(file.estimate.client,'Primary Project');assert.equal(file.estimate.site_address,'Canonical Project Site');
  let saved=file.commercial_documents.documents.find(item=>item.fields.title==='Override Quote');assert.ok(saved);
  assert.equal(saved.fields.details.client,'Beta Company');assert.equal(saved.fields.details.contact,'Beta Contact');assert.equal(saved.fields.details.site_address,'Document-only Site second save');assert.deepEqual(saved.fields.detail_overrides,['client','contact','phone','email','site_address']);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();await expect(quote.locator('.commercial-card')).toContainText('Beta Company');await quote.getByRole('button',{name:'Override Quote',exact:true}).click();
  await expect(quote.locator('.commercial-sidebar').first().getByRole('combobox',{name:'Company',exact:true})).toHaveValue('Beta Company');await expect(quote.locator('.commercial-sidebar').first().getByLabel('Site address',{exact:true})).toHaveValue('Document-only Site second save');
  checked('Company/contact searches fill the chosen directory data; document-only identity/site overrides survive repeated Save and actual saved-file reopen without modifying the Project');
  await create('contacts',{name:'Beta Contact',company:beta.company,phone:'999',email:'beta-later@example.test',title:'Updated Manager'},{id:person.id});
  const reopenedLeft=quote.locator('.commercial-sidebar').first();await reopenedLeft.getByRole('combobox',{name:'Name',exact:true}).fill('Beta');await reopenedLeft.getByRole('option',{name:'Beta Contact',exact:true}).click();await expect(reopenedLeft).toContainText('999');await expect(reopenedLeft).toContainText('Updated Manager');
  await reopenedLeft.getByRole('combobox',{name:'Company',exact:true}).fill('Primary');await reopenedLeft.getByRole('option',{name:'Primary Project',exact:true}).click();await expect(reopenedLeft.getByRole('combobox',{name:'Name',exact:true})).toHaveValue('');await expect(quote.locator('[data-project-detail=phone]')).toHaveValue('');await expect(quote.locator('[data-project-detail=email]')).toHaveValue('');
  await save(quote);checked('A later Contacts edit is fetched on focus; switching Companies clears incompatible document contact details');
  // Inline creation is the real Contacts dialog, returns its saved canonical record.
  await reopenedLeft.getByRole('button',{name:'New Company',exact:true}).click();let dialog=page.getByRole('dialog',{name:'New Company',exact:true});await dialog.getByLabel('Company',{exact:true}).fill('Inline Supplier');await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).toBeHidden();await expect(reopenedLeft.getByRole('combobox',{name:'Company',exact:true})).toHaveValue('Inline Supplier');
  await reopenedLeft.getByRole('button',{name:'New Contact',exact:true}).click();dialog=page.getByRole('dialog',{name:'New Contact',exact:true});await expect(dialog.getByLabel('Company',{exact:true})).toHaveValue('Inline Supplier');await dialog.getByLabel('Name',{exact:true}).fill('Inline Person');await dialog.getByLabel('Phone',{exact:true}).fill('444');await dialog.getByLabel('Email',{exact:true}).fill('inline@example.test');await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).toBeHidden();await expect(reopenedLeft.getByRole('combobox',{name:'Name',exact:true})).toHaveValue('Inline Person');await expect(reopenedLeft).toContainText('444');
  await save(quote);checked('The sidebar + shortcuts create actual Company/Contact records and copy them into only this document');
  await reopenedLeft.getByRole('combobox',{name:'Company',exact:true}).fill('Beta');await expect(reopenedLeft.getByRole('option',{name:'Beta Company',exact:true})).toBeVisible();
  await quote.screenshot({path:path.join(output,'quote-directory-desktop.png')});await reopenedLeft.getByRole('combobox',{name:'Company',exact:true}).press('Escape');await save(quote);
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();await openProjectSection(page,'purchase-orders');const purchase=page.locator('#commercial-purchase-order-root');await purchase.getByRole('button',{name:'New Purchase Order',exact:true}).click();
  const information=purchase.locator('.commercial-purchase-information');await expect(information.getByRole('combobox',{name:'Supplier',exact:true})).toBeVisible();
  await information.getByRole('combobox',{name:'Supplier',exact:true}).fill('Beta');await information.getByRole('option',{name:'Beta Company',exact:true}).click();
  await information.getByRole('combobox',{name:'Supplier contact',exact:true}).fill('');await information.getByRole('combobox',{name:'Supplier contact',exact:true}).focus();await expect(information.locator('.commercial-directory-options:visible').getByRole('option')).toHaveText(['Beta Contact']);await information.getByRole('option',{name:'Beta Contact',exact:true}).click();await expect(information.getByLabel('Supplier email',{exact:true})).toHaveValue('beta-later@example.test');
  await expect(information.getByLabel('Delivery or pickup',{exact:true}).locator('option')).toHaveText(['','Delivery','Pickup']);await information.getByLabel('Delivery or pickup',{exact:true}).selectOption('Pickup');
  for(const textarea of await information.locator('textarea').all()){assert.equal(await textarea.getAttribute('rows'),'1');assert.ok((await textarea.boundingBox()).height<=44);}
  await purchase.getByRole('button',{name:'Add line item',exact:true}).click();const row=purchase.locator('.commercial-lines tbody tr').first(),description=row.locator('.commercial-line-description'),unit=row.locator('td').nth(2).locator('input');
  await expect(description).toHaveAttribute('role','combobox');await expect(description).not.toHaveAttribute('list');await description.focus();await expect(page.locator('.commercial-pricing-popup:visible')).toHaveCount(0);assert.equal(await row.locator('.project-account-add').count(),0);
  const catalog=await(await page.request.get(base+'/api/commercial/supplier-products?workspace='+await page.evaluate(()=>window.CeasefireCertification.sessionId()))).json();const product=catalog.products.find(item=>item.supplier_price>0&&catalog.products.filter(row=>row.label===item.label).length===1);assert.ok(product);
  await description.fill(product.label);await page.locator('.commercial-pricing-popup:visible').getByRole('option').first().click();await expect(unit).toHaveValue(String(Number(Number(product.supplier_price).toFixed(6))));
  await unit.fill('7.5');await description.fill('Unlisted manual purchase');await description.blur();await expect(unit).toHaveValue('7.5');
  await save(purchase);file=JSON.parse(fs.readFileSync(info.project,'utf8'));saved=file.commercial_documents.documents.find(item=>item.kind==='purchase_order');assert.equal(saved.fields.order.supplier,'Beta Company');assert.equal(saved.fields.order.supplier_contact,'Beta Contact');assert.equal(saved.fields.order.delivery_method,'Pickup');assert.equal(saved.fields.lines[0].description,'Unlisted manual purchase');assert.equal(saved.fields.lines[0].unit_price,'7.5');
  checked('Purchase Order supplier/contact searches and delivery dropdown persist; all information boxes start one row; product search only selects on explicit choice and manual no-match descriptions/prices remain editable');
  // Use real Settings navigation: labels translate, document data and canonical enum values do not.
  const beforeLocales=JSON.parse(await page.evaluate(()=>window.CeasefireCommercial.projectFingerprint())).editor;
  const savedFileBeforeLocales=fs.readFileSync(info.project,'utf8'),localeEvidence=[];
  for(const [locale,delivery,pickup] of [['zh-Hans','送货','自提'],['ar','توصيل','استلام'],['en','Delivery','Pickup']]){
    await purchase.locator('.commercial-editor-actions button').first().click();
    await page.locator('nav [data-view="settings"]').click();
    await page.locator('#application-language-toggle').click();
    await page.locator(`#application-language-menu [data-language-code="${locale}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang',locale==='en'?'en-AU':locale);
    await openProjectSection(page,'purchase-orders');
    await purchase.locator('.commercial-card .project-title-button').first().click();
    const method=purchase.locator('[data-order-field="delivery_method"]');
    await expect(method).toHaveValue('Pickup');
    assert.deepEqual(await method.locator('option').evaluateAll(options=>options.map(option=>({value:option.value,text:option.textContent}))),[
      {value:'',text:''},{value:'Delivery',text:delivery},{value:'Pickup',text:pickup}
    ]);
    const supplier=purchase.locator('[data-order-field="supplier"]'),contact=purchase.locator('[data-order-field="supplier_contact"]');
    await expect(supplier).toHaveValue('Beta Company');await expect(contact).toHaveValue('Beta Contact');
    await supplier.focus();await expect(information.locator('.commercial-directory-options:visible').getByRole('option')).toHaveText(['Beta Company']);await supplier.blur();
    await contact.focus();await expect(information.locator('.commercial-directory-options:visible').getByRole('option')).toHaveText(['Beta Contact']);await contact.blur();
    const after=JSON.parse(await page.evaluate(()=>window.CeasefireCommercial.projectFingerprint())).editor;
    assert.equal(after.id,beforeLocales.id);assert.equal(after.version,beforeLocales.version);
    assert.deepEqual(after.fields,beforeLocales.fields,'Language switching preserves every saved Purchase Order field');
    assert.equal(fs.readFileSync(info.project,'utf8'),savedFileBeforeLocales,'Language controls cannot rewrite the saved Project');
    localeEvidence.push({locale,delivery,pickup,value:await method.inputValue(),supplier:await supplier.inputValue(),contact:await contact.inputValue()});
  }
  fs.writeFileSync(path.join(output,'delivery-locales.json'),JSON.stringify({passed:true,languages:localeEvidence,canonicalFieldsUnchanged:true,savedFileUnchanged:true},null,2));
  checked('Delivery/Pickup labels translate in Chinese and Arabic through the real language menu, while canonical option values, selected Pickup, raw Company/Contact results and all saved fields remain unchanged');
  for(const width of [1101,520]){await page.setViewportSize({width,height:1000});const field=information.getByRole('combobox',{name:'Supplier',exact:true});await field.fill('Beta');const option=information.getByRole('option',{name:'Beta Company',exact:true});await expect(option).toBeVisible();const box=await option.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,JSON.stringify(box));await page.screenshot({path:path.join(output,'purchase-search-'+width+'.png'),fullPage:true});await option.click();}
  checked('Directory result lists remain in the available container at desktop/tablet/mobile widths');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,checks}));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
