const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,clickProjectControl,prepareProjectForSave}=require('./project_actions.cjs');

// Isolated fixture: existing signed documents stay literal; new statements use
// saved Personal Details only when the user explicitly inserts a signature.
module.exports=async function peopleDefaults(root,output){
  const directory=path.join(output,'people-signatures');
  const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'swms_fixture.py'),'--directory',directory,'--edition','full'],{cwd:root,windowsHide:true});
  let logs='',browser;
  server.stderr.on('data',value=>logs+=value);
  try{
    const info=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
    assert.notEqual(info.port,8765);
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1575,height:1000}}),errors=[],writes=[],reads=[];
    const base=`http://127.0.0.1:${info.port}`;
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{const route=new URL(request.url()).pathname;if(route==='/api/certifications/defaults'&&request.method()==='GET')reads.push(route);if(['/api/certifications/defaults','/api/swms/people-defaults'].includes(route)&&request.method()==='POST')writes.push(route);});
    await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await prepareProjectForSave(page);
    const firstSave=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await firstSave).status(),200);await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});
    await openProjectSection(page,'swms');const host=page.locator('#swms-root');await expect(host.getByRole('button',{name:'New SWMS',exact:true})).toBeVisible();
    const workspace=await page.evaluate(()=>window.CeasefireCertification.sessionId());
    async function newStatement() {
      const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/swms/defaults');
      await host.getByRole('button',{name:'New SWMS',exact:true}).click();
      await response;await expect(host).toHaveAttribute('aria-busy','false');
    }
    async function post(action,data){const response=await page.request.post(`${base}/api/swms/${action}`,{data:{workspace_id:workspace,...data}});assert.equal(response.status(),200,await response.text());return response.json();}
    async function profile(fields){const current=await (await page.request.get(base+'/api/certifications/defaults')).json();const response=await page.request.post(base+'/api/certifications/defaults',{data:{fields,expected_version:current.version}});assert.equal(response.status(),200,await response.text());return response.json();}
    const savedProfile={name:'Settings person',position:'Site supervisor',qualification:'Qualification as entered',accreditation:'Accreditation as entered'};
    await profile(savedProfile);
    const defaults=await post('defaults',{details:{}}),signature={version:1,ratio:3,strokes:[[[.1,.4],[.5,.2],[.8,.7]]]};
    defaults.fields.reviewers=[{name:'Historical reviewer',position:'Historical role',signature}];
    defaults.fields.consultation=[{name:'Historical consultant',position:'Other saved role',signature}];
    defaults.fields.title='Previously authored statement';
    defaults.fields.details.project_name='Saved client';defaults.fields.details.project_address='Saved site';
    const existing=await post('save',{id:crypto.randomUUID(),version:0,status:'Archived',fields:defaults.fields});
    await post('people-defaults',{section:'reviewers',rows:[{name:'Legacy shared person',position:'Legacy shared role',signature}],expected_version:1});
    const otherFields=JSON.parse(JSON.stringify(defaults.fields));otherFields.details.project_name='Other retained statement';
    const other=await post('save',{id:crypto.randomUUID(),version:0,status:'Draft',fields:otherFields});
    const oldSnapshot=await (await page.request.get(`${base}/api/swms/state?workspace=${workspace}`)).json();
    const legacyDefaults=(await post('defaults',{details:{}})).people_defaults;
    await page.evaluate(()=>window.CeasefireSWMS.activate());
    await expect(host.locator('.project-kanban')).toHaveCount(0);
    const savedStatements=host.getByRole('combobox',{name:'Saved statement',exact:true});
    await expect(savedStatements.locator('option')).toHaveCount(3);
    await savedStatements.selectOption(other.id);await expect(host.getByLabel('Project Name',{exact:true})).toHaveValue('Other retained statement');
    page.once('dialog',dialog=>dialog.accept());await host.locator('.swms-document-actions').getByRole('button',{name:'Delete',exact:true}).click();
    await expect(savedStatements.locator('option')).toHaveCount(2);
    await expect(savedStatements).toHaveValue(existing.id);
    await expect(host.getByLabel('Document title',{exact:true})).toHaveCount(0);
    await expect(host.getByLabel('Workflow status',{exact:true})).toHaveValue('Archived');
    const group=title=>host.locator(':scope > details').filter({has:page.locator(':scope > summary').filter({hasText:new RegExp('^'+title+'$')})});
    const reviewers=group('Person/s responsible for reviewing SWMS'),consultation=group('This SWMS has been developed in consultation with'),site=group('Site Sign-Off');
    await reviewers.locator(':scope > summary').click();
    await expect(reviewers.getByLabel('Name',{exact:true})).toHaveValue('Historical reviewer');
    await expect(reviewers.getByLabel('Position',{exact:true})).toHaveValue('Historical role');
    await expect(reviewers.getByRole('img')).toBeVisible();
    await host.getByRole('button',{name:'Back to Documents',exact:true}).first().click();
    await openProjectSection(page,'swms');
    await newStatement();
    await expect(host.getByLabel('Project Name',{exact:true})).toBeVisible();
    let fields=await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    for(const key of ['reviewers','consultation','work_types'])assert.deepEqual(fields[key],[]);
    assert.equal(fields.details.project_manager,'');assert.equal(fields.manager_signature,null);
    await expect(host.getByLabel('Status',{exact:true})).toHaveCount(0);
    await expect(host.locator('.swms-person')).toHaveCount(0);
    await expect(host.locator('.swms-step-table tbody tr')).toHaveCount(0);
    await host.getByLabel('Passive Firestopping',{exact:true}).check();
    await expect(host.locator('.swms-step-table tbody tr')).toHaveCount(13);
    await host.getByLabel('Passive Firestopping',{exact:true}).uncheck();
    await expect(host.locator('.swms-step-table tbody tr')).toHaveCount(0);
    await host.getByLabel('Project Name',{exact:true}).fill('Explicit SWMS choices');
    await host.getByLabel('Workflow status',{exact:true}).selectOption('Review');
    await host.getByRole('button',{name:'Save',exact:true}).first().click();await expect(host.locator('.swms-message')).toContainText('Saved.');
    await host.getByLabel('Workflow status',{exact:true}).selectOption('Rejected');
    await host.getByRole('button',{name:'Save',exact:true}).first().click();await expect(host.locator('.swms-message')).toContainText('Saved.');
    const savedChoice=await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.id);
    await expect(host.getByLabel('Project Name',{exact:true})).toHaveValue('Explicit SWMS choices');
    fields=await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    for(const key of ['reviewers','consultation','work_types'])assert.deepEqual(fields[key],[]);
    const beforeSign=reads.length;
    await reviewers.locator(':scope > summary').click();await consultation.locator(':scope > summary').click();
    await expect(reviewers.locator('.swms-person')).toHaveCount(0);await expect(consultation.locator('.swms-person')).toHaveCount(0);
    await reviewers.getByRole('button',{name:'Add person',exact:true}).click();await consultation.getByRole('button',{name:'Add person',exact:true}).click();
    await reviewers.locator('.swms-person').first().getByRole('button',{name:'Draw signature',exact:true}).click();
    await page.getByRole('dialog',{name:'Signatures',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(reads.length,beforeSign,'Cancelled drawing does not read or fill Personal Details');
    await expect(reviewers.getByLabel('Name',{exact:true}).first()).toHaveValue('');
    async function sign(row){await row.getByRole('button',{name:'Draw signature',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Signatures',exact:true}),box=await dialog.getByLabel('Signature drawing pad').boundingBox();await page.mouse.move(box.x+30,box.y+60);await page.mouse.down();await page.mouse.move(box.x+130,box.y+20,{steps:5});await page.mouse.up();await dialog.getByRole('button',{name:'Insert signature',exact:true}).click();}
    const firstReviewer=reviewers.locator('.swms-person').first();
    await page.route('**/api/certifications/defaults',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Unavailable'})}),{times:1});
    await sign(firstReviewer);await expect(host.locator('.swms-message')).toContainText('Personal details could not be loaded');await expect(firstReviewer.getByRole('img')).toHaveCount(0);await expect(firstReviewer.getByLabel('Name',{exact:true})).toHaveValue('');
    await firstReviewer.getByLabel('Position',{exact:true}).fill('Manual role');await sign(firstReviewer);
    await expect(firstReviewer.getByLabel('Name',{exact:true})).toHaveValue(savedProfile.name);await expect(firstReviewer.getByLabel('Position',{exact:true})).toHaveValue('Manual role');await expect(host.locator('.swms-message')).toBeHidden();
    await firstReviewer.getByRole('button',{name:'Clear signature',exact:true}).click();await expect(firstReviewer.getByRole('img')).toHaveCount(0);await expect(firstReviewer.getByLabel('Name',{exact:true})).toHaveValue('');await expect(firstReviewer.getByLabel('Position',{exact:true})).toHaveValue('');
    // Each signature reads current saved Settings, and missing values stay blank.
    await profile({...savedProfile,name:'Updated Settings person',position:''});
    const firstConsultant=consultation.locator('.swms-person').first();await sign(firstConsultant);
    await expect(firstConsultant.getByLabel('Name',{exact:true})).toHaveValue('Updated Settings person');await expect(firstConsultant.getByLabel('Position',{exact:true})).toHaveValue('');
    await firstConsultant.getByRole('button',{name:'Clear signature',exact:true}).click();
    await expect(firstConsultant.getByLabel('Name',{exact:true})).toHaveValue('');await expect(firstConsultant.getByLabel('Position',{exact:true})).toHaveValue('');
    await sign(firstConsultant);
    await expect(firstConsultant.getByRole('img')).toBeVisible();
    // Settings loading is part of the guarded signature operation. A newer manual
    // field value must not be replaced when the delayed response arrives.
    let release,intercepted;const held=new Promise(resolve=>intercepted=resolve);
    await page.route('**/api/certifications/defaults',async route=>{if(route.request().method()!=='GET')return route.continue();intercepted();await new Promise(resolve=>release=resolve);await route.continue();},{times:1});
    await reviewers.getByRole('button',{name:'Add person',exact:true}).click();
    const second=reviewers.locator('.swms-person').nth(1);await sign(second);await held;
    await expect(host.getByRole('button',{name:'Save',exact:true}).first()).toBeDisabled();
    await second.getByLabel('Name',{exact:true}).evaluate(input=>{input.value='New manual value';input.dispatchEvent(new Event('input',{bubbles:true}));});
    release();await expect(second.getByRole('img')).toBeVisible();await expect(second.getByLabel('Name',{exact:true})).toHaveValue('New manual value');
    const details=group('Project Details');await sign(details.locator(':scope > .swms-signature'));await expect(host.getByLabel('Project Manager (PM)',{exact:true})).toHaveValue('Updated Settings person');await expect(host.getByLabel('Position',{exact:true}).first()).toHaveValue('');
    await host.getByLabel('Contact',{exact:true}).fill('Unrelated manager contact');
    await details.locator(':scope > .swms-signature').getByRole('button',{name:'Clear signature',exact:true}).click();
    await expect(host.getByLabel('Project Manager (PM)',{exact:true})).toHaveValue('');await expect(host.getByLabel('Contact',{exact:true})).toHaveValue('Unrelated manager contact');
    await expect(second.getByLabel('Name',{exact:true})).toHaveValue('New manual value');await expect(second.getByRole('img')).toBeVisible();
    await site.locator(':scope > summary').click();await site.getByRole('button',{name:'Add person',exact:true}).click();await sign(site.locator('.swms-person').first());await expect(site.getByLabel('Name',{exact:true})).toHaveValue('Updated Settings person');
    await site.getByRole('button',{name:'Clear signature',exact:true}).click();await expect(site.getByLabel('Name',{exact:true})).toHaveValue('');await sign(site.locator('.swms-person').first());
    // Existing shared people rows and the Personal Details profile are untouched
    // by editing, signing, clearing, adding people, and saving this statement.
    await host.getByRole('button',{name:'Save',exact:true}).first().click();await expect(host.locator('.swms-message')).toContainText('Saved.');
    const signed=await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    assert.equal(signed.reviewers[0].signature,null);assert.ok(signed.consultation[0].signature.strokes.length);assert.ok(signed.site_signoffs[0].signature.strokes.length);
    assert.deepEqual((await post('defaults',{details:{}})).people_defaults,legacyDefaults);
    const stateAfter=await (await page.request.get(`${base}/api/swms/state?workspace=${workspace}`)).json();assert.deepEqual(stateAfter.documents.find(row=>row.id===existing.id),oldSnapshot.documents.find(row=>row.id===existing.id));
    await host.getByRole('button',{name:'Back to Documents',exact:true}).first().click();await expect(page.locator('#view-documentation')).toBeVisible();await openProjectSection(page,'swms');await newStatement();await expect(host.getByLabel('Project Name',{exact:true})).toBeVisible();
    fields=await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);assert.deepEqual(fields.reviewers,[]);assert.deepEqual(fields.consultation,[]);assert.deepEqual(fields.work_types,[]);assert.equal(fields.manager_signature,null);assert.deepEqual(fields.site_signoffs,[]);
    await page.screenshot({path:path.join(directory,'new-people-blank.png')});
    // A response for a replaced editor must not sign or fill the replacement.
    await reviewers.locator(':scope > summary').click();
    await reviewers.getByRole('button',{name:'Add person',exact:true}).click();
    let releaseOld,oldStarted;const waitingOld=new Promise(resolve=>oldStarted=resolve);
    await page.route('**/api/certifications/defaults',async route=>{oldStarted();await new Promise(resolve=>releaseOld=resolve);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Stale profile failure'})});},{times:1});
    await sign(reviewers.locator('.swms-person').first());await waitingOld;
    await page.evaluate(async()=>{window.CeasefireSWMS.applyProject({workspace_id:window.CeasefireCertification.sessionId()});await window.CeasefireSWMS.activate();});
    const oldReply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/certifications/defaults'&&response.status()===503);
    releaseOld();await (await oldReply).finished();await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(host.getByRole('button',{name:'New SWMS',exact:true})).toBeVisible();
    assert.equal((await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor)).id,savedChoice);
    await expect(host.locator('.swms-message')).toBeHidden();
    await newStatement();await expect(host.getByLabel('Project Name',{exact:true})).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields.reviewers),[]);
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    return 'SWMS defaults: no automatic people, no selected works or tables, final work choice can be removed and empty choices survive Save/reopen; people are added explicitly, cancel leaves blank, successful signatures read latest saved Personal Details into empty applicable fields only, manual values preserved across delayed profile reads, Clear resets associated name/position, manager and site signoff fill, no shared profile/people writes, and old signed statement snapshots unchanged';
  }catch(error){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'server.log'),logs);throw error;}
  finally{await browser?.close();server.kill();}
};
