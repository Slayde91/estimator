const {chromium, expect: baseExpect} = require('@playwright/test');
const expect = baseExpect.configure({timeout:30000});
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {openProjectSection} = require('./project_actions.cjs');

module.exports = async function peopleDefaults(root, output) {
  const directory = path.join(output, 'people-defaults');
  const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'swms_fixture.py'),'--directory',directory,'--edition','full'], {cwd:root,windowsHide:true});
  let logs = '', browser;
  server.stderr.on('data', value => logs += value);
  try {
    const info = await new Promise((resolve,reject) => {
      let data = ''; const timer = setTimeout(()=>reject(Error(logs || 'Fixture timeout')),120000);
      server.stdout.on('data', value => {data += value; if(data.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
      server.once('error',reject); server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});
    });
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1575,height:1000}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${info.port}`;
    await page.goto(base); await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await openProjectSection(page, 'swms');
    const host = page.locator('#swms-root');
    await expect(host.getByRole('button',{name:'New SWMS',exact:true})).toBeVisible();
    const workspace = await page.evaluate(()=>window.CeasefireCertification.sessionId());
    const post = async (action, data) => {
      const response = await page.request.post(`${base}/api/swms/${action}`, {data:{workspace_id:workspace,...data}});
      assert.equal(response.status(),200,await response.text()); return response.json();
    };
    const defaults = () => post('defaults', {details:{}});
    const seed = await defaults(), signature = {version:1,ratio:3,strokes:[[[.1,.4],[.5,.2],[.8,.7]]]};
    seed.fields.reviewers = [{name:'Existing reviewer',position:'Safety lead',signature}];
    seed.fields.consultation = [{name:'Existing consultant',position:'Supervisor',signature}];
    const existing = await post('save', {id:crypto.randomUUID(),version:0,status:'Draft',fields:seed.fields});
    await page.evaluate(()=>window.CeasefireSWMS.activate());
    await host.getByRole('button',{name:'Open',exact:true}).click();
    assert.equal((await defaults()).people_defaults.reviewers.version,1,'Opening an older statement must not set global defaults');
    const reviewers = host.locator('.swms-section').filter({has:page.locator(':scope > summary').filter({hasText:/^Person\/s responsible for reviewing SWMS$/})});
    const consultation = host.locator('.swms-section').filter({has:page.locator(':scope > summary').filter({hasText:/^This SWMS has been developed in consultation with$/})});
    // Retaining defaults must also retain another untouched, unconfigured group.
    await post('people-defaults',{section:'reviewers',rows:[{name:'Shared reviewer',position:'Lead',signature:null}],expected_version:1});
    await reviewers.locator(':scope > summary').click();
    await consultation.locator(':scope > summary').click();
    await reviewers.getByLabel('Name',{exact:true}).fill('Existing reviewer edited');
    await consultation.getByLabel('Name',{exact:true}).fill('Existing consultant edited');
    await expect(host.locator('.swms-message')).toContainText('changed in another window');
    await host.getByRole('button',{name:'Keep saved defaults',exact:true}).click();
    await expect(host.locator('.swms-message')).toContainText('Your statement edits are unchanged');
    await host.getByRole('button',{name:'Save',exact:true}).click(); await expect(host.locator('.swms-message')).toContainText('Saved.');
    assert.equal((await defaults()).people_defaults.consultation.version,1,'Keep must suppress implicit initial seeding, including pending signatures');
    assert.equal((await defaults()).fields.consultation[0].signature,null);
    assert.equal((await defaults()).fields.reviewers[0].name,'Shared reviewer');
    const retained = await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    assert.equal(retained.consultation[0].name,'Existing consultant edited'); assert.deepEqual(retained.consultation[0].signature,signature);
    await host.getByRole('button',{name:'Back to statements',exact:true}).click();
    await host.getByRole('button',{name:'Open',exact:true}).click();
    await expect(host.getByLabel('Document title',{exact:true})).toBeVisible();
    await host.getByRole('button',{name:'Save',exact:true}).click();
    await expect.poll(async()=>(await defaults()).people_defaults.consultation.version).toBe(2);
    assert.deepEqual((await defaults()).fields.consultation,retained.consultation,'Explicit Save on reopened statement seeds existing names and drawn signatures');
    await reviewers.locator(':scope > summary').click();
    await consultation.locator(':scope > summary').click();
    // A held default write must block navigation, project replacement, Save and unload.
    let release, intercepted;
    const held = new Promise(resolve=>intercepted=resolve);
    await page.route('**/api/swms/people-defaults', async route=>{intercepted(); await new Promise(resolve=>release=resolve); await route.continue();}, {times:1});
    await reviewers.getByLabel('Name',{exact:true}).fill('New reviewer');
    await held;
    await host.getByRole('button',{name:'Save',exact:true}).click();
    await expect(host.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    assert.equal(await page.evaluate(()=>window.CeasefireSWMS.hasPendingOperation()),true);
    assert.equal(await page.evaluate(async()=>{try{await window.CeasefireSWMS.completeProjectSnapshot();return false;}catch{return true;}}),true);
    assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
    const context = await page.evaluate(()=>window.CeasefireProject.runtimeContext());
    await page.getByRole('button',{name:'Estimates',exact:true}).click();
    await expect(host).toBeVisible();
    await page.locator('.project-workspace-actions button').filter({hasText:/^New$/}).evaluate(button=>button.click());
    assert.equal(await page.evaluate(()=>window.CeasefireProject.runtimeContext()),context);
    release();
    await expect(host.locator('.swms-message')).toContainText('Saved.');
    await expect.poll(async()=>(await defaults()).fields.reviewers[0].name).toBe('New reviewer');
    await reviewers.locator(':scope > summary').click();
    async function checkSignatureActions(names) {
      const actions = reviewers.locator('.swms-person').first().getByRole('button');
      const boxes = [];
      for (const name of names) boxes.push(await actions.and(reviewers.getByRole('button',{name,exact:true})).boundingBox());
      for (const [index, box] of boxes.entries()) {
        assert.equal(box.y,boxes[0].y);
        assert.equal(box.width,box.height);
        assert.equal(box.width,boxes[0].width);
        if (index) assert.ok(box.x >= boxes[index-1].x + boxes[index-1].width);
      }
    }
    await page.setViewportSize({width:390,height:844});
    await checkSignatureActions(['Replace signature','Clear signature','Remove person']);
    await reviewers.getByRole('button',{name:'Clear signature',exact:true}).click();
    await checkSignatureActions(['Draw signature','Remove person']);
    await page.setViewportSize({width:1575,height:1000});
    await consultation.locator(':scope > summary').click();
    await consultation.getByLabel('Name',{exact:true}).fill('New consultant');
    await consultation.getByLabel('Position',{exact:true}).fill('Site manager');
    await expect.poll(async()=>(await defaults()).fields.consultation[0].name).toBe('New consultant');
    assert.equal((await defaults()).fields.reviewers[0].signature,null,'Clearing a signature clears the reusable signature');
    await consultation.getByRole('button',{name:'Replace signature',exact:true}).click();
    const pad = page.getByLabel('SWMS signature drawing pad'), box = await pad.boundingBox();
    await page.mouse.move(box.x+20,box.y+100); await page.mouse.down(); await page.mouse.move(box.x+170,box.y+50,{steps:8}); await page.mouse.up();
    await page.getByRole('dialog').getByRole('button',{name:'Use signature',exact:true}).click();
    await expect.poll(async()=>(await defaults()).fields.consultation[0].signature.strokes[0].length).toBeGreaterThan(3);
    const savedPeople = (await defaults()).fields.consultation;
    await host.getByRole('button',{name:'Save',exact:true}).click(); await expect(host.locator('.swms-message')).toContainText('Saved.');
    await page.screenshot({path:path.join(directory,'people-defaults.png')});
    // Reload creates another workspace: global defaults survive without importing a project.
    page.once('dialog', dialog=>dialog.accept());
    await page.reload(); await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await openProjectSection(page,'swms'); await host.getByRole('button',{name:'New SWMS',exact:true}).click();
    await expect(host.getByLabel('Document title',{exact:true})).toBeVisible();
    const fresh = await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    assert.deepEqual(fresh.consultation,savedPeople); assert.equal(fresh.reviewers[0].name,'New reviewer'); assert.equal(fresh.reviewers[0].signature,null);
    assert.notEqual(await page.evaluate(()=>window.CeasefireCertification.sessionId()),workspace);
    // Another window changes reviewers. An unrelated Save must not revert that section.
    const currentDefaults = (await defaults()).people_defaults;
    await post('people-defaults',{section:'reviewers',rows:[{name:'Other window',position:'Lead',signature:null}],expected_version:currentDefaults.reviewers.version});
    await host.getByRole('button',{name:'Save',exact:true}).click(); await expect(host.locator('.swms-message')).toContainText('Saved.');
    assert.equal((await defaults()).fields.reviewers[0].name,'Other window');
    await reviewers.locator(':scope > summary').click();
    await host.getByLabel('Document title',{exact:true}).fill('Unrelated edits survive shared-default conflict');
    await reviewers.getByLabel('Name',{exact:true}).fill('Stale overwrite');
    await expect(host.locator('.swms-message')).toContainText('changed in another window');
    assert.equal((await defaults()).fields.reviewers[0].name,'Other window');
    assert.equal(await page.evaluate(()=>window.CeasefireSWMS.hasPendingOperation()),true);
    await host.getByRole('button',{name:'Keep saved defaults',exact:true}).click();
    await expect(host.locator('.swms-message')).toContainText('Your statement edits are unchanged');
    await expect(host.getByLabel('Document title',{exact:true})).toHaveValue('Unrelated edits survive shared-default conflict');
    await expect(reviewers.getByLabel('Name',{exact:true})).toHaveValue('Stale overwrite');
    await host.getByRole('button',{name:'Save',exact:true}).click(); await expect(host.locator('.swms-message')).toContainText('Saved.');
    assert.equal((await defaults()).fields.reviewers[0].name,'Other window');
    const afterConflict = await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    assert.equal(afterConflict.title,'Unrelated edits survive shared-default conflict');
    assert.equal(afterConflict.reviewers[0].name,'Stale overwrite');
    assert.deepEqual(afterConflict.consultation,savedPeople,'Resolving shared-default conflicts preserves statement signatures');
    await host.getByRole('button',{name:'Back to statements',exact:true}).click();
    await host.getByRole('button',{name:'New SWMS',exact:true}).click();
    await expect(host.getByLabel('Document title',{exact:true})).toBeVisible();
    await reviewers.locator(':scope > summary').click();
    await reviewers.getByRole('button',{name:'Remove person',exact:true}).click();
    await expect.poll(async()=>(await defaults()).fields.reviewers.length).toBe(0);
    assert.deepEqual((await defaults()).fields.consultation,savedPeople,'Clearing reviewers preserves consultation defaults');
    // Previously captured statements retain their people when reopened or restored.
    const old = await page.request.get(`${base}/api/swms/state?workspace=${workspace}`);
    assert.equal((await old.json()).documents.find(row=>row.id===existing.id).fields.reviewers[0].name,'New reviewer');
    assert.deepEqual(errors,[]);
    return 'Global SWMS people: explicit legacy Save seed, debounced names and drawn signatures, pending navigation/project/unload guards, reload/new-workspace reuse, independent versions, stale conflict protection, persistent clear/removal';
  } catch(error) { fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'server.log'),logs);throw error; }
  finally { await browser?.close(); server.kill(); }
};
