'use strict';
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,prepareProjectForSave,clickProjectControl}=require('./project_actions.cjs');
const {openCertificateEditor}=require('./certification_generation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`document-controls-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page,releaseHeld;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const errors=[],writes=[],layouts=[],checks=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1254,height:884}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&/^\/api\/certifications(?:\/[0-9a-f-]{36})?$/.test(new URL(request.url()).pathname))writes.push(request.postDataJSON());});
  await page.goto(base);await idle();await prepareProjectForSave(page);await clickProjectControl(page,'Save');await idle();
  await openProjectSection(page,'certification');await openCertificateEditor(page);await expect(page.locator('#certification-back')).toBeEnabled();
  assert.equal(writes.length,0,'Opening a certificate editor never saves document or personal values');
  await page.locator('#certification-client').fill('Retained certificate draft');
  const fingerprint=await page.evaluate(()=>window.CeasefireCertification.fingerprint());
  await page.locator('#certification-back').click();await expect(page.locator('#certification-list')).toBeVisible();
  await expect(page.locator('#certification-resume')).toBeVisible();await page.locator('#certification-resume').click();
  await expect(page.locator('#certification-client')).toHaveValue('Retained certificate draft');
  assert.equal(await page.evaluate(()=>window.CeasefireCertification.fingerprint()),fingerprint);assert.equal(writes.length,0);
  checks.push('Back returns to certificate board, Resume retains the exact unsaved draft, and neither saves');
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    for(const width of [1254,390]){
      await page.setViewportSize({width,height:884});
      const metrics=await page.locator('#certification-editor').evaluate(editor=>{
        const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
        const scope=editor.querySelector('#certification-scopes'),back=editor.querySelector('#certification-back'),selector=editor.querySelector('.certification-document-select'),workflow=editor.querySelector('.certification-workflow');
        return{back:rect(back),backText:back.textContent.trim(),backBorder:getComputedStyle(back).borderStyle,
          scope:rect(scope.querySelector('summary')),scopeContainer:rect(scope.parentElement),scopePadding:getComputedStyle(scope.querySelector('summary')).paddingTop,
          selector:rect(selector),workflow:rect(workflow),workflowForm:workflow.querySelector('select').form.id,
          save:rect(editor.querySelector('#certification-save-draft')),generate:rect(editor.querySelector('#certification-generate')),
          statusInsideDetailsCard:!!editor.querySelector('.certification-details-card>#certification-status'),overflow:document.documentElement.scrollWidth-innerWidth};
      });
      assert.equal(metrics.back.width,42);assert.equal(metrics.back.height,42);assert.equal(metrics.backText,'←');assert.equal(metrics.backBorder,'solid');
      assert.equal(metrics.scope.height,42);assert.ok(Math.abs(metrics.scope.width-Math.min(420,metrics.scopeContainer.width))<1);assert.equal(metrics.scopePadding,'10.6px');
      if(width>700){assert.ok(metrics.workflow.x>=metrics.selector.right);assert.ok(Math.abs(metrics.workflow.y-metrics.selector.y)<1);}
      assert.equal(metrics.workflowForm,'certification-form');assert.equal(metrics.statusInsideDetailsCard,true);
      assert.ok(metrics.save.right<=metrics.generate.x);assert.ok(Math.abs(metrics.save.y-metrics.generate.y)<1);assert.ok(metrics.overflow<=1);
      await page.locator('#certification-scopes summary').click();await page.locator('#certification-scope-ductwork').focus();await page.keyboard.press('Escape');
      await expect(page.locator('#certification-scopes')).not.toHaveAttribute('open','');await expect(page.locator('#certification-scopes summary')).toBeFocused();
      layouts.push({theme,width,...metrics});
      await page.locator('#certification-back').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`certification-controls-${theme}-${width}.png`)});
    }
  }
  assert.equal(writes.length,0);checks.push('Five themes at desktop and narrow widths retain42px Back/scope controls, adjacent selectors/actions, keyboard scope behavior and no document writes');
  await page.setViewportSize({width:1254,height:884});
  let first=true,announce;const held=new Promise(resolve=>announce=resolve),release=new Promise(resolve=>releaseHeld=resolve);
  await page.route('**/api/certifications?*',async route=>{if(route.request().method()==='POST'&&new URL(route.request().url()).pathname==='/api/certifications'&&first){first=false;announce();await release;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic uncertain Save'})});}else await route.continue();});
  await page.locator('#certification-save-draft').click();await held;await expect(page.locator('#certification-back')).toBeDisabled();releaseHeld();
  await expect(page.locator('#certification-status')).toContainText('Retry the same button');await expect(page.locator('#certification-back')).toBeDisabled();
  await expect(page.locator('#certification-client')).toHaveValue('Retained certificate draft');await page.locator('#certification-save-draft').click();
  await expect(page.locator('#certification-back')).toBeEnabled();await expect(page.locator('#certification-status')).toContainText('Certification details saved.');
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  checks.push('Back stays disabled during Save and uncertain retry; retry uses the exact captured request and retains fields');
  const savedId=await page.locator('#certification-document').inputValue();assert.ok(savedId);
  await page.locator('#certification-back').click();
  const unavailable=async route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Synthetic unavailable certificate'})});
  const savedRoute=url=>url.pathname==='/api/certifications/'+savedId;
  await page.route(savedRoute,unavailable);
  const savedCard=page.locator('#certification-board [data-document-id='+JSON.stringify(savedId)+'] .project-title-button');
  await savedCard.click();await expect(page.locator('#certification-list-status')).toBeVisible();
  await expect(page.locator('#certification-list-status')).toContainText('Synthetic unavailable certificate');
  await expect(page.locator('#certification-list')).toBeVisible();await expect(page.locator('#certification-editor')).toBeHidden();
  await page.unroute(savedRoute,unavailable);
  assert.equal(writes.length,2);checks.push('Certificate load errors remain visible on the board after moving editor status into its details card');
  await openProjectSection(page,'swms');const host=page.locator('#swms-root');
  await host.getByRole('button',{name:'New SWMS',exact:true}).click();const back=host.getByRole('button',{name:'Back to statements',exact:true});
  for(const theme of ['ceasefire','midnight','ocean','forest','slate'])for(const width of [1254,390]){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.setViewportSize({width,height:884});
    const metric=await back.evaluate(button=>{const r=button.getBoundingClientRect();return{width:r.width,height:r.height,text:button.textContent.trim(),border:getComputedStyle(button).borderStyle};});
    assert.equal(metric.width,42);assert.equal(metric.height,42);assert.equal(metric.text,'←');assert.equal(metric.border,'solid');layouts.push({kind:'SWMS',theme,width,...metric});
  }
  await host.getByLabel('Project Address',{exact:true}).fill('Retained SWMS edit');await back.click();
  const discard=page.getByRole('dialog',{name:'Discard the current SWMS?',exact:true});await discard.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(host.getByLabel('Project Address',{exact:true})).toHaveValue('Retained SWMS edit');
  await back.click();await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(host.getByRole('button',{name:'New SWMS',exact:true})).toBeVisible();
  checks.push('SWMS Back uses matching42px outlined arrow in all themes/widths and preserves the existing Cancel/discard guard');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,layouts,errors},null,2));console.log(JSON.stringify({passed:true,output,checks:checks.length,layoutScenarios:layouts.length}));
})().catch(async error=>{releaseHeld?.();console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{releaseHeld?.();await browser?.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
