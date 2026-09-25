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
    querySelectorAll(selector) { const found=[]; const match=selector.match(/^\[data-([a-z-]+)\]$/),key=match?.[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());const walk=node=>{if(key&&node.dataset?.[key]!==undefined)found.push(node);for(const child of node.children||[])walk(child);};this.children.forEach(walk);return found; },
    select() { this.selectionStart=0;this.selectionEnd=String(this.value).length; },
    blur() { this.blurred=true;return this.emit('blur'); },
    addEventListener(name, fn, options = {}) { (this.listeners[name] ||= []).push({ fn, once: options.once }); },
    async emit(name, event) { const list = [...this.listeners[name] || []]; this.listeners[name] = (this.listeners[name] || []).filter(item => !item.once); for (const item of list) await item.fn(event); },
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
vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
let source = fs.readFileSync('static/calculators.js', 'utf8');
source = source.replace('  window.CeasefireCalculators = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject };', `
  globalThis.audit = {state,current,dirty,displayValue,numericInputValue,makeControl,setInput,calculate,save,reset,importSchedule,
     addScheduleRow,removeScheduleRow,undoScheduleRemove,projectSnapshot,projectFingerprint,prepareDefaults,markProjectSaved,choiceSignature,
     exportTemplate,downloadSchedulePdf,downloadExcelRegister,downloadMaterialsSummaryPdf,selectCalculator,selectPage,prepareProject,applyProject,headerLabels,safeDocumentUrl,renderGrid,renderOverview,renderProductTotals,outputState,updateOutputCell,renderDocuments,renderChoices,sourceDisplayText,hiddenColumns,
    setRequest(fn){request=fn;},setFetch(fn){globalThis.fetch=fn;},setRender(fn){renderGrid=fn;}};
  window.CeasefireCalculators = { open };`);
vm.runInContext(source, context);
const { audit } = context;
const copy = value => JSON.parse(JSON.stringify(value));
const fileSaved = (filename='APPENDIX A.pdf', destination='downloads', savedPath) => ({ok:true,headers:{get:()=> 'application/json; charset=utf-8'},json:async()=>({saved:true,path:savedPath||`C:/${destination==='project'?'Projects':'Downloads'}/${filename}`,filename,destination})});
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
  byId('calculator-pdf').setAttribute('aria-label','Download PDF Schedule');byId('calculator-excel').setAttribute('aria-label','Download XLSX Schedule');
  byId('calculator-summary-pdf').setAttribute('aria-label','Download PDF Summary');
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
  assert.equal(byId('calculator-recalculate').disabled, true);
  let requests = 0; audit.setRequest(async () => { requests++; }); await audit.save(); assert.equal(requests, 0);
  waste.value = ''; await waste.emit('input'); assert.equal(entry.invalid.size, 0); assert.equal(entry.inputs.CALCULATOR.B10, ''); passed++;

  // Warning lists permit intermediate FRLs; strict lists keep numeric option types.
  entry = setup();
  const warningWrapper = audit.makeControl({ column: 2, type: 'select', value: 120, options: [60, 90, 120], error_style: 'warning' }, 9, entry, 'Fire rating');
  const rating = warningWrapper.children[0]; assert.equal(rating.tagName, 'input');
  rating.value = '75'; await rating.emit('input'); assert.equal(entry.inputs.CALCULATOR.B9, 75);
  const strict = audit.makeControl({ column: 3, type: 'select', value: 4, options: [1, 2, 3, 4] }, 9, entry, 'Sides');
  assert.equal(strict.tagName, 'select');assert.equal(strict.children[0].value,''); strict.value = '3'; await strict.emit('change'); assert.equal(entry.inputs.CALCULATOR.C9, 3); passed++;

  // Every duct schedule dropdown uses only server choices, even with stale permissive metadata.
  const ductChoices={C:['CAFCO 300','MONOKOTE','FyreWrap'],E:['60/60/60','90/90/90','120/120/120','180/180/180','240/240/180'],H:['Internal','External','Both','Stair pressurisation','Other pressurisation'],I:['Horizontal','Vertical','Both']};
  const ductSetup=(inputs={})=>{
    const next=setup(inputs);audit.state.entries.clear();audit.state.current='ductwork';
    next.definition.id='ductwork';next.definition.title='Ductwork';
    next.definition.schedule={sheet:'CALCULATOR',first_row:11,last_row:1010,header_row:10,columns:[]};
    next.definition.sheets[0].display_cells=Object.fromEntries(Object.keys(ductChoices).flatMap(column=>[11,1010].map(row=>[`${column}${row}`,{control:'select'}])));
    audit.state.entries.set('ductwork',next);return next;
  };
  for(const row of [11,1010])for(const permissive of [false,true]){
    entry=ductSetup();
    for(const [column,options]of Object.entries(ductChoices)){
      const control=audit.makeControl({address:`${column}${row}`,type:'select',value:null,options,allow_other:permissive,error_style:permissive?'warning':'stop'},row,entry,column);
      assert.equal(control.tagName,'select');assert.deepEqual(control.children.map(option=>option.value),['',...options]);
      assert.equal(descendants(control).some(node=>node.tagName==='input'||node.textContent==='Enter custom value…'),false);
      control.value=options.at(-1);await control.emit('change');assert.equal(entry.inputs.CALCULATOR[`${column}${row}`],options.at(-1));
      control.value='Invented value';await control.emit('change');assert.equal(control.value,options.at(-1));assert.equal(entry.inputs.CALCULATOR[`${column}${row}`],options.at(-1));
      control.value='';await control.emit('change');assert.equal(entry.inputs.CALCULATOR[`${column}${row}`],'');
    }
  }passed++;

  // Ductwork product settings show only the approved yield and application choices.
  entry=ductSetup({ 'PRODUCT SETTINGS': { B35:'Calibrated', B65:'Un-injected', B73:'Calibrated' } });
  entry.sheet='PRODUCT SETTINGS';entry.definition.sheets=[{name:'PRODUCT SETTINGS',display_cells:{B35:{control:'select'},B65:{control:'select'},B73:{control:'select'}}}];
  for(const [address,options] of Object.entries({B35:['Calibrated','Uncalibrated'],B65:['Un-injected','Injected'],B73:['Calibrated','Uncalibrated']})){
    const setting=audit.makeControl({address,type:'select',value:entry.inputs['PRODUCT SETTINGS'][address],options,allow_other:true,error_style:'warning'},Number(address.slice(1)),entry,address);
    assert.equal(setting.tagName,'select');assert.deepEqual(setting.children.map(option=>option.value),options);
    setting.value=options[1];await setting.emit('change');assert.equal(entry.inputs['PRODUCT SETTINGS'][address],options[1]);
    setting.value='Invented value';await setting.emit('change');assert.equal(setting.value,options[1]);
  }passed++;

  // Historical values remain visible and exact through viewing and snapshots; only an explicit choice replaces them.
  const legacyDuct={CALCULATOR:{C11:'Earlier custom product',E11:120,H11:'Mixed',I11:'Mixed',D11:1.23456789012345}};
  entry=ductSetup(legacyDuct);const legacyControls={};
  for(const [column,options]of Object.entries(ductChoices)){
    const address=`${column}11`,control=audit.makeControl({address,type:'select',value:legacyDuct.CALCULATOR[address],options,allow_other:false,error_style:'stop'},11,entry,column);
    legacyControls[column]=control;assert.equal(control.tagName,'select');assert.equal(control.value,String(legacyDuct.CALCULATOR[address]));
    const historical=control.children.find(option=>option.value===control.value);assert.equal(historical.disabled,true);assert.ok(historical.textContent.includes('Saved value:'));assert.ok(historical.textContent.includes(String(legacyDuct.CALCULATOR[address])));
    assert.deepEqual(control.children.filter(option=>!option.disabled).map(option=>option.value),['',...options]);
    await control.emit('focus');assert.ok(historical.textContent.includes('Saved value:'));await control.emit('blur');assert.ok(historical.textContent.includes('Saved value:'));
  }
  assert.deepEqual(copy(entry.inputs),legacyDuct);assert.equal(entry.invalid.size,0);assert.equal(entry.revision,0);
  assert.deepEqual(copy(audit.projectSnapshot().ductwork.inputs),legacyDuct);
  const ductDownloads=[];audit.setFetch(async(path,options)=>{ductDownloads.push(JSON.parse(options.body).inputs);return fileSaved(path.endsWith('.pdf')?'APPENDIX A.pdf':'APPENDIX A.xlsx');});
  await audit.downloadSchedulePdf();await audit.downloadExcelRegister();assert.equal(ductDownloads.length,2);for(const captured of ductDownloads)assert.deepEqual(captured,legacyDuct);
  legacyControls.E.value='120/120/120';await legacyControls.E.emit('change');assert.equal(entry.inputs.CALCULATOR.E11,'120/120/120');assert.equal(entry.inputs.CALCULATOR.H11,'Mixed');
  legacyControls.E.value='120';await legacyControls.E.emit('change');assert.equal(legacyControls.E.value,'120/120/120');assert.equal(entry.inputs.CALCULATOR.E11,'120/120/120');passed++;

  // A focused legacy select catches up with normalized server inputs on blur, without replacing an unfinished edit.
  entry=ductSetup({CALCULATOR:{E11:120}});
  const normalizedCell={column:5,address:'E11',type:'select',editable:true,value:'120/120/120',options:ductChoices.E,allow_other:false,error_style:'stop'};
  const normalizedWorksheet=result({CALCULATOR:{E11:'120/120/120'}},{max_column:9,rows:[{row:11,cells:[normalizedCell]}]});
  const focusedLegacy=audit.makeControl(normalizedCell,11,entry,'FRL');byId('calculator-grid').replaceChildren(focusedLegacy);
  entry.result=normalizedWorksheet;entry.needsRender=false;entry.renderedSheet='CALCULATOR';entry.renderedPage='CALCULATOR';entry.choiceSignature=audit.choiceSignature(normalizedWorksheet,entry);
  context.document.activeElement=focusedLegacy;await focusedLegacy.emit('focus');audit.setRequest(async()=>normalizedWorksheet);await audit.calculate();
  assert.equal(entry.inputs.CALCULATOR.E11,'120/120/120');assert.equal(focusedLegacy.value,'120');assert.equal(entry.pendingResult,null);
  context.document.activeElement=null;await focusedLegacy.emit('blur');assert.equal(focusedLegacy.value,'120/120/120');assert.equal(entry.invalid.size,0);passed++;

  // The restriction does not alter steel custom choices or duct controls outside the schedule.
  for(const identity of ['steel_board','steel_vermiculite']){
    entry=setup();entry.definition.id=identity;entry.definition.sheets[0].display_cells={C11:{control:'select'}};
    const [select,custom]=audit.makeControl({address:'C11',type:'select',value:'Legacy',options:['Listed'],allow_other:true,error_style:'warning'},11,entry,'Product').children;
    select.value=select.children.find(option=>option.textContent==='Enter custom value…').value;await select.emit('change');custom.value='Custom retained';await custom.emit('input');assert.equal(entry.inputs.CALCULATOR.C11,'Custom retained');
  }
  entry=ductSetup();entry.definition.sheets[0].display_cells.C10={control:'select'};
  const outside=audit.makeControl({address:'C10',type:'select',value:'Existing',options:['Listed'],allow_other:true},10,entry,'Outside schedule');
  assert.ok(descendants(outside).some(node=>node.textContent==='Enter custom value…'));passed++;

  // Large strict native lists stay lightweight until opened, without losing any source choices.
  entry=setup({SCHEDULE:{F1009:'Legacy custom section'}});entry.sheet='SCHEDULE';
  const sectionOptions=Array.from({length:553},(_,index)=>`Steel section ${index+1}`);
  entry.definition.sheets=[{name:'SCHEDULE',display_cells:Object.fromEntries(Array.from({length:1000},(_,index)=>[`F${index+10}`,{control:'select'}]))}];
  entry.result={option_sets:{section_list:sectionOptions}};
  const nativeSections=Array.from({length:1000},(_,index)=>audit.makeControl({column:6,address:`F${index+10}`,type:'select',value:sectionOptions[index%553],options_ref:'section_list'},index+10,entry,'Steel section'));
  assert.ok(nativeSections.every(control=>control.tagName==='select'&&control.children.length<=2&&control.children[0].value===''));
  assert.ok(nativeSections.reduce((total,control)=>total+control.children.length,0)<=2000);
  await nativeSections[0].emit('pointerdown');
  assert.equal(nativeSections[0].children.length,554);assert.equal(nativeSections[0].children[0].value,'');assert.deepEqual(nativeSections[0].children.filter(option=>option.value!=='').map(option=>option.value),sectionOptions);
  nativeSections[0].value=sectionOptions[552];await nativeSections[0].emit('change');assert.equal(entry.inputs.SCHEDULE.F10,sectionOptions[552]);
  assert.equal(nativeSections[1].children.length,2);
  await nativeSections[999].emit('focus');assert.equal(nativeSections[999].children.length,555);assert.equal(nativeSections[999].children[0].value,'');assert.equal(nativeSections[999].value,'Legacy custom section');
  assert.ok(sectionOptions.every(value=>nativeSections[999].children.some(option=>option.value===value)));
  nativeSections[999].value='';await nativeSections[999].emit('change');await nativeSections[999].emit('blur');assert.equal(entry.inputs.SCHEDULE.F1009,'');assert.equal(entry.invalid.size,0);
  await nativeSections[2].emit('keydown',{key:'ArrowDown'});assert.equal(nativeSections[2].children.length,554);
  const warningSection=audit.makeControl({column:6,address:'F11',type:'select',value:'Custom',options:sectionOptions,error_style:'warning'},11,entry,'Steel section');
  const [warningNative,warningCustom]=warningSection.children;assert.equal(warningNative.tagName,'select');assert.equal(warningCustom.hidden,true);
  warningNative.value=warningNative.children.find(option=>option.textContent==='Enter custom value…').value;await warningNative.emit('change');
  assert.equal(warningCustom.hidden,false);warningCustom.value='Another custom';await warningCustom.emit('input');assert.equal(entry.inputs.SCHEDULE.F11,'Another custom');assert.equal(entry.invalid.size,0);passed++;

  // Quick steel section uses the same native list without changing its canonical input or period choices.
  entry=setup({CALCULATOR:{D10:sectionOptions[100],D12:45}});
  entry.definition.sheets=[{name:'CALCULATOR',display_cells:{D10:{control:'select'}}}];
  entry.result={option_sets:{section_list:sectionOptions}};
  const quickSection=audit.makeControl({column:4,address:'D10',type:'select',value:sectionOptions[100],options_ref:'section_list',allow_other:false,error_style:'stop'},10,entry,'Steel section ID');
  assert.equal(quickSection.tagName,'select');assert.equal(quickSection.value,sectionOptions[100]);assert.equal(quickSection.getAttribute('aria-label'),'Steel section ID');
  await quickSection.emit('focus');assert.equal(quickSection.children.length,554);assert.equal(quickSection.children[0].value,'');
  assert.deepEqual(quickSection.children.slice(1).map(option=>option.value),sectionOptions);
  quickSection.value=sectionOptions[552];await quickSection.emit('change');assert.equal(entry.inputs.CALCULATOR.D10,sectionOptions[552]);assert.equal(entry.inputs.CALCULATOR.D12,45);
  const quickPeriod=audit.makeControl({column:4,address:'D12',type:'select',value:45,options:[15,30,45,60,90,120,180,240]},12,entry,'Fire period');
  assert.ok(quickPeriod.children.some(option=>option.value==='15'));assert.ok(quickPeriod.children.some(option=>option.value==='45'));
  assert.equal(entry.invalid.size,0);passed++;

  // Native warning lists preserve custom precision and validation; their action is never a source value.
  entry=setup({SETTINGS:{B6:7.123456789}});entry.definition.sheets[0].display_cells={B9:{control:'select'}};
  const customCell={column:2,address:'B9',type:'select',value:12.3456789,options:[10,15],error_style:'warning'};
  const [customChoice,customEditor]=audit.makeControl(customCell,9,entry,'Thickness').children;
  assert.equal(customChoice.value,'12.3456789');assert.equal(customChoice.children[0].value,'');assert.equal(customEditor.dataset.calculatorCell,undefined);
  customChoice.value=customChoice.children.find(option=>option.textContent==='Enter custom value…').value;await customChoice.emit('change');
  assert.equal(entry.inputs.CALCULATOR,undefined);assert.equal(customEditor.hidden,false);await customEditor.emit('focus');assert.equal(customEditor.value,'12.3456789');
  customEditor.value='13.456789123';await customEditor.emit('input');await customEditor.emit('blur');assert.equal(entry.inputs.CALCULATOR.B9,13.456789123);assert.equal(customEditor.value,'13.46');
  await customEditor.emit('focus');assert.equal(customEditor.value,'13.456789123');customEditor.value='13x';await customEditor.emit('input');
  assert.equal(entry.inputs.CALCULATOR.B9,13.456789123);assert.equal(entry.invalid.get('CALCULATOR!B9'),'13x');assert.equal(byId('calculator-pdf').disabled,true);assert.equal(byId('calculator-excel').disabled,true);
  const invalidRebuild=audit.makeControl(customCell,9,entry,'Thickness').children;assert.equal(invalidRebuild[1].hidden,false);assert.equal(invalidRebuild[1].value,'13x');
  let customCalls=0;audit.setRequest(async()=>{customCalls++;});audit.setFetch(async()=>{customCalls++;});await audit.save();await audit.downloadSchedulePdf();await audit.downloadExcelRegister();assert.equal(customCalls,0);
  customChoice.value='15';await customChoice.emit('change');assert.equal(entry.invalid.size,0);assert.equal(customEditor.hidden,true);assert.equal(entry.inputs.CALCULATOR.B9,15);
  customChoice.value='';await customChoice.emit('change');assert.equal(entry.inputs.CALCULATOR.B9,'');assert.equal(entry.inputs.SETTINGS.B6,7.123456789);passed++;

  // Native mixed/custom values retain types, fractional percentages and literal action-looking values.
  entry=setup();entry.definition.sheets[0].display_cells={B9:{control:'select'},C9:{control:'select'},D9:{control:'select'}};
  const [mixedChoice,mixedEditor]=audit.makeControl({column:2,type:'select',value:'Legacy FRL',options:[60,90,'60/60/60'],allow_other:true},9,entry,'Fire rating').children;
  mixedChoice.value='90';await mixedChoice.emit('change');assert.equal(entry.inputs.CALCULATOR.B9,90);
  mixedChoice.value='60/60/60';await mixedChoice.emit('change');assert.equal(entry.inputs.CALCULATOR.B9,'60/60/60');
  mixedChoice.value=mixedChoice.children.find(option=>option.textContent==='Enter custom value…').value;await mixedChoice.emit('change');mixedEditor.value='75/75/75';await mixedEditor.emit('input');assert.equal(entry.inputs.CALCULATOR.B9,'75/75/75');
  const [customPercent,percentEditor]=audit.makeControl({column:3,type:'select',value:.123456789,options:[.1,.2],number_format:'0%',allow_other:true},9,entry,'Waste').children;
  customPercent.value='0.123456789';await customPercent.emit('change');assert.equal(entry.inputs.CALCULATOR.C9,.123456789);
  customPercent.value=customPercent.children.find(option=>option.textContent==='Enter custom value…').value;await customPercent.emit('change');percentEditor.value='13.456789';await percentEditor.emit('input');assert.equal(entry.inputs.CALCULATOR.C9,.13456789);
  const actionLiteral='__calculator_custom_value__',literalSelect=audit.makeControl({column:4,type:'select',value:actionLiteral,options:['Listed'],allow_other:true},9,entry,'Item').children[0];
  assert.notEqual(literalSelect.children.find(option=>option.textContent==='Enter custom value…').value,actionLiteral);literalSelect.value=actionLiteral;await literalSelect.emit('change');assert.equal(entry.inputs.CALCULATOR.D9,actionLiteral);passed++;

  // Focused custom editors survive dependent-choice responses, then submit exact source-keyed drafts to save and downloads.
  entry=setup({SETTINGS:{B6:8.7654321}});entry.definition.sheets[0].display_cells={B9:{control:'select'}};
  const customResult=()=>result(copy(entry.inputs),{rows:[{row:9,cells:[{...customCell,editable:true}]}]});entry.result=customResult();realRender(entry);audit.setRender(realRender);
  let activeChoice=renderedControls()[0],activeCustom=descendants(byId('calculator-grid')).find(node=>node.dataset?.calculatorCustomCell==='B9');
  activeChoice.value=activeChoice.children.find(option=>option.textContent==='Enter custom value…').value;await activeChoice.emit('change');context.document.activeElement=activeCustom;await activeCustom.emit('focus');activeCustom.value='17.123456789';await activeCustom.emit('input');
  audit.setRequest(async()=>({...customResult(),rows:[{row:9,cells:[{...customCell,editable:true,options:[12,18]}]}]}));await audit.calculate();
  assert.ok(entry.pendingResult);assert.equal(descendants(byId('calculator-grid')).find(node=>node.dataset?.calculatorCustomCell==='B9'),activeCustom);assert.equal(activeCustom.value,'17.123456789');
  await activeCustom.emit('blur',{relatedTarget:activeChoice});assert.ok(entry.pendingResult);activeCustom.value='18.123456789';await activeCustom.emit('input');assert.equal(entry.pendingResult,null);
  let customSaved;context.document.activeElement=null;audit.setRequest(async(path,options)=>{customSaved=JSON.parse(options.body).inputs;return {inputs:customSaved};});await audit.save();assert.deepEqual(customSaved,{SETTINGS:{B6:8.7654321},CALCULATOR:{B9:18.123456789}});
  const customDownloads=[];audit.setFetch(async(path,options)=>{customDownloads.push({path,inputs:JSON.parse(options.body).inputs});return fileSaved(path.endsWith('.pdf')?'APPENDIX A.pdf':'APPENDIX A.xlsx');});
  await audit.downloadSchedulePdf();await audit.downloadExcelRegister();assert.equal(customDownloads.length,2);assert.ok(customDownloads[0].path.endsWith('report.pdf'));assert.ok(customDownloads[1].path.endsWith('register.xlsx'));
  for(const download of customDownloads)assert.deepEqual(download.inputs,customSaved);passed++;

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

  // A slow first workbook load cannot reopen its workspace after Firestopping is selected.
  audit.state.entries.clear();Object.assign(audit.state,{current:null,loadRevision:0,list:[{id:'steel_board',title:'Structural Steel Board'}]});byId('calculator-workspace').hidden=true;
  let firestoppingSelected=false;context.window.CeasefireProposalCalculators={showWorkbook(){firestoppingSelected=false;},isFirestopping(){return firestoppingSelected;}};
  const delayedDefinition=deferred();audit.setRequest(path=>path.endsWith('/steel_board')?delayedDefinition.promise:Promise.resolve(result()));const delayedOpen=audit.selectCalculator('steel_board');await flush();firestoppingSelected=true;delayedDefinition.resolve({...definition,inputs:{}});await delayedOpen;
  assert.equal(byId('calculator-workspace').hidden,true);assert.equal(audit.state.current,null);delete context.window.CeasefireProposalCalculators;passed++;

  // Returning to unchanged pages reuses exact results and existing controls, including scroll position.
  entry=setup({CALCULATOR:{B9:1.23456789123},SETTINGS:{B9:.123456789}});audit.setRender(realRender);
  entry.definition.pages.push('SUMMARY');entry.definition.sheets.push({name:'SUMMARY',header_rows:[],hidden_columns:[],merges:[]});
  const navigationRequests=[];
  const navigationResult=(inputs,sheet)=>result(copy(inputs),{sheet,warnings:[`${sheet} warning`],rows:[{row:9,cells:[
    {column:1,address:'A9',type:'select',editable:true,value:'Alpha',options:['Alpha','Beta'],allow_other:true},
    {column:2,address:'B9',type:'number',editable:true,value:inputs[sheet]?.B9??0},
    {column:3,address:'C9',calculated:true,value:inputs.CALCULATOR.B9*2}]}]});
  const serveNavigation=async(path,options)=>{const body=JSON.parse(options.body);navigationRequests.push(body);return navigationResult(body.inputs,body.sheet);};
  const navigationControl=()=>renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  audit.setRequest(serveNavigation);await audit.calculate();const originalNavigationControl=navigationControl();
  const originalNavigationList=byId('calculator-option-lists').children[0],originalNavigationChoice=renderedControls().find(control=>control.dataset.calculatorCell==='A9');
  byId('calculator-grid').scrollTop=321;await audit.selectPage('SETTINGS');await audit.selectPage('CALCULATOR');
  assert.equal(navigationRequests.length,2);assert.equal(navigationControl(),originalNavigationControl);assert.equal(byId('calculator-grid').scrollTop,321);
  assert.equal(byId('calculator-option-lists').children[0],originalNavigationList);assert.equal(originalNavigationChoice.getAttribute('list'),originalNavigationList.id);
  assert.deepEqual(originalNavigationList.children.map(option=>option.value),['Alpha','Beta']);assert.ok([...audit.state.optionLists.values()].includes(originalNavigationList.id));
  assert.equal(byId('calculator-warnings').textContent,'CALCULATOR warning');assert.equal(entry.inputs.CALCULATOR.B9,1.23456789123);
  assert.equal(byId('calculator-sheet-title').textContent,'SCHEDULE');assert.equal(navigationRequests[0].sheet,'CALCULATOR');
  const unchangedGrid=byId('calculator-grid').children;await audit.selectPage('CALCULATOR');await audit.selectCalculator('steel_board');
  assert.equal(byId('calculator-grid').children,unchangedGrid);assert.equal(navigationRequests.length,2);passed++;

  // Cached Steel Spray LOOKUP navigation restores its border-removal class every time.
  entry.definition.id='steel_vermiculite';await audit.selectPage('SETTINGS');assert.equal(byId('calculator-grid').classList.contains('calculator-steel-lookup'),false);
  await audit.selectPage('CALCULATOR');assert.equal(byId('calculator-grid').classList.contains('calculator-steel-lookup'),true);entry.definition.id='steel_board';passed++;

  // Explicit recalculate always requests; any sheet's precise edit invalidates dependent pages.
  await audit.calculate();assert.equal(navigationRequests.length,3);
  await audit.selectPage('SETTINGS');assert.equal(navigationRequests.length,4);
  audit.setInput(entry,'SETTINGS','B9',.23456789123);await audit.selectPage('CALCULATOR');await audit.selectPage('SETTINGS');
  assert.equal(navigationRequests.length,6);assert.equal(navigationRequests.at(-1).inputs.SETTINGS.B9,.23456789123);
  assert.equal(entry.inputs.CALCULATOR.B9,1.23456789123);passed++;

  // A cache hit advances the request serial so late worksheet responses and errors cannot overwrite it.
  const lateNavigation=deferred();audit.setRequest(()=>lateNavigation.promise);
  const pendingNavigation=audit.selectPage('SUMMARY');await audit.selectPage('CALCULATOR');const cachedNavigationResult=entry.result;
  lateNavigation.resolve(navigationResult({CALCULATOR:{B9:-99}},'SUMMARY'));await pendingNavigation;
  assert.equal(entry.result,cachedNavigationResult);assert.equal(entry.inputs.CALCULATOR.B9,1.23456789123);assert.equal(entry.sheet,'CALCULATOR');
  const lateNavigationError=deferred();audit.setRequest(()=>lateNavigationError.promise);
  const pendingNavigationError=audit.selectPage('SUMMARY');await audit.selectPage('SETTINGS');
  lateNavigationError.reject(new Error('Obsolete navigation failure'));await pendingNavigationError;
  assert.equal(entry.sheet,'SETTINGS');assert.ok(!byId('calculator-message').textContent.includes('Obsolete navigation failure'));assert.equal(byId('calculator-grid').getAttribute('aria-busy'),'false');passed++;

  // Normalized/replaced inputs also invalidate even if their revision number was unchanged.
  audit.setRequest(serveNavigation);const beforeReplacementRequests=navigationRequests.length;
  entry.inputs.CALCULATOR.B9=9.87654321987;await audit.selectPage('CALCULATOR');
  assert.equal(navigationRequests.length,beforeReplacementRequests+1);assert.equal(navigationRequests.at(-1).inputs.CALCULATOR.B9,9.87654321987);passed++;

  // Calculator switching keeps independent warm pages and invalid text in the original draft.
  const navigationEntry=entry,otherNavigationEntry={definition:{...copy(entry.definition),id:'ductwork',title:'Ductwork'},inputs:{CALCULATOR:{B9:44.123456789}},saved:'{}',revision:0,sheet:'CALCULATOR',page:'CALCULATOR',invalid:new Map(),result:null,needsRender:true};
  audit.state.entries.set('ductwork',otherNavigationEntry);await audit.selectCalculator('ductwork');const afterOtherOpen=navigationRequests.length;
  await audit.selectCalculator('steel_board');assert.equal(navigationRequests.length,afterOtherOpen);assert.equal(otherNavigationEntry.inputs.CALCULATOR.B9,44.123456789);
  const invalidNavigationControl=navigationControl();invalidNavigationControl.value='invalid';await invalidNavigationControl.emit('input');
  const blockedNavigationPage=navigationEntry.page;await audit.selectPage('SETTINGS');assert.equal(navigationEntry.page,blockedNavigationPage);
  await audit.selectCalculator('ductwork');await audit.selectCalculator('steel_board');
  assert.equal(navigationRequests.length,afterOtherOpen);assert.equal(navigationControl().value,'invalid');assert.equal(navigationEntry.inputs.CALCULATOR.B9,9.87654321987);
  navigationControl().value='9.87654321987';await navigationControl().emit('input');passed++;

  // A loaded project cannot inherit retained DOM/results from the previous project's entries.
  const previousProjectControl=renderedControls()[0],preparedNavigation=await audit.prepareProject({steel_board:{inputs:{CALCULATOR:{B9:7.65432198765}}}});
  audit.applyProject(preparedNavigation);const beforeProjectOpen=navigationRequests.length;await audit.selectCalculator('steel_board');
  assert.equal(navigationRequests.length,beforeProjectOpen+1);assert.notEqual(renderedControls()[0],previousProjectControl);assert.equal(audit.current().inputs.CALCULATOR.B9,7.65432198765);passed++;

  // Confirmed reset/import must not reuse a dependent page from the previous draft.
  entry=audit.current();await audit.selectPage('SETTINGS');
  entry.definition.defaults={CALCULATOR:{B9:2.34567891234},SETTINGS:{B9:.34567891234}};
  const beforeNavigationReset=navigationRequests.length,resetNavigation=audit.reset();await flush();await byId('calculator-confirm-dialog').close('confirm');await resetNavigation;
  await audit.selectPage('CALCULATOR');assert.equal(navigationRequests.length,beforeNavigationReset+2);assert.deepEqual(navigationRequests.at(-1).inputs,entry.definition.defaults);
  const importedNavigationInputs={CALCULATOR:{B9:3.45678912345},SETTINGS:{B9:.45678912345}};
  audit.setRequest((path,options)=>path.endsWith('/import')?Promise.resolve({inputs:copy(importedNavigationInputs),imported_rows:1}):serveNavigation(path,options));
  byId('calculator-import-file').files=[{name:'schedule.xlsx',size:100}];
  const beforeNavigationImport=navigationRequests.length,importNavigation=audit.importSchedule();await flush();await byId('calculator-confirm-dialog').close('confirm');await importNavigation;
  await audit.selectPage('SETTINGS');assert.equal(navigationRequests.length,beforeNavigationImport+2);assert.deepEqual(navigationRequests.at(-1).inputs,importedNavigationInputs);passed++;

  // Many display pages retain a bounded number of detached grids, while source results remain reusable.
  audit.setRequest(serveNavigation);
  entry.definition.display_pages=[...entry.definition.pages.map(sheet=>({id:sheet,label:sheet,sheet})),{id:'VIEW A',label:'View A',sheet:'CALCULATOR'},{id:'VIEW B',label:'View B',sheet:'CALCULATOR'}];
  for(const page of ['CALCULATOR','SUMMARY','SETTINGS','VIEW A','VIEW B'])await audit.selectPage(page);
  assert.ok(entry.navigationCache.pages.size<=3);assert.ok(entry.navigationCache.sheets.size<=5);passed++;

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
  entry.definition.schedule.last_row=1008;
  assert.match(audit.sourceDisplayText(warning,entry,'AI1008'),/Check Waste \(%\).*Default wastage/);
  assert.equal(audit.sourceDisplayText(warning,entry,'AI1009'),warning);
  const lastRowStatus=element();audit.updateOutputCell(lastRowStatus,{address:'AI1008',column:35,value:warning,calculated:true});
  assert.equal(lastRowStatus.classList.contains('calculator-row-status'),true);
  assert.equal(audit.sourceDisplayText(warning,entry,'A9'),warning); // user member mark is untouched
  const identifiers='P250 p.16 / P100 / M12 / FAS200445 R2.0 / R3 / B + 2D';
  assert.equal(audit.sourceDisplayText(identifiers,entry,'AI9'),identifiers);
  entry.sheet='SETTINGS';assert.equal(audit.sourceDisplayText('Use Steel ID (D) or ESA/M (E), not both.',entry,'Q15'),'Use Steel ID or ESA/M input, not both.');
  assert.equal(audit.sourceDisplayText('Thickness is available, but board area needs depth/width in R/S or the inside-box girth in V.',entry,'Q48'),'Thickness is available, but board area needs Depth or OD and Width B or the inside-box girth in Box girth override.');
  entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  assert.equal(audit.sourceDisplayText('B35 selects the yield.',entry,'E25'),'Yield basis selects the yield.');
  assert.equal(audit.sourceDisplayText('B35 selects the yield.',entry,'A25'),'B35 selects the yield.');passed++;

  // Current startup assumptions are distinguished from historical source notes.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';
  const originalBasis='Verify pack size, method and site yield for each product. CAFCO uses an inherited assumption; Mandolite is provisional; Fendolite/Perlifoc are theoretical; Monokote is uninjected. Add waste separately. Sources: P330:V333.';
  const shownBasis=audit.sourceDisplayText(originalBasis,entry,'A301');
  assert.match(shownBasis,/The original CAFCO workbook used an inherited assumption; new estimates use user-selected consumption settings\./);
  assert.match(shownBasis,/The startup densities are estimating assumptions; verify product-specific site yield\. Add waste separately\./);
  assert.equal(audit.sourceDisplayText(originalBasis,entry,'D42'),originalBasis);
  const densityNote="Used only when direct yield is blank. Use this product's estimating density, not another product's value.";
  for(const address of ['G38','G71','G103','G180','G236'])assert.equal(audit.sourceDisplayText(densityNote,entry,address),"Used only when direct yield is blank. Estimating density means dry-material consumption per applied volume, not installed coating density. Use this product's estimating density, not another product's value.");
  assert.equal(audit.sourceDisplayText(densityNote,entry,'D38'),densityNote);
  const factorNote='Uses the global lookup policy in D14. Next-higher results are estimates; product limits still apply.';
  for(const address of ['G43','G76','G108','G185','G241'])assert.equal(audit.sourceDisplayText(factorNote,entry,address),'Uses the global Factor lookup policy. Next-higher results are estimates; product limits still apply.');
  assert.equal(audit.sourceDisplayText(factorNote,entry,'D14'),factorNote);passed++;

  // Historical worksheet directions describe the actual app controls and pages.
  entry=setup();entry.sheet='START';
  const maintenance='Only START, CALCULATOR and BOARD SUMMARY are visible. Supporting data sheets remain embedded and hidden. Do not delete them. Library edits must also update the generated geometric lookup prefix.';
  const updated=audit.sourceDisplayText(maintenance,entry,'A27');
  assert.match(updated,/START, CALCULATOR, BOARD SUMMARY, EXTRA BOARDS and SETTINGS/);
  assert.ok(updated.endsWith('Library edits must also update the generated geometric lookup prefix.'));
  const optionalDirections='Unhide M:X for advanced inputs. M:Q controls layout, layers, lookup and installation detail. R/S = depth/width; T = area; U = mass; V = INSIDE box girth; W = added girth; X = design reference. AI gives the action directly. AJ:AV retains detailed outputs and notes.';
  assert.equal(audit.sourceDisplayText(optionalDirections,entry,'A26'),'Row status gives the required action. Saved optional inputs, detailed calculation outputs and notes remain part of the workbook rules.');
  entry.definition.id='steel_vermiculite';entry.sheet='CALCULATOR';
  assert.equal(audit.sourceDisplayText('Edit the blue cells. Check the result.',entry,'A20'),'Edit the input fields. Check the result.');
  assert.equal(audit.sourceDisplayText('Edit the blue cells. Check the result.',entry,'A21'),'Edit the blue cells. Check the result.');
  entry.sheet='SCHEDULE';assert.match(audit.sourceDisplayText('INPUTS  |  Paste your steel schedule here; blue cells are editable.',entry,'A8'),/use Import XLSX Schedule/);passed++;

  // A zero or negative source width is hidden even without an explicit hidden flag.
  assert.deepEqual([...audit.hiddenColumns({hidden_columns:[3],column_widths:{1:12,2:0,4:-1,5:9}})].sort(),[2,3,4]);passed++;

  // Form worksheets keep narrow source spacers; schedule controls retain usable widths.
  entry=setup();entry.result=result({}, {rows:[{row:9,cells:[{column:1,value:'Field'},{column:2,value:1},{column:3,value:'Units'}]}]});entry.definition.sheets[0].column_widths={1:13,2:3,3:13};
  realRender(entry);assert.equal(renderedTable().children[0].children[1].style.width,'125px');
  entry.definition.schedule.sheet='SCHEDULE';realRender(entry);
  assert.equal(renderedTable().children[0].children[1].style.width,'24px');
  assert.equal(renderedTable().style.width,'206px');passed++;

  // Rendered controls retain business names and source values; source-hidden columns stay out of the browser.
  entry = setup(); entry.definition.sheets[0].hidden_columns = [3];
  entry.result = result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: 19.123456 }] }] });
  realRender(entry);
  const table = renderedTable();
  assert.equal(table.children[0].children.length, 2); // only business columns, no row gutter
  const controlCell = renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  assert.equal(controlCell.getAttribute('aria-label'), 'Lineal metres, item 1');
  assert.equal(controlCell.value, '12.35');
  assert.ok(!byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(cell=>cell.dataset.calculatorOutput==='C9')); passed++;

  // Live calculated output updates without removing a focused input control.
  entry.definition.sheets[0].hidden_columns=[];realRender(entry);
  const renderedControl = renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  context.document.activeElement = renderedControl;
  audit.setRequest(async () => result({}, { rows: [{ row: 9, cells: [{ column: 1, value: 'Beam 1', editable: true, type: 'text' }, { column: 2, value: 12.34567, editable: true, type: 'number' }, { column: 3, value: '#VALUE!', error: '#VALUE!' }] }] }));
  await audit.calculate();
  const output = byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell => cell.dataset.calculatorOutput === 'C9');
  assert.equal(output.textContent, '#VALUE!'); assert.equal(output.classList.contains('calculator-error'), true);
  assert.equal(renderedControls().find(control=>control.dataset.calculatorCell==='B9'), renderedControl); passed++;

  // Board Line numbers are display-only; Location remains source B through all 1,000 rows.
  entry=setup();Object.assign(entry.definition.schedule,{last_row:1008,line_numbers:true,columns:[{column:'A',label:'Member mark'},{column:'B',label:'Location'}]});
  entry.definition.sheets[0].max_column=12;
  const choices=Array.from({length:553},(_,index)=>`Section ${index}`);
  entry.result=result({}, {max_row:1008,max_column:12,visible_columns:Array.from({length:12},(_,i)=>i+1),option_sets:{steel:choices},
    rows:Array.from({length:1000},(_,index)=>({row:index+9,cells:Array.from({length:12},(_,column)=>({column:column+1,address:String.fromCharCode(65+column)+(index+9),value:column===1?`Zone ${index+1}`:column?1:null,editable:true,type:column===1?'text':column?'number':'select',...(column?{}:{options_ref:'steel'})}))}))});
  const boardSourceRows=JSON.stringify(entry.result.rows);
  realRender(entry);
  assert.equal(JSON.stringify(entry.result.rows),boardSourceRows);
  assert.equal(renderedTable().children.at(-1).children.length,1000);
  assert.deepEqual(renderedTable().children[1].children[0].children.slice(0,3).map(cell=>cell.textContent),['Line','Member mark','Location']);
  assert.equal(renderedTable().children[0].children.length,13);
  for(const [index,line] of [[0,'1'],[999,'1000']]){
    const row=renderedTable().children.at(-1).children[index];
    assert.equal(row.children[0].textContent,line);assert.equal(row.children[0].dataset.calculatorOutput,undefined);
    assert.equal(row.children[2].children[0].dataset.calculatorCell,`B${index+9}`);
    assert.equal(row.children.length,13);
  }
  assert.equal(renderedControls().length,12000);
  assert.equal(byId('calculator-option-lists').children.length,1);
  assert.equal(byId('calculator-option-lists').children[0].children.length,553);
  const html=fs.readFileSync('static/index.html','utf8');
  assert.doesNotMatch(html,/calculator-(?:previous|next|row-page)/);
  assert.doesNotMatch(html,/Show advanced columns|calculator-advanced/);
  assert.doesNotMatch(source,/Show advanced columns|calculator-advanced|entry\.advanced|renderedAdvanced/);
  assert.match(html,/Add or remove schedule rows as needed · Imports create their rows automatically/);assert.doesNotMatch(html,/Highlighted fields are editable/);passed++;

  // A Location edit on the final row survives recalculation without rebuilding 12,000 controls.
  const retainedControl=renderedControls()[0],lastBoardLocation=renderedControls().find(control=>control.dataset.calculatorCell==='B1008');
  lastBoardLocation.value=' Level 10 / final bay ';await lastBoardLocation.emit('input');
  const boardLocationInputs=copy(entry.inputs);let boardLocationRequest;
  audit.setRender(realRender);audit.setRequest(async(path,options)=>{boardLocationRequest=JSON.parse(options.body);return {...copy(entry.result),inputs:boardLocationInputs};});
  context.document.activeElement=null;await audit.calculate();
  assert.equal(renderedControls()[0],retainedControl);assert.equal(renderedControls().find(control=>control.dataset.calculatorCell==='B1008'),lastBoardLocation);
  assert.equal(boardLocationRequest.inputs.CALCULATOR.B1008,' Level 10 / final bay ');assert.deepEqual(copy(entry.inputs),{CALCULATOR:{B1008:' Level 10 / final bay '}});
  assert.equal(renderedTable().children.at(-1).children[999].children[0].textContent,'1000');passed++;

  // Spray uses its existing Z Line plus independent AA Location before unchanged calculation columns.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SCHEDULE';
  entry.definition.schedule={sheet:'SCHEDULE',first_row:10,last_row:1009,header_row:9,line_id_column:'Z',columns:[{column:'Z',label:'Line'},{column:'AA',label:'Location'},{column:'A',label:'Item mark'}]};
  entry.definition.sheets=[{name:'SCHEDULE',header_rows:[9],display_column_order:[26,27,1],merges:[]}];
  entry.result=result({}, {sheet:'SCHEDULE',max_row:1009,max_column:27,visible_columns:[1,26,27],rows:Array.from({length:1000},(_,index)=>({row:index+10,cells:[
    {column:1,address:`A${index+10}`,value:`Beam ${index+1}`,editable:true,type:'text'},
    {column:26,address:`Z${index+10}`,value:index+1,calculated:true},
    {column:27,address:`AA${index+10}`,value:null,editable:true,type:'text'},
  ]}))});
  const spraySourceRows=JSON.stringify(entry.result.rows);realRender(entry);assert.equal(JSON.stringify(entry.result.rows),spraySourceRows);
  assert.deepEqual(renderedTable().children[1].children[0].children.map(cell=>cell.textContent),['Line','Location','Item mark']);
  assert.equal(renderedControls().length,2000);assert.equal(renderedTable().children.at(-1).children.length,1000);
  assert.equal(renderedTable().children.at(-1).children[0].children[0].textContent,'1');
  const finalSprayRow=renderedTable().children.at(-1).children[999];assert.equal(finalSprayRow.children[0].textContent,'1000');
  assert.equal(finalSprayRow.children[0].dataset.calculatorOutput,'Z1009');
  const sprayLocation=renderedControls().find(control=>control.dataset.calculatorCell==='AA1009');
  assert.equal(sprayLocation.getAttribute('aria-label'),'Location, item 1000');sprayLocation.value=' Roof / Zone 0 ';await sprayLocation.emit('input');
  let sprayLocationRequest;const sprayLocationInputs=copy(entry.inputs);audit.setRequest(async(path,options)=>{sprayLocationRequest=JSON.parse(options.body);return {...copy(entry.result),inputs:sprayLocationInputs};});
  await audit.calculate();assert.equal(sprayLocationRequest.inputs.SCHEDULE.AA1009,' Roof / Zone 0 ');
  assert.deepEqual(copy(entry.inputs),{SCHEDULE:{AA1009:' Roof / Zone 0 '}});assert.equal(renderedControls().find(control=>control.dataset.calculatorCell==='AA1009'),sprayLocation);
  assert.equal(finalSprayRow.children[0].textContent,'1000');assert.equal(finalSprayRow.children[2].children[0].dataset.calculatorCell,'A1009');
  let savedSprayLocation;audit.setRequest(async(path,options)=>{assert.match(path,/\/state$/);savedSprayLocation=JSON.parse(options.body);return savedSprayLocation;});
  await audit.save();assert.deepEqual(savedSprayLocation,{inputs:{SCHEDULE:{AA1009:' Roof / Zone 0 '}}});assert.equal(audit.dirty(entry),false);passed++;

  // Formula-backed editable defaults refresh after dependencies change, keeping exact focus values.
  entry=setup();entry.result=result({}, {rows:[{row:9,cells:[{column:2,address:'B9',value:2,editable:true,type:'number',calculated:true}]}]});
  realRender(entry);const derived=renderedControls()[0];
  audit.setRequest(async()=>result({}, {rows:[{row:9,cells:[{column:2,address:'B9',value:3.24689,editable:true,type:'number',calculated:true}]}]}));
  await audit.calculate();assert.equal(renderedControls()[0],derived);assert.equal(derived.value,'3.25');
  await derived.emit('focus');assert.equal(derived.value,'3.24689');assert.deepEqual(copy(entry.inputs),{});passed++;

  // Worksheet calls request a bounded view while retaining saved hidden inputs.
  entry=setup({CALCULATOR:{B9:2,M9:'Saved optional layout'}});let worksheetBody;
  audit.setRender(()=>{});audit.setRequest(async(path,options)=>{assert.match(path,/\/worksheet$/);worksheetBody=JSON.parse(options.body);return result();});
  await audit.calculate();assert.deepEqual(worksheetBody,{inputs:{CALCULATOR:{B9:2,M9:'Saved optional layout'}},sheet:'CALCULATOR',include_advanced:false,schedule_view:{offset:0,limit:60}});passed++;

  // Schedule summaries retain relationships and zero values; the scope-block metric is display-only removed.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SCHEDULE';
  entry.definition.sheets=[{name:'SCHEDULE',display_text:{A4:'TOTAL ENTERED SPRAY AREA (m²)',G4:'COATING VOLUME QUANTIFIED (m³)'}}];
  const overview=audit.renderOverview([{row:4,cells:[{column:1,address:'A4',value:'Total spray area'},{column:7,address:'G4',value:'Coating volume'},{column:13,address:'M4',value:'Scope blocks'},{column:19,address:'S4',value:'Not quantified'}]},
    {row:5,cells:[{column:1,address:'A5',value:430.725},{column:7,address:'G5',value:11.2},{column:13,address:'M5',value:0},{column:19,address:'S5',value:0}]}],entry,Array.from({length:25},(_,i)=>i+1));
  const cards=overview.children[0].children;assert.equal(cards.length,3);
  assert.equal(cards[0].children[0].textContent,'TOTAL ENTERED SPRAY AREA (m²)');assert.equal(cards[0].children[1].textContent,'430.73');
  assert.equal(cards[1].children[0].textContent,'COATING VOLUME QUANTIFIED (m³)');assert.equal(cards[1].children[1].textContent,'11.20');
  assert.equal(cards[2].children[0].textContent,'Not quantified');assert.equal(cards[2].children[1].textContent,'0.00');
  assert.ok(!descendants(overview).some(node=>node.dataset?.calculatorOutput==='M5'||node.textContent==='Scope blocks'));passed++;

  // Product bag totals are authoritative, preserve withheld blanks and refresh without losing schedule controls.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SCHEDULE';entry.definition.schedule.sheet='SCHEDULE';
  entry.definition.sheets=[{name:'SCHEDULE',header_rows:[8],merges:[],hidden_columns:[],schedule_heading:'MEMBER SCHEDULE'}];
  const totalsResult=(net,whole)=>result({}, {sheet:'SCHEDULE',product_totals:[{product:'CAFCO 300',net_bags:net,whole_bags:whole,status:whole==null?'REVIEW YIELD':'QUANTITY COMPLETE'}],
    rows:[{row:4,cells:[{column:1,address:'A4',value:'Spray area'}]},{row:5,cells:[{column:1,address:'A5',value:20}]},{row:9,cells:[{column:2,address:'B9',value:1,editable:true,type:'number'}]}]});
  entry.result=totalsResult(2.3456789,null);realRender(entry);const bagInput=renderedControls()[0],totalsNode=entry.productTotalsElement;
  assert.equal(totalsNode.children[0].textContent,'PRODUCT SUMMARY');
  assert.ok(byId('calculator-grid').children.includes(totalsNode));
  const memberSection=byId('calculator-grid').children.find(node=>node.className==='calculator-schedule-section');
  assert.ok(memberSection);assert.equal(memberSection.children[0].textContent,'MEMBER SCHEDULE');assert.ok(descendants(memberSection).includes(bagInput));
  assert.ok(byId('calculator-grid').children.indexOf(totalsNode)<byId('calculator-grid').children.indexOf(memberSection));
  const bagOverview=descendants(totalsNode).find(node=>node.className==='calculator-overview');
  assert.ok(bagOverview);assert.equal(totalsNode.children[1],bagOverview);assert.ok(descendants(bagOverview).some(node=>node.calculatorValueCard));
  assert.ok(descendants(byId('calculator-grid')).filter(node=>node.className?.includes('calculator-table-scroll')).every(node=>!node.classList.contains('calculator-section-scroll')));
  const totalRow=()=>descendants(totalsNode).find(node=>node.tagName==='tbody').children[0];
  assert.equal(totalRow().children[1].textContent,'2.35');assert.equal(totalRow().children[2].textContent,'');assert.equal(totalRow().children[3].textContent,'REVIEW YIELD');
  audit.setRender(realRender);audit.setRequest(async()=>totalsResult(4.56789,6));await audit.calculate();
  assert.equal(renderedControls()[0],bagInput);assert.equal(entry.productTotalsElement,totalsNode);assert.equal(totalRow().children[1].textContent,'4.57');assert.equal(totalRow().children[2].textContent,'6.00');passed++;

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

  // The period matrix has eight equal period columns; the form's narrow G spacer cannot crush 120 minutes.
  entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  entry.definition.sheets[0]={name:'CALCULATOR',header_rows:[28],hidden_columns:[],merges:['J28:N30'],column_widths:{7:3}};
  entry.result=result({}, {max_column:14,visible_columns:Array.from({length:14},(_,i)=>i+1),rows:[28,29,30].map((row)=>({row,cells:Array.from({length:10},(_,i)=>({column:i+1,address:`${String.fromCharCode(65+i)}${row}`,value:i===9?(row===28?'The source qualification stays visible.':null):i===0?['Minutes','mm','Status'][row-28]:row===28?[15,30,45,60,90,120,180,240][i-1]:row===29?26:'TABLE'}))}))});
  realRender(entry);const periods=renderedTable();assert.equal(periods.children[0].children.length,9);
  assert.equal(periods.children[0].children[6].style.width,'88px');assert.equal(periods.children[0].children[5].style.width,'88px');
  for(const row of periods.children.at(-1).children)assert.equal(row.children.length,9);
  assert.equal(periods.children.at(-1).children[0].children[6].textContent,'120.00');
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.dataset?.calculatorOutput==='J28'));assert.equal(entry.result.rows[0].cells[9].value,'The source qualification stays visible.');passed++;

  // Every declared main section has a distinct theme and a real contents target; the old banner is omitted.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';entry.definition.schedule.sheet='SCHEDULE';
  const anchors=[9,17,31,64,96,173,229,270,341,356,370];
  entry.definition.sheets=[{name:'SETTINGS',header_rows:[],section_cells:anchors.map(row=>`A${row}`),hidden_columns:[],merges:[]}];
  entry.result=result({}, {sheet:'SETTINGS',rows:[{row:5,cells:[{column:1,address:'A5',value:'OLD NAVIGATION BANNER'}]},...anchors.map((row,index)=>({row,cells:[{column:1,address:`A${row}`,value:`Section ${index+1}`,presentation:{role:'section'}}]}))]});
  realRender(entry);const contents=byId('calculator-grid').children[0];assert.equal(contents.tagName,'nav');
  const sectionLinks=contents.children[1].children;assert.equal(sectionLinks.length,11);assert.equal(new Set(sectionLinks.map(link=>link.className)).size,11);
  for(const [index,link] of sectionLinks.entries()) {const target=descendants(byId('calculator-grid')).find(node=>`#${node.id}`===link.href);assert.ok(target);assert.equal(target.classList.contains(`calculator-section-theme-${index}`),true);}
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.textContent==='OLD NAVIGATION BANNER'));passed++;

  // A full reset uses reviewed calculator defaults and remains a draft until explicitly saved.
  entry=setup({SCHEDULE:{A10:'Example'},SETTINGS:{D36:1}});entry.definition.defaults={SETTINGS:{D36:20,D42:'Reviewed'}};
  audit.setRequest(async(path,options)=>result(JSON.parse(options.body).inputs));
  const resetReviewed=audit.reset();await flush();await byId('calculator-confirm-dialog').close('confirm');await resetReviewed;
  assert.deepEqual(copy(entry.inputs),entry.definition.defaults);assert.equal(JSON.parse(entry.saved).SETTINGS.D36,1);assert.equal(audit.dirty(entry),true);passed++;

  // Removed review controls cannot reappear from definition data; the five stored basis values remain readonly.
  entry=setup({SETTINGS:{D42:'Stored basis\nExisting project qualification'}});entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';
  entry.definition.defaults={SETTINGS:{D36:20}};entry.definition.yield_review={products:[{product:'CAFCO 300'}]};
  entry.definition.sheets.find(sheet=>sheet.name==='SETTINGS').display_cells={D42:{bold:false}};
  entry.result=result(copy(entry.inputs),{sheet:'SETTINGS',max_column:4,rows:[42,75,107,184,240].map(row=>({row,cells:[{column:1,address:`A${row}`,value:'Material basis / reference',presentation:{role:'label'}},{column:4,address:`D${row}`,value:row===42?entry.inputs.SETTINGS.D42:'Retained source basis',editable:false,read_only:true,output:true,type:'text',presentation:{role:'note',bold:true}}]}))});
  realRender(entry);assert.equal(renderedControls().length,0);
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.tagName==='button'||node.tagName==='details'));
  const basisCell=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='D42');
  assert.equal(basisCell.textContent,'Stored basis\nExisting project qualification');assert.equal(basisCell.classList.contains('calculator-value-present'),true);
  assert.equal(basisCell.classList.contains('calculator-normal'),true);assert.equal(basisCell.classList.contains('calculator-bold'),false);
  assert.deepEqual(copy(entry.inputs),{SETTINGS:{D42:'Stored basis\nExisting project qualification'}});
  assert.doesNotMatch(source,/function (?:useReviewedDefaults|renderYieldReview)|calculator-reviewed-defaults/);passed++;

  // Source metadata row exclusions remove presentation only, including all product publication blocks.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';
  const omitted=[32,33,34,65,66,67,97,98,99,174,175,176,230,231,232];
  entry.definition.sheets=[{name:'SETTINGS',header_rows:[],merges:[],omitted_rows:omitted}];
  entry.result=result({}, {sheet:'SETTINGS',rows:[...omitted.map(row=>({row,cells:[{column:1,address:`A${row}`,value:`Source publication ${row}`}]})),{row:36,cells:[{column:1,address:'A36',value:'Bag mass'},{column:2,address:'B36',value:20,editable:true,type:'number'}]}]});
  const preservedSource=JSON.stringify(entry.result);realRender(entry);
  assert.deepEqual(descendants(byId('calculator-grid')).filter(node=>node.dataset?.sourceRow).map(node=>node.dataset.sourceRow),['36']);
  assert.equal(JSON.stringify(entry.result),preservedSource);assert.equal(renderedControls().length,1);passed++;

  // Schedule title prose and V/W/X stay hidden even in a full API result; cards, pooled totals and Y stay visible.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SCHEDULE';entry.definition.schedule.sheet='SCHEDULE';
  entry.definition.schedule.header_row=9;entry.definition.schedule.first_row=10;
  entry.definition.sheets=[{name:'SCHEDULE',header_rows:[9],merges:[],omitted_rows:[1,2,3,8],omitted_columns:[22,23,24]}];
  entry.result=result({}, {sheet:'SCHEDULE',max_column:25,visible_columns:Array.from({length:25},(_,i)=>i+1),product_totals:[{product:'CAFCO 300',net_bags:0,whole_bags:null,status:'NO SCHEDULE LINES'}],rows:[
    ...[1,2,3,8].map(row=>({row,cells:[{column:1,address:`A${row}`,value:`Removed introductory line ${row}`}]})),
    {row:4,cells:[{column:1,address:'A4',value:'Area'},{column:7,address:'G4',value:'Volume'},{column:19,address:'S4',value:'Not quantified'}]},
    {row:5,cells:[{column:1,address:'A5',value:0},{column:7,address:'G5',value:0},{column:19,address:'S5',value:0}]},
    {row:10,cells:[{column:1,address:'A10',value:'Member',editable:true,type:'text'},...[22,23,24,25].map(column=>({column,address:`${String.fromCharCode(64+column)}10`,value:column===25?'Visible detailed note':`Hidden source ${column}`,calculated:true}))]}]});
  const fullResult=JSON.stringify(entry.result);
  realRender(entry);const rendered=descendants(byId('calculator-grid'));
  assert.ok(!rendered.some(node=>/^Removed introductory line|^Hidden source/.test(node.textContent||'')));
  assert.ok(rendered.some(node=>node.dataset?.calculatorOutput==='Y10'));
  assert.equal(renderedControls().length,1);assert.equal(entry.productTotalsElement.hidden,false);
  assert.equal(rendered.filter(node=>node.calculatorValueCard).length,3);
  assert.equal(JSON.stringify(entry.result),fullResult);passed++;

  // Settings banners are omitted from display; source titles and other notes remain unchanged.
  for(const [id,sheet] of [['steel_vermiculite','SETTINGS'],['ductwork','PRODUCT SETTINGS'],['steel_board','SETTINGS']]){
    entry=setup();entry.definition.id=id;entry.sheet=sheet;entry.definition.sheets=[{name:sheet,header_rows:[],merges:['A1:C1']}];
    entry.result=result({}, {sheet,rows:[{row:1,cells:[{column:1,address:'A1',value:'Original settings title',presentation:{role:'section'}}]},
      {row:4,cells:[{column:1,address:'A4',value:'Retain the other source note',presentation:{role:'note'}}]}]});
    realRender(entry);const title=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='A1');
    assert.equal(title,undefined);assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(cell=>cell.dataset.calculatorOutput==='A4'));
    assert.equal(entry.result.rows[0].cells[0].value,'Original settings title');
  }passed++;

  // A calculated reference with a heading-like source font remains a value output (Verm H23).
  entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  entry.definition.sheets[0].section_cells=['A26'];
  entry.result=result({}, {max_column:8,rows:[{row:23,cells:[{column:8,address:'H23',value:'C300-2021 p4',calculated:true,presentation:{role:'section',bold:true}}]},
    {row:26,cells:[{column:1,address:'A26',value:'Published periods',calculated:true,presentation:{role:'section',bold:true}}]}]});
  realRender(entry);const referenceOutput=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='H23');
  assert.match(referenceOutput.className,/calculator-role-output/);assert.equal(referenceOutput.classList.contains('calculator-value-present'),true);
  const explicitSection=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='A26');
  assert.match(explicitSection.className,/calculator-role-section/);assert.equal(explicitSection.dataset.calculatorValue,undefined);passed++;

  // The BAGS order table uses nine logical columns, fills desktop width and gives status a bounded share.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='BAGS';entry.definition.sheets=[{name:'BAGS',header_rows:[19],merges:['A1:N1']}];
  entry.result=result({}, {sheet:'BAGS',max_column:14,visible_columns:Array.from({length:14},(_,i)=>i+1),rows:[{row:1,cells:[{column:1,address:'A1',value:'Bags'}]},...[19,20,21,22,23,24].map(row=>({row,cells:Array.from({length:9},(_,i)=>({column:i+1,address:`${String.fromCharCode(65+i)}${row}`,value:i===8?'Order status':row===19?'Header':0,calculated:row!==19}))}))]});
  realRender(entry);const order=descendants(byId('calculator-grid')).find(node=>node.classList?.contains('calculator-order-table'));
  assert.equal(order.style.width,'100%');assert.equal(order.children[0].children.length,9);assert.equal(order.children[0].children[8].style.width,'20%');
  assert.equal(order.children[0].children.reduce((sum,col)=>sum+parseFloat(col.style.width),0),100);
  assert.equal(order.children.at(-1).children.length,6);
  const bagsForm=descendants(byId('calculator-grid')).find(node=>node.classList?.contains('calculator-bags-form'));
  assert.equal(bagsForm.style.width,'100%');assert.ok(bagsForm.children[0].children.every(col=>col.style.width.endsWith('%')));
  assert.ok(Math.abs(bagsForm.children[0].children.reduce((sum,col)=>sum+parseFloat(col.style.width),0)-100)<1e-10);passed++;

  // Every output state uses the same two fill classes, including live zero/error/text/blank transitions.
  entry=setup();entry.result=result({}, {rows:[{row:9,cells:[{column:1,address:'A9',value:'Input',editable:true,type:'text'},{column:2,address:'B9',value:0,calculated:true,presentation:{role:'output',bold:true}},{column:3,address:'C9',value:'Label',presentation:{role:'label'}}]}]});
  realRender(entry);audit.setRender(realRender);const retainedValue=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='B9');
  for(const value of [null,'',undefined,0,'OK','#VALUE!']) {
    const changed=result({}, {rows:[{row:9,cells:[{column:1,address:'A9',value:'Input',editable:true,type:'text'},{column:2,address:'B9',value,calculated:true,presentation:{role:'output',bold:true}},{column:3,address:'C9',value:'Label',presentation:{role:'label'}}]}]});
    audit.setRequest(async()=>changed);await audit.calculate();
    const expected=value!==null&&value!==undefined&&value!=='';
    assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='B9'),retainedValue);
    assert.equal(retainedValue.classList.contains('calculator-value-present'),expected);assert.equal(retainedValue.classList.contains('calculator-value-empty'),!expected);
  }
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='C9').dataset.calculatorValue,'true');
  assert.doesNotMatch(fs.readFileSync('static/calculators.css','utf8'),/nth-child\(even\).*background|tbody tr:hover>td/);passed++;

  // Literal product/reference values inside source tables use output fills even when their original font was bold.
  for(const [id,sheet,row,column] of [['ductwork','SUMMARY',9,1],['steel_board','BOARD SUMMARY',12,1],['steel_board','SETTINGS',6,7]]) {
    entry=setup();entry.definition.id=id;entry.sheet=sheet;entry.definition.sheets=[{name:sheet,header_rows:[5],merges:[]}];
    entry.result=result({}, {sheet,max_column:column,rows:[{row,cells:[{column,address:`${String.fromCharCode(64+column)}${row}`,value:'Reference product',presentation:{role:'label',bold:true}}]}]});
    realRender(entry);const reference=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.textContent==='Reference product');
    assert.equal(reference.classList.contains('calculator-value-present'),true);
  }passed++;

  // Duct SUMMARY E9/F9/G9 are real blank table outputs even though they contain no source formulas.
  entry=setup();entry.definition.id='ductwork';entry.sheet='SUMMARY';entry.definition.sheets=[{name:'SUMMARY',header_rows:[8],merges:[]}];
  entry.result=result({}, {sheet:'SUMMARY',max_column:7,rows:[{row:8,cells:[{column:1,address:'A8',value:'Product'},...[5,6,7].map(column=>({column,address:`${String.fromCharCode(64+column)}8`,value:'Quantity',presentation:{role:'column_header'}}))]},
    {row:9,cells:[{column:1,address:'A9',value:'CAFCO 300'},...[5,6,7].map(column=>({column,address:`${String.fromCharCode(64+column)}9`,value:null,calculated:false,presentation:{role:'body'}}))]}]});
  realRender(entry);for(const address of ['E9','F9','G9']) {
    const blank=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput===address);
    assert.equal(blank.dataset.calculatorValue,'true');assert.equal(blank.classList.contains('calculator-value-empty'),true);
  }
  entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';entry.definition.sheets[0].merges=['A1:H1'];
  entry.result=result({}, {max_column:8,rows:[{row:1,cells:[{column:1,address:'A1',value:'Member calculator',presentation:{role:'title'}}]},
    {row:6,cells:[{column:1,address:'A6',value:'Product',presentation:{role:'label'}},{column:4,address:'D6',value:'CAFCO 300',editable:true,type:'text'},{column:7,address:'G6',value:null,calculated:false}]}]});
  realRender(entry);assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(cell=>cell.dataset.calculatorOutput==='G6').dataset.calculatorValue,undefined);passed++;

  // Duct summaries have separate table geometry; local omissions never hide another table's quantities.
  entry=setup();entry.definition.id='ductwork';entry.sheet='SUMMARY';
  const summaryTables=[
    {first_row:8,last_row:11,columns:[1,2,3,4,5,6,7,8,9,10],column_widths:[200,125,125,125,125,125,125,125,125,125],label:'Product totals'},
    {first_row:18,last_row:26,columns:['A','B','C','D','E','F'],column_widths:[200,160,160,125,200,360],label:'Angle totals'},
    {first_row:30,last_row:32,columns:[1,2,3],column_widths:[200,125,180],label:'Working yields'},
    {first_row:39,last_row:41,columns:[1,2,3,4,5,6,7],column_widths:[200,125,125,125,125,125,125],label:'Board totals'},
  ];
  const boldDuctSummaryRows=[9,10,11,19,20,21,22,23,24,25,26,31,32];
  entry.definition.sheets=[{name:'SUMMARY',header_rows:[8,18,30,39],section_cells:['A17','A29','A38'],navigation_mode:'hidden',section_spacing:true,presentation_tables:summaryTables,display_cells:{A1:{role:'compact_summary_title'},A17:{merge:'A17:L17'},A29:{merge:'A29:L29'},...Object.fromEntries(boldDuctSummaryRows.map(row=>[`A${row}`,{bold:true}]))},merges:['A1:L1','A14:L14','A15:L15','A17:F17','A29:F29','A35:L35','A36:L36','A37:L37','A38:L38','I40:L40','A43:L43']}];
  const summaryRows=[1,14,15,17,29,35,36,37,38,43].map(row=>({row,cells:[{column:1,address:`A${row}`,value:`Source note ${row}`,presentation:{role:'note'}}]}));
  for(const table of summaryTables) for(let row=table.first_row;row<=table.last_row;row++) summaryRows.push({row,cells:Array.from({length:12},(_,i)=>({column:i+1,address:`${String.fromCharCode(65+i)}${row}`,value:row===26?null:row===table.first_row?`Header ${i+1}`:row*100+i,calculated:row!==table.first_row}))});
  summaryRows.sort((a,b)=>a.row-b.row);
  entry.result=result({}, {sheet:'SUMMARY',max_column:12,visible_columns:Array.from({length:12},(_,i)=>i+1),display_cells:{A1:{role:'compact_summary_title'},A17:{merge:'A17:L17'},A29:{merge:'A29:L29'},...Object.fromEntries(boldDuctSummaryRows.map(row=>[`A${row}`,{bold:true}]))},rows:summaryRows});
  const originalSummary=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  const summaryRendered=descendants(byId('calculator-grid')).filter(node=>node.tagName==='table');
  assert.equal(summaryRendered.length,11);
  assert.deepEqual(summaryRendered.map(table=>table.children.at(-1).children.map(row=>Number(row.dataset.sourceRow))),[[1],[8,9,10,11],[14,15],[17],[18,19,20,21,22,23,24,25,26],[29],[30,31,32],[35,36,37],[38],[39,40,41],[43]]);
  const logicalSummary=byId('calculator-grid').children.filter(node=>node.className==='calculator-logical-section');assert.equal(logicalSummary.length,4);
  assert.deepEqual(logicalSummary.map(section=>descendants(section).filter(node=>node.tagName==='tr').map(node=>Number(node.dataset.sourceRow))),[[1,8,9,10,11,14,15],[17,18,19,20,21,22,23,24,25,26],[29,30,31,32,35,36,37],[38,39,40,41,43]]);
  for(const spec of summaryTables) {
    const table=summaryRendered.find(node=>node.getAttribute('aria-label')===spec.label);
    assert.equal(table.children[0].children.length,spec.columns.length);
    assert.deepEqual(table.children[0].children.map(col=>col.style.width),spec.column_widths.map(width=>`${width}px`));
    assert.ok(table.children.at(-1).children[0].children.every(cell=>cell.tagName==='th'));
  }
  const summaryOutputs=()=>byId('calculator-grid').querySelectorAll('[data-calculator-output]');
  const productSummaryHeading=summaryOutputs().find(cell=>cell.dataset.calculatorOutput==='A1');assert.match(productSummaryHeading.className,/calculator-role-compact_summary_title/);assert.equal(productSummaryHeading.dataset.calculatorValue,undefined);assert.equal(productSummaryHeading.classList.contains('calculator-value-present'),false);
  for(const address of ['K9','L9','D31','E31','F31','H40','I40','J40','K40','L40']) assert.ok(!summaryOutputs().some(cell=>cell.dataset.calculatorOutput===address),address);
  for(const address of ['D9','E9','F9','G9','D19','E19','F19','E40','F40','G40']) assert.ok(summaryOutputs().some(cell=>cell.dataset.calculatorOutput===address),address);
  for(const row of boldDuctSummaryRows)assert.equal(summaryOutputs().find(cell=>cell.dataset.calculatorOutput===`A${row}`).classList.contains('calculator-bold'),true);
  assert.equal(summaryOutputs().find(cell=>cell.dataset.calculatorOutput==='B9').classList.contains('calculator-bold'),false);
  const productColumns=summaryRendered[1].children[0].children;
  assert.equal(productColumns[4].style.width,productColumns[1].style.width);assert.equal(productColumns[5].style.width,productColumns[1].style.width);
  for(const row of [17,29]) {
    const titleRow=descendants(byId('calculator-grid')).find(node=>node.dataset?.sourceRow===String(row));
    assert.equal(titleRow.children.length,1);assert.equal(titleRow.children[0].colSpan,12);
    assert.equal(titleRow.children[0].dataset.calculatorOutput,`A${row}`);
  }
  assert.ok(entry.definition.sheets[0].merges.includes('A17:F17'));assert.ok(entry.definition.sheets[0].merges.includes('A29:F29'));
  assert.equal(descendants(byId('calculator-grid')).filter(node=>node.classList?.contains('calculator-section-scroll')).length,4);
  assert.equal(summaryOutputs().find(cell=>cell.dataset.calculatorOutput==='A26').classList.contains('calculator-value-empty'),true);
  assert.equal(JSON.stringify(entry.result),originalSummary);passed++;

  // Ordinary result refreshes retain table nodes; layout metadata changes rebuild the independent columns.
  const oldTable=summaryRendered[1],oldQuantity=summaryOutputs().find(cell=>cell.dataset.calculatorOutput==='F9');
  let summaryResponse=copy(entry.result);summaryResponse.rows.find(row=>row.row===9).cells.find(cell=>cell.column===6).value=123.456;
  audit.setRequest(async()=>summaryResponse);await audit.calculate();
  assert.equal(summaryOutputs().find(cell=>cell.dataset.calculatorOutput==='F9'),oldQuantity);assert.equal(oldQuantity.textContent,'123.46');
  summaryResponse={...summaryResponse,presentation_tables:copy(summaryTables)};summaryResponse.presentation_tables[0].column_widths[0]=240;
  await audit.calculate();const changedProductTable=descendants(byId('calculator-grid')).find(node=>node.getAttribute?.('aria-label')==='Product totals'&&node.tagName==='table');
  assert.notEqual(changedProductTable,oldTable);assert.equal(changedProductTable.children[0].children[0].style.width,'240px');passed++;

  // Removing Both/Mixed notes is a bounded rectangle: left-hand settings and later FyreWrap reference columns survive.
  entry=setup();entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  entry.definition.sheets=[{name:'PRODUCT SETTINGS',header_rows:[],section_cells:['J6','J94'],omitted_ranges:['J6:Q21'],merges:['J6:Q6','J94:Q94']}];
  entry.result=result({}, {sheet:entry.sheet,max_column:17,rows:[
    {row:6,cells:[{column:1,address:'A6',value:'Primary settings',presentation:{role:'label'}},{column:4,address:'D6',value:25.12345,editable:true,type:'number'},{column:10,address:'J6',value:'Removed Both/Mixed title',presentation:{role:'section'}}]},
    {row:7,cells:[{column:10,address:'J7',value:'Removed Both/Mixed note'}]},
    {row:21,cells:[{column:17,address:'Q21',value:'Removed final note'}]},
    {row:94,cells:[{column:10,address:'J94',value:'FyreWrap reference',presentation:{role:'section'}}]},
    {row:100,cells:[{column:10,address:'J100',value:0.005,editable:true,type:'number'},{column:17,address:'Q100',value:'Functional reference'}]},
  ]});
  const sourceSettings=JSON.stringify(entry.result);realRender(entry);
  let settingsNodes=descendants(byId('calculator-grid'));
  assert.ok(!settingsNodes.some(node=>/^Removed/.test(node.textContent||'')));
  assert.ok(!settingsNodes.some(node=>node.href?.endsWith('-J6')));assert.ok(settingsNodes.some(node=>node.href?.endsWith('-J94')));
  assert.ok(!settingsNodes.some(node=>['J6','J7','Q21'].includes(node.dataset?.calculatorOutput)));
  assert.deepEqual(renderedControls().map(control=>control.dataset.calculatorCell),['D6','J100']);
  assert.ok(settingsNodes.some(node=>node.dataset?.calculatorOutput==='Q100'));assert.equal(JSON.stringify(entry.result),sourceSettings);
  audit.setRender(realRender);audit.setRequest(async()=>({...entry.result,omitted_ranges:[]}));await audit.calculate();
  settingsNodes=descendants(byId('calculator-grid'));assert.ok(settingsNodes.some(node=>node.dataset?.calculatorOutput==='J6'));passed++;

  // Board status body cells are normal weight on render and refresh, while the schedule header remains bold.
  entry=setup();entry.definition.sheets[0].max_column=35;
  entry.result=result({}, {max_column:35,visible_columns:[1,35],rows:[{row:8,cells:[{column:35,address:'AI8',value:'Row status',presentation:{role:'column_header',bold:true}}]},
    ...[9,208].map(row=>({row,cells:[{column:35,address:`AI${row}`,value:'Review required',calculated:true,presentation:{role:'output',bold:true}}]}))]});
  realRender(entry);audit.setRender(realRender);
  const statusOutputs=byId('calculator-grid').querySelectorAll('[data-calculator-output]');
  for(const address of ['AI9','AI208']) assert.equal(statusOutputs.find(node=>node.dataset.calculatorOutput===address).classList.contains('calculator-row-status'),true);
  assert.ok(descendants(byId('calculator-grid')).filter(node=>node.tagName==='th').every(node=>!node.classList.contains('calculator-row-status')));
  const retainedStatus=statusOutputs.find(node=>node.dataset.calculatorOutput==='AI9');
  const statusResult=copy(entry.result);statusResult.rows.find(row=>row.row===9).cells[0].value='Ready';audit.setRequest(async()=>statusResult);await audit.calculate();
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='AI9'),retainedStatus);
  assert.equal(retainedStatus.textContent,'Ready');assert.equal(retainedStatus.classList.contains('calculator-row-status'),true);
  assert.match(fs.readFileSync('static/calculators.css','utf8'),/td\.calculator-row-status\s*\{\s*font-weight:\s*400\s*!important/);passed++;

  // Overlapping board settings source rows become three ordered tables, with every primary control exactly once.
  entry=setup();entry.sheet='SETTINGS';
  const boardSettingTables=[
    {first_row:5,last_row:34,columns:[1,2,3],column_widths:[460,180,140],label:'Primary settings'},
    {first_row:5,last_row:10,columns:[7,8,9,10,11,12,13,14],column_widths:Array(8).fill(140),label:'Dropdown values'},
    {first_row:5,last_row:51,columns:[16,17],column_widths:[360,620],label:'Diagnostic messages'},
  ];
  entry.definition.sheets=[{name:'SETTINGS',header_rows:[5],table_layout:'stacked',presentation_tables:boardSettingTables,omitted_ranges:['D5:D34','G12:N13'],merges:['A1:H2','A3:H3','G13:K13','L13:N13']}];
  const settingRows=[{row:1,cells:[{column:1,address:'A1',value:'SETTINGS & CONVENTIONS',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Source constants are not project approvals.',presentation:{role:'note'}}]}];
  for(let row=5;row<=51;row++) {
    const cells=[];
    if(row<=34) for(let column=1;column<=4;column++) cells.push({column,address:`${String.fromCharCode(64+column)}${row}`,value:row===22?null:column===2&&row>5?row+0.123456:column===4?'Removed basis':`Primary ${row}/${column}`,editable:column===2&&row>5&&row!==22,type:'number'});
    if(row<=10||row===12||row===13) for(let column=7;column<=14;column++) cells.push({column,address:`${String.fromCharCode(64+column)}${row}`,value:row>=12?'Removed dropdown reference':row===5?`Dropdown ${column}`:row*10+column});
    cells.push({column:16,address:`P${row}`,value:row===5?'Existing diagnostic code':`Diagnostic ${row}`},{column:17,address:`Q${row}`,value:row===5?'Plain-English message':'Live diagnostic lookup message'});
    settingRows.push({row,cells});
  }
  entry.result=result({}, {sheet:'SETTINGS',max_column:17,visible_columns:Array.from({length:17},(_,i)=>i+1),rows:settingRows});
  const settingsRaw=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  const stacked=descendants(byId('calculator-grid')).filter(node=>node.className==='calculator-stacked-section');
  assert.equal(stacked.length,3);assert.deepEqual(stacked.map(node=>node.children[0].textContent),boardSettingTables.map(table=>table.label));
  assert.equal(new Set(stacked.map(node=>node.children[0].className)).size,3);
  for(const section of stacked) assert.ok(descendants(byId('calculator-grid')).some(node=>node.href===`#${section.children[0].id}`));
  for(const [index,section] of stacked.entries()) {
    const table=descendants(section).find(node=>node.tagName==='table'),spec=boardSettingTables[index];
    assert.equal(table.getAttribute('aria-label'),spec.label);assert.equal(table.children[0].children.length,spec.columns.length);
    assert.equal(table.children.at(-1).children.length,spec.last_row-spec.first_row+1);
  }
  assert.equal(renderedControls().length,28);assert.equal(new Set(renderedControls().map(node=>node.dataset.calculatorCell)).size,28);
  assert.ok(renderedControls().some(node=>node.dataset.calculatorCell==='B12'));assert.ok(renderedControls().some(node=>node.dataset.calculatorCell==='B13'));
  assert.ok(!descendants(byId('calculator-grid')).some(node=>/Removed basis|Removed dropdown reference/.test(node.textContent||'')));
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>['A1','A3'].includes(node.dataset.calculatorOutput)).length,0);
  assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='Q51'));
  assert.equal(JSON.stringify(entry.result),settingsRaw);assert.deepEqual(copy(entry.inputs),{});
  const primaryControl=renderedControls().find(node=>node.dataset.calculatorCell==='B12');
  const updatedSettings=copy(entry.result);updatedSettings.inputs={SETTINGS:{B12:99.987654}};updatedSettings.rows.find(row=>row.row===12).cells.find(cell=>cell.column===2).value=99.987654;
  audit.setRequest(async()=>updatedSettings);await audit.calculate();assert.equal(renderedControls().find(node=>node.dataset.calculatorCell==='B12'),primaryControl);assert.equal(primaryControl.value,'99.99');assert.equal(entry.inputs.SETTINGS.B12,99.987654);passed++;

  // BOARD SUMMARY hides six purchasing columns while retaining all three cards, warning rows and raw quantities.
  entry=setup();entry.sheet='BOARD SUMMARY';entry.definition.sheets=[{name:entry.sheet,header_rows:[11],presentation_tables:[{first_row:11,last_row:29,columns:[1,2,3,4,9,10],column_widths:[240,150,150,150,150,150],label:'Board purchasing totals'}],merges:['A1:L1','A3:L3','A6:C7','E6:G7','I6:L7','A8:L9','A31:L31','A35:L35']}];
  const purchasingHeaders=['Product','Thickness mm','Sheet length mm','Sheet width mm','Box board - net m2','Extra boards - net m2','Net total sqm','With waste sqm','Whole sheets','Purchase sqm','Stock source','Board key'];
  entry.result=result({}, {sheet:entry.sheet,max_column:12,rows:[
    {row:1,cells:[{column:1,address:'A1',value:'BOARD SUMMARY',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Product totals include additional boards.',presentation:{role:'note'}}]},
    {row:5,cells:[{column:1,address:'A5',value:'Net board area'},{column:5,address:'E5',value:'Board area with waste'},{column:9,address:'I5',value:'Whole sheets'}]},
    {row:6,cells:[{column:1,address:'A6',value:58.476,calculated:true},{column:5,address:'E6',value:60.789,calculated:true},{column:9,address:'I6',value:27,calculated:true}]},
    {row:8,cells:[{column:1,address:'A8',value:'9 incomplete rows need review.',calculated:true,presentation:{role:'note'}}]},
    {row:11,cells:purchasingHeaders.map((value,index)=>({column:index+1,address:`${String.fromCharCode(65+index)}11`,value}))},
    ...[12,29].map(row=>({row,cells:purchasingHeaders.map((_,index)=>({column:index+1,address:`${String.fromCharCode(65+index)}${row}`,value:index===0?'COREX':index===6?21.014:index+1,calculated:index>3&&index<10}))})),
    {row:31,cells:[{column:1,address:'A31',value:'Additional board quantities require review.',calculated:true,presentation:{role:'note'}}]},
    {row:35,cells:[{column:1,address:'A35',value:'Board quantity scope note.',presentation:{role:'note'}}]},
  ]});
  const sourceBoardSummary=JSON.stringify(entry.result);
  realRender(entry);audit.setRender(realRender);
  const summaryCards=descendants(byId('calculator-grid')).filter(node=>node.calculatorValueCard);
  assert.equal(summaryCards.length,3);assert.deepEqual(summaryCards.map(node=>node.textContent),['58.48','60.79','27.00']);
  const boardSummaryOverview=byId('calculator-grid').children.find(node=>node.className==='calculator-overview');
  assert.equal(boardSummaryOverview.classList.contains('calculator-overview-full'),true);assert.equal(boardSummaryOverview.classList.contains('calculator-overview-board'),true);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>node.dataset.calculatorOutput==='A8').length,1);
  const purchasingTable=descendants(byId('calculator-grid')).find(node=>node.tagName==='table'&&node.getAttribute('aria-label')==='Board purchasing totals');
  assert.equal(purchasingTable.children[0].children.length,6);
  assert.deepEqual(purchasingTable.children.at(-1).children[0].children.map(node=>node.textContent),[0,1,2,3,8,9].map(index=>purchasingHeaders[index]));
  const purchasingOutputAddresses=byId('calculator-grid').querySelectorAll('[data-calculator-output]').map(node=>node.dataset.calculatorOutput);
  for(const row of [12,29]) {
    for(const column of ['E','F','G','H','K','L'])assert.ok(!purchasingOutputAddresses.includes(`${column}${row}`));
    for(const column of ['A','B','C','D','I','J'])assert.ok(purchasingOutputAddresses.includes(`${column}${row}`));
  }
  for(const address of ['A6','E6','I6','A31','A35'])assert.ok(purchasingOutputAddresses.includes(address));
  assert.equal(JSON.stringify(entry.result),sourceBoardSummary);
  for(const row of descendants(byId('calculator-grid')).filter(node=>node.dataset?.sourceRow)) assert.ok(Number(row.dataset.sourceRow)>=11);
  const updatedSummary=copy(entry.result);updatedSummary.rows.find(row=>row.row===6).cells[0].value=0;updatedSummary.rows.find(row=>row.row===8).cells[0].value='No incomplete rows';audit.setRequest(async()=>updatedSummary);await audit.calculate();
  assert.equal(summaryCards[0].textContent,'0.00');assert.equal(summaryCards[0].calculatorValueCard.classList.contains('calculator-value-present'),true);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='A8').textContent,'No incomplete rows');passed++;

  // Hiding Evidence reference preserves saved references and optional inputs through edits, calculation and save.
  entry=setup({CALCULATOR:{M9:'Saved optional layout'},'EXTRA BOARDS':{A6:'Extra support',N6:'Existing design reference'}});
  entry.sheet='EXTRA BOARDS';entry.definition.sheets=[{name:entry.sheet,header_rows:[5],omitted_columns:[14],merges:[]}];
  const extraResult=inputs=>result(copy(inputs),{sheet:'EXTRA BOARDS',max_column:14,visible_columns:[1,13,14],rows:[
    {row:1,cells:[{column:1,address:'A1',value:'EXTRA BOARDS / DETAIL TAKEOFF',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Add additional boards using the required quantities.',presentation:{role:'note'}}]},
    {row:5,cells:[{column:1,address:'A5',value:'Item'},{column:13,address:'M5',value:'Status'},{column:14,address:'N5',value:'Evidence reference'}]},
    {row:6,cells:[{column:1,address:'A6',value:inputs['EXTRA BOARDS'].A6,editable:true,type:'text'},{column:13,address:'M6',value:'REVIEW',calculated:true},{column:14,address:'N6',value:inputs['EXTRA BOARDS'].N6,editable:true,type:'text'}]},
  ]});
  entry.result=extraResult(entry.inputs);const sourceExtraRows=JSON.stringify(entry.result.rows);realRender(entry);audit.setRender(realRender);
  assert.deepEqual(renderedControls().map(node=>node.dataset.calculatorCell),['A6']);
  const extraOverview=byId('calculator-grid').children.find(node=>node.className==='calculator-overview');
  assert.equal(extraOverview.classList.contains('calculator-overview-full'),true);
  assert.equal(extraOverview.children.find(node=>node.dataset.calculatorOutput==='A1').tagName,'h3');
  assert.equal(extraOverview.children.find(node=>node.dataset.calculatorOutput==='A3').className,'calculator-overview-note');
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.textContent==='Evidence reference'));
  assert.equal(JSON.stringify(entry.result.rows),sourceExtraRows);
  const visibleExtraInput=renderedControls()[0];visibleExtraInput.value='Updated support';await visibleExtraInput.emit('input');
  let extraSavedBody;
  audit.setRequest(async(path,options)=>{
    const body=JSON.parse(options.body);
    if(path.endsWith('/worksheet')){assert.equal(body.include_advanced,false);return extraResult(body.inputs);}
    assert.ok(path.endsWith('/state'));extraSavedBody=body;return {inputs:copy(body.inputs)};
  });
  await audit.calculate();await audit.save();
  const retainedHiddenInputs={CALCULATOR:{M9:'Saved optional layout'},'EXTRA BOARDS':{A6:'Updated support',N6:'Existing design reference'}};
  assert.deepEqual(extraSavedBody.inputs,retainedHiddenInputs);assert.deepEqual(copy(entry.inputs),retainedHiddenInputs);
  assert.deepEqual(JSON.parse(entry.saved),retainedHiddenInputs);assert.equal(audit.dirty(entry),false);passed++;

  // The board schedule shows authoritative product totals instead of six detached metrics, with incomplete rows explicit.
  entry=setup();entry.definition.sheets[0].max_column=35;
  const boardTotals=[{product:'COREX',box_reference_area:12.34567,net_board_area:21.014,whole_sheets:11,incomplete_rows:5,incomplete_extra_rows:1},
    {product:'P250',box_reference_area:0,net_board_area:null,whole_sheets:null,incomplete_rows:0,incomplete_extra_rows:2}];
  entry.result=result({}, {max_column:35,board_product_totals:boardTotals,rows:[{row:1,cells:[{column:1,address:'A1',value:'Board calculator',presentation:{role:'title'}}]},
    {row:4,cells:[1,3,5,7,9,11,25,27,29,31,33,35].map(column=>({column,address:`${column<=26?String.fromCharCode(64+column):'A'+String.fromCharCode(64+column-26)}4`,value:column%4===1?'Old metric label':100}))},
    {row:6,cells:[{column:25,address:'Y6',value:'Incomplete order: 9 rows have no board quantity.',calculated:true,presentation:{role:'note'}}]},
    {row:9,cells:[{column:1,address:'A9',value:'Member',editable:true,type:'text'}]}]});
  const boardRaw=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  assert.equal(descendants(byId('calculator-grid')).filter(node=>node.calculatorValueCard).length,0);
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.textContent==='Old metric label'));
  assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='Y6'&&node.textContent.includes('9 rows have no board quantity')));
  assert.ok(entry.productTotalsElement);const boardTotalNodes=descendants(entry.productTotalsElement);
  assert.ok(byId('calculator-grid').children.includes(entry.productTotalsElement));
  const boardOverview=byId('calculator-grid').children.find(node=>node.className==='calculator-overview');
  assert.equal(boardOverview.classList.contains('calculator-overview-full'),true);assert.ok(!descendants(boardOverview).includes(entry.productTotalsElement));
  assert.ok(boardTotalNodes.some(node=>node.textContent==='CALCULATED SUMMARY'));
  const boardGridChildren=byId('calculator-grid').children,boardOverviewIndex=boardGridChildren.indexOf(boardOverview);
  assert.ok(boardGridChildren.indexOf(entry.productTotalsElement)<boardOverviewIndex);
  assert.ok(descendants(boardGridChildren[boardOverviewIndex+1]).some(node=>node.dataset?.calculatorCell==='A9'));
  for(const address of ['A1','Y6'])assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>node.dataset.calculatorOutput===address).length,1);
  assert.ok(boardTotalNodes.some(node=>node.textContent==='Box reference area (m²)'));
  assert.ok(boardTotalNodes.some(node=>node.textContent==='12.35'));assert.ok(boardTotalNodes.some(node=>node.textContent==='21.01'));
  assert.ok(boardTotalNodes.some(node=>/5.00 incomplete schedule rows; 1.00 incomplete additional-board rows/.test(node.textContent||'')));
  const boardTable=boardTotalNodes.find(node=>node.tagName==='table'),incompleteProduct=boardTable.children[1].children[1];
  assert.equal(incompleteProduct.children[1].classList.contains('calculator-value-present'),true);
  assert.equal(incompleteProduct.children[2].classList.contains('calculator-value-empty'),true);assert.equal(incompleteProduct.children[3].textContent,'');
  assert.equal(JSON.stringify(entry.result),boardRaw);
  const updatedBoard=copy(entry.result);updatedBoard.board_product_totals[0].net_board_area=99.9999;updatedBoard.board_product_totals[0].incomplete_rows=0;updatedBoard.board_product_totals[0].incomplete_extra_rows=0;updatedBoard.rows.find(row=>row.row===6).cells[0].value='Incomplete order: 3 rows have no board quantity.';
  const retainedMember=renderedControls()[0];audit.setRequest(async()=>updatedBoard);await audit.calculate();
  assert.equal(renderedControls()[0],retainedMember);assert.ok(descendants(entry.productTotalsElement).some(node=>node.textContent==='100.00'));assert.ok(descendants(entry.productTotalsElement).some(node=>node.textContent==='No incomplete rows'));passed++;
  assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='Y6'&&node.textContent.includes('3 rows have no board quantity')));

  // Duct output reordering moves the two requested results without losing prepared rows, controls or omitted columns.
  entry=setup({CALCULATOR:{D11:2.3456789}});entry.definition.id='ductwork';
  entry.definition.schedule={sheet:'CALCULATOR',first_row:11,last_row:310,header_row:10,columns:[{column:'B',label:'Width'},{column:'C',label:'Height'},{column:'D',label:'Length'}]};
  const ductColumns=[2,3,4,36,37,38,39,40,41,42,43],columnOrder=[2,3,4,36,40,41,37,38,39,42,43];
  const ductColumnName=column=>column<=26?String.fromCharCode(64+column):'A'+String.fromCharCode(64+column-26);
  const ductLabels={2:'Width',3:'Height',4:'Length',36:'Combined angle length',37:'Hidden clearance',38:'Hidden fixing',39:'Support guide',40:'Spray body volume',41:'Working yield',42:'Qualifications',43:'Sources'};
  entry.definition.sheets=[{name:'CALCULATOR',header_rows:[10],display_column_order:columnOrder,omitted_columns:[37,38],merges:[]}];
  const reorderedRows=[{row:10,cells:ductColumns.map(column=>({column,address:`${ductColumnName(column)}10`,value:ductLabels[column]}))},
    ...Array.from({length:300},(_,i)=>({row:i+11,cells:ductColumns.map(column=>({column,address:`${ductColumnName(column)}${i+11}`,value:column===4&&i===0?2.3456789:column<=4?null:column,editable:column<=4,type:'number',calculated:column>4}))}))];
  entry.result=result(copy(entry.inputs),{max_row:310,max_column:43,visible_columns:ductColumns,rows:reorderedRows});
  const reorderedSource=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  let ductTable=renderedTable(),firstDuctRow=ductTable.children.at(-1).children[0];
  assert.deepEqual(ductTable.children[1].children[0].children.map(node=>node.textContent),[2,3,4,36,40,41,39,42,43].map(column=>ductLabels[column]));
  assert.deepEqual(firstDuctRow.children.slice(3).map(node=>node.dataset.calculatorOutput),['AJ11','AN11','AO11','AM11','AP11','AQ11']);
  assert.equal(ductTable.children.at(-1).children.length,300);assert.equal(renderedControls().length,900);
  assert.ok(!byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>/^A[KL]/.test(node.dataset.calculatorOutput)));
  assert.equal(JSON.stringify(entry.result),reorderedSource);assert.equal(entry.inputs.CALCULATOR.D11,2.3456789);
  const retainedDuctLength=renderedControls().find(node=>node.dataset.calculatorCell==='D11'),changedDuct=copy(entry.result);
  changedDuct.rows.find(row=>row.row===11).cells.find(cell=>cell.column===40).value=0.123456;
  audit.setRequest(async()=>changedDuct);await audit.calculate();assert.equal(renderedControls().find(node=>node.dataset.calculatorCell==='D11'),retainedDuctLength);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='AN11').textContent,'0.12');
  changedDuct.display_column_order=['B','C','D','AJ','AO','AN','AN','ZZ'];await audit.calculate();ductTable=renderedTable();
  assert.deepEqual(ductTable.children[1].children[0].children.map(node=>node.textContent),[2,3,4,36,41,40,39,42,43].map(column=>ductLabels[column]));assert.equal(renderedControls().length,900);passed++;

  // Browser text overrides cover headers and contents, while omitted titles,
  // raw data and output-state classification stay unchanged.
  entry=setup();entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  entry.definition.sheets=[{name:entry.sheet,header_rows:[5],section_cells:['A6'],omitted_rows:[3],display_text:{A1:'Ductwork Settings',A3:'Still omitted',A5:'Option',A6:'Product rules'},merges:['A1:C1']}];
  entry.result=result({}, {sheet:entry.sheet,rows:[
    {row:1,cells:[{column:1,address:'A1',value:'Original source title',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Original omitted note'}]},
    {row:5,cells:[{column:1,address:'A5',value:'Original header'}]},
    {row:6,cells:[{column:1,address:'A6',value:'Original section',presentation:{role:'section'}}]},
    {row:7,cells:[{column:1,address:'A7',value:'Editable setting',presentation:{role:'label'}},{column:2,address:'B7',value:0.005,editable:true,type:'number'},{column:3,address:'C7',value:'Calculated note',calculated:true}]},
  ]});
  const textSource=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  let overrideNodes=descendants(byId('calculator-grid'));
  assert.ok(!overrideNodes.some(node=>node.textContent==='Ductwork Settings'));assert.ok(overrideNodes.some(node=>node.href&&node.textContent==='Product rules'));
  assert.ok(overrideNodes.some(node=>node.dataset?.calculatorOutput==='A5'&&node.textContent==='Option'));assert.ok(!overrideNodes.some(node=>node.dataset?.calculatorOutput==='A3'));
  assert.equal(JSON.stringify(entry.result),textSource);
  const revisedText=copy(entry.result);revisedText.display_text={A1:'Updated Ductwork Settings',A5:'Updated option',A6:'Updated product rules',C7:'Display-only note'};
  audit.setRequest(async()=>revisedText);await audit.calculate();overrideNodes=descendants(byId('calculator-grid'));
  assert.ok(!overrideNodes.some(node=>node.textContent==='Updated Ductwork Settings'));assert.ok(overrideNodes.some(node=>node.href&&node.textContent==='Updated product rules'));
  assert.ok(overrideNodes.some(node=>node.dataset?.calculatorOutput==='A5'&&node.textContent==='Updated option'));
  const overriddenOutput=overrideNodes.find(node=>node.dataset?.calculatorOutput==='C7');assert.equal(overriddenOutput.textContent,'Display-only note');assert.equal(overriddenOutput.classList.contains('calculator-value-present'),true);
  const textControl=renderedControls()[0];revisedText.rows.find(row=>row.row===7).cells[2].value='Updated raw note';await audit.calculate();
  assert.equal(renderedControls()[0],textControl);assert.equal(overriddenOutput.textContent,'Display-only note');assert.equal(entry.result.rows.find(row=>row.row===7).cells[2].value,'Updated raw note');passed++;

  // Browser-only heading changes leave the workbook sheet names and raw values untouched.
  for(const [calculator,sheet,source,shown] of [
    ['steel_vermiculite','CALCULATOR','QUICK CALCULATOR',null],
    ['steel_board','START','CEASEFIRE / STRUCTURAL STEEL BOARD ESTIMATOR',null],
    ['steel_board','BOARD SUMMARY','BOARD SUMMARY','SUMMARY'],
  ]) {
    entry=setup();entry.definition.id=calculator;entry.sheet=sheet;entry.definition.sheets=[{name:sheet,header_rows:[],merges:[]}];
    entry.result=result({}, {sheet,rows:[{row:1,cells:[{column:1,address:'A1',value:source,presentation:{role:'title'}}]}]});
    const headingSource=JSON.stringify(entry.result);realRender(entry);const labels=descendants(byId('calculator-grid')).map(node=>node.textContent);
    if(shown===null)assert.ok(!labels.includes(source));else assert.ok(labels.includes(shown));
    assert.equal(JSON.stringify(entry.result),headingSource);assert.equal(entry.sheet,sheet);
  }passed++;

  // Exact board introductory omissions remove INPUTS/RESULTS wording while keeping the live global warning and all inputs.
  entry=setup();entry.definition.sheets[0]={name:'CALCULATOR',header_rows:[8],omitted_rows:[2,5,7],omitted_ranges:['Y1:AI1','A6:L6'],display_text:{A1:'STRUCTURAL STEEL BOARD SCHEDULE'},merges:[]};
  entry.result=result({}, {max_column:35,board_product_totals:[{product:'COREX',box_reference_area:0,net_board_area:0,whole_sheets:0,incomplete_rows:1,incomplete_extra_rows:0}],rows:[
    {row:1,cells:[{column:1,address:'A1',value:'CEASEFIRE / STRUCTURAL STEEL BOARD SCHEDULE',presentation:{role:'title'}},{column:25,address:'Y1',value:'Removed version label'}]},
    ...[2,5,7].map(row=>({row,cells:[{column:1,address:`A${row}`,value:row===7?'INPUTS':'Removed input direction'},{column:25,address:`Y${row}`,value:row===7?'RESULTS':'Removed result direction'}]})),
    {row:6,cells:[{column:1,address:'A6',value:'Removed page direction'},{column:25,address:'Y6',value:'Incomplete order: 1 row has no board quantity.',calculated:true,presentation:{role:'note'}}]},
    {row:9,cells:[{column:1,address:'A9',value:'Keep this member',editable:true,type:'text'}]},
  ]});
  const introRaw=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);let introNodes=descendants(byId('calculator-grid'));
  assert.ok(introNodes.some(node=>node.textContent==='STRUCTURAL STEEL BOARD SCHEDULE'));assert.ok(!introNodes.some(node=>/^Removed|^(INPUTS|RESULTS)$/.test(node.textContent||'')));
  const preservedWarning=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='Y6');assert.ok(preservedWarning);assert.equal(renderedControls().length,1);assert.equal(JSON.stringify(entry.result),introRaw);
  const introUpdate=copy(entry.result);introUpdate.rows.find(row=>row.row===6).cells[1].value='Incomplete order: 2 rows have no board quantity.';audit.setRequest(async()=>introUpdate);await audit.calculate();
  assert.equal(preservedWarning.textContent,'Incomplete order: 2 rows have no board quantity.');passed++;

  // Projected vermiculite forms retain every input while hiding only the requested period columns and citation.
  entry=setup({CALCULATOR:{D6:12.3456789}});entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  const vermProjections=[
    {first_row:5,last_row:24,columns:[1,2,3,4,5,6],column_widths:Array(6).fill(1),width_mode:'fit',table_kind:'form',title_address:'A5',label:'Inputs'},
    {first_row:5,last_row:24,columns:[8,9,10,11,12,13,14],column_widths:Array(7).fill(1),width_mode:'fit',table_kind:'form',title_address:'H5',label:'Thickness and quantities'},
    {first_row:26,last_row:30,columns:[1,3,5,6,7,8,9],column_widths:[100,...Array(6).fill(88)],table_kind:'comparison',title_address:'A26',header_row:28,label:'Published periods'},
  ];
  entry.definition.sheets=[{name:'CALCULATOR',table_layout:'projected',navigation_mode:'hidden',presentation_tables:vermProjections,header_rows:[28],section_cells:['A5','H5','A26'],display_cells:Object.fromEntries([28,29,30].flatMap(row=>[...'ABCDEFGHI'].map(column=>[`${column}${row}`,{align:'center'}]))),omitted_ranges:['J28:N30','B28:B30','D28:D30','H23:N24'],merges:['A1:N1','A5:F5','H5:N5','H10:J10','H20:N20','H23:N24','A26:N26','J28:N30']}];
  const vermRows=new Map(),pushVerm=(row,cell)=>{if(!vermRows.has(row))vermRows.set(row,{row,cells:[]});vermRows.get(row).cells.push(cell);};
  for(const [row,column,value] of [[1,1,'Vermiculite calculator'],[3,1,'Source introduction'],[5,1,'01 INPUTS'],[5,8,'02 OUTPUTS'],[13,7,'Keep the unprojected note'],[20,1,'Input note'],[25,1,'Between the forms and periods'],[26,1,'03 PUBLISHED PERIODS'],[28,10,'Omitted matrix narrative']])pushVerm(row,{column,address:`${String.fromCharCode(64+column)}${row}`,value,presentation:{role:[1,5,26].includes(row)?'section':'note'}});
  for(const row of [6,7,8,9,10,11,12,14,15,16,17])pushVerm(row,{column:4,address:`D${row}`,value:row===6?12.3456789:row,editable:true,type:'number'});
  for(let row=6;row<=23;row++)pushVerm(row,{column:8,address:`H${row}`,value:row===10?'Lookup ESA/M':row===20?'Full-width source subheading':row===23?'C300-2021 p4':row+0.123456,calculated:![10,20].includes(row),presentation:{role:[10,20].includes(row)?'section':'output'}});
  for(let row=28;row<=30;row++)for(let column=1;column<=9;column++)pushVerm(row,{column,address:`${String.fromCharCode(64+column)}${row}`,value:row===28?`Period ${column}`:row*column,calculated:row!==28});
  vermRows.set(27,{row:27,cells:[]});
  entry.result=result(copy(entry.inputs),{max_column:14,rows:[...vermRows.values()].sort((a,b)=>a.row-b.row)});const vermRaw=JSON.stringify(entry.result);
  realRender(entry);audit.setRender(realRender);
  const vermSections=descendants(byId('calculator-grid')).filter(node=>node.className==='calculator-projected-section');
  assert.equal(vermSections.length,3);assert.deepEqual(vermSections.map(node=>node.children[0].dataset.calculatorOutput),['A5','H5','A26']);
  assert.equal(renderedControls().length,11);assert.equal(new Set(renderedControls().map(node=>node.dataset.calculatorCell)).size,11);
  for(const section of vermSections){assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>node.dataset.calculatorOutput===section.children[0].dataset.calculatorOutput).length,1);assert.equal(descendants(byId('calculator-grid')).filter(node=>node.href===`#${section.children[0].id}`).length,0);assert.equal(section.children[0].dataset.calculatorValue,undefined);}
  assert.ok(descendants(vermSections[0]).find(node=>node.tagName==='table').className.includes('calculator-responsive-form'));
  const periodTable=descendants(vermSections[2]).find(node=>node.tagName==='table');assert.equal(periodTable.children[0].children.length,7);assert.ok(periodTable.children[0].children.slice(1).every(col=>col.style.width==='88px'));assert.equal(periodTable.children.at(-1).children[0].children[0].tagName,'th');assert.equal(periodTable.children.at(-1).children[0].dataset.sourceRow,'28');
  for(const periodRow of periodTable.children.at(-1).children)for(const cell of periodRow.children){assert.equal(cell.classList.contains('calculator-align-center'),true);assert.equal(cell.tagName,periodRow.dataset.sourceRow==='28'?'th':'td');}
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='H6').classList.contains('calculator-align-center'),true);
  assert.ok(!byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='J28'));assert.equal(JSON.stringify(entry.result),vermRaw);
  const orderedVermOutputs=byId('calculator-grid').querySelectorAll('[data-calculator-output]').map(node=>node.dataset.calculatorOutput);
  for(const row of [28,29,30]){assert.deepEqual(periodTable.children.at(-1).children.find(node=>node.dataset.sourceRow===String(row)).children.map(node=>node.dataset.calculatorOutput),[...'ACEFGHI'].map(column=>`${column}${row}`));for(const column of ['B','D'])assert.ok(!orderedVermOutputs.includes(`${column}${row}`));}
  assert.ok(!orderedVermOutputs.includes('H23'));assert.ok(!descendants(byId('calculator-grid')).some(node=>node.textContent==='C300-2021 p4'));
  const fieldLabel=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='H10');assert.match(fieldLabel.className,/calculator-role-label/);
  const formSubheading=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='H20');assert.match(formSubheading.className,/calculator-role-section/);assert.equal(formSubheading.dataset.calculatorValue,undefined);
  assert.ok(orderedVermOutputs.indexOf('H5')<orderedVermOutputs.indexOf('G13'));assert.ok(orderedVermOutputs.indexOf('G13')<orderedVermOutputs.indexOf('A25'));assert.ok(orderedVermOutputs.indexOf('A25')<orderedVermOutputs.indexOf('A26'));
  const retainedVermInput=renderedControls()[0],vermUpdate=copy(entry.result);vermUpdate.rows.find(row=>row.row===6).cells.find(cell=>cell.column===8).value=0.987654;audit.setRequest(async()=>vermUpdate);await audit.calculate();
  assert.equal(renderedControls()[0],retainedVermInput);assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='H6').textContent,'0.99');
  vermUpdate.rows.find(row=>row.row===5).cells.find(cell=>cell.column===1).value='Updated input section';await audit.calculate();assert.ok(descendants(byId('calculator-grid')).some(node=>node.dataset?.calculatorOutput==='A5'&&node.textContent==='Updated input section'));assert.equal(entry.inputs.CALCULATOR.D6,12.3456789);passed++;

  // A presentation row can swap the published caption/value while retaining source IDs, vertical merges and controls.
  entry=setup();entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  const publishedLayout={first_row:5,last_row:9,columns:[8,9,10,11,12,13,14],column_widths:Array(7).fill(1),title_address:'H5',table_kind:'comparison',label:'Thickness and quantities',row_layouts:{6:[{address:'L6',span:3},{address:'H6',span:4}],9:[{address:'H9',span:7}]}};
  entry.definition.sheets=[{name:'CALCULATOR',table_layout:'projected',presentation_tables:[publishedLayout],header_rows:[],display_text:{L6:'PUBLISHED VALUE'},display_cells:{H6:{align:'left',suffix:' mm',highlight:'published-thickness'},H9:{bold:false}},merges:['H5:N5','H6:K8','L6:N8','H9:J9','K9:N9']}];
  entry.result=result({}, {max_column:14,rows:[
    {row:5,cells:[{column:8,address:'H5',value:'Thickness and quantities',presentation:{role:'section'}}]},
    {row:6,cells:[{column:4,address:'D6',value:12.3456789,editable:true,type:'number',label:'Member length'},{column:8,address:'H6',value:26,calculated:true},{column:12,address:'L6',value:'mm / PUBLISHED VALUE',presentation:{role:'note'}}]},
    {row:7,cells:[]},{row:8,cells:[]},
    {row:9,cells:[{column:8,address:'H9',value:'Reference quantity',presentation:{role:'label',bold:true}},{column:11,address:'K9',value:0.123456789,editable:true,type:'number',label:'Reference quantity'}]},
  ]});
  const rawPublishedLayout=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  const publishedTable=descendants(byId('calculator-grid')).find(node=>node.tagName==='table'&&node.getAttribute('aria-label')==='Thickness and quantities');
  const publishedRow=publishedTable.children.at(-1).children.find(node=>node.dataset.sourceRow==='6');
  assert.deepEqual(publishedRow.children.map(cell=>cell.dataset.calculatorOutput),['L6','H6']);assert.deepEqual(publishedRow.children.map(cell=>cell.colSpan),[3,4]);assert.deepEqual(publishedRow.children.map(cell=>cell.rowSpan),[3,3]);
  assert.equal(publishedRow.children[0].textContent,'PUBLISHED VALUE');assert.equal(publishedRow.children[1].textContent,'26.00 mm');assert.equal(publishedRow.children[1].classList.contains('calculator-align-center'),true);
  const belowPublishedRow=publishedTable.children.at(-1).children.find(node=>node.dataset.sourceRow==='9');assert.equal(belowPublishedRow.children.length,2);assert.deepEqual(belowPublishedRow.children.map(cell=>cell.colSpan),[3,4]);
  assert.equal(belowPublishedRow.children[0].classList.contains('calculator-normal'),true);assert.equal(belowPublishedRow.children[0].classList.contains('calculator-bold'),false);
  assert.deepEqual(renderedControls().map(control=>control.dataset.calculatorCell).sort(),['D6','K9']);
  const referenceControl=renderedControls().find(control=>control.dataset.calculatorCell==='K9');assert.equal(referenceControl.getAttribute('aria-label'),'Reference quantity');
  assert.equal(JSON.stringify(entry.result),rawPublishedLayout);
  const updatedPublishedLayout=copy(entry.result);updatedPublishedLayout.rows.find(row=>row.row===6).cells.find(cell=>cell.address==='H6').value=27.123456789;audit.setRequest(async()=>updatedPublishedLayout);await audit.calculate();
  assert.equal(renderedControls().find(control=>control.dataset.calculatorCell==='K9'),referenceControl);assert.equal(publishedRow.children[1].textContent,'27.12 mm');assert.equal(publishedRow.children[1].dataset.calculatorOutput,'H6');assert.equal(publishedRow.children[1].rowSpan,3);
  assert.ok(publishedRow.children[1].classList.contains('calculator-published-thickness'));
  for(const [value,error] of [[null,false],['',false],['HOLD',false],[NaN,false],[Infinity,false],[26,true]]){audit.updateOutputCell(publishedRow.children[1],{address:'H6',value,error});assert.ok(!publishedRow.children[1].textContent.endsWith(' mm'));assert.equal(publishedRow.children[1].classList.contains('calculator-published-thickness'),false);}
  audit.updateOutputCell(publishedRow.children[1],{address:'H6',value:0});assert.ok(publishedRow.children[1].classList.contains('calculator-published-thickness'));assert.ok(publishedRow.children[1].classList.contains('calculator-value-present'));
  assert.match(fs.readFileSync('static/calculators.css','utf8'),/\.calculator-value-present\.calculator-published-thickness\{background:#dceeff!important\}/);
  assert.equal(entry.result.rows.find(row=>row.row===6).cells.find(cell=>cell.address==='H6').value,27.123456789);passed++;

  // Collapsing a blank factor-helper row leaves its neighbouring merged source note and later inputs intact.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';
  entry.definition.sheets=[{name:'SETTINGS',header_rows:[],display_cells:{A371:{merge:'A371:G371',role:'collapsed_spacer'}},merges:['H371:N374',...[372,373,374].flatMap(row=>[`A${row}:C${row}`,`D${row}:G${row}`])]}];
  entry.result=result({}, {sheet:'SETTINGS',max_column:14,rows:[{row:371,cells:[{column:1,address:'A371',value:null},{column:8,address:'H371',value:'Retained section-factor qualification',presentation:{role:'note'}}]},
    ...[372,373,374].map(row=>({row,cells:[{column:1,address:`A${row}`,value:'Section-factor input',presentation:{role:'label'}},{column:4,address:`D${row}`,value:12.3456789,editable:row===373,type:'number'}]}))]});
  const rawFactorRows=JSON.stringify(entry.result);realRender(entry);
  const collapsedRow=descendants(byId('calculator-grid')).find(node=>node.dataset?.sourceRow==='371');assert.equal(collapsedRow.children.length,2);
  assert.match(collapsedRow.children[0].className,/calculator-role-collapsed_spacer/);assert.equal(collapsedRow.children[0].colSpan,7);assert.equal(collapsedRow.children[0].dataset.calculatorValue,undefined);assert.equal(collapsedRow.children[0].classList.contains('calculator-value-empty'),false);
  assert.equal(collapsedRow.children[1].dataset.calculatorOutput,'H371');assert.equal(collapsedRow.children[1].colSpan,7);assert.equal(collapsedRow.children[1].rowSpan,4);assert.equal(collapsedRow.children[1].textContent,'Retained section-factor qualification');
  assert.deepEqual(renderedControls().map(control=>control.dataset.calculatorCell),['D373']);assert.equal(JSON.stringify(entry.result),rawFactorRows);passed++;

  // BAGS extends the first source note over its decorative gap, preserving both notes and the exact yield.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='BAGS';
  entry.definition.sheets=[{name:'BAGS',table_layout:'projected',navigation_mode:'hidden',display_table_order:[1,0],header_rows:[19],section_cells:['A17'],display_cells:{H6:{merge:'H6:N10'},...Object.fromEntries([20,21,22,23,24].map(row=>[`A${row}`,{bold:true}]))},merges:['A1:N1','A3:N3','A17:N17','H6:N9','H11:N15',...[6,7,8,9,10,11,12,13,14].flatMap(row=>[`A${row}:C${row}`,`D${row}:F${row}`])],presentation_tables:[
    {first_row:1,last_row:15,columns:[1,2,3,4,5,6,8,9,10,11,12,13,14],column_widths:Array(13).fill(1),width_mode:'fit',table_kind:'form',title_address:'A1',subtitle_address:'A3',label:'Manual quantity'},
    {first_row:17,last_row:24,columns:Array.from({length:9},(_,i)=>i+1),column_widths:[19,7,9,10,8,7,11,9,20],width_mode:'fit',table_kind:'order',title_address:'A17',header_row:19,label:'Product order summary'},
  ]}];
  entry.result=result({}, {sheet:'BAGS',max_column:14,rows:[{row:1,cells:[{column:1,address:'A1',value:'BAGS',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Manual quantities stay separate from schedule orders.',presentation:{role:'note'}}]},
    ...[6,7,8].map(row=>({row,cells:[{column:1,address:`A${row}`,value:'Manual input',presentation:{role:'label'}},{column:4,address:`D${row}`,value:row,editable:true,type:'number'},...(row===6?[{column:8,address:'H6',value:'Enter the spray area and established thickness.',presentation:{role:'note'}}]:[])]})),
    {row:9,cells:[{column:1,address:'A9',value:'Coating volume'},{column:4,address:'D9',value:0.6,calculated:true}]},
    {row:10,cells:[{column:1,address:'A10',value:'Working yield',presentation:{role:'label'}},{column:4,address:'D10',value:0.05128205128205128,calculated:true},...Array.from({length:8},(_,index)=>({column:index+7,address:`${String.fromCharCode(71+index)}10`,value:null,presentation:{role:'body'}}))]},
    {row:11,cells:[{column:1,address:'A11',value:'Waste'},{column:4,address:'D11',value:0},{column:8,address:'H11',value:'Verify the selected product yield.',presentation:{role:'note'}}]},
    ...[12,13,14].map(row=>({row,cells:[{column:1,address:`A${row}`,value:'Quantity'},{column:4,address:`D${row}`,value:12,calculated:true}]})),
    {row:15,cells:[{column:1,address:'A15',value:'Manual quantity note',presentation:{role:'note'}}]},
    {row:17,cells:[{column:1,address:'A17',value:'PRODUCT ORDER SUMMARY',presentation:{role:'section'}}]},{row:18,cells:[]},
    ...[19,20,21,22,23,24].map(row=>({row,cells:Array.from({length:9},(_,i)=>({column:i+1,address:`${String.fromCharCode(65+i)}${row}`,value:row===19?`Header ${i+1}`:i===8?'Order status':row,calculated:row>19}))})),
  ]});const rawBagCells=JSON.stringify(entry.result);realRender(entry);
  assert.equal(renderedControls().length,3);const projectedOrder=descendants(byId('calculator-grid')).find(node=>node.className==='calculator-projected-section');assert.equal(projectedOrder.children[0].textContent,'PRODUCT ORDER SUMMARY');
  const projectedOrderTable=descendants(projectedOrder).find(node=>node.tagName==='table');assert.equal(projectedOrderTable.style.width,'100%');assert.equal(projectedOrderTable.children.at(-1).children.length,6);assert.equal(projectedOrderTable.children[0].children[8].style.width,'20%');
  const manualTable=descendants(byId('calculator-grid')).find(node=>node.tagName==='table'&&node.getAttribute('aria-label')==='Manual quantity');assert.ok(manualTable.children.at(-1).children[0].children.every(node=>node.tagName==='td'));
  assert.ok(descendants(byId('calculator-grid')).indexOf(projectedOrderTable)<descendants(byId('calculator-grid')).indexOf(manualTable));assert.match(projectedOrder.children[0].id,/-1$/);
  const manualSection=byId('calculator-grid').children.find(node=>node.className==='calculator-projected-section'&&descendants(node).includes(manualTable));
  assert.deepEqual(manualSection.children.slice(0,2).map(node=>node.dataset.calculatorOutput),['A1','A3']);assert.equal(manualSection.children[1].tagName,'p');assert.match(manualSection.children[0].id,/-0$/);
  for(const address of ['A1','A3'])assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>node.dataset.calculatorOutput===address).length,1);
  assert.ok(!descendants(manualTable).some(node=>['A1','A3'].includes(node.dataset?.calculatorOutput)));
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.className==='calculator-contents'));
  for(const row of [20,21,22,23,24])assert.ok(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput===`A${row}`).classList.contains('calculator-bold'));
  const yieldRow=manualTable.children.at(-1).children.find(node=>node.dataset.sourceRow==='10');
  assert.deepEqual(yieldRow.children.map(node=>node.dataset.calculatorOutput),['A10','D10']);assert.deepEqual(yieldRow.children.map(node=>node.colSpan),[3,3]);
  const bagNotes=byId('calculator-grid').querySelectorAll('[data-calculator-output]').filter(node=>['H6','H11'].includes(node.dataset.calculatorOutput));
  assert.equal(bagNotes.length,2);assert.deepEqual(bagNotes.map(node=>node.rowSpan),[5,5]);assert.ok(bagNotes.every(node=>node.colSpan===7&&/calculator-role-note/.test(node.className)));
  assert.deepEqual(bagNotes.map(node=>node.textContent),['Enter the spray area and established thickness.','Verify the selected product yield.']);
  assert.ok(!byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='H10'));
  assert.equal(manualTable.children[0].children.length,13);assert.ok(manualTable.children[0].children.every(column=>column.style.width===manualTable.children[0].children[0].style.width));
  assert.ok(!byId('calculator-grid').querySelectorAll('[data-calculator-output]').some(node=>node.dataset.calculatorOutput==='G10'));
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='G20').textContent,'20.00');
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='D10').textContent,'0.05');
  assert.equal(entry.result.rows.find(row=>row.row===10).cells.find(cell=>cell.address==='D10').value,0.05128205128205128);
  assert.equal(JSON.stringify(entry.result),rawBagCells);
  for(const table of [manualTable,projectedOrderTable])assert.ok(descendants(byId('calculator-grid')).some(node=>node.classList?.contains('calculator-section-scroll')&&node.children.includes(table)));
  entry.result.rows.find(row=>row.row===18).cells.push({column:2,address:'B18',value:null,calculated:true});realRender(entry);
  const preservedBlankFormula=byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='B18');assert.ok(preservedBlankFormula);assert.equal(preservedBlankFormula.classList.contains('calculator-value-empty'),true);passed++;

  // Duct projections omit USE NOTES while retaining side-table references, uncovered controls and blank separator rows.
  entry=setup();entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  const blankDuctRows=[105,108,111,131,136];
  entry.definition.sheets=[{name:entry.sheet,table_layout:'projected',header_rows:[95,116,117,123,136],section_cells:['A6','A48','A94','J94','J115','A153'],omitted_rows:[153,154,155,156,157,158,159],display_cells:Object.fromEntries(blankDuctRows.map(row=>[`J${row}`,{merge:`J${row}:Q${row}`}])),merges:['A94:H94','J94:Q94','J115:Q115'],presentation_tables:[
    {first_row:94,last_row:151,columns:[1,2,3,4,5,6,7,8],column_widths:Array(8).fill(1),width_mode:'fit',table_kind:'form',title_address:'A94',label:'FyreWrap settings'},
    {first_row:94,last_row:113,columns:[10,11,12,13,14,15,16,17],column_widths:Array(8).fill(100),table_kind:'comparison',title_address:'J94',header_row:95,label:'Application'},
    {first_row:115,last_row:149,columns:[10,11,12,13,14,15,16,17],column_widths:Array(8).fill(1),width_mode:'fit',table_kind:'comparison',title_address:'J115',header_row:116,label:'Penetration'},
  ]}];
  entry.result=result({}, {sheet:entry.sheet,max_column:17,rows:[
    ...[[6,1,'CAFCO'],[48,1,'MONOKOTE'],[94,1,'FYREWRAP'],[94,10,'APPLICATION'],[115,10,'PENETRATION'],[153,1,'USE NOTES']].map(([row,column,value])=>({row,cells:[{column,address:`${String.fromCharCode(64+column)}${row}`,value,presentation:{role:'section'}}]})),
    ...[[8,2,25],[65,2,1],[97,2,0.61],[100,2,0.005],[150,17,0.123456]].map(([row,column,value])=>({row,cells:[{column,address:`${String.fromCharCode(64+column)}${row}`,value,editable:true,type:'number'}]})),
    {row:95,cells:[{column:10,address:'J95',value:'Application header'}]},{row:96,cells:[{column:10,address:'J96',value:'Duct application'}]},
    {row:114,cells:[{column:10,address:'J114',value:'Uncovered source note',presentation:{role:'note'}}]},
    {row:116,cells:[{column:10,address:'J116',value:'Penetration header'}]},
    {row:117,cells:[{column:1,address:'A117',value:'Left-hand section header',presentation:{role:'column_header'}},{column:10,address:'J117',value:'Wall board collars',presentation:{role:'column_header'}}]},
    {row:123,cells:[{column:10,address:'J123',value:'Cut strips per collar',presentation:{role:'column_header'}}]},
    {row:137,cells:[{column:10,address:'J137',value:'Dropdown source value'},{column:11,address:'K137',value:'Dropdown explanation',presentation:{role:'note'}}]},
    {row:149,cells:[{column:10,address:'J149',value:'Last dropdown choice'}]},
    ...blankDuctRows.map(row=>({row,cells:[...Array.from({length:8},(_,index)=>({column:index+1,address:`${String.fromCharCode(65+index)}${row}`,value:`Main setting ${row}/${index+1}`})),...Array.from({length:8},(_,index)=>({column:index+10,address:`${String.fromCharCode(74+index)}${row}`,value:null,presentation:{role:'body'}}))]})),
    ...[154,155,156,157,158,159].map(row=>({row,cells:[{column:1,address:`A${row}`,value:`Omitted use note ${row}`,presentation:{role:'note'}}]})),
  ].reduce((rows,row)=>{const existing=rows.find(other=>other.row===row.row);if(existing)existing.cells.push(...row.cells);else rows.push(row);return rows;},[]).sort((a,b)=>a.row-b.row)});
  const ductProjectionRaw=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  assert.equal(renderedControls().length,5);assert.equal(new Set(renderedControls().map(node=>node.dataset.calculatorCell)).size,5);
  const ductAddresses=byId('calculator-grid').querySelectorAll('[data-calculator-output]').map(node=>node.dataset.calculatorOutput);
  for(const address of ['A6','A48','A94','J94','J115','J137','K137','J149','J114'])assert.equal(ductAddresses.filter(value=>value===address).length,1,address);
  assert.ok(ductAddresses.indexOf('A48')<ductAddresses.indexOf('A94'));assert.ok(ductAddresses.indexOf('J94')<ductAddresses.indexOf('J115'));assert.ok(ductAddresses.indexOf('J115')<ductAddresses.indexOf('J149'));
  for(const row of [153,154,155,156,157,158,159])assert.ok(!ductAddresses.includes(`A${row}`));
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.href?.endsWith('-A153')||node.textContent==='USE NOTES'));
  for(const row of blankDuctRows) {
    const sectionTable=descendants(byId('calculator-grid')).find(node=>node.tagName==='table'&&node.getAttribute('aria-label')===(row<115?'Application':'Penetration'));
    const separator=sectionTable.children.at(-1).children.find(node=>node.dataset.sourceRow===String(row));
    assert.equal(separator.children.length,1);assert.equal(separator.children[0].colSpan,8);
    assert.equal(separator.children[0].dataset.calculatorOutput,`J${row}`);assert.equal(separator.children[0].classList.contains('calculator-value-empty'),true);
    assert.equal(separator.children[0].tagName,'td');assert.equal(separator.children[0].classList.contains('calculator-source-heading'),false);
    for(const column of ['A','B','C','D','E','F','G','H'])assert.equal(ductAddresses.filter(value=>value===`${column}${row}`).length,1);
  }
  assert.ok(descendants(byId('calculator-grid')).filter(node=>node.className?.includes('calculator-table-scroll')).every(node=>node.classList.contains('calculator-section-scroll')));
  assert.equal(JSON.stringify(entry.result),ductProjectionRaw);const retainedRoll=renderedControls().find(node=>node.dataset.calculatorCell==='B97');await retainedRoll.emit('focus');assert.equal(retainedRoll.value,'0.61');
  const preciseOverlap=renderedControls().find(node=>node.dataset.calculatorCell==='B100');await preciseOverlap.emit('focus');assert.equal(preciseOverlap.value,'0.005');await preciseOverlap.emit('blur');assert.deepEqual(copy(entry.inputs),{});passed++;

  // A projected table's own header is independent of left-hand headings sharing the same source rows.
  const ductProjectedOutputs=byId('calculator-grid').querySelectorAll('[data-calculator-output]');
  for(const address of ['J117','J123']) {
    const value=ductProjectedOutputs.find(node=>node.dataset.calculatorOutput===address);
    assert.match(value.className,/calculator-role-body/);assert.equal(value.classList.contains('calculator-value-present'),true);assert.equal(value.classList.contains('calculator-source-heading'),false);
  }
  const leftHeader=ductProjectedOutputs.find(node=>node.dataset.calculatorOutput==='A117');assert.equal(leftHeader.dataset.calculatorValue,undefined);assert.equal(leftHeader.classList.contains('calculator-source-heading'),true);
  const ownHeader=ductProjectedOutputs.find(node=>node.dataset.calculatorOutput==='J116');assert.equal(ownHeader.tagName,'th');assert.equal(ownHeader.dataset.calculatorValue,undefined);
  const retainedPenetrationValue=ductProjectedOutputs.find(node=>node.dataset.calculatorOutput==='J117'),headerScopedUpdate=copy(entry.result);headerScopedUpdate.rows.find(row=>row.row===117).cells.find(cell=>cell.column===10).value='Updated wall board collars';
  audit.setRequest(async()=>headerScopedUpdate);await audit.calculate();assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='J117'),retainedPenetrationValue);assert.equal(retainedPenetrationValue.classList.contains('calculator-value-present'),true);passed++;

  // Plain settings forms use the page's vertical scroll, including forms with no table projection metadata.
  for(const [calculator,sheet] of [['steel_vermiculite','SETTINGS'],['steel_board','SETTINGS'],['ductwork','PRODUCT SETTINGS']]) {
    entry=setup();entry.definition.id=calculator;entry.sheet=sheet;entry.definition.sheets=[{name:sheet,header_rows:[],merges:[]}];
    entry.result=result({}, {sheet,rows:[{row:1,cells:[{column:1,address:'A1',value:'Product settings',presentation:{role:'title'}}]},
      {row:7,cells:[{column:1,address:'A7',value:'Working value'},{column:2,address:'B7',value:0.005,editable:true,type:'number'}]}]});
    realRender(entry);const plainSettingsScroll=byId('calculator-grid').children.find(node=>node.className?.includes('calculator-table-scroll'));
    assert.ok(plainSettingsScroll.classList.contains('calculator-section-scroll'));assert.equal(renderedControls().length,1);
  }passed++;

  // START expands all instructions without internal table scrolling or an extra contents list.
  entry=setup();entry.sheet='START';entry.definition.schedule.sheet='CALCULATOR';
  entry.definition.sheets=[{name:'START',navigation_mode:'hidden',expand_tables:true,header_rows:[],section_cells:['A8'],merges:['A1:C1','A8:C8']}];
  entry.result=result({}, {sheet:'START',rows:[{row:1,cells:[{column:1,address:'A1',value:'Start',presentation:{role:'title'}}]},
    {row:8,cells:[{column:1,address:'A8',value:'Getting started',presentation:{role:'section'}}]},
    {row:12,cells:[{column:1,address:'A12',value:'Source instructions'},{column:3,address:'C12',value:'Keep this qualification'}]}]});
  const startRaw=JSON.stringify(entry.result);realRender(entry);
  assert.equal(byId('calculator-grid').classList.contains('calculator-grid-expanded'),true);
  assert.ok(!descendants(byId('calculator-grid')).some(node=>node.className==='calculator-contents'));
  assert.ok(descendants(byId('calculator-grid')).filter(node=>node.className?.includes('calculator-table-scroll')).every(node=>node.classList.contains('calculator-section-scroll')));
  assert.ok(descendants(byId('calculator-grid')).some(node=>node.textContent==='Keep this qualification'));assert.equal(JSON.stringify(entry.result),startRaw);
  entry.result.expand_tables=false;realRender(entry);assert.equal(byId('calculator-grid').classList.contains('calculator-grid-expanded'),false);passed++;

  // All settings choosers start closed, partition overlapping source columns once, and retain drafts/errors/selection.
  const chooserBounds=[[9,16],[17,30],[31,63],[64,95],[96,172],[173,228],[229,269],[270,340],[341,355],[356,369],[370,374]];
  const chooserCases=[
    {id:'steel_vermiculite',sheet:'SETTINGS',sections:chooserBounds.map(([first,last],index)=>({id:`A${first}`,label:`Section ${index+1}`,ranges:[`A${first}:N${last}`]})),metadata:{section_cells:chooserBounds.map(([first])=>`A${first}`),merges:chooserBounds.map(([first])=>`A${first}:N${first}`)},rows:[
      {row:1,cells:[{column:1,address:'A1',value:'Vermiculite settings',presentation:{role:'title'}}]},
      ...chooserBounds.flatMap(([first],index)=>[{row:first,cells:[{column:1,address:`A${first}`,value:`Section ${index+1}`,presentation:{role:'section'}}]},{row:first+1,cells:[{column:1,address:`A${first+1}`,value:'Setting'},{column:4,address:`D${first+1}`,value:index+0.123456789,editable:true,type:'number'}]}]),
      {row:42,cells:[{column:4,address:'D42',value:'Saved reference basis',read_only:true,presentation:{role:'note'}}]},
    ]},
    {id:'steel_board',sheet:'SETTINGS',sections:[{id:'table-0',label:'General settings',ranges:['A5:C34']},{id:'table-1',label:'Fire periods and temperatures',ranges:['G5:N10']},{id:'table-2',label:'Diagnostic messages',ranges:['P5:Q51']}],metadata:{table_layout:'stacked',presentation_tables:boardSettingTables,header_rows:[5]},rows:[
      {row:1,cells:[{column:1,address:'A1',value:'Board settings',presentation:{role:'title'}}]},
      {row:5,cells:[{column:1,address:'A5',value:'Setting'},{column:7,address:'G5',value:'Fire period'},{column:16,address:'P5',value:'Diagnostic code'},{column:17,address:'Q5',value:'Message'}]},
      {row:6,cells:[{column:1,address:'A6',value:'Allowance'},{column:2,address:'B6',value:0.1,editable:true,type:'number'},{column:7,address:'G6',value:90},{column:16,address:'P6',value:'REVIEW'},{column:17,address:'Q6',value:'Source diagnostic message'}]},
    ]},
    {id:'ductwork',sheet:'PRODUCT SETTINGS',sections:[{id:'A6',label:'CAFCO',note:'Check the assessed construction.',display_columns:[1,2,3,4],ranges:['A6:H46']},{id:'A48',label:'MONOKOTE',ranges:['A48:H92']},{id:'A94',label:'FYREWRAP',ranges:['A94:H151']},{id:'J94',label:'FYREWRAP APPLICATION TABLE',display_columns:[10,13,14,15],ranges:['J94:Q113']},{id:'J115',label:'PENETRATION',ranges:['J115:Q149']}],metadata:{table_layout:'projected',header_rows:[95,116],section_cells:['A6','A48','A94','J94','J115'],display_text:{J94:'FYREWRAP APPLICATION TABLE'},technical_basis:{label:'TECHNICAL BASIS',visible:false,sections:[{section_id:'A6',ranges:['A21:H24']}]},merges:['A94:H94','J94:Q94','J115:Q115'],presentation_tables:[
      {first_row:94,last_row:151,columns:[1,2,3,4,5,6,7,8],column_widths:Array(8).fill(1),width_mode:'fit',table_kind:'form',title_address:'A94',label:'FYREWRAP'},
      {first_row:94,last_row:113,columns:[10,11,12,13,14,15,16,17],column_widths:Array(8).fill(100),table_kind:'comparison',title_address:'J94',header_row:95,label:'Application',note:'FyreWrap application FRLs preserve directional requirements.'},
      {first_row:115,last_row:149,columns:[10,11,12,13,14,15,16,17],column_widths:Array(8).fill(1),width_mode:'fit',table_kind:'comparison',title_address:'J115',header_row:116,label:'Penetration'},
    ]},rows:[
      {row:1,cells:[{column:1,address:'A1',value:'Duct settings',presentation:{role:'title'}}]},
      {row:6,cells:[{column:1,address:'A6',value:'CAFCO',presentation:{role:'section'}}]},{row:8,cells:[{column:2,address:'B8',value:25,editable:true,type:'number'},{column:5,address:'E8',value:'Historical source detail'}]},
      {row:48,cells:[{column:1,address:'A48',value:'MONOKOTE',presentation:{role:'section'}}]},{row:65,cells:[{column:2,address:'B65',value:1,editable:true,type:'number'}]},
      {row:94,cells:[{column:1,address:'A94',value:'FYREWRAP',presentation:{role:'section'}},{column:10,address:'J94',value:'Original application title',presentation:{role:'section'}}]},
      {row:95,cells:[{column:10,address:'J95',value:'Application header'}]},
      {row:100,cells:[{column:2,address:'B100',value:0.005,editable:true,type:'number'},{column:10,address:'J100',value:'Application source record'},{column:11,address:'K100',value:'Documentary wording'}]},
      {row:115,cells:[{column:1,address:'A115',value:'FyreWrap settings note'},{column:10,address:'J115',value:'PENETRATION',presentation:{role:'section'}}]},
      {row:116,cells:[{column:10,address:'J116',value:'Penetration header'}]},
      {row:117,cells:[{column:1,address:'A117',value:'Another FyreWrap setting'},{column:10,address:'J117',value:'Penetration source record'}]},
    ]},
  ];
  for(const scenario of chooserCases) {
    entry=setup();audit.state.entries.delete('steel_board');audit.state.entries.set(scenario.id,entry);audit.state.current=scenario.id;
    entry.definition.id=scenario.id;entry.sheet=scenario.sheet;entry.definition.pages=[scenario.sheet,'CALCULATOR'];entry.definition.schedule.sheet='CALCULATOR';
    entry.definition.sheets=[{name:scenario.sheet,header_rows:[],merges:[],...copy(scenario.metadata),navigation_mode:'select',settings_sections:copy(scenario.sections)},{name:'CALCULATOR',header_rows:[8],merges:[]}];
    const sectionResult=inputs=>result(copy(inputs),{sheet:scenario.sheet,max_column:17,rows:copy(scenario.rows)});
    entry.result=sectionResult(entry.inputs);const rawChooser=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
    const chooserButtons=()=>descendants(byId('calculator-grid')).filter(node=>node.className?.startsWith('calculator-settings-choice'));
    const chooserPanels=()=>byId('calculator-grid').children.filter(node=>node.className==='calculator-settings-panel');
    const openPanels=()=>chooserPanels().filter(panel=>!panel.hidden);
    assert.equal(chooserButtons().length,scenario.sections.length);assert.equal(chooserPanels().length,scenario.sections.length);assert.equal(openPanels().length,0);
    assert.ok(!descendants(byId('calculator-grid')).some(node=>node.className==='calculator-contents'));
    for(const [index,button] of chooserButtons().entries()){assert.equal(button.tagName,'button');assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(button.getAttribute('aria-controls'),chooserPanels()[index].id);assert.equal(chooserPanels()[index].getAttribute('aria-labelledby'),button.id);}
    const sourceControls=scenario.rows.flatMap(row=>row.cells.filter(cell=>cell.editable).map(cell=>cell.address)).sort();
    assert.deepEqual(renderedControls().map(control=>control.dataset.calculatorCell).sort(),sourceControls);
    for(const control of renderedControls())assert.equal(chooserPanels().filter(panel=>descendants(panel).includes(control)).length,1);
    if(scenario.id==='ductwork') {
      const panelById=id=>chooserPanels().find(panel=>panel.id.endsWith(`-${id}`));
      assert.ok(descendants(panelById('A6')).some(node=>node.className?.includes('calculator-settings-note')&&node.textContent==='Check the assessed construction.'));
      assert.ok(!chooserButtons().some(button=>button.textContent==='TECHNICAL BASIS'));
      assert.ok(!descendants(panelById('A6')).some(node=>node.textContent==='Historical source detail'));
      assert.ok(!descendants(panelById('J94')).some(node=>node.textContent==='Documentary wording'));
      for(const address of ['A94','A115','A117'])assert.ok(descendants(panelById('A94')).some(node=>node.dataset?.calculatorOutput===address));
      assert.ok(descendants(panelById('J94')).some(node=>node.dataset?.calculatorOutput==='J94'&&node.textContent==='FYREWRAP APPLICATION TABLE'));
      assert.equal(descendants(panelById('J94')).filter(node=>node.className?.includes('calculator-technical-note')).length,1);
      assert.equal(descendants(panelById('J94')).find(node=>node.className?.includes('calculator-technical-note')).textContent,'FyreWrap application FRLs preserve directional requirements.');
      assert.ok(!descendants(panelById('J115')).some(node=>node.className?.includes('calculator-technical-note')));
      assert.ok(descendants(panelById('J115')).some(node=>node.dataset?.calculatorOutput==='J117'));
    }
    assert.equal(JSON.stringify(entry.result),rawChooser);assert.deepEqual(copy(entry.inputs),{});
    await chooserButtons()[0].emit('click');assert.equal(openPanels().length,1);assert.equal(chooserButtons()[0].getAttribute('aria-expanded'),'true');
    const firstControl=descendants(openPanels()[0]).find(node=>node.dataset?.calculatorCell),controlAddress=firstControl.dataset.calculatorCell;
    await firstControl.emit('focus');firstControl.value='12.3456789';await firstControl.emit('input');await firstControl.emit('blur');
    const draftBeforeChoice=JSON.stringify(entry.inputs),savedBeforeChoice=entry.saved;
    firstControl.value='invalid';await firstControl.emit('input');assert.equal(entry.invalid.size,1);
    await chooserButtons()[1].emit('click');assert.equal(openPanels().length,1);assert.equal(chooserButtons()[0].getAttribute('aria-expanded'),'false');assert.equal(entry.invalid.size,1);
    assert.equal(JSON.stringify(entry.inputs),draftBeforeChoice);assert.equal(entry.saved,savedBeforeChoice);
    await chooserButtons()[0].emit('click');firstControl.value='12.3456789';await firstControl.emit('input');await firstControl.emit('blur');await chooserButtons()[1].emit('click');
    audit.setRequest(async(path,options)=>{const body=JSON.parse(options.body);return body.sheet===scenario.sheet?sectionResult(body.inputs):result(body.inputs,{sheet:body.sheet,rows:[]});});
    await audit.calculate();assert.equal(renderedControls().find(control=>control.dataset.calculatorCell===controlAddress),firstControl);assert.equal(openPanels().length,1);assert.equal(chooserButtons()[1].getAttribute('aria-expanded'),'true');
    entry.needsRender=true;await audit.calculate();assert.equal(openPanels().length,1);assert.equal(chooserButtons()[1].getAttribute('aria-expanded'),'true');
    await chooserButtons()[0].emit('click');const pendingControl=renderedControls().find(control=>control.dataset.calculatorCell===controlAddress);
    context.document.activeElement=pendingControl;await pendingControl.emit('focus');
    audit.setRequest(async(path,options)=>({...sectionResult(JSON.parse(options.body).inputs),display_text:{A1:'Updated settings title'}}));
    await audit.calculate();assert.ok(entry.pendingResult);assert.equal(renderedControls().find(control=>control.dataset.calculatorCell===controlAddress),pendingControl);
    const pendingButton=chooserButtons()[1];await pendingControl.emit('blur',{relatedTarget:pendingButton});context.document.activeElement=pendingButton;
    assert.ok(entry.pendingResult);assert.equal(chooserButtons()[1],pendingButton);
    await pendingButton.emit('click');assert.equal(entry.pendingResult,null);assert.equal(chooserButtons()[1].getAttribute('aria-expanded'),'true');assert.notEqual(chooserButtons()[1],pendingButton);assert.equal(openPanels().length,1);
    assert.equal(entry.inputs[scenario.sheet][controlAddress],12.3456789);context.document.activeElement=null;
    audit.setRequest(async(path,options)=>{const body=JSON.parse(options.body);return body.sheet===scenario.sheet?sectionResult(body.inputs):result(body.inputs,{sheet:body.sheet,rows:[]});});
    await audit.selectPage('CALCULATOR');await audit.selectPage(scenario.sheet);assert.equal(chooserButtons()[1].getAttribute('aria-expanded'),'true');
    const otherId=scenario.id==='ductwork'?'steel_board':'ductwork',other={...entry,definition:{...entry.definition,id:otherId,title:'Other calculator'},inputs:{CALCULATOR:{B9:99}},saved:'{}',invalid:new Map(),settingsSelection:{},sheet:'CALCULATOR',result:null};
    audit.state.entries.set(otherId,other);await audit.selectCalculator(otherId);await audit.selectCalculator(scenario.id);
    assert.equal(chooserButtons()[1].getAttribute('aria-expanded'),'true');assert.equal(entry.inputs[scenario.sheet][controlAddress],12.3456789);assert.equal(entry.saved,savedBeforeChoice);assert.equal(other.inputs.CALCULATOR.B9,99);
    await chooserButtons()[1].emit('click');assert.equal(openPanels().length,0);
  }passed++;

  // Browser tabs partition one source Settings sheet without creating new input or API identities.
  entry=setup();const virtualBase=copy(entry.definition);audit.state.entries.clear();audit.state.current=null;
  const virtualInputs={SETTINGS:{D10:1.23456789,D342:2.34567891,BF533:'Retained hidden input'},SCHEDULE:{A1009:'Last schedule mark'}};
  const virtualRows=copy(chooserCases[0].rows).map(row=>row.row===271?{...row,cells:row.cells.filter(cell=>!cell.editable)}:row);
  virtualRows.push({row:7,cells:[{column:1,address:'A7',value:'Factor helper starts at row 341.',presentation:{role:'note'}}]});virtualRows.sort((a,b)=>a.row-b.row);
  const virtualDefinition={...virtualBase,id:'steel_vermiculite',title:'Vermiculite',inputs:copy(virtualInputs),pages:['CALCULATOR','SCHEDULE','BAGS','SETTINGS'],
    schedule:{...virtualBase.schedule,sheet:'SCHEDULE'},display_pages:[
      {id:'START',label:'START',sheet:'SETTINGS',section_ids:['A270'],section_mode:'content',include_common:false,intro_address:'A7',intro_after_address:'A270'},
      ...['CALCULATOR','SCHEDULE','BAGS'].map(sheet=>({id:sheet,label:sheet==='BAGS'?'SUMMARY':sheet,sheet})),
      {id:'SETTINGS',label:'SETTINGS',sheet:'SETTINGS',section_ids:['A9','A17','A31','A64','A96','A173','A229'],include_common:true,hidden_common_addresses:['A7']},
      {id:'FACTOR CALCS',label:'FACTOR CALCS',sheet:'SETTINGS',section_ids:['A341','A356','A370'],include_common:false}],
    sheets:[{name:'SETTINGS',header_rows:[],...copy(chooserCases[0].metadata),navigation_mode:'select',settings_sections:copy(chooserCases[0].sections)},
      ...['CALCULATOR','SCHEDULE','BAGS'].map(name=>({name,header_rows:[],merges:[]}))]};
  const virtualResult=inputs=>result(copy(inputs),{sheet:'SETTINGS',max_column:14,rows:copy(virtualRows)}),virtualRequests=[];
  const serveVirtual=async(path,options)=>{
    if(!options)return copy(virtualDefinition);
    const body=JSON.parse(options.body);virtualRequests.push({path,body});
    if(path.endsWith('/state'))return {inputs:body.inputs};
    assert.equal(body.sheet,'SETTINGS');return virtualResult(body.inputs);
  };
  audit.setRequest(serveVirtual);audit.setRender(realRender);await audit.selectCalculator('steel_vermiculite');entry=audit.current();
  const virtualButtons=()=>descendants(byId('calculator-grid')).filter(node=>node.className?.startsWith('calculator-settings-choice'));
  const virtualPanels=()=>byId('calculator-grid').children.filter(node=>node.className==='calculator-settings-panel');
  const virtualOutputs=()=>byId('calculator-grid').querySelectorAll('[data-calculator-output]').map(node=>node.dataset.calculatorOutput);
  assert.equal(entry.page,'START');assert.equal(entry.sheet,'SETTINGS');assert.equal(byId('calculator-sheet-title').textContent,'START');
  assert.deepEqual(byId('calculator-pages').children.map(button=>button.textContent),['START','LOOKUP','SCHEDULE','SUMMARY','SETTINGS','FACTOR CALCS']);
  assert.equal(virtualButtons().length,0);assert.equal(renderedControls().length,0);assert.ok(virtualOutputs().includes('A270'));
  assert.equal(virtualOutputs().filter(address=>address==='A7').length,1);
  const startBody=descendants(byId('calculator-grid')).find(node=>node.tagName==='tbody'&&node.children.some(row=>row.dataset.sourceRow==='270'));
  assert.equal(startBody.children[startBody.children.findIndex(row=>row.dataset.sourceRow==='270')+1].children[0].dataset.calculatorOutput,'A7');
  for(const address of ['A1','A9','A31','A341','D342'])assert.ok(!virtualOutputs().includes(address));
  assert.deepEqual(copy(entry.inputs),virtualInputs);assert.deepEqual(copy(entry.definition.pages),['CALCULATOR','SCHEDULE','BAGS','SETTINGS']);passed++;
  const virtualNavigationStartRequests=virtualRequests.length;
  assert.equal(audit.sourceDisplayText('Factor helper starts at row 341.',entry,'A7'),'Open FACTOR CALCS for the Section Factor Helper.');
  assert.equal(audit.sourceDisplayText('CALCULATOR = one member | BAGS = ordering | Factor helper starts at row 341.',entry,'A7'),'LOOKUP = one member | SUMMARY = ordering | Open FACTOR CALCS for the Section Factor Helper.');
  assert.equal(audit.sourceDisplayText('Use CALCULATOR for one member and BAGS for ordering.',entry,'A9'),'Use LOOKUP for one member and SUMMARY for ordering.');
  const bagsDirectionsEntry={...entry,sheet:'BAGS',result:null};
  assert.equal(audit.sourceDisplayText('Change product yields and waste in SETTINGS. The factor helper is also there.',bagsDirectionsEntry,'A27'),'Change product yields and waste in SETTINGS. Open FACTOR CALCS for factor helpers.');

  // Settings and factor chooser selections are independent; hidden source inputs and invalid drafts survive switching.
  await audit.selectPage('SETTINGS');assert.equal(virtualButtons().length,7);assert.ok(virtualPanels().every(panel=>panel.hidden));assert.equal(renderedControls().length,7);
  assert.equal(virtualRequests.length,virtualNavigationStartRequests); // Both browser tabs use the same unchanged source worksheet.
  assert.ok(!virtualOutputs().includes('A1'));assert.ok(virtualOutputs().includes('D42'));for(const address of ['A7','A270','A341','A356','A370'])assert.ok(!virtualOutputs().includes(address));
  await virtualButtons()[0].emit('click');const virtualSetting=renderedControls().find(control=>control.dataset.calculatorCell==='D10');
  assert.equal(virtualSetting.dataset.calculatorSheet,'SETTINGS');virtualSetting.value='3.45678912';await virtualSetting.emit('input');
  await audit.selectPage('FACTOR CALCS');assert.equal(virtualButtons().length,3);assert.ok(virtualPanels().every(panel=>panel.hidden));assert.equal(renderedControls().length,3);
  assert.ok(!virtualOutputs().includes('A1'));for(const address of ['A9','A31','A270','D42'])assert.ok(!virtualOutputs().includes(address));
  await virtualButtons()[0].emit('click');const virtualFactor=renderedControls().find(control=>control.dataset.calculatorCell==='D342');
  assert.equal(virtualFactor.dataset.calculatorSheet,'SETTINGS');virtualFactor.value='4.56789123';await virtualFactor.emit('input');
  await audit.selectPage('SETTINGS');assert.equal(virtualButtons()[0].getAttribute('aria-expanded'),'true');assert.equal(entry.inputs.SETTINGS.D10,3.45678912);
  await audit.selectPage('FACTOR CALCS');assert.equal(virtualButtons()[0].getAttribute('aria-expanded'),'true');assert.equal(entry.inputs.SETTINGS.D342,4.56789123);
  const invalidFactor=renderedControls().find(control=>control.dataset.calculatorCell==='D342');invalidFactor.value='not a number';await invalidFactor.emit('input');
  const beforeBlockedTab=virtualRequests.length;await audit.selectPage('START');assert.equal(entry.page,'FACTOR CALCS');assert.equal(virtualRequests.length,beforeBlockedTab);assert.ok(entry.invalid.has('SETTINGS!D342'));
  invalidFactor.value='4.56789123';await invalidFactor.emit('input');await audit.selectPage('START');assert.equal(entry.page,'START');assert.equal(entry.invalid.size,0);
  assert.equal(entry.inputs.SETTINGS.BF533,'Retained hidden input');assert.equal(entry.inputs.SCHEDULE.A1009,'Last schedule mark');
  assert.equal(entry.inputs.START,undefined);assert.equal(entry.inputs['FACTOR CALCS'],undefined);assert.ok(virtualRequests.every(request=>request.body.sheet==='SETTINGS'));passed++;

  // Late responses for another browser tab cannot replace the active tab even when both share SETTINGS.
  entry.navigationCache=null;
  const oldVirtual=deferred();let virtualCalls=0;
  audit.setRequest(async(path,options)=>{const body=JSON.parse(options.body);assert.equal(body.sheet,'SETTINGS');return ++virtualCalls===1?oldVirtual.promise:virtualResult(body.inputs);});
  const oldVirtualRun=audit.selectPage('SETTINGS');await audit.selectPage('FACTOR CALCS');
  const freshVirtualResult=entry.result;oldVirtual.resolve(virtualResult({SETTINGS:{D10:-99}}));await oldVirtualRun;
  assert.equal(entry.page,'FACTOR CALCS');assert.equal(entry.renderedPage,'FACTOR CALCS');assert.equal(entry.result,freshVirtualResult);assert.equal(virtualButtons().length,3);assert.equal(entry.inputs.SETTINGS.D10,3.45678912);
  const oldVirtualError=deferred();virtualCalls=0;
  entry.navigationCache=null;
  audit.setRequest(async(path,options)=>++virtualCalls===1?oldVirtualError.promise:virtualResult(JSON.parse(options.body).inputs));
  const oldFailure=audit.selectPage('START');await audit.selectPage('SETTINGS');oldVirtualError.reject(new Error('Obsolete START failure'));await oldFailure;
  assert.equal(entry.page,'SETTINGS');assert.ok(!byId('calculator-message').textContent.includes('Obsolete START failure'));assert.equal(virtualButtons().length,7);passed++;

  // Saving, both downloads and reset from a virtual tab still use the complete source-keyed calculator draft.
  audit.setRequest(serveVirtual);await audit.selectPage('FACTOR CALCS');const fullVirtualDraft=copy(entry.inputs);
  await audit.save();assert.deepEqual(virtualRequests.at(-1).body,{inputs:fullVirtualDraft});assert.equal(entry.saved,JSON.stringify(fullVirtualDraft));
  for(const [download,action,mime] of [[audit.downloadSchedulePdf,'report.pdf','application/pdf'],[audit.downloadExcelRegister,'register.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    let capturedVirtualDownload;audit.setFetch(async(path,options)=>{assert.ok(path.endsWith('/'+action));capturedVirtualDownload=JSON.parse(options.body);return fileSaved(action);});
    await download();assert.deepEqual(capturedVirtualDownload,{inputs:fullVirtualDraft,...(mime==='application/pdf'?{project_details:{}}:{}),download:{project_token:null}});assert.equal(entry.page,'FACTOR CALCS');assert.equal(entry.sheet,'SETTINGS');
  }
  entry.definition.defaults={SETTINGS:{D10:9.123456789,D342:8.987654321},SCHEDULE:{A1009:'Reset schedule'}};
  const savedBeforeVirtualReset=entry.saved,virtualReset=audit.reset();await byId('calculator-confirm-dialog').close('confirm');await virtualReset;
  assert.deepEqual(copy(entry.inputs),copy(entry.definition.defaults));assert.equal(entry.saved,savedBeforeVirtualReset);assert.equal(entry.page,'FACTOR CALCS');assert.equal(entry.sheet,'SETTINGS');passed++;

  // Successful generic subtitles disappear; calculating/errors remain, and only the exact approved duct banner is hidden.
  const approvedFixingBanner='The copied fixing instructions use the first schedule row’s fixed technical references on every row. This is the approved correction to the source workbook; quantity formulas are unchanged.';
  for(const sheet of ['CALCULATOR','SUMMARY','PRODUCT SETTINGS']) {
    entry=setup();entry.definition.id='ductwork';entry.sheet=sheet;
    const warningPayload=result({}, {sheet,warnings:[approvedFixingBanner,`${approvedFixingBanner} Updated source.`,{message:'Keep the technical qualification.'}]});
    const calculating=deferred();audit.setRequest(()=>calculating.promise);const runningCalculation=audit.calculate();
    assert.equal(byId('calculator-calculation-status').hidden,false);assert.equal(byId('calculator-calculation-status').textContent,'Calculating…');assert.equal(byId('calculator-recalculate').disabled,true);assert.equal(byId('calculator-recalculate').getAttribute('aria-busy'),'true');
    calculating.resolve(warningPayload);await runningCalculation;
    assert.equal(byId('calculator-calculation-status').hidden,true);assert.equal(byId('calculator-calculation-status').textContent,'');assert.equal(byId('calculator-recalculate').disabled,false);assert.equal(byId('calculator-recalculate').getAttribute('aria-busy'),'false');
    assert.deepEqual(byId('calculator-warnings').textContent.split('\n'),[`${approvedFixingBanner} Updated source.`,'Keep the technical qualification.']);
    assert.equal(entry.result.warnings[0],approvedFixingBanner);assert.equal(entry.result.warnings.length,3);
    audit.setRequest(async()=>result({}, {sheet,warnings:[approvedFixingBanner]}));await audit.calculate();assert.equal(byId('calculator-warnings').hidden,true);
  }
  entry=setup();audit.setRequest(async()=>result({}, {warnings:[approvedFixingBanner]}));await audit.calculate();
  assert.equal(byId('calculator-warnings').textContent,approvedFixingBanner);assert.equal(byId('calculator-warnings').hidden,false);
  audit.setRequest(async()=>{throw new Error('Server unavailable');});await audit.calculate();
  assert.equal(byId('calculator-calculation-status').hidden,false);assert.equal(byId('calculator-calculation-status').textContent,'Calculation needs attention');
  const invalidStatusControl=audit.makeControl({column:2,type:'number',value:1},9,entry,'Length');invalidStatusControl.value='invalid';await invalidStatusControl.emit('input');
  assert.equal(byId('calculator-calculation-status').hidden,false);assert.match(byId('calculator-calculation-status').textContent,/valid number/);passed++;

  // Cell-specific bold and centred text are presentation only and survive ordinary result refreshes.
  entry=setup();entry.definition.id='ductwork';entry.sheet='PRODUCT SETTINGS';
  entry.definition.sheets=[{name:entry.sheet,header_rows:[],display_cells:{J96:{bold:true,align:'center'},K96:{align:'center'},L96:{bold:false,align:'left'}},merges:[]}];
  entry.result=result({}, {sheet:entry.sheet,max_column:12,visible_columns:[10,11,12],rows:[{row:96,cells:[
    {column:10,address:'J96',value:'Application detail',presentation:{role:'body',bold:false}},
    {column:11,address:'K96',value:0.123456789,calculated:true,presentation:{role:'body'}},
    {column:12,address:'L96',value:'Source emphasis',presentation:{role:'body',bold:true}},
  ]}]});
  const rawAlignedCells=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  const alignedOutput=address=>byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput===address);
  const alignedLabel=alignedOutput('J96');assert.equal(alignedLabel.classList.contains('calculator-bold'),true);assert.equal(alignedLabel.classList.contains('calculator-align-center'),true);
  assert.equal(alignedOutput('K96').classList.contains('calculator-align-center'),true);assert.equal(alignedOutput('K96').classList.contains('calculator-bold'),false);
  assert.equal(alignedOutput('L96').classList.contains('calculator-bold'),false);assert.equal(alignedOutput('L96').classList.contains('calculator-normal'),true);assert.equal(alignedOutput('L96').classList.contains('calculator-align-left'),false);assert.equal(alignedOutput('L96').classList.contains('calculator-align-center'),true);
  assert.equal(JSON.stringify(entry.result),rawAlignedCells);
  const alignedUpdate=copy(entry.result);alignedUpdate.rows[0].cells[1].value=0.987654321;audit.setRequest(async()=>alignedUpdate);await audit.calculate();
  assert.equal(alignedOutput('J96'),alignedLabel);assert.equal(alignedOutput('K96').textContent,'0.99');assert.equal(alignedOutput('K96').classList.contains('calculator-align-center'),true);
  alignedUpdate.display_cells={J96:{align:'center'},K96:{align:'center'}};await audit.calculate();
  assert.notEqual(alignedOutput('J96'),alignedLabel);assert.equal(alignedOutput('J96').classList.contains('calculator-bold'),false);assert.equal(alignedOutput('J96').classList.contains('calculator-align-center'),true);
  assert.equal(alignedOutput('L96').classList.contains('calculator-normal'),false);assert.equal(alignedOutput('L96').classList.contains('calculator-bold'),true);
  assert.equal(alignedUpdate.rows[0].cells[0].presentation.bold,false);passed++;

  // Populated notes use the same present-value state in forms and overview; headings stay structural.
  entry=setup();entry.definition.schedule.sheet='SCHEDULE';entry.definition.sheets[0].section_cells=['A5'];
  entry.result=result({}, {rows:[{row:5,cells:[{column:1,address:'A5',value:'Section heading',presentation:{role:'section'}}]},
    {row:6,cells:[{column:1,address:'A6',value:'Read this source note',presentation:{role:'note'}},{column:2,address:'B6',value:'Calculated note',calculated:true,presentation:{role:'note'}}]}]});
  realRender(entry);for(const address of ['A6','B6'])assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput===address).classList.contains('calculator-value-present'),true);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput==='A5').dataset.calculatorValue,undefined);
  const noteOverview=audit.renderOverview([{row:2,cells:[{column:1,address:'A2',value:'Overview note',presentation:{role:'note'}}]},{row:3,cells:[{column:1,address:'A3',value:'Overview heading',presentation:{role:'section'}}]}],entry,[1]);
  assert.equal(descendants(noteOverview).find(node=>node.dataset?.calculatorOutput==='A2').classList.contains('calculator-value-present'),true);assert.equal(descendants(noteOverview).find(node=>node.dataset?.calculatorOutput==='A3').dataset.calculatorValue,undefined);passed++;

  // The duct introduction is a full-width note even when its retained source style says section heading.
  entry=setup();entry.definition.id='ductwork';entry.definition.schedule.header_row=10;entry.definition.schedule.first_row=11;
  entry.definition.sheets=[{name:'CALCULATOR',header_rows:[10],display_cells:{A3:{role:'note',bold:false,align:'left'}},merges:['A1:C1','A3:C3']}];
  entry.result=result({}, {rows:[{row:1,cells:[{column:1,address:'A1',value:'DUCT PROTECTION CALCULATOR',presentation:{role:'title'}}]},
    {row:3,cells:[{column:1,address:'A3',value:'Enter the schedule in blue cells.',presentation:{role:'section',bold:true}}]},
    {row:11,cells:[{column:2,address:'B11',value:1,editable:true,type:'number'}]}]});
  const rawDuctIntro=JSON.stringify(entry.result);realRender(entry);
  const ductOverview=descendants(byId('calculator-grid')).find(node=>node.className==='calculator-overview');assert.equal(ductOverview.classList.contains('calculator-overview-full'),true);
  const ductIntro=descendants(ductOverview).find(node=>node.dataset?.calculatorOutput==='A3');
  assert.equal(ductIntro.tagName,'p');assert.equal(ductIntro.className,'calculator-overview-note');assert.equal(ductIntro.classList.contains('calculator-value-present'),true);
  assert.equal(ductIntro.classList.contains('calculator-normal'),true);assert.equal(ductIntro.classList.contains('calculator-bold'),false);assert.equal(ductIntro.classList.contains('calculator-align-left'),true);
  assert.equal(ductIntro.textContent,'Enter values in the schedule input fields.');assert.equal(JSON.stringify(entry.result),rawDuctIntro);
  assert.equal(renderedControls().length,1);passed++;

  // Calculator tables always leave vertical wheel scrolling to the page;
  // selecting an input must not collapse a table into an inner viewport.
  const sectionCss=fs.readFileSync('static/calculators.css','utf8');
  assert.match(sectionCss,/\.calculator-table-scroll\{[^}]*overflow-x:auto;overflow-y:visible;max-height:none/);
  assert.doesNotMatch(sectionCss,/\.calculator-table-scroll:focus-within\{[^}]*overflow-y:auto|\.calculator-table-scroll:focus-within[^}]*max-height/);
  assert.match(sectionCss,/\.calculator-table-scroll\.calculator-section-scroll\s*\{\s*max-height:\s*none\s*\}/);
  assert.doesNotMatch(sectionCss,/calculator-section-scroll:focus-within/);
  assert.match(sectionCss,/\.calculator-grid td\.calculator-role-spacer\s*\{\s*background:\s*#fff0ce!important\s*\}/);
  assert.match(sectionCss,/\.calculator-grid \.calculator-value-empty\s*\{\s*background:\s*#f2f3f5!important\s*\}/);
  assert.match(sectionCss,/\.calculator-overview-full\s*>\s*p\s*\{[^}]*flex:\s*0 0 100%/);
  assert.match(sectionCss,/\.calculator-overview-board\s+h3\s*\{[^}]*font-size:\s*15px/);
  assert.match(sectionCss,/\.calculator-role-compact_title\s*\{[^}]*font-size:\s*15px/);
  assert.match(sectionCss,/\.calculator-role-compact_summary_title\s*\{[^}]*font-size:\s*14px/);
  assert.match(sectionCss,/\.calculator-grid>\.calculator-table-scroll:first-child,\.calculator-grid>\.calculator-table-scroll:first-child>table\{border-top:0\}/);
  assert.match(sectionCss,/\.calculator-grid\.calculator-steel-lookup>\.calculator-table-scroll:first-of-type\{border-top:0;border-bottom:0\}/);
  assert.match(sectionCss,/\.calculator-grid>:first-child:is\(\.calculator-stacked-section,\.calculator-projected-section\)\{border-top:0\}/);
  assert.match(sectionCss,/\.calculator-grid \.calculator-normal\s*\{\s*font-weight:\s*400!important/);
  assert.match(sectionCss,/One black, red and white palette is shared by every workbook calculator tab/);
  assert.match(sectionCss,/\.calculator-grid td\.calculator-role-label,[^}]*background:#fff!important;color:#171217/);
  assert.match(sectionCss,/\.calculator-page\[aria-pressed=true\][^}]*border-bottom-color:var\(--red\)/);passed++;

  // The Firestopping choice and every workbook choice expose the same estimator
  // selection state so only the active calculator remains highlighted.
  entry=setup();audit.renderChoices();
  const calculatorChoices=byId('calculator-list').children;
  assert.equal(calculatorChoices.length,2);
  assert.equal(calculatorChoices[0].dataset.estimatorKind,'penetration');
  assert.equal(calculatorChoices[1].dataset.estimatorKind,'estimate');passed++;

  // Only Exposure input column data is normal weight; headers and diagnostics retain their source emphasis.
  for(const [id,sheet,column,firstRow,label] of [
    ['steel_vermiculite','SCHEDULE',3,10,'Exposure / member case'],
    ['steel_board','CALCULATOR',13,9,'Exposure layout'],
    ['ductwork','CALCULATOR',8,11,'Fire exposure / FyreWrap application']]) {
    entry=setup();entry.definition.id=id;entry.sheet=sheet;
    const name=number=>String.fromCharCode(64+number),address=`${name(column)}${firstRow}`;
    entry.definition.schedule={sheet,first_row:firstRow,last_row:firstRow,header_row:firstRow-1,columns:[
      {column:'A',label:'Product',editable:true},{column:name(column),label,editable:true},
      {column:name(column+1),label:'Exposure valid',editable:false}]};
    entry.definition.sheets=[{name:sheet,header_rows:[firstRow-1],merges:[],hidden_columns:[],display_cells:{}}];
    entry.result=result({}, {sheet,max_row:firstRow,max_column:column+1,visible_columns:[1,column,column+1],rows:[
      {row:firstRow-1,cells:[{column:1,value:'Product'},{column,value:label},{column:column+1,value:'Exposure valid'}]},
      {row:firstRow,cells:[
        {column:1,address:`A${firstRow}`,value:'Product A',editable:true,type:'select',options:['Product A'],presentation:{bold:true}},
        {column,address,value:'Three sided',editable:true,type:'select',options:['Three sided','Four sided'],presentation:{bold:true}},
        {column:column+1,address:`${name(column+1)}${firstRow}`,value:'Valid',calculated:true,presentation:{bold:true}}]}]});
    const before=JSON.stringify(entry.result);realRender(entry);
    const all=descendants(byId('calculator-grid')),exposure=all.find(node=>node.dataset?.calculatorCell===address);
    const target=all.find(node=>node.tagName==='td'&&descendants(node).includes(exposure));
    assert.ok(target.classList.contains('calculator-exposure-input'));
    assert.equal(all.filter(node=>node.classList?.contains('calculator-exposure-input')).length,1);
    assert.ok(all.filter(node=>node.tagName==='th').every(node=>!node.classList.contains('calculator-exposure-input')));
    assert.ok(all.find(node=>node.dataset?.calculatorOutput===`${name(column+1)}${firstRow}`).classList.contains('calculator-bold'));
    assert.equal(JSON.stringify(entry.result),before);exposure.value='Four sided';await exposure.emit('change');
    assert.equal(entry.inputs[sheet][address],'Four sided');
  }
  assert.match(sectionCss,/\.calculator-grid td\.calculator-exposure-input,\.calculator-grid td\.calculator-exposure-input :is\(input,select,textarea\)\{font-weight:400!important\}/);passed++;

  // Historical Back to Top text now has a real, labelled destination.
  entry=setup();entry.definition.id='steel_vermiculite';entry.sheet='SETTINGS';const back=element('td');
  audit.updateOutputCell(back,{address:'J32',value:'BACK TO TOP'});assert.equal(back.children[0].href,'#calculator-sheet-title');
  assert.equal(back.children[0].textContent,'Back to worksheet controls');passed++;

  // Schedule PDF downloads capture the clicked draft without saving or including later edits.
  for(const id of ['steel_vermiculite','steel_board','ductwork']) {
  entry=setup({CALCULATOR:{B9:2.3456789}});entry.definition.id=id;const pdfResponse=deferred();let pdfBody,pdfPath;
  audit.setFetch((path,options)=>{pdfPath=path;pdfBody=JSON.parse(options.body);return pdfResponse.promise;});
  const downloading=audit.downloadSchedulePdf();audit.setInput(entry,'CALCULATOR','B9',9);
  pdfResponse.resolve(fileSaved());await downloading;
  assert.equal(pdfPath,`/api/calculators/${id}/report.pdf`);assert.equal(pdfBody.inputs.CALCULATOR.B9,2.3456789);
  assert.equal(entry.inputs.CALCULATOR.B9,9);assert.equal(JSON.parse(entry.saved).CALCULATOR.B9,2.3456789);
  assert.deepEqual(pdfBody.download,{project_token:null});assert.match(byId('calculator-message').textContent,/saved to C:\/Downloads\/APPENDIX A.pdf/);assert.match(byId('calculator-message').textContent,/later edits are not included/);
  }passed++;

  // Materials/summary PDFs use their separate endpoint for all calculators and capture every exact draft input.
  for(const id of ['steel_vermiculite','steel_board','ductwork']) {
    entry=setup({CALCULATOR:{B9:2.3456789},SETTINGS:{D37:0.123456789},'EXTRA BOARDS':{D6:7.654321987}});entry.definition.id=id;
    const pending=deferred();let body,path,headers;
    audit.setFetch((requestPath,options)=>{path=requestPath;body=JSON.parse(options.body);headers=options.headers;return pending.promise;});
    const run=audit.downloadMaterialsSummaryPdf();
    assert.equal(audit.state.action,true);assert.equal(byId('calculator-summary-pdf').disabled,true);
    assert.equal(byId('calculator-pdf').disabled,true);assert.equal(byId('calculator-excel').disabled,true);
    assert.equal(byId('calculator-summary-pdf').getAttribute('aria-busy'),'true');
    assert.equal(byId('calculator-summary-pdf').getAttribute('aria-label'),'Preparing PDF Summary…');
    audit.setInput(entry,'CALCULATOR','B9',9.87654321);
    pending.resolve(fileSaved(`ceasefire-${id}-materials-summary.pdf`));await run;
    assert.equal(path,`/api/calculators/${id}/summary.pdf`);assert.equal(headers.Accept,'application/json');
    assert.deepEqual(body,{inputs:{CALCULATOR:{B9:2.3456789},SETTINGS:{D37:0.123456789},'EXTRA BOARDS':{D6:7.654321987}},project_details:{},download:{project_token:null}});
    assert.ok(byId('calculator-message').textContent.includes(`saved to C:/Downloads/ceasefire-${id}-materials-summary.pdf`));
    assert.equal(entry.inputs.CALCULATOR.B9,9.87654321);assert.equal(JSON.parse(entry.saved).CALCULATOR.B9,2.3456789);
    assert.equal(audit.state.action,false);assert.equal(byId('calculator-summary-pdf').disabled,false);
    assert.equal(byId('calculator-summary-pdf').getAttribute('aria-label'),'Download PDF Summary');
    assert.equal(byId('calculator-summary-pdf').getAttribute('aria-busy'),undefined);
    assert.match(byId('calculator-message').textContent,/later edits are not included/);
  }passed++;

  // Every calculator's Excel register receives its complete clicked draft, including hidden settings and exact decimals.
  const registerMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  for(const id of ['steel_vermiculite','steel_board','ductwork']) {
    entry=setup({CALCULATOR:{B9:2.3456789},SETTINGS:{D37:0.123456789}});entry.definition.id=id;
    const pendingRegister=deferred();let registerBody,registerPath,registerHeaders;
    audit.setFetch((path,options)=>{registerPath=path;registerBody=JSON.parse(options.body);registerHeaders=options.headers;return pendingRegister.promise;});
    const registerRun=audit.downloadExcelRegister();
    assert.equal(audit.state.action,true);assert.equal(byId('calculator-excel').disabled,true);assert.equal(byId('calculator-pdf').disabled,true);assert.equal(byId('calculator-template').disabled,true);
    assert.equal(byId('calculator-excel').getAttribute('aria-busy'),'true');assert.equal(byId('calculator-excel').getAttribute('aria-label'),'Preparing XLSX Schedule…');
    audit.setInput(entry,'CALCULATOR','B9',9.87654321);
    pendingRegister.resolve(fileSaved('APPENDIX A.xlsx'));await registerRun;
    assert.equal(registerPath,`/api/calculators/${id}/register.xlsx`);assert.equal(registerHeaders.Accept,'application/json');
    assert.deepEqual(registerBody,{inputs:{CALCULATOR:{B9:2.3456789},SETTINGS:{D37:0.123456789}},download:{project_token:null}});
    assert.match(byId('calculator-message').textContent,/saved to C:\/Downloads\/APPENDIX A.xlsx/);
    assert.equal(entry.inputs.CALCULATOR.B9,9.87654321);assert.equal(JSON.parse(entry.saved).CALCULATOR.B9,2.3456789);
    assert.equal(audit.state.action,false);assert.equal(byId('calculator-excel').disabled,false);assert.equal(byId('calculator-pdf').disabled,false);
    assert.equal(byId('calculator-excel').getAttribute('aria-busy'),undefined);assert.equal(byId('calculator-excel').getAttribute('aria-label'),'Download XLSX Schedule');
  }passed++;

  // Focused numeric edits are validated before either export and retain exact draft precision.
  for(const [download,mime] of [[audit.downloadExcelRegister,registerMime],[audit.downloadMaterialsSummaryPdf,'application/pdf']]) {
  entry=setup();const exportInput=audit.makeControl({column:2,address:'B9',value:1,type:'number'},9,entry,'Length');
  await exportInput.emit('focus');exportInput.value='7.654321987';await exportInput.emit('input');context.document.activeElement=exportInput;
  let focusedExportBody;audit.setFetch(async(path,options)=>{focusedExportBody=JSON.parse(options.body);return fileSaved();});
  await download();assert.equal(exportInput.blurred,true);assert.equal(focusedExportBody.inputs.CALCULATOR.B9,7.654321987);assert.equal(entry.inputs.CALCULATOR.B9,7.654321987);
  }passed++;

  // Dropdown blur validation and existing invalid/busy drafts block all downloads without a network request.
  entry=setup();const strictChoices=Array.from({length:41},(_,index)=>`Product ${index}`);
  const exportChoice=audit.makeControl({column:1,address:'A9',type:'select',value:'Product 0',options:strictChoices},9,entry,'Product').children[0];
  exportChoice.value='Unlisted product';await exportChoice.emit('input');context.document.activeElement=exportChoice;
  let blockedDownloads=0;audit.setFetch(async()=>{blockedDownloads++;throw new Error('Download should be blocked');});
  await audit.downloadExcelRegister();await audit.downloadSchedulePdf();await audit.downloadMaterialsSummaryPdf();
  assert.equal(blockedDownloads,0);assert.equal(entry.invalid.size,1);assert.equal(byId('calculator-excel').disabled,true);assert.equal(byId('calculator-pdf').disabled,true);assert.equal(byId('calculator-summary-pdf').disabled,true);
  entry=setup();audit.state.action=true;await audit.downloadExcelRegister();await audit.downloadSchedulePdf();await audit.downloadMaterialsSummaryPdf();assert.equal(blockedDownloads,0);audit.state.action=false;passed++;

  // Switching calculators during export keeps both drafts and names the captured document correctly.
  for(const [download,mime,filename] of [[audit.downloadExcelRegister,registerMime,'APPENDIX A.xlsx'],[audit.downloadMaterialsSummaryPdf,'application/pdf','ceasefire-steel_board-materials-summary.pdf']]) {
  entry=setup({CALCULATOR:{B9:4.1234567}});const switchedRegister=deferred();let switchedBody;
  audit.setFetch((path,options)=>{switchedBody=JSON.parse(options.body);return switchedRegister.promise;});const switchedRun=download();
  const switchedEntry={...entry,definition:{...entry.definition,id:'ductwork',title:'Ductwork'},inputs:{CALCULATOR:{B9:99}},saved:'{}',invalid:new Map()};
  audit.state.entries.set('ductwork',switchedEntry);audit.state.current='ductwork';
  switchedRegister.resolve(fileSaved(filename));await switchedRun;
  assert.equal(audit.current(),switchedEntry);assert.equal(switchedEntry.inputs.CALCULATOR.B9,99);assert.equal(entry.inputs.CALCULATOR.B9,4.1234567);assert.equal(switchedBody.inputs.CALCULATOR.B9,4.1234567);
  assert.ok(byId('calculator-message').textContent.includes(`saved to C:/Downloads/${filename}`));assert.match(byId('calculator-message').textContent,/current draft was kept/);
  }passed++;

  // Every calculator export captures its destination at click time. A later
  // Save As capability or New-project reset cannot redirect an in-flight file;
  // the next click uses the new target, including the template-only payload.
  const priorProjectBridge=context.window.CeasefireProject;
  try {
    for(const [download,action,filename,withDetails,template] of [
      [audit.downloadSchedulePdf,'report.pdf','APPENDIX A.pdf',true,false],
      [audit.downloadExcelRegister,'register.xlsx','APPENDIX A.xlsx',false,false],
      [audit.downloadMaterialsSummaryPdf,'summary.pdf','materials-summary.pdf',true,false],
      [audit.exportTemplate,'template','schedule-template.xlsx',false,true],
    ]) {
      entry=setup({CALCULATOR:{B9:7.123456789012345},SETTINGS:{B6:.123456789012345}});
      let projectToken='project-before-save-as',projectNo='CF-before';
      context.window.CeasefireProject={downloadTarget:()=>({project_token:projectToken}),details:()=>({project_no:projectNo})};
      let pending=deferred(),sent;
      audit.setFetch((path,options)=>{sent={path,body:JSON.parse(options.body),method:options.method,headers:options.headers};return pending.promise;});
      const firstRun=download();
      assert.equal(sent.path,`/api/calculators/steel_board/${action}`);assert.equal(sent.method,'POST');assert.equal(sent.headers.Accept,'application/json');
      assert.deepEqual(sent.body.download,{project_token:'project-before-save-as'});
      if(template)assert.deepEqual(sent.body,{download:{project_token:'project-before-save-as'}});
      else {assert.equal(sent.body.inputs.CALCULATOR.B9,7.123456789012345);assert.equal(sent.body.inputs.SETTINGS.B6,.123456789012345);}
      assert.deepEqual(sent.body.project_details,withDetails?{project_no:'CF-before'}:undefined);
      projectToken='project-after-save-as';projectNo='CF-after';
      pending.resolve(fileSaved(filename,'project',`C:/Before/${filename}`));await firstRun;
      assert.ok(byId('calculator-message').textContent.includes(`saved to C:/Before/${filename}`));assert.equal(audit.state.action,false);
      pending=deferred();const secondRun=download();assert.deepEqual(sent.body.download,{project_token:'project-after-save-as'});
      projectToken=null;projectNo='';pending.resolve(fileSaved(filename,'project',`C:/After/${filename}`));await secondRun;
      assert.ok(byId('calculator-message').textContent.includes(`saved to C:/After/${filename}`));
      audit.setFetch(async(path,options)=>{sent={path,body:JSON.parse(options.body)};return fileSaved(filename);});await download();
      assert.deepEqual(sent.body.download,{project_token:null});assert.ok(byId('calculator-message').textContent.includes(`saved to C:/Downloads/${filename}`));
      assert.equal(entry.inputs.CALCULATOR.B9,7.123456789012345);assert.equal(entry.inputs.SETTINGS.B6,.123456789012345);
    }
  }finally{if(priorProjectBridge===undefined)delete context.window.CeasefireProject;else context.window.CeasefireProject=priorProjectBridge;}
  passed++;

  // Generation/network failures, wrong MIME and invalid save receipts never
  // claim a saved file or leave either button busy.
  for(const [download,mime,buttonId,label] of [[audit.downloadExcelRegister,registerMime,'calculator-excel','Download XLSX Schedule'],[audit.downloadSchedulePdf,'application/pdf','calculator-pdf','Download PDF Schedule'],[audit.downloadMaterialsSummaryPdf,'application/pdf','calculator-summary-pdf','Download PDF Summary']]) {
    const failures=[
      {response:{ok:false,status:400,headers:{get:()=> 'application/json'},json:async()=>({error:'Source validation detail'})},message:/Source validation detail/},
      {response:{ok:false,status:500,headers:{get:()=> 'text/html'},json:async()=>{throw new Error('Must not parse HTML');}},message:/\(500\)/},
      {response:{ok:true,headers:{get:()=> 'text/html'}},message:/did not return/},
      {response:{ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:true,path:'',filename:'report.pdf',destination:'downloads'})},message:/did not confirm/},
      {response:{ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:false,path:'C:/Downloads/report.pdf',filename:'report.pdf',destination:'downloads'})},message:/did not confirm/},
      {response:{ok:true,headers:{get:()=> 'application/json'},json:async()=>{throw new Error('Invalid JSON');}},message:/did not confirm/},
      {error:new Error('Connection unavailable'),message:/Connection unavailable/},
    ];
    for(const failure of failures) {
      entry=setup({CALCULATOR:{B9:0.123456789}});const bodyCount=context.document.body.children.length,inputsBefore=JSON.stringify(entry.inputs),savedBefore=entry.saved;
      audit.setFetch(async()=>{if(failure.error)throw failure.error;return failure.response;});await download();
      assert.match(byId('calculator-message').textContent,failure.message);assert.equal(context.document.body.children.length,bodyCount);
      assert.equal(audit.state.action,false);assert.equal(byId('calculator-excel').disabled,false);assert.equal(byId('calculator-pdf').disabled,false);assert.equal(byId('calculator-summary-pdf').disabled,false);assert.equal(byId(buttonId).getAttribute('aria-label'),label);assert.equal(byId(buttonId).getAttribute('aria-busy'),undefined);
      assert.equal(JSON.stringify(entry.inputs),inputsBefore);assert.equal(entry.saved,savedBefore);
    }
  }passed++;

  // Template failures use the same validated receipt contract and restore the
  // controls without altering or saving the current calculator draft.
  entry=setup({CALCULATOR:{B9:8.123456789012345}});const templateBefore=JSON.stringify(entry.inputs);
  audit.setFetch(async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:true,path:'C:/Downloads/template.xlsx',filename:'template.xlsx',destination:'unrecognized'})}));
  await audit.exportTemplate();assert.match(byId('calculator-message').textContent,/did not confirm/);assert.equal(audit.state.action,false);
  assert.equal(byId('calculator-template').disabled,false);assert.equal(JSON.stringify(entry.inputs),templateBefore);passed++;

  // Import and the four distinct exports retain their actions and requested order.
  const registerMarkup=fs.readFileSync('static/index.html','utf8');
  for(const [id,label] of [['calculator-import','Import XLSX Schedule'],['calculator-template','Export Template'],['calculator-excel','Download XLSX Schedule'],['calculator-pdf','Download PDF Schedule'],['calculator-summary-pdf','Download PDF Summary']]){
    assert.match(registerMarkup,new RegExp(`id="${id}"[^>]*class="[^"]*icon-only[^"]*"[^>]*aria-label="${label}"[^>]*title="${label}"`));
  }
  assert.match(registerMarkup,/id="calculator-template"[^>]*class="[^"]*excel-button[^"]*icon-only[^"]*"/);
  assert.match(registerMarkup,/id="calculator-template"[^>]*title="Export Template"[\s\S]*?<span class="download-arrow"[^>]*><svg[^>]*>[\s\S]*?<\/svg><\/span>/);
  assert.match(registerMarkup,/id="calculator-reset"[^>]*class="[^"]*secondary[^"]*"[^>]*aria-label="Reset Calc"[^>]*title="Reset Calc"[\s\S]*?pricing-reset-symbol/);
  assert.match(registerMarkup,/id="calculator-recalculate"[^>]*class="[^"]*icon-only[^"]*calculator-symbol-button[^"]*"[^>]*aria-label="Recalculate"[^>]*title="Recalculate"/);
  for(const id of ['calculator-reset','calculator-recalculate'])assert.match(registerMarkup,new RegExp(`id="${id}"[^>]*class="[^"]*secondary[^"]*"`));
  assert.doesNotMatch(registerMarkup,/id="calculator-reset"[^>]*pricing-reset-button/);
  assert.equal((registerMarkup.match(/id="calculator-recalculate"/g)||[]).length,1);
  const toolbarCss=fs.readFileSync('static/calculators.css','utf8');
  assert.doesNotMatch(toolbarCss,/\.calculator-workspace-heading #calculator-template\{[^}]*background/);
  assert.match(toolbarCss,/\.calculator-product-totals h4\{[^}]*margin:0 0 7px/);
  for(const [className,background,color] of [['calculator-export-excel','var(--navy)','#fff'],['calculator-export-pdf','#c5221f','#fff']]){
    assert.ok(registerMarkup.includes(className));assert.ok(toolbarCss.includes(`.calculator-tools .${className}{background:${background};color:${color};`));
  }
  const sharedButtonCss=fs.readFileSync('static/styles.css','utf8');
  assert.match(registerMarkup,/id="calculator-import"[^>]*class="[^"]*excel-button[^"]*icon-only[^"]*"/);
  assert.doesNotMatch(registerMarkup,/id="calculator-save"/);
  assert.ok(sharedButtonCss.includes('.button.excel-button{color:#fff;background:var(--navy);'));
  assert.ok(sharedButtonCss.includes('.button.save-button{color:#332600;background:#ffdb66;'));
  assert.ok(toolbarCss.includes(':hover:not(:disabled)'));assert.ok(toolbarCss.includes(':focus-visible'));assert.ok(toolbarCss.includes(':disabled{opacity:.5;filter:none;cursor:not-allowed}'));
  for(const id of ['calculator-excel','calculator-pdf','calculator-summary-pdf','calculator-reset','calculator-recalculate'])assert.equal(byId(id).listeners.click.length,1);passed++;

  // Status alignment keeps the original output anchors and refreshes their text
  // once, without adding a second calculated value or altering exact inputs.
  entry=setup({CALCULATOR:{D6:12.3456789012345}});entry.definition.id='steel_vermiculite';entry.definition.schedule.sheet='SCHEDULE';
  entry.definition.sheets=[{name:'CALCULATOR',header_rows:[],merges:['H5:N5','H9:N10','H20:N21'],section_cells:['H5'],table_layout:'projected',
    presentation_tables:[{first_row:5,last_row:21,columns:[8,9,10,11,12,13,14],column_widths:Array(7).fill(1),width_mode:'fit',table_kind:'form',title_address:'H5',label:'Thickness and quantities'}]}];
  entry.result=result(copy(entry.inputs),{max_column:14,rows:[
    {row:5,cells:[{column:8,address:'H5',value:'02 THICKNESS & QUANTITIES',presentation:{role:'section'}}]},
    {row:9,cells:[{column:8,address:'H9',value:'PUBLISHED - TABLE LOOKUP',calculated:true}]},
    {row:20,cells:[{column:8,address:'H20',value:'QUANTIFIED - ESTIMATE',calculated:true}]},
  ]});
  const statusRaw=JSON.stringify(entry.result);realRender(entry);audit.setRender(realRender);
  const statusOutput=address=>byId('calculator-grid').querySelectorAll('[data-calculator-output]').find(node=>node.dataset.calculatorOutput===address);
  const retainedAnnotationStatus=statusOutput('H9');
  for(const [address,text] of [['H9','PUBLISHED - TABLE LOOKUP'],['H20','QUANTIFIED - ESTIMATE']]){
    const output=statusOutput(address);assert.equal(output.colSpan,7);assert.equal(output.classList.contains('calculator-split-status'),true);
    assert.equal(output.children.length,1);assert.equal(output.children[0].children.length,2);assert.equal(output.children[0].children[0].textContent,text);
    assert.equal(output.children[0].children[1].getAttribute('aria-hidden'),'true');
    assert.equal(output.children[0].children[0].dataset.calculatorOutput,undefined);
  }
  assert.equal(statusOutput('H5').classList.contains('calculator-align-center'),false);assert.equal(JSON.stringify(entry.result),statusRaw);
  const statusUpdate=copy(entry.result);statusUpdate.rows[1].cells[0].value='HOLD - REVIEW SOURCE';audit.setRequest(async()=>statusUpdate);await audit.calculate();
  assert.equal(statusOutput('H9'),retainedAnnotationStatus);assert.equal(retainedAnnotationStatus.children[0].children[0].textContent,'HOLD - REVIEW SOURCE');
  assert.equal(retainedAnnotationStatus.children.length,1);assert.equal(entry.inputs.CALCULATOR.D6,12.3456789012345);passed++;

  // The two browser labels are aliases at exact coordinates, never raw data edits.
  for(const [id,sheet,address,raw,shown] of [['steel_board','SETTINGS','Q5','Plain-English message (display only)','Description'],['ductwork','SUMMARY','A17','PENETRATION ANGLES — LENGTH BY SIZE AND LOCATION','PENETRATION ANGLES']]){
    entry=setup();entry.definition.id=id;entry.sheet=sheet;
    assert.equal(audit.sourceDisplayText(raw,entry,address),shown);assert.equal(audit.sourceDisplayText(raw,entry,'Z99'),raw);
  }passed++;

  // Cancelled file pickers and oversized workbooks do not read or submit content.
  entry = setup(); requests = 0; audit.setRequest(async () => { requests++; });
  byId('calculator-import-file').files = []; await audit.importSchedule();
  byId('calculator-import-file').files = [{ name: 'large.xlsx', size: 6 * 1024 * 1024 }]; await audit.importSchedule(); assert.equal(requests, 0); passed++;

  // Dynamic schedules keep source addresses, all hidden inputs and precise
  // values while creating only the bounded set of controls returned by the API.
  function dynamicSetup(rows=[9], inputs={CALCULATOR:{A9:null,B9:null,M9:null},SETTINGS:{B6:0.123456789012345}}) {
    const currentEntry=setup(inputs);
    currentEntry.definition.schedule={sheet:'CALCULATOR',first_row:9,last_row:1008,header_row:8,line_numbers:true,columns:[
      {column:'A',label:'Member',editable:true},{column:'B',label:'Length',editable:true},{column:'M',label:'Advanced layout',editable:true},{column:'Z',label:'Generated',generated:true,editable:false}]};
    currentEntry.definition.sheets[0].max_row=1008;
    currentEntry.scheduleRows=[...rows];currentEntry.savedRows=JSON.stringify(rows);
    audit.setRender(realRender);
    audit.setRequest(async(path,options)=>{
      const body=JSON.parse(options.body),view=body.schedule_view||{rows:currentEntry.scheduleRows,offset:0,limit:60};
      const scheduleRows=view.rows||currentEntry.scheduleRows;
      return result(body.inputs,{max_row:1008,visible_columns:[1,2],schedule_view:{...view,rows:scheduleRows,total_rows:scheduleRows.length,capacity:1000},rows:scheduleRows.slice(view.offset,view.offset+view.limit).map(row=>({row,cells:[
        {column:1,address:`A${row}`,editable:true,type:'text',value:body.inputs.CALCULATOR?.[`A${row}`]??null},
        {column:2,address:`B${row}`,editable:true,type:'number',value:body.inputs.CALCULATOR?.[`B${row}`]??null}]}))});
    });
    return currentEntry;
  }
  entry=dynamicSetup();await audit.calculate();
  assert.equal(renderedControls().length,2);assert.equal(byId('calculator-grid').querySelectorAll('[data-schedule-remove]').length,1);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-schedule-add]').length,1);assert.equal(audit.dirty(entry),false);
  assert.equal(byId('calculator-grid').children.at(-1).className,'calculator-schedule-tools');
  const scheduleAdd=byId('calculator-grid').querySelectorAll('[data-schedule-add]')[0],scheduleUndo=byId('calculator-grid').querySelectorAll('[data-schedule-undo]')[0];
  assert.equal(scheduleAdd.textContent,'');assert.equal(scheduleAdd.title,'Add row');assert.equal(scheduleAdd.getAttribute('aria-label'),'Add row');assert.match(scheduleAdd.children[0].textContent,/\+/);
  assert.equal(scheduleUndo.textContent,'');assert.equal(scheduleUndo.title,'Undo remove');assert.equal(scheduleUndo.getAttribute('aria-label'),'Undo remove');assert.match(scheduleUndo.children[0].textContent,/↶/);
  assert.doesNotMatch(fs.readFileSync('static/index.html','utf8'),/id="calculator-page-status"/);
  assert.doesNotMatch(fs.readFileSync('static/calculators.js','utf8'),/calculator-page-status/);passed++;

  // Adding creates explicitly blank editable cells, including advanced inputs,
  // and changing only the displayed row list still marks the project unsaved.
  await audit.addScheduleRow();assert.deepEqual(copy(entry.scheduleRows),[9,10]);
  assert.equal(entry.inputs.CALCULATOR.A10,null);assert.equal(entry.inputs.CALCULATOR.B10,null);assert.equal(entry.inputs.CALCULATOR.M10,null);
  assert.equal(entry.inputs.CALCULATOR.Z10,undefined);assert.equal(entry.inputs.SETTINGS.B6,0.123456789012345);assert.equal(audit.dirty(entry),true);
  assert.deepEqual(copy(audit.projectSnapshot().steel_board.schedule_rows),[9,10]);passed++;

  // Remove/Undo restores both precise values and absent overrides, without
  // changing settings or moving the other row's formula addresses.
  entry=dynamicSetup([9,10],{CALCULATOR:{A9:'Original',B9:7.123456789012345,M9:'Optional exact',A10:'Keep',B10:2},SETTINGS:{B6:0.123456789012345}});await audit.calculate();
  const removeButton=byId('calculator-grid').querySelectorAll('[data-schedule-remove]')[0];
  assert.equal(removeButton.tagName,'button');assert.equal(removeButton.type,'button');
  assert.equal(removeButton.getAttribute('aria-label'),'Remove line 1');assert.equal(removeButton.title,'Remove line 1');
  assert.equal(removeButton.children[0].getAttribute('aria-hidden'),'true');
  const beforeRemove=JSON.stringify(entry.inputs);await removeButton.emit('click');
  assert.deepEqual(copy(entry.scheduleRows),[10]);for(const cell of ['A9','B9','M9'])assert.equal(entry.inputs.CALCULATOR[cell],null);
  assert.equal(entry.inputs.CALCULATOR.A10,'Keep');assert.equal(entry.inputs.SETTINGS.B6,0.123456789012345);
  await byId('calculator-grid').querySelectorAll('[data-schedule-undo]')[0].emit('click');assert.deepEqual(copy(entry.scheduleRows),[9,10]);assert.equal(JSON.stringify(entry.inputs),beforeRemove);assert.equal(audit.dirty(entry),false);passed++;

  // The final row remains an empty placeholder; Undo must never overwrite a
  // new value subsequently entered into that same physical row.
  entry=dynamicSetup([9],{CALCULATOR:{A9:'Deleted',B9:7.123456789012345},SETTINGS:{B6:1}});await audit.calculate();await audit.removeScheduleRow(9);
  assert.deepEqual(copy(entry.scheduleRows),[9]);assert.equal(entry.inputs.CALCULATOR.A9,null);
  audit.setInput(entry,'CALCULATOR','A9','Replacement');assert.equal(entry.removedRows.length,0);await audit.undoScheduleRemove();assert.equal(entry.inputs.CALCULATOR.A9,'Replacement');passed++;

  // Removing a sole non-first source row and undoing restores exactly its
  // original row list rather than leaving an extra empty placeholder behind.
  entry=dynamicSetup([19],{CALCULATOR:{A19:'Line 11',B19:1.23456789012345}});await audit.calculate();await audit.removeScheduleRow(19);assert.deepEqual(copy(entry.scheduleRows),[9]);
  await audit.undoScheduleRemove();assert.deepEqual(copy(entry.scheduleRows),[19]);assert.equal(entry.inputs.CALCULATOR.B19,1.23456789012345);passed++;

  // Editing a different remaining row does not destroy the removed-row undo
  // and the undo restores only its target inputs.
  entry=dynamicSetup([9,10],{CALCULATOR:{A9:'Restore',A10:'Original other'}});await audit.calculate();await audit.removeScheduleRow(9);
  audit.setInput(entry,'CALCULATOR','A10','Updated other');await audit.undoScheduleRemove();assert.equal(entry.inputs.CALCULATOR.A9,'Restore');assert.equal(entry.inputs.CALCULATOR.A10,'Updated other');passed++;

  // At full capacity the browser creates only sixty rows. Vertical spacers
  // retain the complete scroll range; offscreen exact input remains in state.
  entry=dynamicSetup(Array.from({length:1000},(_,index)=>index+9),{CALCULATOR:{A9:'First',B9:7.123456789012345,A1008:'Last',B1008:9.987654321098765}});await audit.calculate();
  assert.equal(renderedControls().length,120);assert.equal(byId('calculator-grid').querySelectorAll('[data-schedule-remove]').length,60);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-schedule-add]')[0].disabled,true);
  const virtualTable=renderedTable(),virtualBody=virtualTable.children.at(-1);
  assert.equal(virtualTable.classList.contains('calculator-virtual-schedule'),true);assert.equal(virtualTable.getAttribute('aria-rowcount'),'1001');
  assert.equal(virtualBody.children.at(-1).children[0].style.height,`${940*96}px`);assert.equal(entry.inputs.CALCULATOR.B1008,9.987654321098765);passed++;

  // Scrolling to the end asks for the final bounded window with every draft
  // input retained, then renders its actual source Line 1000.
  const nativeSetTimeout=context.setTimeout;let scrollTimer;
  context.setTimeout=(callback)=>{scrollTimer=callback;return 1;};
  const viewport=byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0];viewport.clientHeight=600;viewport.scrollTop=999*96;viewport.scrollLeft=333;
  await viewport.emit('scroll');assert.ok(scrollTimer);scrollTimer();await flush();
  assert.equal(entry.scheduleViewport.offset,940);assert.equal(renderedControls().length,120);
  assert.equal(renderedControls().at(-1).dataset.calculatorCell,'B1008');assert.equal(renderedControls().at(-1).value,'9.99');
  assert.equal(entry.inputs.CALCULATOR.B9,7.123456789012345);assert.equal(entry.inputs.CALCULATOR.B1008,9.987654321098765);
  assert.equal(byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0].scrollLeft,333);
  context.setTimeout=nativeSetTimeout;passed++;

  // Invalid text stays attached to its source field and blocks a distant
  // viewport change rather than disappearing into an offscreen draft.
  entry=dynamicSetup(Array.from({length:1000},(_,index)=>index+9),{CALCULATOR:{B9:3.123456789}});await audit.calculate();
  entry.invalid.set('CALCULATOR!B9','broken');let invalidScrollRequests=0;audit.setRequest(async()=>{invalidScrollRequests++;});
  const invalidViewport=byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0];invalidViewport.scrollTop=900*96;await invalidViewport.emit('scroll');
  assert.equal(invalidViewport.scrollTop,0);assert.equal(invalidScrollRequests,0);assert.equal(entry.invalid.get('CALCULATOR!B9'),'broken');assert.equal(entry.inputs.CALCULATOR.B9,3.123456789);passed++;

  // An invalid editor at the end of a buffered window remains at its exact
  // prior viewport, rather than jumping to the first row of that window.
  entry=dynamicSetup(Array.from({length:1000},(_,index)=>index+9),{CALCULATOR:{B1008:3.123456789}});
  entry.scheduleViewport={offset:940,top:95200,left:333};await audit.calculate();
  entry.invalid.set('CALCULATOR!B1008','broken');let blockedTailRequests=0;audit.setRequest(async()=>{blockedTailRequests++;});
  const tailViewport=byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0];tailViewport.scrollTop=0;tailViewport.scrollLeft=100;await tailViewport.emit('scroll');
  assert.equal(tailViewport.scrollTop,95200);assert.equal(tailViewport.scrollLeft,333);assert.equal(entry.scheduleViewport.top,95200);assert.equal(blockedTailRequests,0);
  assert.equal(entry.invalid.get('CALCULATOR!B1008'),'broken');assert.equal(entry.inputs.CALCULATOR.B1008,3.123456789);passed++;

  // Invalid Line 1 can leave view during permitted interior scrolling. A later
  // distant jump must reveal that editor below the header, rather than merely
  // returning to Line 30. Hidden custom controls must never become the target.
  entry=dynamicSetup(Array.from({length:1000},(_,index)=>index+9),{CALCULATOR:{B9:3.123456789}});await audit.calculate();
  const interiorViewport=byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0];
  interiorViewport.clientHeight=600;interiorViewport.clientWidth=700;interiorViewport.getBoundingClientRect=()=>({top:100,left:0,width:700,height:600});
  interiorViewport.querySelector=()=>({getBoundingClientRect:()=>({height:64})});
  const invalidFirst=renderedControls().find(control=>control.dataset.calculatorCell==='B9');
  invalidFirst.getClientRects=()=>[{}];invalidFirst.getBoundingClientRect=()=>({top:100+84-interiorViewport.scrollTop,left:1100-interiorViewport.scrollLeft,width:120,height:40});
  const hiddenCustom=element('input');hiddenCustom.hidden=true;hiddenCustom.dataset={calculatorCustomCell:'B9',calculatorSheet:'CALCULATOR'};hiddenCustom.getClientRects=()=>[{}];hiddenCustom.getBoundingClientRect=()=>{throw Error('Hidden custom editor must not be revealed');};interiorViewport.append(hiddenCustom);
  entry.invalid.set('CALCULATOR!B9','broken');let interiorRequests=0;audit.setRequest(async()=>{interiorRequests++;});
  interiorViewport.scrollTop=29*96;await interiorViewport.emit('scroll');assert.equal(entry.scheduleViewport.top,29*96);
  interiorViewport.scrollTop=900*96;await interiorViewport.emit('scroll');
  assert.equal(interiorRequests,0);assert.equal(interiorViewport.scrollTop,12);assert.equal(interiorViewport.scrollLeft,528);
  assert.equal(entry.invalid.get('CALCULATOR!B9'),'broken');assert.equal(entry.inputs.CALCULATOR.B9,3.123456789);passed++;

  // A narrow viewport cannot fit an oversized editor between both margins.
  // Repeated native scroll events must keep its start aligned, not alternate
  // between its start and end edges and create a scroll-event loop.
  entry=dynamicSetup(Array.from({length:1000},(_,index)=>index+9),{CALCULATOR:{B209:3.123456789}});
  entry.scheduleViewport={offset:200,top:220*96,left:333};await audit.calculate();
  const narrowViewport=byId('calculator-grid').querySelectorAll('[data-schedule-viewport]')[0];
  narrowViewport.clientHeight=90;narrowViewport.clientWidth=100;narrowViewport.getBoundingClientRect=()=>({top:100,left:0,width:100,height:90});
  narrowViewport.querySelector=()=>({getBoundingClientRect:()=>({height:64})});
  const oversized=renderedControls().find(control=>control.dataset.calculatorCell==='B209');
  oversized.getClientRects=()=>[{}];oversized.getBoundingClientRect=()=>({top:100+200*96+84-narrowViewport.scrollTop,left:1100-narrowViewport.scrollLeft,width:120,height:40});
  entry.invalid.set('CALCULATOR!B209','broken');let narrowRequests=0;audit.setRequest(async()=>{narrowRequests++;});
  narrowViewport.scrollTop=900*96;
  for(let repeat=0;repeat<4;repeat++){
    await narrowViewport.emit('scroll');assert.equal(narrowViewport.scrollTop,200*96+12);assert.equal(narrowViewport.scrollLeft,1092);
  }
  assert.equal(narrowRequests,0);assert.equal(entry.invalid.get('CALCULATOR!B209'),'broken');assert.equal(entry.inputs.CALCULATOR.B209,3.123456789);passed++;

  // Project saving acknowledges row metadata independently of inputs. Later
  // row additions remain dirty when an earlier save completes.
  entry=dynamicSetup([9]);const captured=audit.projectSnapshot();entry.scheduleRows=[9,10];audit.markProjectSaved(captured);assert.equal(audit.dirty(entry),true);
  audit.markProjectSaved(audit.projectSnapshot());assert.equal(audit.dirty(entry),false);passed++;

  // Imports use the server's complete row extent (including deliberate gaps)
  // and reset an old scrolled viewport while keeping non-schedule inputs.
  entry=dynamicSetup([9]);entry.scheduleViewport={offset:500,top:48000,left:50};let importedWorksheet;
  audit.setRequest(async(path,options)=>{
    if(path.endsWith('/import'))return {inputs:{CALCULATOR:{A9:'Start',B11:1.23456789012345},SETTINGS:{B6:0.123456789012345}},imported_rows:2,schedule_rows:[9,10,11]};
    importedWorksheet=JSON.parse(options.body);return result(importedWorksheet.inputs,{schedule_view:{...importedWorksheet.schedule_view,total_rows:3},rows:[]});
  });
  byId('calculator-import-file').files=[{name:'schedule.xlsx',size:600}];const dynamicImport=audit.importSchedule();await flush();await byId('calculator-confirm-dialog').close('confirm');await dynamicImport;
  assert.deepEqual(copy(entry.scheduleRows),[9,10,11]);assert.equal(importedWorksheet.schedule_view.offset,0);assert.equal(entry.inputs.CALCULATOR.B11,1.23456789012345);assert.equal(entry.inputs.SETTINGS.B6,0.123456789012345);passed++;

  assert.match(fs.readFileSync('static/app.js', 'utf8'), /view === "calculators".*CeasefireCalculators\?\.open/);
  console.log(`Calculator UI checks passed: ${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
