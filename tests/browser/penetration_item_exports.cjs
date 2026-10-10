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
const errors = [], itemExports = [];
async function idle() { await page.waitForFunction(() => { const s = window.CeasefireDesktop?.status(); return s?.ready && !s.busy; }); }
async function settled() { await expect(page.locator('#penetration-recalculate')).toHaveAttribute('aria-busy', 'false'); await idle(); }
async function snapshot() { await settled(); return page.evaluate(() => ({ penetration: window.CeasefirePenetrations.projectSnapshot(), fingerprint: window.CeasefirePenetrations.projectFingerprint(), dirty: window.CeasefirePenetrations.hasUnsavedChanges(), pricing: window.CeasefireProject.configuration(), calculators: window.CeasefireCalculators.projectSnapshot() })); }
async function detailsTab() { await page.locator('#penetration-input-groups').getByRole('tab', { name: 'DETAILS', exact: true }).click(); }
async function fill(column, value) { const field = page.locator(`[data-penetration-scope="composer"][data-penetration-field="${column}"]`); await field.fill(value); await field.press('Tab'); await settled(); }
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
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
  for (const [column, value] of [['J','Plumbing & Hydraulic'],['K','Copper Pipes'],['L','Core Hole'],['M','Vertical'],['N','-/120/120'],['P','Concrete/masonry wall']]) await page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`).selectOption(value);
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
  const toggle = page.locator('[aria-controls="firestopping-item-document-actions"]'), menu = page.locator('#firestopping-item-document-actions');
  for (const [extension, id] of [['pdf','penetration-item-pdf'],['xlsx','penetration-item-excel']]) {
    await toggle.click(); await expect(menu).toBeVisible(); await expect(page.locator(`#${id}`)).toHaveAccessibleName('Download Current Item');
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
  const content = spawnSync(python, [path.join(__dirname, 'penetration_item_export_content.py'), '--directory', output], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(content.status, 0, `${content.stdout}\n${content.stderr}`);
  await toggle.focus(); await toggle.press('ArrowDown'); await expect(page.locator('#penetration-item-excel')).toBeFocused(); await page.keyboard.press('End'); await expect(page.locator('#penetration-item-pdf')).toBeFocused(); await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(toggle).toBeFocused();
  for (const width of [1146, 390]) { await page.setViewportSize({ width, height: 900 }); await toggle.click(); await expect(menu).toBeVisible(); await page.screenshot({ path: path.join(output, `item-document-${width}.png`) }); await page.keyboard.press('Escape'); }
  assert.deepEqual(fs.readFileSync(info.project), projectBytes); assert.deepEqual(errors, []);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(root,name))), expected, `Source unchanged: ${name}`);
  fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({ passed:true, port:info.port, sourceHashes, exports:itemExports, content:JSON.parse(content.stdout), pipeLabour:{initiallyCollapsed:true,explicitOpenAndCloseRetained:true,bandsUnchanged:true}, independentScheduleRetained:true, savedProjectUnchanged:true, draftUnchanged:true, errors }, null, 2));
  console.log(JSON.stringify({ passed:true, output }));
})().catch(async error => { console.error(error); fs.writeFileSync(path.join(output,'failure.txt'), `${error.stack}\n${logs}`); if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); process.exitCode=1; }).finally(async()=>{ fs.writeFileSync(path.join(output,'server.log'),logs); if(browser) await browser.close(); server.kill(); });
