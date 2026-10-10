const { chooseTakeoff } = require('./section_navigation.cjs');
'use strict';
// Native controls and source-based values; no live application or calculator writes.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `appearance-values-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup: ${logs}`)), 120000);
  server.stdout.on('data', data => { text += data; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const runtimeHashes = () => Object.fromEntries(['takeoffs.js', 'takeoffs.css', 'takeoff_model.py', 'takeoff_markup_pdf.py', 'takeoff_markup_pdf_worker.py'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name.endsWith('.py') ? 'estimator' : 'static', name))).digest('hex')]));
const panel = () => page.locator('#takeoff-markup-settings');
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op = 'bulk_update') {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, reply = await response.json(); assert.equal(response.status(), 200, JSON.stringify(reply)); await idle(); await settingsSettled(page); return reply;
}
async function modal(title, fields, action) {
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [name, value] of Object.entries(fields)) { const field = dialog.getByLabel(name, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value)); }
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  const box = await overlay.boundingBox(); return [box.x + x / 842 * box.width, box.y + (1 - y / 595) * box.height];
}
async function select(item) {
  await page.getByRole('checkbox', { name: 'Select all matching items', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select all matching items', exact: true }).uncheck();
  await page.locator(`tr[data-item-id="${item.id}"]`).getByRole('checkbox', { name: /^Select / }).check();
  if (!await panel().isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel()).toBeVisible();
}
async function draw(mode, mark, x = 100) {
  await chooseTakeoff(page, mode); await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 1);
  const area = ['wall', 'slab'].includes(mode), points = area ? [[x,100],[x+120,100],[x+120,240],[x,240]] : [[x,400],[x+120,400],[x+120,470]];
  await page.getByRole('button', { name: area ? 'Trace surface' : 'Trace length', exact: true }).click();
  for (const point of points) await page.mouse.click(...await screen(point)); await page.locator('.takeoff-viewport').press('Enter');
  const fields = area ? { 'Surface Type': mode, 'Surface ID': mark, 'Number of layers': 1 } : { [mode === 'steel' ? 'Member mark' : 'Item']: mark, 'Count/QTY': 1 };
  const reply = await command(() => modal(area ? 'Add surface' : `Add ${mode} object`, fields, area ? 'Add surface' : 'Add item'), 'create_item');
  const item = reply.snapshot.items.find(value => value.fields.mark === mark); assert.equal(item.mode,mode); if(area)assert.equal(item.fields.layers,1); await select(item); return item;
}
function preserved(before, after) {
  for (const key of ['geometry','measurement','fields','quantity','member_ids','evidence','confirmation','state']) assert.deepEqual(after[key], before[key], `${key} must survive a visual edit`);
}
function values(item, state) {
  const calibration = state.calibrations.find(value => value.id === item.measurement.calibration_id), points = calibration.points;
  const denominator = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0]-points[index][0], point[1]-points[index][1]), 0), scale = calibration.distance_m / denominator;
  const rings = [item.geometry.points, ...(item.geometry.exclusions || []).map(value => value.points)], area = item.geometry.kind === 'polygon';
  return rings.flatMap(ring => { const sequence = area ? [...ring,ring[0]] : ring; return sequence.slice(1).map((point,index) => Math.hypot(point[0]-sequence[index][0],point[1]-sequence[index][1])*scale*1000); });
}
async function assertLabels(item, state) {
  const expected = values(item, state), labels = page.locator(`[data-value-item-id="${item.id}"]`);
  await expect(labels).toHaveCount(expected.length);
  const actual = await labels.evaluateAll(elements => elements.map(el => ({ value: Number(el.dataset.value), text: el.firstChild.textContent, pointer: getComputedStyle(el).pointerEvents })));
  actual.forEach((entry,index) => { assert.equal(entry.value,expected[index]); assert.equal(entry.text,`${new Intl.NumberFormat('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(expected[index])} mm`); assert.equal(entry.pointer,'none'); });
  if (['wall','slab'].includes(item.mode)) {
    const reply = await page.request.get(`/api/takeoffs/sessions/${await page.evaluate(() => window.CeasefireTakeoffs.sessionId())}`), result = (await reply.json()).item_results.find(value => value.id === item.id);
    await expect(page.locator(`[data-area-item-id="${item.id}"]`)).toHaveText(`${new Intl.NumberFormat('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(result.net_area_m2)} m²`);
  }
  return actual;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, baseURL: `http://127.0.0.1:${info.port}` });
  await context.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.violatedDirective)); });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror',error => errors.push(error.message)); page.on('request',request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
  const response = await page.goto('/'); assert.equal(response.status(),200); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready,null,{timeout:120000});
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click(); await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture),1);
  await page.getByRole('button',{name:'Scale',exact:true}).click(); await page.getByLabel('Drawing calibration',{exact:true}).selectOption('scale:100');
  await command(() => modal('Apply drawing scale 1:100?',{},'Apply scale'),'add_calibration');
  const runtimeBefore = runtimeHashes(), initial = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const items = [];
  for (const mode of ['steel','duct','wall','slab']) {
    const before = await draw(mode,`VALUE-${mode}`); items.push(before); await expect(panel().getByLabel('Display Values',{exact:true})).not.toBeChecked();
    await expect(page.locator(`[data-value-item-id="${before.id}"]`)).toHaveCount(0); await expect(page.locator(`[data-area-item-id="${before.id}"]`)).toHaveCount(0);
    const reply = await command(() => panel().getByLabel('Display Values',{exact:true}).check()), enabled = reply.snapshot.items.find(value => value.id === before.id); preserved(before,enabled);
    const labels = await assertLabels(enabled,reply.snapshot);
    const width = panel().getByLabel('Line Width',{exact:true}), opacity = panel().getByLabel('Opacity',{exact:true});
    for (const control of [width,opacity]) { await expect(control).toHaveAttribute('min','1'); await expect(control).toHaveAttribute('max','100'); }
    for (const [line,percent] of [[100,1],[1,100]]) {
      await command(async () => { await width.fill(String(line)); await width.press('Tab'); });
      const changed = await command(async () => { await opacity.fill(String(percent)); await opacity.press('Tab'); });
      const current = changed.snapshot.items.find(value => value.id === before.id); assert.equal(current.appearance.stroke_width,line); assert.equal(current.appearance.opacity,percent/100); preserved(before,current);
    }
    await command(async () => { await width.fill('2'); await width.press('Tab'); });
    if (mode === 'steel') {
      await command(async () => { await opacity.fill('33.33333333333333'); await opacity.press('Tab'); });
      const retained = await snapshot(), exact = retained.items.find(value => value.id === before.id).appearance.opacity;
      await command(async () => { await panel().getByLabel('Line Colour',{exact:true}).fill('#123456'); await panel().getByLabel('Line Colour',{exact:true}).press('Tab'); });
      assert.equal((await snapshot()).items.find(value => value.id === before.id).appearance.opacity,exact,'Unrelated edits do not round stored opacity');
    }
    await page.locator('.takeoff-viewport').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(output,`${mode}-display-values.png`)});
    await command(() => panel().getByLabel('Display Values',{exact:true}).uncheck()); await expect(page.locator(`[data-value-item-id="${before.id}"]`)).toHaveCount(0); await expect(page.locator(`[data-area-item-id="${before.id}"]`)).toHaveCount(0);
    evidence[mode] = { labels, minimumAndMaximum:true, canonicalPercent:true, optIn:true, removal:true, technicalDataUnchanged:true };
  }
  // Saved appearance defaults never enable values on fresh items or rewrite old items.
  await chooseTakeoff(page, 'steel'); await select(items[0]); await command(() => panel().getByLabel('Display Values',{exact:true}).check());
  const beforeDefault = await snapshot(), requestCount = requests.length; await panel().getByRole('button',{name:'Set as default',exact:true}).click(); await settingsSettled(page);
  assert.deepEqual(await snapshot(),beforeDefault); assert.equal(requests.length,requestCount);
  const preference = await page.evaluate(() => JSON.parse(localStorage.getItem('ceasefire.takeoff-markup-defaults.v2')).appearance); assert.equal(preference.display_values,true);
  const fresh = await draw('duct','NEW-WITH-VALUES',400); assert.deepEqual(fresh.appearance,{...preference,marker_size:25,display_values:false});
  await expect(page.locator(`[data-value-item-id="${fresh.id}"]`)).toHaveCount(0);
  const enabledFresh = await command(() => panel().getByLabel('Display Values',{exact:true}).check());
  await assertLabels(enabledFresh.snapshot.items.find(value => value.id === fresh.id),enabledFresh.snapshot);
  // Counted Steel uses each explicit member length, even with no inferred scale for a count.
  await chooseTakeoff(page, 'steel'); await page.getByRole('button',{name:'Count steel lengths',exact:true}).click();
  for (const point of [[450,300],[550,300]]) { await page.mouse.click(...await screen(point)); await modal('Counted member length',{'Length per member (m)':6.123456789},'Place marker'); }
  await expect(page.locator('.takeoff-count-pending')).toHaveCount(2);
  const counted = await command(async () => page.mouse.dblclick(...await screen([650,300])),'add_count_items'), count = counted.snapshot.items.find(value => value.geometry?.kind === 'count');
  assert.equal(count.quantity,2); assert.equal(count.measurement.length_m,6.123456789); assert.equal(count.appearance.display_values,false);
  await expect(page.locator(`[data-value-item-id="${count.id}"]`)).toHaveCount(0);
  await select(count); await command(() => panel().getByLabel('Display Values',{exact:true}).check());
  await expect(page.locator(`[data-value-item-id="${count.id}"]`)).toHaveCount(2);
  assert.deepEqual(await page.locator(`[data-value-item-id="${count.id}"]`).evaluateAll(elements => elements.map(el => Number(el.dataset.value))),[6123.456789,6123.456789]);
  await page.screenshot({path:path.join(output,'steel-count-cited-values.png')});
  const saved = await snapshot(), saving = page.waitForResponse(value => value.url().endsWith('/api/project/save-as')); await clickProjectControl(page,'Save'); assert.equal((await saving).status(),200);
  const opening = page.waitForResponse(value => value.url().endsWith('/api/project/open')); await clickProjectControl(page,'Load'); assert.equal((await opening).status(),200); await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click(); await page.getByRole('button',{name:'Takeoffs',exact:true}).click(); await idle();
  const reopened = await snapshot(); assert.deepEqual(reopened.items,saved.items); assert.deepEqual(JSON.parse(fs.readFileSync(info.project)).takeoffs.items,saved.items);
  assert.deepEqual(reopened.documents,initial.documents); assert.deepEqual(reopened.calibrations,initial.calibrations); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  assert.deepEqual(errors,[]); assert.deepEqual(await page.evaluate(() => window.qaCsp),[]);
  const runtimeAfter = runtimeHashes(); assert.deepEqual(runtimeAfter,runtimeBefore,'The fixture ran against stable runtime bytes');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,port:info.port,evidence,errors,requests,preference,count:{id:count.id,length_m:count.measurement.length_m,quantity:count.quantity},saveReopenExact:true,sourceAndCalculatorUnchanged:true,runtimeBefore,runtimeAfter},null,2));
  console.log(`PASS: native four-mode values, percentage/width bounds, exact opacity retention, values disabled on creation, counted cited lengths and Save/Load. ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-3000)); if(page) { await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),errors,evidence,status:await page.evaluate(()=>window.CeasefireDesktop?.status()).catch(()=>null)},null,2)); } process.exitCode=1; }).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); if(browser)await browser.close(); server.kill(); });
