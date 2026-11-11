const {fillProjectDetails}=require('./project_actions.cjs');
'use strict';
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:20000});
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {openProjectSection,clickProjectControl}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..');
const directory=path.join(root,'.runtime/browser-qa','commercial-unfiled-'+Date.now());
fs.mkdirSync(directory,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',directory],{cwd:root,windowsHide:true});
let browser,logs='';
server.stderr.on('data',chunk=>{logs+=chunk;});
const metadata=new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(Error('Fixture timed out: '+logs)),120000);
  server.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});
});
const board=page=>page.locator('#commercial-quote-root');
const currentFile=page=>page.evaluate(()=>window.CeasefireProject.context().project_path);
async function idle(page){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
async function save(page){
  await board(page).locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(board(page).locator('.commercial-message')).toContainText('Document saved.');
}
(async()=>{
  const info=await metadata,base='http://127.0.0.1:'+info.port,errors=[];
  assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1500,height:950}});
  async function newWindow(){
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await idle(page);
    assert.equal(await currentFile(page),null);
    return page;
  }
  const original='Unfiled fixture quote',heading='Quote: Unfiled fixture company',edited='Changed from another window';
  const owner=await newWindow();
  await owner.getByRole('button',{name:'Estimates',exact:true}).click();
  await fillProjectDetails(owner,{'client':'Unfiled fixture company'});
  await fillProjectDetails(owner,{'site-address':'21 Fixture Street'});
  await openProjectSection(owner,'quote');
  await expect(board(owner).getByRole('button',{name:'New Quote',exact:true})).toBeVisible();
  // Existing pre-policy history is deliberately seeded outside the creation API.
  // This preserves recovery coverage without re-enabling New without a Project.
  const workspace=await owner.evaluate(()=>window.CeasefireCertification.sessionId());
  const scopeResponse=await owner.request.get(base+'/api/certifications/workspaces/'+workspace);
  assert.equal(scopeResponse.status(),200,await scopeResponse.text());const scope=await scopeResponse.json();
  assert.equal(scope.created_project,false);
  const seeded=spawnSync(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'legacy_unfiled_fixture.py'),directory,workspace,scope.project_id],{cwd:root,windowsHide:true,encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);assert.equal(JSON.parse(seeded.stdout).title,original);
  await owner.evaluate(()=>window.CeasefireCommercial.activate('quote'));
  await expect(board(owner).getByRole('button',{name:heading,exact:true})).toBeVisible();
  await board(owner).getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(owner.locator('#app-message')).toHaveText('Create or load a project before creating documents.');
  await expect(board(owner).locator('.commercial-editor')).toHaveCount(0);
  assert.equal(await currentFile(owner),null);
  assert.equal(fs.existsSync(info.project),false);

  const other=await newWindow();await openProjectSection(other,'quote');
  assert.notEqual(await owner.evaluate(()=>window.CeasefireCertification.sessionId()),
    await other.evaluate(()=>window.CeasefireCertification.sessionId()),'Each tab has its own active workspace');
  const card=title=>board(other).locator('.commercial-card').filter({has:other.getByRole('button',{name:title,exact:true})});
  await expect(card(heading)).toHaveCount(1);
  await card(heading).getByRole('button',{name:heading,exact:true}).click();
  await expect(board(other).getByLabel('Client',{exact:true})).toHaveValue('Unfiled fixture company');
  await expect(board(other).locator('.commercial-details').getByLabel('Site address',{exact:true})).toHaveValue('21 Fixture Street');
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveValue('');
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveAttribute('placeholder','No linked Project');
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveAttribute('readonly','');
  await board(other).getByLabel('Introduction',{exact:true}).fill(edited);
  await save(other);
  await board(other).getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await card(heading).locator('.commercial-card-menu summary').click();
  await card(heading).getByLabel('Move to',{exact:true}).selectOption('Presented');
  await expect(board(other).locator('.project-kanban-column').filter({has:other.getByRole('heading',{name:'Presented',exact:true})})).toContainText(heading);
  assert.equal(await currentFile(other),null);
  assert.equal(fs.existsSync(info.project),false);

  // Sign another workspace's recovered order without loading or filing its project.
  await openProjectSection(other,'purchase-orders');
  const purchases=other.locator('#commercial-purchase-order-root');
  const requested=purchases.locator('.commercial-column').filter({has:other.getByRole('heading',{name:'Requested',exact:true})});
  const otherWorkspace=await other.evaluate(()=>window.CeasefireCertification.sessionId());
  await other.evaluate(()=>localStorage.setItem('ceasefire.takeoff-signature.v1',JSON.stringify({version:1,ratio:2,strokes:[[[0,.3],[.5,1],[1,0]]]})));
  await purchases.locator('.commercial-card').dragTo(requested);
  const signing=other.getByRole('dialog',{name:'Sign and move',exact:true});
  await signing.getByLabel('Name',{exact:true}).fill('Unfiled fixture signer');
  await signing.getByLabel('Date',{exact:true}).fill('2026-11-11');
  await signing.getByRole('button',{name:'Sign and move',exact:true}).click();
  await expect(requested.locator('.commercial-card')).toContainText('Unfiled fixture supplier');
  assert.equal(await other.evaluate(()=>window.CeasefireCertification.sessionId()),otherWorkspace);
  assert.equal(await currentFile(other),null);
  assert.equal(fs.existsSync(info.project),false);

  const firstSave=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save-as'&&r.request().method()==='POST');
  await clickProjectControl(owner,'Save');
  const published=await firstSave;assert.equal(published.status(),200,await published.text());await idle(owner);
  const file=JSON.parse(fs.readFileSync(info.project,'utf8'));
  const documents=file.commercial_documents.documents.filter(d=>d.kind==='quote');
  assert.equal(documents.length,1);assert.equal(documents[0].fields.title,original);assert.equal(documents[0].fields.introduction,edited);assert.equal(documents[0].status,'Presented');
  const signed=file.commercial_documents.documents.find(d=>d.id===JSON.parse(seeded.stdout).purchase_id);
  assert.equal(signed.status,'Requested');
  assert.equal(signed.fields.order.requested_by,'Unfiled fixture signer');
  assert.equal(signed.fields.order.requested_date,'2026-11-11');
  assert.ok(signed.fields.signatures.requested_by.strokes.length);
  await openProjectSection(owner,'quote');
  await board(owner).getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(board(owner).locator('.commercial-editor')).toBeVisible();
  await board(owner).getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await owner.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  assert.equal(JSON.parse(fs.readFileSync(info.project,'utf8')).commercial_documents.documents.length,2,'An unsaved new draft never duplicates the recovered history');
  await other.reload();await idle(other);await openProjectSection(other,'quote');
  await expect(board(other).locator('.commercial-card')).toHaveCount(1);
  await expect(card(heading)).toBeVisible();
  const registry=await other.evaluate(async()=>{
    const workspace=window.CeasefireCertification.sessionId();
    let result;
    do {const response=await fetch('/api/commercial/register?workspace='+encodeURIComponent(workspace));if(!response.ok)throw new Error(await response.text());result=await response.json();} while(result.scan_pending);
    return result.documents.map(card=>({id:card.id,title:card.fields.title,status:card.status,path:card.source_path}));
  });
  assert.deepEqual(registry.map(row=>row.id).sort(),[documents[0].id,signed.id].sort());
  for(const row of registry)assert.equal(path.resolve(row.path),path.resolve(info.project));
  assert.equal(await currentFile(other),null);
  await card(heading).getByRole('button',{name:heading,exact:true}).click();
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveValue([file.estimate.project_no,file.estimate.client,file.estimate.site_address?.replace(/\s+/g,' ')].filter(Boolean).join(' · '));
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveAttribute('readonly','');
  assert.equal(await currentFile(other),null,'Displaying the saved Quote owner does not load it over the active workspace');

  // A browser tab can outlive the server's in-memory project capability.
  const savedBytes=fs.readFileSync(info.project);
  const registerRequests=[];
  const observeRegister=req=>{if(new URL(req.url()).pathname==='/api/commercial/register') registerRequests.push(req.url());};
  owner.on('request',observeRegister);
  await owner.route('**/api/commercial/state?*',route=>route.fulfill({status:403,json:{error:'Sign in to open this workspace.'}}),{times:1});
  await openProjectSection(owner,'work-orders');
  await expect(owner.locator('#commercial-work-order-root .commercial-message')).toHaveText('Sign in to open this workspace.');
  owner.off('request',observeRegister);
  assert.deepEqual(registerRequests,[],'Authorization errors cannot fall back to the saved register');
  await openProjectSection(owner,'quote');
  await board(owner).getByRole('button',{name:'New Quote',exact:true}).click();
  const introduction=board(owner).getByLabel('Introduction',{exact:true});
  await introduction.fill('Keep my unsaved Quote edits');
  const expiredWorkspace=await owner.evaluate(()=>window.CeasefireCertification.sessionId());
  const expiration=await owner.request.post(base+'/api/certifications/workspaces/'+expiredWorkspace+'/discard',{data:{}});
  assert.equal(expiration.status(),200);
  await board(owner).locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(board(owner).locator('.commercial-message')).toContainText(/reopen.*project/i);
  await expect(board(owner).locator('.commercial-message')).not.toContainText(/certificate/i);
  await expect(introduction).toHaveValue('Keep my unsaved Quote edits');
  await board(owner).getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await owner.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();

  for(const [section,label,id] of [
    ['work-orders','Work Order','commercial-work-order-root'],
    ['purchase-orders','Purchase Order','commercial-purchase-order-root'],
    ['quote','Quote','commercial-quote-root']
  ]){
    const pane=owner.locator('#'+id);
    await openProjectSection(owner,section);
    const create=pane.getByRole('button',{name:'New '+label,exact:true});
    await expect(create).toBeVisible();
    await expect(pane).not.toContainText(/certificate workspace/i);
    if(section==='quote'){
      await pane.locator('.commercial-card').getByRole('button',{name:heading,exact:true}).click();
      await expect(introduction).toHaveValue(edited);
      await pane.getByRole('button',{name:'Back to Quotes',exact:true}).click();
    }
    await create.click();
    await expect(pane.locator('.commercial-message')).toContainText(/reopen.*project/i);
    await expect(pane.locator('.commercial-editor')).toHaveCount(0);
    assert.equal(await owner.evaluate(()=>window.CeasefireCertification.sessionId()),expiredWorkspace);
  }
  await openProjectSection(owner,'certification');
  await expect(owner.locator('#app-message')).toContainText(/certificate workspace is unavailable/i);
  assert.deepEqual(fs.readFileSync(info.project),savedBytes);
  assert.deepEqual(errors,[]);
  console.log('PASS: Unfiled history, saved cards after workspace expiry, retained Quote drafts, authorization, and certificate-specific errors.');
})().catch(error=>{console.error(error,logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
