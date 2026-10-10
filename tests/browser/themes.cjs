// Presentation-only acceptance against a disposable server, never port 8765.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { chooseTakeoff } = require('./section_navigation.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `themes-${Date.now()}`);
fs.mkdirSync(output, { recursive:true });
const assets = ['tests/browser/themes.cjs','static/theme.js','static/theme.css','static/index.html','static/app.js','static/calculators.js','static/ceasefire-logo.png'];
const hashes = () => Object.fromEntries(assets.map(name => [name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const assetHashes = hashes();
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname,'fixtures.py'),'--directory',output], { cwd:root, windowsHide:true });
let logs='', browser, page, serverExit=null;
server.once('exit',(code,signal) => { serverExit={code,signal}; });
server.stderr.on('data', value => { logs+=value; });
const ready = new Promise((resolve,reject) => {
  let text=''; const timer=setTimeout(() => reject(Error(`Fixture startup timeout: ${logs}`)),120000);
  server.stdout.on('data', value => { text+=value; if(text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch(error) { reject(error); } } });
  server.once('error',reject); server.once('exit',code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors=[], networkFailures=[], evidence={ themes:[], layouts:[], keyboard:false, persistence:false, deniedStorage:false, calculator:false, drawings:false }, mutationRequests=[];
async function idle() { await page.waitForFunction(() => { const s=window.CeasefireDesktop?.status(); return s?.ready&&!s.busy; }); }
async function snapshot() {
  return page.evaluate(() => ({ calculators:window.CeasefireCalculators.projectSnapshot(), penetration:window.CeasefirePenetrations.projectSnapshot(), pricing:window.CeasefireProject.configuration(), takeoffs:window.CeasefireTakeoffs.projectSnapshot(), dirty:window.CeasefireDesktop.status().dirty,
    inputs:[...document.querySelectorAll('#view-estimate input,#view-estimate textarea,#view-estimate select')].map(el => [el.id,el.value,el.selectionStart,el.selectionEnd]) }));
}
function watch(target) { target.on('pageerror',e => errors.push({message:e.message})); target.on('console',m => { if(m.type()==='error') errors.push({message:m.text(),location:m.location()}); }); target.on('requestfailed',r => networkFailures.push({url:r.url(),failure:r.failure()})); target.on('request',r => { if(!['GET','HEAD'].includes(r.method())) mutationRequests.push({ method:r.method(),url:r.url() }); }); }
async function theme(id) { for(let i=0;i<5 && await page.locator('html').getAttribute('data-theme')!==id;i++) await page.locator('#theme-toggle').click(); await expect(page.locator('html')).toHaveAttribute('data-theme',id); }
function luminance(rgb) { const c=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4); return .2126*c[0]+.7152*c[1]+.0722*c[2]; }
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
async function colors(selector) { return page.locator(selector).first().evaluate(el => { const s=getComputedStyle(el); return { color:s.color,background:s.backgroundColor,border:s.borderColor }; }); }
(async () => {
  const fixture=await ready; assert.notEqual(fixture.port,8765);
  browser=await chromium.launch({ headless:true });
  const context=await browser.newContext({ viewport:{ width:1146,height:1000 }, reducedMotion:'reduce' });
  await context.addInitScript(() => { window.themeCsp=[]; document.addEventListener('securitypolicyviolation',e => window.themeCsp.push(e.effectiveDirective)); });
  page=await context.newPage(); watch(page);
  await page.goto(`http://127.0.0.1:${fixture.port}`,{waitUntil:'networkidle'}); await idle();
  await expect(page.locator('#theme-toggle')).toHaveAccessibleName('Theme: Ceasefire. Next theme: Midnight.');
  await page.getByRole('button',{name:'Estimates',exact:true}).click(); await idle();
  await expect(page.locator('#project-no')).toBeVisible();
  await page.locator('#project-no').fill('THEME-DRAFT-UNCHANGED'); await page.locator('#measurements').fill('Pending notes are preserved across every theme.');
  await page.locator('#measurements').press('Tab'); await idle(); await page.waitForLoadState('networkidle');
  const before=await snapshot(), requestCount=mutationRequests.length, buttonColors=new Set();
  for(const id of ['ceasefire','midnight','ocean','forest','slate']) {
    await theme(id); const button=await colors('#theme-toggle'), card=await colors('#view-estimate .card'), input=await colors('#project-no'), text=await colors('#view-estimate .card .helper');
    assert.ok(contrast(button.color,button.background)>=4.5,id+' button contrast'); assert.ok(contrast(card.color,card.background)>=4.5,id+' card contrast'); assert.ok(contrast(input.color,input.background)>=4.5,id+' input contrast'); assert.ok(contrast(text.color,card.background)>=4.5,id+' helper contrast'); buttonColors.add(button.background);
    if(id!=='ceasefire') assert.ok(contrast(input.border,input.background)>=3,id+' input boundary');
    for(const width of [1146,752,720]) {
      await page.setViewportSize({width,height:1000});
      const geometry=await page.evaluate(() => { const box=s => { const r=document.querySelector(s).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; }; return {header:box('.app-header'),nav:box('.app-header nav'),tools:box('.header-tools'),theme:box('#theme-toggle'),overflow:document.documentElement.scrollWidth-innerWidth}; });
      assert.ok(geometry.overflow<=1,`${id}/${width} page overflow`); assert.ok(geometry.nav.right<=geometry.tools.x+1,`${id}/${width} header collision`); assert.ok(geometry.theme.width>=40&&geometry.theme.height>=40); assert.ok(geometry.theme.right<=width&&geometry.theme.bottom<=geometry.header.bottom);
      const screenshot=path.join(output,`${id}-${width}.png`); await page.screenshot({path:screenshot}); evidence.layouts.push({id,width,geometry,screenshot});
    }
    evidence.themes.push({id,button,card,input,helper:text});
    assert.deepEqual(await snapshot(),before,id+' must preserve draft/project/calculator snapshots');
  }
  assert.equal(buttonColors.size,5); assert.equal(mutationRequests.length,requestCount,'Theme changes must not send mutation requests');
  await theme('midnight'); await page.emulateMedia({media:'print'}); const print=await colors('#view-estimate .card'); assert.equal(print.background,'rgb(255, 255, 255)'); assert.equal(print.color,'rgb(43, 37, 42)'); await expect(page.locator('#theme-toggle')).toBeHidden(); await page.emulateMedia({media:'screen'}); evidence.print=print;
  await theme('slate');
  await page.locator('#theme-toggle').focus(); await page.keyboard.press('Enter'); await expect(page.locator('html')).toHaveAttribute('data-theme','ceasefire'); await expect(page.locator('#theme-toggle')).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.keyboard=true;
  await page.reload({waitUntil:'networkidle'}); await idle(); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.persistence=true;
  await chooseCalculator(page,'Steel (spray)'); await idle(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false',{timeout:60000});
  const calculatorBefore=await snapshot(); await theme('forest'); await theme('midnight'); assert.deepEqual(await snapshot(),calculatorBefore); const grid=await colors('.calculator-grid'); assert.ok(contrast(grid.color,grid.background)>=4.5); evidence.calculator={preserved:true,grid};
  await page.locator('#calculator-pages').getByRole('button',{name:'SCHEDULE',exact:true}).click(); await idle(); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');
  const calculatorInput=page.locator('.calculator-grid input:not([readonly])').first();
  await calculatorInput.evaluate(el=>el.setAttribute('aria-invalid','true')); const invalid=await colors('.calculator-grid input[aria-invalid=true]'); assert.ok(contrast(invalid.color,invalid.background)>=4.5); assert.equal(invalid.background,'rgb(255, 242, 242)'); await calculatorInput.evaluate(el=>el.removeAttribute('aria-invalid')); evidence.calculator.invalid=invalid;
  await chooseTakeoff(page,'Steel'); await idle();
  // Source-image semantics are fixed rules; theme CSS never filters or colors pixels.
  const pageStyles=await page.locator('.takeoff-viewer').evaluate(el => ({filter:getComputedStyle(el).filter})); assert.equal(pageStyles.filter,'none'); evidence.drawings=pageStyles;
  // Like retained header-controls acceptance, 320px covers the header rather
  // than forcing a data register's minimum workspace width into that viewport.
  await page.getByRole('button',{name:'Home',exact:true}).click(); await idle();
  for(const width of [390,320]) { await page.setViewportSize({width,height:1000}); const b=await page.locator('#theme-toggle').boundingBox(); assert.ok(b.width>=40&&b.height>=40&&b.x+b.width<=width); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1)); }
  assert.deepEqual(await page.evaluate(() => window.themeCsp),[]);
  // A fresh document with denied storage exercises the real fallback, including
  // an existing saved preference that is inaccessible to the controller.
  await page.addInitScript(() => Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Denied','SecurityError');}}));
  await page.reload({waitUntil:'networkidle'}); await expect(page.locator('html')).toHaveAttribute('data-theme','ceasefire'); await page.locator('#theme-toggle').click(); await expect(page.locator('html')).toHaveAttribute('data-theme','midnight'); evidence.deniedStorage=true;
  assert.deepEqual(hashes(),assetHashes,'Source assets must remain unchanged during QA'); assert.deepEqual(errors,[]);
  assert.ok(networkFailures.every(r=>r.failure?.errorText==='net::ERR_ABORTED'&&r.url===`http://127.0.0.1:${fixture.port}/api/calculate`),'Only calculation cancellation during deliberate disposable reload is permitted');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,assetHashes,evidence,errors,networkFailures,mutationRequests,fixturePort:fixture.port},null,2)); console.log(`PASS themes: ${output}`);
})().catch(async error => { console.error(error); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),assetHashes,evidence,errors,networkFailures,serverExit},null,2)); process.exitCode=1; }).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
