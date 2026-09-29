// Real rendered standard-edition acceptance. All files and state are synthetic.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `standard-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'standard_fixture.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], requests = [];
function choose(mode) { fs.writeFileSync(path.join(output, 'dialog-mode.json'), JSON.stringify(mode)); }
async function reply(action, suffix) {
  const pending = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const response = await pending; return { status: response.status(), body: await response.json() };
}
async function load(mode) {
  choose({ open: mode });
  const response = await reply(() => page.getByRole('button', {name:'Load', exact:true}).click(), '/api/project/open');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await page.getByRole('dialog').getByRole('button', {name:'Load Project', exact:true}).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
}
async function worksheetReady(title, label) {
  const options={timeout:45000};
  await expect(page.locator('#calculator-title')).toHaveText(title,options);
  if (label) await expect(page.locator('#calculator-sheet-title')).toHaveText(label,options);
  await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',options);
  await expect(page.locator('#calculator-grid')).toBeVisible(options);
  await expect(page.locator('#calculator-grid table').first()).toBeAttached(options);
  await expect(page.locator('#calculator-grid')).not.toContainText('Loading this worksheet…',options);
  await expect(page.locator('#calculator-calculation-status')).toBeHidden(options);
  assert.ok(!await page.locator('#calculator-message').evaluate(element => element.classList.contains('error') && !element.hidden));
}
(async () => {
  const info = await ready; browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => { window.qaCsp=[]; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({directive:event.effectiveDirective, blocked:event.blockedURI})); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await expect(page.locator('#project-tools')).toBeVisible();
  await expect(page.getByRole('button', {name:'TAKEOFFS', exact:true})).toHaveCount(0);
  assert.equal(await page.evaluate(() => typeof window.CeasefireTakeoffs), 'undefined');
  const bootstrap = await page.request.get(`http://127.0.0.1:${info.port}/api/bootstrap`);
  assert.equal((await bootstrap.json()).features.takeoffs, false);
  await load('legacy');
  const original = JSON.parse(fs.readFileSync(path.join(output,'legacy-v1.json')));
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByLabel('Project No.', {exact:true}).fill('STANDARD-SAVED');
  await page.getByLabel('Client', {exact:true}).fill('Offline Windows acceptance');
  choose({});
  const savedReply = await reply(() => page.getByRole('button', {name:'Save As',exact:true}).click(), '/api/project/save-as');
  assert.equal(savedReply.status,200,JSON.stringify(savedReply.body));
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(path.join(output,'standard-project.json')));
  assert.equal(saved.version,1); assert.equal('takeoffs' in saved,false);
  assert.deepEqual(saved.estimate.configuration,original.estimate.configuration);
  assert.deepEqual(saved.calculators,original.calculators);
  await load('saved');
  await expect(page.getByLabel('Project No.', {exact:true})).toHaveValue('STANDARD-SAVED');
  await expect(page.getByLabel('Client', {exact:true})).toHaveValue('Offline Windows acceptance');
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  await page.screenshot({path:path.join(output,'saved-legacy-project.png'),fullPage:true});
  const protectedBefore = fs.readFileSync(path.join(output,'protected-v2.json'));
  choose({open:'takeoffs'});
  const rejected = await reply(() => page.getByRole('button', {name:'Load',exact:true}).click(),'/api/project/open');
  assert.equal(rejected.status,400); assert.match(JSON.stringify(rejected.body), /TAKEOFFS/i);
  await expect(page.getByLabel('Project No.', {exact:true})).toHaveValue('STANDARD-SAVED');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  choose({save:'takeoffs'});
  const overwrite = await reply(() => page.getByRole('button', {name:'Save As',exact:true}).click(),'/api/project/save-as');
  assert.equal(overwrite.status,400); assert.match(JSON.stringify(overwrite.body), /TAKEOFFS/i);
  assert.deepEqual(fs.readFileSync(path.join(output,'protected-v2.json')),protectedBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'standard-project.json'))),saved);
  await page.getByRole('button',{name:'Calculators',exact:true}).click();
  await expect(page.getByRole('button',{name:'TAKEOFFS',exact:true})).toHaveCount(0);
  await page.screenshot({path:path.join(output,'standard-calculators.png'),fullPage:true});
  assert.ok(!requests.some(p => p.startsWith('/api/takeoffs/') || /takeoff|pdfjs/.test(p)));
  assert.deepEqual(errors,[]); assert.deepEqual(await page.evaluate(() => window.qaCsp),[]);
  // Hold cold browser responses to exercise rapid clicks without timing thresholds.
  await page.close();page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(45000);
  const navigationRequests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>navigationRequests.push(new URL(request.url()).pathname));
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',event=>window.qaCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  let releaseList,releaseDefinition;
  const listGate=new Promise(resolve=>{releaseList=resolve;}),definitionGate=new Promise(resolve=>{releaseDefinition=resolve;});
  await page.route('**/api/calculators',async route=>{await listGate;await route.continue();});
  await page.route('**/api/calculators/steel_vermiculite',async route=>{await definitionGate;await route.continue();});
  await page.goto(`http://127.0.0.1:${info.port}/`);await expect(page.locator('#project-tools')).toBeVisible();
  const calculatorsButton=page.getByRole('button',{name:'Calculators',exact:true});
  await calculatorsButton.click();await calculatorsButton.click();
  const count=pathname=>navigationRequests.filter(value=>value===pathname).length;
  await expect.poll(()=>count('/api/calculators')).toBe(1);releaseList();
  await expect.poll(()=>count('/api/calculators/steel_vermiculite')).toBe(1);
  await calculatorsButton.click();releaseDefinition();
  await worksheetReady('Steel (spray)','START');
  assert.equal(count('/api/calculators'),1);assert.equal(count('/api/calculators/steel_vermiculite'),1);assert.equal(count('/api/calculators/steel_vermiculite/worksheet'),1);
  await page.unroute('**/api/calculators');await page.unroute('**/api/calculators/steel_vermiculite');
  const destinations=['Steel (spray)','Ductwork (spray/wrap)','Steel (board)'],lastPages=[];
  for(const title of destinations){
    await page.locator('#calculator-list button').filter({has:page.locator('strong',{hasText:title})}).click();await worksheetReady(title);
    const pages=page.locator('#calculator-pages button'),label=await pages.nth(1).textContent();
    await pages.nth(1).click();await worksheetReady(title,label);lastPages.push(label);
  }
  const snapshot=await page.evaluate(()=>window.CeasefireCalculators.projectSnapshot()),beforeRevisit=navigationRequests.filter(value=>value.endsWith('/worksheet')).length;
  for(const [index,title] of destinations.entries()){
    await page.locator('#calculator-list button').filter({has:page.locator('strong',{hasText:title})}).click();await worksheetReady(title,lastPages[index]);
  }
  assert.equal(navigationRequests.filter(value=>value.endsWith('/worksheet')).length,beforeRevisit);
  assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.projectSnapshot()),snapshot);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);
  await page.screenshot({path:path.join(output,'calculator-navigation.png'),fullPage:true});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,edition:'standard',legacyRoundtrip:true,frozenPricingPreserved:true,calculatorSnapshotsPreserved:true,takeoffLoadRejected:true,takeoffOverwriteRejected:true,coldRequestsCoalesced:true,warmNavigationWithoutRequests:true,navigationRequests,errors,csp:[],requests},null,2));
  console.log(`PASS: standard edition preserves saved data, rejects incompatible projects, coalesces cold calculator requests and reuses rendered worksheets without requests. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); process.exitCode=1;
}).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
