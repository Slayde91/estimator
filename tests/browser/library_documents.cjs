const { cycleTheme } = require('./theme_navigation.cjs');
// Document controls exercise real handlers against fixture-owned project/storage.
const { chromium, expect } = require('@playwright/test');
const { chooseLibrary } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `library-documents-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'project_library_fixture.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let data = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { data += value; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], evidence = [];
async function idle() { await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function snapshot() { await idle(); return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details(), editor: [...document.querySelectorAll('#library-pricing input:not([type="file"]),#library-pricing select,#library-pricing textarea')].map(e => [e.id, e.dataset.priceField, e.value]) })); }
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save-as');
  await clickProjectControl(page, 'Save'); assert.equal((await saved).status(), 200); await idle();
  const projectBytes = fs.readFileSync(info.project);
  fs.writeFileSync(path.join(output, 'before-downloads.cf.json'), projectBytes);
  await chooseLibrary(page, 'pricing'); await expect(page.locator('#library-pricing')).toBeVisible();
  const before = await snapshot();
  const toggle = page.locator('.pricing-document-menu [data-document-menu-toggle]'), menu = page.locator('#pricing-document-actions');
  assert.equal(await toggle.locator('img').getAttribute('src'), '/icons/document.png');
  await toggle.focus(); await toggle.press('ArrowDown'); await expect(page.locator('#export-pricing')).toBeFocused();
  await page.keyboard.press('End'); await expect(page.locator('#import-pricing')).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.locator('#export-pricing')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(menu).toBeHidden();
  for (const theme of ['ceasefire', 'midnight', 'ocean', 'forest', 'slate']) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1146, 752, 390]) {
      await page.setViewportSize({ width, height: 900 }); await toggle.click();
      await expect(menu.getByRole('button')).toHaveCount(2);
      await expect(menu.getByRole('button', { name: 'Export Excel', exact: true })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Import Excel', exact: true })).toBeVisible();
      const layout = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width }; };
        return { document:box('.pricing-document-menu'), toolbar:box('.pricing-table-actions'), menu:box('#pricing-document-actions'), scope:box('.pricing-scope-field'), availability:box('#rate-group-field'), search:box('.pricing-controls .search-field'), overflow:document.documentElement.scrollWidth-innerWidth };
      });
      assert.ok(Math.abs(layout.document.x-layout.toolbar.x)<1, 'Pricing Document is the far-left toolbar control');
      assert.ok(layout.menu.x>=0 && layout.menu.right<=width+1, 'Pricing popup stays within viewport');
      assert.ok(layout.overflow<=1, `Pricing page overflows at ${width}`);
      if (width>570) { assert.ok(Math.abs(layout.scope.y-layout.availability.y)<1); assert.ok(layout.scope.x>=layout.availability.right); }
      else { assert.ok(layout.scope.y>=layout.availability.bottom); }
      if (width<880) assert.ok(layout.search.bottom<=layout.availability.y);
      await page.screenshot({ path:path.join(output, `pricing-${theme}-${width}.png`) });
      evidence.push({theme,width,...layout});
      await page.locator('#library-pricing .page-heading').click(); await expect(menu).toBeHidden();
    }
    await cycleTheme(page);
  }
  await page.setViewportSize({width:1146,height:900});
  await toggle.click();
  const exported = page.waitForResponse(r => new URL(r.url()).pathname === '/api/pricing/export');
  const projectSave = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project/save' && r.request().method() === 'POST');
  projectSave.catch(() => {});
  await page.locator('#export-pricing').click(); const response=await exported; assert.equal(response.status(),200);
  const file=await response.json(); assert.equal(file.saved,true);
  const relative=path.relative(output,file.path); assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const exportedBytes = fs.readFileSync(file.path);
  assert.equal(exportedBytes.subarray(0,2).toString(),'PK');
  assert.equal((await projectSave).status(), 200);
  await expect.poll(() => page.evaluate(() => Boolean(window.CeasefireDownloads.hasPendingOperation() || window.CeasefireDocumentation.hasPendingOperation() || window.CeasefireProject.hasPendingOperation())), { timeout: 60000 }).toBe(false);
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await expect(menu).toBeHidden(); await idle();
  await toggle.click(); const chooser=page.waitForEvent('filechooser'); await page.locator('#import-pricing').click();
  const selected=await chooser; assert.equal(selected.isMultiple(),false); await expect(menu).toBeHidden();
  assert.deepEqual(await snapshot(),before,'Menu actions and export preserve pricing, calculator and composer drafts');
  await page.locator('#estimate-navigation-toggle').click(); await expect(page.locator('#view-estimate')).toBeVisible();
  const scheduleMenu=page.locator('#firestopping-document-actions'), scheduleToggle=page.locator('[aria-controls="firestopping-document-actions"]');
  assert.equal(await scheduleToggle.evaluate(e=>e.closest('.page-heading')?.querySelector('#download-quote-pdf')!==null),true);
  assert.equal(await scheduleToggle.evaluate(e=>document.querySelector('#download-quote-pdf').parentElement===document.getElementById(e.getAttribute('aria-controls'))),true,'Estimate Summary belongs to the existing Document list');
  await scheduleToggle.click();
  await expect(scheduleMenu.getByRole('button',{name:'Firestopping Schedule',exact:true})).toHaveCount(0);
  await expect(scheduleMenu.locator('.download-format')).toHaveText(['PDF','PDF','PDF']);
  await page.keyboard.press('Escape'); await expect(scheduleMenu).toBeHidden();
  assert.equal(await page.locator('.penetration-schedule-recalculate-tools .calculator-document-menu').count(),0);
  const initial = JSON.parse(projectBytes), stored = JSON.parse(fs.readFileSync(info.project, 'utf8'));
  assert.equal(initial.documentation.revision_count, 0);
  const folder = path.join(output, initial.documentation.companion_folder);
  const manifestBytes = fs.readFileSync(path.join(folder, `${stored.documentation.manifest_sha256}.json`)), manifest = JSON.parse(manifestBytes);
  assert.deepEqual(Object.keys(manifest).sort(), ['project_id', 'revisions', 'version', 'workspace_revision']);
  assert.equal(manifest.project_id, initial.documentation.project_id); assert.equal(manifest.version, 1); assert.equal(manifest.workspace_revision, 1);
  const frozen = { filename: path.basename(file.path), kind: 'pricing.library.xlsx', revision: 1, sequence: 1,
    sha256: hash(exportedBytes), size: exportedBytes.length, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  assert.deepEqual(manifest.revisions.map(row => Object.fromEntries(Object.keys(frozen).map(key => [key, row[key]]))), [frozen]);
  const blob = fs.readFileSync(path.join(folder, 'blobs', frozen.sha256 + '.xlsx'));
  assert.equal(blob.length, frozen.size); assert.equal(hash(blob), frozen.sha256, 'The frozen revision preserves the exact native Pricing export');
  const expected = { ...initial, documentation: { ...initial.documentation, manifest_sha256: hash(manifestBytes), manifest_size: manifestBytes.length,
    revision_count: 1, unique_bytes: exportedBytes.length } };
  assert.deepEqual(stored, expected, 'Automatic Save changes only the verified document-history metadata; every other saved project field stays exact');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({completed:true,layouts:evidence,exported:path.basename(file.path),keyboard:true,importChooser:true,draftsPreserved:true,savedProjectMatchesAutomaticSave:true,verifiedFrozenRevisions:1,errors},null,2));
  console.log(`PASS pricing Document keyboard, native export/import chooser, adjacent scope and 15 theme/viewport layouts; exact frozen history is automatically saved while all other project fields and drafts stay unchanged. Evidence: ${output}`);
})().catch(async error=>{console.error(error);console.error(logs.slice(-4000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{fs.writeFileSync(path.join(output,'server.log'),logs);if(browser)await browser.close();server.kill();});
