// Run both production browser modules together. The DOM is minimal; project
// capture, confirmation, loading, request guards and downloads are unmodified.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ids = ['steel_vermiculite', 'steel_board', 'ductwork'];
const titles = ['Steel (spray)', 'Steel (board)', 'Ductwork (spray/wrap)'];
const listing = ids.map((id, index) => ({ id, title: titles[index] }));
const projectFilename = 'CEASEFIRE-Project.ceasefire-project.json';
const fileResponse = type => ({ ok: true, status: 200, headers: { get: key => key === 'Content-Type' ? type : null }, blob: async () => ({ size: 500 }) });
function definition(id) {
  return { id, title: titles[ids.indexOf(id)], pages: ['CALCULATOR'], inputs: { CALCULATOR: { A9: 'Local saved value' } },
    sheets: [{ name: 'CALCULATOR', header_rows: [], hidden_columns: [], merges: [] }], documents: [] };
}
function project() {
  return { estimate: { id: null, title: 'Imported project', project_no: 'CF-2000', client: 'Imported client', site_address: '20 Imported Road',
    workflow: 'Imported workflow', measurements: 'Imported notes', inputs: { D15: 'Imported product', B15: 234 },
    configuration: { inventory: {}, rates: { imported: { price: 98.76543 } }, catalog: { name: 'Frozen imported pricing' } }, result: { summary: { total: 456 } } },
    fields: [{ cell: 'D15', label: 'Product', type: 'select', options: ['Imported product'], default: 'Imported product' }],
    project_details: { project_no: 'CF-2000', client: 'Imported client', site_address: '20 Imported Road' },
    calculators: Object.fromEntries(ids.map(id => [id, { source_sha256: 'matching-source', inputs: { CALCULATOR: { A9: `Imported ${id}` } } }])) };
}

function harness() {
  const elements = new Map();
  function element(tagName = 'div') {
    const attrs = new Map(), classes = new Set();
    return { tagName, value: '', textContent: '', children: [], options: [], dataset: {}, style: {}, listeners: {}, parts: new Map(), files: [], validity: { badInput: false },
      classList: { add(...names) { names.forEach(name => classes.add(name)); }, contains(name) { return classes.has(name); }, toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { attrs.set(name, value); }, getAttribute(name) { return attrs.get(name); }, removeAttribute(name) { attrs.delete(name); },
      append(...nodes) { this.children.push(...nodes); this.options = this.children; }, replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      querySelector(selector) { if (!this.parts.has(selector)) this.parts.set(selector, element()); return this.parts.get(selector); }, querySelectorAll() { return []; },
      addEventListener(name, fn, options = {}) { (this.listeners[name] ||= []).push({ fn, once: options.once }); },
      async emit(name, event) { const callbacks = [...this.listeners[name] || []]; this.listeners[name] = callbacks.filter(item => !item.once); for (const item of callbacks) await item.fn(event); },
      showModal() { assert.ok(!this.open); this.open = true; }, async close(value) { this.returnValue = value; this.open = false; await this.emit('close'); },
      click() { this.clicked = true; }, remove() {}, focus() {}, blur() { this.blurred = true; }, setCustomValidity() {},
    };
  }
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = { document: { getElementById: byId, querySelector: selector => byId(selector), querySelectorAll: () => [], createElement: element, createTextNode: text => text, body: element(), activeElement: null },
    window: { addEventListener() {}, scrollTo() {}, location: { origin: 'http://127.0.0.1:8765' } },
    Intl, Number, String, JSON, Object, Set, Map, WeakMap, Array, Promise, Error, AbortController, console,
    URL: { createObjectURL: () => 'blob:project-audit', revokeObjectURL() {} }, setTimeout: () => 1, clearTimeout() {},
    FileReader: class { readAsDataURL() { this.result = 'data:application/octet-stream;base64,QUFBQQ=='; queueMicrotask(() => this.onload()); } },
  };
  vm.createContext(context);
  let calculatorSource = fs.readFileSync('static/calculators.js', 'utf8');
  const bridge = '  window.CeasefireCalculators = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject };';
  assert.ok(calculatorSource.includes(bridge), 'Calculator test hook must match the actual project bridge');
  calculatorSource = calculatorSource.replace(bridge, `${bridge}
    globalThis.calcAudit = {state, current, dirty, setInput, calculate, save, selectCalculator,
      downloadSchedulePdf, downloadExcelRegister, downloadMaterialsSummaryPdf,
      setRequest(fn) { request = fn; }};
    renderGrid = () => {};
  `);
  vm.runInContext(calculatorSource, context);
  let appSource = fs.readFileSync('static/app.js', 'utf8');
  const appEnd = /  bootstrap\(\);\s*\}\)\(\);\s*$/;
  assert.ok(appEnd.test(appSource), 'Estimator test hook must replace bootstrap only');
  appSource = appSource.replace(appEnd, `
    globalThis.appAudit = {state, saveProject, loadProject, projectStamp, saveQuote, openQuote, calculate,
      setRequest(fn) { request = fn; }};
  })();`);
  vm.runInContext(appSource, context);
  const app = context.appAudit, calc = context.calcAudit, bridgeApi = context.window.CeasefireCalculators;
  Object.assign(app.state, { configuration: { inventory: {}, rates: { local: { price: 12 } } }, draft: { inventory: {}, rates: { unsavedLibrary: { price: 14 } } },
    quote: { id: 'existing-quote' }, quoteConfiguration: { inventory: {}, rates: { frozen: { price: 17.12345 } } },
    inputs: { D15: 'Local product', B15: 123 }, fields: [{ cell: 'D15', label: 'Product', type: 'select', options: ['Local product'] }],
    currentFields: [{ cell: 'D15', options: ['Current library product'] }], workflow: 'Local workflow', dirty: true, pricingDirty: true });
  byId('project-no').value = ' CF-1000 '; byId('client').value = 'Local client'; byId('site-address').value = '10 Local Road'; byId('measurements').value = 'Local notes';
  Object.assign(calc.state, { list: copy(listing), current: 'steel_board' });
  function addEntry(id, inputs = { CALCULATOR: { A9: `Unsaved ${id}` } }) {
    const entry = { definition: definition(id), inputs: copy(inputs), saved: JSON.stringify({ CALCULATOR: { A9: `Saved ${id}` } }),
      revision: 2, page: 'CALCULATOR', sheet: 'CALCULATOR', needsRender: true, invalid: new Map(), result: null, pendingResult: null, labels: {} };
    calc.state.entries.set(id, entry); return entry;
  }
  addEntry('steel_vermiculite'); addEntry('steel_board');
  const calls = [];
  calc.setRequest(async (path, options) => { calls.push({ path, options }); if (path === '/api/calculators') return { calculators: copy(listing) }; return definition(path.split('/').at(-1)); });
  app.setRequest(async (path, options) => { calls.push({ path, options }); assert.equal(path, '/api/project/import'); return project(); });
  function chooseFile() { byId('project-import-file').files = [{ name: projectFilename, size: 600 }]; }
  function snapshot() { return copy({ estimate: { inputs: app.state.inputs, configuration: app.state.quoteConfiguration, quote: app.state.quote },
    pricing: app.state.configuration, pricingDraft: app.state.draft, calculators: bridgeApi.projectSnapshot(), details: context.window.CeasefireProject.details() }); }
  async function loadAccepted() { chooseFile(); const pending = app.loadProject(); await flush(); assert.equal(byId('discard-dialog').open, true); await byId('discard-dialog').close('confirm'); await pending; }
  return { context, app, calc, bridgeApi, byId, element, addEntry, calls, chooseFile, snapshot, loadAccepted };
}

let passed = 0;
async function check(name, fn) { await fn(harness()); passed++; console.log(`ok - ${name}`); }
(async () => {
  await check('Export captures active snapshot and loaded unsaved drafts while leaving unopened calculators for backend fallback', async h => {
    const before = h.snapshot(), pending = deferred(); let sent;
    h.context.fetch = async (path, options) => { sent = { path, body: JSON.parse(options.body), method: options.method }; return pending.promise; };
    const exporting = h.app.saveProject();
    assert.equal(sent.path, '/api/project/export'); assert.equal(sent.method, 'POST');
    assert.deepEqual(sent.body.estimate.configuration, before.estimate.configuration);
    assert.equal(sent.body.estimate.project_no, 'CF-1000'); assert.equal(sent.body.estimate.source_quote_id, undefined);
    assert.deepEqual(sent.body.calculators, before.calculators); assert.equal(sent.body.calculators.ductwork, undefined);
    assert.deepEqual(h.snapshot(), before); assert.equal(h.app.state.dirty, true);
    h.app.state.inputs.B15 = 999; h.calc.setInput(h.calc.current(), 'CALCULATOR', 'A9', 'Later board edit');
    pending.resolve(fileResponse('application/octet-stream')); await exporting;
    assert.equal(h.context.document.body.children.at(-1)?.download, projectFilename);
    assert.match(h.byId('app-message').textContent, /Later edits are not included/);
    assert.equal(h.app.state.inputs.B15, 999); assert.equal(h.calc.current().inputs.CALCULATOR.A9, 'Later board edit');
    assert.equal(h.app.state.dirty, true); assert.equal(h.calc.dirty(h.calc.current()), true); assert.equal(h.calls.length, 0);
  });

  await check('Export rejects invalid inputs or an active calculator save without requesting a file', async h => {
    let calls = 0; h.context.fetch = async () => { calls++; };
    h.app.state.inputErrors.set('B15', 'Whole numbers required'); await h.app.saveProject();
    assert.match(h.byId('app-message').textContent, /Whole numbers/); h.app.state.inputErrors.clear();
    h.calc.current().invalid.set('A9', 'Invalid cell'); await h.app.saveProject(); h.calc.current().invalid.clear();
    h.calc.state.action = true; await h.app.saveProject(); assert.equal(calls, 0); assert.equal(h.app.state.projectBusy, false);
  });

  await check('Canceling Load Project keeps every draft and local pricing after read-only preparation', async h => {
    const before = h.snapshot(); h.chooseFile(); const loading = h.app.loadProject(); await flush();
    assert.equal(h.byId('discard-dialog').open, true); assert.match(h.byId('discard-dialog').querySelector('p').textContent, /CF-2000/);
    assert.deepEqual(h.snapshot(), before); await h.byId('discard-dialog').close('cancel'); await loading;
    assert.deepEqual(h.snapshot(), before); assert.match(h.byId('app-message').textContent, /cancelled/);
    assert.ok(h.calls.some(call => call.path === '/api/calculators/ductwork'));
    assert.ok(h.calls.every(call => !call.options || call.options.method !== 'PUT'));
  });

  await check('Accepted project atomically becomes a new estimate with all three unsaved calculator drafts', async h => {
    const pricing = copy(h.app.state.configuration), libraryDraft = copy(h.app.state.draft), currentFields = copy(h.app.state.currentFields);
    const loadRevision = h.calc.state.loadRevision, requestRevision = h.calc.state.requestRevision;
    h.calc.state.optionLists.set('stale', {}); await h.loadAccepted();
    assert.equal(h.app.state.quote, null); assert.equal(h.app.state.dirty, true);
    assert.deepEqual(copy(h.app.state.inputs), project().estimate.inputs);
    assert.deepEqual(copy(h.app.state.quoteConfiguration), project().estimate.configuration);
    assert.deepEqual(copy(h.app.state.fields), project().fields);
    assert.deepEqual(copy(h.app.state.configuration), pricing); assert.deepEqual(copy(h.app.state.draft), libraryDraft);
    assert.deepEqual(copy(h.app.state.currentFields), currentFields);
    assert.deepEqual(copy(h.context.window.CeasefireProject.details()), project().project_details);
    assert.equal(h.byId('measurements').value, 'Imported notes'); assert.equal(h.calc.state.entries.size, 3);
    for (const id of ids) { const entry = h.calc.state.entries.get(id); assert.equal(entry.saved, null); assert.equal(h.calc.dirty(entry), true); assert.equal(entry.inputs.CALCULATOR.A9, `Imported ${id}`); }
    assert.equal(h.calc.state.current, null); assert.equal(h.calc.state.optionLists.size, 0);
    assert.equal(h.calc.state.loadRevision, loadRevision + 1); assert.equal(h.calc.state.requestRevision, requestRevision + 1);
    assert.equal(h.byId('calculator-workspace').hidden, true);
    assert.ok(h.calls.every(call => !call.options || call.options.method !== 'PUT'));
  });

  for (const editing of ['estimate', 'calculator', 'project details']) await check(`Edits to ${editing} during file loading prevent replacement`, async h => {
    const pending = deferred(); h.app.setRequest(() => pending.promise); h.chooseFile(); const loading = h.app.loadProject(); await flush();
    if (editing === 'estimate') h.app.state.inputs.B15 = 777;
    else if (editing === 'calculator') h.calc.setInput(h.calc.current(), 'CALCULATOR', 'A9', 'New edit');
    else h.byId('client').value = 'New client';
    const before = h.snapshot(); pending.resolve(project()); await loading;
    assert.deepEqual(h.snapshot(), before); assert.match(h.byId('app-message').textContent, /changed while reading/); assert.ok(!h.byId('discard-dialog').open);
  });

  await check('Edits made while the confirmation is open prevent replacement even after confirmation', async h => {
    h.chooseFile(); const loading = h.app.loadProject(); await flush(); h.calc.setInput(h.calc.current(), 'CALCULATOR', 'A9', 'Review-time change');
    const before = h.snapshot(); await h.byId('discard-dialog').close('confirm'); await loading;
    assert.deepEqual(h.snapshot(), before); assert.match(h.byId('app-message').textContent, /changed during review/);
  });

  for (const stage of ['import', 'calculator definitions']) await check(`${stage} network failure leaves both workspaces intact`, async h => {
    const before = h.snapshot();
    if (stage === 'import') h.app.setRequest(async () => { throw new Error('Import offline'); });
    else h.calc.setRequest(async () => { throw new Error('Definitions offline'); });
    h.chooseFile(); await h.app.loadProject(); assert.deepEqual(h.snapshot(), before);
    assert.match(h.byId('app-message').textContent, /offline/); assert.equal(h.app.state.projectBusy, false); assert.ok(!h.byId('discard-dialog').open);
  });

  await check('Late saved-quote load cannot replace the newly loaded project', async h => {
    const old = deferred(); h.app.setRequest(path => path === '/api/project/import' ? Promise.resolve(project()) : old.promise);
    const loadingQuote = h.app.openQuote('old', h.element('button')); await h.loadAccepted();
    const before = h.snapshot(); old.resolve({ id: 'old', inputs: { B15: 1 }, configuration: {} }); await loadingQuote;
    assert.deepEqual(h.snapshot(), before); assert.equal(h.app.state.quote, null); assert.ok(!h.byId('discard-dialog').open);
  });

  await check('Late quote-save response cannot attach its saved identity or pricing to the loaded project', async h => {
    const old = deferred(); h.app.setRequest(path => path === '/api/project/import' ? Promise.resolve(project()) : old.promise);
    const savingQuote = h.app.saveQuote(); await h.loadAccepted(); const before = h.snapshot();
    old.resolve({ id: 'old-save', configuration: { old: true }, inputs: { B15: 1 } }); await savingQuote;
    assert.deepEqual(h.snapshot(), before); assert.equal(h.app.state.quote, null); assert.equal(h.app.state.dirty, true);
  });

  await check('Late worksheet result cannot replace imported calculator inputs', async h => {
    const old = deferred(); h.calc.setRequest(path => path.endsWith('/worksheet') ? old.promise : Promise.resolve(definition(path.split('/').at(-1))));
    const calculating = h.calc.calculate(); await h.loadAccepted(); const before = h.snapshot();
    old.resolve({ inputs: { CALCULATOR: { A9: 'Stale calculated input' } }, rows: [] }); await calculating;
    assert.deepEqual(h.snapshot(), before); assert.equal(h.calc.state.entries.get('steel_board').result, null);
  });

  await check('Late first-open definition cannot restore a calculator from before the project load', async h => {
    const old = deferred(); let definitions = 0;
    h.calc.setRequest(path => { assert.equal(path, '/api/calculators/ductwork'); return ++definitions === 1 ? old.promise : Promise.resolve(definition('ductwork')); });
    const selecting = h.calc.selectCalculator('ductwork'); await h.loadAccepted(); const before = h.snapshot();
    old.resolve(definition('ductwork')); await selecting; assert.deepEqual(h.snapshot(), before); assert.equal(h.calc.state.current, null);
  });

  await check('An in-flight calculator save blocks project apply until it finishes and keeps the current drafts', async h => {
    h.chooseFile(); const loading = h.app.loadProject(); await flush();
    const old = deferred(); h.calc.setRequest(() => old.promise); const entry = h.calc.current(), savedInputs = copy(entry.inputs);
    const saving = h.calc.save(); await h.byId('discard-dialog').close('confirm'); await loading;
    assert.equal(h.app.state.quote.id, 'existing-quote'); assert.equal(h.calc.current(), entry);
    assert.match(h.byId('app-message').textContent, /changed during review/);
    old.resolve({ inputs: savedInputs }); await saving; assert.equal(h.calc.current(), entry); assert.equal(h.app.state.quote.id, 'existing-quote');
  });

  await check('Preparation supports a never-opened Calculators view without applying saved defaults over imported inputs', async h => {
    h.calc.state.entries.clear(); h.calc.state.list = null; h.calc.state.current = null;
    await h.loadAccepted(); assert.equal(h.calc.state.entries.size, 3);
    assert.ok(h.calls.some(call => call.path === '/api/calculators'));
    for (const id of ids) assert.equal(h.calc.state.entries.get(id).inputs.CALCULATOR.A9, `Imported ${id}`);
  });

  for (const id of ids) for (const action of ['schedule', 'summary', 'xlsx']) await check(`${id} ${action} download captures project identity only for PDFs`, async h => {
    const entry = h.calc.state.entries.get(id) || h.addEntry(id); h.calc.state.current = id;
    const pending = deferred(); let sent;
    h.context.fetch = (path, options) => { sent = { path, body: JSON.parse(options.body) }; return pending.promise; };
    const details = copy(h.context.window.CeasefireProject.details()), inputs = copy(entry.inputs);
    const download = ({ schedule: h.calc.downloadSchedulePdf, summary: h.calc.downloadMaterialsSummaryPdf, xlsx: h.calc.downloadExcelRegister })[action]();
    assert.deepEqual(sent.body.inputs, inputs);
    if (action === 'xlsx') assert.deepEqual(Object.keys(sent.body), ['inputs']);
    else assert.deepEqual(sent.body.project_details, details);
    h.byId('client').value = 'Client changed after click';
    pending.resolve(fileResponse(action === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')); await download;
    if (action !== 'xlsx') assert.match(h.byId('calculator-message').textContent, /later edits are not included/);
    assert.equal(h.byId('client').value, 'Client changed after click'); assert.deepEqual(copy(entry.inputs), inputs); assert.equal(h.calc.dirty(entry), true);
    const next = deferred(); h.context.fetch = (path, options) => { sent = { path, body: JSON.parse(options.body) }; return next.promise; };
    const downloadAgain = ({ schedule: h.calc.downloadSchedulePdf, summary: h.calc.downloadMaterialsSummaryPdf, xlsx: h.calc.downloadExcelRegister })[action]();
    if (action !== 'xlsx') assert.equal(sent.body.project_details.client, 'Client changed after click');
    next.resolve(fileResponse(action === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')); await downloadAgain;
  });
  console.log(`${passed} project UI regression checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
