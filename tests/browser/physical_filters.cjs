const { assertParentControls, clickInspectorAdd } = require('./parent_controls_helpers.cjs');
const { chooseTakeoff } = require('./section_navigation.cjs');
// Column filters and automatic editing use an isolated fixture and owned records.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `physical-filters-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, origin, logs = '';
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = { scopes: [] };
const details = () => page.getByRole('complementary', { name: 'Item Details', exact: true });
const row = id => page.locator(`tr[data-physical-id="${id}"]`);
async function idle() { await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true'); await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true'); }
async function rawSnapshot() { const id = await page.evaluate(() => window.CeasefireTakeoffs.sessionId()); const reply = await page.request.get(`${origin}/api/takeoffs/sessions/${id}`); assert.equal(reply.status(), 200); return (await reply.json()).snapshot; }
async function snapshot() { await idle(); return rawSnapshot(); }
async function response(action, suffix) { const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(suffix)); pending.catch(() => {}); await action(); const reply = await pending; assert.equal(reply.status(), 200, await reply.text()); await idle(); return reply.json(); }
async function seed(scope) {
  const ids = Object.fromEntries(['d1', 'd2', 'b1', 'b2', 'b3', 's1', 's2', 's3'].map(key => [key, randomUUID()]));
  const commands = [], entity = (id, fields, more = {}, state = 'not_assessed') => ({ id, fields, evidence: [], uncertainty: { state, note: '' }, ...more });
  const create = (kind, value) => commands.push({ op: 'create', kind, entity: value });
  if (scope === 'defect_reports') { create('defect', entity(ids.d1, { label: 'FILTER-A', location: 'Level01', frl: '-/120/120' })); create('defect', entity(ids.d2, { label: 'FILTER-B', location: 'Level02', frl: '-/90/90' })); }
  const parent = id => scope === 'defect_reports' ? { defect_id: id } : {};
  create('barrier', entity(ids.b1, { location: 'Level01', substrate: 'Concrete/masonry wall', orientation: 'Vertical', ...(scope === 'service_plans' ? { frl: '-/120/120' } : {}) }, parent(ids.d1)));
  create('barrier', entity(ids.b2, { location: 'Level02', substrate: 'Concrete/masonry floor', orientation: 'Horizontal', ...(scope === 'service_plans' ? { frl: '-/90/90' } : {}) }, parent(ids.d2)));
  create('barrier', entity(ids.b3, {}, parent(ids.d1), 'unresolved'));
  create('service', entity(ids.s1, { service: 'Mechanical', service_type: 'Plastic Pipes', size: '25' }, { barrier_id: ids.b1, quantity: 1 }));
  create('service', entity(ids.s2, { service: 'Electrical & Communications', service_type: 'D2 Comms Cables' }, { barrier_id: ids.b1, quantity: 2 }, 'missing'));
  create('service', entity(ids.s3, { service: 'Mechanical', service_type: 'Plastic Pipes' }, { barrier_id: ids.b2, quantity: 3 }));
  commands.push({ op:'update', entity_id:scope==='defect_reports'?ids.d1:ids.b1, changes:{confirmation:'confirmed'} });
  const session = await page.evaluate(() => window.CeasefireTakeoffs.sessionId()), before = await snapshot();
  const previewReply = await page.request.post(`${origin}/api/takeoffs/sessions/${session}/physical/preview`, { data: { scope, expected_revision: before.revision, commands } }); assert.equal(previewReply.status(), 200, await previewReply.text()); const preview = await previewReply.json();
  const applyReply = await page.request.post(`${origin}/api/takeoffs/sessions/${session}/physical/apply`, { data: { scope, expected_revision: preview.revision, request_id: randomUUID(), preview_id: preview.preview_id } }); assert.equal(applyReply.status(), 200, await applyReply.text());
  const applied = await applyReply.json(); assert.ok(applied.snapshot[scope === 'service_plans' ? 'service_plans' : 'physical'].barriers.length);
  await page.evaluate(async value => { const t = window.CeasefireTakeoffs; t.applyProject(await t.prepareProject(value, t.sessionId())); await t.open(); }, applied.snapshot); await idle();
  await chooseTakeoff(page, 'physical'); await chooseTakeoff(page, scope === 'service_plans' ? 'Service Plans' : 'Defect Reports'); await idle(); return ids;
}
async function menu(label) { await page.getByRole('button', { name: `Filter ${label}`, exact: true }).click(); const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: `Filter ${label}`, exact: true })).toBeVisible(); return dialog; }
async function setFilter(label, values) { const dialog = await menu(label); await dialog.getByRole('checkbox', { name: 'Select all values', exact: true }).uncheck(); for (const value of values) await dialog.getByRole('checkbox', { name: value || '(Blanks)', exact: true }).check(); await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click(); await expect(dialog).not.toBeVisible(); }
async function reset(label) { const dialog = await menu(label); await dialog.getByRole('button', { name: 'Reset filter', exact: true }).click(); await expect(dialog).not.toBeVisible(); }
async function visible() { return page.locator('.takeoff-register-table tbody tr').evaluateAll(rows => rows.map(row => ({ id: row.dataset.physicalId, context: [...row.querySelectorAll('small.helper')].some(note => note.textContent.includes('Ancestor context')) }))); }
async function matches(ids) { const expected = [...ids].sort(); await expect.poll(async () => (await visible()).filter(row => !row.context).map(row => row.id).sort()).toEqual(expected); const all = page.getByRole('checkbox', { name: 'Select all matching physical records', exact: true }); await all.check(); await expect.poll(() => page.locator('.takeoff-register-table tbody tr').evaluateAll(rows => rows.filter(row => row.querySelector('input[type=checkbox]')?.checked).map(row => row.dataset.physicalId).sort())).toEqual(expected); await page.getByRole('button', { name: 'Select filtered records', exact: true }).click(); }
async function checkDocuments(scope, ids) {
  const before = await snapshot(), graph = before[scope === 'service_plans' ? 'service_plans' : 'physical'];
  const active = [...(graph.defects || []), ...graph.barriers, ...graph.services].filter(entry => !entry.deleted).map(entry => entry.id);
  const root = page.locator('.takeoff-physical-register'), toggle = root.getByRole('button', { name: 'Document', exact: true }), list = root.locator('.calculator-document-actions');
  await toggle.press('ArrowDown'); await expect(list).toBeVisible(); await expect(list.getByRole('button', { name: 'Download confirmed items', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(list.getByRole('button', { name: 'Download Passive Fire Matrix PDF', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(list).toBeHidden(); await expect(toggle).toBeFocused();
  await setFilter('Category', ['Mechanical']); // Export selection is independent of the visible register filter.
  const confirmed=scope==='service_plans'?[ids.b1,ids.s1,ids.s2]:[ids.d1,ids.b1,ids.b3,ids.s1,ids.s2];
  for (const [selection, expected] of [['confirmed', confirmed], ['unconfirmed', active.filter(id => !confirmed.includes(id))], ['all', active]]) {
    await toggle.click(); const action = list.getByRole('button', { name: `Download ${selection} items`, exact: true });
    const position = await action.evaluate(el => ({ icon: el.firstElementChild.getBoundingClientRect().x, label: el.lastElementChild.getBoundingClientRect().x })); assert.ok(position.icon < position.label);
    const downloadWait = page.waitForEvent('download'), responseWait = page.waitForResponse(reply => reply.url().endsWith('/physical/export/xlsx'));
    await action.click(); const reply = await responseWait; assert.equal(reply.status(), 200, await reply.text()); assert.deepEqual(reply.request().postDataJSON(), { scope, expected_revision: before.revision, confirmation: selection });
    const download = await downloadWait, filename = path.join(output, `${scope}-${download.suggestedFilename()}`); await download.saveAs(filename);
    const parsed = spawnSync(process.env.CEASEFIRE_PYTHON || 'python', ['-c', "import json,sys\nfrom openpyxl import load_workbook\nw=load_workbook(sys.argv[1],data_only=False)\nrows=[]\nfor s in w:\n if s.title in ('Defects','Barriers','Services'):\n  v=list(s.values);rows.extend(dict(zip(v[0],r)) for r in v[1:])\nprint(json.dumps({'ids':sorted(r['entity_id'] for r in rows),'confirmation':sorted(set(r['confirmation'] for r in rows)),'formulas':[c.coordinate for s in w for r in s for c in r if c.data_type=='f']}))\nw.close()", filename], { encoding: 'utf8', windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr); const result = JSON.parse(parsed.stdout); assert.deepEqual(result.ids, [...expected].sort()); assert.deepEqual(result.formulas, []); if (selection !== 'all') assert.deepEqual(result.confirmation, [selection]);
    await expect(list).toBeHidden(); await idle(); assert.deepEqual(await snapshot(), before);
  }
  await reset('Category'); await toggle.click(); await root.getByRole('heading', { level: 2 }).click(); await expect(list).toBeHidden();
  const session = await page.evaluate(() => window.CeasefireTakeoffs.sessionId());
  for (const data of [{ scope, confirmation: 'all', expected_revision: before.revision - 1 }, { scope, confirmation: 'approved', expected_revision: before.revision }, { scope, confirmation: 'all', expected_revision: true }, { scope, confirmation: 'all', expected_revision: before.revision, selected_ids: [] }]) {
    const reply = await page.request.post(`${origin}/api/takeoffs/sessions/${session}/physical/export/xlsx`, { data }); assert.equal(reply.status(), 400);
  }
  assert.deepEqual(await snapshot(), before);
  await page.setViewportSize({ width: 390, height: 764 }); await toggle.click(); await list.scrollIntoViewIfNeeded();
  const bounds = await list.boundingBox(), layout = await list.evaluate(el => { const r=el.getBoundingClientRect(),toggle=el.previousElementSibling.getBoundingClientRect(),css=getComputedStyle(el);return {bounds:{x:r.x,y:r.y,width:r.width,height:r.height},toggle:{x:toggle.x,y:toggle.y,width:toggle.width,height:toggle.height},boxSizing:css.boxSizing,cssWidth:css.width,padding:css.padding,border:css.borderWidth,viewport:{width:innerWidth,height:innerHeight},scrollWidth:document.documentElement.scrollWidth}; });
  (evidence.documentMenus||=[]).push({scope,...layout});await page.screenshot({ path: path.join(output, `physical-document-${scope}-390.png`) });
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 764,JSON.stringify(layout));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.keyboard.press('Escape'); await expect(list).toBeHidden(); await page.setViewportSize({ width: 1600, height: 1100 });
}
async function checkAutomaticMenuIntent(scope, ids) {
  const cases = [];
  for (const mode of ['toggle', 'action-focus', 'escape', 'outside', 'field-focus', 'selection', 'activate', 'pointer', 'pointer-cancel', 'pointer-leave']) {
    await row(ids.b1).locator('.takeoff-row-link').click(); await idle();
    const before = await rawSnapshot(), prior = requests.length, value = `Held Add intent: ${scope} ${mode}`;
    let release, signal, first = true;
    const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { signal = resolve; });
    await page.route('**/physical/preview', async route => { if (first) { first = false; signal(); await held; } await route.continue(); });
    try {
      const notes = details().getByLabel('Notes', { exact: true }); await notes.fill(value); await notes.press('Tab'); await started;
      const toggle = details().getByRole('button', { name: 'Add', exact: true }), list = details().getByRole('group', { name: 'Add item actions', exact: true, includeHidden: true });
      await toggle.click(); await expect(list).toBeVisible();
      const action = list.getByRole('button', { name: 'Add service in Item Details', exact: true });
      let pressed, pressedBounds, pointerEvidence;
      if (mode === 'action-focus') { await toggle.press('ArrowDown'); await expect(action).toBeFocused(); }
      if (mode === 'escape') await toggle.press('Escape');
      if (mode === 'outside') await details().getByRole('heading', { name: 'Item Details', exact: true }).click();
      if (mode === 'field-focus') await notes.click();
      if (mode === 'selection') await row(ids.b2).locator('.takeoff-row-link').click();
      if (mode === 'activate') await action.click();
      if (mode.startsWith('pointer')) {
        pressed = await action.elementHandle(); pressedBounds = await action.boundingBox();
        await page.mouse.move(pressedBounds.x + pressedBounds.width / 2, pressedBounds.y + pressedBounds.height / 2); await page.mouse.down();
      }
      const applied = page.waitForResponse(reply => reply.url().endsWith('/physical/apply')); release(); assert.equal((await applied).status(), 200); if (mode !== 'activate') await idle();
      await expect.poll(async () => { const graph = (await rawSnapshot())[scope === 'service_plans' ? 'service_plans' : 'physical']; return graph.barriers.find(entity => entity.id === ids.b1).fields.notes; }).toBe(value);
      if (mode.startsWith('pointer')) {
        assert.equal(await pressed.evaluate(el => el.isConnected), true, 'The original pressed Add option must survive its automatic Notes response');
        pointerEvidence = await pressed.evaluate((el, point) => { const rect = el.getBoundingClientRect(), hit = document.elementFromPoint(point[0], point[1]); return { connected: el.isConnected, point, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, originalActionAtPoint: el === hit || el.contains(hit) }; }, [pressedBounds.x + pressedBounds.width / 2, pressedBounds.y + pressedBounds.height / 2]);
        const [x, y] = pointerEvidence.point, bounds = pointerEvidence.bounds;
        assert.ok(x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height && pointerEvidence.originalActionAtPoint, 'The unchanged native mouse-down point must still hit the original pressed action after the save');
        if (mode === 'pointer-cancel') await action.dispatchEvent('pointercancel', { pointerId: 1 });
        if (mode === 'pointer-leave') { const heading = await details().getByRole('heading', { name: 'Item Details', exact: true }).boundingBox(); await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2); }
        await page.mouse.up();
      }
      if (['activate', 'pointer'].includes(mode)) {
        const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: 'Create draft service', exact: true })).toBeVisible(); await expect(dialog).toContainText('Parent ID: B-0001');
        await expect(list).toBeHidden(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
        if (mode === 'pointer') {
          await details().getByRole('button', { name: 'Delete draft record', exact: true }).click();
          await expect(dialog.getByRole('heading', { name: 'Delete draft barrier', exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
          if (scope === 'defect_reports') {
            await details().getByRole('button', { name: 'Change Parent', exact: true }).click();
            await expect(dialog.getByRole('heading', { name: 'Change barrier parent', exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
          }
        }
      } else if (['toggle', 'action-focus'].includes(mode)) {
        await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(list).toBeVisible();
        await expect(mode === 'toggle' ? toggle : action).toBeFocused(); await page.keyboard.press('Escape'); await expect(list).toBeHidden();
      } else {
        await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(list).toBeHidden();
        if (mode === 'selection') await expect(row(ids.b2).locator('input[type="checkbox"]').first()).toBeChecked();
        if (mode.startsWith('pointer')) {
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await details().getByRole('button', { name: 'Delete draft record', exact: true }).click();
          const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: 'Delete draft barrier', exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
        }
      }
      assert.equal(requests.length, prior + 1, 'Each held Notes value must produce exactly one preview and apply before any child command');
      const after = await rawSnapshot(), key = scope === 'service_plans' ? 'service_plans' : 'physical';
      assert.deepEqual(after[key].services, before[key].services); assert.deepEqual(after[key].barriers.map(entity => [entity.id, entity.defect_id]), before[key].barriers.map(entity => [entity.id, entity.defect_id]));
      cases.push({ mode, mouseOpenedBeforeRelease: true, savedExactlyOnce: true, menuIntentPreserved: ['toggle', 'action-focus'].includes(mode), explicitDismissalRetained: !['toggle', 'action-focus', 'pointer'].includes(mode), originalPressedOptionRetained: mode.startsWith('pointer'), pointerEvidence, currentParentDialog: ['activate', 'pointer'].includes(mode), freshFirstClickDeleteAfterPointer: mode.startsWith('pointer') });
    } finally { release(); await page.unroute('**/physical/preview'); }
  }
  return cases;
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); origin = `http://127.0.0.1:${info.port}`; browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/physical/preview')) requests.push(request.postDataJSON()); }); await page.goto(origin); await expect.poll(() => page.evaluate(() => window.CeasefireDesktop?.status().ready)).toBe(true);
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await chooseTakeoff(page, 'physical'); await idle();
  for (const scope of ['defect_reports', 'service_plans']) {
    await chooseTakeoff(page, scope === 'service_plans' ? 'Service Plans' : 'Defect Reports'); await idle(); const ids = await seed(scope);
    await checkDocuments(scope, ids);
    const cases = [['Confirmation', 'Confirmed', scope==='service_plans'?[ids.b1,ids.s1,ids.s2]:[ids.d1,ids.b1,ids.b3,ids.s1,ids.s2]], ['Location', 'Level01', scope==='service_plans'?[ids.b1,ids.s1,ids.s2]:[ids.d1,ids.b1,ids.b3,ids.s1,ids.s2]], ['FRL', '-/90/90', scope === 'service_plans' ? [ids.b2, ids.s3] : [ids.d2, ids.b2, ids.s3]], ['Substrate', 'Concrete/masonry floor', [ids.b2, ids.s3]], ['Orientation', 'Vertical', [ids.b1, ids.s1, ids.s2]], ['Category', 'Mechanical', [ids.s1, ids.s3]], ['Service type', 'D2 Comms Cables', [ids.s2]]];
    cases.push(['Service Size (mm)', '25', [ids.s1]]);
    const beforeHide=await snapshot(),hideAll=page.getByRole('checkbox',{name:'Hide all matching physical records',exact:true});
    await hideAll.check(); await expect(page.locator('.takeoff-register-table tbody input[aria-label^="Hide "]:checked')).toHaveCount(scope==='service_plans'?6:8);
    await hideAll.uncheck(); assert.deepEqual(await snapshot(),beforeHide);
    for (const [label, value, expected] of cases) { await setFilter(label, [value]); await matches(expected); assert.equal(await page.getByRole('button', { name: `Filter ${label}`, exact: true }).getAttribute('aria-pressed'), 'true'); await reset(label); }
    await setFilter('Category', ['Mechanical', 'Electrical & Communications']); await matches([ids.s1, ids.s2, ids.s3]); await reset('Category');
    await setFilter('Category', ['Mechanical']); await setFilter('Orientation', ['Vertical']); await matches([ids.s1]); const context = await visible(); assert.deepEqual(context.filter(row => row.context).map(row => row.id), scope === 'service_plans' ? [ids.b1] : [ids.d1, ids.b1]);
    const search = page.getByRole('searchbox', { name: 'Filter physical hierarchy', exact: true }); await search.fill('Level01'); await matches([ids.s1]); await search.fill('Level02'); await expect(page.locator('.takeoff-register-table tbody tr')).toHaveCount(0); await search.fill('');
    const dialog = await menu('Location'); await expect(dialog.getByRole('checkbox', { name: 'Level02', exact: true })).toBeVisible(); await dialog.getByRole('searchbox', { name: 'Search Location values', exact: true }).fill('Level02'); await expect(dialog.getByRole('checkbox', { name: 'Level01', exact: true })).toHaveCount(0); await expect(dialog.getByRole('checkbox', { name: 'Select all values', exact: true })).toBeChecked(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await reset('Category'); await reset('Orientation'); await setFilter('Location', scope==='service_plans'?['', 'Level02']:['Level02']); await matches(scope==='service_plans'?[ids.b2,ids.s3,ids.b3]:[ids.d2,ids.b2,ids.s3]); await reset('Location');
    await setFilter('Category', ['Mechanical']); await page.setViewportSize({ width: 764, height: 764 }); const narrow = await menu('Category'); const box = await narrow.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 764 && box.y >= 0 && box.y + box.height <= 764); await page.screenshot({ path: path.join(output, `physical-filter-${scope}-764.png`) }); await narrow.getByRole('button', { name: 'Reset filter', exact: true }).click(); await page.setViewportSize({ width: 1600, height: 1100 });
    await row(ids.b1).locator('.takeoff-row-link').click(); await idle(); await expect(details().getByRole('button', { name: 'Preview physical edits', exact: true })).toHaveCount(0);
    await assertParentControls(page, details());
    const notes = details().getByLabel('Notes', { exact: true }), discard = details().getByRole('button', { name: 'Discard unfinished physical edits', exact: true }); await discard.scrollIntoViewIfNeeded(); const beforeDiscard = requests.length; await notes.fill('Discard this unfinished note'); await discard.click(); await expect(notes).toHaveValue(''); assert.equal(requests.length, beforeDiscard, 'The first Discard click must not apply its unfinished field');
    await notes.fill('Flush before child creation'); await clickInspectorAdd(details(), 'Add service in Item Details'); const create = page.getByRole('dialog'); await expect(create.getByRole('heading', { name: 'Create draft service', exact: true })).toBeVisible(); const graph = (await rawSnapshot())[scope === 'service_plans' ? 'service_plans' : 'physical']; assert.equal(graph.barriers.find(value => value.id === ids.b1).fields.notes, 'Flush before child creation'); await create.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
    let release, intercepted; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { intercepted = resolve; }); let first = true;
    await page.route('**/physical/preview', async route => { if (first) { first = false; intercepted(); await held; } await route.continue(); });
    const prior = requests.length; await notes.fill('First queued value'); await notes.press('Tab'); await started; await expect(notes).toBeEnabled(); await notes.fill('Later queued value'); await notes.evaluate(el => { el.focus(); el.setSelectionRange(5, 5); }); const retained = await notes.elementHandle(); release();
    await expect.poll(async () => { const graph = (await snapshot())[scope === 'service_plans' ? 'service_plans' : 'physical']; return graph.barriers.find(value => value.id === ids.b1).fields.notes; }).toBe('Later queued value'); await page.unroute('**/physical/preview');
    assert.equal(requests.length, prior + 2); assert.deepEqual(await retained.evaluate(el => ({ connected: el.isConnected, focused: document.activeElement === el, caret: el.selectionStart, value: el.value })), { connected: true, focused: true, caret: 5, value: 'Later queued value' });
    const deletion = details().getByRole('button', { name: 'Delete draft record', exact: true }); await deletion.scrollIntoViewIfNeeded(); await notes.fill('Flush before delete review'); await deletion.click(); const review = page.getByRole('dialog'); await expect(review.getByRole('heading', { name: 'Delete draft barrier', exact: true })).toBeVisible(); const deletionGraph = (await rawSnapshot())[scope === 'service_plans' ? 'service_plans' : 'physical']; assert.equal(deletionGraph.barriers.find(value => value.id === ids.b1).fields.notes, 'Flush before delete review'); assert.equal(deletionGraph.barriers.find(value => value.id === ids.b1).deleted, false); await review.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle();
    const automaticMenuIntent = await checkAutomaticMenuIntent(scope, ids);
    evidence.scopes.push({ scope, automaticMenuIntent, eightColumns: true, andOr: true, blanks: scope==='service_plans', ownerLocationAndConfirmation: true, ancestorContext: true, matchingSelection: true, searchFiltered: true, narrowMenu: true, compactOriginalIconAddService: true, firstClickDiscard: true, firstClickAddService: true, firstClickDelete: true, inFlightTyping: true, focusedControlAndCaretRetained: true });
  }
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, requests, errors }, null, 2)); console.log(`PASS: Eight physical column filters, AND/OR/blanks, ancestor context, search and matching selection, responsive menus and first-click Discard/Add service in both scopes. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-4000)); fs.writeFileSync(path.join(output,'failure-evidence.json'),JSON.stringify({error:error.message,evidence,errors},null,2));if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
