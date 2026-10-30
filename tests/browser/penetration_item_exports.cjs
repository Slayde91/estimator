// Real current-unsaved-item downloads never read the independently retained Schedule.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `penetration-item-exports-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const sources = ['static/penetration.js', 'estimator/penetration_item_exports.py', 'estimator/server.py', 'data/penetration.json.gz', 'estimator/penetration_calculator.py'];
const sourceHashes = Object.fromEntries(sources.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  let data = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { data += value; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], itemExports = [], calculationRequests = [];
async function idle() { await page.waitForFunction(() => { const s = window.CeasefireDesktop?.status(); return s?.ready && !s.busy; }); }
async function settled() { await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy', 'false'); await idle(); }
async function snapshot() { await settled(); return page.evaluate(() => ({ penetration: window.CeasefirePenetrations.projectSnapshot(), fingerprint: window.CeasefirePenetrations.projectFingerprint(), dirty: window.CeasefirePenetrations.hasUnsavedChanges(), pricing: window.CeasefireProject.configuration(), calculators: window.CeasefireCalculators.projectSnapshot() })); }
async function detailsTab() { await page.locator('#penetration-input-groups').getByRole('tab', { name: 'DETAILS', exact: true }).click(); }
async function fill(column, value) { const field = page.locator(`[data-penetration-scope="composer"][data-penetration-field="${column}"]`); await field.fill(value); await field.press('Tab'); await settled(); }
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if(new URL(request.url()).pathname==='/api/penetration/calculate')calculationRequests.push(request.postDataJSON()); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  const saving = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save-as'); await clickProjectControl(page, 'Save'); assert.equal((await saving).status(), 200); await idle();
  const projectBytes = fs.readFileSync(info.project);
  await chooseCalculator(page, 'Firestopping'); await settled();
  const pipe = () => page.locator('details.penetration-band-settings').filter({ has: page.locator(':scope > summary', { hasText: 'Pipe Labour' }) });
  const settingsBefore = (await snapshot()).penetration.draft.globals;
  await page.locator('#penetration-settings').click(); await expect(pipe()).toHaveJSProperty('open', false);
  await pipe().locator(':scope > summary').click(); await expect(pipe()).toHaveJSProperty('open', true);
  await detailsTab(); await page.locator('#penetration-settings').click(); await expect(pipe()).toHaveJSProperty('open', true);
  await pipe().locator(':scope > summary').click(); await expect(pipe()).toHaveJSProperty('open', false);
  await detailsTab(); await page.locator('#penetration-settings').click(); await expect(pipe()).toHaveJSProperty('open', false);
  assert.deepEqual((await snapshot()).penetration.draft.globals, settingsBefore); await detailsTab();
  for (const [column, value] of [['J','Plumbing & Hydraulic'],['K','Copper Pipes'],['L','Core hole'],['M','Vertical'],['N','-/120/120'],['P','Concrete/masonry wall']]) await page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`).selectOption(value);
  await fill('T', 'SCHEDULE ONLY - RETAIN THIS ROW'); await fill('O', '4');
  await page.locator('#penetration-add-to-schedule').click(); await expect(page.locator('#penetration-add-to-schedule')).toHaveAttribute('aria-busy', 'false'); await settled();
  const scheduled = (await snapshot()).penetration.draft.rows; assert.equal(scheduled.length, 1);
  await page.locator('#penetration-input-groups').getByRole('tab', { name:'Products and labour', exact:true }).click();
  const crew=page.locator('#penetration-row-fields [data-penetration-field="W"]'); await crew.selectOption(await crew.locator('option').evaluateAll(options=>options.find(o=>o.value&&!o.disabled).value)); await settled(); await detailsTab();
  await fill('T', 'CURRENT UNSAVED - EXPORT THIS ITEM ONLY'); await fill('U', 'Current unsaved system and item detail'); await fill('O', '2.123456789');
  const generated = spawnSync(python, ['-c', "from PIL import Image; from io import BytesIO; import sys; im=Image.new('RGB',(320,160),'white'); im.paste((180,25,20),(40,25,150,110)); im.save(sys.stdout.buffer,format='PNG')"], { cwd: root, windowsHide: true }); assert.equal(generated.status, 0, generated.stderr.toString());
  await page.locator('#penetration-diagram-file').setInputFiles({ name: 'Current source.png', mimeType: 'image/png', buffer: generated.stdout });
  await expect(page.locator('#penetration-diagram-image')).toBeVisible(); await expect(page.locator('#penetration-diagram-remove')).toBeVisible();
  const before = await snapshot(); assert.deepEqual(before.penetration.draft.rows, scheduled); assert.equal(before.dirty, true);
  await expect(page.locator('#view-estimate #penetration-schedule-breakdown-card,#main-tab-firestopping-breakdown,#main-panel-firestopping-breakdown')).toHaveCount(0);
  await expect(page.locator('#firestopping-document-actions #penetration-excel,#firestopping-document-actions #penetration-pdf')).toHaveCount(0);
  const scheduleDetails=page.locator('details[aria-labelledby="penetration-estimator-schedule-heading"]'),schedulePanel=page.locator('#penetration-schedule-panel-schedule'),breakdownPanel=page.locator('#penetration-schedule-panel-breakdown');
  const scheduleTab=page.locator('#penetration-schedule-tab-schedule'),breakdownTab=page.locator('#penetration-schedule-tab-breakdown');
  await expect(scheduleDetails).toHaveJSProperty('open',true);await expect(schedulePanel).toBeVisible();await expect(breakdownPanel).toBeHidden();
  const scheduleNodes=await page.locator('#penetration-estimator-schedule-body').elementHandle(),breakdownNode=await page.locator('#penetration-schedule-breakdown').elementHandle();
  const renderedBefore=await page.locator('#penetration-schedule-breakdown-card').textContent(),requestsBeforeTabs=calculationRequests.length;
  for(const width of [1146,390]){
    await page.setViewportSize({width,height:900});await breakdownTab.click();await expect(breakdownPanel).toBeVisible();await expect(schedulePanel).toBeHidden();
    await expect(breakdownTab).toHaveAttribute('aria-selected','true');await expect(scheduleTab).toHaveAttribute('tabindex','-1');
    assert.equal(await page.locator('#penetration-schedule-view-tabs').evaluate(tabs=>tabs.scrollWidth<=tabs.clientWidth),true,'Both Schedule tabs fit without horizontal clipping');
    await expect(breakdownPanel.getByRole('table')).toHaveCount(1);await expect(breakdownPanel.getByRole('table')).toContainText('Subtotal');
    assert.equal(await breakdownPanel.getByRole('table').evaluate(table=>!!table.closest('.penetration-schedule')),false,'Schedule column widths never affect the Breakdown table');
    await page.screenshot({path:path.join(output,`schedule-breakdown-${width}.png`)});
    await breakdownTab.focus();await breakdownTab.press('Home');await expect(scheduleTab).toBeFocused();await expect(schedulePanel).toBeVisible();
    await scheduleTab.press('End');await expect(breakdownTab).toBeFocused();await expect(breakdownPanel).toBeVisible();
    await breakdownTab.press('ArrowRight');await expect(scheduleTab).toBeFocused();await expect(schedulePanel).toBeVisible();
    await scheduleTab.press('ArrowLeft');await expect(breakdownTab).toBeFocused();await expect(breakdownPanel).toBeVisible();
    await scheduleDetails.locator(':scope > summary').click();await expect(scheduleDetails).toHaveJSProperty('open',false);await expect(breakdownTab).toBeHidden();
    await scheduleDetails.locator(':scope > summary').click();await expect(breakdownPanel).toBeVisible();await expect(breakdownTab).toHaveAttribute('aria-selected','true');
  }
  assert.equal(await page.evaluate(node=>node===document.getElementById('penetration-estimator-schedule-body'),scheduleNodes),true);
  assert.equal(await page.evaluate(node=>node===document.getElementById('penetration-schedule-breakdown'),breakdownNode),true);
  assert.equal(await page.locator('#penetration-schedule-breakdown-card').textContent(),renderedBefore);
  assert.equal(calculationRequests.length,requestsBeforeTabs,'Tab/collapse/navigation presentation never recalculates');assert.deepEqual(await snapshot(),before);
  await scheduleNodes.dispose();await breakdownNode.dispose();await page.setViewportSize({width:1146,height:900});
  const toggle = page.locator('[aria-controls="firestopping-item-document-actions"]'), menu = page.locator('#firestopping-item-document-actions');
  await expect(menu.getByRole('button',{includeHidden:true})).toHaveCount(4);
  await expect(menu.locator('.download-format')).toHaveText(['XLSX','PDF','XLSX','PDF']);
  for (const [extension, id] of [['pdf','penetration-item-pdf'],['xlsx','penetration-item-excel']]) {
    await toggle.click(); await expect(menu).toBeVisible(); await expect(page.locator(`#${id}`)).toHaveAccessibleName('Item Details');
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === `/api/penetration/item.${extension}` && r.request().method() === 'POST');
    await page.locator(`#${id}`).click(); const reply = await pending; assert.equal(reply.status(), 200, await reply.text());
    const capture = reply.request().postDataJSON(), saved = await reply.json(); assert.deepEqual(capture.item, before.penetration.composer.rows[0]);
    assert.equal(capture.rows, undefined); assert.equal(capture.draft, undefined); assert.equal(saved.saved, true);
    const relative = path.relative(output, saved.path); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.copyFileSync(saved.path, path.join(output, `CEASEFIRE-Firestopping-Item.${extension}`));
    if (extension === 'pdf') fs.writeFileSync(path.join(output, 'captured-item.json'), JSON.stringify(capture, null, 2));
    itemExports.push({ extension, path: saved.path, sha256: hash(fs.readFileSync(saved.path)), capture });
    await expect(menu).toBeHidden(); await expect(page.locator(`#${id}`)).toHaveAttribute('aria-busy', 'false');
    assert.deepEqual(await snapshot(), before, 'Downloading preserves unsaved Item, Schedule, pricing, settings and calculator drafts');
  }
  await toggle.click();await expect(page.locator('#penetration-pdf')).toHaveAccessibleName('Download Firestopping Schedule');
  const scheduleReply=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/penetration/report.pdf'&&reply.request().method()==='POST');
  await page.locator('#penetration-pdf').click();const response=await scheduleReply;assert.equal(response.status(),200,await response.text());
  const scheduleCapture=response.request().postDataJSON(),scheduleFile=await response.json();assert.equal(scheduleFile.saved,true);
  assert.deepEqual(scheduleCapture.draft,before.penetration.draft);assert.deepEqual(scheduleCapture.configuration,before.pricing);assert.equal(scheduleCapture.item,undefined);assert.equal(scheduleCapture.diagram,undefined);
  const scheduleRelative=path.relative(output,scheduleFile.path);assert.ok(scheduleRelative&&!scheduleRelative.startsWith('..')&&!path.isAbsolute(scheduleRelative));
  const scheduleContent=spawnSync(python,['-c',"from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); t='\\n'.join(p.extract_text() for p in r.pages); assert 'Schedule' in t and 'Copper Pipes' in t and '4.00' in t; assert '2.12' not in t; assert 'CURRENT UNSAVED - EXPORT THIS ITEM ONLY' not in t; assert all(i.image.size!=(320,160) for p in r.pages for i in p.images); print('Independent Schedule PDF content passed')",scheduleFile.path],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(scheduleContent.status,0,`${scheduleContent.stdout}\n${scheduleContent.stderr}`);
  assert.deepEqual(await snapshot(),before,'New Schedule entry preserves current unsaved item and independent Schedule');
  const scheduleExport={path:scheduleFile.path,sha256:hash(fs.readFileSync(scheduleFile.path)),capture:scheduleCapture,independentContent:true};
  await toggle.click();await expect(page.locator('#penetration-excel')).toHaveAccessibleName('Download Firestopping Schedule');
  const scheduleWorkbookReply=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/penetration/register.xlsx'&&reply.request().method()==='POST');
  await page.locator('#penetration-excel').click();const workbookResponse=await scheduleWorkbookReply;assert.equal(workbookResponse.status(),200,await workbookResponse.text());
  const workbookCapture=workbookResponse.request().postDataJSON(),workbookFile=await workbookResponse.json();assert.equal(workbookFile.saved,true);assert.deepEqual(workbookCapture.draft,before.penetration.draft);assert.deepEqual(workbookCapture.configuration,before.pricing);assert.equal(workbookCapture.item,undefined);assert.equal(workbookCapture.diagram,undefined);
  const workbookRelative=path.relative(output,workbookFile.path);assert.ok(workbookRelative&&!workbookRelative.startsWith('..')&&!path.isAbsolute(workbookRelative));assert.equal(fs.readFileSync(workbookFile.path).subarray(0,2).toString(),'PK');
  assert.deepEqual(await snapshot(),before,'Moved Schedule XLSX preserves every draft and exact pricing');
  const content = spawnSync(python, [path.join(__dirname, 'penetration_item_export_content.py'), '--directory', output], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(content.status, 0, `${content.stdout}\n${content.stderr}`);
  await toggle.focus(); await toggle.press('ArrowDown'); await expect(page.locator('#penetration-item-excel')).toBeFocused(); await page.keyboard.press('End'); await expect(page.locator('#penetration-pdf')).toBeFocused(); await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(toggle).toBeFocused();
  for (const width of [1146, 390]) { await page.setViewportSize({ width, height: 900 }); await toggle.click(); await expect(menu).toBeVisible(); await page.screenshot({ path: path.join(output, `item-document-${width}.png`) }); await page.keyboard.press('Escape'); }
  assert.deepEqual(fs.readFileSync(info.project), projectBytes); assert.deepEqual(errors, []);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(root,name))), expected, `Source unchanged: ${name}`);
  fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({ passed:true, port:info.port, sourceHashes, exports:itemExports, scheduleExport, scheduleWorkbook:{path:workbookFile.path,sha256:hash(fs.readFileSync(workbookFile.path)),capture:workbookCapture}, scheduleTabs:{keyboard:true,retainedNodes:true,unchangedRenderedData:true,noCalculationRequests:true,collapseRetainsSelection:true,viewports:[1146,390]},content:JSON.parse(content.stdout), pipeLabour:{initiallyCollapsed:true,explicitOpenAndCloseRetained:true,bandsUnchanged:true}, independentScheduleRetained:true, savedProjectUnchanged:true, draftUnchanged:true, errors }, null, 2));
  console.log(JSON.stringify({ passed:true, output }));
})().catch(async error => { console.error(error); fs.writeFileSync(path.join(output,'failure.txt'), `${error.stack}\n${logs}`); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); process.exitCode=1; }).finally(async()=>{ fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
