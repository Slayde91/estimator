const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const elements = new Map();
function element(tag = 'div') {
  const attributes = new Map(), classes = new Set();
  return {
    tagName: tag, value: '', textContent: '', children: [], dataset: {}, style: {}, listeners: {}, files: [],
    scrollLeft: 0, scrollTop: 0, options: [],
    classList: { add(...items) { items.forEach(item => classes.add(item)); }, contains(item) { return classes.has(item); }, toggle(item, force) { if (force ?? !classes.has(item)) classes.add(item); else classes.delete(item); } },
    setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, getAttribute(name) { return attributes.get(name); },
    append(...items) { this.children.push(...items); this.options = this.children; },
    replaceChildren(...items) { this.children = items; this.options = items; },
    querySelectorAll(selector) { const found=[]; const walk=node=>{if(selector==='[data-calculator-output]' && node.dataset?.calculatorOutput)found.push(node);for(const child of node.children||[])walk(child);};this.children.forEach(walk);return found; },
    select() { this.selectionStart=0;this.selectionEnd=String(this.value).length; },
    addEventListener(name, fn, options = {}) { (this.listeners[name] ||= []).push({ fn, once: options.once }); },
    async emit(name) { const list = [...this.listeners[name] || []]; this.listeners[name] = (this.listeners[name] || []).filter(item => !item.once); for (const item of list) await item.fn(); },
    showModal() { assert.ok(!this.open); this.open = true; },
    async close(value) { this.returnValue = value; this.open = false; await this.emit('close'); },
    click() { this.clicked = true; }, remove() {},
  };
}
const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
const context = {
  document: { getElementById: byId, createElement: element, body: element(), activeElement: null },
  window: { addEventListener() {}, location: { origin: 'http://127.0.0.1:8765' } },
  Intl, Number, String, JSON, Object, Set, Map, Array, Promise, Error, URL, console,
  setTimeout: () => 0, clearTimeout() {},
  FileReader: class { readAsDataURL() { this.result = 'data:application/octet-stream;base64,AAAA'; queueMicrotask(() => this.onload()); } },
};
vm.createContext(context);
let source = fs.readFileSync('static/calculators.js', 'utf8');
source = source.replace('  window.CeasefireCalculators = { open };', `
  globalThis.audit = {state,current,dirty,displayValue,numericInputValue,makeControl,setInput,calculate,save,reset,importSchedule,
    exportTemplate,selectCalculator,selectPage,changeRows,jumpRows,headerLabels,safeDocumentUrl,renderGrid,renderDocuments,sourceDisplayText,hiddenColumns,
    setRequest(fn){request=fn;},setFetch(fn){globalThis.fetch=fn;},setRender(fn){renderGrid=fn;}};
  window.CeasefireCalculators = { open };`);
vm.runInContext(source, context);
const { audit } = context;
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const realRender = audit.renderGrid;
function setup(inputs = {}) {
  audit.state.entries.clear();
  Object.assign(audit.state, { current: 'steel_board', requestRevision: 0, loadRevision: 0, action: false, list: [{ id: 'steel_board', title: 'Structural Steel Board' }] });
  const entry = {
    definition: { id: 'steel_board', title: 'Structural Steel Board', pages: ['CALCULATOR', 'SETTINGS'],
      sheets: [{ name: 'CALCULATOR', max_row: 208, max_column: 3, header_rows: [8], hidden_columns: [], merges: [] }, { name: 'SETTINGS', header_rows: [5], hidden_columns: [], merges: [] }],
      schedule: { sheet: 'CALCULATOR', first_row: 9, last_row: 208, header_row: 8, columns: [{ column: 'A', label: 'Member mark' }, { column: 'B', label: 'Lineal metres' }] },
    },
    inputs: copy(inputs), saved: JSON.stringify(inputs), revision: 0, sheet: 'CALCULATOR', startRow: 1, labels: {}, invalid: new Map(), result: null, pendingResult: null,
  };
  audit.state.entries.set('steel_board', entry);
  context.document.activeElement = null;
  byId('calculator-confirm-dialog').open = false;
  audit.setRender(() => {});
  return entry;
}
const result = (inputs = {}, values = {}) => ({ inputs, sheet: 'CALCULATOR', start_row: 1, end_row: 25, max_row: 208, max_column: 3, rows: [], ...values });
let passed = 0;
(async () => {
  // Focus/blur formatting cannot turn precise source defaults into overrides.
  let entry = setup();
  for (const value of [1 / 3, 1e-8, 12.34567]) {
    const control = audit.makeControl({ column: 2, type: 'number', value }, 9, entry, 'Length');
    assert.equal(control.value, Number(value).toFixed(2));
    await control.emit('focus'); assert.equal(control.value, String(value));
    await control.emit('blur'); assert.deepEqual(copy(entry.inputs), {});
  }
  passed++;

  // Intentional edits retain every digit after displaying two decimals at rest.
  const control = audit.makeControl({ column: 2, type: 'number', value: 0 }, 9, entry, 'Length');
  await control.emit('focus'); control.value = '12.34567'; await control.emit('input'); await control.emit('blur');
  assert.equal(entry.inputs.CALCULATOR.B9, 12.34567); assert.equal(control.value, '12.35');
  await control.emit('focus'); assert.equal(control.value, '12.34567'); passed++;

  // Focus formatting must preserve replace-all editing instead of prepending the old value.
  entry=setup();const replacement=audit.makeControl({column:2,type:'number',value:1},9,entry,'Length');
  replacement.select(); await replacement.emit('focus');
  replacement.value=replacement.value.slice(0,replacement.selectionStart)+'2.3456789'+replacement.value.slice(replacement.selectionEnd);
  await replacement.emit('input');await replacement.emit('blur');
  assert.equal(entry.inputs.CALCULATOR.B9,2.3456789);assert.equal(replacement.value,'2.35');passed++;

  // Fractional percentage settings preserve the decimal shift and exact input.
  entry = setup();
  const waste = audit.makeControl({ column: 2, type: 'number', value: 0.1234567, number_format: '0.0%' }, 10, entry, 'Waste');
  assert.equal(waste.value, '12.35'); await waste.emit('focus'); assert.equal(waste.value, '12.34567');
  waste.value = '13.456789'; await waste.emit('input'); await waste.emit('blur');
  assert.equal(entry.inputs.CALCULATOR.B10, 0.13456789); assert.equal(waste.value, '13.46');
  assert.equal(audit.displayValue(0.13456789, { number_format: '0%' }), '13.46%'); passed++;

  // Invalid numeric text neither overwrites valid input nor permits saving.
  waste.value = '12x'; await waste.emit('input');
  assert.equal(entry.invalid.size, 1); assert.equal(entry.inputs.CALCULATOR.B10, 0.13456789);
  assert.equal(byId('calculator-save').disabled, true);
  let requests = 0; audit.setRequest(async () => { requests++; }); await audit.save(); assert.equal(requests, 0);
  waste.value = ''; await waste.emit('input'); assert.equal(entry.invalid.size, 0); assert.equal(entry.inputs.CALCULATOR.B10, ''); passed++;

  // Warning lists permit intermediate FRLs; strict lists keep numeric option types.
  entry = setup();
  const warningWrapper = audit.makeControl({ column: 2, type: 'select', value: 120, options: [60, 90, 120], error_style: 'warning' }, 9, entry, 'Fire rating');
  const rating = warningWrapper.children[0]; assert.equal(rating.tagName, 'input');
  rating.value = '75'; await rating.emit('input'); assert.equal(entry.inputs.CALCULATOR.B9, 75);
  const strict = audit.makeControl({ column: 3, type: 'select', value: 4, options: [1, 2, 3, 4] }, 9, entry, 'Sides');
  assert.equal(strict.tagName, 'select'); strict.value = '3'; await strict.emit('change'); assert.equal(entry.inputs.CALCULATOR.C9, 3); passed++;

  // Mixed FRLs retain each chosen option's original type in either direction.
  entry = setup();
  for (const allowOther of [false, true]) {
    for (const initial of [60, '60/60/60']) {
      const mixed = audit.makeControl({ column: 2, type: 'select', value: initial, options: [60, 90, '60/60/60', '120/120/120'], allow_other: allowOther }, 9, entry, 'Fire rating');
      const control = allowOther ? mixed.children[0] : mixed;
      control.value = '60/60/60'; await control.emit(allowOther ? 'input' : 'change');
      assert.equal(entry.inputs.CALCULATOR.B9, '60/60/60'); assert.equal(entry.invalid.size, 0);
      control.value = '90'; await control.emit(allowOther ? 'input' : 'change');
      assert.equal(entry.inputs.CALCULATOR.B9, 90); assert.equal(entry.invalid.size, 0);
    }
  }
  passed++;

  // Numeric percentage options already contain fractions and must not be divided twice.
  entry = setup();
  const percentSelect = audit.makeControl({ column: 2, type: 'select', value: 0.1, options: [0.1, 0.2], number_format: '0%' }, 9, entry, 'Allowance');
  percentSelect.value = '0.2'; await percentSelect.emit('change'); assert.equal(entry.inputs.CALCULATOR.B9, 0.2); passed++;

  // Colliding rounded numeric choices expose exact values while choosing them.
  entry=setup();const preciseOptions=audit.makeControl({column:2,type:'select',value:.005,options:[.005,.01]},9,entry,'Clearance');
  const numericChoices=preciseOptions.children.filter(item=>item.value!=='');
  assert.deepEqual(numericChoices.map(item=>item.textContent),['0.01','0.01']);
  await preciseOptions.emit('focus');assert.deepEqual(numericChoices.map(item=>item.textContent),['0.005','0.01']);
  preciseOptions.value='.01';await preciseOptions.emit('change');assert.equal(entry.inputs.CALCULATOR.B9,.01);
  await preciseOptions.emit('blur');assert.deepEqual(numericChoices.map(item=>item.textContent),['0.01','0.01']);passed++;

  // A calculation response cannot discard edits made while it was running.
  entry = setup({ CALCULATOR: { B9: 2 } });
  const pending = deferred(); audit.setRequest(() => pending.promise);
  const run = audit.calculate(); audit.setInput(entry, 'CALCULATOR', 'B9', 3.12345);
  pending.resolve(result({ CALCULATOR: { B9: 2 } })); await run;
  assert.equal(entry.inputs.CALCULATOR.B9, 3.12345); assert.equal(entry.result, null); passed++;

  // Calculations leave a focused control in place; a later edit invalidates its pending render.
  entry = setup(); const active = element('input'); active.dataset = { calculatorCell: 'B9', calculatorSheet: 'CALCULATOR' };
  context.document.activeElement = active; audit.setRequest(async () => result());
  await audit.calculate(); assert.ok(entry.pendingResult); assert.ok(entry.result);
  audit.setInput(entry, 'CALCULATOR', 'B9', 9); assert.equal(entry.pendingResult, null); passed++;

  // Save records only the submitted draft; concurrent edits remain unsaved.
  entry = setup({ CALCULATOR: { B9: 1 } }); entry.saved = '{}';
  const saveResponse = deferred(); let savedBody;
  audit.setRequest((path, options) => { assert.match(path, /\/state$/); savedBody = JSON.parse(options.body); return saveResponse.promise; });
  const saving = audit.save(); audit.setInput(entry, 'CALCULATOR', 'B9', 9.87654);
  saveResponse.resolve({ inputs: savedBody.inputs }); await saving;
  assert.equal(entry.inputs.CALCULATOR.B9, 9.87654); assert.equal(JSON.parse(entry.saved).CALCULATOR.B9, 1); assert.equal(audit.dirty(entry), true); passed++;

  // Switching calculators retains both independent drafts and ignores stale page responses.
  entry = setup({ CALCULATOR: { B9: 8 } });
  const oldResponse = deferred(); audit.setRequest(() => oldResponse.promise); const oldRun = audit.calculate();
  const other = { ...entry, definition: { ...entry.definition, id: 'ductwork', title: 'Ductwork' }, inputs: { CALCULATOR: { B9: 22 } }, saved: '{}', invalid: new Map() };
  audit.state.entries.set('ductwork', other); audit.state.current = 'ductwork';
  oldResponse.resolve(result({ CALCULATOR: { B9: 0 } })); await oldRun;
  assert.equal(entry.inputs.CALCULATOR.B9, 8); assert.equal(other.inputs.CALCULATOR.B9, 22); passed++;

  // An older metadata response cannot replace a calculator draft opened by a newer request.
  entry = setup(); const definition = copy(entry.definition); audit.state.entries.clear(); audit.state.current = null;
  const earlier = deferred(), later = deferred(); let loads = 0;
  audit.setRequest(path => path.endsWith('/calculate') ? Promise.resolve(result()) : (++loads === 1 ? earlier.promise : later.promise));
  const firstOpen = audit.selectCalculator('steel_board'), secondOpen = audit.selectCalculator('steel_board');
  later.resolve({ ...definition, inputs: {} }); await secondOpen;
  const retained = audit.current(); audit.setInput(retained, 'CALCULATOR', 'B9', 33);
  earlier.resolve({ ...definition, inputs: { CALCULATOR: { B9: 2 } } }); await firstOpen;
  assert.equal(audit.current(), retained); assert.equal(audit.current().inputs.CALCULATOR.B9, 33); passed++;

  // Import races and cancellation cannot replace the current draft.
  entry = setup({ CALCULATOR: { B9: 4 } }); const importResponse = deferred(); audit.setRequest(() => importResponse.promise);
  byId('calculator-import-file').files = [{ name: 'schedule.xlsx', size: 100 }];
  const importing = audit.importSchedule(); await flush(); audit.setInput(entry, 'CALCULATOR', 'B9', 5);
  importResponse.resolve({ inputs: { CALCULATOR: { B9: 99 } }, imported_rows: 1 }); await importing;
  assert.equal(entry.inputs.CALCULATOR.B9, 5); assert.equal(byId('calculator-confirm-dialog').open, false); passed++;

  entry = setup({ CALCULATOR: { B9: 4 } }); audit.setRequest(async () => ({ inputs: { CALCULATOR: { B9: 99 } }, imported_rows: 1 }));
  byId('calculator-import-file').files = [{ name: 'schedule.xlsx', size: 100 }];
  const cancelled = audit.importSchedule(); await flush(); await byId('calculator-confirm-dialog').close('cancel'); await cancelled;
  assert.equal(entry.inputs.CALCULATOR.B9, 4); passed++;

  // Applying a confirmed import is still an unsaved draft, with no state PUT.
  entry = setup(); const paths = [];
  audit.setRequest(async path => { paths.push(path); return path.endsWith('/import') ? { inputs: { CALCULATOR: { B9: 99.12345 } }, imported_rows: 1 } : result({ CALCULATOR: { B9: 99.12345 } }); });
  byId('calculator-import-file').files = [{ name: 'schedule.xlsx', size: 100 }];
  const applied = audit.importSchedule(); await flush(); await byId('calculator-confirm-dialog').close('confirm'); await applied;
  assert.equal(entry.inputs.CALCULATOR.B9, 99.12345); assert.equal(entry.saved, '{}'); assert.equal(audit.dirty(entry), true); assert.ok(paths.every(path => !path.endsWith('/state'))); passed++;

  // Changes made while reviewing the import remain authoritative.
  entry = setup(); audit.setRequest(async () => ({ inputs: { CALCULATOR: { B9: 99 } }, imported_rows: 1 }));
  byId('calculator-import-file').files = [{ name: 'schedule.xlsx', size: 100 }];
  const confirmationRace = audit.importSchedule(); await flush(); audit.setInput(entry, 'CALCULATOR', 'B9', 77);
  await byId('calculator-confirm-dialog').close('confirm'); await confirmationRace; assert.equal(entry.inputs.CALCULATOR.B9, 77); passed++;

  // Reset restores only the draft and is explicitly confirmed.
  entry = setup({ CALCULATOR: { B9: 4 } }); audit.setRequest(async path => { assert.match(path, /\/calculate$/); return result(); });
  const resetting = audit.reset(); await flush(); await byId('calculator-confirm-dialog').close('confirm'); await resetting;
  assert.deepEqual(copy(entry.inputs), {}); assert.equal(JSON.parse(entry.saved).CALCULATOR.B9, 4); assert.equal(audit.dirty(entry), true); passed++;

  // Pages keep business headers after pagination; unsafe document protocols are rejected.
  entry = setup();
  const labels = audit.headerLabels(entry, { rows: [{ row: 8, cells: [{ column: 3, value: 'Calculated area' }] }] });
  assert.equal(labels[1], 'Member mark'); assert.equal(labels[3], 'Calculated area');
  assert.equal(audit.headerLabels(entry, { rows: [] })[3], 'Calculated area');
  assert.equal(audit.safeDocumentUrl('javascript:alert(1)'), null);
  assert.equal(audit.safeDocumentUrl('file:///C:/secret'), null);
  assert.equal(audit.safeDocumentUrl('https://example.com/report.pdf'), 'https://example.com/report.pdf'); passed++;

  // Manufacturer document requests remain visibly distinct from downloadable reports.
  entry.definition.documents = [
    { title:'Product assessment',kind:'Assessment report',availability:'Public PDF',products:['Example board'],url:'https://example.com/report.pdf',reference_coverage:'Tested construction details.' },
    { title:'Supporting documents',kind:'Manufacturer document request',availability:'Request from manufacturer',products:['Example board'],url:'https://example.com/contact',reference_coverage:'Ask for the exact arrangement.',notes:'A product listing is not a report.' },
    { title:'Unsafe',url:'javascript:alert(1)' },
  ];
  audit.renderDocuments(entry);
  const documentGroup = byId('calculator-document-list').children[0], documentCards = documentGroup.children[1].children;
  assert.equal(documentCards.length,2); assert.equal(documentGroup.children[0].textContent,'Example board');
  assert.match(documentCards[1].children[0].textContent,/Manufacturer document request.*Request from manufacturer/);
  assert.equal(documentCards[1].classList.contains('calculator-document-request'),true);
  assert.equal(documentCards[1].children.at(-1).textContent,'A product listing is not a report.'); passed++;

  // Only explicit directions in their identified source cells receive business labels.
  entry=setup();const warning='No quantity: wastage must be between 0% and 100%. Check L, or the default on SETTINGS when L is blank.';
  assert.match(audit.sourceDisplayText(warning,entry,'AI9'),/Check Waste \(%\).*Default wastage/);
  assert.equal(audit.sourceDisplayText(warning,entry,'A9'),warning); // user member mark is untouched
  const identifiers='P250 p.16 / P100 / M12 / FAS200445 R2.0 / R3 / B + 2D';
  assert.equal(audit.sourceDisplayText(identifiers,entry,'AI9'),identifiers);
  entry.sheet='SETTINGS';assert.equal(audit.sourceDisplayText('Use Steel ID (D) or ESA/M (E), not both.',entry,'Q15'),'Use Steel ID or ESA/M input, not both.');
  assert.equal(audit.sourceDisplayText('Thickness is available, but board area needs depth/width in R/S or the inside-box girth in V.',entry,'Q48'),'Thickness is available, but board area needs Depth or OD and Width B or the inside-box girth in Box girth override.');
  entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  assert.equal(audit.sourceDisplayText('B35 selects the yield.',entry,'E25'),'Yield basis selects the yield.');
  assert.equal(audit.sourceDisplayText('B35 selects the yield.',entry,'A25'),'B35 selects the yield.');passed++;

  // Historical worksheet directions describe the actual app controls and pages.
  entry=setup();entry.sheet='START';
  const maintenance='Only START, CALCULATOR and BOARD SUMMARY are visible. Supporting data sheets remain embedded and hidden. Do not delete them. Library edits must also update the generated geometric lookup prefix.';
  const updated=audit.sourceDisplayText(maintenance,entry,'A27');
  assert.match(updated,/START, CALCULATOR, BOARD SUMMARY, EXTRA BOARDS and SETTINGS/);
  assert.ok(updated.endsWith('Library edits must also update the generated geometric lookup prefix.'));
  entry.definition.id='steel_vermiculite';entry.sheet='CALCULATOR';
  assert.equal(audit.sourceDisplayText('Edit the blue cells. Check the result.',entry,'A20'),'Edit the highlighted inputs. Check the result.');
  assert.equal(audit.sourceDisplayText('Edit the blue cells. Check the result.',entry,'A21'),'Edit the blue cells. Check the result.');
  entry.sheet='SCHEDULE';assert.match(audit.sourceDisplayText('INPUTS  |  Paste your steel schedule here; blue cells are editable.',entry,'A8'),/use Import schedule/);passed++;

  // A zero or negative source width is hidden even without an explicit hidden flag.
  assert.deepEqual([...audit.hiddenColumns({hidden_columns:[3],column_widths:{1:12,2:0,4:-1,5:9}})].sort(),[2,3,4]);passed++;

  // Form worksheets keep narrow source spacers; schedule controls retain usable widths.
  entry=setup();entry.result=result({}, {rows:[]});entry.definition.sheets[0].column_widths={1:13,2:3,3:13};
  realRender(entry);assert.equal(byId('calculator-grid').children[0].children[0].children[2].style.width,'125px');
  entry.definition.schedule.sheet='SCHEDULE';realRender(entry);
  assert.equal(byId('calculator-grid').children[0].children[0].children[2].style.width,'24px');
  assert.equal(byId('calculator-grid').children[0].style.width,'258px');passed++;

  // Rendered controls retain business names and source values, with advanced columns opt-in.
  entry = setup(); entry.definition.sheets[0].hidden_columns = [3];
  entry.result = result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: 19.123456 }] }] });
  realRender(entry);
  const table = byId('calculator-grid').children[0];
  assert.equal(table.children[0].children.length, 3); // item column + two visible columns
  const controlCell = table.children[2].children[0].children[2].children[0];
  assert.equal(controlCell.getAttribute('aria-label'), 'Lineal metres, item 1');
  assert.equal(controlCell.value, '12.35');
  entry.advanced = true; realRender(entry); assert.equal(byId('calculator-grid').children[0].children[0].children.length, 4); passed++;

  // Live calculated output updates without removing a focused input control.
  const renderedControl = byId('calculator-grid').children[0].children[2].children[0].children[2].children[0];
  context.document.activeElement = renderedControl;
  audit.setRequest(async () => result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: '#VALUE!', error: '#VALUE!' }] }] }));
  await audit.calculate();
  const output = byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell => cell.dataset.calculatorOutput === 'C9');
  assert.equal(output.textContent, '#VALUE!'); assert.equal(output.classList.contains('calculator-error'), true);
  assert.equal(byId('calculator-grid').children[0].children[2].children[0].children[2].children[0], renderedControl); passed++;

  // Large schedules expose direct row-range navigation instead of forty Next clicks.
  context.document.activeElement = null; entry.result.max_row = 1009; realRender(entry);
  assert.equal(byId('calculator-row-page').children.length, 41);
  let pageRequest; audit.setRequest(async (path, options) => { pageRequest=JSON.parse(options.body);return result({}, {start_row:1001,end_row:1009,max_row:1009}); });
  byId('calculator-row-page').value = '1001'; audit.jumpRows(); await flush();
  assert.equal(pageRequest.start_row, 1001); assert.equal(entry.startRow, 1001); passed++;

  // Cancelled file pickers and oversized workbooks do not read or submit content.
  entry = setup(); requests = 0; audit.setRequest(async () => { requests++; });
  byId('calculator-import-file').files = []; await audit.importSchedule();
  byId('calculator-import-file').files = [{ name: 'large.xlsx', size: 6 * 1024 * 1024 }]; await audit.importSchedule(); assert.equal(requests, 0); passed++;

  assert.match(fs.readFileSync('static/app.js', 'utf8'), /view === "calculators".*CeasefireCalculators\?\.open/);
  console.log(`Calculator UI checks passed: ${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
