// Full-logo startup and error recovery on one disposable random-port server.
const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = process.env.CEASEFIRE_BROWSER_OUTPUT || path.join(root, '.runtime/browser-qa', `brand-boot-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalLogo = hash(path.join(root, 'static/classifire-logo.png'));
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs = '', browser, activePage;
server.stderr.on('data', value => logs += value);
const started = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error(logs || 'Fixture startup timed out')), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const evidence = {}, errors = [];
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
async function page() {
  const value = await browser.newPage({viewport:{width:1280,height:900}}); value.setDefaultTimeout(45000); activePage = value;
  value.on('pageerror', error => errors.push(error.message));
  await value.addInitScript(() => {
    window.bootNativeMessages = []; window.bootCsp = [];
    window.chrome ||= {}; window.chrome.webview = {postMessage:value => window.bootNativeMessages.push(value)};
    document.addEventListener('securitypolicyviolation', event => window.bootCsp.push(event.effectiveDirective));
  });
  return value;
}
async function ready(value) {
  await value.waitForFunction(() => window.ClassifireBoot?.state === 'ready');
  await expect(value.locator('#classifire-boot')).toBeHidden();
  await expect(value.locator('#view-home')).toBeVisible();
  assert.deepEqual(await value.evaluate(() => window.bootNativeMessages), [{type:'classifire.boot',state:'ready'}]);
  assert.deepEqual(await value.evaluate(() => window.bootCsp), []);
}
(async () => {
  const fixture = await started; assert.notEqual(fixture.port, 8765); evidence.port = fixture.port;
  const origin = `http://127.0.0.1:${fixture.port}`;
  browser = await chromium.launch({headless:true});
  {
    const value = await page(), entered = deferred(), release = deferred();
    await value.route('**/api/bootstrap', async route => { entered.resolve(); await release.promise; await route.continue(); });
    await value.goto(origin, {waitUntil:'domcontentloaded'}); await entered.promise;
    await expect(value).toHaveTitle('CLASSIFIRE | Passive Fire Intelligence');
    await expect(value.locator('#classifire-boot img')).toBeVisible();
    await expect(value.locator('.app-header')).toBeHidden();
    assert.equal(await value.evaluate(() => window.CeasefireDesktop.status().ready), false);
    for (const width of [1280,390]) {
      await value.setViewportSize({width,height:900});
      const layout = await value.locator('#classifire-boot img').evaluate(image => {
        const rectangle = image.getBoundingClientRect();
        return {width:rectangle.width,height:rectangle.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,
          background:getComputedStyle(image).backgroundColor,hostBackground:getComputedStyle(image.parentElement).backgroundColor,
          canvasBackground:getComputedStyle(document.body).backgroundColor,
          left:rectangle.left,right:rectangle.right,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth};
      });
      assert.equal(layout.naturalWidth,2172); assert.equal(layout.naturalHeight,724);
      assert.equal(layout.background,'rgba(0, 0, 0, 0)'); assert.equal(layout.hostBackground,'rgba(0, 0, 0, 0)');
      assert.equal(layout.canvasBackground,'rgb(255, 255, 255)');
      assert.ok(Math.abs(layout.width/layout.height-3)<.01); assert.ok(layout.left>=0&&layout.right<=width&&layout.documentWidth<=width+1);
      evidence[`pending${width}`] = layout;
      await value.screenshot({path:path.join(output,`full-logo-loading-${width}.png`)});
    }
    assert.deepEqual(await value.evaluate(() => window.bootNativeMessages), []);
    release.resolve(); await ready(value);
    // Later activity or a repeated signal cannot restore startup artwork.
    await value.evaluate(() => { const end=window.CeasefireActivity.begin(); window.ClassifireBoot.ready(); window.ClassifireBoot.failed(); end(); });
    await ready(value);
    const icon = await value.request.get(origin+'/classifire-app.ico'); assert.equal(icon.status(),200);
    assert.equal(createHash('sha256').update(await icon.body()).digest('hex'),hash(path.join(root,'static/classifire-app.ico')));
    await value.screenshot({path:path.join(output,'ready-home.png')}); await value.close();
    evidence.bootstrapGate = {realBootstrapHeld:true,logoUntilFinalReady:true,oneNativeNotification:true,servedIconMatches:true};
  }
  {
    const value = await page(), entered = deferred(), release = deferred();
    await value.route('**/fonts/Montserrat-Variable.ttf', async route => { entered.resolve(); await release.promise; await route.continue(); });
    await value.goto(origin,{waitUntil:'domcontentloaded'}); await entered.promise;
    await value.waitForFunction(() => window.CeasefireDesktop?.status().ready === true);
    assert.equal(await value.evaluate(() => window.ClassifireBoot.state),'pending');
    await expect(value.locator('#classifire-boot img')).toBeVisible();
    assert.deepEqual(await value.evaluate(() => window.bootNativeMessages), []);
    release.resolve(); await ready(value); await value.close();
    evidence.fontGate = {bootstrapReadyBeforeFonts:true,logoKeptUntilFontsReady:true};
  }
  {
    const value = await page();
    await value.route('**/api/bootstrap', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Disposable bootstrap failure'})}));
    await value.goto(origin,{waitUntil:'load'});
    await value.waitForFunction(() => window.ClassifireBoot?.state === 'error');
    await expect(value.locator('#classifire-boot')).toBeHidden();
    await expect(value.locator('#loading-state')).toBeVisible();
    await expect(value.locator('#loading-state')).toHaveText('The estimator could not be loaded. Reload after the local server is available.');
    assert.equal(await value.evaluate(() => window.CeasefireDesktop.status().ready),false);
    assert.deepEqual(await value.evaluate(() => window.bootNativeMessages),[{type:'classifire.boot',state:'error'}]);
    assert.deepEqual(await value.evaluate(() => window.bootCsp),[]);
    await value.screenshot({path:path.join(output,'recoverable-bootstrap-error.png')}); await value.close();
    evidence.failure = {nativeArtworkReleased:true,recoveryMessageVisible:true,falseReadyPrevented:true};
  }
  assert.deepEqual(errors,[]); assert.equal(hash(path.join(root,'static/classifire-logo.png')),originalLogo);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors,originalLogo},null,2));
  console.log('PASS full CLASSIFIRE boot logo, title, icon and recoverable failure: '+output);
})().catch(async error => {
  console.error(error); if(activePage&&!activePage.isClosed()) await activePage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),evidence,errors},null,2)); process.exitCode=1;
}).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
