'use strict';
// Real selection, auto-save and movement on disposable synthetic PDF evidence.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `surface-selection-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const evidence = {}, errors = [], commands = [], assets = {}, assetTasks = [];
const panel = () => page.locator('#takeoff-markup-settings');
const hit = id => page.locator(`.takeoff-area-hit[data-item-id="${id}"]`);
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
const snapshot = () => page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
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
async function clickPoint(point, modifiers = []) {
  // Allow the existing 500ms pointer-capture echo suppression to expire.
  await page.waitForTimeout(550); const position = await screen(point);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try { await page.mouse.click(...position); } finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
  await idle();
}
async function selected(id, value) { await expect(hit(id)).toHaveAttribute('aria-pressed', String(value)); await expect(page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox', { name: /^Select / })).toBeChecked({ checked: value }); }
async function drawSurface(mode, mark, startX) {
  await page.getByRole('button', { name: 'Trace surface', exact: true }).click();
  for (const point of [[startX,100],[startX+120,100],[startX+120,240],[startX,240]]) await page.mouse.click(...await screen(point));
  await page.locator('.takeoff-viewport').press('Enter');
  const value = await command(() => dialog(`Add ${mode} surface`, {
    [mode === 'wall' ? 'Wall ID' : 'Slab / zone ID']: mark,
    'Explicit physical quantity': 1, 'Surface basis': mode === 'wall' ? 'wall-face' : 'slab-soffit',
    'True-surface source citation': `Synthetic true ${mode} surface; not real design evidence`
  }, 'Add surface'), 'create_item');
  return value.snapshot.items.find(item => item.mode === mode && item.fields.mark === mark);
}
(async () => {
  const info = await ready; browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) commands.push(request.postDataJSON()); });
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (['/takeoffs.js','/takeoffs.css'].includes(pathname)) assetTasks.push(response.body().then(bytes => { assets[pathname] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; })); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  await page.getByRole('button', { name: 'Scale', exact: true }).click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  const originalCalculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  for (const mode of ['wall','slab']) {
    await page.locator(`[data-mode="${mode}"]`).click(); await expect(panel()).toBeHidden();
    await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 1);
    const first = await drawSurface(mode, `${mode.toUpperCase()}-A`, 100);
    await expect(panel()).toBeVisible(); await expect(panel().getByRole('heading', { name: 'Item details', exact: true })).toBeVisible();
    const second = await drawSurface(mode, `${mode.toUpperCase()}-B`, 400);
    await clickPoint([700,450]); await expect(panel()).toBeHidden(); await selected(second.id, false);
    const beforeSelection = await snapshot(), beforeCommandCount = commands.length;
    await clickPoint([160,170]); await selected(first.id, true); await expect(panel()).toBeVisible();
    await expect(panel().getByLabel(mode === 'wall' ? 'Wall ID' : 'Slab / zone ID', { exact: true })).toHaveValue(first.fields.mark);
    await clickPoint([160,170]); await selected(first.id, false); await expect(panel()).toBeHidden();
    await hit(first.id).press('Enter'); await selected(first.id, true); await expect(panel()).toBeVisible();
    await hit(first.id).press('Space'); await selected(first.id, false); await expect(panel()).toBeHidden();
    await clickPoint([160,170]); await clickPoint([460,170], ['Shift']);
    await selected(first.id, true); await selected(second.id, true); await expect(panel()).toBeVisible();
    await clickPoint([160,170], ['Control']); await selected(first.id, false); await selected(second.id, true); await expect(panel()).toBeVisible();
    await clickPoint([700,450]); await selected(second.id, false); await expect(panel()).toBeHidden();
    await page.locator(`tr[data-item-id="${first.id}"]`).getByRole('checkbox', { name: /^Select / }).check(); await expect(panel()).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click(); await expect(panel()).toBeHidden();
    assert.deepEqual(await snapshot(), beforeSelection, 'Selection changes neither source evidence nor item quantities/geometry'); assert.equal(commands.length, beforeCommandCount, 'Selection sends no mutation command');
    // Click immediately after input, before the 450ms auto-save debounce.
    await clickPoint([160,170]); const repeatPosition = await screen([160,170]);
    await page.waitForTimeout(550);
    await panel().getByLabel('Level', { exact: true }).fill(`${mode}-L01`);
    await command(() => page.mouse.click(...repeatPosition), 'bulk_update');
    await selected(first.id, false); await expect(panel()).toBeHidden();
    assert.equal((await snapshot()).items.find(item => item.id === first.id).fields.level, `${mode}-L01`);
    await clickPoint([160,170]); const blankPosition = await screen([700,450]);
    await page.waitForTimeout(550);
    await panel().getByLabel('Level', { exact: true }).fill(`${mode}-L02`);
    await command(() => page.mouse.click(...blankPosition), 'bulk_update'); await expect(panel()).toBeHidden();
    // A blank click during an already running auto-save waits for it to finish.
    await clickPoint([160,170]); const savingBlankPosition = await screen([700,450]);
    await page.waitForTimeout(550);
    let releaseSave, heldResolve;
    const held = new Promise(resolve => { heldResolve = resolve; });
    const release = new Promise(resolve => { releaseSave = resolve; });
    const holdSave = async route => { if (route.request().postDataJSON()?.op === 'bulk_update') { heldResolve(); await release; } await route.continue(); };
    await page.route('**/commands', holdSave);
    await panel().getByLabel('Level', { exact: true }).fill(`${mode}-L03`);
    await command(async () => {
      await panel().getByLabel('Level', { exact: true }).press('Tab'); await held;
      await expect(page.locator('#takeoffs-workspace')).toHaveAttribute('aria-busy', 'true');
      await page.mouse.click(...savingBlankPosition); releaseSave();
    }, 'bulk_update');
    await page.unroute('**/commands', holdSave); await expect(panel()).toBeHidden();
    const edited = (await snapshot()).items.find(item => item.id === first.id); assert.equal(edited.fields.level, `${mode}-L03`); assert.deepEqual(edited.geometry, first.geometry); assert.deepEqual(edited.evidence, first.evidence);
    // A drag keeps selection and details open, moving only the selected source vertices.
    await clickPoint([160,170]); await page.waitForTimeout(550);
    const origin = await screen([160,170]), destination = await screen([175,182]);
    const moved = await command(async () => { await page.mouse.move(...origin); await page.mouse.down(); await page.mouse.move(...destination, { steps: 6 }); await page.mouse.up(); }, 'move_items');
    await selected(first.id, true); await expect(panel()).toBeVisible();
    const current = moved.snapshot.items.find(item => item.id === first.id), delta = current.geometry.points[0].map((value,index) => value-first.geometry.points[0][index]);
    assert.ok(Math.abs(delta[0]-15)<2 && Math.abs(delta[1]-12)<2, JSON.stringify(delta));
    current.geometry.points.forEach((point,index) => point.forEach((value,axis) => assert.ok(Math.abs(value-first.geometry.points[index][axis]-delta[axis])<1e-8)));
    assert.deepEqual(current.evidence, first.evidence); assert.equal(current.quantity, 1); assert.deepEqual(current.member_ids, first.member_ids);
    await page.screenshot({ path: path.join(output, `${mode}-selected-details.png`) });
    await clickPoint([700,450]); await expect(panel()).toBeHidden();
    evidence[mode] = { firstId: first.id, secondId: second.id, pointerToggle: true, blankClickCloses: true, keyboardEnterAndSpace: true, modifierSelectionRetained: true, pendingEditSavedBeforeClose: true, moveDelta: delta, sourceEvidenceUnchanged: true, quantityUnchanged: true };
  }
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), originalCalculators);
  const beforeSave = await snapshot(), saving = page.waitForResponse(response => response.url().endsWith('/api/project/save-as'));
  await page.getByRole('button', { name: 'Save As', exact: true }).click(); assert.equal((await saving).status(), 200); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const opening = page.waitForResponse(response => response.url().endsWith('/api/project/open')); await page.getByRole('button', { name: 'Load', exact: true }).click(); assert.equal((await opening).status(), 200); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click(); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); assert.deepEqual((await snapshot()).items, beforeSave.items); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), originalCalculators);
  assert.deepEqual(errors, []); await Promise.all(assetTasks);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, assets, commands, savedItems: beforeSave.items, calculatorInputsUnchanged: true }, null, 2));
  console.log(`PASS: Wall/Slab drawing, keyboard and modifier selection; details open/close; pending edits saved; movement preserves evidence/quantity; save/reopen; unchanged calculators. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-3000)); if (page) { await page.screenshot({ path: path.join(output,'failure.png'), fullPage:true }).catch(() => {}); fs.writeFileSync(path.join(output,'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode=1; }).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs); fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(commands,null,2)); if (browser) await browser.close(); server.kill(); });
