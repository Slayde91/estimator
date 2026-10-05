// Project navigation, native file picking and real attachment writes use only
// a disposable production server and its synthetic project folder.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `project-controls-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const assets = ['static/app.js','static/index.html','static/styles.css'];
const assetHashes = Object.fromEntries(assets.map(name => [name,sha256(fs.readFileSync(path.join(root,name)))]));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], { cwd:root, windowsHide:true });
let logs = '', browser, page, info;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve,reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)),120000);
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error',error => { clearTimeout(timer); reject(error); });
  server.once('exit',code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
async function idle() { await page.waitForFunction(() => { const state = window.CeasefireDesktop?.status(); return state?.ready && !state.busy; }); }
async function enter(name) {
  await page.getByRole('button',{name,exact:true}).click();
  await expect(page.locator(`.nav-button[data-view="${name === 'Projects' ? 'quotes' : {Home:'home',Estimates:'estimate',Calculators:'calculators',Takeoffs:'takeoffs',Libraries:'pricing',Help:'help'}[name]}"]`)).toHaveAttribute('aria-current','page');
}
async function snapshot() {
  return page.evaluate(() => ({
    details:window.CeasefireProject.details(), pricing:window.CeasefireProject.configuration(),
    calculators:window.CeasefireCalculators.projectSnapshot(), penetration:window.CeasefirePenetrations.projectSnapshot(),
    takeoffs:window.CeasefireTakeoffs.projectSnapshot(), dirty:window.CeasefireDesktop.status().dirty,
    saved:document.getElementById('project-save-state').textContent,
  }));
}
async function upload(action) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project/attachment'); pending.catch(() => {});
  await action(); const response = await pending, result = await response.json();
  assert.equal(response.status(),200,JSON.stringify(result)); await idle(); return result;
}
async function drop(name,content,eventName = 'drop') {
  const transfer = await page.evaluateHandle(({name,content}) => {
    const data = new DataTransfer(); data.items.add(new File([content],name,{type:'text/plain'})); return data;
  },{name,content});
  try { await page.locator('#project-attachment-zone').dispatchEvent(eventName,{dataTransfer:transfer}); }
  finally { await transfer.dispose(); }
}

(async () => {
  info = await ready; assert.notEqual(info.port,8765);
  browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1}); page.setDefaultTimeout(45000);
  page.on('pageerror',error => errors.push(error.message));
  page.on('request',request => { if (new URL(request.url()).pathname === '/api/project/attachment') requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation',event => window.qaCsp.push({directive:event.effectiveDirective,blocked:event.blockedURI})); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`);
  assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline')); await idle();
  for (const asset of assets) {
    const served = await page.request.get(`http://127.0.0.1:${info.port}/${asset === 'static/index.html' ? '' : path.basename(asset)}`);
    assert.equal(served.status(),200); assert.equal(sha256(await served.body()),assetHashes[asset]);
  }
  const tools = page.locator('#project-tools'), button = page.getByRole('button',{name:'Project files',exact:true});
  const description = page.locator('#project-attachment-status');
  await expect(tools).toBeHidden(); await expect(button).toBeVisible();
  evidence.navigation = [];
  for (const width of [1600,764,390]) {
    await page.setViewportSize({width,height:1000});
    for (const name of ['Projects','Home','Estimates','Calculators','Takeoffs','Libraries','Help']) {
      await enter(name); await idle();
      if (name === 'Projects') {
        await expect(tools).toBeVisible(); await expect(button).toBeVisible();
        await expect(button).toHaveAccessibleName('Project files'); await expect(button).toHaveAccessibleDescription('Files save beside the current project.');
        const geometry = await button.evaluate(element => {
          const button = element.getBoundingClientRect(), svg = element.querySelector('svg').getBoundingClientRect(), status = document.getElementById('project-attachment-status');
          return {width:button.width,height:button.height,text:element.textContent.trim(),svgWidth:svg.width,svgHeight:svg.height,slotWidth:element.parentElement.getBoundingClientRect().width,statusClip:getComputedStyle(status).clip,statusWidth:status.getBoundingClientRect().width,buttonRight:button.right,viewport:innerWidth,pageWidth:document.documentElement.scrollWidth};
        });
        assert.equal(geometry.width,width <= 570 ? 44 : 48); assert.equal(geometry.height,width <= 570 ? 44 : 48); assert.equal(geometry.text,'');
        assert.equal(geometry.svgWidth,24); assert.equal(geometry.svgHeight,24); assert.equal(geometry.statusWidth,1);
        assert.equal(geometry.statusClip,'rect(0px, 0px, 0px, 0px)');
        assert.ok(geometry.buttonRight <= width); assert.ok(geometry.pageWidth <= width);
        if (width > 760) assert.equal(geometry.slotWidth,48,'The icon has no leftover dropzone column width');
        await page.screenshot({path:path.join(output,`projects-${width}.png`),fullPage:true});
        evidence.navigation.push({width,name,visible:true,geometry});
      } else {
        await expect(tools).toBeHidden(); await expect(button).toBeVisible();
        for (const name of ['New','Load','Save','Save As']) await expect(tools.getByRole('button',{name,exact:true})).toHaveCount(0);
        evidence.navigation.push({width,name,visible:false});
      }
    }
  }
  await page.setViewportSize({width:1440,height:1000}); await enter('Projects'); await idle();
  let choosers = 0; page.on('filechooser',() => { choosers++; });
  const beforeUnsaved = await snapshot();
  await button.click(); await expect(page.getByRole('alert')).toContainText('There is no saved project.');
  assert.equal(choosers,0); assert.equal(requests.length,0);
  await drop('unsaved.txt','Must not be written');
  await expect(description).toContainText('Please click "Save"'); assert.equal(requests.length,0);
  assert.deepEqual(await snapshot(),beforeUnsaved); assert.equal(fs.existsSync(path.join(output,'unsaved.txt')),false);
  evidence.unsaved = {pickerBlocked:true,dropBlocked:true,noRequests:true,draftsPreserved:true};

  await enter('Estimates'); await page.getByLabel('Client',{exact:true}).fill('Disposable project controls client');
  await page.getByLabel('Client',{exact:true}).press('Tab'); await enter('Projects'); await idle();
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project/save-as'); saving.catch(() => {});
  await page.locator('#header-project-actions').getByRole('button',{name:'Save',exact:true}).click();
  const savedReply = await saving; assert.equal(savedReply.status(),200,await savedReply.text()); await idle();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const projectBytes = fs.readFileSync(info.project), beforeFiles = await snapshot(); assert.equal(beforeFiles.dirty,false);
  const chosenContent = 'SYNTHETIC NATIVE PICKER FILE\n';
  const picked = await upload(async () => {
    const chooser = page.waitForEvent('filechooser'); await button.click();
    await (await chooser).setFiles({name:'picked.txt',mimeType:'text/plain',buffer:Buffer.from(chosenContent)});
  });
  assert.equal(choosers,1); assert.equal(picked.filename,'picked.txt');
  assert.equal(fs.readFileSync(path.join(output,'picked.txt'),'utf8'),chosenContent);
  await expect(button).toHaveAccessibleDescription(/1 file saved.*picked\.txt/);
  const droppedContent = 'SYNTHETIC DATA TRANSFER FILE\n';
  await drop('picked.txt',droppedContent,'dragenter'); await expect(button).toHaveClass(/is-dragover/);
  const dropped = await upload(() => drop('picked.txt',droppedContent));
  assert.equal(dropped.filename,'picked (1).txt'); await expect(button).not.toHaveClass(/is-dragover/);
  assert.equal(fs.readFileSync(path.join(output,'picked.txt'),'utf8'),chosenContent);
  assert.equal(fs.readFileSync(path.join(output,'picked (1).txt'),'utf8'),droppedContent);
  assert.deepEqual(await snapshot(),beforeFiles); assert.deepEqual(fs.readFileSync(info.project),projectBytes);
  evidence.uploads = {nativePicker:true,nativeInputMultiple:await page.locator('#project-attachment-input').evaluate(element => element.multiple),drop:true,collisionPreserved:true,files:[picked.filename,dropped.filename],projectUnchanged:true,draftsAndPricingPreserved:true,dirty:false};

  const entered = deferred(), release = deferred();
  await page.route('**/api/project/attachment',async route => { entered.resolve(); await release.promise; const response = await route.fetch(); await route.fulfill({response}); });
  const heldUpload = upload(() => drop('held.txt','SYNTHETIC HELD FILE\n')); heldUpload.catch(() => {}); await entered.promise;
  await expect(button).toBeDisabled(); await expect(button).toHaveAttribute('aria-busy','true');
  await expect(page.locator('#project-attachment-input')).toBeDisabled();
  await expect(description).toHaveText('Saving 1 of 1: held.txt');
  const heldCount = requests.length; await drop('ignored.txt','Must not be written','dragover'); await expect(button).not.toHaveClass(/is-dragover/);
  await drop('ignored.txt','Must not be written'); assert.equal(requests.length,heldCount);
  await enter('Home'); await expect(tools).toBeHidden(); release.resolve(); const held = await heldUpload;
  await page.unroute('**/api/project/attachment');
  assert.equal(held.filename,'held.txt'); assert.equal(fs.existsSync(path.join(output,'ignored.txt')),false);
  await expect(page.locator('#app-message')).toBeVisible(); await expect(page.locator('#app-message')).toContainText('1 file saved');
  assert.deepEqual(await snapshot(),beforeFiles); assert.deepEqual(fs.readFileSync(info.project),projectBytes);
  evidence.busy = {progressAnnounced:true,disabledPickerAndInput:true,secondDropIgnored:true,completionVisibleOutsideProjects:true,draftsPreserved:true};

  await enter('Projects'); await idle();
  const rejected = deferred(), rejectNow = deferred();
  await page.route('**/api/project/attachment',async route => { rejected.resolve(); await rejectNow.promise; await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic fixture folder is read only.'})}); });
  await drop('rejected.txt','Must not be written'); await rejected.promise;
  await enter('Home'); rejectNow.resolve(); await expect(page.getByRole('alert')).toHaveText('Project files were not saved. Synthetic fixture folder is read only.');
  await idle(); await page.unroute('**/api/project/attachment'); await expect(tools).toBeHidden();
  await enter('Projects'); await idle(); await expect(button).toBeEnabled();
  await expect(button).toHaveAccessibleDescription('Project files were not saved. Synthetic fixture folder is read only.');
  assert.equal(fs.existsSync(path.join(output,'rejected.txt')),false); assert.deepEqual(await snapshot(),beforeFiles);
  assert.deepEqual(fs.readFileSync(info.project),projectBytes);
  evidence.error = {visibleAlertOutsideProjects:true,statusDescriptionRetained:true,retryEnabled:true,noFileWritten:true,draftsPreserved:true};
  await page.screenshot({path:path.join(output,'upload-error-projects.png'),fullPage:true});
  assert.ok(requests.every(request => Object.keys(request).sort().join(',') === 'content_base64,filename,project_token' && typeof request.project_token === 'string' && request.project_token.length > 0));
  assert.deepEqual(errors,[]); assert.deepEqual(await page.evaluate(() => window.qaCsp),[]);
  for (const asset of assets) assert.equal(sha256(fs.readFileSync(path.join(root,asset))),assetHashes[asset],'Source assets stayed fixed for the complete browser journey');
  const result = {passed:true,port:info.port,disposable:true,assetHashes,checks:evidence,consoleErrors:errors,cspViolations:[],limits:['Synthetic fixture folder only; no live application or existing project touched.','Failure response is controlled to verify error accessibility; successful uploads use the real production endpoint.']};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify({passed:true,output,port:info.port}));
})().catch(async error => {
  console.error(error); fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);
  if (page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(() => {}); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); });
