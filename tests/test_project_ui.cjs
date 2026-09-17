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
const fileResponse = type => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({saved:true,path:`C:/Downloads/report.${type.includes('spreadsheet')?'xlsx':'pdf'}`,filename:`report.${type.includes('spreadsheet')?'xlsx':'pdf'}`,destination:'downloads'}) });
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
  vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
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
    globalThis.appAudit = {state, saveProject, loadProject, openNativeProject, newQuote, projectStamp, saveQuote, openQuote, calculate,
      applyProjectPricing,savePricing,switchPricingScope,useCurrentPricing,loadProjects,linkProjectFolder,openProjectFile,projectPricingChanged,resetProjectPricing,pricingInputProblem,updateProjectStatus,showView,
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
  await check('Save As captures estimate and every loaded calculator, preserving edits made while the dialog is open', async h => {
    const before = h.snapshot(), pending = deferred(); let sent;
    h.app.setRequest((path, options) => { sent = { path, body: JSON.parse(options.body), method: options.method }; return pending.promise; });
    const saving = h.app.saveProject(); await flush();
    assert.equal(sent.path, '/api/project/save-as'); assert.equal(sent.method, 'POST');
    assert.deepEqual(sent.body.estimate.configuration, before.estimate.configuration);
    assert.equal(sent.body.estimate.project_no, 'CF-1000'); assert.equal(sent.body.estimate.source_quote_id, undefined);
    assert.deepEqual(sent.body.calculators.steel_board, before.calculators.steel_board); assert.equal(sent.body.calculators.ductwork.inputs.CALCULATOR.A9,'Local saved value');
    const saved = { ...project(), estimate: { ...sent.body.estimate }, calculators: { ...project().calculators, ...sent.body.calculators } };
    h.app.state.inputs.B15 = 999; h.calc.setInput(h.calc.current(), 'CALCULATOR', 'A9', 'Later board edit');
    pending.resolve({ cancelled:false, file:{name:projectFilename,path:'C:/estimates/'+projectFilename}, project:saved }); await saving;
    assert.equal(h.app.state.inputs.B15, 999); assert.equal(h.calc.current().inputs.CALCULATOR.A9, 'Later board edit');
    assert.equal(h.app.state.dirty, true); assert.equal(h.calc.dirty(h.calc.current()), true);
    assert.match(h.byId('app-message').textContent, /Later edits are not included/);
    assert.equal(h.calc.dirty(h.calc.state.entries.get('steel_vermiculite')),false);
    assert.equal(h.context.document.body.children.length,0);
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

  await check('Accepted project atomically restores a clean estimate and all calculators while keeping shared pricing isolated', async h => {
    const pricing = copy(h.app.state.configuration), libraryDraft = copy(h.app.state.draft), currentFields = copy(h.app.state.currentFields);
    const loadRevision = h.calc.state.loadRevision, requestRevision = h.calc.state.requestRevision;
    h.calc.state.optionLists.set('stale', {}); await h.loadAccepted();
    assert.equal(h.app.state.quote, null); assert.equal(h.app.state.dirty, false);
    assert.deepEqual(copy(h.app.state.inputs), project().estimate.inputs);
    assert.deepEqual(copy(h.app.state.quoteConfiguration), project().estimate.configuration);
    assert.deepEqual(copy(h.app.state.fields), project().fields);
    assert.deepEqual(copy(h.app.state.configuration), pricing); assert.deepEqual(copy(h.app.state.libraryDraft), libraryDraft); assert.deepEqual(copy(h.app.state.draft), project().estimate.configuration);
    assert.deepEqual(copy(h.app.state.currentFields), currentFields);
    assert.deepEqual(copy(h.context.window.CeasefireProject.details()), project().project_details);
    assert.equal(h.byId('measurements').value, 'Imported notes'); assert.equal(h.calc.state.entries.size, 3);
    for (const id of ids) { const entry = h.calc.state.entries.get(id); assert.equal(entry.saved, JSON.stringify(project().calculators[id].inputs)); assert.equal(h.calc.dirty(entry), false); assert.equal(entry.inputs.CALCULATOR.A9, `Imported ${id}`); }
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
    assert.deepEqual(h.snapshot(), before); assert.equal(h.app.state.quote, null); assert.equal(h.app.state.dirty, false);
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
    if (action === 'xlsx') assert.deepEqual(Object.keys(sent.body), ['inputs','download']);
    else assert.deepEqual(sent.body.project_details, details);
    assert.deepEqual(sent.body.download,{project_token:null});
    h.byId('client').value = 'Client changed after click';
    pending.resolve(fileResponse(action === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')); await download;
    if (action !== 'xlsx') assert.match(h.byId('calculator-message').textContent, /later edits are not included/);
    assert.equal(h.byId('client').value, 'Client changed after click'); assert.deepEqual(copy(entry.inputs), inputs); assert.equal(h.calc.dirty(entry), true);
    const next = deferred(); h.context.fetch = (path, options) => { sent = { path, body: JSON.parse(options.body) }; return next.promise; };
    const downloadAgain = ({ schedule: h.calc.downloadSchedulePdf, summary: h.calc.downloadMaterialsSummaryPdf, xlsx: h.calc.downloadExcelRegister })[action]();
    if (action !== 'xlsx') assert.equal(sent.body.project_details.client, 'Client changed after click');
    next.resolve(fileResponse(action === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')); await downloadAgain;
  });
  await check('Cancelled Save As keeps dirty state and writes no independent quote, calculator or shared pricing record', async h => {
    h.app.setRequest(async(path)=>{assert.equal(path,'/api/project/save-as');return {cancelled:true};});
    await h.app.saveProject();assert.equal(h.app.state.dirty,true);assert.equal(h.calc.dirty(h.calc.current()),true);
    assert.equal(h.app.state.projectFile,null);assert.match(h.byId('app-message').textContent,/cancelled/);
  });
  await check('Successful Save As marks every captured calculator saved and freezes project pricing', async h => {
    const shared=copy(h.app.state.configuration);let captured;
    h.app.setRequest(async(path,options)=>{assert.equal(path,'/api/project/save-as');captured=JSON.parse(options.body);return {cancelled:false,file:{name:'saved.json',path:'C:/estimates/saved.json'},project:{...project(),estimate:captured.estimate,calculators:captured.calculators}};});
    await h.app.saveProject();assert.equal(h.app.state.dirty,false);assert.equal(h.app.state.quote,null);
    assert.equal(h.calc.state.entries.size,3);for(const entry of h.calc.state.entries.values())assert.equal(h.calc.dirty(entry),false);
    assert.deepEqual(copy(h.app.state.configuration),shared);assert.deepEqual(copy(h.app.state.quoteConfiguration),captured.estimate.configuration);
  });
  await check('Save without an authorized file shows the requested popup and sends no request', async h => {
    h.app.setRequest(async()=>{throw new Error('Save must not send a request');});
    for(const file of [null,{name:'uploaded.json',path:'C:/fakepath/uploaded.json'}]) {
      h.app.state.projectFile=file;const before=h.snapshot();await h.app.saveProject(false);
      assert.equal(h.byId('save-required-dialog').open,true);assert.deepEqual(h.snapshot(),before);assert.equal(h.app.state.projectFile,file);
      await h.byId('save-required-dialog').close('close');
    }
    assert.equal(h.calls.length,0);
    assert.ok(fs.readFileSync('static/index.html','utf8').includes('You have not yet created a Project, please click "Save As"'));
  });
  await check('Save sends the current capability and complete precise state, then keeps the rotated target', async h => {
    h.addEntry('ductwork');
    h.app.state.projectFile={name:'existing.json',path:'C:/estimates/existing.json',save_token:'authorized-original'};
    h.app.state.inputs.B15=432.123456789;
    for(const [index,id] of ids.entries())h.calc.state.entries.get(id).inputs.CALCULATOR.F9=1.234567890123+index;
    const before=h.snapshot(),paths=[];
    h.app.setRequest(async(path,options)=>{
      paths.push(path);const body=JSON.parse(options.body);assert.equal(body.save_token,'authorized-original');assert.equal(body.path,undefined);
      assert.equal(body.estimate.inputs.B15,432.123456789);assert.deepEqual(body.estimate.configuration,before.estimate.configuration);
      assert.deepEqual(body.calculators,before.calculators);
      return {cancelled:false,file:{name:'existing.json',path:'C:/estimates/existing.json',save_token:'authorized-next'},project:{...project(),estimate:body.estimate,calculators:body.calculators}};
    });
    await h.app.saveProject(false);assert.deepEqual(paths,['/api/project/save']);assert.equal(h.app.state.projectFile.save_token,'authorized-next');
    assert.equal(h.app.state.inputs.B15,432.123456789);assert.equal(h.app.state.dirty,false);
    for(const entry of h.calc.state.entries.values())assert.equal(h.calc.dirty(entry),false);
  });
  await check('Edits during Save remain unsaved while its returned capability points to the saved snapshot', async h => {
    h.addEntry('ductwork');h.app.state.projectFile={name:'saved.json',path:'C:/estimates/saved.json',save_token:'old'};
    const pending=deferred();let payload;h.app.setRequest((path,options)=>{assert.equal(path,'/api/project/save');payload=JSON.parse(options.body);return pending.promise;});
    const saving=h.app.saveProject(false);await flush();h.app.state.inputs.B15=789.123456789;h.calc.setInput(h.calc.current(),'CALCULATOR','A9','Later board');
    pending.resolve({cancelled:false,file:{name:'saved.json',path:'C:/estimates/saved.json',save_token:'new'},project:{...project(),estimate:payload.estimate,calculators:payload.calculators}});await saving;
    assert.equal(h.app.state.projectFile.save_token,'new');assert.equal(h.app.state.inputs.B15,789.123456789);
    assert.equal(h.app.state.dirty,true);assert.equal(h.calc.dirty(h.calc.current()),true);assert.match(h.byId('app-message').textContent,/Later edits are not included/);
  });
  for(const failure of ['cancel','failure'])await check(`Save As ${failure} retains the previous target and unapplied project pricing draft`, async h => {
    h.addEntry('ductwork');const file={name:'original.json',path:'C:/estimates/original.json',save_token:'keep-me'};h.app.state.projectFile=file;
    h.app.switchPricingScope('project');h.app.state.draft.rates.frozen.price=123.456789;const before=h.snapshot();
    h.app.setRequest(async(path,options)=>{
      if(path==='/api/configuration/preview')return {configuration:JSON.parse(options.body).configuration,fields:copy(h.app.state.fields)};
      assert.equal(path,'/api/project/save-as');if(failure==='failure')throw new Error('File locked');return {cancelled:true};
    });
    await h.app.saveProject();assert.equal(h.app.state.projectFile,file);assert.deepEqual(h.snapshot(),before);
    assert.equal(h.app.state.quoteConfiguration.rates.frozen.price,17.12345);assert.equal(h.app.state.draft.rates.frozen.price,123.456789);
  });
  await check('Native Load cancellation retains the existing target and native Load acceptance enables Save', async h => {
    const original={name:'old.json',save_token:'old'};h.app.state.projectFile=original;const before=h.snapshot();
    h.app.setRequest(async(path,options)=>{assert.equal(path,'/api/project/open');assert.deepEqual(JSON.parse(options.body),{});return {cancelled:true};});
    await h.app.openNativeProject();assert.equal(h.app.state.projectFile,original);assert.deepEqual(h.snapshot(),before);
    const loaded={name:'loaded.json',path:'C:/estimates/loaded.json',save_token:'loaded'};
    h.app.setRequest(async()=>({...project(),file:loaded,cancelled:false}));
    let loading=h.app.openNativeProject();await flush();await h.byId('discard-dialog').close('cancel');await loading;
    assert.equal(h.app.state.projectFile,original);assert.deepEqual(h.snapshot(),before);
    loading=h.app.openNativeProject();await flush();await h.byId('discard-dialog').close('confirm');await loading;
    assert.equal(h.app.state.projectFile.save_token,'loaded');
    h.app.setRequest(async(path,options)=>{assert.equal(path,'/api/project/save');assert.equal(JSON.parse(options.body).save_token,'loaded');return {cancelled:true};});
    await h.app.saveProject(false);
  });
  await check('A browser-imported project cannot grant a writable target', async h => {
    await h.loadAccepted();assert.equal(h.app.state.projectFile.save_token,undefined);let requested=false;
    h.app.setRequest(async()=>{requested=true;});await h.app.saveProject(false);
    assert.equal(requested,false);assert.equal(h.byId('save-required-dialog').open,true);
  });
  await check('Starting a new project clears the previous Save target', async h => {
    h.app.state.projectFile={name:'old.json',save_token:'old'};h.app.state.initialized=true;
    const creating=h.app.newQuote();await flush();await h.byId('discard-dialog').close('confirm');await creating;
    assert.equal(h.app.state.projectFile,null);await h.app.saveProject(false);assert.equal(h.byId('save-required-dialog').open,true);
  });
  await check('Project pricing changes are validated without changing shared rates and are included by Save Project', async h => {
    h.app.switchPricingScope('project');h.app.state.draft.rates.frozen.price=42.75;
    const shared=copy(h.app.state.configuration),library=copy(h.app.state.libraryDraft),paths=[];let saved;
    h.app.setRequest(async(path,options)=>{paths.push(path);const body=JSON.parse(options.body);
      if(path==='/api/configuration/preview')return {configuration:body.configuration,fields:copy(h.app.state.fields)};
      assert.equal(path,'/api/project/save-as');saved=body;return {cancelled:false,file:{name:'saved.json',path:'C:/estimates/saved.json'},project:{...project(),estimate:body.estimate,calculators:body.calculators}};
    });
    await h.app.saveProject();assert.deepEqual(paths,['/api/configuration/preview','/api/project/save-as']);assert.equal(saved.estimate.configuration.rates.frozen.price,42.75);
    assert.deepEqual(copy(h.app.state.configuration),shared);assert.deepEqual(copy(h.app.state.libraryDraft),library);assert.equal(h.app.state.dirty,false);
  });
  await check('Saving pending project pricing refreshes visible totals with the saved prices', async h => {
    h.app.switchPricingScope('project');h.app.state.draft.rates.frozen.price=42.123456789;
    h.app.state.result={summary:{total:111}};const timers=[];let calculated;
    h.context.setTimeout=callback=>{timers.push(callback);return timers.length;};
    h.app.setRequest(async(path,options)=>{
      const body=JSON.parse(options.body);
      if(path==='/api/configuration/preview')return {configuration:body.configuration,fields:copy(h.app.state.fields)};
      if(path==='/api/calculate'){calculated=body;return {summary:{total:987.65},cells:{},materials:[],errors:{},labour:[]};}
      assert.equal(path,'/api/project/save-as');return {cancelled:false,file:{name:'saved.json',path:'C:/estimates/saved.json',save_token:'saved'},project:{...project(),estimate:body.estimate,calculators:body.calculators}};
    });
    await h.app.saveProject();assert.equal(h.app.state.result,null);assert.match(h.byId('calculation-status').textContent,/Calculating/);
    assert.ok(timers.length);timers.at(-1)();await flush();
    assert.equal(calculated.configuration.rates.frozen.price,42.123456789);assert.equal(h.app.state.result.summary.total,987.65);
    assert.equal(h.byId('sum-total').textContent,'$987.65');assert.equal(h.app.state.dirty,false);
  });
  await check('New estimate follows newly saved shared library and Save Project does not restore stale prices', async h => {
    h.app.state.quote=null;h.app.state.quoteConfiguration=null;h.app.state.projectPricingDraft=copy(h.app.state.configuration);
    h.app.state.draft=copy(h.app.state.configuration);h.app.state.draft.rates.local.price=99;h.app.state.libraryDraft=h.app.state.draft;
    const next=copy(h.app.state.draft);let saved;
    h.app.setRequest(async(path,options)=>{
      if(path==='/api/configuration')return next;
      if(path==='/api/bootstrap')return {configuration:next,fields:copy(h.app.state.currentFields)};
      assert.equal(path,'/api/project/save-as');saved=JSON.parse(options.body);return {cancelled:true};
    });
    await h.app.savePricing();assert.equal(h.app.state.projectPricingDraft.rates.local.price,99);
    await h.app.saveProject();assert.equal(saved.estimate.configuration.rates.local.price,99);
  });
  await check('Invalid estimate edits arriving during pricing preview prevent Save As and stay visible', async h => {
    h.app.switchPricingScope('project');h.app.state.draft.rates.frozen.price=123;
    const pending=deferred();let calls=0;h.app.setRequest(()=>{calls++;return pending.promise;});
    const saving=h.app.saveProject();await flush();h.app.state.inputRevision++;h.app.state.inputErrors.set('B15','Whole number required');h.app.state.inputDrafts.set('B15','1.5');
    pending.resolve({configuration:copy(h.app.state.draft),fields:copy(h.app.state.fields)});await saving;
    assert.equal(calls,1);assert.equal(h.app.state.inputDrafts.get('B15'),'1.5');assert.match(h.byId('app-message').textContent,/Whole number/);
  });
  await check('Scope switching retains both unsaved pricing drafts without applying either to the other', async h => {
    const library=h.app.state.draft;h.app.switchPricingScope('project');const local=h.app.state.draft;local.rates.frozen.price=345;
    h.app.switchPricingScope('library');assert.equal(h.app.state.draft,library);h.app.switchPricingScope('project');assert.equal(h.app.state.draft,local);
    assert.equal(h.app.state.quoteConfiguration.rates.frozen.price,17.12345);assert.equal(h.app.state.configuration.rates.local.price,12);
  });
  await check('Late shared pricing save updates only its own scope after a project editor is opened', async h => {
    h.app.state.libraryDraft=h.app.state.draft;const pending=deferred();const draft=copy(h.app.state.draft);
    h.app.setRequest(path=>path==='/api/configuration'?pending.promise:Promise.resolve({configuration:draft,fields:copy(h.app.state.currentFields)}));
    const saving=h.app.savePricing();h.app.switchPricingScope('project');const local=h.app.state.draft;local.rates.frozen.price=76;
    pending.resolve(draft);await saving;assert.equal(h.app.state.draft,local);assert.equal(h.app.state.draft.rates.frozen.price,76);assert.equal(h.app.state.pricingScope,'project');
  });
  await check('Switching to unchanged project prices during a shared save follows the new baseline', async h => {
    h.app.state.quote=null;h.app.state.quoteConfiguration=null;h.app.state.projectPricingDraft=copy(h.app.state.configuration);
    h.app.state.draft=copy(h.app.state.configuration);h.app.state.draft.rates.local.price=111;h.app.state.libraryDraft=h.app.state.draft;
    const next=copy(h.app.state.draft),pending=deferred();
    h.app.setRequest(path=>path==='/api/configuration'?pending.promise:Promise.resolve({configuration:next,fields:copy(h.app.state.currentFields)}));
    const saving=h.app.savePricing();h.app.switchPricingScope('project');assert.equal(h.app.state.draft.rates.local.price,12);
    pending.resolve(next);await saving;assert.equal(h.app.state.draft,h.app.state.projectPricingDraft);assert.equal(h.app.state.draft.rates.local.price,111);assert.equal(h.app.projectPricingChanged(),false);
  });
  await check('Save As failure retains estimate and calculator edits for retry', async h => {
    h.app.setRequest(async()=>{throw new Error('Folder is read only');});await h.app.saveProject();
    assert.equal(h.app.state.dirty,true);assert.equal(h.calc.dirty(h.calc.current()),true);assert.equal(h.app.state.projectFile,null);assert.equal(h.app.state.projectBusy,false);assert.match(h.byId('app-message').textContent,/Folder is read only/);
  });
  await check('Folder library loads the selected opaque file and restores the entire project', async h => {
    const paths=[];h.app.setRequest(async(path,options)=>{paths.push(path);if(path==='/api/projects')return {folder:'C:/estimates',files:[{id:'opaque',name:'project.json',title:'Project',modified_at:'2026-09-16T00:00:00Z'}],errors:[]};assert.equal(JSON.parse(options.body).id,'opaque');return {...project(),file:{name:'project.json'}};});
    await h.app.loadProjects();assert.match(h.byId('project-folder').textContent,/C:\/estimates/);assert.equal(h.byId('project-list').children.length,1);
    const opening=h.app.openProjectFile({id:'opaque',name:'project.json'},h.element('button'));await flush();await h.byId('discard-dialog').close('confirm');await opening;
    assert.deepEqual(paths,['/api/projects','/api/projects/load']);assert.equal(h.app.state.dirty,false);assert.equal(h.calc.state.entries.size,3);
  });
  await check('Persistent project status reflects saved path, file time and calculator-only edits', async h => {
    h.app.state.dirty=false;h.app.state.projectPricingDraft=copy(h.app.state.quoteConfiguration);
    h.app.state.projectFile={name:'Quote.json',path:'C:/Estimates/Client/Quote.json',modified_at:'2026-09-17T01:23:00Z'};
    h.bridgeApi.markProjectSaved(h.bridgeApi.projectSnapshot());h.app.updateProjectStatus();
    assert.equal(h.byId('project-save-state').textContent,'Saved project');assert.equal(h.byId('project-file-location').textContent,'C:/Estimates/Client/Quote.json');
    assert.match(h.byId('project-last-saved').textContent,/File saved/);assert.match(h.byId('project-pricing-source').textContent,/project snapshot/);
    h.calc.setInput(h.calc.current(),'CALCULATOR','A9','Changed calculator');
    assert.equal(h.byId('project-save-state').textContent,'Unsaved changes');
  });
  await check('Project status includes project pricing edits but excludes shared library edits', async h => {
    h.app.state.dirty=false;h.app.state.projectFile={name:'saved.json'};h.app.state.projectPricingDraft=copy(h.app.state.quoteConfiguration);
    h.bridgeApi.markProjectSaved(h.bridgeApi.projectSnapshot());h.app.updateProjectStatus();
    assert.equal(h.byId('project-save-state').textContent,'Saved project');
    h.app.switchPricingScope('project');h.app.state.draft.rates.frozen.price=200;h.app.updateProjectStatus();
    assert.equal(h.byId('project-save-state').textContent,'Unsaved changes');
    h.app.state.draft.rates.frozen.price=17.12345;h.app.updateProjectStatus();
    assert.equal(h.byId('project-save-state').textContent,'Saved project');
  });
  await check('Folder search and paging retain relative paths and never fetch older estimate saves', async h => {
    const calls=[];h.byId('project-search').value='Client & north';h.byId('project-sort').value='name_asc';
    h.app.setRequest(async path=>{calls.push(path);return {folder:'C:/Estimates',files:[{id:'nested',name:'Quote.json',relative_path:'Client/north/Quote.json',title:'Quote',modified_at:'2026-09-17T00:00:00Z'}],total:500,matched:120,offset:100,errors:[],scan_pending:true,scanned_entries:2000};});
    await h.app.loadProjects({offset:100});
    assert.equal(calls[0],'/api/projects?search=Client%20%26%20north&sort=name_asc&offset=100');
    assert.equal(h.byId('project-list').children[0].children[0].children[2].textContent,'Client/north/Quote.json');
    assert.match(h.byId('project-list-status').textContent,/101–101 of 120/);assert.equal(h.byId('project-continue').hidden,false);
    assert.equal(h.byId('project-previous').disabled,false);assert.equal(h.byId('project-next').disabled,false);
  });
  await check('Late folder search cannot replace a newer search result', async h => {
    const pending=deferred();let count=0;h.app.setRequest(()=>++count===1?pending.promise:Promise.resolve({files:[],folder:'New folder',total:0,matched:0,errors:[]}));
    const first=h.app.loadProjects();h.byId('project-search').value='new';await h.app.loadProjects({offset:0});
    pending.resolve({folder:'Old folder',files:[],errors:[]});await first;assert.equal(h.byId('project-folder').textContent,'New folder');
    assert.match(h.byId('project-list').children[0].textContent,/No projects match/);
  });
  await check('Saved projects view has no request or control for older estimate-only records', async h => {
    const calls=[];h.app.setRequest(async path=>{calls.push(path);return {files:[],errors:[]};});h.app.showView('quotes');await flush();
    assert.deepEqual(calls,['/api/projects']);const html=fs.readFileSync('static/index.html','utf8');
    assert.ok(!html.includes('Older estimate-only saves'));assert.ok(!html.includes('id="quote-list"'));
  });
  await check('Completed folder rescan returns an out-of-range page to existing projects', async h => {
    const paths=[];h.app.setRequest(async path=>{paths.push(path);return {folder:'C:/estimates',files:paths.length===1?[]:[{id:'remaining',name:'Remaining.json',modified_at:'2026-09-17T00:00:00Z'}],offset:paths.length===1?200:0,total:20,matched:20,scan_pending:false,errors:[]};});
    await h.app.loadProjects({offset:200});assert.deepEqual(paths,['/api/projects?offset=200','/api/projects']);
    assert.equal(h.app.state.projectsOffset,0);assert.match(h.byId('project-list-status').textContent,/1–1 of 20/);
  });
  await check('Loaded schedule row lists survive project saving for every calculator', async h => {
    const incoming=project();
    for(const [index,id] of ids.entries()) incoming.calculators[id].schedule_rows=[9,12+index,1008];
    h.app.setRequest(async()=>incoming);await h.loadAccepted();
    for(const id of ids){
      const entry=h.calc.state.entries.get(id);assert.deepEqual(copy(entry.scheduleRows),incoming.calculators[id].schedule_rows);assert.equal(h.calc.dirty(entry),false);
      assert.deepEqual(copy(h.bridgeApi.projectSnapshot()[id].schedule_rows),incoming.calculators[id].schedule_rows);
    }
    let saved;
    h.app.setRequest(async(path,options)=>{saved=JSON.parse(options.body);return {cancelled:false,file:{name:'rows.json',path:'C:/estimates/rows.json',save_token:'rows'},project:{...incoming,estimate:saved.estimate,calculators:saved.calculators}};});
    await h.app.saveProject();for(const id of ids)assert.deepEqual(saved.calculators[id].schedule_rows,incoming.calculators[id].schedule_rows);
  });
  await check('Changing only schedule rows during project save remains unsaved after completion', async h => {
    const entry=h.calc.current();entry.scheduleRows=[9];entry.savedRows=JSON.stringify([9]);
    const pending=deferred();let sent;
    h.app.setRequest((path,options)=>{sent=JSON.parse(options.body);return pending.promise;});const saving=h.app.saveProject();await flush();
    entry.scheduleRows=[9,10];entry.revision++;
    pending.resolve({cancelled:false,file:{name:'rows.json',path:'C:/estimates/rows.json',save_token:'rows'},project:{...project(),estimate:sent.estimate,calculators:sent.calculators}});await saving;
    assert.deepEqual(sent.calculators.steel_board.schedule_rows,[9]);assert.deepEqual(copy(entry.scheduleRows),[9,10]);assert.equal(h.calc.dirty(entry),true);
    assert.match(h.byId('app-message').textContent,/Later edits are not included/);
  });
  await check('New project prepares one blank source row for all calculators without changing their settings', async h => {
    for(const [index,id] of ids.entries()){
      const entry=h.calc.state.entries.get(id)||h.addEntry(id);entry.definition.schedule={sheet:'CALCULATOR',first_row:9+index,last_row:1008+index};
      entry.definition.defaults={CALCULATOR:{[`A${9+index}`]:null},SETTINGS:{B6:0.123456789012345}};
    }
    const prepared=await h.bridgeApi.prepareDefaults();
    for(const [index,[id,entry]] of prepared.entries.entries()){
      assert.deepEqual(copy(entry.scheduleRows),[9+index]);assert.equal(entry.inputs.CALCULATOR[`A${9+index}`],null);
      assert.equal(entry.inputs.SETTINGS.B6,0.123456789012345);assert.equal(h.calc.dirty(entry),false);assert.equal(id,ids[index]);
    }
  });
  console.log(`${passed} project UI regression checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
