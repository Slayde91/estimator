'use strict';
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,clickProjectControl,prepareProjectForSave}=require('./project_actions.cjs');
const {generateCertificate,openCertificateEditor}=require('./certification_generation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`personal-details-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const python=process.env.CEASEFIRE_PYTHON||'python';
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output,'--real-auth'],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);});
const errors=[],checks=[],profileWrites=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);}
async function settings(){await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.locator('#personal-details-save')).toBeEnabled();await idle();}
function seedPreviousProfile(signature){
  // The shared record predates staff sign-in. Seed the old database shape
  // through its service, since current HTTP clients can only save their own.
  const code=[
    'import json, sys',
    'from pathlib import Path',
    'from estimator.certification import CertificationService',
    'from estimator.storage import Store',
    'service = CertificationService(Store(Path(sys.argv[1])))',
    'old = service.get_defaults()',
    "old['fields']['name'] = 'Legacy shared signer'",
    "result = service.save_defaults(old['fields'], old['version'], signature_image=json.load(sys.stdin), signature_name='Historical image.png')",
    'print(json.dumps(result))',
  ].join('\n');
  const seeded=spawnSync(python,['-c',code,path.join(output,'qa.sqlite3')],{cwd:root,windowsHide:true,input:JSON.stringify(signature),encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);return JSON.parse(seeded.stdout);
}
(async()=>{
  const info=await ready,base=`http://127.0.0.1:${info.port}`;browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1101,height:884}});page.setDefaultTimeout(60000);
  assert.notEqual(info.port,8765);
  const admin={email:'profile-admin@example.test',password:'Synthetic-profile-password'};
  const second={email:'profile-editor@example.test',password:'Synthetic-second-password'};
  async function post(route,data,headers={}){
    const response=await page.request.post(base+'/api/'+route,{data,headers});
    assert.equal(response.status(),200,await response.text());return response.json();
  }
  const signature=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;const ink=canvas.getContext('2d');ink.moveTo(2,15);ink.lineTo(32,3);ink.stroke();return canvas.toDataURL('image/png');});
  const previous=seedPreviousProfile(signature);
  assert.equal((await page.request.get(base+'/api/certifications/defaults')).status(),401);
  assert.equal((await page.request.get(base+'/api/certifications/defaults/legacy')).status(),401);
  const setup=await post('access/setup',{...admin,name:'Profile administrator'});
  const firstActor={'X-CRM-Member':setup.user.id};
  const editor=await post('scheduler/members/save',{...second,name:'Profile editor',role:'worker'});
  await post('access/roles',{member_id:editor.id,role:'editor',version:0},firstActor);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/certifications/defaults')profileWrites.push(request.postDataJSON());});await page.goto(base);await idle();
  await prepareProjectForSave(page);
  const projectSave=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await projectSave).status(),200);await idle();
  const defaults=()=>page.request.get(base+'/api/certifications/defaults').then(r=>r.json());
  const initial=await defaults();assert.equal(initial.fields.name,'');assert.equal(initial.signature_image,null);
  await post('certifications/defaults',{fields:initial.fields,expected_version:initial.version,signature_image:signature,signature_name:'Saved signer.png'},firstActor);
  await settings();
  const first={name:'Signer <literal> One',position:'Site Manager',qualification:'Cert 2\nAdditional qualification',accreditation:'ACC-123'};
  for(const [name,value]of Object.entries(first))await page.locator('#personal-'+name).fill(value);
  await page.locator('#personal-details-save').click();await expect(page.locator('#personal-details-status')).toContainText('copied to a certificate only when it is signed');await idle();
  const saved=await defaults();assert.deepEqual(saved.fields,first);assert.equal(saved.signature_image,signature);assert.equal(saved.signature_name,'Saved signer.png');
  checks.push('Personal text saves through existing signer-default API without changing signature artwork');
  await openProjectSection(page,'certification');await idle();
  await expect(page.locator('#certification-board')).toHaveCount(0);await expect(page.locator('#certification-editor')).toBeVisible();
  await openCertificateEditor(page);
  for(const name of Object.keys(first))await expect(page.locator('#certification-'+name)).toHaveValue('');
  async function sign(){await page.locator('#certification-signature-use').click();const dialog=page.getByRole('dialog',{name:'Signatures',exact:true}),box=await dialog.getByLabel('Signature drawing pad').boundingBox();await page.mouse.move(box.x+25,box.y+50);await page.mouse.down();await page.mouse.move(box.x+120,box.y+15,{steps:5});await page.mouse.up();await dialog.getByRole('button',{name:'Insert signature',exact:true}).click();await expect(page.locator('#certification-signature-preview')).toBeVisible();}
  await sign();for(const [name,value]of Object.entries(first))await expect(page.locator('#certification-'+name)).toHaveValue(value);
  assert.equal(profileWrites.length,1,'Signing reads Settings but never writes them');
  await page.locator('#certification-form textarea[required]').evaluateAll(controls=>{for(const control of controls)if(!control.value.trim()){control.value='Synthetic certificate evidence';control.dispatchEvent(new Event('input',{bubbles:true}));}});
  const creation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/certifications'&&r.request().method()==='POST');
  await expect(page.locator('#certification-save')).toHaveCount(0);await generateCertificate(page,1);const document=await (await creation).json();await idle();
  assert.ok(document.id);checks.push('New certificate starts blank; explicit signing fills empty fields from saved Personal Details');
  await settings();await page.locator('#personal-name').fill('Updated future signer');await page.locator('#personal-details-save').click();await expect(page.locator('#personal-details-status')).toContainText('copied to a certificate only when it is signed');await idle();
  await openProjectSection(page,'certification');await idle();await openCertificateEditor(page);await expect(page.locator('#certification-name')).toHaveValue(first.name);
  const workspace=await page.evaluate(()=>window.CeasefireCertification.sessionId());
  const old=await (await page.request.get(base+'/api/certifications/'+document.id+'?workspace='+workspace)).json();assert.equal(old.fields.name,first.name);
  await openCertificateEditor(page,{fresh:true});await idle();for(const name of Object.keys(first))await expect(page.locator('#certification-'+name)).toHaveValue('');
  await sign();await expect(page.locator('#certification-name')).toHaveValue('Updated future signer');
  checks.push('Existing certificate snapshot retains its signer; New stays blank until signing reads updated Settings');
  const beforeEdit=await defaults(),writesBeforeEdit=profileWrites.length;
  await page.locator('#certification-name').fill('Edited in Certification');await settings();await expect(page.locator('#personal-name')).toHaveValue('Updated future signer');
  assert.equal(profileWrites.length,writesBeforeEdit);assert.deepEqual(await defaults(),beforeEdit);
  checks.push('Certificate signer edits never write shared Personal Details or reusable signature artwork');
  await page.locator('#personal-name').fill('Keep my personal draft');const beforeConflict=await defaults();
  await post('certifications/defaults',{fields:{...beforeConflict.fields,name:'Other window signer'},expected_version:beforeConflict.version},firstActor);
  await page.locator('#personal-details-save').click();await expect(page.locator('#personal-details-status')).toContainText('changed in another window');
  await page.locator('#personal-details-save').click();const dialog=page.getByRole('dialog',{name:'Personal details changed',exact:true});await dialog.getByRole('button',{name:'Keep editing',exact:true}).click();
  assert.equal((await defaults()).fields.name,'Other window signer');await expect(page.locator('#personal-name')).toHaveValue('Keep my personal draft');
  await page.locator('#personal-details-save').click();await dialog.getByRole('button',{name:'Use entered details',exact:true}).click();await expect(page.locator('#personal-details-status')).toContainText('copied to a certificate only when it is signed');
  assert.equal((await defaults()).fields.name,'Keep my personal draft');assert.equal((await defaults()).signature_image,signature);
  checks.push('Concurrent defaults conflict preserves entries, supports cancellation, and requires explicit approval');
  await page.locator('#personal-details-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'personal-details.png')});
  await page.setViewportSize({width:390,height:900});await page.locator('#personal-details-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'personal-details-mobile.png')});
  const form=await page.locator('#personal-details-form').boundingBox();assert.ok(form.x>=0&&form.x+form.width<=390);
  const firstProfile=await defaults();
  await expect(page.locator('#personal-details-review')).toHaveCount(0);
  await post('access/login',second);
  await page.reload();await idle();await settings();
  await expect(page.locator('#personal-name')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Review previous personal details',exact:true})).toHaveCount(0);
  const empty=await defaults();assert.equal(empty.version,1);assert.equal(empty.signature_image,null);
  await page.locator('#personal-name').fill('My current profile');await page.locator('#personal-details-save').click();
  await expect(page.locator('#personal-details-status')).toContainText('copied to a certificate only when it is signed');
  const savedProfile=await defaults();assert.equal(savedProfile.fields.name,'My current profile');assert.equal(savedProfile.signature_image,null);
  await page.reload();await idle();await settings();await expect(page.locator('#personal-name')).toHaveValue('My current profile');
  assert.deepEqual(await defaults(),savedProfile);
  assert.equal((await page.request.get(base+'/api/certifications/defaults/legacy')).status(),403);
  await post('access/login',admin);
  assert.deepEqual(await defaults(),firstProfile);
  assert.deepEqual(await (await page.request.get(base+'/api/certifications/defaults/legacy')).json(),previous);
  checks.push('Two named staff profiles stay separate across reload and sign-in. Signed-out clients cannot read defaults. Only the administrator can read the unchanged historical details and artwork.');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,output,checks:checks.length}));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{await browser?.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
