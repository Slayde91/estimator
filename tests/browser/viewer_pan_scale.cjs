const { chooseTakeoff } = require('./section_navigation.cjs');
// Native Chromium gestures against a disposable server and synthetic PDF only.
const { chromium, expect } = require('@playwright/test');
const { renderDrawing } = require('./viewer_helpers.cjs');
const { settingsSettled } = require('./settings_helpers.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `viewer-pan-scale-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], commands = [], evidence = { scale: [], wheel: [], pan: [] };
const retained = async () => { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); };
async function reveal() {
  await page.locator('.takeoff-viewer').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom - 12));
}
const viewport = () => page.locator('.takeoff-viewport');
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const position = () => page.evaluate(() => {
  const el = document.querySelector('.takeoff-viewport'), paper = el.querySelector('canvas').getBoundingClientRect();
  return { left: el.scrollLeft, top: el.scrollTop, outer: window.scrollY, paper: [paper.x, paper.y], max: [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight] };
});
async function vector(dx, dy) {
  const before = await position();
  await page.mouse.wheel(dx, dy);
  await expect.poll(async () => { const next = await position(); return [next.left, next.top]; }).toEqual([
    Math.max(0, Math.min(before.max[0], before.left + dx)), Math.max(0, Math.min(before.max[1], before.top + dy))
  ]);
  const after = await position(); assert.equal(after.outer, before.outer, 'An available drawing axis keeps the vector inside the PDF viewer');
  evidence.wheel.push({ delta: [dx, dy], before, after });
}
async function scaleGeometry(mode, width) {
  const scale = page.getByRole('button', { name: 'Scale', exact: true }), popup = page.getByRole('group', { name: 'Drawing scale', exact: true });
  await reveal(); await scale.click(); await expect(popup).toBeVisible();
  const geometry = await scale.evaluate(el => {
    const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { button: box(el), popup: box(document.querySelector('#takeoff-scale-controls')), viewer: box(el.closest('.takeoff-viewer')), pages: box(document.querySelector('.takeoff-page-controls')), inRail: !!el.closest('.takeoff-tool-rail') };
  });
  assert.equal(geometry.inRail, false);
  assert.ok(geometry.button.x>=geometry.viewer.x && geometry.button.x-geometry.viewer.x<40, `${mode}/${width}: scale is at the upper left viewer gutter`);
  assert.ok(geometry.button.bottom <= geometry.viewer.bottom);
  assert.ok(geometry.button.y < geometry.pages.y, `${mode}/${width}: scale is above the page controls`);
  assert.ok(geometry.popup.y >= geometry.button.bottom, `${mode}/${width}: scale menu opens below its button`);
  assert.ok(geometry.popup.x >= geometry.viewer.x && geometry.popup.right <= geometry.viewer.right + 1);
  assert.ok(geometry.popup.bottom < geometry.pages.y, `${mode}/${width}: scale menu never overlaps page controls`);
  assert.ok(geometry.pages.x >= geometry.viewer.x && geometry.pages.bottom <= geometry.viewer.bottom + 1);
  await page.keyboard.press('Escape'); await expect(popup).toBeHidden(); await expect(scale).toBeFocused();
  evidence.scale.push({ mode, width, geometry });
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1146, height: 1100 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/commands')) commands.push(request.postDataJSON()?.op); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const initial = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!initial.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await settingsSettled(page);
  for (const width of [1600, 1146, 825, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const mode of ['STEEL', 'DUCT', 'WALLS', 'SLABS', 'PENETRATIONS']) {
      await chooseTakeoff(page, mode); await scaleGeometry(mode, width);
      if (mode === 'PENETRATIONS') {
        await chooseTakeoff(page, 'Service Plans'); await scaleGeometry('Service Plans', width);
        await chooseTakeoff(page, 'Defect Reports');
      }
    }
    await chooseTakeoff(page, 'STEEL');
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await scaleGeometry('STEEL/settings', width);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.screenshot({ path: path.join(output, `scale-overlay-${width}.png`) });
  }
  await page.setViewportSize({ width: 1146, height: 1100 }); await reveal();
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
  const fitPaper=await page.locator('.takeoff-page').boundingBox(),sourceAtFit=await retained();
  await renderDrawing(page,()=>page.getByRole('button',{name:'+',exact:true}).click());
  await renderDrawing(page,()=>viewport().press('Control+0'));
  const shortcutPaper=await page.locator('.takeoff-page').boundingBox();assert.ok(Math.abs(shortcutPaper.width-fitPaper.width)<1&&Math.abs(shortcutPaper.height-fitPaper.height)<1);assert.deepEqual(await retained(),sourceAtFit);
  await expect(page.getByRole('button',{name:'Fit page',exact:true})).toHaveAttribute('aria-keyshortcuts','Control+0');
  const eventFromInput=await page.getByLabel('Page number',{exact:true}).evaluate(el=>{const event=new KeyboardEvent('keydown',{key:'0',ctrlKey:true,bubbles:true,cancelable:true});el.dispatchEvent(event);return event.defaultPrevented;});assert.equal(eventFromInput,false,'Editable controls retain their native shortcut behavior');
  evidence.fitShortcut=true;
  for (let i = 0; i < 4; i++) await renderDrawing(page, () => page.getByRole('button', { name: '+', exact: true }).click());
  await viewport().focus(); await viewport().evaluate(el => { el.scrollLeft = 400; el.scrollTop = 400; });
  const bounds = await viewport().boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const sourceBefore = await retained(), calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await vector(35, 20); const circleStart = await position();
  for (const [x, y] of [[20, 0], [14, 14], [0, 20], [-14, 14], [-20, 0], [-14, -14], [0, -20], [14, -14]]) await vector(x, y);
  const circleEnd = await position(); assert.deepEqual([circleEnd.left, circleEnd.top], [circleStart.left, circleStart.top]);
  // A hand-tool drag follows an unrestricted circular path and returns the
  // paper to its original screen position; source geometry stays untouched.
  await page.getByRole('button', { name: 'Pan', exact: true }).click(); await reveal();
  const frame = await viewport().boundingBox(), center = [frame.x + frame.width / 2, frame.y + frame.height / 2], start = await position();
  await page.mouse.move(...center); await page.mouse.down();
  for (const delta of [[30,20],[40,0],[30,-20],[0,-30],[-30,-20],[-40,0],[-30,20],[0,0]]) {
    await page.mouse.move(center[0] + delta[0], center[1] + delta[1]); await frames(); const next = await position();
    assert.ok(Math.abs(next.paper[0] - start.paper[0] - delta[0]) <= 1.1 && Math.abs(next.paper[1] - start.paper[1] - delta[1]) <= 1.1);
    evidence.pan.push({ delta, paper: next.paper });
  }
  await page.mouse.up(); assert.deepEqual((await position()).paper, start.paper);
  assert.deepEqual(await retained(), sourceBefore); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore);
  // Rounded dimensions can differ from Chromium's true fractional limit.
  // Clamp through the browser, then prove a focused viewer hands the wheel to
  // the outer page when neither drawing axis actually moves.
  await page.evaluate(() => window.scrollTo(0, 100)); await viewport().focus();
  await viewport().evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
  const edgeBefore = await position(), edgeBox = await viewport().boundingBox();
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2); await page.mouse.wheel(0, 180);
  await expect.poll(async () => (await position()).outer).toBeGreaterThan(edgeBefore.outer);
  const edgeAfter = await position(); assert.deepEqual([edgeAfter.left, edgeAfter.top], [edgeBefore.left, edgeBefore.top]);
  evidence.edge = { before: edgeBefore, after: edgeAfter };
  // Release focus: the same wheel input belongs to the outer page again.
  await viewport().press('Escape'); await page.evaluate(() => window.scrollTo(0, 100));
  const beforePage = await position(); await page.mouse.move(center[0], center[1]); await page.mouse.wheel(0, 180);
  await expect.poll(async () => (await position()).outer).toBeGreaterThan(beforePage.outer);
  assert.deepEqual([(await position()).left, (await position()).top], [beforePage.left, beforePage.top]);
  const rotate = page.getByRole('button', { name: 'Rotate page', exact: true }); await expect(rotate.locator('svg')).toHaveCount(1);
  const icon = await rotate.locator('svg').evaluate(el => { const box = el.querySelector('path').getBBox(); return { view: el.getAttribute('viewBox'), stroke: el.getAttribute('stroke-linecap'), d: el.querySelector('path').getAttribute('d'), bounds: [box.x, box.y, box.width, box.height] }; });
  assert.equal(icon.view, '0 0 24 24'); assert.equal(icon.stroke, 'round'); assert.match(icon.d, /M12 6l6 6-6 6-6-6z/); assert.ok(icon.bounds[0] >= 0 && icon.bounds[1] >= 0 && icon.bounds[0] + icon.bounds[2] <= 24 && icon.bounds[1] + icon.bounds[3] <= 24);
  evidence.rotateIcon = icon; assert.deepEqual(errors, []); const csp = await page.evaluate(() => window.qaCsp); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, commands, errors, csp }, null, 2));
  console.log(`PASS: scale opens above a top-left overlay in every mode at four widths, controls never overlap, native two-axis/circular wheel and hand-tool paths preserve original source/calculator data. Evidence: ${output}`);
})().catch(async error => { if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n${logs}`); console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill(); });
