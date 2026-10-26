const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { harness, copy, result, definition } = require('./helpers/penetration_ui.cjs');
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = data => ({ ok: true, json: async () => data });
const record = (id, title = id) => ({ id, title, subtitle: 'Test report / service' });
const page = (items, offset = 0, total = items.length) => ({ items, offset, total, filters: [{ key: 'orientation', options: ['Vertical', 'Horizontal'] }, { key: 'services', options: [{ value: 'pipes', label: 'Pipes' }] }] });
function setup() {
  const h = harness(), doc = h.context.document, original = doc.createElement;
  doc.createElement = tag => {
    const el = original(tag); el.showModal = function () { this.open = true; }; el.close = function () { this.open = false; };
    el.querySelectorAll = function (selector) { return this.children.flatMap(child => [...(selector === child.tagName || selector === '[data-penetration-references]' && child.dataset.penetrationReferences !== undefined ? [child] : []), ...child.querySelectorAll(selector)]); };
    return el;
  };
  doc.body = doc.createElement('body'); Object.assign(h.context, { AbortController, URLSearchParams });
  Object.assign(h.context.window, { document: doc });
  vm.runInContext(fs.readFileSync('static/register-references.js', 'utf8'), h.context);
  vm.runInContext(fs.readFileSync('static/penetration-references.js', 'utf8'), h.context);
  h.refs = h.context.window.CeasefirePenetrationReferences;
  h.elements = () => { const all = []; const walk = el => { all.push(el); for (const child of el.children) walk(child); }; walk(doc.body); return all; };
  h.find = predicate => h.elements().find(predicate);
  h.button = name => h.find(el => el.tagName === 'button' && el.textContent === name);
  return h;
}
(async () => {
  let checks = 0;
  const check = async (name, fn) => { await fn(); checks++; console.log(`ok - ${name}`); };
  await check('Report links accept exact registered-document routes and reject malformed same-origin destinations', async () => {
    const h = setup(), api = h.context.window.CeasefireRegisterReferences;
    assert.equal(api.publicURL('/api/libraries/documents/fas190235.pdf'), '/api/libraries/documents/fas190235.pdf');
    for (const bad of ['/api/libraries/documents/../secrets.pdf', '/api/libraries/documents/abc.pdf?token=x', '//evil.example/a.pdf', 'javascript:alert(1)', '/api/libraries/documents/a.pdf#x', '/api/libraries/documents/a\\b.pdf']) assert.equal(api.publicURL(bad), null);
  });
  await check('Systems use stable plain 1 | 2 links and literal source titles', async () => {
    const h = setup(), opened = [];
    h.context.window.CeasefireLibraryNavigation = { open: async (...args) => opened.push(args) };
    const rendered = h.refs.renderSystems({ systems: [record('one', '<script>literal</script>'), record('two')] });
    assert.deepEqual(rendered.children.map(el => el.textContent), ['1', ' | ', '2']);
    await rendered.children[2].emit('click'); assert.deepEqual(opened, [['technical', 'two']]);
    assert.equal(rendered.children[0].title, '<script>literal</script>');
  });
  await check('Invalid duplicate, over-limit and unsafe technical IDs are rejected', async () => {
    const h = setup(); for (const ids of [null, ['same', 'same'], ['a/b'], ['<script>'], Array.from({ length: 129 }, (_, i) => 'id-' + i)]) assert.throws(() => h.refs.validateIds(ids));
    assert.deepEqual(copy(h.refs.validateIds(['b', 'a'])), ['b', 'a']);
  });
  await check('Report dropdown reads the unfiltered Technical listing and preserves exact labels, values and groups', async () => {
    const h = setup(), calls = [], definition = { key: 'report', options: [{ value: 'REPORT A Rev 1', label: 'REPORT A Rev 1', group: 'Supplier A' }, { value: 'REPORT B', label: 'Report B label', group: 'Supplier B' }] };
    h.context.window.fetch = async url => { calls.push(url); return reply({ filters: [definition], items: [] }); };
    const [first, second] = await Promise.all([h.refs.reportOptions(), h.refs.reportOptions()]);
    assert.deepEqual(copy(first), definition); assert.deepEqual(copy(second), definition); assert.deepEqual(calls, ['/api/libraries/technical?limit=1']);
    const control = h.context.document.createElement('select'); control.ownerDocument = h.context.document; h.refs.appendReportOptions(control, first);
    assert.deepEqual(control.children.map(group => [group.label, group.children[0].value, group.children[0].textContent]), [['Supplier A', 'REPORT A Rev 1', 'REPORT A Rev 1'], ['Supplier B', 'REPORT B', 'Report B label']]);
    await h.refs.reportOptions(); assert.equal(calls.length, 2, 'A new editor render reads current library options rather than stale cached choices');
  });
  await check('Picker starts with recorded filters, preserves choices across pages and saves ordered IDs only', async () => {
    const h = setup(), calls = [], applied = [];
    const fetch = async url => { calls.push(url); const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset')); return reply(page([record(offset ? 'second' : 'first')], offset, 21)); };
    const pending = h.refs.open({ reference: { systems: [], initial_filters: { orientation: 'Vertical', services: 'pipes' } }, fetch, apply: async ids => applied.push(ids) }); await flush();
    assert.match(calls[0], /orientation=Vertical/); assert.match(calls[0], /services=pipes/);
    const first = h.find(el => el.dataset.penetrationReferenceChoice === 'first'); first.checked = true; await first.emit('change');
    await h.button('Next').emit('click'); await flush(); const second = h.find(el => el.dataset.penetrationReferenceChoice === 'second'); second.checked = true; await second.emit('change');
    await h.button('Use selected references').emit('click'); await flush(); assert.deepEqual(copy(applied), [['first', 'second']]); assert.deepEqual(copy(await pending), { applied: true });
  });
  await check('Empty explicit override and restoring linked inheritance are different operations', async () => {
    for (const inherited of [false, true]) {
      const h = setup(), applied = []; const pending = h.refs.open({ reference: { systems: [record('one')] }, selectedIds: [], fetch: async () => reply(page([])), apply: async ids => applied.push(ids) }); await flush();
      await h.button(inherited ? 'Use linked references' : 'Use selected references').emit('click'); await flush(); await pending;
      if (inherited) assert.equal(applied[0], undefined); else assert.deepEqual(copy(applied), [[]]);
    }
  });
  await check('Inspecting an item keeps its pending selection inside the picker and renders source text literally', async () => {
    const h = setup(), applied = [];
    const pending = h.refs.open({ reference: { systems: [] }, fetch: async url => reply(url.includes('?') ? page([record('first')]) : { id: 'first', title: 'First system', fields: [{ label: 'Report', value: '<script>literal</script>' }] }), apply: async ids => applied.push(ids) }); await flush();
    const checkbox = h.find(el => el.dataset.penetrationReferenceChoice === 'first'); checkbox.checked = true; await checkbox.emit('change'); await h.button('View item').emit('click'); await flush();
    assert.ok(h.elements().some(el => el.tagName === 'dd' && el.textContent === '<script>literal</script>')); assert.equal(checkbox.checked, true);
    await h.button('Use selected references').emit('click'); await pending; assert.deepEqual(copy(applied), [['first']]);
  });
  await check('Unavailable selected IDs remain visible and removable rather than silently discarded', async () => {
    const h = setup(), applied = []; const pending = h.refs.open({ reference: { systems: [] }, selectedIds: ['missing-id'], fetch: async () => reply(page([])), apply: async ids => applied.push(ids) }); await flush();
    assert.ok(h.elements().some(el => el.textContent === '1. missing-id')); await h.button('Remove').emit('click'); await h.button('Use selected references').emit('click'); await flush(); await pending; assert.deepEqual(copy(applied), [[]]);
  });
  await check('Cancel does not apply any selection and stale result pages cannot replace newer search results', async () => {
    const h = setup(), held = deferred(); let calls = 0, applied = 0;
    const pending = h.refs.open({ reference: { systems: [] }, fetch: async () => ++calls === 1 ? held.promise : reply(page([record('fresh')])), apply: async () => applied++ });
    await h.button('Search').emit('click'); await flush(); held.resolve(reply(page([record('obsolete')]))); await flush();
    assert.ok(h.find(el => el.dataset.penetrationReferenceChoice === 'fresh')); assert.equal(h.find(el => el.dataset.penetrationReferenceChoice === 'obsolete'), undefined);
    await h.button('Cancel').emit('click'); assert.equal(await pending, undefined); assert.equal(applied, 0);
  });
  await check('Project replacement and server rejection keep the schedule untouched', async () => {
    const h = setup(); let current = true, applied = 0;
    const pending = h.refs.open({ reference: { systems: [] }, fetch: async () => reply(page([])), isCurrent: () => current, apply: async () => { applied++; throw Error('Record unavailable'); } }); await flush();
    await h.button('Use selected references').emit('click'); await flush(); assert.ok(h.elements().some(el => el.textContent === 'Record unavailable'));
    current = false; await h.button('Use selected references').emit('click'); await flush(); assert.equal(applied, 1); assert.ok(h.elements().some(el => /schedule item changed/.test(el.textContent)));
    await h.button('Cancel').emit('click'); await pending;
  });
  await check('Manual and inherited references survive quantity edits, composer updates, cancellation, and save/reopen snapshots', async () => {
    const h = harness(); await h.api.open();
    const source = { id: 'line-1', inputs: { T: 'Ref row', O: 2 }, technical_reference_ids: ['manual-one', 'manual-two'], takeoff_reference_ids: ['inherited'] };
    h.audit.state.schedule.draft.rows = [copy(source)]; h.audit.state.rowEpochs.set('line-1', ++h.audit.state.nextEpoch); h.audit.render();
    await h.audit.selectRow('line-1'); h.audit.state.draft.rows[0].inputs.O = 3.23456789; await h.audit.updateSchedule();
    assert.deepEqual(copy(h.api.projectSnapshot().draft.rows[0].technical_reference_ids), source.technical_reference_ids);
    assert.deepEqual(copy(h.api.projectSnapshot().draft.rows[0].takeoff_reference_ids), source.takeoff_reference_ids);
    const snapshot = copy(h.api.projectSnapshot()); h.api.applyProject(await h.api.prepareProject(snapshot)); assert.deepEqual(copy(h.api.projectSnapshot()), snapshot);
    await h.audit.selectRow('line-1'); h.audit.state.draft.rows[0].technical_reference_ids = ['unsaved']; await h.audit.cancelEdit(); assert.deepEqual(copy(h.api.projectSnapshot().draft.rows[0].technical_reference_ids), source.technical_reference_ids);
  });
  await check('Same-session Takeoff revisions invalidate cached schedule references without saving or reading unfinished drawing state', async () => {
    const h = setup(); let revision = 1, reads = 0;
    h.context.window.CeasefireTakeoffs = { sessionId: () => 'owned-session', referenceRevision: () => revision, projectSnapshot: () => { throw Error('Unfinished drawing must not be read'); } };
    h.audit.setRequest(async (url, payload) => {
      if (url.endsWith('/references')) { reads++; return { row_references: Object.fromEntries(payload.draft.rows.map(row => [row.id, { reports: [{ label: 'Report ' + revision, url: null }], systems: [] }])) }; }
      return url.endsWith('/definition') ? definition() : result(payload.draft);
    });
    await h.api.open(); h.audit.state.schedule.draft.rows = [{ id: 'line-1', inputs: { O: 1 } }]; h.audit.renderSchedule(); await flush();
    const prior = reads; h.audit.renderSchedule(); await flush(); assert.equal(reads, prior);
    revision++; h.audit.renderSchedule(); await flush(); assert.equal(reads, prior + 1);
    assert.equal(h.byId('penetration-schedule-body').children[0].children[9].children[0].children[0].textContent, 'Report 2');
  });
  console.log(`${checks} Firestopping reference UI checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
