const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const elements = new Map();
const scrollCalls = [];
function element(tag='div') {
  return {
    tagName: tag, value: '', textContent: '', dataset: {}, children: [], disabled: false,
    listeners: {}, parts: new Map(), options: [], files: [], validity: {badInput:false},
    classList: {add(){},toggle(){}}, setAttribute(){},removeAttribute(){},focus(){},
    addEventListener(event, fn, options={}) { (this.listeners[event] ||= []).push({fn,once:options.once}); },
    emit(event) { const callbacks = [...(this.listeners[event] || [])]; this.listeners[event] = (this.listeners[event]||[]).filter(x=>!x.once); return Promise.all(callbacks.map(x=>x.fn())); },
    append(...children){this.children.push(...children);this.options=this.children;},
    replaceChildren(...children){this.children=children;this.options=children;},
    querySelector(selector){if(!this.parts.has(selector))this.parts.set(selector,element());return this.parts.get(selector);},
    closest(selector){return this.querySelector(`parent:${selector}`);},
    showModal(){assert.ok(!this.open);this.open=true;},
    close(value){this.returnValue=value;this.open=false;return this.emit('close');},
    click(){this.clicked=true;}, remove(){},
  };
}
function byId(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}
const context = {
  document:{getElementById:id=>['workflow','work-summary'].includes(id)?null:byId(id),querySelector:selector=>byId(`selector:${selector}`),querySelectorAll:()=>[],createElement:element,createTextNode:text=>text,body:element()},
  window:{addEventListener(){},scrollTo(options){scrollCalls.push(options);}}, Intl, Number, JSON, Object, Set, Array, String, Promise, Error,
  setTimeout:()=>0,clearTimeout(){},AbortController, console,
  FileReader:class { readAsDataURL(){this.result='data:application/octet-stream;base64,AAAA';queueMicrotask(()=>this.onload());} },
};
vm.createContext(context);
let source=fs.readFileSync('static/app.js','utf8');
source=source.replace(/  bootstrap\(\);\s*\}\)\(\);\s*$/, `
  globalThis.audit={state,savePricing,saveQuote,openQuote,newQuote,confirmReplace,importPricing,exportPricing,makeControl,priceInput,
    quoteDetails,updateQuoteTitle,reportPayload,controlValue,formatNumber,formatMoney,calculate,renderResults,showView,bootstrap,
    setRequest(fn){request=fn;}, setFetch(fn){globalThis.fetch=fn;}};
  renderInputs=()=>{}; renderPricing=()=>{state.pricingDirty=JSON.stringify(state.draft)!==JSON.stringify(state.configuration);};
  globalThis.scheduled=0; scheduleCalculation=()=>{globalThis.scheduled++;};
})();`);
vm.runInContext(source,context);
const {audit}=context;
const copy=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const oldFields=[{cell:'D15',label:'Spray material',type:'select',default:'Old spray',options:['Old spray']}];
const newFields=[{cell:'D15',label:'Spray material',type:'select',default:'New spray',options:['New spray']}];
const oldConfig={inventory:{},rates:{},version:'old'};
const newConfig={inventory:{},rates:{},version:'new'};
function setup(){
  Object.assign(audit.state,{configuration:copy(oldConfig),draft:copy(newConfig),fields:copy(oldFields),currentFields:copy(oldFields),baseline:{inventory:[],rate_groups:{}},quote:null,quoteConfiguration:null,inputs:{D15:'Old spray'},dirty:false,quoteLoadRevision:0,legacyTitle:'',workflow:'workflow',defaultWorkflow:'Intumescent spray to ductwork'});
  for(const id of ['project-no','client','site-address','measurements'])byId(id).value='';
}
let passed=0;
(async()=>{
  setup();
  const put=deferred(),meta=deferred();
  audit.setRequest(path=>path==='/api/configuration'?put.promise:meta.promise);
  const save=audit.savePricing();
  assert.equal(byId('use-current-pricing').disabled,true);
  put.resolve(copy(newConfig)); await flush();
  assert.equal(audit.state.configuration.version,'old');
  assert.equal(audit.state.currentFields[0].options[0],'Old spray');
  audit.state.draft.rates.concurrent={price:17};
  meta.resolve({configuration:copy(newConfig),fields:copy(newFields)}); await save;
  assert.equal(audit.state.configuration.version,'new');
  assert.equal(audit.state.fields[0].options[0],'New spray');
  assert.equal(audit.state.draft.rates.concurrent.price,17);
  assert.equal(byId('use-current-pricing').disabled,false); passed++;

  // Historical quotes retain their own choices after active-library removal.
  audit.setRequest(async()=>({id:'old-quote',title:'Historical',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'workflow'}));
  audit.state.dirty=false;
  await audit.openQuote('old-quote',element('button'));
  assert.equal(audit.state.fields[0].options[0],'Old spray');
  assert.equal(audit.state.currentFields[0].options[0],'New spray');
  assert.equal(audit.state.quoteConfiguration.version,'old');
  assert.equal(audit.state.workflow,'workflow');
  const historical=audit.makeControl(audit.state.fields[0],true);
  assert.equal(historical.value,'Old spray');
  assert.ok(historical.options.some(x=>x.value==='Old spray'));
  await audit.newQuote();
  assert.equal(audit.state.quoteConfiguration,null);
  assert.equal(audit.state.fields[0].options[0],'New spray');
  assert.equal(audit.state.inputs.D15,'New spray');assert.equal(audit.state.workflow,'Intumescent spray to ductwork'); passed++;

  // Refresh failure must not mix new prices with old field metadata.
  setup(); audit.setRequest(async path=>{if(path==='/api/configuration')return copy(newConfig);throw new Error('Metadata offline');});
  await audit.savePricing();
  assert.equal(audit.state.configuration.version,'old');
  assert.equal(audit.state.fields[0].options[0],'Old spray');
  assert.match(byId('app-message').textContent,/Pricing was saved/); passed++;

  // Shared dialog responses are isolated even when asynchronous work finishes.
  const first=audit.confirmReplace('First action','First detail','First confirm');
  const second=audit.confirmReplace('Second action','Second detail','Second confirm');
  await flush(); const dialog=byId('discard-dialog');
  assert.equal(dialog.querySelector('h2').textContent,'First action');
  await dialog.close('cancel'); assert.equal(await first,false); await flush();
  assert.equal(dialog.querySelector('h2').textContent,'Second action');
  await dialog.close('confirm');assert.equal(await second,true);passed++;

  // Reject stale import responses and preserve edits made during the read.
  setup(); const imported=deferred();audit.setRequest(()=>imported.promise);
  byId('pricing-import-file').files=[{name:'new.xlsx',size:20}];
  const importRun=audit.importPricing();await flush();
  audit.state.draft.rates.concurrent={price:29};
  imported.resolve({configuration:{inventory:{},rates:{},version:'imported'},summary:{}});
  await importRun;
  assert.equal(audit.state.draft.rates.concurrent.price,29);
  assert.match(byId('app-message').textContent,/Pricing changed while/);assert.ok(!dialog.open);passed++;

  // Cancelling import leaves both active configuration and draft unchanged.
  setup();const before=copy(audit.state.draft);
  audit.setRequest(async()=>({configuration:{inventory:{},rates:{},version:'imported'},summary:{inventory:{added:1},rates:{removed:1}}}));
  byId('pricing-import-file').files=[{name:'new.xlsx',size:20}];
  const cancelImport=audit.importPricing();await flush();
  assert.equal(dialog.querySelector('h2').textContent,'Review imported pricing');
  await dialog.close('cancel');await cancelImport;
  assert.deepEqual(copy(audit.state.draft),before);assert.equal(audit.state.configuration.version,'old');passed++;

  // Accepted import updates the draft only; Save remains a separate operation.
  byId('pricing-import-file').files=[{name:'new.xlsx',size:20}];
  const acceptImport=audit.importPricing();await flush();await dialog.close('confirm');await acceptImport;
  assert.equal(audit.state.draft.version,'imported');assert.equal(audit.state.configuration.version,'old');
  assert.equal(audit.state.currentFields[0].options[0],'Old spray');passed++;

  // Export downloads the captured draft, preserving concurrent edits locally.
  setup();const exported=deferred();let exportBody;
  context.URL={createObjectURL:()=> 'blob:audit',revokeObjectURL(){}};
  audit.setFetch((path,options)=>{exportBody=JSON.parse(options.body);return exported.promise;});
  const exportRun=audit.exportPricing();
  audit.state.draft.rates.concurrent={price:45};
  exported.resolve({ok:true,headers:{get:()=> 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},blob:async()=>({size:100})});
  await exportRun;
  assert.equal(exportBody.configuration.rates.concurrent,undefined);
  assert.equal(audit.state.draft.rates.concurrent.price,45);
  assert.match(byId('app-message').textContent,/Later edits are not included/);passed++;

  // Quote naming is derived in the requested order and reaches report payloads.
  setup(); byId('project-no').value=' P-104 ';byId('client').value=' Client One ';byId('site-address').value=' 10 Example Street ';
  await byId('client').emit('input');
  assert.equal(byId('quote-title').value,'P-104- Client One- 10 Example Street');
  const detailsPayload=audit.reportPayload();
  assert.equal(detailsPayload.title,'P-104- Client One- 10 Example Street');
  assert.equal(detailsPayload.project_no,'P-104');assert.equal(detailsPayload.client,'Client One');assert.equal(detailsPayload.site_address,'10 Example Street');
  byId('project-no').value='';audit.updateQuoteTitle();assert.equal(byId('quote-title').value,'Client One- 10 Example Street');passed++;

  // Metadata-backed saved quotes clear to an untitled new name; legacy names survive.
  audit.state.dirty=false;
  audit.setRequest(async()=>({id:'metadata',title:'P-1- Client- Site',project_no:'P-1',client:'Client',site_address:'Site',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'workflow'}));
  await audit.openQuote('metadata',element('button'));
  assert.equal(byId('quote-title').value,'P-1- Client- Site');
  for(const id of ['project-no','client','site-address'])byId(id).value='';
  audit.updateQuoteTitle();assert.equal(byId('quote-title').value,'Untitled quote');
  audit.setRequest(async()=>({id:'legacy',title:'Original legacy quote',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'workflow'}));
  await audit.openQuote('legacy',element('button'));
  assert.equal(byId('quote-title').value,'Original legacy quote');
  await audit.newQuote();assert.equal(byId('quote-title').value,'Untitled quote');assert.equal(byId('client').value,'');passed++;

  // Formatting untouched quantities and percentages never rounds the source state.
  setup();audit.state.inputs.B15=1/3;audit.state.inputs.B9=1/3;
  const quantityControl=audit.makeControl({cell:'B15',label:'Coverage',type:'number'},true);
  const percentControl=audit.makeControl({cell:'B9',label:'Masking',type:'number'},true);
  assert.equal(quantityControl.value,'0.33');assert.equal(percentControl.value,'33.33');
  await quantityControl.emit('blur');await percentControl.emit('blur');
  assert.equal(audit.state.inputs.B15,1/3);assert.equal(audit.state.inputs.B9,1/3);
  quantityControl.value='12.345';await quantityControl.emit('input');await quantityControl.emit('blur');
  assert.equal(quantityControl.value,'12.35');assert.equal(audit.state.inputs.B15,12.35);
  percentControl.value='12.345';await percentControl.emit('input');await percentControl.emit('blur');
  assert.equal(percentControl.value,'12.35');assert.equal(audit.state.inputs.B9,0.1235);
  assert.equal(audit.formatNumber(2.345),'2.35');assert.equal(audit.formatNumber(-2.345),'-2.35');assert.equal(audit.formatMoney(-2.345),'-$2.35');passed++;

  // Merely viewing or leaving a displayed pricing value must not create an override.
  setup();const item={id:'precise',name:'Precise product',supplier_price:123.456789,markup:.333333333,sales_price:164.609051};
  const priceControl=audit.priceInput('inventory',item,'supplier_price');
  assert.equal(priceControl.value,'123.46');await priceControl.emit('blur');
  assert.equal(audit.state.draft.inventory.precise,undefined);assert.equal(item.supplier_price,123.456789);
  priceControl.value='125.555';await priceControl.emit('input');await priceControl.emit('blur');
  assert.equal(priceControl.value,'125.56');assert.equal(audit.state.draft.inventory.precise.supplier_price,125.56);passed++;

  // Saved workflow labels and summary data remain available without either removed UI control.
  setup();audit.setRequest(async()=>({id:'wrap',title:'Saved wrap quote',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'Fire wrap to ductwork'}));
  await audit.openQuote('wrap',element('button'));let calculationBody;
  audit.setRequest(async(path,options)=>{calculationBody=JSON.parse(options.body);return {summary:{total:1.2345,days:2.345},cells:{},materials:[],errors:{},notes:'Literal product 1.2345',work_summary:'Fire wrap to ductwork\nWrap: 12.35 m² <b>literal label</b>'};});
  await audit.calculate();assert.equal(calculationBody.workflow,'Fire wrap to ductwork');
  assert.equal(audit.state.result.work_summary,'Fire wrap to ductwork\nWrap: 12.35 m² <b>literal label</b>');
  assert.equal(byId('sum-days').textContent,'2.35');assert.equal(byId('sum-total').textContent,'$1.23');
  assert.equal(byId('calculated-notes').textContent,'Literal product 1.2345');passed++;

  // New estimates keep normal defaults but start Notes blank without mutating source metadata.
  const notesField=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields.find(field=>field.cell==='B12');
  assert.equal(notesField.default,'Allowances');
  const currentNotesFields=[...copy(newFields),notesField],sourceNotesFields=JSON.stringify(currentNotesFields);
  setup();audit.setRequest(async path=>{assert.equal(path,'/api/bootstrap');return {configuration:newConfig,fields:currentNotesFields,workflows:['Intumescent spray to ductwork','Fire wrap to ductwork']};});
  await audit.bootstrap();assert.equal(audit.state.workflow,'Intumescent spray to ductwork');assert.equal(audit.state.defaultWorkflow,'Intumescent spray to ductwork');
  assert.equal(audit.reportPayload().workflow,'Intumescent spray to ductwork');assert.deepEqual(copy(audit.state.inputs),{D15:'New spray',B12:''});
  assert.equal(audit.makeControl(audit.state.fields.find(field=>field.cell==='B12'),true).value,'');
  assert.equal(JSON.stringify(currentNotesFields),sourceNotesFields);assert.equal(audit.state.currentFields.find(field=>field.cell==='B12').default,'Allowances');
  audit.renderResults({});passed++;

  // Explicit saved notes, including the former default and deliberate blanks, survive opening, editing and saving.
  for(const savedNotes of ['Allowances','Measured project note','']) {
    setup();audit.state.currentFields=copy(currentNotesFields);
    audit.setRequest(async()=>({id:'notes-quote',title:'Saved notes',configuration:oldConfig,fields:currentNotesFields,inputs:{D15:'New spray',B12:savedNotes},workflow:'Fire wrap to ductwork'}));
    await audit.openQuote('notes-quote',element('button'));assert.equal(audit.state.inputs.B12,savedNotes);
    const savedNotesControl=audit.makeControl(audit.state.fields.find(field=>field.cell==='B12'),true);assert.equal(savedNotesControl.value,savedNotes);
    savedNotesControl.value=`${savedNotes}\nAdded detail`;await savedNotesControl.emit('input');
    let notesBody;audit.setRequest(async(path,options)=>{notesBody=JSON.parse(options.body);return {id:'notes-quote',...notesBody,fields:currentNotesFields};});
    await audit.saveQuote();assert.equal(notesBody.inputs.B12,`${savedNotes}\nAdded detail`);assert.equal(audit.reportPayload().inputs.B12,`${savedNotes}\nAdded detail`);
    assert.equal(audit.state.fields.find(field=>field.cell==='B12').default,'Allowances');
    await audit.newQuote();assert.equal(audit.state.inputs.B12,'');assert.equal(audit.state.inputs.D15,'New spray');
  }passed++;

  // A save in flight captures its explicit notes while keeping later edits and a newly opened estimate independent.
  setup();audit.state.fields=copy(currentNotesFields);audit.state.currentFields=copy(currentNotesFields);audit.state.inputs.B12='Captured note';
  const notesSave=deferred();let notesSaveBody;audit.setRequest((path,options)=>{notesSaveBody=JSON.parse(options.body);return notesSave.promise;});
  const notesSaveRun=audit.saveQuote();audit.state.inputs.B12='Later note';
  notesSave.resolve({id:'notes-race',...notesSaveBody,fields:currentNotesFields});await notesSaveRun;
  assert.equal(notesSaveBody.inputs.B12,'Captured note');assert.equal(audit.state.inputs.B12,'Later note');assert.equal(audit.state.dirty,true);
  audit.state.dirty=false;const oldNotesSave=deferred();let oldNotesBody;audit.setRequest((path,options)=>{oldNotesBody=JSON.parse(options.body);return oldNotesSave.promise;});
  const oldNotesRun=audit.saveQuote();await audit.newQuote();oldNotesSave.resolve({id:'notes-race',...oldNotesBody,fields:currentNotesFields});await oldNotesRun;
  assert.equal(audit.state.quote,null);assert.equal(audit.state.inputs.B12,'');assert.equal(oldNotesBody.inputs.B12,'Later note');passed++;

  // Hidden historical workflow strings, including empty ones, survive note edits, saving and report payloads.
  for(const historicalWorkflow of ['Legacy / mixed scopes','']) {
    setup();audit.setRequest(async()=>({id:'historical-workflow',title:'Historical workflow',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:historicalWorkflow,measurements:'Original note'}));
    await audit.openQuote('historical-workflow',element('button'));
    assert.equal(audit.state.workflow,historicalWorkflow);byId('measurements').value='Updated note';await byId('measurements').emit('input');
    let historicalBody;
    audit.setRequest(async(path,options)=>{assert.equal(path,'/api/quotes/historical-workflow');historicalBody=JSON.parse(options.body);return {id:'historical-workflow',...historicalBody,fields:oldFields};});
    await audit.saveQuote();assert.equal(historicalBody.workflow,historicalWorkflow);assert.equal(historicalBody.measurements,'Updated note');
    assert.deepEqual(historicalBody.configuration,oldConfig);assert.equal(audit.state.workflow,historicalWorkflow);assert.equal(audit.state.dirty,false);
    assert.equal(audit.reportPayload().workflow,historicalWorkflow);
  }passed++;

  // A save response for a previous quote cannot restore its hidden workflow into a new estimate.
  setup();audit.state.workflow='Fire wrap to ductwork';audit.state.quote={id:'prior'};byId('measurements').value='Prior notes';
  const workflowSave=deferred();let workflowSaveBody;
  audit.setRequest((path,options)=>{assert.equal(path,'/api/quotes/prior');workflowSaveBody=JSON.parse(options.body);return workflowSave.promise;});
  const workflowSaveRun=audit.saveQuote();await audit.newQuote();
  workflowSave.resolve({id:'prior',...workflowSaveBody,configuration:oldConfig,fields:oldFields});await workflowSaveRun;
  assert.equal(workflowSaveBody.workflow,'Fire wrap to ductwork');assert.equal(audit.state.workflow,'Intumescent spray to ductwork');
  assert.equal(audit.state.quote,null);assert.equal(audit.state.quoteConfiguration,null);assert.equal(byId('measurements').value,'');assert.equal(audit.state.dirty,false);passed++;

  // Metadata changes made during Save quote remain unsaved and cannot be lost.
  setup();byId('project-no').value='P-2';byId('client').value='Captured Client';byId('site-address').value='Site';audit.updateQuoteTitle();
  const quoteSaved=deferred();let quoteBody;
  audit.setRequest((path,options)=>{quoteBody=JSON.parse(options.body);return quoteSaved.promise;});
  const saveQuote=audit.saveQuote();byId('client').value='Later Client';await byId('client').emit('input');
  quoteSaved.resolve({id:'saved',...quoteBody,configuration:oldConfig,fields:oldFields});await saveQuote;
  assert.equal(quoteBody.client,'Captured Client');assert.equal(audit.state.dirty,true);
  assert.equal(byId('quote-title').value,'P-2- Later Client- Site');passed++;

  // Clearing metadata during the first save of a renamed legacy quote must
  // refresh its fallback title when the persisted quote becomes metadata-based.
  setup();audit.state.legacyTitle='Legacy';byId('client').value='New Client';audit.updateQuoteTitle();
  const renamedSave=deferred();let renamedBody;
  audit.setRequest((path,options)=>{renamedBody=JSON.parse(options.body);return renamedSave.promise;});
  const renameRun=audit.saveQuote();byId('client').value='';await byId('client').emit('input');
  assert.equal(byId('quote-title').value,'Legacy');
  renamedSave.resolve({id:'renamed',...renamedBody,configuration:oldConfig,fields:oldFields});await renameRun;
  assert.equal(byId('quote-title').value,'Untitled quote');assert.equal(audit.state.dirty,true);passed++;

  // Section navigation must reveal headings/actions instead of retaining the
  // previous estimate's vertical or horizontal scroll beneath the sticky bar.
  setup();audit.setRequest(async()=>({quotes:[]}));scrollCalls.length=0;
  for(const section of ['pricing','quotes','estimate'])audit.showView(section);
  assert.deepEqual(copy(scrollCalls),Array.from({length:3},()=>({top:0,left:0,behavior:'instant'})));passed++;

  const markup=fs.readFileSync('static/index.html','utf8');
  assert.doesNotMatch(markup,/id="print-quote"/);assert.doesNotMatch(source,/function printQuote|window\.print/);
  assert.doesNotMatch(markup,/Estimating workflow|id="workflow"|Choose a workflow|Dimensions and takeoff notes/);
  assert.doesNotMatch(source,/\$\("workflow"\)|Choose a workflow/);
  assert.match(markup,/<span>NOTES <span class="optional">Optional<\/span><\/span><textarea id="measurements"/);
  assert.match(markup,/id="quote-title"[^>]*readonly/);assert.doesNotMatch(markup,/work-summary|Generated work summary|Updating work summary/);assert.doesNotMatch(source,/\$\("work-summary"\)/);passed++;

  console.log(`${passed} UI metadata, precision, summary and race checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
