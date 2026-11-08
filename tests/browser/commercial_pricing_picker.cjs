'use strict';
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`commercial-pricing-${Date.now()}`);
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
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:884}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/commercial/pricing')requests.push(url.searchParams.get('search'));});
  const base=`http://127.0.0.1:${info.port}`;
  for(const asset of ['commercial-pricing-picker.js','commercial-pricing-picker.css']){
    const response=await page.request.get(base+'/'+asset);assert.equal(response.status(),200,asset+' must be served by the application');
    assert.ok(response.headers()['content-type'].startsWith(asset.endsWith('.js')?'text/javascript':'text/css'),asset+' must have its expected MIME type');
  }
  const configuration={inventory:{'200':{supplier_price:10,markup:.1,product_service:'Duplicate pricing choice'},'201':{supplier_price:20,markup:.1,product_service:'Duplicate pricing choice'}},rates:{}};
  const saved=await page.request.put(base+'/api/configuration',{data:configuration});assert.equal(saved.status(),200,await saved.text());
  const savedPricing=await (await page.request.get(base+'/api/configuration')).json();
  await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  await page.waitForFunction(()=>typeof window.ClassifireCommercialPricing?.attach==='function');
  await createNewProject(page,{client:'Pricing picker QA','site-address':'Synthetic pricing test site'});
  await openProjectSection(page,'quote');const quote=page.locator('#commercial-quote-root');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.locator('.commercial-line-description').first()).not.toHaveAttribute('role','combobox');
  await quote.getByRole('button',{name:'Add custom row',exact:true}).click();
  let row=quote.locator('.commercial-lines tbody tr').last(),description=row.locator('.commercial-line-description'),unit=row.locator('td').nth(2).locator('input');
  const popup=page.locator('.commercial-pricing-popup:visible'),options=popup.getByRole('option');
  await description.fill('Promasil-1100 Super - 1250x600x60mm');
  await expect(popup.locator('[data-pricing-id="inventory:239"]')).toBeVisible();
  await description.press('ArrowDown');await description.press('Enter');
  await expect(unit).toHaveValue('213.122');
  assert.ok((await description.inputValue()).includes('Promasil-1100'));
  await row.locator('td').nth(1).locator('input').fill('2');await expect(row.locator('.commercial-line-total')).toHaveText('$426.24');
  checked('Real Pricing Library float213.12199999999999 fills Quote precision213.122 without extra markup and computes the existing2-decimal line total');
  await unit.fill('7.5');await description.fill('Manual product or service');await description.blur();
  await expect(unit).toHaveValue('7.5');await expect(row.locator('.commercial-line-total')).toHaveText('$15.00');
  checked('Manual description and Unit price remain editable; typing or leaving a match never commits a price');
  async function nativeManualArrows(label,expectedPrice){
    const before=await description.inputValue();
    await description.evaluate(input=>input.setSelectionRange(3,3));
    await description.press('ArrowDown');
    const down=await description.evaluate(input=>input.selectionStart);
    assert.ok(down>3,label+': ArrowDown advances the native multiline caret');
    await description.press('ArrowUp');
    assert.ok((await description.evaluate(input=>input.selectionStart))<down,label+': ArrowUp returns toward the preceding line');
    await expect(description).toHaveValue(before);await expect(unit).toHaveValue(expectedPrice);
  }
  const manualLines='Unlisted manual first line\nUnlisted manual second line\nUnlisted manual third line';
  await description.fill(manualLines);await expect(popup).toContainText('No matching products or services.');
  await nativeManualArrows('No matching Pricing records','7.5');
  await description.press('Escape');await expect(popup).toHaveCount(0);
  await nativeManualArrows('After Escape','7.5');await expect(popup).toHaveCount(0);
  await description.fill('Manual first line\n'+'x'.repeat(520)+'\nManual third line');
  await expect(popup).toContainText('Type up to 500 characters');await nativeManualArrows('Long manual description','7.5');
  checked('Native multiline caret arrows work with no matching choices, after Escape and for long manual descriptions, preserving description and price');
  await description.fill('Duplicate pricing choice');await expect(options).toHaveCount(2);
  await popup.locator('[data-pricing-id="inventory:201"]').click();await expect(unit).toHaveValue('22');
  checked('Duplicate names retain canonical IDs and distinct effective selling prices');
  const changedPricing=JSON.parse(JSON.stringify(savedPricing));changedPricing.inventory['201'].supplier_price=30;
  assert.equal((await page.request.put(base+'/api/configuration',{data:changedPricing})).status(),200);
  await expect(unit).toHaveValue('22');
  await description.blur();await description.focus();
  await expect(popup.locator('[data-pricing-id="inventory:201"]')).toContainText('$33.00');await expect(unit).toHaveValue('22');
  await popup.locator('[data-pricing-id="inventory:201"]').click();await expect(unit).toHaveValue('33');
  assert.equal((await page.request.put(base+'/api/configuration',{data:savedPricing})).status(),200);
  await description.blur();await description.focus();await expect(popup.locator('[data-pricing-id="inventory:201"]')).toContainText('$22.00');
  await popup.locator('[data-pricing-id="inventory:201"]').click();await expect(unit).toHaveValue('22');
  checked('A new focus reads updated saved Pricing; existing Quote prices change only after explicit selection');
  let releaseOld,notifyOld,notifyFinished;const oldHeld=new Promise(resolve=>notifyOld=resolve),oldReleased=new Promise(resolve=>releaseOld=resolve),oldFinished=new Promise(resolve=>notifyFinished=resolve);
  await page.route('**/api/commercial/pricing?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('search')!=='Held old query')return route.continue();
    notifyOld();await oldReleased;
    await route.fulfill({json:{items:[{id:'stale',name:'STALE CHOICE',description:'STALE CHOICE',unit_price:999}]}}).catch(()=>{});notifyFinished();
  });
  await description.fill('Held old query');await bounded(oldHeld,'Old pricing query');
  await description.fill('Duplicate pricing choice');await expect(options).toHaveCount(2);
  releaseOld();await oldFinished;await expect(options).toHaveCount(2);await expect(popup).not.toContainText('STALE CHOICE');await expect(unit).toHaveValue('22');
  await page.unroute('**/api/commercial/pricing?*');
  checked('A cancelled earlier search cannot overwrite newer matches or their independent manually editable price');
  await page.route('**/api/commercial/pricing?*',route=>route.fulfill({status:500,json:{error:'Synthetic failure'}}));
  await description.fill(manualLines);await expect(popup).toContainText('Pricing Library could not be loaded.');await expect(unit).toHaveValue('22');
  await nativeManualArrows('Failed Pricing lookup','22');
  await description.press('Escape');await expect(popup).toHaveCount(0);await page.unroute('**/api/commercial/pricing?*');
  checked('Failed lookup reports a recoverable notice while retaining text and Unit price');
  requests.length=0;
  await description.evaluate(input=>{for(const value of ['Fast A','Fast AB','Fast ABC','Duplicate pricing choice']){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}});
  await expect(options).toHaveCount(2);assert.deepEqual(requests,['Duplicate pricing choice']);
  await description.press('Escape');
  checked('Rapid typing is debounced into one bounded read-only search');
  // Exercise the actual table's last row after it requires both vertical and,
  // on mobile, horizontal scrolling. The portal must escape its overflow box.
  for(let index=0;index<11;index++)await quote.getByRole('button',{name:'Add custom row',exact:true}).click();
  row=quote.locator('.commercial-lines tbody tr').last();description=row.locator('.commercial-line-description');unit=row.locator('td').nth(2).locator('input');
  const geometry=[];
  for(const width of [1915,1101,390]){
    await page.setViewportSize({width,height:884});await description.scrollIntoViewIfNeeded();
    await description.evaluate(input=>window.scrollBy(0,input.getBoundingClientRect().bottom-(innerHeight-36)));
    await description.fill('Duplicate pricing choice');await expect(options).toHaveCount(2);
    const dimensions=await popup.evaluate(element=>{
      const box=element.getBoundingClientRect(),header=document.querySelector('.app-header'),head=header.getBoundingClientRect();
      const option=element.querySelector('[role=option]'),optionBox=option.getBoundingClientRect(),hit=document.elementFromPoint(optionBox.x+10,Math.max(optionBox.y+5,box.y+10));
      return {box:{x:box.x,y:box.y,right:box.right,bottom:box.bottom},headerBottom:head.bottom,headerZ:Number(getComputedStyle(header).zIndex),popupZ:Number(getComputedStyle(element).zIndex),portal:element.parentElement===document.body,clickable:option.contains(hit),viewport:document.documentElement.clientWidth};
    });
    assert.ok(dimensions.portal&&dimensions.clickable,JSON.stringify(dimensions));
    assert.ok(dimensions.popupZ<dimensions.headerZ&&dimensions.box.y>=dimensions.headerBottom,JSON.stringify(dimensions));
    assert.ok(dimensions.box.x>=0&&dimensions.box.right<=dimensions.viewport&&dimensions.box.bottom<=884,JSON.stringify(dimensions));
    geometry.push({width,...dimensions});await page.screenshot({path:path.join(output,`pricing-picker-${width}.png`)});
    await popup.locator('[data-pricing-id="inventory:201"]').click();await expect(unit).toHaveValue('22');
  }
  checked('Body portal remains visible and clickable outside the Quote table, within the viewport and below the sticky header at1915/1101/390px');
  let releaseDetached,notifyDetached,notifyDetachedDone;const detachedHeld=new Promise(resolve=>notifyDetached=resolve),detachedReleased=new Promise(resolve=>releaseDetached=resolve),detachedDone=new Promise(resolve=>notifyDetachedDone=resolve);
  await page.route('**/api/commercial/pricing?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('search')!=='Detached query')return route.continue();
    notifyDetached();await detachedReleased;await route.fulfill({json:{items:[{id:'detached',name:'DETACHED CHOICE',description:'DETACHED CHOICE',unit_price:888}]}}).catch(()=>{});notifyDetachedDone();
  });
  await description.fill('Detached query');await bounded(detachedHeld,'Detached pricing query');
  await row.getByRole('button',{name:'Remove row',exact:true}).click();releaseDetached();await detachedDone;
  await expect(page.locator('.commercial-pricing-popup:visible')).toHaveCount(0);
  await expect(quote).not.toContainText('DETACHED CHOICE');await page.unroute('**/api/commercial/pricing?*');
  checked('Deleting a custom row disposes its lookup and ignores pending results');
  assert.deepEqual(await (await page.request.get(base+'/api/configuration')).json(),savedPricing,'Lookup never changes saved Pricing Library data');
  await quote.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,geometry,errors},null,2));console.log(JSON.stringify({passed:true,output,checks,geometry}));
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);if(page){fs.writeFileSync(path.join(output,'failure-state.json'),JSON.stringify({errors,requests,dom:await page.evaluate(()=>({active:document.activeElement?.outerHTML,popups:[...document.querySelectorAll('.commercial-pricing-popup')].map(element=>element.outerHTML)})).catch(()=>null)},null,2));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
