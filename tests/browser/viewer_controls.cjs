const { renderDrawing } = require('./viewer_helpers.cjs');
// Toolbar acceptance against a disposable server and original synthetic PDF.
const { chromium, expect } = require('@playwright/test');
const { editSettings, settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `viewer-controls-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], operations = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op) {
  const pending = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const result = await pending, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); await idle(); if(op==='record_render')await settingsSettled(page); return body;
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible({timeout:30000});
  for (const [label, value] of Object.entries(values)) {
    const field = modal.getByLabel(label, { exact: true });
    if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function sourcePoint([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  const point = [Math.round(box.x + (y - 30) / 540 * box.width), Math.round(box.y + (x - 20) / 780 * box.height)];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport'), point), true, 'Gesture lands on the drawing, clear of fixed controls');
  return point;
}
async function assertErrorVisible() {
  const notice = page.locator('#takeoffs-workspace [role="alert"]'); await expect(notice).toBeVisible();
  let position;
  // Tab can scroll the next focused control after the alert is rendered. The
  // app reveals it again on the next animation frame; rendered visibility
  // alone does not establish that the error has cleared the sticky header.
  await expect.poll(async () => {
    position = await notice.evaluate(el => {
      const box = el.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
      return { bounds: { x: box.x, y: box.y, width: box.width, height: box.height }, headerBottom: header.bottom, viewportHeight: window.innerHeight };
    });
    return { belowHeader: position.bounds.y >= position.headerBottom + 10,
      insideWindow: position.bounds.y + position.bounds.height <= position.viewportHeight };
  }, { timeout: 5000, message: 'Error clears the sticky header and remains fully visible after Tab focus scrolling' }).toEqual({ belowHeader: true, insideWindow: true });
  return position.bounds;
}
async function inspectLeftPanel(width, registerPosition = 'below') {
  await page.setViewportSize({ width, height: 1000 });
  await page.getByLabel('Register position', { exact: true }).selectOption(registerPosition);
  const panel = page.locator('.takeoff-markup-settings'), viewer = page.locator('.takeoff-viewport');
  await viewer.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const metrics = await panel.evaluate(el => {
    const viewer = document.querySelector('.takeoff-viewport'), rail = document.querySelector('.takeoff-tool-rail');
    const bounds = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height }; };
    return { panel: bounds(el), viewer: bounds(viewer), rail: bounds(rail), overlay: getComputedStyle(el).position === 'absolute', overflowY: getComputedStyle(el).overflowY,
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      fields: [...el.querySelectorAll('.field')].filter(node => node.getClientRects().length).map(bounds),
      controls: [...el.querySelectorAll('.field input,.field select')].filter(node => node.getClientRects().length).map(bounds) };
  });
  assert.ok(Math.abs(metrics.panel.top - metrics.viewer.top) <= 1, `${width}/${registerPosition}: panel starts with PDF viewer`);
  assert.ok(metrics.panel.bottom <= metrics.viewer.bottom + 1, `${width}/${registerPosition}: panel ends within PDF viewer`);
  assert.ok(metrics.panel.left >= metrics.rail.right, `${width}/${registerPosition}: panel follows tool rail`);
  if (metrics.overlay) assert.ok(Math.abs(metrics.panel.left - metrics.viewer.left) <= 1, `${width}/${registerPosition}: narrow panel overlays left edge`);
  else assert.ok(metrics.panel.right <= metrics.viewer.left, `${width}/${registerPosition}: panel is left of drawing`);
  assert.equal(metrics.overflowY, 'auto'); assert.ok(metrics.scrollHeight > metrics.clientHeight, 'Long settings have their own vertical scrollbar');
  assert.ok(metrics.fields.length >= 4);
  assert.ok(Math.abs(metrics.fields[0].top - metrics.fields[1].top) <= 1 && metrics.fields[0].right <= metrics.fields[1].left, 'At least two controls fit each row');
  for (const bounds of metrics.controls) assert.ok(bounds.left >= metrics.panel.left && bounds.right <= metrics.panel.right, `${width}/${registerPosition}: fields stay inside settings pane`);
  const before = await page.evaluate(() => ({ y: window.scrollY, drawing: document.querySelector('.takeoff-viewport').scrollTop }));
  const box = await panel.boundingBox(); await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height / 2, 800)); await page.mouse.wheel(0, 450);
  await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const after = await page.evaluate(() => ({ y: window.scrollY, drawing: document.querySelector('.takeoff-viewport').scrollTop }));
  assert.deepEqual(after, before, 'Scrolling settings does not scroll the drawing or page');
  await page.screenshot({ path: path.join(output, `left-settings-${width}-${registerPosition}.png`) });
  evidence[`settings${width}-${registerPosition}`] = metrics;
}
async function fitPageMatrix() {
  const protectedBefore = await snapshot();
  const calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const fit = page.getByRole('button', { name: 'Fit page', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const metrics = () => page.evaluate(() => {
    const frame = document.querySelector('.takeoff-viewport'), canvas = frame.querySelector('canvas');
    const bounds = frame.getBoundingClientRect(), paper = canvas.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
    return { top: bounds.top, headerBottom: header.bottom, scrollY: window.scrollY,
      frame: { width: frame.clientWidth, height: frame.clientHeight },
      paper: { x: paper.left - bounds.left - frame.clientLeft, y: paper.top - bounds.top - frame.clientTop, width: paper.width, height: paper.height },
      page: document.querySelector('.takeoff-page-input').value,
      detailsOpen: document.querySelector('.takeoff-tool-rail [aria-controls="takeoff-markup-settings"], .takeoff-tool-rail [aria-controls="takeoff-physical-details"]').getAttribute('aria-expanded') };
  });
  evidence.fitPage = [];
  // Page 3 is a true portrait viewport after its retained rotation, crop and
  // UserUnit are applied; page 1 is landscape. Both use the uploaded original.
  for (const [mode, scope] of [['STEEL'], ['DUCT'], ['WALLS'], ['SLABS'], ['PENETRATIONS', 'Defect Reports'], ['PENETRATIONS', 'Service Plans']]) {
    await page.getByRole('tab', { name: mode, exact: true }).click(); await settingsSettled(page);
    if (scope) { await page.getByRole('tab', { name: scope, exact: true }).click(); await settingsSettled(page); }
    for (const width of [1146, 764]) {
      await page.setViewportSize({ width, height: 764 });
      for (const [orientation, number, aspect] of [['landscape', 1, 842 / 595], ['portrait-rotated-crop-UserUnit2', 3, 540 / 780]]) {
        if (await settings.getAttribute('aria-expanded') === 'true') await settings.click();
        if (Number(await page.getByLabel('Page number', { exact: true }).inputValue()) !== number) {
          await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill(String(number)); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, number);
        }
        for (const detailsOpen of [false, true]) {
          if ((await settings.getAttribute('aria-expanded') === 'true') !== detailsOpen) await settings.click();
          await settingsSettled(page);
          // Start away from the viewer. Clicking the real bottom-toolbar button
          // also exercises browser focus/scrolling before Fit applies its snap.
          await page.evaluate(() => window.scrollTo(0, 0));
          await renderDrawing(page, () => fit.click(), number);
          const first = await metrics(), label = `${scope || mode}/${width}/${orientation}/${detailsOpen ? 'details' : 'closed'}`;
          assert.ok(Math.abs(first.top - first.headerBottom) <= 1, `${label}: Fit aligns the viewer immediately below the actual sticky header: ${JSON.stringify(first)}`);
          assert.equal(first.detailsOpen, String(detailsOpen), `${label}: Fit preserves the open details pane`);
          assert.equal(first.page, String(number));
          assert.ok(first.paper.x >= -1 && first.paper.y >= -1 && first.paper.x + first.paper.width <= first.frame.width + 1 && first.paper.y + first.paper.height <= first.frame.height + 1, `${label}: the entire PDF stays fitted inside its viewport`);
          assert.ok(Math.abs(first.paper.width / first.paper.height - aspect) < .001, `${label}: source page aspect is retained`);
          await renderDrawing(page, () => fit.click(), number);
          const second = await metrics();
          for (const key of ['top', 'headerBottom', 'scrollY']) assert.ok(Math.abs(first[key] - second[key]) <= 1, `${label}: repeat Fit keeps ${key} stable`);
          for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(first.paper[key] - second.paper[key]) <= .1, `${label}: repeat Fit preserves PDF ${key}`);
          assert.equal(second.detailsOpen, first.detailsOpen);
          evidence.fitPage.push({ label, ...second });
          if (mode === 'STEEL' && detailsOpen && ((width === 1146 && number === 3) || (width === 764 && number === 1))) {
            await page.screenshot({ path: path.join(output, `fit-page-${width}-${orientation}.png`) });
          }
        }
        if (await settings.getAttribute('aria-expanded') === 'true') await settings.click();
      }
    }
  }
  const protectedAfter = await snapshot();
  for (const key of ['documents', 'items', 'calibrations', 'viewports', 'physical', 'service_plans']) assert.deepEqual(protectedAfter[key], protectedBefore[key], `Fit preserves ${key}`);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore, 'Fit preserves every calculator');
  assert.equal(evidence.fitPage.length, 48);
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 900 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) operations.push(request.postDataJSON()?.op); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
  await page.getByRole('button',{name:'Takeoffs',exact:true}).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await settingsSettled(page);
  const navigation = page.getByRole('group', { name: 'Page navigation', exact: true });
  assert.deepEqual(await navigation.getByRole('button').evaluateAll(nodes => nodes.map(el => el.getAttribute('aria-label'))), ['First page', '‹ Page', 'Page ›', 'Last page']);
  for (const name of ['First page', 'Last page']) {
    const button = navigation.getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('title', name); await expect(button.locator('svg')).toHaveCount(1);
  }
  await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('4');
  await command(() => page.getByRole('button', { name: 'First page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
  await command(() => page.getByRole('button', { name: '‹ Page', exact: true }).click(), 'record_render');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('3');
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  evidence.firstLastNavigation = true;

  const scale = page.getByRole('button', { name: 'Scale', exact: true }), popup = page.getByRole('group', { name: 'Drawing scale', exact: true }), calibrate = popup.getByRole('button', { name: 'Calibrate', exact: true });
  await expect(page.locator('.takeoff-tool-rail > [data-tool="calibrate"]')).toHaveCount(0);
  await scale.click(); await expect(calibrate).toBeVisible(); await expect(calibrate.locator('svg')).toHaveCount(0);
  const calibrationButtons=await popup.locator('button').evaluateAll(buttons=>buttons.map(button=>{const r=button.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,right:r.right};}));
  assert.equal(calibrationButtons.length,2);assert.ok(Math.abs(calibrationButtons[0].y-calibrationButtons[1].y)<=1&&calibrationButtons[0].right<=calibrationButtons[1].x,'Calibrate and Edit calibration share one row');
  evidence.calibrationButtons=calibrationButtons;
  assert.deepEqual(await popup.evaluate(el => [...el.children].map(child => child.tagName === 'SELECT' ? child.id : child.textContent)), ['takeoff-calibration', 'Calibrate', 'Edit calibration']);
  await calibrate.click(); await expect(popup).toBeHidden(); await expect(scale).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'calibrate');
  await page.mouse.click(...await sourcePoint([350, 300]), { button: 'right' });
  await expect(page.locator('.takeoff-viewport')).toHaveAttribute('data-tool', 'select');
  assert.equal((await snapshot()).calibrations.length, 0);
  await scale.click(); await page.getByLabel('Drawing calibration', { exact: true }).selectOption('scale:100');
  await command(() => dialog('Apply drawing scale 1:100?', {}, 'Apply scale'), 'add_calibration');
  await expect(popup).toBeHidden(); await expect(scale).toHaveAttribute('title', /1:100/); evidence.calibrationPopup = true;

  await page.getByRole('button', { name: 'Trace length', exact: true }).click();
  await page.mouse.click(...await sourcePoint([300, 400]));
  await page.mouse.move(...await sourcePoint([450, 500]));
  const pendingLength = page.locator('polyline.takeoff-pending'); await expect(pendingLength).toBeVisible();
  assert.equal(await pendingLength.evaluate(el => getComputedStyle(el).fill), 'none', 'Open length tracing never fills an area');
  assert.equal(await pendingLength.evaluate(el => getComputedStyle(el).filter), 'none', 'Length preview has no shadow');
  await page.mouse.dblclick(...await sourcePoint([550, 400]));
  let reply = await command(() => dialog('Add steel object', { 'Member mark': 'TOOLBAR-STEEL', 'Count/QTY': 2 }, 'Add item'), 'create_item');
  const item = reply.snapshot.items[0];
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const width of [1800, 1146, 764, 500]) await inspectLeftPanel(width);
  await inspectLeftPanel(1146, 'beside');
  await page.getByLabel('Register position', { exact: true }).selectOption('below');
  await page.setViewportSize({ width: 1146, height: 900 });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const selectedLength = page.locator('polyline.takeoff-markup.selected');
  await expect(selectedLength).toHaveCount(1); assert.equal(await selectedLength.evaluate(el => getComputedStyle(el).filter), 'none', 'Selected length uses control points instead of a red glow');
  // View returns to the drawing; Edit opens the single settings pane from the register.
  await page.setViewportSize({width:1146,height:764});
  const row=page.locator(`tr[data-item-id="${item.id}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator('.takeoff-row-link').click();
  await expect(page.locator('.takeoff-viewport')).toBeFocused();await idle();
  const viewBounds=await page.locator('.takeoff-viewport').boundingBox(),headerBounds=await page.locator('.app-header').boundingBox();
  assert.ok(viewBounds.y>=headerBounds.y+headerBounds.height&&viewBounds.y<headerBounds.y+headerBounds.height+30,'View snaps drawing below the sticky header at 1146x764');
  await row.getByRole('button',{name:'Edit item',exact:true}).click();
  const editor=page.locator('#takeoff-markup-settings');await expect(editor).toBeFocused();
  await expect(page.locator('.takeoff-register-editor')).toHaveCount(0);
  const editBounds=await editor.boundingBox();assert.ok(editBounds.y>=headerBounds.y+headerBounds.height&&editBounds.y<headerBounds.y+headerBounds.height+30,'Edit brings settings into view');
  assert.equal(await editor.evaluate(el=>el.scrollTop),0,'Edit starts at the beginning of its independent settings scrollbar');
  await expect(editor.getByRole('button',{name:/Apply settings|Discard settings|Apply item edits|Discard edits/})).toHaveCount(0);
  const appearanceOrder=await editor.locator('.takeoff-settings-fields>.field').evaluateAll(fields=>fields.slice(0,6).map(field=>field.textContent.trim()));
  assert.deepEqual(appearanceOrder,['Line Colour','Line Width','Fill colour','Fill enabled','Opacity%','Display Values']);
  await editSettings(page,{'Level':'AUTO-LEVEL'});
  const afterEdit=await snapshot();assert.equal(afterEdit.items.find(value=>value.id===item.id).fields.level,'AUTO-LEVEL');
  assert.deepEqual(afterEdit.items.find(value=>value.id===item.id).geometry,item.geometry);
  await editor.getByRole('button',{name:'Close settings',exact:true}).click();
  const beforeDirty=await snapshot();evidence.viewEditNavigation={viewport:{width:1146,height:764},viewBounds,editBounds,automaticUpdate:true,inlineEditorRemoved:true};

  for (const width of [1146, 764]) {
    await page.setViewportSize({ width, height: 900 });
    await navigation.scrollIntoViewIfNeeded();
    const layout = await navigation.evaluate(el => {
      const viewer = el.closest('.takeoff-viewer').getBoundingClientRect(), group = el.getBoundingClientRect(), controls = [...el.querySelectorAll('button,input')].map(node => node.getBoundingClientRect());
      return { viewer: { left: viewer.left, right: viewer.right }, group: { left: group.left, right: group.right }, controls: controls.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
    });
    assert.ok(layout.group.left >= layout.viewer.left && layout.group.right <= layout.viewer.right, `${width}: page group fits inside viewer`);
    for (const bounds of layout.controls) assert.ok(bounds.left >= layout.group.left && bounds.right <= layout.group.right, `${width}: page buttons remain within their group`);
    assert.ok(Math.max(...layout.controls.map(rect => rect.top)) - Math.min(...layout.controls.map(rect => rect.top)) < 8, `${width}: page buttons remain on one row`);
    const before = await snapshot();
    await page.getByLabel('Page number', { exact: true }).fill('0'); await page.getByLabel('Page number', { exact: true }).press('Tab');
    await expect(page.locator('#takeoffs-workspace [role="alert"]')).toHaveText('Choose a page within this document.');
    const errorBounds = await assertErrorVisible(); assert.deepEqual(await snapshot(), before, 'Invalid page does not change the retained document or item');
    await page.screenshot({ path: path.join(output, `error-visible-${width}.png`) });
    await command(() => page.getByRole('button', { name: 'Last page', exact: true }).click(), 'record_render');
    await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('4');
    await navigation.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `page-controls-${width}.png`) });
    evidence[`width${width}`] = { layout, errorBounds };
  }
  await fitPageMatrix();
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  const final = await snapshot(); assert.deepEqual(final.items, beforeDirty.items); assert.deepEqual(final.calibrations, beforeDirty.calibrations);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, errors, item: final.items[0], sourceHash: final.documents[0].sha256 }, null, 2));
  console.log(`PASS: Scale calibration, first/last page controls, View/Edit navigation, automatic settings, visible errors, responsive toolbar and 48 explicit/repeated Fit page combinations. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-5000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
