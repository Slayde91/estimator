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

  const firstSave=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save-as'&&r.request().method()==='POST');
  await clickProjectControl(owner,'Save');
  const published=await firstSave;assert.equal(published.status(),200,await published.text());await idle(owner);
  const file=JSON.parse(fs.readFileSync(info.project,'utf8'));
  const documents=file.commercial_documents.documents.filter(d=>d.kind==='quote');
  assert.equal(documents.length,1);assert.equal(documents[0].fields.title,original);assert.equal(documents[0].fields.introduction,edited);assert.equal(documents[0].status,'Presented');
  await openProjectSection(owner,'quote');
  await board(owner).getByRole('button',{name:'New Quote',exact:true}).click();
  await expect(board(owner).locator('.commercial-editor')).toBeVisible();
  await board(owner).getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await owner.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  assert.equal(JSON.parse(fs.readFileSync(info.project,'utf8')).commercial_documents.documents.length,1,'An unsaved new draft never duplicates the recovered history');
  await other.reload();await idle(other);await openProjectSection(other,'quote');
  await expect(board(other).locator('.commercial-card')).toHaveCount(1);
  await expect(card(heading)).toBeVisible();
  const registry=await other.evaluate(async()=>{
    const workspace=window.CeasefireCertification.sessionId();
    let result;
    do {const response=await fetch('/api/commercial/register?workspace='+encodeURIComponent(workspace));if(!response.ok)throw new Error(await response.text());result=await response.json();} while(result.scan_pending);
    return result.documents.map(card=>({id:card.id,title:card.fields.title,status:card.status,path:card.source_path}));
  });
  assert.equal(registry.length,1);
  assert.equal(registry[0].id,documents[0].id);
  assert.equal(path.resolve(registry[0].path),path.resolve(info.project));
  assert.equal(await currentFile(other),null);
  await card(heading).getByRole('button',{name:heading,exact:true}).click();
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveValue([file.estimate.project_no,file.estimate.client,file.estimate.site_address?.replace(/\s+/g,' ')].filter(Boolean).join(' · '));
  await expect(board(other).getByLabel('Linked Project',{exact:true})).toHaveAttribute('readonly','');
  assert.equal(await currentFile(other),null,'Displaying the saved Quote owner does not load it over the active workspace');
  assert.deepEqual(errors,[]);
  console.log('PASS: Existing unfiled history is editable across tabs and filed exactly once; New requires an explicitly saved Project.');
})().catch(error=>{console.error(error,logs);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
