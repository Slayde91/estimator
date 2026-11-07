// Real first-save numbering and client history, using disposable native targets.
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {clickProjectControl}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`project-details-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const python=process.env.CEASEFIRE_PYTHON||'python';
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',v=>{data+=v;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[];
async function idle(){await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});}
async function estimate(){await page.locator('#estimate-navigation-toggle').click();await page.locator('#estimate-navigation-toggle').press('Escape');await idle();}
async function save(){const reply=page.waitForResponse(r=>/\/api\/project\/save(?:-as)?$/.test(new URL(r.url()).pathname));await clickProjectControl(page,'Save');const response=await reply;assert.equal(response.status(),200,await response.text());await idle();return response.json();}
async function settings(prefix,start){await page.locator('nav [data-view="settings"]').click();await expect(page.locator('#project-number-prefix')).toBeEnabled();await page.locator('#project-number-prefix').fill(prefix);await page.locator('#project-start-number').fill(String(start));const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/project-details');await page.locator('#project-details-settings-save').click();assert.equal((await response).status(),200);await idle();}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);const base=`http://127.0.0.1:${info.port}`;
 const seed=spawnSync(python,['-c',`import sys\nfrom pathlib import Path\nfrom estimator.storage import Store\nfrom estimator.project_file import export_project\np=Path(sys.argv[1]);s=Store(p/'qa.sqlite3')\nfor name,number,client in [('legacy','PN-00006','Alpha <literal>'),('other','OLD-12','Beta')]:\n (p/(name+'.cf.json')).write_bytes(export_project(s,{'estimate':{'project_no':number,'client':client}}))`,output],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);
 assert.equal((await fetch(base+'/api/projects/link-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/');await idle();await estimate();
 await expect(page.locator('#project-no')).toHaveAttribute('readonly','');await expect(page.locator('#project-no')).toHaveValue('');
 await expect(page.locator('#client')).toHaveAttribute('list','previous-project-clients');await expect(page.locator('#previous-project-clients option')).toHaveCount(2);
 assert.deepEqual(await page.locator('#previous-project-clients option').evaluateAll(nodes=>nodes.map(node=>node.value)),['Alpha <literal>','Beta']);
 await settings('PN',1);await expect(page.locator('#project-number-next')).toContainText('PN-00007');
 await estimate();await page.locator('#client').fill('New free-input client');await page.locator('#site-address').fill('10 Synthetic Street');await page.locator('#site-address').blur();await idle();
 const first=await save();assert.equal(first.project.estimate.project_no,'PN-00007');await expect(page.locator('#project-no')).toHaveValue('PN-00007');
 assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.project_no,'PN-00007');await expect(page.locator('#previous-project-clients option')).toHaveCount(3);
 await settings('PK',42);await expect(page.locator('#project-number-next')).toContainText('PK-00042');await estimate();await expect(page.locator('#project-no')).toHaveValue('PN-00007');
 await page.locator('#measurements').fill('An existing project retains its number');await page.locator('#measurements').blur();await idle();assert.equal((await save()).project.estimate.project_no,'PN-00007');
 await clickProjectControl(page,'New');const discard=page.locator('#discard-dialog');if(await discard.isVisible())await discard.getByRole('button',{name:'Continue without saving',exact:true}).click();await idle();await estimate();await expect(page.locator('#project-no')).toHaveValue('');
 fs.renameSync(info.project,path.join(output,'first-saved-project.cf.json'));
 await page.locator('#client').fill('Beta');await page.locator('#client').blur();await idle();const second=await save();assert.equal(second.project.estimate.project_no,'PK-00042');await expect(page.locator('#project-no')).toHaveValue('PK-00042');
 await settings('PK',1);await expect(page.locator('#project-number-next')).toContainText('PK-00043');
 const series=page.locator('#document-number-settings');
 await expect(series.locator('tbody tr')).toHaveCount(5);
 await series.getByLabel('Work Orders prefix',{exact:true}).fill('Job');
 await series.getByLabel('Work Orders starting number',{exact:true}).fill('31');
 await series.getByRole('button',{name:'Save document numbering'}).click();
 await expect(series.locator('tr').filter({hasText:'Work Orders'})).toContainText('JOB-31');
 await expect(series.locator('tr').filter({hasText:'Purchase Orders'})).toContainText('PO-01');
 await estimate();await page.locator('nav [data-view="settings"]').click();
 await expect(series.getByLabel('Work Orders prefix',{exact:true})).toHaveValue('JOB');
 await page.screenshot({path:path.join(output,'project-number-settings.png'),fullPage:true});assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,first:first.project.estimate.project_no,second:second.project.estimate.project_no,errors},null,2));console.log(`PASS project details: ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),String(error.stack));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
