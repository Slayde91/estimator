const englishI18n = require("./english_i18n_fixture.cjs");
// Exact, destination-scoped thickness and async stale-result suppression.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const copy = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test) { for (let i = 0; i < 100; i++) { if (test()) return; await pause(20); } throw new Error('Projection did not settle'); }
function harness() {
  const el = () => ({ children: [], dataset: {}, attributes: {}, classList: { add() {} },
    append(...values) { this.children.push(...values); }, setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {}, closest() { return null; } });
  const pending = [], calls = [], controls = { fingerprint: 'draft-one', action: false, invalid: false };
  const window = { CeasefireCalculators: {
    projectFingerprint: () => controls.fingerprint,
    hasPendingOperation: () => controls.action,
    readTakeoffTarget: () => { if (controls.invalid) throw new Error('Invalid current schedule input'); return { inputs: { SCHEDULE: { J10: 10 } }, schedule_rows: [10], fingerprint: controls.fingerprint }; }
  } };
  const context = { window, document: { getElementById() { return null; }, createElement: el, createElementNS: el },
    crypto: require('node:crypto'), console, setTimeout, clearTimeout, fetch: (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => pending.push(value => resolve({ ok: true, json: async () => value })));
    } };
  if (context.window) context.window.CeasefireI18n = englishI18n(); vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit = { state, linkedThicknessFor, registerFilterValue, visibleItems, scheduleLinkedThickness, calculatorDraftChanged, invalidateLinkedThickness, thicknessContext,
    cache:()=>linkedThickness, renderer:()=>{renderRegister=()=>{globalThis.renders=(globalThis.renders||0)+1;};} };
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const { audit } = context, state = audit.state;
  state.active = true; state.ui = { root: el(), target: { value: 'steel_vermiculite' } };
  const item = { id: 'source-item', mode: 'steel', state: 'confirmed', version: 4, quantity: 2, fields: { mark: 'B1' } };
  const binding = { id: 'link-one', item_id: item.id, item_version: 4, status: 'current', calculator_id: 'steel_vermiculite', row: 10, sheet: 'SCHEDULE', source_sha256: 'a'.repeat(64) };
  state.session = { session_id: 'session-one', revision: 8, snapshot: { project_id: 'project-one', revision: 8, items: [item], documents: [], transfers: [binding] } };
  const record = { calculator_id: 'steel_vermiculite', binding_id: binding.id, row: 10, sheet: 'SCHEDULE', status: 'Current',
    estimating_thickness_mm: 13.123456789012345, published_thickness_mm: 12.82, total_thickness_mm: null,
    calculator_source_sha256: 'a'.repeat(64), calculator_draft_sha256: 'b'.repeat(64) };
  const reply = (results = [record]) => ({ project_id: state.session.snapshot.project_id, revision: state.session.revision, linked_results: { [item.id]: results } });
  audit.renderer();
  return { audit, context, state, item, binding, record, controls, pending, calls, reply, async start() { audit.scheduleLinkedThickness(); await waitFor(() => pending.length); }, finish(value = reply()) { pending.shift()(value); } };
}
let passed = 0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check('Unlinked rows stay blank without deriving from source fields or other schedules', () => {
    const h = harness(); h.state.session.snapshot.transfers = [];
    h.item.fields.thickness_mm = 99; assert.equal(h.audit.linkedThicknessFor(h.item).text, '—');
    h.audit.scheduleLinkedThickness(); assert.equal(h.calls.length, 0);
  });
  await check('Current exact estimating thickness is read-only and filterable without rounding', async () => {
    const h = harness(), before = copy(h.state.session); await h.start();
    assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Checking…');
    assert.deepEqual(copy(h.calls[0].body), { expected_revision: 8, calculator_drafts: { steel_vermiculite: { inputs: { SCHEDULE: { J10: 10 } }, schedule_rows: [10] } } });
    h.finish(); await waitFor(() => !h.audit.cache().pending);
    const result = h.audit.linkedThicknessFor(h.item);
    assert.equal(result.text, String(h.record.estimating_thickness_mm)); assert.equal(result.filter, result.text);
    assert.match(result.detail, /Estimating thickness.*Published thickness: 12\.82/); assert.match(result.detail, /SCHEDULE row 10/);
    assert.match(result.detail, new RegExp('a'.repeat(64))); assert.match(result.detail, new RegExp('b'.repeat(64)));
    assert.equal(h.audit.registerFilterValue(h.item, 'thickness'), result.text);
    h.state.registerColumnFilters.set('steel', new Map([['thickness', new Set([result.text])]])); h.state.registerFilterSession = 'session-one';
    assert.equal(h.audit.visibleItems().length, 1); h.state.registerColumnFilters.get('steel').get('thickness').clear(); assert.equal(h.audit.visibleItems().length, 0);
    assert.deepEqual(copy(h.state.session), before);
  });
  await check('Duct surface stays blank until linked and reads its own native output even when thickness is unavailable', async () => {
    const h = harness(); h.state.mode = h.item.mode = 'duct'; h.state.ui.target.value = 'ductwork';
    Object.assign(h.binding, { calculator_id: 'ductwork', sheet: 'CALCULATOR' });
    Object.assign(h.record, { calculator_id: 'ductwork', sheet: 'CALCULATOR', status: 'Unavailable', duct_surface_status: 'Current', duct_surface_m2: 20.123456789, duct_thickness_mm: null });
    h.item.fields.duct_surface_m2 = 999; const before = copy(h.state.session);
    h.state.session.snapshot.transfers = []; assert.equal(h.audit.linkedThicknessFor(h.item, 'duct_surface').text, '');
    h.state.session.snapshot.transfers = [h.binding]; await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    const result = h.audit.linkedThicknessFor(h.item, 'duct_surface');
    assert.equal(result.value, 20.123456789); assert.equal(result.text, '20.12'); assert.equal(result.filter, '20.123456789');
    assert.match(result.detail, /CALCULATOR row 10.*Duct surface/); assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
    assert.equal(h.audit.registerFilterValue(h.item, 'duct_surface'), '20.123456789'); assert.deepEqual(copy(h.state.session), before);
    for (const value of [null, 0, -1, '20', Infinity, NaN]) { h.audit.cache().results[h.item.id][0].duct_surface_m2 = value; assert.equal(h.audit.linkedThicknessFor(h.item, 'duct_surface').text, 'Unavailable'); }
    h.audit.cache().results[h.item.id][0].duct_surface_m2 = 20.123456789;
    for (const fault of ['source', 'draft', 'status', 'version', 'confirmation', 'binding']) {
      const record = h.audit.cache().results[h.item.id][0]; Object.assign(record, { calculator_source_sha256: h.binding.source_sha256, calculator_draft_sha256: 'b'.repeat(64), duct_surface_status: 'Current' });
      h.binding.status = 'current'; h.item.version = 4; h.item.state = 'confirmed';
      if (fault === 'source') record.calculator_source_sha256 = 'c'.repeat(64); if (fault === 'draft') record.calculator_draft_sha256 = '';
      if (fault === 'status') record.duct_surface_status = 'Unavailable'; if (fault === 'version') h.item.version++;
      if (fault === 'confirmation') h.item.state = 'draft'; if (fault === 'binding') h.binding.status = 'stale';
      assert.equal(h.audit.linkedThicknessFor(h.item, 'duct_surface').text, 'Unavailable', fault);
    }
  });
  await check('Destination switch never combines spray and board results, and board uses native total', async () => {
    const h = harness(); await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    h.state.ui.target.value = 'steel_board'; assert.equal(h.audit.linkedThicknessFor(h.item).text, '—');
    h.state.session.snapshot.transfers.push({ ...h.binding, id: 'board-link', calculator_id: 'steel_board', sheet: 'CALCULATOR', row: 9 });
    h.audit.scheduleLinkedThickness(); await waitFor(() => h.pending.length);
    h.finish(h.reply([{ ...h.record, binding_id: 'board-link', calculator_id: 'steel_board', sheet: 'CALCULATOR', row: 9, total_thickness_mm: 30, board_stack_mm: '15 + 15', board_layers: 2 }]));
    await waitFor(() => !h.audit.cache().pending);
    assert.equal(h.audit.linkedThicknessFor(h.item).text, '30'); assert.match(h.audit.linkedThicknessFor(h.item).detail, /Total board thickness.*15 \+ 15/);
  });
  await check('Source edits, conflicts and missing or unusable native outputs never display old numbers', async () => {
    const h = harness(); await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    for (const status of ['stale', 'conflict', 'deleted']) { h.binding.status = status; assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable'); }
    h.binding.status = 'current'; h.item.version++; assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
    h.item.version--; h.item.state = 'draft'; assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
    h.item.state = 'confirmed';
    for (const value of [null, 0, -1, '12', Infinity, NaN]) {
      h.audit.cache().results[h.item.id][0].estimating_thickness_mm = value;
      assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable'); assert.equal(h.audit.registerFilterValue(h.item, 'thickness'), '');
    }
  });
  await check('Intumescent destination reads exact native DFT mm and keeps assessment provenance', async () => {
    const h = harness(); h.state.ui.target.value = 'steel_intumescent';
    Object.assign(h.binding, { calculator_id: 'steel_intumescent' });
    Object.assign(h.record, { calculator_id: 'steel_intumescent', intumescent_dft_um: 1234.56789012345,
      intumescent_thickness_mm: 1.23456789012345, intumescent_thickness_status: 'PUBLISHED - CERTIFICATE TABLE',
      intumescent_thickness_source: 'FC21221-01-1-C1 Table 1' });
    const before = copy(h.state.session); await h.start();
    assert.ok(h.calls[0].body.calculator_drafts.steel_intumescent);
    h.finish(); await waitFor(() => !h.audit.cache().pending);
    const result = h.audit.linkedThicknessFor(h.item);
    assert.equal(result.value, h.record.intumescent_thickness_mm);
    assert.equal(result.text, String(h.record.intumescent_thickness_mm));
    assert.equal(result.filter, result.text);
    assert.match(result.detail, /Dry film thickness: 1234\.56789012345 µm.*FC21221-01-1-C1 Table 1/);
    assert.equal(h.audit.registerFilterValue(h.item, 'thickness'), result.text);
    assert.deepEqual(copy(h.state.session), before);
    h.state.ui.target.value = 'steel_vermiculite';
    assert.equal(h.audit.linkedThicknessFor(h.item).text, '—');
  });
  await check('Calculator changes invalidate visibly before a delayed obsolete response returns', async () => {
    const h = harness(); await h.start(); const oldResponse = h.reply();
    h.controls.fingerprint = 'draft-two'; h.audit.calculatorDraftChanged();
    assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Checking…'); h.finish(oldResponse);
    await waitFor(() => h.pending.length);
    assert.equal(h.audit.cache().pending, true);
    h.finish(h.reply([{ ...h.record, status: 'Unavailable', reason: 'The linked row was edited', estimating_thickness_mm: null }]));
    await waitFor(() => !h.audit.cache().pending);
    assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable'); assert.match(h.audit.linkedThicknessFor(h.item).detail, /row was edited/);
    assert.equal(h.calls.length, 2);
  });
  await check('Delayed results cannot cross revisions, sessions or destination schedules', async () => {
    for (const change of ['revision', 'session', 'destination']) {
      const h = harness(); await h.start(); const old = h.reply();
      if (change === 'revision') h.state.session.revision++;
      else if (change === 'session') h.state.session.session_id = 'new-session';
      else h.state.ui.target.value = 'steel_board';
      h.finish(old); await pause(25);
      assert.equal(h.audit.cache().pending, true, `${change} response was not installed`);
      assert.notEqual(h.audit.linkedThicknessFor(h.item).text, String(h.record.estimating_thickness_mm));
    }
  });
  await check('Malformed response and invalid current calculator input fail explicitly, never to zero', async () => {
    let h = harness(); await h.start(); h.finish({ project_id: 'wrong-project', revision: 8, linked_results: {} });
    await waitFor(() => !h.audit.cache().pending); assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
    h = harness(); h.controls.invalid = true; h.audit.scheduleLinkedThickness(); await waitFor(() => h.audit.cache() && !h.audit.cache().pending);
    assert.equal(h.calls.length, 0); assert.match(h.audit.linkedThicknessFor(h.item).detail, /Invalid current schedule input/);
  });
  await check('Result source and draft provenance must match the retained schedule link', async () => {
    const h = harness(); await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    const record = h.audit.cache().results[h.item.id][0]; record.calculator_source_sha256 = 'c'.repeat(64);
    assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
    record.calculator_source_sha256 = h.binding.source_sha256; delete record.calculator_draft_sha256;
    assert.equal(h.audit.linkedThicknessFor(h.item).text, 'Unavailable');
  });
  await check('Delayed derived results update cells without replacing an unfinished register input', async () => {
    const h = harness(), cell = { dataset: { thicknessItemId: h.item.id }, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
    const field = { tagName: 'INPUT', value: 'UNFINISHED LEVEL', events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
    h.context.document.activeElement = field; h.state.ui.tableWrap = { contains(value) { return value === field; }, querySelectorAll() { return [cell]; } };
    await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    assert.equal(cell.textContent, String(h.record.estimating_thickness_mm)); assert.equal(field.value, 'UNFINISHED LEVEL'); assert.equal(h.context.renders, undefined);
    h.state.registerFilterSession = h.state.session.session_id; h.state.registerColumnFilters.set('steel', new Map([['thickness', new Set([cell.textContent])]]));
    h.controls.fingerprint = 'new-settings'; h.audit.calculatorDraftChanged(); await waitFor(() => h.pending.length);
    h.finish(); await waitFor(() => !h.audit.cache().pending);
    assert.equal(field.value, 'UNFINISHED LEVEL'); assert.equal(h.context.renders, undefined); assert.equal(h.state.thicknessFilterNeedsRender, true);
    h.context.document.activeElement = null; field.events.blur(); await waitFor(() => h.context.renders === 1);
    assert.equal(h.state.thicknessFilterNeedsRender, false);
  });
  await check('Equivalent drafts do not repeatedly calculate, and hidden views defer projection work', async () => {
    const h = harness(); await h.start(); h.finish(); await waitFor(() => !h.audit.cache().pending);
    h.audit.scheduleLinkedThickness(); h.audit.calculatorDraftChanged(); await pause(180); assert.equal(h.calls.length, 1);
    h.state.ui.root.closest = () => ({}); h.controls.fingerprint = 'draft-hidden'; h.audit.calculatorDraftChanged();
    await pause(180); assert.equal(h.calls.length, 1); assert.equal(h.audit.cache(), null);
  });
  console.log(`${passed} linked thickness UI checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
