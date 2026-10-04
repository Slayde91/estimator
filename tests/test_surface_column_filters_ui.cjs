// Wall/Slab filters exercise real predicates and presentation state without
// changing source records, calculation inputs or selected export identities.
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
      focus() {}, remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text + this.children.map(child => child.textContent).join(''); }, set(value) { this._text = String(value); this.children = []; } });
    el.classList = { add(...values) { el.className += ' ' + values.join(' '); }, toggle() {} };
    return el;
  }
  const document = { body: element('body'), getElementById() { return null; }, createElement: element, createElementNS: (_, tag) => element(tag) };
  const context = { document, window: { innerWidth: 1146, innerHeight: 764 }, crypto: require('node:crypto'), console, setTimeout, clearTimeout };
  vm.createContext(context);
  const source = fs.readFileSync('static/takeoffs.js', 'utf8').replace('  window.CeasefireTakeoffs = {', `  globalThis.audit = {state,visibleItems,selectedItems,itemGroup,registerFilters,registerFilterValue,registerColumnValues,setRegisterColumnFilter,openRegisterColumnFilter,renderRegister,projectFingerprint,
    stubRenderers(){renderRegister=()=>{globalThis.registerRenders=(globalThis.registerRenders||0)+1;};renderOverlay=()=>{};}};
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const audit = context.audit, state = audit.state, ui = {};
  for (const key of ['split', 'merge', 'bulk', 'selectionCount', 'tableWrap', 'pagination']) ui[key] = element();
  ui.bulkField = { value: 'mark', querySelector() { return null; } }; ui.statusFilter = { value: 'unconfirmed' };
  state.ui = ui; state.mode = 'wall'; state.sort = 'area'; state.group = 'level';
  const row = (id, mode, fields = {}, status = 'draft') => ({ id, mode, state: status, quantity: 1, fields: { mark: id, level: 'L1', surface_basis: mode === 'wall' ? 'wall-face' : 'slab-soffit', substrate: 'Concrete', treatment: 'Board', system: 'System A', product: 'Product A', frl: '120/120/120', ...fields } });
  state.session = { session_id: 'first', revision: 7, snapshot: { revision: 7, items: [
    row('W1', 'wall', {}, 'confirmed'), row('W2', 'wall', { treatment: 'Spray', frl: '60/60/60' }),
    row('W3', 'wall', { level: 'L2', surface_basis: 'Retained custom plane', substrate: 'Custom substrate', treatment: 'Custom treatment', system: 'Custom system', product: 'Custom product', frl: 'Custom rating' }, 'reviewed'),
    row('W4', 'wall', { level: null, surface_basis: '', substrate: '  ', treatment: null, system: '', product: undefined, frl: '' }),
    row('W5', 'wall', {}, 'confirmed'), row('S1', 'slab', {}, 'confirmed'), row('S2', 'slab', { level: 'L2', surface_basis: 'slab-top', treatment: 'Spray' }) ], documents: [] } };
  state.resultMap.set('W5', { issues: ['Changed original source'] });
  return { audit, state, ui, context, document, element, ids: () => Array.from(audit.visibleItems(), item => item.id), all(root) { return root.children.flatMap(child => [child, ...this.all(child)]); } };
}
let passed = 0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check('Each surface register exposes exactly the nine requested accessible column filters', () => {
    const h = harness();
    for (const [mode, mark] of [['wall', 'Wall ID'], ['slab', 'Slab / zone ID']]) {
      h.state.mode = mode; h.audit.renderRegister();
      const controls = h.all(h.ui.tableWrap).filter(el => el.className.includes('takeoff-column-filter-button'));
      assert.deepEqual(controls.map(el => el.attributes['aria-label']), ['Confirmation', mark, 'Level', 'Surface basis', 'Substrate', 'Treatment', 'Protection system', 'Protection product', 'FRL / fire rating'].map(label => `Filter ${label}`));
      assert.ok(controls.every(el => el.attributes['aria-haspopup'] === 'dialog' && el.attributes['aria-pressed'] === 'false'));
      assert.equal(h.all(h.ui.tableWrap).filter(el => el.className.includes('takeoff-group-row')).length, 0);
    }
  });
  await check('All nine surface filters intersect and confirmation includes current review issues', () => {
    const h = harness(), filters = h.audit.registerFilters();
    for (const [key, values] of Object.entries({ confirmation: ['Confirmed'], mark: ['W1', 'W2', 'W5'], level: ['L1'], surface_basis: ['Wall face (true elevation)'], substrate: ['Concrete'], treatment: ['Board', 'Spray'], system: ['System A'], product: ['Product A'], frl: ['120/120/120'] })) filters.set(key, new Set(values));
    assert.deepEqual(h.ids(), ['W1']); filters.set('confirmation', new Set(['Unconfirmed'])); assert.deepEqual(h.ids(), ['W5']);
    filters.delete('confirmation'); filters.set('frl', new Set(['120/120/120', '60/60/60'])); assert.deepEqual(h.ids(), ['W1', 'W2', 'W5']);
  });
  await check('Surface basis labels match the register and unknown values remain exact; blanks are selectable', () => {
    const h = harness(); assert.deepEqual(Array.from(h.audit.registerColumnValues('surface_basis')), ['', 'Retained custom plane', 'Wall face (true elevation)']);
    h.audit.registerFilters().set('substrate', new Set([''])); assert.deepEqual(h.ids(), ['W4']);
    h.audit.registerFilters().clear(); h.audit.registerFilters().set('surface_basis', new Set(['Retained custom plane'])); assert.deepEqual(h.ids(), ['W3']);
    h.state.mode = 'slab'; assert.deepEqual(Array.from(h.audit.registerColumnValues('surface_basis')), ['Slab soffit', 'Slab top']);
    assert.equal(h.audit.registerFilterValue({ mode: 'slab', fields: { surface_basis: ' Retained custom plane ' } }, 'surface_basis'), 'Retained custom plane');
  });
  await check('Wall and Slab filter states stay independent and ignore hidden legacy dropdowns', () => {
    const h = harness(); h.audit.registerFilters().set('level', new Set(['L1'])); assert.deepEqual(h.ids(), ['W1', 'W2', 'W5']);
    h.state.mode = 'slab'; h.audit.registerFilters().set('surface_basis', new Set(['Slab top'])); assert.deepEqual(h.ids(), ['S2']);
    h.state.mode = 'wall'; assert.deepEqual(h.ids(), ['W1', 'W2', 'W5']); h.state.mode = 'slab'; assert.deepEqual(h.ids(), ['S2']);
    assert.equal(h.audit.itemGroup(h.state.session.snapshot.items.at(-1)), null);
    h.state.session.revision++; h.state.session.snapshot = copy(h.state.session.snapshot); assert.deepEqual(h.ids(), ['S2']);
    h.state.session.session_id = 'replacement'; assert.deepEqual(h.ids(), ['S1', 'S2']); h.state.mode = 'wall'; assert.equal(h.audit.registerFilters().size, 0);
  });
  await check('Search and filters combine, resetting pagination without changing selected export IDs or source records', () => {
    const h = harness(); h.audit.stubRenderers(); h.state.offset = 100; h.state.selected.add('W1'); h.state.selected.add('W3');
    const before = copy(h.state.session.snapshot), fingerprint = h.audit.projectFingerprint();
    h.audit.setRegisterColumnFilter('level', new Set(['L1'])); assert.equal(h.state.offset, 0); h.state.filter = 'spray'; assert.deepEqual(h.ids(), ['W2']);
    assert.deepEqual(Array.from(h.audit.selectedItems(), item => item.id), ['W1', 'W3']);
    assert.deepEqual(Array.from(h.audit.registerColumnValues('level')), ['', 'L1', 'L2']);
    h.audit.setRegisterColumnFilter('level', new Set()); assert.deepEqual(h.ids(), []); h.audit.setRegisterColumnFilter('level', null); assert.deepEqual(h.ids(), ['W2']);
    assert.deepEqual(copy(h.state.session.snapshot), before); assert.equal(h.audit.projectFingerprint(), fingerprint);
  });
  await check('Custom value checklists support apply/cancel/reset and cannot cross project or surface mode boundaries', async () => {
    const h = harness(); h.audit.stubRenderers(); const before = copy(h.state.session), anchor = h.element('button');
    const labeled = label => h.all(h.document.body.children[0]).find(el => el.attributes['aria-label'] === label);
    let pending = h.audit.openRegisterColumnFilter('surface_basis', anchor); let dialog = h.document.body.children[0];
    labeled('Select all values').checked = false; labeled('Select all values').events.change(); labeled('Retained custom plane').checked = true; labeled('Retained custom plane').events.change();
    dialog.close('apply'); await pending; assert.deepEqual(h.ids(), ['W3']);
    pending = h.audit.openRegisterColumnFilter('surface_basis', anchor); h.document.body.children[0].close('reset'); await pending; assert.equal(h.audit.registerFilters().size, 0);
    pending = h.audit.openRegisterColumnFilter('substrate', anchor); h.state.mode = 'slab'; h.document.body.children[0].close('apply'); await pending; assert.equal(h.audit.registerFilters().size, 0);
    h.state.mode = 'wall'; pending = h.audit.openRegisterColumnFilter('substrate', anchor); h.state.session.session_id = 'replacement'; h.document.body.children[0].close('apply'); await pending; assert.equal(h.audit.registerFilters().size, 0);
    h.state.session.session_id = 'first'; pending = h.audit.openRegisterColumnFilter('substrate', anchor); h.document.body.children[0].close('cancel'); await pending;
    assert.deepEqual(copy(h.state.session), before); assert.equal(h.state.modal, false); assert.equal(anchor.attributes['aria-expanded'], 'false');
  });
  console.log(`${passed} surface column filter UI checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
