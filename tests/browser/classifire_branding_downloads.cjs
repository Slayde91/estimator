// Real company-logo deletion/default fallback and download receipts on a disposable app.
const {chromium, expect} = require('@playwright/test');
const {chooseCalculator} = require('./calculator_actions.cjs');
const {clickProjectControl} = require('./project_actions.cjs');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `classifire-branding-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], {cwd:root, windowsHide:true});
let logs='', browser, page;
server.stderr.on('data', chunk=>logs+=chunk);
const ready = new Promise((resolve,reject)=>{
  let text=''; const timer=setTimeout(()=>reject(Error(logs || 'Fixture timeout')),120000);
  server.stdout.on('data', chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});
  server.once('error', reject); server.once('exit', code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});
});
const evidence={}, errors=[];
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function reply(action, suffix){const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(suffix));await action();const result=await pending;assert.equal(result.status(),200);return result.json();}
(async()=>{
  const fixture=await ready;assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(45000);
  page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.downloadProgressEvidence=[];window.brandingCsp=[];
    document.addEventListener('securitypolicyviolation', e=>window.brandingCsp.push(e.effectiveDirective));
    document.addEventListener('DOMContentLoaded',()=>new MutationObserver(records=>{
      for(const record of records){
        for(const node of record.addedNodes){if(node.nodeType===1){const bars=node.matches('progress')?[node]:[...node.querySelectorAll('progress')];for(const bar of bars)window.downloadProgressEvidence.push(bar.value);}}
        if(record.type==='attributes'&&record.target.tagName==='PROGRESS')window.downloadProgressEvidence.push(record.target.value);
      }
    }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['value']}));
  });
  await page.goto(`http://127.0.0.1:${fixture.port}/`,{waitUntil:'networkidle'});await idle();
  await expect(page.locator('.brand-logo')).toHaveAttribute('src','/classifire-logo.png');
  const served=await page.request.get(`http://127.0.0.1:${fixture.port}/classifire-logo.png`);
  assert.equal(crypto.createHash('sha256').update(await served.body()).digest('hex'),'a91d44ba45c0f96a589c577800d9e4cc292efaa1f8a9cdab7be18aaebc0d32da');
  await expect(page.locator('footer')).toContainText('CLASSIFIRE');
  await expect(page.locator('footer')).toContainText('This estimating product has been developed by CLASSIFIRE. All information and results are indicative and provided for guidance only. Before relying on any output, confirm its suitability with the relevant manufacturer and project authority.');
  await expect(page.locator('.eyebrow').filter({hasText:/REFERENCE LIBRARY|INVENTORY & RATES|CEASEFIRE ESTIMATOR/})).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.locator('#company-settings-save')).toBeEnabled();
  await expect(page.locator('#company-logo-reset')).toHaveCount(0);
  await page.locator('#company-logo').setInputFiles(path.join(root,'static/icons/takeoff-set-default.png'));
  await expect(page.locator('#company-settings-save')).toBeEnabled();
  const custom=await reply(()=>page.locator('#company-settings-save').click(),'/api/company-settings');assert.ok(custom.logo.startsWith('data:image/png;base64,'));
  await page.getByRole('button',{name:'Delete company logo',exact:true}).click();
  await expect(page.locator('#company-logo-preview')).toBeHidden();
  const cleared=await reply(()=>page.locator('#company-settings-save').click(),'/api/company-settings');assert.equal(cleared.logo,null);
  await expect(page.locator('#company-logo-preview')).toBeVisible();await expect(page.locator('#company-logo-preview')).toHaveAttribute('src','/classifire-logo.png');
  await page.screenshot({path:path.join(output,'company-logo-fallback.png')});evidence.companyLogoDeletionAndDefaultFallback=true;
  await page.getByRole('button',{name:'Estimates',exact:true}).hover();await page.getByRole('group',{name:'Choose an estimate',exact:true}).getByRole('button',{name:'Estimate',exact:true}).click();await idle();
  await reply(()=>clickProjectControl(page,'Save'),'/api/project/save-as');await expect(page.locator('#app-message')).toBeVisible();
  const notice=await page.locator('#app-message').textContent();assert.match(notice,/Project saved/);
  await expect(page.locator('#app-message')).toBeHidden({timeout:6500});await expect(page.locator('#project-save-state')).toHaveText('Saved project');evidence.appStatusExpiresWithoutLosingSavedState=true;
  await chooseCalculator(page,'Steel (board)');await idle();
  let release;const held=new Promise(resolve=>release=resolve);
  await page.route('**/api/calculators/steel_board/template',async route=>{await held;await route.continue();});
  await page.locator('#calculator-document-toggle').click();
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/calculators/steel_board/template');
  await page.locator('#calculator-template').click();
  await expect(page.locator('.document-download-progress progress')).toBeVisible();
  const bar=await page.locator('.document-download-progress progress').evaluate(el=>({value:el.value,accent:getComputedStyle(el).accentColor,host:el.parentElement.parentElement.className}));
  assert.equal(bar.value,0);assert.equal(bar.accent,'rgb(24, 134, 76)');
  await page.screenshot({path:path.join(output,'document-progress-preparing.png')});release();
  const saved=await (await pending).json();assert.equal(saved.saved,true);assert.equal(saved.destination,'project');
  assert.ok(path.relative(output,saved.path)&&!path.relative(output,saved.path).startsWith('..'));assert.equal(fs.readFileSync(saved.path).subarray(0,2).toString(),'PK');
  await expect(page.locator('.document-download-progress')).toHaveCount(0);await idle();
  const progress=await page.evaluate(()=>window.downloadProgressEvidence);assert.ok(progress.includes(100));evidence.confirmedDownload={file:path.basename(saved.path),progress,bar};
  await page.unroute('**/api/calculators/steel_board/template');
  await page.route('**/api/calculators/steel_board/template',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Fixture rejected file preparation.'})}));
  const count=progress.filter(value=>value===100).length;
  await page.locator('#calculator-document-toggle').click();await page.locator('#calculator-template').click();
  await expect(page.locator('#calculator-message')).toHaveText('Could not export the template. Fixture rejected file preparation.');await expect(page.locator('#calculator-message')).toHaveAttribute('role','alert');
  await expect(page.locator('.document-download-progress')).toHaveCount(0);
  assert.equal((await page.evaluate(()=>window.downloadProgressEvidence)).filter(value=>value===100).length,count);evidence.failedDownloadNeverReports100=true;
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.brandingCsp),[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence},null,2));console.log('PASS CLASSIFIRE branding and download progress: '+output);
})().catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
