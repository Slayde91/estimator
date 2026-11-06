const {chromium, expect: baseExpect} = require('@playwright/test');
const expect = baseExpect.configure({timeout:30000});
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `swms-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const checks = [];
async function run(edition) {
  const directory = path.join(output, edition);
  const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'swms_fixture.py'),'--directory',directory,'--edition',edition], {cwd:root,windowsHide:true});
  let logs = '', browser;
  server.stderr.on('data', value => logs += value);
  try {
    const info = await new Promise((resolve,reject) => {
      let data = ''; const timer = setTimeout(()=>reject(Error(logs || 'Fixture timeout')),120000);
      server.stdout.on('data', value => {data += value; if(data.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
      server.once('error',reject); server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});
    });
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1575,height:1000}}), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if(!request.url().startsWith('http://127.0.0.1:') && !request.url().startsWith('data:')) external.push(request.url()); });
    const idle = () => page.waitForFunction(()=>{const value=window.CeasefireDesktop?.status();return value?.ready && !value.busy;});
    await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
    await page.getByRole('button',{name:'Estimates',exact:true}).click();
    await page.locator('#project-no').fill('CF-SWMS'); await page.locator('#client').fill('Example builder'); await page.locator('#site-address').fill('10 Test Street');
    await page.locator('#projects-navigation-toggle').hover();
    await page.locator('#projects-navigation-menu [data-project-section="documentation"]').click();
    const documentRow = page.locator('#documentation-pdf-rows tr').filter({hasText:'Safe Work Method Statement'});
    await documentRow.getByRole('button').first().click();
    const host = page.locator('#swms-root'); await expect(host).toBeVisible();
    await host.getByRole('button',{name:'New SWMS',exact:true}).click();
    await expect(host.getByLabel('Job Reference',{exact:true})).toHaveValue('CF-SWMS');
    await expect(host.getByLabel('Project Address',{exact:true})).toHaveValue('10 Test Street');
    await host.getByLabel('Document title',{exact:true}).fill(`SWMS ${edition}`);
    await host.getByLabel('Protective Coatings',{exact:true}).check();
    await host.getByLabel('Installation of Passive Fire Protection Works',{exact:true}).check();
    await expect(host.locator('.swms-step-table tbody tr')).toHaveCount(45);
    await host.getByRole('button',{name:'Draw signature',exact:true}).first().click();
    const pad = page.getByLabel('SWMS signature drawing pad'), rect = await pad.boundingBox();
    await page.mouse.move(rect.x+30,rect.y+120); await page.mouse.down(); await page.mouse.move(rect.x+90,rect.y+45,{steps:6}); await page.mouse.move(rect.x+160,rect.y+125,{steps:6}); await page.mouse.up();
    await page.getByRole('dialog').getByRole('button',{name:'Use signature',exact:true}).click();
    await expect(host.getByRole('img',{name:'Project manager drawn signature'})).toBeVisible();
    await host.locator('summary').filter({hasText:'Form Attachments'}).click();
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        window.releaseSWMSRead = () => { FileReader.prototype.readAsDataURL = original; original.call(this,file); };
      };
    });
    await host.getByLabel('Add files',{exact:true}).setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64')});
    await expect(host.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    await expect(host.getByRole('button',{name:'Download PDF',exact:true})).toBeDisabled();
    assert.equal(await page.evaluate(()=>window.CeasefireSWMS.hasPendingOperation()),true);
    assert.equal(await page.evaluate(async()=>{try{await window.CeasefireSWMS.completeProjectSnapshot();return false;}catch{return true;}}),true);
    await page.evaluate(()=>window.releaseSWMSRead());
    await expect(host.getByText('pixel.png',{exact:true})).toBeVisible();
    await expect(host.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await host.getByLabel('Add files',{exact:true}).setInputFiles({name:'over-budget.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(9.5*1024*1024)});
    await expect(host.locator('.swms-message')).toContainText('12 MiB SWMS storage budget');
    await expect(host.getByText('over-budget.pdf',{exact:true})).toHaveCount(0);
    await expect(host.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await host.getByRole('button',{name:'Save',exact:true}).click();
    await expect(host.locator('.swms-message')).toContainText('Saved.');
    const saveResponse = page.waitForResponse(response=>/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
    await page.locator('#header-project-actions').getByRole('button',{name:'Save',exact:true}).click();
    assert.equal((await saveResponse).status(),200); await idle();
    const saved = JSON.parse(fs.readFileSync(info.project,'utf8'));
    assert.equal(saved.swms.documents[0].fields.work_types.length,3);
    assert.ok(saved.swms.documents[0].fields.manager_signature.strokes.length);
    assert.equal(saved.swms.documents[0].fields.attachments[0].name,'pixel.png');
    const downloadResponse = page.waitForResponse(response=>response.url().endsWith('/api/swms/issue') && response.request().method()==='POST');
    await host.getByRole('button',{name:'Download PDF',exact:true}).click();
    const response = await downloadResponse, result = await response.json();
    assert.equal(response.status(),200,JSON.stringify(result)); assert.equal(result.saved,true);
    assert.ok(result.path.startsWith(directory)); assert.equal(fs.readFileSync(result.path).subarray(0,5).toString(),'%PDF-');
    await expect(host.locator('.swms-message')).toContainText('SWMS PDF saved.'); await idle();
    assert.equal(await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.pendingIssue),null);
    // A confirmed export ends its retry receipt; a later company change must
    // generate a fresh export without reopening or editing this statement.
    const company = await (await page.request.get(`http://127.0.0.1:${info.port}/api/company-settings`)).json();
    const updatedCompany = await page.request.post(`http://127.0.0.1:${info.port}/api/company-settings`,{data:{...company,name:'UPDATED SWMS COMPANY'}});
    assert.equal(updatedCompany.status(),200,await updatedCompany.text());
    const secondResponse = page.waitForResponse(response=>response.url().endsWith('/api/swms/issue') && response.request().method()==='POST');
    await host.getByRole('button',{name:'Download PDF',exact:true}).click();
    const second = await secondResponse;
    assert.equal(second.status(),200,await second.text());
    await expect(host.locator('.swms-message')).toContainText('SWMS PDF saved.'); await idle();
    await page.evaluate(()=>{window.originalSWMSDownload=window.CeasefireDownloads.save;window.CeasefireDownloads.save=async()=>({cancelled:true});});
    await host.getByRole('button',{name:'Download PDF',exact:true}).click();
    await expect(host.locator('.swms-message')).toContainText('PDF download cancelled.');
    assert.ok(await page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.pendingIssue));
    await page.evaluate(()=>{window.CeasefireDownloads.save=window.originalSWMSDownload;});
    await host.getByRole('button',{name:'Back to statements',exact:true}).click();
    await host.getByRole('button',{name:'Open',exact:true}).click();
    await expect(host.getByRole('img',{name:'Project manager drawn signature'})).toBeVisible();
    await expect(host.locator('.swms-step-table tbody tr')).toHaveCount(45);
    await page.screenshot({path:path.join(directory,'swms-editor.png'),fullPage:false});
    // Raw user text is rendered through DOM text/value properties, never HTML.
    await host.getByLabel('Document title',{exact:true}).fill('<img src=x onerror=alert(1)>');
    await host.getByRole('button',{name:'Save',exact:true}).click(); await expect(host.locator('.swms-message')).toContainText('Saved.');
    await host.getByRole('button',{name:'Back to statements',exact:true}).click();
    await expect(host.getByRole('heading',{name:'<img src=x onerror=alert(1)>',exact:true})).toBeVisible();
    assert.equal(await host.locator('img').count(),0);
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    checks.push(`${edition}: Documentation entry, project defaults, 45 work steps, drawn signature, delayed attachment lock and encoded budget, save/reopen, portable project, real PDF download after company change, cleared successful export receipt and retained cancellation receipt, escaped text, no external location requests`);
  } catch(error) { fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'server.log'),logs);throw error; }
  finally { await browser?.close(); server.kill(); }
}
(async()=>{ await run('full'); await run('standard'); fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks},null,2)); console.log(JSON.stringify({checks,output})); })().catch(error=>{console.error(error);process.exitCode=1;});
