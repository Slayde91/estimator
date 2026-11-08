// Creation guards use disposable native Save/Load fixtures, never the live app.
const {chromium, expect}=require('@playwright/test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {fillProjectDetails,clickProjectControl,openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','project-document-guard-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',stdout='',browser,page;
server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error(logs||'Fixture startup timed out')),120000);
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timeout);reject(Error('Fixture exited '+code));});
  server.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(stdout.split('\n')[0]));}});
});
const errors=[],writes=[];
const guarded=/\/api\/(?:project\/save(?:-as)?|commercial\/(?:defaults|save|purchase-order-defaults)|swms\/(?:defaults|save)|certifications(?:\?|$))/;
const required='Create or load a project before creating documents.';
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);}
async function notified(){await expect(page.locator('#app-message')).toHaveText(required);}
async function discard(root,label){
  await root.getByRole('button',{name:label,exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:900}});page.setDefaultTimeout(45000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&guarded.test(request.url()))writes.push(request.url());});
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  await fillProjectDetails(page,{client:'Project guard account','site-address':'1 Guard Road'});
  const before=await page.evaluate(()=>({details:window.CeasefireProject.details(),inputs:window.CeasefireProject.configuration()}));
  await page.getByRole('button',{name:'Estimates',exact:true}).click();
  for(const id of ['project-estimate-quote','project-estimate-swms']){await page.locator('#'+id).click();await notified();}
  const commercial=[['quote','commercial-quote-root','New Quote','Back to Quotes'],['work-orders','commercial-work-order-root','New Work Order','Back to Work Orders'],['purchase-orders','commercial-purchase-order-root','New Purchase Order','Back to Purchase Orders']];
  for(const [section,id,label]of commercial){
    await openProjectSection(page,section);const host=page.locator('#'+id);await host.getByRole('button',{name:label,exact:true}).click();await notified();await expect(host.locator('.commercial-editor')).toHaveCount(0);
  }
  await openProjectSection(page,'swms');await page.locator('#swms-root').getByRole('button',{name:'New SWMS',exact:true}).click();await notified();
  await expect(page.locator('#swms-root').getByLabel('Document title',{exact:true})).toHaveCount(0);
  await openProjectSection(page,'certification');await expect(page.locator('#certification-document')).toBeEnabled();
  await page.locator('#certification-client').fill('Keep incomplete certificate draft');
  await page.locator('#certification-document').selectOption('');await notified();
  await expect(page.locator('#certification-client')).toHaveValue('Keep incomplete certificate draft');
  await page.locator('#certification-save').click();await notified();
  const documentTabs=page.locator('#document-pages');await expect(documentTabs).toBeVisible();
  await documentTabs.locator('[data-document-section="documentation"]').click();await notified();
  await expect(page.locator('#view-certification')).toBeVisible();await expect(page.locator('#view-documentation')).toBeHidden();
  await expect(documentTabs.locator('[aria-current="page"]')).toHaveAttribute('data-document-section','certification');
  await expect(page.locator('#certification-client')).toHaveValue('Keep incomplete certificate draft');
  await page.locator('#documents-navigation-toggle').hover();
  await page.locator('#documents-navigation-menu [data-document-section="documentation"]').click();await notified();
  await expect(page.locator('#view-documentation')).toBeHidden();
  assert.equal(await page.evaluate(async()=>{try{await window.CeasefireDocumentation.open();return false;}catch(error){return error.message==='Create or load a project before creating documents.';}}),true);
  assert.deepEqual(writes,[],'New without a Project must not save or request document defaults');assert.equal(fs.existsSync(info.project),false);
  assert.deepEqual(await page.evaluate(()=>({details:window.CeasefireProject.details(),inputs:window.CeasefireProject.configuration()})),before);
  // Explicit Settings operations remain available independently of a Project.
  const defaults=await(await page.request.get(new URL('/api/certifications/defaults',page.url()).href)).json();
  const settings=await page.request.post(new URL('/api/certifications/defaults',page.url()).href,{data:{expected_version:defaults.version,fields:{...defaults.fields,name:'Independent settings'}}});assert.equal(settings.status(),200);
  const savedResponse=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as'));
  await clickProjectControl(page,'Save');const saved=await savedResponse;assert.equal(saved.status(),200,await saved.text());await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),true);
  const token=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  const workspace=await(await page.request.get(new URL('/api/certifications/workspaces/'+token,page.url()).href)).json();assert.equal(workspace.created_project,true);
  await openProjectSection(page,'documentation');await expect(page.locator('#documentation-pdf-rows [data-document-kind]')).not.toHaveCount(0);await idle();
  for(const [section,id,label,back]of commercial){
    await openProjectSection(page,section);const host=page.locator('#'+id);await host.getByRole('button',{name:label,exact:true}).click();
    await expect(host.locator('.commercial-editor')).toBeVisible();await discard(host,back);await expect(host.getByRole('button',{name:label,exact:true})).toBeVisible();
  }
  await openProjectSection(page,'swms');await page.locator('#swms-root').getByRole('button',{name:'New SWMS',exact:true}).click();
  await expect(page.locator('#swms-root').getByLabel('Document title',{exact:true})).toBeVisible();await discard(page.locator('#swms-root'),'Back to statements');
  await openProjectSection(page,'certification');await page.locator('#certification-document').selectOption('');
  await expect(page.locator('#certification-client')).toHaveValue('Project guard account');
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'created-project-certificate.png')});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['all five New actions blocked without a saved Project','no automatic saves/default requests','fields and pricing preserved','Settings independent','explicit Save activates exact workspace','all five New actions allowed after Save'],errors},null,2));
  console.log('PASS Project-required document creation: '+output);
})().catch(async error=>{console.error(error);console.error(logs);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();});
