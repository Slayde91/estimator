const { chooseTakeoff } = require('./section_navigation.cjs');
'use strict';
// Native markup/handle selection and browser-owned visual defaults on disposable evidence.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `markup-selection-defaults-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const evidence = {}, errors = [], requests = [], csp = [], pointerTargets = [], nativeFirst = {}, desired = { stroke_color: '#A020F0', stroke_width: 3.75, fill_color: '#00CC88', fill_enabled: true, opacity: .45, display_values: false };
const defaultKey = 'ceasefire.takeoff-markup-defaults.v2';
const runtimeHashes = () => Object.fromEntries(['takeoffs.js','takeoff-physical.js','takeoffs.css'].map(name => [name,createHash('sha256').update(fs.readFileSync(path.join(root,'static',name))).digest('hex')]));
const panel = () => page.locator('#takeoff-markup-settings');
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, value = await response.json(); assert.equal(response.status(), 200, JSON.stringify(value)); await idle(); return value;
}
async function dialog(title, values, submit) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) { const field = modal.getByLabel(label, { exact: true }); if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value)); }
  await modal.getByRole('button', { name: submit, exact: true }).click(); await expect(page.locator('dialog.takeoff-dialog')).toHaveCount(0);
}
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await page.locator('.takeoff-viewport').evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  const box = await overlay.boundingBox(); return [box.x + x / 842 * box.width, box.y + (1 - y / 595) * box.height];
}
async function click(point, modifiers = [], expectedId) {
  // Existing pointer-capture echo suppression expires before a new gesture.
  await page.waitForTimeout(550); const target = await screen(point);
  if (expectedId) {
    const hitId = await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.closest('.takeoff-hit')?.dataset.itemId, target);
    assert.equal(hitId, expectedId, 'The real pointer coordinate must hit its intended native markup before clicking');
    pointerTargets.push({ itemId: expectedId, pdfPoint: point, screenPoint: target, actualHitId: hitId });
  }
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try { await page.mouse.click(...target); } finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
  await idle();
}
async function openDrawingSettings(point) {
  await page.waitForTimeout(550);
  await page.mouse.dblclick(...await screen(point)); await idle();
}
const body = id => page.locator(`.takeoff-hit[data-item-id="${id}"]`).first();
async function enterWorkspace(info, calibrate = true) {
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.equal(response.status(), 200); assert.match(response.headers()['content-security-policy'], /script-src 'self'/);
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready, null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  if (calibrate) {
    await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
    await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  }
}
async function draw(mode, mark, x = 100) {
  const area = ['wall', 'slab'].includes(mode), points = area ? [[x,100],[x+120,100],[x+120,240],[x,240]] : [[x,400],[x+180,400]];
  await page.getByRole('button', { name: area ? 'Trace surface' : 'Trace length', exact: true }).click();
  for (const point of points) await page.mouse.click(...await screen(point));
  await page.locator('.takeoff-viewport').press('Enter');
  const fields = area ? { [mode === 'wall' ? 'Wall ID' : 'Slab / zone ID']: mark, 'Surface basis': mode === 'wall' ? 'wall-face' : 'slab-soffit', 'Explicit physical quantity': 1, 'True-surface source citation': `Synthetic true ${mode} plane; not real design evidence` } : { [mode === 'steel' ? 'Member mark' : 'Item']: mark, 'Count/QTY': 1 };
  const reply = await command(() => dialog(area ? `Add ${mode} surface` : `Add ${mode} object`, fields, area ? 'Add surface' : 'Add item'), 'create_item');
  return reply.snapshot.items.find(item => item.fields.mark === mark);
}
async function setDefault() {
  for (const [label, value] of [['Line Colour', desired.stroke_color], ['Line Width', desired.stroke_width], ['Fill colour', desired.fill_color], ['Opacity', desired.opacity * 100]]) { await panel().getByLabel(label, { exact: true }).fill(String(value)); await panel().getByLabel(label, { exact: true }).press('Tab'); await settingsSettled(page); }
  await panel().getByLabel('Fill enabled', { exact: true }).setChecked(desired.fill_enabled); await settingsSettled(page);
  const before = await snapshot(), mutations = requests.length;
  await panel().getByRole('button', { name: 'Set as default', exact: true }).click(); await settingsSettled(page);
  assert.deepEqual(await snapshot(), before, 'Saving a visual preference sends no item change'); assert.equal(requests.length, mutations);
}
async function drawCount(mark) {
  await chooseTakeoff(page, 'duct'); await page.getByRole('button', { name: 'Count', exact: true }).click();
  for (const point of [[500,250],[550,280]]) await page.mouse.click(...await screen(point));
  await page.locator('.takeoff-viewport').press('Enter');
  const reply = await command(() => dialog('Add count', { Item: mark }, 'Add count'), 'add_standalone_count');
  return reply.snapshot.items.find(item => item.fields.mark === mark);
}
async function blankDuringHeldSettings(mode, item) {
  const before = await snapshot(), blank = await screen([750,500]);
  await page.waitForTimeout(550);
  let release, observed;
  const held = new Promise(resolve => { release = resolve; }), sawRequest = new Promise(resolve => { observed = resolve; });
  const handler = async route => {
    const value = route.request().postDataJSON();
    if (value.op === 'bulk_update' && value.changes?.fields?.level === `${mode}-HELD`) { observed(value); await held; }
    await route.continue();
  };
  await page.route('**/commands',handler);
  try {
    const response = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.changes?.fields?.level === `${mode}-HELD`);
    response.catch(() => {});
    await panel().getByLabel('Level',{exact:true}).fill(`${mode}-HELD`);
    await panel().getByLabel('Level',{exact:true}).press('Tab');
    const sent = await Promise.race([sawRequest,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`No held ${mode} settings request`)),10000))]);
    assert.deepEqual(sent.item_ids,[item.id]);
    await expect(page.locator('#takeoffs-workspace')).toHaveAttribute('aria-busy','true');
    const canonical = await page.request.get(await page.evaluate(()=>`${location.origin}/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`));
    assert.equal(canonical.status(),200);assert.deepEqual((await canonical.json()).snapshot.items,before.items,'Held request has not changed canonical items');
    await page.mouse.click(...blank);await expect(panel()).toBeVisible();await expect(body(item.id)).toHaveAttribute('aria-pressed','true');
    release();assert.equal((await response).status(),200);await idle();await expect(panel()).toBeHidden();await expect(body(item.id)).toHaveAttribute('aria-pressed','false');
    const after=await snapshot(),expected=structuredClone(before.items);expected.find(value=>value.id===item.id).fields.level=`${mode}-HELD`;
    const actual=after.items.find(value=>value.id===item.id),previous=before.items.find(value=>value.id===item.id);
    assert.equal(actual.fields.level,`${mode}-HELD`);
    for(const key of ['geometry','measurement','evidence','quantity','appearance'])assert.deepEqual(actual[key],previous[key]);
    assert.deepEqual(after.items.filter(value=>value.id!==item.id),before.items.filter(value=>value.id!==item.id));
  } finally { release();await page.unroute('**/commands',handler); }
}
function watch(current) {
  current.on('pageerror', error => errors.push(error.message));
  current.on('request', request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.violatedDirective)); });
  page = await context.newPage(); page.setDefaultTimeout(30000); watch(page); await enterWorkspace(info);
  const runtimeBefore=runtimeHashes();
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const originalDocuments = (await snapshot()).documents, originalCalibrations = (await snapshot()).calibrations;
  for (const mode of ['steel','duct','wall','slab']) {
    await chooseTakeoff(page, mode); await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 1);
    // Wall and Floor now share one drawing. Distinct synthetic planes preserve
    // genuine pointer coverage instead of assuming the other plane is hidden.
    const origin = mode === 'slab' ? 400 : 100, area = ['wall','slab'].includes(mode);
    const first = await draw(mode, `${mode}-A`, origin), bodyPoint = area ? [origin+60,170] : [190,400];
    nativeFirst[mode] = first.id;
    let oldSecond;
    if (mode === 'steel') oldSecond = await draw(mode, 'steel-OLD', 400); else assert.deepEqual(first.appearance, {...desired,marker_size:25});
    if (await panel().isVisible()) await panel().getByRole('button', { name: 'Close settings', exact: true }).click();
    await click(bodyPoint, [], first.id); await expect(panel()).toBeHidden(); await expect(body(first.id)).toHaveAttribute('aria-pressed', 'true');
    await openDrawingSettings(bodyPoint); await expect(panel()).toBeVisible();
    await panel().getByRole('button', { name: 'Close settings', exact: true }).click(); await expect(panel()).toBeHidden();
    await page.waitForTimeout(550); const handle = page.locator(`.takeoff-control-point[data-control-item-id="${first.id}"][data-point-index="0"][data-exclusion-id=""]`);
    const beforeHandle = await snapshot(), count = requests.length;
    await handle.click(); await expect(panel()).toBeHidden(); assert.deepEqual(await snapshot(), beforeHandle); assert.equal(requests.length, count);
    const box = await handle.boundingBox(), start = [box.x+box.width/2,box.y+box.height/2];
    const moved = await command(async () => { await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0]+12,start[1]-8,{steps:6}); await page.mouse.up(); }, 'update_item');
    await expect(panel()).toBeHidden(); const current = moved.snapshot.items.find(item => item.id === first.id);
    assert.notDeepEqual(current.geometry.points[0], first.geometry.points[0]); assert.deepEqual(current.geometry.points.slice(1),first.geometry.points.slice(1)); assert.deepEqual(current.evidence,first.evidence); assert.equal(current.quantity,first.quantity);
    // A native double click opens a manually closed pane after a handle operation.
    await openDrawingSettings(bodyPoint); await expect(panel()).toBeVisible();
    // A genuinely immediate blank click joins the pending automatic settings save.
    const blank = await screen([750,500]); await page.waitForTimeout(550);
    await panel().getByLabel('Level', { exact: true }).fill(`${mode}-PENDING`);
    await command(() => page.mouse.click(...blank), 'bulk_update'); await expect(panel()).toBeHidden(); await expect(body(first.id)).toHaveAttribute('aria-pressed','false');
    assert.equal((await snapshot()).items.find(item => item.id === first.id).fields.level,`${mode}-PENDING`);
    await body(first.id).press('Enter'); await expect(panel()).toBeVisible();
    await blankDuringHeldSettings(mode,first);await body(first.id).press('Enter');await expect(panel()).toBeVisible();
    if (mode === 'steel') {
      await setDefault(); assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)),defaultKey),{version:1,appearance:desired});
      assert.deepEqual((await snapshot()).items.find(item => item.id === oldSecond.id),oldSecond,'Setting defaults does not rewrite existing unrelated items');
      const fresh = await draw(mode,'steel-NEW',650); assert.deepEqual(fresh.appearance,{...desired,marker_size:25});
      await click([490,400]); await click([190,400],['Shift']); await expect(body(oldSecond.id)).toHaveAttribute('aria-pressed','true'); await expect(body(first.id)).toHaveAttribute('aria-pressed','true'); await expect(panel()).toBeVisible();
      await click([750,500]); await expect(panel()).toBeHidden();
    }
    await page.screenshot({ path:path.join(output,`${mode}-settings-selection.png`) });
    evidence[mode]={singleClickSelectsWithoutOpening:true,nativeDoubleClickOpens:true,selectedBodyDoubleClickReopensClosedPane:true,controlClickSilent:true,controlDragSilent:true,blankClearsAndHides:true,pendingEditPreserved:true,heldSaveBlankClearsWithoutLoss:true,sourceEvidenceAndQuantityPreserved:true,newAppearance:mode==='steel'?desired:first.appearance};
  }
  const beforeMixed = await snapshot(), mixedCommands = requests.length;
  await click([750,500]);await body(nativeFirst.wall).press('Enter');await body(nativeFirst.slab).press('Shift+Space');
  for(const id of [nativeFirst.wall,nativeFirst.slab])await expect(body(id)).toHaveAttribute('aria-pressed','true');
  await expect(panel()).toBeVisible();await expect(panel().getByText('Surface type: Wall / Floor',{exact:true})).toBeVisible();
  await expect(panel().getByLabel('Surface basis',{exact:true})).toHaveCount(0);
  assert.deepEqual(await snapshot(),beforeMixed,'Mixed native keyboard selection changes no item, source, measurement, quantity or appearance');
  assert.equal(requests.length,mixedCommands,'Mixed native keyboard selection sends no mutation');
  await page.screenshot({path:path.join(output,'combined-native-keyboard-selection.png')});await click([750,500]);
  evidence.combined={nativeItemIds:[nativeFirst.wall,nativeFirst.slab],bothNativePathsVisible:true,keyboardEnterAndAdditiveSpace:true,noMutation:true,mixedBasisNotEditable:true};
  const counted = await drawCount('DUCT-COUNT-DEFAULT'); assert.deepEqual(counted.appearance,{...desired,marker_size:25}); assert.equal(counted.quantity,2);
  await chooseTakeoff(page, 'wall'); await page.getByRole('button',{name:'Length',exact:true}).click();
  for(const point of [[400,300],[600,320]])await page.mouse.click(...await screen(point)); await page.locator('.takeoff-viewport').press('Enter');
  const length = await command(()=>dialog('Add length measurement',{Item:'WALL-LENGTH-DEFAULT'},'Add measurement'),'create_item'); assert.deepEqual(length.snapshot.items.find(item=>item.fields.mark==='WALL-LENGTH-DEFAULT').appearance,{...desired,marker_size:25});
  assert.deepEqual((await snapshot()).documents,originalDocuments); assert.deepEqual((await snapshot()).calibrations,originalCalibrations); assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  const saved=await snapshot(),saveWait=page.waitForResponse(response=>response.url().endsWith('/api/project/save-as')); await clickProjectControl(page,'Save'); assert.equal((await saveWait).status(),200); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const openWait=page.waitForResponse(response=>response.url().endsWith('/api/project/open')); await clickProjectControl(page,'Load'); assert.equal((await openWait).status(),200); await page.getByRole('dialog').getByRole('button',{name:'Load Project',exact:true}).click(); await page.getByRole('button',{name:'Takeoffs',exact:true}).click(); assert.deepEqual((await snapshot()).items,saved.items); assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);
  // A new launch keeps the browser preference without putting it in the project.
  assert.equal(Object.hasOwn(saved,'markup_defaults'),false); await enterWorkspace(info,false); const reloaded=await drawCount('AFTER-RELOAD'); assert.deepEqual(reloaded.appearance,{...desired,marker_size:25}); evidence.reloadPersisted=true;
  csp.push(...await page.evaluate(()=>window.qaCsp)); await context.close();
  const blocked=await browser.newContext({viewport:{width:1146,height:900}}); await blocked.addInitScript(()=>{window.qaCsp=[];document.addEventListener('securitypolicyviolation',event=>window.qaCsp.push(event.violatedDirective));Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}});});
  page=await blocked.newPage();page.setDefaultTimeout(30000);watch(page);await enterWorkspace(info);
  await chooseTakeoff(page, 'duct');const baseline=await draw('duct','BLOCKED-OLD');assert.deepEqual(baseline.appearance,{stroke_width:5,fill_enabled:true,marker_size:25,display_values:false});await openDrawingSettings([190,400]);await setDefault();await expect(page.locator('#takeoffs-workspace [role="status"]').filter({hasText:'Browser storage is unavailable'})).toBeVisible();const fallback=await drawCount('BLOCKED-NEW');assert.deepEqual(fallback.appearance,{...desired,marker_size:25});evidence.blockedStorageInWindow=true;csp.push(...await page.evaluate(()=>window.qaCsp));
  assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);
  const runtimeAfter=runtimeHashes();
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,fixturePort:info.port,evidence,pointerTargets,errors,csp,requests,savedItems:saved.items,calculatorInputsUnchanged:true,sourceDocumentsAndCalibrationUnchanged:true,runtimeBefore,runtimeAfter,runtimeSourceSha256:runtimeAfter['takeoffs.js'],limits:['Disposable fixture only; no live8765 interaction.','Copied or continued existing groups retain their original style; fresh drawings/counts/cited items use the browser visual preference.']},null,2));
  console.log(`PASS: four-mode body/blank/control-point selection, automatic edit flush, visual defaults and persistence/fallback, new counts/lengths, saved item/source/calculator preservation. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-3000));if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),await page.locator('body').innerText().catch(()=>''));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),errors,csp,status:await page.evaluate(()=>window.CeasefireDesktop?.status()).catch(()=>null),evidence},null,2));}process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(requests,null,2));if(browser)await browser.close();server.kill();});
