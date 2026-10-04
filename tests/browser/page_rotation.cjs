// Real PDF.js rendering on disposable synthetic pages, including an original
// rotation, offset CropBox and UserUnit. No user projects or live port are used.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `page-rotation-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page; const errors = [], cases = [];
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const snapshot = () => page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) await modal.getByLabel(label, { exact: true }).fill(String(value));
  await modal.getByRole('button', { name: action, exact: true }).click(); await expect(modal).toHaveCount(0); await settingsSettled(page);
}
function normalized(point, view, rotation) {
  const u = (point[0] - view[0]) / (view[2] - view[0]), v = (point[1] - view[1]) / (view[3] - view[1]);
  return [[u, 1-v], [v, u], [1-u, v], [1-v, 1-u]][rotation / 90];
}
async function sourcePoint(point, view, rotation) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox(), p = normalized(point, view, rotation);
  const result = [box.x + box.width * p[0], box.y + box.height * p[1]];
  assert.equal(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest('.takeoff-viewport'), result), true, 'Gesture lands inside drawing, clear of toolbar');
  return result;
}
async function assertMarkup(item, view, rotation) {
  const points = await page.locator(`polyline.takeoff-hit[data-item-id="${item.id}"]`).evaluate(el => [...el.previousElementSibling.points].map(p => [p.x,p.y]));
  const size = await page.locator('.takeoff-overlay').evaluate(el => [Number(el.getAttribute('width')), Number(el.getAttribute('height'))]);
  for (let index = 0; index < points.length; index++) {
    const expected = normalized(item.geometry.points[index], view, rotation).map((v,i)=>v*size[i]);
    assert.ok(Math.hypot(points[index][0]-expected[0], points[index][1]-expected[1]) < .01, `Markup vertex ${index} shares the independently calculated PDF rotation`);
  }
  const canvas = await page.locator('.takeoff-page > canvas').evaluate(el => [parseFloat(el.style.width), parseFloat(el.style.height)]);
  assert.ok(canvas.every((value,index)=>Math.abs(value-size[index])<.001), 'PDF bitmap and overlay retain identical display dimensions within browser CSS serialization precision');
}
(async () => {
  const info = await ready; assert.notEqual(info.port,8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport:{width:1146,height:900} }); page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',e=>window.qaCsp.push(e.effectiveDirective));});
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click(); await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1); await settingsSettled(page);
  const rotate=page.getByRole('button',{name:'Rotate page',exact:true}); await expect(rotate.locator('svg')).toHaveCount(1);
  for(const spec of [{number:1,view:[0,0,842,595],original:0,trace:[[170,350],[440,350]]},{number:3,view:[20,30,800,570],original:90,trace:[[240,230],[550,230]]}]) {
    if(Number(await page.getByLabel('Page number',{exact:true}).inputValue())!==spec.number) await renderDrawing(page,async()=>{await page.getByLabel('Page number',{exact:true}).fill(String(spec.number));await page.getByLabel('Page number',{exact:true}).press('Tab');},spec.number);
    await renderDrawing(page,()=>page.getByRole('button',{name:'Fit page',exact:true}).click());
    await page.getByRole('button',{name:'Scale',exact:true}).click();await page.getByLabel('Drawing calibration',{exact:true}).selectOption('scale:100');await dialog('Apply drawing scale 1:100?',{},'Apply scale');
    await page.getByRole('button',{name:'Trace length',exact:true}).click();
    await page.mouse.click(...await sourcePoint(spec.trace[0],spec.view,spec.original));await page.mouse.dblclick(...await sourcePoint(spec.trace[1],spec.view,spec.original));
    await dialog('Add steel object',{'Member mark':`ROTATION-${spec.number}`,'Count/QTY':1},'Add item');
    const before=await snapshot(), item=before.items.find(v=>v.fields.mark===`ROTATION-${spec.number}`), calculators=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
    assert.ok(item);await assertMarkup(item,spec.view,spec.original);
    for(const offset of [90,180,270,0]) {
      await renderDrawing(page,()=>rotate.click()); const rotation=(spec.original+offset)%360;
      await renderDrawing(page,()=>page.getByRole('button',{name:'Fit page',exact:true}).click());await assertMarkup(item,spec.view,rotation);
      const after=await snapshot();for(const key of ['documents','items','calibrations','viewports','physical','service_plans'])assert.deepEqual(after[key],before[key],`Rotation/fit preserves ${key}`);
      assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
      cases.push({page:spec.number,originalRotation:spec.original,offset});
      if(offset===90) {
        await page.getByRole('button',{name:'Select PDF text',exact:true}).click();await expect(page.locator('.takeoff-text-layer[data-text-state="ready"]')).toBeVisible();
        const text=await page.locator('.takeoff-text-layer').evaluate(el=>({matrix:getComputedStyle(el).transform,count:el.querySelectorAll('span').length}));assert.ok(text.count>0);assert.match(text.matrix,/^matrix\(/);
        await page.getByRole('button',{name:'Select',exact:true}).click();
        await page.screenshot({path:path.join(output,`rotation-${spec.number}-90.png`)});
      }
    }
  }
  // A second page retains its own viewing rotation after navigating away.
  await renderDrawing(page,()=>rotate.click());await renderDrawing(page,async()=>{await page.getByLabel('Page number',{exact:true}).fill('1');await page.getByLabel('Page number',{exact:true}).press('Tab');},1);
  const saved=await snapshot(), first=saved.items.find(v=>v.fields.mark==='ROTATION-1');await assertMarkup(first,[0,0,842,595],0);
  await renderDrawing(page,async()=>{await page.getByLabel('Page number',{exact:true}).fill('3');await page.getByLabel('Page number',{exact:true}).press('Tab');},3);
  await assertMarkup(saved.items.find(v=>v.fields.mark==='ROTATION-3'),[20,30,800,570],180);
  assert.deepEqual(errors,[]);const csp=await page.evaluate(()=>window.qaCsp);assert.deepEqual(csp,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,cases,consoleErrors:errors,cspViolations:csp},null,2));console.log(JSON.stringify({passed:true,output,cases:cases.length}));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),logs,errors},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
