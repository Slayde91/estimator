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
  await page.locator('#certification-back').click();await expect(page.locator('#view-documentation')).toBeVisible();
  const pdfRows=page.locator('#documentation-pdf-rows');
  await pdfRows.getByRole('button',{name:'Schedules',exact:true}).click();
  const revisions=pdfRows.locator('tr[data-document-kind="project.full_schedule.pdf"] .documentation-view-revisions');
  await expect(revisions).toHaveCount(1);
  for(const width of [1254,390]){
    await page.setViewportSize({width,height:884});
    for(const selected of [false,true]){
      if(selected){await revisions.click();await expect(revisions).toHaveAttribute('aria-expanded','true');}
      const alignment=await page.locator('.documentation-pdf-table').evaluate(table=>{
        const th=[...table.querySelectorAll('thead th')],row=table.querySelector('tr[data-document-kind]:not([hidden])');
        const textStart=cell=>{const range=document.createRange();range.selectNodeContents(cell);return range.getBoundingClientRect().left;};
        const picker=row.querySelector('.document-cover-picker'),remove=row.querySelector('.document-cover-actions button'),download=row.querySelector('.documentation-download-button');
        const middle=node=>{const box=node.getBoundingClientRect();return box.left+box.width/2;};
        return{coverHeading:textStart(th[3]),cover:picker.getBoundingClientRect().left,actionsHeading:textStart(th[4]),actions:remove.getBoundingClientRect().left,downloadHeading:middle(th[2]),download:middle(download)};
      });
      assert.ok(Math.abs(alignment.coverHeading-alignment.cover)<1,'PDF cover heading starts with its Choose file control');
      assert.ok(Math.abs(alignment.actionsHeading-alignment.actions)<1,'Actions heading starts with its trash control');
      assert.ok(Math.abs(alignment.downloadHeading-alignment.download)<1,'Download heading stays centered over its PDF control');
      layouts.push({kind:'Documentation',width,selected,...alignment});
      if(selected){
        await expect(revisions).toHaveCSS('border-top-color','rgb(226, 182, 0)');
        assert.ok((await revisions.evaluate(button=>getComputedStyle(button).boxShadow)).includes('255, 221, 83'));
        await revisions.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(revisions).toBeFocused();await expect(revisions).toHaveCSS('outline-style','solid');
        await page.locator('#documentation-revisions-close').click();await expect(revisions).toHaveAttribute('aria-expanded','false');
        assert.notEqual(await revisions.evaluate(button=>getComputedStyle(button).borderTopColor),'rgb(226, 182, 0)');
      }
    }
  }
  checks.push('Documentation cover/actions headings align with their controls at desktop and narrow widths, with and without revision pane; selected revisions glow yellow and retain keyboard focus');
  await page.setViewportSize({width:1254,height:884});
  await openProjectSection(page,'certification');
  await expect(page.locator('#certification-client')).toHaveValue('Retained certificate draft');
  assert.equal(await page.evaluate(()=>window.CeasefireCertification.fingerprint()),fingerprint);assert.equal(writes.length,0);
  checks.push('Back returns to certificate board, Resume retains the exact unsaved draft, and neither saves');
  for(const theme of ['ceasefire','midnight','ocean','forest','slate']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    for(const width of [1254,390]){
      await page.setViewportSize({width,height:884});
      const metrics=await page.locator('#certification-editor').evaluate(editor=>{
        const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
        const scope=editor.querySelector('#certification-scopes'),back=editor.querySelector('#certification-back'),workflow=editor.querySelector('.certification-workflow select');
        return{back:rect(back),backText:back.textContent.trim(),backBorder:getComputedStyle(back).borderStyle,
          scope:rect(scope.querySelector('summary')),scopeContainer:rect(scope.parentElement),scopePadding:getComputedStyle(scope.querySelector('summary')).paddingTop,
          workflow:rect(workflow),workflowForm:workflow.form.id,
          save:rect(editor.querySelector('#certification-save-draft')),create:rect(editor.querySelector('#certification-new')),generate:rect(editor.querySelector('#certification-generate')),newBeforePDF:editor.querySelector('#certification-new').nextElementSibling.id==="certification-generate",newInToolbar:editor.querySelector('#certification-new').parentElement.classList.contains('certification-editor-toolbar'),
          statusInsideDetailsCard:!!editor.querySelector('.certification-details-card>#certification-status'),overflow:document.documentElement.scrollWidth-innerWidth};
      });
      assert.equal(metrics.back.width,42);assert.equal(metrics.back.height,42);assert.equal(metrics.backText,'←');assert.equal(metrics.backBorder,'solid');
      assert.equal(metrics.generate.height,42);assert.equal(metrics.newBeforePDF,true);assert.equal(metrics.newInToolbar,true);assert.ok(metrics.create.right<=metrics.generate.x);assert.ok(Math.abs(metrics.create.y+metrics.create.height-metrics.generate.y-metrics.generate.height)<1);
      assert.equal(metrics.scope.height,42);assert.ok(Math.abs(metrics.scope.width-Math.min(420,metrics.scopeContainer.width))<1);assert.equal(metrics.scopePadding,'10.6px');
      if(width>700){assert.ok(metrics.workflow.x>=metrics.generate.right);assert.ok(Math.abs(metrics.workflow.y+metrics.workflow.height-metrics.generate.y-metrics.generate.height)<1);}
      assert.equal(metrics.workflowForm,'certification-form');assert.equal(metrics.statusInsideDetailsCard,true);
      assert.ok(metrics.save.right<=metrics.generate.x);assert.ok(Math.abs(metrics.save.y+metrics.save.height-metrics.generate.y-metrics.generate.height)<1);assert.ok(metrics.overflow<=1);
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
  await page.locator('#certification-save-draft').click();await held;
  for(const prefix of ['certification-','certification-revisions-']){
    for(const control of ['back','save-draft','new','generate','workflow'])await expect(page.locator('#'+prefix+control)).toBeDisabled();
  }
  releaseHeld();
  await expect(page.locator('#certification-status')).toContainText('Retry the same button');
  for(const prefix of ['certification-','certification-revisions-']){
    await expect(page.locator('#'+prefix+'save-draft')).toBeEnabled();
    for(const control of ['back','new','generate','workflow'])await expect(page.locator('#'+prefix+control)).toBeDisabled();
  }
  await expect(page.locator('#certification-client')).toHaveValue('Retained certificate draft');await page.locator('#certification-revisions-save-draft').click();
  await expect(page.locator('#certification-back')).toBeEnabled();await expect(page.locator('#certification-new')).toBeEnabled();await expect(page.locator('#certification-status')).toContainText('Certification details saved.');
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  checks.push('Back stays disabled during Save and uncertain retry; retry uses the exact captured request and retains fields');
  const savedId=await page.locator('#certification-document').inputValue();assert.ok(savedId);
  await page.locator('#certification-revisions-new').click();await expect(page.locator('#certification-client')).toBeFocused();
  const unavailable=async route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Synthetic unavailable certificate'})});
  const savedRoute=url=>url.pathname==='/api/certifications/'+savedId;
  await page.route(savedRoute,unavailable);
  await page.locator('#certification-document').selectOption(savedId);
  await expect(page.locator('#certification-status')).toContainText('Synthetic unavailable certificate');
  await expect(page.locator('#certification-editor')).toBeVisible();
  await page.unroute(savedRoute,unavailable);
  assert.equal(writes.length,2);checks.push('Certificate load errors remain visible on the form');
  await openProjectSection(page,'swms');const host=page.locator('#swms-root');
  const swmsDefaults=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/swms/defaults');
  await host.getByRole('button',{name:'New SWMS',exact:true}).click();await swmsDefaults;await expect(host).toHaveAttribute('aria-busy','false');const back=host.getByRole('button',{name:'Back to Documents',exact:true}).first();
  for(const theme of ['ceasefire','midnight','ocean','forest','slate'])for(const width of [1254,390]){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await page.setViewportSize({width,height:884});
    const metric=await back.evaluate(button=>{const r=button.getBoundingClientRect();return{width:r.width,height:r.height,text:button.textContent.trim(),border:getComputedStyle(button).borderStyle};});
    assert.equal(metric.width,42);assert.equal(metric.height,42);assert.equal(metric.text,'←');assert.equal(metric.border,'solid');layouts.push({kind:'SWMS',theme,width,...metric});
    const toolbar=host.locator('.swms-toolbar').first(),pdf=toolbar.getByRole('button',{name:'Download PDF',exact:true});
    assert.ok(await host.locator('.swms-download').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height===42)),'Both SWMS PDF actions are42px high');
    await expect(toolbar.getByRole('combobox',{name:'Workflow status',exact:true})).toBeVisible();
    assert.equal(await toolbar.locator('.swms-workflow>span').evaluate(label=>getComputedStyle(label).position),'absolute','Workflow label remains available to assistive technology without visible text');
    const pdfBox=await pdf.boundingBox(),workflowBox=await toolbar.getByRole('combobox',{name:'Workflow status',exact:true}).boundingBox();
    if(width>700)assert.ok(Math.abs(pdfBox.y+pdfBox.height-workflowBox.y-workflowBox.height)<1);
  }
  await host.getByLabel('Project Address',{exact:true}).fill('Retained SWMS edit');await back.click();
  const discard=page.getByRole('dialog',{name:'Discard the current SWMS?',exact:true});await discard.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(host.getByLabel('Project Address',{exact:true})).toHaveValue('Retained SWMS edit');
  await back.click();await discard.getByRole('button',{name:'Yes',exact:true}).click();await expect(page.locator('#view-documentation')).toBeVisible();
  checks.push('SWMS Back uses matching42px outlined arrow in all themes/widths and preserves the existing Cancel/discard guard');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,layouts,errors},null,2));console.log(JSON.stringify({passed:true,output,checks:checks.length,layoutScenarios:layouts.length}));
})().catch(async error=>{releaseHeld?.();console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{releaseHeld?.();await browser?.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
