// Exercise the real Duct register filter predicates and checklist lifecycle.
// Filters are presentation state: no takeoff commands, quantities or exports change.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const copy = value => JSON.parse(JSON.stringify(value));
function harness() {
  function element(tag = 'div') {
    const el = { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, events: {}, style: {}, value: '', className: '', _text: '',
      append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); },
      setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener(key, fn) { this.events[key] = fn; },
      querySelectorAll() { return []; }, getBoundingClientRect() { return { left: 980, bottom: 680, width: 280, height: 420 }; },
      showModal() { this.open = true; }, close(value) { this.returnValue = value; this.open = false; this.events.close?.(); },
      focus() { this.focused = true; }, remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text + this.children.map(child => child.textContent).join(''); }, set(value) { this._text = String(value); this.children = []; } });
    el.classList = { add(...values) { el.className += ' ' + values.join(' '); }, toggle() {} };
    return el;
  }
  const document = { body: element('body'), getElementById() { return null; }, createElement: element, createElementNS: (_, tag) => element(tag) };
  const context = { document, window: { innerWidth: 1146, innerHeight: 764 }, crypto: require('node:crypto'), console, setTimeout, clearTimeout };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit = {state,visibleItems,selectedItems,itemGroup,groupedItems,ductFilters,ductFilterValue,ductColumnValues,setDuctColumnFilter,openDuctColumnFilter,ductColumnFilterButton,renderRegister,projectFingerprint,
    stubRenderers(){renderRegister=()=>{globalThis.registerRenders=(globalThis.registerRenders||0)+1;};renderOverlay=()=>{};}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const audit = context.audit, state = audit.state, ui = {};
  for (const key of ['split', 'merge', 'bulk', 'selectionCount', 'tableWrap', 'pagination']) ui[key] = element();
  ui.bulkField = { value: 'mark', querySelector() { return null; } }; ui.statusFilter = { value: '' };
  state.ui = ui; state.mode = 'duct';
  const row = (id, fields = {}, status = 'draft', mode = 'duct') => ({ id, mode, state: status, quantity: 1, fields: { mark: id, ...fields } });
  state.session = { session_id: 'first', revision: 7, snapshot: { revision: 7, items: [
    row('D1', { level: 'L1', width_mm: 100, height_mm: 200, frl: '120/120/120', orientation: 'Horizontal' }, 'confirmed'),
    row('D2', { level: 'L1', width_mm: 100, height_mm: 200, frl: '60/60/60', orientation: 'Vertical' }),
    row('D3', { level: 'L2', width_mm: 300, height_mm: 400, frl: '120/120/120', orientation: 'Both' }, 'reviewed'),
    row('D4', { level: null, frl: '', orientation: '  ' }),
    row('D5', { level: 'L2', frl: '60/60/60', orientation: 'Horizontal' }, 'confirmed'),
    row('S1', { level: 'L1' }, 'confirmed', 'steel') ], documents: [] } };
  state.resultMap.set('D5', { issues: ['Changed original source'] });
  return { audit, state, ui, context, document, element, ids: () => Array.from(audit.visibleItems(), item => item.id), all(root) { return root.children.flatMap(child => [child, ...this.all(child)]); } };
}
let passed = 0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check('Only the six requested Duct columns have accessible filter buttons and active state', () => {
    const h = harness(); h.audit.renderRegister();
    const buttons = h.all(h.ui.tableWrap).filter(el => el.className.includes('takeoff-column-filter-button'));
    assert.deepEqual(buttons.map(el => el.attributes['aria-label']), ['Filter Confirmation', 'Filter Item', 'Filter Level', 'Filter WxH (mm)', 'Filter FRL', 'Filter Orientation']);
    assert.ok(buttons.every(el => el.attributes['aria-pressed'] === 'false' && el.attributes['aria-haspopup'] === 'dialog'));
    h.audit.ductFilters().set('level', new Set(['L1']));
    const active = h.audit.ductColumnFilterButton('level'); assert.equal(active.attributes['aria-pressed'], 'true'); assert.match(active.className, /active/); assert.match(active.title, /filter applied/);
    h.state.mode = 'steel'; h.audit.renderRegister(); assert.equal(h.all(h.ui.tableWrap).filter(el => el.className.includes('takeoff-column-filter-button')).length, 0);
  });
  await check('Values use OR within a column and AND across all six columns, with authoritative confirmation', () => {
    const h = harness(), filters = h.audit.ductFilters();
    filters.set('mark', new Set(['D1', 'D2', 'D3', 'D5'])); filters.set('level', new Set(['L1', 'L2'])); filters.set('duct_size', new Set(['100 x 200']));
    filters.set('frl', new Set(['120/120/120', '60/60/60'])); filters.set('orientation', new Set(['Horizontal', 'Vertical']));
    assert.deepEqual(h.ids(), ['D1', 'D2']);
    filters.set('confirmation', new Set(['Confirmed'])); assert.deepEqual(h.ids(), ['D1']);
    filters.clear(); filters.set('confirmation', new Set(['Unconfirmed'])); assert.deepEqual(h.ids(), ['D2', 'D3', 'D4', 'D5']);
  });
  await check('Missing, null and whitespace-only values are blanks; dimensions retain complete pairs', () => {
    const h = harness(); assert.deepEqual(Array.from(h.audit.ductColumnValues('level')), ['', 'L1', 'L2']);
    h.audit.ductFilters().set('orientation', new Set([''])); assert.deepEqual(h.ids(), ['D4']);
    h.audit.ductFilters().clear(); h.audit.ductFilters().set('duct_size', new Set([''])); assert.deepEqual(h.ids(), ['D4', 'D5']);
    assert.equal(h.audit.ductFilterValue({ fields: { width_mm: 100 } }, 'duct_size'), '100 x');
  });
  await check('Register search combines with filters, empty selections match nothing and reset returns page one', () => {
    const h = harness(); h.audit.stubRenderers(); h.state.offset = 100;
    h.audit.setDuctColumnFilter('level', new Set(['L1'])); assert.equal(h.state.offset, 0); assert.deepEqual(h.ids(), ['D1', 'D2']);
    h.state.filter = 'vertical'; assert.deepEqual(h.ids(), ['D2']);
    assert.deepEqual(Array.from(h.audit.ductColumnValues('level')), ['', 'L1', 'L2'], 'value universe stays available while searching');
    h.audit.setDuctColumnFilter('level', new Set()); assert.deepEqual(h.ids(), []);
    h.audit.setDuctColumnFilter('level', null); assert.deepEqual(h.ids(), ['D2']);
    h.state.filter = ''; h.audit.setDuctColumnFilter('level', new Set(['', 'L1', 'L2'])); assert.equal(h.audit.ductFilters().size, 0); assert.equal(h.ids().length, 5);
  });
  await check('Duct ignores hidden legacy dropdowns without changing other modes or selected export identities', () => {
    const h = harness(); h.state.ui.statusFilter.value = 'unconfirmed'; h.state.sort = 'level'; h.state.group = 'state'; h.state.selected.add('D1'); h.state.selected.add('D3');
    const before = copy(h.state.session.snapshot), fingerprint = h.audit.projectFingerprint();
    h.audit.ductFilters().set('level', new Set(['L1'])); assert.deepEqual(h.ids(), ['D1', 'D2']); assert.equal(h.audit.itemGroup(h.state.session.snapshot.items[0]), null);
    assert.deepEqual(Array.from(h.audit.selectedItems(), item => item.id), ['D1', 'D3']);
    assert.deepEqual(copy(h.state.session.snapshot), before); assert.equal(h.audit.projectFingerprint(), fingerprint);
    h.state.mode = 'steel'; assert.deepEqual(h.ids(), []); h.state.ui.statusFilter.value = 'confirmed'; assert.deepEqual(h.ids(), ['S1']); assert.equal(h.audit.itemGroup(h.state.session.snapshot.items.at(-1)), 'Confirmed');
  });
  await check('Filters survive revisions within a project and clear when its session is replaced', () => {
    const h = harness(); h.audit.ductFilters().set('level', new Set(['L1'])); h.state.session.snapshot = copy(h.state.session.snapshot); h.state.session.revision++;
    assert.deepEqual(h.ids(), ['D1', 'D2']); h.state.session.session_id = 'replacement'; assert.equal(h.ids().length, 5); assert.equal(h.audit.ductFilters().size, 0);
  });
  await check('Searchable checklist toggles only matching values and supports cancel, apply and reset without writes', async () => {
    const h = harness(); h.audit.stubRenderers(); const before = copy(h.state.session), anchor = h.element('button');
    const menu = () => h.document.body.children[0], labeled = label => h.all(menu()).find(el => el.attributes['aria-label'] === label);
    const open = () => h.audit.openDuctColumnFilter('level', anchor);
    let pending = open(); assert.equal(h.state.modal, true); assert.equal(menu().style.left, '858px'); assert.equal(menu().style.top, '336px');
    let search = labeled('Search Level values'), all = labeled('Select all values'); all.checked = false; all.events.change();
    search.value = 'l1'; search.events.input(); all.checked = true; all.events.change();
    search.value = ''; search.events.input(); assert.equal(labeled('L1').checked, true); assert.equal(labeled('L2').checked, false); assert.equal(all.indeterminate, true);
    menu().close('cancel'); await pending; assert.equal(h.audit.ductFilters().size, 0); assert.equal(h.state.modal, false);
    pending = open(); labeled('(Blanks)').checked = false; labeled('(Blanks)').events.change(); menu().close('apply'); await pending; assert.deepEqual(h.ids(), ['D1', 'D2', 'D3', 'D5']);
    pending = open(); menu().close('reset'); await pending; assert.equal(h.audit.ductFilters().size, 0);
    pending = open(); menu().close(''); await pending; assert.equal(h.document.body.children.length, 0); assert.equal(anchor.attributes['aria-expanded'], 'false');
    assert.deepEqual(copy(h.state.session), before);
  });
  await check('An open checklist cannot install stale choices into a replacement project', async () => {
    const h = harness(); h.audit.stubRenderers(); const pending = h.audit.openDuctColumnFilter('level', h.element('button'));
    h.state.session.session_id = 'replacement'; h.document.body.children[0].close('apply'); await pending;
    assert.equal(h.audit.ductFilters().size, 0); assert.equal(h.context.registerRenders, undefined); assert.equal(h.state.modal, false);
  });
  console.log(`${passed} Duct column filter UI checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
