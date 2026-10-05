const { chooseTakeoff, takeoffChoice } = require('./section_navigation.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
// Native browser gestures use synthetic PDFs and disposable projects only.
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { renderDrawing } = require('./viewer_helpers.cjs');
const root = path.resolve(__dirname, '../..');
const layoutReview = process.argv.includes('--layout-review');
const autosaveDragReview = process.argv.includes('--autosave-drag');
const output = path.join(root, '.runtime/browser-qa', `physical-interactions-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || 'python';
fs.mkdirSync(output, { recursive: true });
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '', state, origin;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], caughtFindErrors = [], vendorFindProbes = [], requests = [], evidence = { scopes: [], responsive: [] };
const details = () => page.getByRole('complementary', { name: 'Item Details', exact: true });
const row = id => page.locator(`tr[data-physical-id="${id}"]`);
const marker = id => page.locator(`.takeoff-physical-marker-hit[data-physical-id="${id}"]`);
const callout = id => page.locator(`.takeoff-physical-callout[data-physical-id="${id}"]`);
const frame = id => callout(id).locator('.takeoff-physical-callout-frame');
const sha = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const graph = scope => state[scope === 'service_plans' ? 'service_plans' : 'physical'];
const entity = (scope, id) => ['defects', 'barriers', 'services'].flatMap(key => graph(scope)?.[key] || []).find(value => value.id === id);
async function idle() {
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true');
}
async function snapshot() {
  await idle(); await expect.poll(async () => { try { state = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return state;
}
async function response(action, suffix) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(value)); if (!suffix.endsWith('/preview')) await idle(); return value;
}
async function dialog(title, fields, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(fields)) {
    const control = modal.getByLabel(label, { exact: true });
    if (await control.evaluate(el => el.tagName) === 'SELECT') await control.selectOption(String(value)); else await control.fill(String(value));
  }
  await modal.getByRole('button', { name: action, exact: true }).click();
}
async function create(kind, fields, trigger) {
  await trigger(); const preview = await response(() => dialog(`Create draft ${kind}`, fields, 'Preview new draft'), '/physical/preview');
  await response(() => dialog(`Create one draft ${kind}?`, {}, 'Apply draft change'), '/physical/apply'); await snapshot(); return preview.changed_ids[0];
}
async function scopeTab(name) {
  await chooseTakeoff(page, name); await idle(); await expect(takeoffChoice(page, name)).toHaveAttribute('aria-pressed', 'true');
}
async function selectBarrier(id) {
  await row(id).locator('.takeoff-row-link').click(); await idle(); await expect(details()).toBeVisible();
  await expect(details().getByLabel('Location', { exact: true })).toBeVisible();
}
async function closeDetails() {
  if (await details().isVisible()) await page.getByRole('button', { name: 'Close Item Details', exact: true }).click();
  await expect(details()).not.toBeVisible();
}
async function fit() {
  await renderDrawing(page, () => page.getByRole('button', { name: 'Fit page', exact: true }).click());
}
async function drawingPoint(point, pageNumber) {
  const overlay = await page.locator('.takeoff-overlay').boundingBox();
  const mapped = pageNumber === 3
    ? [overlay.x + (point[1] - 30) / 540 * overlay.width, overlay.y + (point[0] - 20) / 780 * overlay.height]
    : [overlay.x + point[0] / 842 * overlay.width, overlay.y + (595 - point[1]) / 595 * overlay.height];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport'), mapped), true, `Source point is visible on the plan: ${mapped}`);
  return mapped;
}
async function drag(locator, dx, dy) {
  const box = await locator.boundingBox(); assert.ok(box, 'A native drag target must have a visible box');
  const start = [box.x + box.width / 2, box.y + box.height / 2];
  const target = await page.evaluate(([x, y]) => ({ className: document.elementFromPoint(x, y)?.getAttribute('class'), viewport: !!document.elementFromPoint(x, y)?.closest('.takeoff-viewport') }), start);
  assert.ok(target.viewport, `Native pointer reaches drawing, rather than a floating pane: ${JSON.stringify(target)}`);
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0] + dx, start[1] + dy, { steps: 8 }); await page.mouse.up();
}
async function frameBox(id) {
  return frame(id).evaluate(el => Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(el.getAttribute(key))])));
}
async function textFits(id) {
  const result = await callout(id).evaluate(el => {
    const rect = el.querySelector('.takeoff-physical-callout-frame'), r = rect.getBBox(), text = el.querySelector('text'), t = text.getBBox();
    return { frame: { x: r.x, y: r.y, width: r.width, height: r.height }, text: { x: t.x, y: t.y, width: t.width, height: t.height }, lines: [...text.querySelectorAll('tspan')].map(span => ({ text: span.textContent, width: span.getComputedTextLength() })), fontSize: Number(text.getAttribute('font-size')) };
  });
  assert.ok(result.text.x >= result.frame.x && result.text.x + result.text.width <= result.frame.x + result.frame.width + .1, `Measured text fits callout width: ${JSON.stringify(result)}`);
  assert.ok(result.text.y >= result.frame.y && result.text.y + result.text.height <= result.frame.y + result.frame.height + .1, `Measured text fits callout height: ${JSON.stringify(result)}`);
  assert.ok(result.lines.some(line => line.width > result.frame.width * .65), 'Text uses available width instead of an arbitrary short character limit');
  return result;
}
async function automaticField(id, label, value) {
  const control = details().getByLabel(label, { exact: true });
  await response(async () => { await control.fill(value); await control.press('Tab'); }, '/physical/apply');
  await expect(page.getByRole('dialog')).toHaveCount(0); await snapshot();
  assert.equal(entity(currentScope, id).fields[label === 'Location' ? 'location' : 'notes'], value);
}
async function selectDrawingBehavior(scope, barrier, defect) {
  await closeDetails(); await fit();
  for (const input of ['pointer', 'Enter', ' ']) {
    if (input === 'pointer') await frame(barrier).click(); else await callout(barrier).press(input);
    await expect(details()).not.toBeVisible(); await expect(callout(barrier)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.takeoff-physical-callout-handle')).toHaveCount(4);
  }
  await page.getByRole('button', { name: 'Resize callout se', exact: true }).click(); await expect(details()).not.toBeVisible();
  await marker(barrier).click(); await expect(details()).not.toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.takeoff-physical-selection')).toHaveCount(1);
  await marker(barrier).dblclick({ delay: 100 }); await expect(details()).toBeVisible();
  if (defect) await expect(details().getByLabel('Defect ID in Item Details', { exact: true })).toHaveValue(defect);
  for (const input of ['pointer', 'Enter', ' ']) {
    if (input === 'pointer') await frame(barrier).click(); else await callout(barrier).press(input);
    await expect(details()).toBeVisible(); await expect(callout(barrier)).toHaveAttribute('aria-pressed', 'true');
  }
  await callout(barrier).press('Control+Enter'); await expect(details()).toBeVisible(); await expect(callout(barrier)).toHaveAttribute('aria-pressed', 'false');
  await callout(barrier).press('Enter'); await expect(details()).toBeVisible(); await expect(callout(barrier)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join(output, `${scope}-callout-selected-pane-open.png`), fullPage: true });
  await marker(barrier).click({ modifiers: ['Control'] }); await expect(details()).not.toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'false');
  await marker(barrier).press('Enter'); await expect(details()).toBeVisible();
  await marker(barrier).press(' '); await expect(details()).toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'true');
  await marker(barrier).press('Control+Space'); await expect(details()).not.toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'false');
  await marker(barrier).press('Enter'); await expect(details()).toBeVisible();
  // The existing post-drag guard ignores pointer-release echo clicks for500ms;
  // keyboard actions above are intentionally exercised inside that interval.
  await page.waitForTimeout(550);
  await page.mouse.click(...await drawingPoint(scope === 'service_plans' ? [80, 470] : [550, 500], scope === 'service_plans' ? 3 : 1));
  await expect(details()).not.toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'false');
  (evidence.selection ||= []).push({ scope, calloutPointerAndKeyboardPreservePane: true, calloutModifierDeselectionPreservesOpenPane: true, resizeHandleClickPreservesClosedPane: true, markerSingleSelectsDoubleOpens: true, selectedMarkerHalo: true, keyboardOpensModifierDeselects: true, blankPageClearsSelection: true });
}
async function compareAddServiceStyle(scope) {
  await page.mouse.move(0, 0);
  await expect.poll(() => details().getByRole('button', { name: 'Add service in Item Details', exact: true }).evaluate(service => service.matches(':hover') || document.querySelector('.takeoff-physical-add-row .takeoff-physical-add-defect').matches(':hover')), { message: 'Neither compact plus is hovered for the base-style comparison' }).toBe(false);
  const measure = () => details().getByRole('button', { name: 'Add service in Item Details', exact: true }).evaluate(service => {
    const substrate = document.querySelector('.takeoff-physical-add-row .takeoff-physical-add-defect');
    const read = el => { const css = getComputedStyle(el), rect = el.getBoundingClientRect(); return { text: el.textContent, width: rect.width, height: rect.height, ...Object.fromEntries(['display','alignItems','justifyContent','color','backgroundColor','fontSize','fontWeight','lineHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopStyle','borderTopColor','borderRadius','boxShadow'].map(key => [key, css[key]])) }; };
    return { service: read(service), substrate: read(substrate), sharedClasses: [...substrate.classList].every(value => service.classList.contains(value)) };
  });
  let measured = await measure();
  // Native pointer position is neutral; retain exact settled computed styles.
  await expect.poll(async () => { measured = await measure(); return measured.service; }, { message: 'The Add service style settles to the exact register plus style' }).toEqual(measured.substrate);
  assert.equal(measured.sharedClasses, true); assert.deepEqual(measured.service, measured.substrate, 'Add service and the register red plus have identical size, glyph, padding, border and colour');
  assert.equal(measured.service.fontSize, '22px'); (evidence.addServiceStyle ||= []).push({ scope, ...measured });
}
async function reviewAutosaveDrag(scope, barrier, service, pageNumber) {
  const cases = [];
  for (const [kind, savingFirst, canceled, clickOnly] of [['marker', false, false, false], ['callout', true, false, false], ['resize', true, false, false], ['marker', true, true, false], ['callout', true, false, true]]) {
    await selectBarrier(barrier); await fit(); await snapshot();
    const original = structuredClone(entity(scope, barrier).marker), serviceBefore = structuredClone(entity(scope, service));
    const target = kind === 'marker' ? marker(barrier) : kind === 'resize' ? page.getByRole('button', { name: 'Resize callout nw', exact: true }) : frame(barrier);
    const dx = clickOnly ? 0 : -12, dy = clickOnly ? 0 : -10;
    const requestStart = requests.length, notes = `${scope} ${kind} delayed save ${savingFirst} canceled ${canceled} click ${clickOnly}`;
    let release, held = false, heldRequest, first = true;
    const blocked = new Promise(resolve => { release = resolve; });
    const activeRoutes = new Set();
    const intercept = route => {
      const action = (async () => { if (first) { first = false; heldRequest = route.request(); held = true; await blocked; } await route.continue(); })();
      activeRoutes.add(action); return action.finally(() => activeRoutes.delete(action));
    };
    await page.route('**/physical/apply', intercept);
    try {
      await details().getByLabel('Notes', { exact: true }).fill(notes);
      if (savingFirst) { await details().getByLabel('Notes', { exact: true }).press('Tab'); await expect.poll(() => held).toBe(true); }
      // Filling a lower pane field may scroll the outer document. Read the
      // native hit position afterward rather than aiming at stale coordinates.
      await target.evaluate(el => {
        const bounds = el.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
        const y = bounds.y + bounds.height / 2;
        if (y < header.bottom + 32) window.scrollBy(0, y - header.bottom - 32);
      });
      const bounds = await target.boundingBox(), start = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
      const hit = await page.evaluate(([x, y]) => ({ className: document.elementFromPoint(x, y)?.getAttribute('class'), physical: !!document.elementFromPoint(x, y)?.closest('.takeoff-physical-callout,.takeoff-physical-marker-hit,.takeoff-physical-callout-handle') }), start);
      assert.ok(hit.physical, `The delayed-save regression reaches its native physical target: ${JSON.stringify(hit)}`);
      await page.mouse.move(...start); await page.mouse.down();
      await expect.poll(() => held).toBe(true);
      await page.mouse.move(start[0] + dx, start[1] + dy, { steps: 4 });
      if (canceled) await page.keyboard.press('Escape');
      await page.mouse.up();
      const pending = await page.evaluate(() => JSON.parse(window.CeasefireTakeoffs.projectFingerprint()));
      const pendingGraph = pending.snapshot[scope === 'service_plans' ? 'service_plans' : 'physical'];
      assert.deepEqual(pendingGraph.barriers.find(value => value.id === barrier).marker, original, 'Pointer movement and release cannot mutate canonical geometry before the field save resolves');
      assert.equal(!!pending.gesture, !canceled, 'The released drag stays reserved until its field save completes, and Escape cancels it');
      assert.equal(requests.slice(requestStart).some(request => request.body.commands?.some(command => command.changes?.marker)), false, 'No marker command enters the backend while the field save is blocked');
      const applied = page.waitForResponse(reply => reply.request() === heldRequest);
      const gestured = canceled || clickOnly ? null : page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/physical/apply') && reply.request() !== heldRequest);
      release();
      assert.equal((await applied).status(), 200); if (gestured) assert.equal((await gestured).status(), 200);
      await snapshot();
      const next = structuredClone(entity(scope, barrier).marker);
      assert.equal(entity(scope, barrier).fields.notes, notes, 'The typed field survives the concurrent pointer action');
      assert.deepEqual(entity(scope, service), serviceBefore, 'Concurrent gestures retain service identity, details and quantity');
      if (canceled || clickOnly) assert.deepEqual(next, original, 'Canceled drag or ordinary click keeps geometry unchanged');
      else if (kind === 'marker') {
        assert.notDeepEqual(next.point, original.point, 'The fast drag is applied after the held save even though pointerup already happened');
        const withoutPoint = value => { const copy = structuredClone(value); delete copy.point; return copy; };
        assert.deepEqual(withoutPoint(next), withoutPoint(original), 'The delayed marker drag changes only its source point');
      } else {
        assert.deepEqual(next.point, original.point, 'Delayed callout gestures retain the marker source point');
        assert.ok(next.callout?.offset.every(Number.isFinite), 'Delayed callout drag/resize persists a finite source layout');
        if (kind === 'resize') assert.ok(next.callout.width > original.callout.width && next.callout.height > original.callout.height, 'The delayed corner resize persists both dimensions');
        else assert.notDeepEqual(next.callout?.offset, original.callout?.offset, 'The delayed callout drag persists its offset');
      }
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(details()).toBeVisible();
      cases.push({ kind, savingFirst, canceled, clickOnly, pageNumber, pointerReleasedBeforeSave: true, fieldRetained: true, geometryBefore: original, geometryAfter: next });
    } finally { release(); await Promise.all([...activeRoutes]); await page.unroute('**/physical/apply', intercept); }
  }
  (evidence.autosaveDrags ||= []).push({ scope, cases });
  console.log(`PASS: ${scope} fast marker/callout drag, corner resize, cancel and click with a held automatic save.`);
}
async function reviewAlignment(scope, barrier) {
  for (const width of [764, 1146]) {
    await page.setViewportSize({ width, height: 764 });
    for (const open of [false, true]) {
      if (open) await selectBarrier(barrier); else await closeDetails();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#takeoff-navigation-toggle').hover();
      const measured = await page.evaluate(() => {
        const bounds = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
        const style = element => Object.fromEntries(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderBottomWidth', 'borderBottomColor', 'borderTopLeftRadius', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'textTransform'].map(key => [key, getComputedStyle(element)[key]]));
        const selected = document.querySelector('#takeoff-navigation-menu [aria-pressed=true]');
        const reference = document.createElement('button'); reference.className = 'calculator-navigation-choice'; reference.setAttribute('aria-pressed', 'true'); document.body.append(reference);
        const referenceStyle = style(reference); reference.remove();
        return { documents: bounds('.takeoff-source-documents'), layout: bounds('.takeoff-drawing-layout'), selectedStyle: style(selected), calculatorStyle: referenceStyle, scopesInMenu: !!document.querySelector('#takeoff-navigation-menu .section-navigation-subgroup [data-physical-scope]'), oldPanelCount: document.querySelectorAll('.takeoff-tab-panel').length };
      });
      assert.ok(measured.documents.x >= measured.layout.x && measured.documents.x + measured.documents.width <= measured.layout.x + measured.layout.width + 1, 'Source dropdown remains in the drawing overlay with Item Details open or closed');
      assert.equal(measured.scopesInMenu, true); assert.equal(measured.oldPanelCount, 0);
      assert.deepEqual(measured.selectedStyle, measured.calculatorStyle, 'Takeoffs selection matches the existing Calculators dropdown style');
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(output, `${scope}-${width}-details-${open ? 'open' : 'closed'}-alignment.png`), fullPage: true });
      (evidence.alignment ||= []).push({ scope, width, detailsOpen: open, ...measured });
    }
  }
}
let currentScope = 'defect_reports';

(async () => {
  const info = await ready; assert.notEqual(info.port, 8765, 'Never use the live server'); origin = `http://127.0.0.1:${info.port}`;
  const sourceBefore = sha(info.fixture); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1146, height: 764 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
  // The UI catches edit errors, so pageerror alone cannot reproduce a caught .find failure.
  const debuggerSession = await page.context().newCDPSession(page), scripts = new Map();
  debuggerSession.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, event.url));
  debuggerSession.on('Debugger.paused', event => {
    const message = event.data?.description || event.data?.value || '';
    if (/find[\s\S]*function|function[\s\S]*find/i.test(message)) {
      const failure = { message, reason: event.reason, stack: event.callFrames.map(frame => ({ function: frame.functionName, url: frame.url || scripts.get(frame.location.scriptId), line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1 })) };
      // PDF.js deliberately invokes Iterator.find(-1) inside try/catch to test closing behavior.
      const probe = message.split('\n')[0] === 'TypeError: number -1 is not a function' && failure.stack[0]?.function === 'module.exports' && failure.stack.every(frame => frame.url?.endsWith('/vendor/pdfjs/build/pdf.mjs'));
      (probe ? vendorFindProbes : caughtFindErrors).push(failure);
    }
    void debuggerSession.send('Debugger.resume').catch(() => {});
  });
  await debuggerSession.send('Debugger.enable'); await debuggerSession.send('Debugger.setPauseOnExceptions', { state: 'all' });
  page.on('request', request => { if (/\/physical\/(preview|apply)$/.test(new URL(request.url()).pathname)) requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.goto(origin); await expect.poll(() => page.evaluate(() => window.CeasefireDesktop?.status().ready)).toBe(true);
  const calculatorsBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'PENETRATIONS');
  await renderDrawing(page, () => page.locator('#takeoff-upload').setInputFiles(info.fixture), 1);
  const retained = [];
  for (const scope of ['defect_reports', 'service_plans']) {
    currentScope = scope; await scopeTab(scope === 'service_plans' ? 'Service Plans' : 'Defect Reports');
    let defect;
    if (scope === 'defect_reports') defect = await create('defect', { 'Defect Ref.': 'INTERACTION-A', FRL: '-/120/120' }, () => page.getByRole('button', { name: 'Add defect', exact: true }).click());
    const barrier = await create('barrier', { Location: 'North plant room', 'Barrier type': 'Core hole', Substrate: 'Concrete/masonry wall', 'Substrate orientation': 'Vertical', ...(scope === 'service_plans' ? { FRL: '-/90/90' } : {}) }, () => page.getByRole('button', { name: scope === 'service_plans' ? 'Add substrate' : 'Add barrier to D-0001', exact: true }).click());
    await compareAddServiceStyle(scope);
    const service = await create('service', { Category: 'Mechanical', 'Explicit service quantity': 2, 'Service Size (mm)': '100' }, () => page.getByRole('button', { name: 'Add service in Item Details', exact: true }).click());
    await selectBarrier(barrier);
    if (layoutReview) {
      const pageNumber = scope === 'service_plans' ? 3 : 1;
      if (pageNumber === 3) await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
      await details().getByRole('button', { name: 'Place count marker', exact: true }).click(); await closeDetails(); await fit();
      await response(async () => page.mouse.click(...await drawingPoint(pageNumber === 3 ? [410, 470] : [550, 330], pageNumber)), '/physical/apply'); await snapshot();
      await reviewAlignment(scope, barrier); await closeDetails(); await fit();
      await selectDrawingBehavior(scope, barrier, defect);
      evidence.scopes.push({ scope, pageNumber, rapidKeyboardAfterPointer: true });
      console.log(`PASS: ${scope} full-width source documents, grouped Firestopping tabs and rapid keyboard regression.`);
      continue;
    }
    const entityBefore = structuredClone(entity(scope, barrier)), serviceBefore = structuredClone(entity(scope, service));
    const location = 'North plant room beside the long corridor with a wide beam and electrical services';
    await automaticField(barrier, 'Location', location); assert.equal(entity(scope, barrier).defect_id, entityBefore.defect_id); assert.deepEqual(entity(scope, service), serviceBefore);
    await automaticField(barrier, 'Notes', 'Automatic edit retained without a preview button.');
    await expect(details().getByRole('button', { name: 'Preview physical edits', exact: true })).toHaveCount(0);
    const pageNumber = scope === 'service_plans' ? 3 : 1;
    if (pageNumber === 3) await renderDrawing(page, async () => { await page.getByLabel('Page number', { exact: true }).fill('3'); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 3);
    await selectBarrier(barrier); await details().getByRole('button', { name: 'Place count marker', exact: true }).click(); await closeDetails(); await fit();
    await response(async () => page.mouse.click(...await drawingPoint(pageNumber === 3 ? [410, 470] : [550, 330], pageNumber)), '/physical/apply');
    await snapshot(); await expect(marker(barrier)).toBeVisible(); await expect(marker(barrier)).toHaveAttribute('aria-pressed', 'true');
    await reviewAutosaveDrag(scope, barrier, service, pageNumber);
    if (autosaveDragReview) {
      retained.push({ scope, barrier, service, marker: structuredClone(entity(scope, barrier).marker) });
      evidence.scopes.push({ scope, pageNumber, delayedAutomaticSave: true }); continue;
    }
    const placed = structuredClone(entity(scope, barrier).marker);
    assert.equal(placed.page, pageNumber); assert.equal(placed.document_sha256, sourceBefore);
    await closeDetails(); await fit();
    await response(() => drag(marker(barrier), -18, 14), '/physical/apply'); await snapshot();
    await expect(details()).not.toBeVisible();
    const moved = structuredClone(entity(scope, barrier).marker); assert.notDeepEqual(moved.point, placed.point);
    const withoutPoint = value => { const copy = structuredClone(value); delete copy.point; return copy; };
    assert.deepEqual(withoutPoint(moved), withoutPoint(placed), 'Marker drag changes only its source point'); assert.deepEqual(entity(scope, service), serviceBefore);
    await closeDetails(); await fit(); const beforeCallout = await frameBox(barrier);
    await response(() => drag(frame(barrier), -24, -20), '/physical/apply'); await snapshot();
    await expect(details()).not.toBeVisible();
    const layout = structuredClone(entity(scope, barrier).marker.callout); assert.ok(layout?.offset.every(Number.isFinite)); assert.deepEqual(entity(scope, barrier).marker.point, moved.point);
    await closeDetails(); await fit(); const draggedCallout = await frameBox(barrier);
    assert.ok(Math.abs(draggedCallout.x - beforeCallout.x + 24) < 2 && Math.abs(draggedCallout.y - beforeCallout.y + 20) < 2, 'Callout drag persists its screen-equivalent source offset');
    const corners = [];
    for (const [corner, dx, dy] of [['nw', -12, -10], ['ne', 14, -10], ['sw', -12, 10], ['se', 14, 10]]) {
      await closeDetails(); await fit(); await expect(page.locator('.takeoff-physical-callout-handle')).toHaveCount(4);
      const prior = structuredClone(entity(scope, barrier).marker.callout), handle = page.getByRole('button', { name: `Resize callout ${corner}`, exact: true });
      await response(() => drag(handle, dx, dy), '/physical/apply'); await snapshot();
      await expect(details()).not.toBeVisible();
      const next = structuredClone(entity(scope, barrier).marker.callout); assert.ok(next.width > prior.width && next.height > prior.height, `${corner} corner enlarges both callout dimensions`);
      assert.deepEqual(entity(scope, barrier).marker.point, moved.point); assert.deepEqual(entity(scope, service), serviceBefore); corners.push({ corner, before: prior, after: next });
    }
    await closeDetails(); await fit(); const text = await textFits(barrier);
    await selectDrawingBehavior(scope, barrier, defect);
    await reviewAlignment(scope, barrier);
    await closeDetails(); await fit(); await page.screenshot({ path: path.join(output, `${scope}-1146.png`), fullPage: true });
    for (const width of [764, 1146]) {
      await page.setViewportSize({ width, height: 764 }); await closeDetails(); await fit(); await textFits(barrier);
      const stable = structuredClone(entity(scope, barrier).marker);
      await renderDrawing(page, () => page.getByRole('button', { name: '+', exact: true }).click());
      await renderDrawing(page, () => page.getByRole('button', { name: '−', exact: true }).click()); await snapshot(); assert.deepEqual(entity(scope, barrier).marker, stable);
      await fit(); await page.screenshot({ path: path.join(output, `${scope}-${width}-zoom.png`), fullPage: true }); evidence.responsive.push({ scope, width, pageNumber, zoomRetainsMarkerAndCallout: true });
    }
    retained.push({ scope, barrier, service, marker: structuredClone(entity(scope, barrier).marker) });
    evidence.scopes.push({ scope, barrier, service, defect, pageNumber, automaticEdits: true, markerDragPreservesClosedPane: true, calloutDragPreservesClosedPane: true, calloutDrag: layout, corners, measuredText: text, calloutSelectionPreservesPane: true, markerSingleSelectsDoubleOpens: true, rapidKeyboardAfterPointer: true });
    console.log(`PASS: ${scope} automatic edits, marker/callout drag, four corners, measured text and responsive zoom.`);
  }
  if (layoutReview) {
    assert.deepEqual(errors, []); assert.deepEqual(caughtFindErrors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
    assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore); assert.equal(sha(info.fixture), sourceBefore);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, layoutReview: true, evidence, requests, errors, caughtFindErrors, vendorFindProbes }, null, 2));
    console.log(`PASS: Focused layout and keyboard review; source PDF and calculators unchanged. Evidence: ${output}`); return;
  }
  await snapshot(); const beforeSave = structuredClone(state);
  await response(() => clickProjectControl(page, 'Save As'), '/api/project/save-as'); await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project, 'utf8')); assert.deepEqual(saved.takeoffs.physical, beforeSave.physical); assert.deepEqual(saved.takeoffs.service_plans, beforeSave.service_plans);
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open'); await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await snapshot(); assert.deepEqual(state.physical, beforeSave.physical); assert.deepEqual(state.service_plans, beforeSave.service_plans);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorsBefore); assert.equal(sha(info.fixture), sourceBefore); assert.deepEqual(errors, []); assert.deepEqual(caughtFindErrors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  evidence.savedReopened = true; evidence.retained = retained; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, requests, errors, caughtFindErrors, vendorFindProbes }, null, 2));
  console.log(`PASS: Physical interaction layout survives Save/reopen; source PDF and calculators unchanged. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-4000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: false, evidence, error: String(error), stack: error.stack, errors, caughtFindErrors, vendorFindProbes, requests }, null, 2)); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
