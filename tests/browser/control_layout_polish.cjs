const {chromium,expect:baseExpect}=require('@playwright/test');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,clickProjectControl}=require('./project_actions.cjs');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa',`control-layout-polish-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const python=process.env.CEASEFIRE_PYTHON||'python';
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,releaseHeld;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});});
const widths=[1213,1915,390],errors=[],checks=[],evidence={estimate:[],picker:[],documentation:[]},derive=[];
const secondaryName='Secondary estimate '+ 'LongName'.repeat(12);
async function idle(){await page.waitForFunction(()=>{const value=window.CeasefireDesktop?.status();return value?.ready&&!value.busy;});}
const money=value=>Number(value.replace(/[^\d.-]/g,''));
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  execFileSync(python,['-c',`import json,sys
from pathlib import Path
from estimator.storage import Store
from estimator.project_file import export_project
target=Path(sys.argv[1]);store=Store(target.parent/'layout-seed.sqlite3')
def workspace(mark):
 data=json.loads(export_project(store,{'estimate':{'title':'Layout fixture','project_no':'PN-901','client':'Layout receiver','site_address':'13 Layout Road'},'calculators':{'steel_board':{'inputs':{'CALCULATOR':{'A9':mark}}}}}))
 return {'estimate':data['estimate'],'calculators':{key:{'inputs':value['inputs'],'schedule_rows':value['schedule_rows']} for key,value in data['calculators'].items()}}
first=workspace('LAYOUT-FIRST');second=workspace('LAYOUT-SECOND')
target.write_bytes(export_project(store,{**first,'estimates':[{'id':'estimate-1','name':'First estimate','workspace':first},{'id':'estimate-22222222222222222222222222222222','name':sys.argv[2],'workspace':second}],'active_estimate_id':'estimate-1'}))`,info.project,secondaryName],{cwd:root,windowsHide:true});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().endsWith('/api/commercial/derive'))derive.push(request.postDataJSON());});
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();await clickProjectControl(page,'Load');
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  // Measure the actual SWMS Add person control as the larger reference size.
  await openProjectSection(page,'swms');const swms=page.locator('#swms-root');await swms.getByRole('button',{name:'New SWMS',exact:true}).click();
  const people=swms.locator('details.swms-section:has(button[aria-label="Add person"])').first();
  if(!await people.evaluate(item=>item.open))await people.locator(':scope>summary').click();
  evidence.swmsAdd=await people.getByRole('button',{name:'Add person',exact:true}).boundingBox();
  await swms.getByRole('button',{name:'Back to Documents',exact:true}).last().click();await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  for(const width of widths){
    await page.setViewportSize({width,height:1000});
    const metrics=await page.locator('.project-estimate-controls').evaluate(host=>{
      const box=element=>{const b=element.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
      return{estimate:box(host.querySelector('.project-estimate-picker')),
        document:box(host.querySelector('.calculator-document-toggle')),otherDocumentHeight:getComputedStyle(document.querySelector('[aria-controls="firestopping-item-document-actions"]')).height,
        overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.ok(metrics.document.height>0&&(width<570?metrics.document.y>=metrics.estimate.y+metrics.estimate.height:Math.abs(metrics.document.y+metrics.document.height-metrics.estimate.y-metrics.estimate.height)<1),JSON.stringify(metrics));
    assert.equal(metrics.otherDocumentHeight,'48px');assert.ok(metrics.overflow<=1);
    evidence.estimate.push({width,...metrics});
  }
  await page.setViewportSize({width:1915,height:1000});await page.locator('[aria-controls="firestopping-document-actions"]').click();await page.locator('#estimate-open-quote').click();
  const quote=page.locator('#commercial-quote-root');await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  const add=quote.getByRole('button',{name:'Add custom row',exact:true}),picker=quote.locator('.commercial-estimate-picker'),summary=picker.locator(':scope>summary');
  for(const width of widths){
    await page.setViewportSize({width,height:1000});await add.scrollIntoViewIfNeeded();
    assert.equal(await picker.evaluate(item=>item.open),false);await expect(add).toBeVisible();
    const metrics=await quote.locator('.commercial-estimate-controls').evaluate(host=>{
      const rect=element=>{const b=element.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right};};
      const add=host.querySelector('.commercial-add-custom-row'),summary=host.querySelector('summary');
      return{host:rect(host),add:rect(add),summary:rect(summary),nestedInteractive:summary.querySelectorAll('button,input,select,a,[contenteditable]').length,
        overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.equal(metrics.add.width,36);assert.equal(metrics.add.height,36);assert.ok(metrics.add.height<evidence.swmsAdd.height);
    assert.ok(metrics.add.right<=metrics.summary.x);assert.ok(Math.abs(metrics.add.y+18-metrics.summary.y-metrics.summary.height/2)<1);
    assert.ok(Math.abs(metrics.summary.width-Math.min(261,metrics.host.width-46))<1,JSON.stringify(metrics));assert.equal(metrics.nestedInteractive,0);assert.ok(metrics.overflow<=1);
    await add.focus();await page.keyboard.press('Tab');await expect(summary).toBeFocused();await page.keyboard.press('Enter');await expect(picker).toHaveAttribute('open','');
    await expect(quote.getByRole('checkbox',{name:secondaryName,exact:true})).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`quote-picker-open-${width}.png`),fullPage:true});
    await summary.focus();await page.keyboard.press('Space');await expect(picker).not.toHaveAttribute('open','');
    evidence.picker.push({width,...metrics});
  }
  checks.push('36px Add custom row remains left of a 261px responsive native summary; Tab/Enter/Space retain keyboard details behavior at 1213/1915/390');
  await page.setViewportSize({width:1915,height:1000});const rows=quote.locator('.commercial-lines tbody tr');
  await rows.first().locator('textarea').fill('Manual linked-estimate description');await rows.first().locator('input[type="number"]').first().fill('2');
  const generatedUnit=Number(await rows.first().locator('input[type="number"]').last().inputValue());
  await add.click();assert.equal(await picker.evaluate(item=>item.open),false);await expect(rows).toHaveCount(2);
  await rows.last().locator('textarea').fill('Custom layout row');await rows.last().locator('input[type="number"]').first().fill('2');await rows.last().locator('input[type="number"]').last().fill('50');
  await expect(quote.locator('.commercial-totals p').last().locator('span')).toHaveText(new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format((generatedUnit*2+100)*1.1));
  let heldResolve;const held=new Promise(resolve=>heldResolve=resolve),gate=new Promise(resolve=>releaseHeld=resolve);let once=true;
  await page.route('**/api/commercial/derive',async route=>{if(!once)return route.continue();once=false;const response=await route.fetch();heldResolve();await gate;await route.fulfill({response});});
  await summary.click();await quote.getByRole('checkbox',{name:secondaryName,exact:true}).check();
  let timer;try{await Promise.race([held,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Selection did not request its missing estimate')),30000))]);}finally{clearTimeout(timer);}
  await expect(add).toBeDisabled();releaseHeld();await expect(rows).toHaveCount(3);await expect(add).toBeEnabled();await page.unroute('**/api/commercial/derive');
  await expect(rows.first().locator('textarea')).toHaveValue('Manual linked-estimate description');await expect(rows.first().locator('input[type="number"]').first()).toHaveValue('2');
  await expect(rows.last().locator('textarea')).toHaveValue('Custom layout row');await expect(rows.last().locator('input[type="number"]').last()).toHaveValue('50');
  assert.ok(derive.every(body=>body.include_scope_tables===false));await expect(quote.locator('.commercial-scope tbody tr')).toHaveCount(0);
  await quote.locator('.commercial-scope details summary').first().click();await expect(quote.locator('.commercial-scope tbody tr')).toHaveCount(1);
  assert.equal(derive.at(-1).include_scope_tables,undefined);const before=derive.length;
  await quote.getByRole('checkbox',{name:secondaryName,exact:true}).uncheck();await expect(rows).toHaveCount(2);await expect(add).toBeEnabled();assert.equal(derive.length,before);
  assert.equal(money(await quote.locator('.commercial-totals p').last().locator('span').innerText()),Number(((generatedUnit*2+100)*1.1).toFixed(2)));
  checks.push('closed-picker Add custom row updates totals; held selection preserves manual quantities/descriptions/custom amounts and full schedules remain lazy and cached');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  await openProjectSection(page,'documentation');await idle();
  await page.locator('#documentation-pdf-rows').getByRole('button',{name:'Other documents',exact:true}).click();
  for(const width of widths){
    await page.setViewportSize({width,height:1000});await page.locator('button[data-revisions-kind="estimate.summary.pdf"]').click();
    const metrics=await page.evaluate(()=>{
      const rect=selector=>{const element=document.querySelector(selector),r=element.getBoundingClientRect();return{width:r.width,height:r.height,fontSize:getComputedStyle(element).fontSize};};
      return{download:rect('.documentation-pdf-table thead th:nth-child(3)'),actions:rect('.documentation-pdf-table thead th:nth-child(5)'),
        xlsxDownload:rect('.documentation-tables>.documentation-section:last-child thead th:nth-child(3)'),close:rect('#documentation-revisions-close'),overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.ok(metrics.download.width>=44,JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.download.width-metrics.xlsxDownload.width)<1,JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.actions.width-metrics.download.width)<1,JSON.stringify(metrics));
    assert.equal(metrics.close.fontSize,'22px');assert.equal(metrics.close.width,40);assert.equal(metrics.close.height,40);assert.ok(metrics.overflow<=1);
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,`documentation-${width}.png`),fullPage:true});
    await page.locator('#documentation-revisions-close').click();await expect(page.locator('#documentation-revisions-pane')).toBeHidden();evidence.documentation.push({width,...metrics});
  }
  checks.push('PDF and XLSX share aligned, equally sized action columns; revision close glyph is22px within its retained40px hit target');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,evidence,errors},null,2));console.log('PASS control layout polish. '+output);
})().catch(async error=>{releaseHeld?.();console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{releaseHeld?.();await browser?.close();server.kill();});
