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
    querySelectorAll(selector) { const found=[]; const walk=node=>{if(selector==='[data-calculator-output]' && node.dataset?.calculatorOutput)found.push(node);if(selector==='[data-calculator-cell]'&&node.dataset?.calculatorCell)found.push(node);for(const child of node.children||[])walk(child);};this.children.forEach(walk);return found; },
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
    exportTemplate,downloadSchedulePdf,selectCalculator,selectPage,headerLabels,safeDocumentUrl,renderGrid,renderOverview,updateOutputCell,renderDocuments,sourceDisplayText,hiddenColumns,
    setRequest(fn){request=fn;},setFetch(fn){globalThis.fetch=fn;},setRender(fn){renderGrid=fn;}};
  window.CeasefireCalculators = { open };`);
vm.runInContext(source, context);
const { audit } = context;
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const realRender = audit.renderGrid;
const descendants=(root)=>[root,...(root.children||[]).flatMap(descendants)];
const renderedTable=()=>descendants(byId('calculator-grid')).find(node=>node.tagName==='table');
const renderedControls=()=>descendants(byId('calculator-grid')).filter(node=>node.dataset?.calculatorCell);
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
  audit.setRequest(path => path.endsWith('/worksheet') ? Promise.resolve(result()) : (++loads === 1 ? earlier.promise : later.promise));
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
  entry = setup({ CALCULATOR: { B9: 4 } }); audit.setRequest(async path => { assert.match(path, /\/worksheet$/); return result(); });
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
  entry=setup();entry.result=result({}, {rows:[{row:9,cells:[{column:1,value:'Field'},{column:2,value:1},{column:3,value:'Units'}]}]});entry.definition.sheets[0].column_widths={1:13,2:3,3:13};
  realRender(entry);assert.equal(renderedTable().children[0].children[1].style.width,'125px');
  entry.definition.schedule.sheet='SCHEDULE';realRender(entry);
  assert.equal(renderedTable().children[0].children[1].style.width,'24px');
  assert.equal(renderedTable().style.width,'206px');passed++;

  // Rendered controls retain business names and source values, with advanced columns opt-in.
  entry = setup(); entry.definition.sheets[0].hidden_columns = [3];
  entry.result = result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: 19.123456 }] }] });
  realRender(entry);
  const table = renderedTable();
  assert.equal(table.children[0].children.length, 2); // only business columns, no row gutter
  const controlCell = renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  assert.equal(controlCell.getAttribute('aria-label'), 'Lineal metres, item 1');
  assert.equal(controlCell.value, '12.35');
  entry.advanced = true; realRender(entry); assert.equal(renderedTable().children[0].children.length, 3); passed++;

  // Live calculated output updates without removing a focused input control.
  const renderedControl = renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  context.document.activeElement = renderedControl;
  audit.setRequest(async () => result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: '#VALUE!', error: '#VALUE!' }] }] }));
  await audit.calculate();
  const output = byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell => cell.dataset.calculatorOutput === 'C9');
  assert.equal(output.textContent, '#VALUE!'); assert.equal(output.classList.contains('calculator-error'), true);
  assert.equal(renderedControls().find(control=>control.dataset.calculatorCell==='B9'), renderedControl); passed++;

  // The complete 1,000-row schedule is rendered at once; large choices share one datalist.
  entry=setup();entry.definition.schedule.last_row=1008;entry.definition.sheets[0].max_column=12;
  const choices=Array.from({length:553},(_,index)=>`Section ${index}`);
  entry.result=result({}, {max_row:1008,max_column:12,visible_columns:Array.from({length:12},(_,i)=>i+1),option_sets:{steel:choices},
    rows:Array.from({length:1000},(_,index)=>({row:index+9,cells:Array.from({length:12},(_,column)=>({column:column+1,address:String.fromCharCode(65+column)+(index+9),value:column?1:null,editable:true,type:column?'number':'select',...(column?{}:{options_ref:'steel'})}))}))});
  realRender(entry);
  assert.equal(renderedTable().children.at(-1).children.length,1000);
  assert.equal(renderedControls().length,12000);
  assert.equal(byId('calculator-option-lists').children.length,1);
  assert.equal(byId('calculator-option-lists').children[0].children.length,553);
  assert.equal(byId('calculator-page-status').textContent,'1,000 schedule rows · Scroll to any item');
  const html=fs.readFileSync('static/index.html','utf8');
  assert.doesNotMatch(html,/calculator-(?:previous|next|row-page)/);passed++;

  // Ordinary value edits refresh outputs without rebuilding thousands of inputs.
  const retainedControl=renderedControls()[0];
  audit.setRender(realRender);audit.setRequest(async()=>copy(entry.result));
  context.document.activeElement=null;await audit.calculate();
  assert.equal(renderedControls()[0],retainedControl);passed++;

  // Formula-backed editable defaults refresh after dependencies change, keeping exact focus values.
  entry=setup();entry.result=result({}, {rows:[{row:9,cells:[{column:2,address:'B9',value:2,editable:true,type:'number',calculated:true}]}]});
  realRender(entry);const derived=renderedControls()[0];
  audit.setRequest(async()=>result({}, {rows:[{row:9,cells:[{column:2,address:'B9',value:3.24689,editable:true,type:'number',calculated:true}]}]}));
  await audit.calculate();assert.equal(renderedControls()[0],derived);assert.equal(derived.value,'3.25');
  await derived.emit('focus');assert.equal(derived.value,'3.24689');assert.deepEqual(copy(entry.inputs),{});passed++;

  // Worksheet calls request all rows and carry the explicit advanced-column state.
  entry=setup();entry.advanced=true;let worksheetBody;
  audit.setRender(()=>{});audit.setRequest(async(path,options)=>{assert.match(path,/\/worksheet$/);worksheetBody=JSON.parse(options.body);return result();});
  await audit.calculate();assert.deepEqual(worksheetBody,{inputs:{},sheet:'CALCULATOR',include_advanced:true});passed++;

  // Schedule summaries retain each label/value relationship, including repeated zero counts.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SCHEDULE';
  const overview=audit.renderOverview([{row:4,cells:[{column:1,address:'A4',value:'Total spray area'},{column:7,address:'G4',value:'Coating volume'},{column:13,address:'M4',value:'Scope blocks'},{column:19,address:'S4',value:'Not quantified'}]},
    {row:5,cells:[{column:1,address:'A5',value:430.725},{column:7,address:'G5',value:11.2},{column:13,address:'M5',value:0},{column:19,address:'S5',value:0}]}],entry,Array.from({length:25},(_,i)=>i+1));
  const cards=overview.children[0].children;assert.equal(cards.length,4);
  assert.equal(cards[0].children[0].textContent,'Total spray area');assert.equal(cards[0].children[1].textContent,'430.73');
  assert.equal(cards[2].children[0].textContent,'Scope blocks');assert.equal(cards[2].children[1].textContent,'0.00');
  assert.equal(cards[3].children[0].textContent,'Not quantified');assert.equal(cards[3].children[1].textContent,'0.00');passed++;

  // Decorative gaps disappear while section roles, populated merge widths and values survive.
  entry=setup();entry.definition.schedule.sheet='SCHEDULE';entry.definition.sheets[0].merges=['A1:C1'];
  entry.result=result({}, {max_column:5,visible_columns:[1,2,3,4,5],rows:[{row:1,cells:[{column:1,address:'A1',value:'Settings',presentation:{role:'title',bold:true}}]},
    {row:2,cells:[{column:1,value:null}]},{row:3,cells:[{column:1,value:'Pack size',presentation:{role:'label',bold:true}},{column:2,value:12.34567,editable:true,type:'number'}]}]});
  realRender(entry);assert.equal(renderedTable().children[0].children.length,3);assert.equal(renderedTable().children.at(-1).children.length,2);
  const titleCell=renderedTable().children.at(-1).children[0].children[0];assert.equal(titleCell.colSpan,3);assert.match(titleCell.className,/calculator-role-title/);passed++;

  // Empty-to-populated formula notes must enter the form without a page change.
  entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  const formResult=populated=>result({}, {max_column:14,visible_columns:Array.from({length:14},(_,i)=>i+1),rows:[
    {row:6,cells:[{column:1,address:'A6',value:'Product'},{column:4,address:'D6',value:populated?'CAFCO 300':null,editable:true,type:'select',options:['CAFCO 300']}]},
    ...[23,33,35].map((row,index)=>({row,cells:[{column:index?1:8,address:`${index?'A':'H'}${row}`,value:populated?['C300-2021 p4','Exposure and steel temperature qualification','Thickness review and quantity limitation'][index]:'',calculated:true}]}))]});
  entry.result=formResult(false);realRender(entry);
  assert.equal(descendants(byId('calculator-grid')).filter(node=>node.dataset?.sourceRow).length,1);
  audit.setRender(realRender);audit.setRequest(async()=>formResult(true));await audit.calculate();
  for(const address of ['H23','A33','A35'])assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(cell=>cell.dataset.calculatorOutput===address),`${address} appears immediately`);
  audit.setRequest(async()=>formResult(false));await audit.calculate();
  assert.equal(descendants(byId('calculator-grid')).filter(node=>node.dataset?.sourceRow).length,1);passed++;

  // Schedule overview notes also become visible when their formula changes from blank.
  entry=setup();const introResult=value=>result({}, {rows:[{row:6,cells:[{column:1,address:'A6',value,calculated:true}]},{row:9,cells:[{column:2,address:'B9',value:1,editable:true,type:'number'}]}]});
  entry.result=introResult('');realRender(entry);audit.setRender(realRender);audit.setRequest(async()=>introResult('Review the selected construction.'));await audit.calculate();
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='A6').textContent,'Review the selected construction.');passed++;

  // Mobile forms reuse each input once; comparison rows retain real column headers in their own scroll region.
  for(const [sheet,first,last] of [['CALCULATOR',28,30],['BAGS',19,24]]){
    entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';entry.sheet=sheet;
    entry.definition.sheets=[{name:sheet,header_rows:[first],merges:['A1:D1','A6:C6'],hidden_columns:[]}];
    entry.result=result({}, {sheet,max_column:4,visible_columns:[1,2,3,4],rows:[{row:1,cells:[{column:1,address:'A1',value:sheet,presentation:{role:'title'}}]},
      {row:6,cells:[{column:1,address:'A6',value:'Area (m²)',presentation:{role:'label'}},{column:4,address:'D6',value:2.3456789,type:'number',editable:true}]},
      ...Array.from({length:last-first+1},(_,i)=>({row:first+i,cells:[{column:1,address:`A${first+i}`,value:i?'Status':'Product'},{column:2,address:`B${first+i}`,value:i?26:'Thickness'}]})),
      {row:last+3,cells:[{column:1,address:`A${last+3}`,value:'Keep the source design qualification.',presentation:{role:'note'}}]}]});
    realRender(entry);const parts=byId('calculator-grid').children;
    assert.equal(parts.length,3);assert.match(parts[0].className,/calculator-responsive-scroll/);assert.match(parts[2].className,/calculator-responsive-scroll/);
    const comparison=parts[1].children[0];assert.match(comparison.className,/calculator-comparison-table/);
    assert.equal(comparison.children.at(-1).children.length,last-first+1);
    assert.equal(comparison.children.at(-1).children[0].children[0].tagName,'th');assert.equal(parts[1].getAttribute('role'),'region');
    assert.equal(renderedControls().length,1);assert.equal(renderedControls()[0].dataset.calculatorCell,'D6');
    await renderedControls()[0].emit('focus');assert.equal(renderedControls()[0].value,'2.3456789');await renderedControls()[0].emit('blur');assert.deepEqual(copy(entry.inputs),{});
  }
  const calculatorCss=fs.readFileSync('static/calculators.css','utf8');
  assert.match(calculatorCss,/calculator-responsive-form\{display:block;width:100%!important;min-width:0/);
  assert.match(calculatorCss,/calculator-responsive-scroll\{overflow:visible;max-height:none/);passed++;

  // Historical Back to Top text now has a real, labelled destination.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';const back=element('td');
  audit.updateOutputCell(back,{address:'J32',value:'BACK TO TOP'});assert.equal(back.children[0].href,'#calculator-sheet-title');
  assert.equal(back.children[0].textContent,'Back to worksheet controls');passed++;

  // Schedule PDF downloads capture the clicked draft without saving or including later edits.
  entry=setup({CALCULATOR:{B9:2.3456789}});const pdfResponse=deferred();let pdfBody,pdfPath;
  audit.setFetch((path,options)=>{pdfPath=path;pdfBody=JSON.parse(options.body);return pdfResponse.promise;});
  const downloading=audit.downloadSchedulePdf();audit.setInput(entry,'CALCULATOR','B9',9);
  pdfResponse.resolve({ok:true,headers:{get:()=> 'application/pdf'},blob:async()=>new Blob(['%PDF-1.4'])});await downloading;
  assert.match(pdfPath,/\/steel_board\/report\.pdf$/);assert.equal(pdfBody.inputs.CALCULATOR.B9,2.3456789);
  assert.equal(entry.inputs.CALCULATOR.B9,9);assert.equal(JSON.parse(entry.saved).CALCULATOR.B9,2.3456789);passed++;

  // Cancelled file pickers and oversized workbooks do not read or submit content.
  entry = setup(); requests = 0; audit.setRequest(async () => { requests++; });
  byId('calculator-import-file').files = []; await audit.importSchedule();
  byId('calculator-import-file').files = [{ name: 'large.xlsx', size: 6 * 1024 * 1024 }]; await audit.importSchedule(); assert.equal(requests, 0); passed++;

  assert.match(fs.readFileSync('static/app.js', 'utf8'), /view === "calculators".*CeasefireCalculators\?\.open/);
  console.log(`Calculator UI checks passed: ${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
