const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const elements = new Map();
const scrollCalls = [];
function element(tag='div') {
  return {
    tagName: tag, value: '', textContent: '', dataset: {}, children: [], disabled: false,
    listeners: {}, parts: new Map(), options: [], files: [], validity: {badInput:false}, attributes: new Map(),
    classList: {add(){},toggle(){}}, setAttribute(name,value){this.attributes.set(name,value);},getAttribute(name){return this.attributes.get(name);},removeAttribute(name){this.attributes.delete(name);},focus(){},
    addEventListener(event, fn, options={}) { (this.listeners[event] ||= []).push({fn,once:options.once}); },
    emit(event) { const callbacks = [...(this.listeners[event] || [])]; this.listeners[event] = (this.listeners[event]||[]).filter(x=>!x.once); return Promise.all(callbacks.map(x=>x.fn())); },
    append(...children){this.children.push(...children);this.options=this.children;children.forEach(child=>{if(child&&typeof child==='object')child.parent=this;});},
    replaceChildren(...children){this.children=[];this.append(...children);},
    querySelector(selector){if(selector==='[data-sell-preview]'){const find=node=>node.dataset?.sellPreview?node:(node.children||[]).map(find).find(Boolean);return this.children.map(find).find(Boolean)||null;}if(!this.parts.has(selector))this.parts.set(selector,element());return this.parts.get(selector);},
    closest(selector){for(let current=this;current;current=current.parent)if(current.tagName===selector)return current;return this.querySelector(`parent:${selector}`);},
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
    quoteDetails,updateQuoteTitle,reportPayload,reportFilename,downloadQuotePdf,controlValue,formatNumber,formatMoney,calculate,renderInputs,renderResults,showView,bootstrap,renderPricing,refreshPricingCatalog,projectStamp,
    setRequest(fn){request=fn;}, setFetch(fn){globalThis.fetch=fn;},setRenderPricing(fn){renderPricing=fn;},setRenderInputs(fn){renderInputs=fn;}};
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
  Object.assign(audit.state,{configuration:copy(oldConfig),draft:copy(newConfig),fields:copy(oldFields),currentFields:copy(oldFields),baseline:{inventory:[],rate_groups:{}},quote:null,quoteConfiguration:null,inputs:{D15:'Old spray'},dirty:false,quoteLoadRevision:0,legacyTitle:'',workflow:'workflow',defaultWorkflow:'Intumescent spray to ductwork',inputErrors:new Map(),inputDrafts:new Map(),inputRevision:0});
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

  // Missing or unsafe PDF filenames use the same Estimator name as the server.
  for(const disposition of [null,'','attachment','attachment; filename="../report.pdf"',
    'attachment; filename="C:\\report.pdf"','attachment; filename="report.html"','attachment; filename="<unsafe>.pdf"']) {
    assert.equal(audit.reportFilename(disposition),'CEASEFIRE-Estimate.pdf');
  }
  assert.equal(audit.reportFilename('attachment; filename="CEASEFIRE-Estimate.pdf"'),'CEASEFIRE-Estimate.pdf');
  assert.equal(audit.reportFilename('attachment; filename=Safe-123.pdf'),'Safe-123.pdf');passed++;

  // Both draft and saved downloads retain snapshots and later edits with the common filename.
  for(const saved of [false,true]) {
    setup();audit.state.quote=saved?{id:'saved-report'}:null;audit.state.quoteConfiguration=saved?copy(oldConfig):null;
    audit.state.inputs.B12='Preserved workbook note';byId('measurements').value='Captured general note';
    const beforeInputs=copy(audit.state.inputs),beforeConfig=copy(audit.state.quoteConfiguration||audit.state.configuration);
    const pending=deferred();let reportPath,reportOptions;
    audit.setFetch((path,options)=>{reportPath=path;reportOptions=options;return pending.promise;});
    const download=audit.downloadQuotePdf();
    assert.equal(byId('download-quote-pdf').disabled,true);assert.equal(byId('download-quote-pdf').getAttribute('aria-busy'),'true');
    audit.state.inputs.B12='Later workbook note';byId('measurements').value='Later general note';audit.state.dirty=true;
    pending.resolve({ok:true,headers:{get:name=>name==='Content-Type'?'application/pdf':saved?'attachment; filename="CEASEFIRE-Estimate.pdf"':null},blob:async()=>({size:100})});
    await download;
    assert.equal(reportPath,saved?'/api/quotes/saved-report/report.pdf':'/api/quote-report');
    assert.equal(reportOptions.method,saved?'GET':'POST');
    if(saved)assert.equal(reportOptions.body,undefined);
    else {
      const captured=JSON.parse(reportOptions.body);
      assert.deepEqual(captured.inputs,beforeInputs);assert.deepEqual(captured.configuration,beforeConfig);
      assert.equal(captured.measurements,'Captured general note');
    }
    const link=context.document.body.children.at(-1);assert.equal(link.download,'CEASEFIRE-Estimate.pdf');assert.equal(link.clicked,true);
    assert.equal(audit.state.inputs.B12,'Later workbook note');assert.equal(byId('measurements').value,'Later general note');
    assert.deepEqual(copy(audit.state.quoteConfiguration||audit.state.configuration),beforeConfig);assert.equal(audit.state.dirty,true);
    assert.match(byId('app-message').textContent,/Later edits are not included/);
    assert.equal(byId('download-quote-pdf').disabled,false);assert.equal(byId('download-quote-pdf').getAttribute('aria-busy'),undefined);
  }passed++;

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
  assert.equal(quantityControl.value,String(1/3));assert.equal(percentControl.value,'33.33333333333333');
  await quantityControl.emit('blur');await percentControl.emit('blur');
  assert.equal(audit.state.inputs.B15,1/3);assert.equal(audit.state.inputs.B9,1/3);
  quantityControl.value='12.345';await quantityControl.emit('input');await quantityControl.emit('blur');
  assert.equal(quantityControl.value,'12.345');assert.equal(audit.state.inputs.B15,1/3);assert.ok(audit.state.inputErrors.has('B15'));
  percentControl.value='12.345';await percentControl.emit('input');await percentControl.emit('blur');
  assert.equal(percentControl.value,'12.345');assert.equal(audit.state.inputs.B9,1/3);assert.ok(audit.state.inputErrors.has('B9'));
  quantityControl.value='12';await quantityControl.emit('input');await quantityControl.emit('blur');
  percentControl.value='13';await percentControl.emit('input');await percentControl.emit('blur');
  assert.equal(quantityControl.value,'12');assert.equal(percentControl.value,'13');assert.equal(audit.state.inputs.B15,12);assert.equal(audit.state.inputs.B9,.13);assert.equal(audit.state.inputErrors.size,0);
  assert.equal(audit.formatNumber(2.345),'2.35');assert.equal(audit.formatNumber(-2.345),'-2.35');assert.equal(audit.formatMoney(-2.345),'-$2.35');passed++;

  // Restrict only the explicitly named controls, in their displayed units.
  for(const cell of ['B4','B8','B9','B26','B27','F27','F28',...Array.from({length:9},(_,i)=>`B${i+15}`),...Array.from({length:9},(_,i)=>`E${i+15}`)]){
    setup();audit.state.inputs[cell]=0;const control=audit.makeControl({cell,label:cell,type:'number'},true);
    assert.equal(control.step,'1');assert.equal(control.value,'0');
    control.value='2.5';await control.emit('input');await control.emit('blur');assert.equal(audit.state.inputs[cell],0);assert.ok(audit.state.inputErrors.has(cell));
    control.value='3';await control.emit('input');await control.emit('blur');assert.equal(audit.state.inputs[cell],(['B9','B26','B27'].includes(cell)||cell.startsWith('E')) ? .03 : 3);assert.equal(control.value,'3');assert.equal(audit.state.inputErrors.size,0);
    control.value='';await control.emit('input');assert.equal(audit.state.inputs[cell],'');
  }passed++;
  setup();for(const cell of ['C15','C22','F26']){audit.state.inputs[cell]=1.5;const control=audit.makeControl({cell,label:cell,type:'number'},true);assert.equal(control.step,'0.01');control.value='2.75';await control.emit('input');assert.equal(audit.state.inputs[cell],2.75);}passed++;

  // Global adjustment looks like money at rest and accepts signed currency edits.
  setup();audit.state.inputs.B28=1234.56789;const currency=audit.makeControl({cell:'B28',label:'Global Adjustment ($)',type:'number'},true);
  assert.equal(currency.type,'text');assert.equal(currency.value,'$1,234.57');await currency.emit('blur');assert.equal(audit.state.inputs.B28,1234.56789);
  await currency.emit('focus');assert.equal(currency.value,'$1,234.57');currency.value='-$50.25';await currency.emit('input');await currency.emit('blur');assert.equal(audit.state.inputs.B28,-50.25);assert.equal(currency.value,'-$50.25');
  currency.value='$invalid';await currency.emit('input');let invalidSaveCalls=0;audit.setRequest(async()=>{invalidSaveCalls++;});await audit.saveQuote();assert.equal(invalidSaveCalls,0);assert.equal(audit.state.inputs.B28,-50.25);
  currency.value='';await currency.emit('input');assert.equal(audit.state.inputs.B28,'');assert.equal(audit.state.inputErrors.size,0);passed++;

  // Filling a currency field may clear it before focus; focus must not insert the old amount.
  setup();audit.state.inputs.B28=0;const clearedCurrency=audit.makeControl({cell:'B28',label:'Global Adjustment ($)',type:'number'},true);
  clearedCurrency.value='';await clearedCurrency.emit('focus');assert.equal(clearedCurrency.value,'');
  clearedCurrency.value='-1234.56';await clearedCurrency.emit('input');await clearedCurrency.emit('blur');
  assert.equal(audit.state.inputs.B28,-1234.56);assert.equal(clearedCurrency.value,'-$1,234.56');passed++;

  // A save response or pricing refresh must retain later invalid numeric text and the dirty state.
  setup();const numericFields=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields;
  audit.state.fields=copy(numericFields);audit.state.currentFields=copy(numericFields);
  audit.state.inputs=Object.fromEntries(numericFields.map(field=>[field.cell,field.default??'']));audit.state.inputs.B15=12;audit.state.inputs.B28=0;
  audit.setRenderInputs(audit.renderInputs);
  const pendingNumericSave=deferred();let numericSaveBody;
  audit.setRequest((path,options)=>{numericSaveBody=JSON.parse(options.body);return pendingNumericSave.promise;});
  const savingNumbers=audit.saveQuote();
  const invalidQuantity=audit.makeControl(numericFields.find(field=>field.cell==='B15'),true),invalidCurrency=audit.makeControl(numericFields.find(field=>field.cell==='B28'),true);
  invalidQuantity.value='1.5';await invalidQuantity.emit('input');invalidCurrency.value='$invalid';await invalidCurrency.emit('input');
  pendingNumericSave.resolve({id:'numeric-save',...numericSaveBody,fields:numericFields});await savingNumbers;
  const numericNodes=node=>[node,...(node.children||[]).flatMap(numericNodes)];
  const renderedNumeric=cell=>['input-sections','adjustment-sections','material-inputs'].flatMap(id=>numericNodes(byId(id))).find(node=>node.dataset?.cell===cell);
  assert.equal(renderedNumeric('B15').value,'1.5');assert.equal(renderedNumeric('B28').value,'$invalid');
  assert.equal(renderedNumeric('B15').getAttribute('aria-invalid'),'true');assert.equal(audit.state.inputs.B15,12);assert.equal(audit.state.inputs.B28,0);
  assert.equal(audit.state.inputErrors.size,2);assert.equal(audit.state.dirty,true);assert.match(byId('app-message').textContent,/still need to be saved/);
  await byId('use-current-pricing').emit('click');assert.equal(renderedNumeric('B15').value,'1.5');assert.equal(renderedNumeric('B28').value,'$invalid');assert.equal(audit.state.inputErrors.size,2);passed++;

  // Identical validation messages cannot hide later invalid edits from a project-load guard.
  context.window.CeasefireCalculators={projectFingerprint:()=>''};
  const invalidStamp=audit.projectStamp(),firstError=audit.state.inputErrors.get('B15');
  renderedNumeric('B15').value='1.6';await renderedNumeric('B15').emit('input');
  assert.equal(audit.state.inputErrors.get('B15'),firstError);assert.equal(audit.state.inputs.B15,12);
  assert.notEqual(audit.projectStamp(),invalidStamp);assert.equal(audit.state.inputDrafts.get('B15'),'1.6');
  delete context.window.CeasefireCalculators;passed++;

  // Explicit replacement clears invalid drafts after confirmation; editing a value validly clears only its own error.
  const fixedQuantity=renderedNumeric('B15');fixedQuantity.value='14';await fixedQuantity.emit('input');
  assert.equal(audit.state.inputDrafts.has('B15'),false);assert.equal(audit.state.inputErrors.has('B15'),false);assert.equal(audit.state.inputErrors.has('B28'),true);
  const replaceInvalid=audit.newQuote();await flush();await dialog.close('confirm');await replaceInvalid;
  assert.equal(audit.state.inputErrors.size,0);assert.equal(audit.state.inputDrafts.size,0);assert.equal(audit.state.dirty,false);
  audit.setRenderInputs(()=>{});passed++;

  // Merely viewing or leaving a displayed pricing value must not create an override.
  setup();const item={id:'precise',name:'Precise product',supplier_price:123.456789,markup:.333333333,sales_price:164.609051};
  const priceControl=audit.priceInput('inventory',item,'supplier_price');
  assert.equal(priceControl.value,'123.46');await priceControl.emit('blur');
  assert.equal(audit.state.draft.inventory.precise,undefined);assert.equal(item.supplier_price,123.456789);
  priceControl.value='125.555';await priceControl.emit('input');await priceControl.emit('blur');
  assert.equal(priceControl.value,'125.56');assert.equal(audit.state.draft.inventory.precise.supplier_price,125.56);passed++;

  // One inventory product exposes every actual use; standalone rates and unused products are retained.
  const pricingFixture={inventory:[
    {id:'coat',item_code:'P-1',name:'Coating <literal>',supplier_price:100.123456,markup:.2,sales_price:120.1481472,pricing_mode:'supplier_markup'},
    {id:'unused',item_code:'P-2',name:'Unused Primers product',supplier_price:20,markup:.1,sales_price:22,pricing_mode:'supplier_markup'},
    {id:'manual',item_code:'P-3',name:'Manual inventory',supplier_price:null,markup:0,sales_price:400,pricing_mode:'manual'}],
    rate_groups:{primers:[{id:'primer',inventory_id:'coat',name:'Primer choice',price:120.1481472,yield:10.123456,uses_yield:true,price_mode:'inventory'}],
      topcoats:[{id:'topcoat',inventory_id:'coat',name:'Topcoat choice',price:180.123456,yield:8,uses_yield:true,price_mode:'override'}],
      labour_rates:[{id:'team',inventory_id:null,name:'Site team',price:1000,yield:'',uses_yield:false,price_mode:'override'}],
      sprays:[{id:'duplicate-name',inventory_id:null,name:'Coating <literal>',price:55,yield:2,uses_yield:true,price_mode:'override'}]}};
  const pricingNodes=()=>{const walk=node=>[node,...(node.children||[]).flatMap(walk)];return walk(byId('pricing-body'));};
  const productRows=()=>byId('pricing-body').children.filter(row=>row.dataset.priceId);
  const rateRow=id=>pricingNodes().find(node=>node.dataset.rateId===id);
  const rateInput=(id,field)=>rateRow(id).children.flatMap(cell=>cell.children||[]).find(node=>node.dataset.priceField===field);
  const rateAction=(id,label)=>rateRow(id).children.at(-1).children.find(button=>button.textContent===label);
  const usedIn=key=>byId('pricing-body').children.find(row=>row.dataset.pricingUsesFor===key)?.children[0].children[0];
  const productInput=(id,field)=>productRows().find(row=>row.dataset.priceId===id).children.flatMap(cell=>cell.children||[]).find(node=>node.dataset.priceField===field);
  setup();audit.state.baseline=copy(pricingFixture);audit.state.configuration={inventory:{},rates:{}};audit.state.draft={inventory:{},rates:{}};audit.state.pricingExpanded=new Set();
  byId('pricing-search').value='';byId('rate-group').value='';audit.setRenderPricing(audit.renderPricing);audit.refreshPricingCatalog();audit.renderPricing();
  const originalPricing=JSON.stringify(pricingFixture);
  assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat','unused','manual','team','duplicate-name']);
  assert.deepEqual(pricingNodes().filter(node=>node.dataset.rateId).map(node=>node.dataset.rateId),['primer','topcoat','team','duplicate-name']);
  assert.deepEqual(byId('rate-group').children.map(option=>option.textContent),['All uses','Primers','Topcoats','Labour','Sprays','Not used']);
  assert.equal(rateInput('primer','yield').value,'10.12');assert.equal(rateInput('team','yield'),undefined);
  for(const [id,name,group] of [['primer','Primer choice','Primers'],['topcoat','Topcoat choice','Topcoats']]) {
    assert.equal(rateInput(id,'price').getAttribute('aria-label'),`${name}: ${group} sell rate`);
    assert.equal(rateInput(id,'yield').getAttribute('aria-label'),`${name}: ${group} material yield`);
    assert.equal(rateAction(id,'Reset rate').getAttribute('aria-label'),`${name}: ${group} reset rate`);
    assert.equal(rateAction(id,'Reset yield').getAttribute('aria-label'),`${name}: ${group} reset yield`);
  }
  assert.equal(productInput('coat','name').value,'Coating <literal>');assert.equal(rateRow('duplicate-name').children[1].textContent,'Coating <literal>');
  assert.equal(audit.state.pricingDirty,false);assert.equal(JSON.stringify(pricingFixture),originalPricing);passed++;

  // Used in is a native disclosure: opening and closing preserves its controls and changes no pricing draft.
  const initialPricing=JSON.stringify(audit.state.draft),initialPrimerYield=rateInput('primer','yield');
  assert.equal(byId('pricing-head').children[0].children.length,6);assert.equal(usedIn('inventory:coat').tagName,'details');assert.equal(usedIn('inventory:coat').open,false);
  assert.equal(usedIn('inventory:unused'),undefined);assert.ok(usedIn('rates:team'));
  usedIn('inventory:coat').open=true;await usedIn('inventory:coat').emit('toggle');assert.equal(rateInput('primer','yield'),initialPrimerYield);
  audit.renderPricing();assert.equal(usedIn('inventory:coat').open,true);assert.equal(rateInput('primer','yield').value,'10.12');
  usedIn('inventory:coat').open=false;await usedIn('inventory:coat').emit('toggle');audit.renderPricing();assert.equal(usedIn('inventory:coat').open,false);
  assert.ok(!audit.state.pricingExpanded.has('inventory:coat'));assert.equal(JSON.stringify(audit.state.draft),initialPricing);passed++;

  // Search and category filters resolve links, even when product names look like another category.
  byId('rate-group').value='primers';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat']);assert.ok(rateRow('topcoat'));
  byId('rate-group').value='sprays';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['duplicate-name']);
  byId('rate-group').value='not-used';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused','manual']);
  byId('rate-group').value='';byId('pricing-search').value='Topcoat choice';await byId('pricing-search').emit('input');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat']);
  assert.equal(pricingNodes().find(node=>node.tagName==='details').open,true);
  byId('pricing-search').value='P-2';await byId('pricing-search').emit('input');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused']);
  byId('pricing-search').value='no match';await byId('pricing-search').emit('input');assert.equal(productRows().length,0);assert.equal(byId('pricing-body').children[0].children[0].textContent,'No matching products or rates.');
  assert.deepEqual(copy(audit.state.draft),{inventory:{},rates:{}});passed++;

  // Inventory price changes refresh linked uses without overwriting imported rate overrides or untouched precision.
  byId('pricing-search').value='';audit.renderPricing();const supplierInput=productInput('coat','supplier_price');
  await supplierInput.emit('blur');await rateInput('primer','price').emit('blur');await rateInput('primer','yield').emit('blur');assert.deepEqual(copy(audit.state.draft),{inventory:{},rates:{}});
  assert.equal(audit.state.catalog.inventory[0].supplier_price,100.123456);assert.equal(audit.state.catalog.rate_groups.primers[0].yield,10.123456);
  supplierInput.value='200';await supplierInput.emit('input');assert.equal(rateInput('primer','price').value,'240.00');assert.equal(rateInput('topcoat','price').value,'180.12');
  assert.equal(productRows()[0].querySelector('[data-sell-preview]').textContent,'$240.00');
  assert.equal(rateRow('primer').children[3].textContent,'Follows inventory pricing');assert.equal(rateRow('topcoat').children[3].textContent,'Imported rate override');
  rateInput('primer','price').value='250';await rateInput('primer','price').emit('input');rateInput('primer','yield').value='12.75';await rateInput('primer','yield').emit('input');
  assert.equal(productRows()[0].querySelector('[data-sell-preview]').textContent,'$240.00');
  supplierInput.value='210';await supplierInput.emit('input');assert.equal(rateInput('primer','price').value,'250.00');assert.equal(rateRow('primer').children[3].textContent,'Rate override');
  assert.deepEqual(copy(audit.state.draft.rates.primer),{price:250,yield:12.75});assert.equal(audit.state.catalog.rate_groups.primers[0].price_mode,'inventory');assert.equal(audit.state.catalog.rate_groups.topcoats[0].price_mode,'override');passed++;

  // Each field reset preserves other edits and imported pricing mode, and disclosures stay open across rerenders.
  let coatDetails=pricingNodes().find(node=>node.tagName==='details');coatDetails.open=true;await coatDetails.emit('toggle');
  await rateAction('primer','Reset rate').emit('click');assert.deepEqual(copy(audit.state.draft.rates.primer),{yield:12.75});assert.equal(rateInput('primer','price').value,'252.00');
  assert.equal(pricingNodes().find(node=>node.tagName==='details').open,true);assert.equal(rateAction('primer','Reset rate').disabled,true);
  await rateAction('primer','Reset yield').emit('click');assert.equal(audit.state.draft.rates.primer,undefined);assert.equal(rateInput('primer','yield').value,'10.12');
  rateInput('topcoat','price').value='199';await rateInput('topcoat','price').emit('input');await rateAction('topcoat','Reset rate').emit('click');assert.equal(rateInput('topcoat','price').value,'180.12');assert.equal(rateRow('topcoat').children[3].textContent,'Imported rate override');
  productInput('manual','sales_price').value='450';await productInput('manual','sales_price').emit('input');rateInput('team','price').value='1050';await rateInput('team','price').emit('input');
  assert.equal(productRows().find(row=>row.dataset.priceId==='team').children[4].children[0].textContent,'$1,050.00');
  byId('pricing-search').value='Site team';await byId('pricing-search').emit('input');byId('pricing-search').value='';await byId('pricing-search').emit('input');
  assert.equal(productInput('manual','sales_price').value,'450.00');assert.equal(rateInput('team','price').value,'1050.00');assert.equal(audit.state.configuration.inventory.manual,undefined);assert.equal(JSON.stringify(pricingFixture),originalPricing);passed++;

  // Export ignores the visible group/search filter and captures edits from all uses with exact untouched defaults.
  byId('rate-group').value='primers';byId('pricing-search').value='Primer choice';await byId('rate-group').emit('change');
  let unifiedExport;audit.setFetch(async(path,options)=>{unifiedExport=JSON.parse(options.body).configuration;return {ok:true,headers:{get:()=> 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},blob:async()=>({size:100})};});await audit.exportPricing();
  assert.equal(unifiedExport.inventory.manual.sales_price,450);assert.equal(unifiedExport.rates.team.price,1050);assert.equal(unifiedExport.inventory.coat.supplier_price,210);assert.equal(unifiedExport.rates.topcoat,undefined);assert.equal(unifiedExport.rates.primer,undefined);
  assert.equal(audit.state.catalog.rate_groups.primers[0].price,120.1481472);assert.equal(audit.state.catalog.rate_groups.primers[0].yield,10.123456);assert.match(byId('app-message').textContent,/all inventory and rate groups/);passed++;

  // Resetting a product row does not remove independent prices or yields from its expanded uses.
  rateInput('primer','price').value='401.25';await rateInput('primer','price').emit('input');
  rateInput('primer','yield').value='71';await rateInput('primer','yield').emit('input');
  rateInput('topcoat','yield').value='142';await rateInput('topcoat','yield').emit('input');
  productInput('coat','supplier_price').value='300';await productInput('coat','supplier_price').emit('input');
  assert.equal(productRows()[0].querySelector('[data-sell-preview]').textContent,'$360.00');assert.equal(rateInput('primer','price').value,'401.25');assert.equal(rateInput('topcoat','price').value,'180.12');
  await productRows()[0].children.at(-1).children.find(node=>node.tagName==='button'&&node.textContent==='Reset row').emit('click');
  assert.equal(audit.state.draft.inventory.coat,undefined);assert.deepEqual(copy(audit.state.draft.rates.primer),{price:401.25,yield:71});assert.deepEqual(copy(audit.state.draft.rates.topcoat),{yield:142});
  assert.equal(rateInput('primer','yield').value,'71.00');assert.equal(rateInput('topcoat','yield').value,'142.00');assert.equal(usedIn('inventory:coat').open,true);passed++;

  // Expanding imported blank and zero yields retains both distinct values without creating overrides.
  const blankYieldCatalog=copy(pricingFixture);blankYieldCatalog.rate_groups.primers[0].yield='';blankYieldCatalog.rate_groups.topcoats[0].yield=0;
  audit.state.draft={catalog:blankYieldCatalog,inventory:{},rates:{}};audit.state.pricingExpanded=new Set();byId('pricing-search').value='';byId('rate-group').value='';audit.refreshPricingCatalog();audit.renderPricing();
  const blankYieldBefore=JSON.stringify(audit.state.draft);assert.equal(usedIn('inventory:coat').open,false);usedIn('inventory:coat').open=true;await usedIn('inventory:coat').emit('toggle');
  assert.equal(rateInput('primer','yield').value,'');assert.equal(rateInput('topcoat','yield').value,'0.00');assert.equal(rateInput('team','yield'),undefined);
  await rateInput('primer','yield').emit('blur');await rateInput('topcoat','yield').emit('blur');assert.equal(JSON.stringify(audit.state.draft),blankYieldBefore);
  byId('rate-group').value='topcoats';await byId('rate-group').emit('change');assert.equal(usedIn('inventory:coat').open,true);assert.equal(rateInput('primer','yield').value,'');assert.equal(rateInput('topcoat','yield').value,'0.00');
  assert.equal(JSON.stringify(audit.state.draft),blankYieldBefore);passed++;
  audit.setRenderPricing(()=>{audit.state.pricingDirty=JSON.stringify(audit.state.draft)!==JSON.stringify(audit.state.configuration);});byId('pricing-search').value='';byId('rate-group').value='';

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

  // B12 has no second editor anywhere in the form; all other inputs and the main NOTES remain.
  setup();audit.state.fields=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields;
  audit.state.inputs=Object.fromEntries(audit.state.fields.map(field=>[field.cell,field.default??'']));
  audit.state.inputs.B12='Historical workbook note';byId('measurements').value='Visible main note';
  const hiddenNotesInputs=JSON.stringify(audit.state.inputs),hiddenNotesFields=JSON.stringify(audit.state.fields);
  audit.renderInputs();
  const inputDescendants=node=>[node,...(node.children||[]).flatMap(inputDescendants)];
  const visibleCells=['input-sections','adjustment-sections','material-inputs'].flatMap(id=>inputDescendants(byId(id))).filter(node=>node.dataset?.cell).map(node=>node.dataset.cell);
  assert.ok(!visibleCells.includes('B12'));assert.equal(visibleCells.length,audit.state.fields.length-1);
  assert.deepEqual(visibleCells.slice().sort(),audit.state.fields.filter(field=>field.cell!=='B12').map(field=>field.cell).sort());
  assert.equal(JSON.stringify(audit.state.inputs),hiddenNotesInputs);assert.equal(JSON.stringify(audit.state.fields),hiddenNotesFields);
  assert.equal(audit.reportPayload().inputs.B12,'Historical workbook note');assert.equal(audit.reportPayload().measurements,'Visible main note');
  assert.match(fs.readFileSync('static/index.html','utf8'),/<textarea[^>]*id="measurements"/);passed++;

  // Labour rows display source-projected days, preserve literal labels, and read the authoritative total.
  setup();const labourResult={summary:{days:16.987654321},cells:{},errors:{},materials:[],labour:{
    tasks:[{name:'Spray / wrap',days:1.23456789},{name:'Mesh <literal>',days:2},{name:'Access panels',days:0},{name:'Fan enclosure mesh',days:3},{name:'Primer',days:0},{name:'Topcoat',days:0},{name:'Board',days:1},{name:'Mastic',days:0}],
    task_days:7.23456789,masking_days:0.123456789,extra_days:1.5,mobilisation_days:.75,total_days:16.987654321}};
  const labourBefore=JSON.stringify(labourResult);audit.renderResults(labourResult);
  const labourRows=()=>byId('labour-results').children;
  assert.equal(labourRows().length,13);assert.equal(labourRows()[0].children[1].textContent,'1.23');assert.equal(labourRows()[1].children[0].textContent,'Mesh <literal>');assert.equal(labourRows()[2].children[1].textContent,'0.00');
  assert.equal(labourRows()[8].children[0].textContent,'Task labour subtotal');assert.equal(labourRows()[11].children[0].textContent,'Mobilisation allowance');assert.equal(labourRows()[11].children[1].textContent,'0.75');
  assert.equal(labourRows()[12].children[0].textContent,'Total project days');assert.equal(labourRows()[12].children[1].textContent,'16.99');assert.equal(byId('sum-days').textContent,'16.99');
  assert.equal(labourRows()[0].children[0].scope,'row');assert.equal(JSON.stringify(labourResult),labourBefore);assert.equal(byId('labour-breakdown').getAttribute('aria-busy'),'false');passed++;

  // Missing and failed labour values remain unavailable or explicit errors rather than plausible zero days.
  const missingLabour=copy(labourResult);missingLabour.labour.tasks[0].days=null;missingLabour.labour.task_days='#DIV/0!';missingLabour.labour.mobilisation_days='';missingLabour.labour.total_days='#N/A';
  audit.renderResults(missingLabour);assert.equal(labourRows()[0].children[1].textContent,'—');assert.equal(labourRows()[8].children[1].textContent,'#DIV/0!');assert.equal(labourRows()[11].children[1].textContent,'—');assert.equal(labourRows()[12].children[1].textContent,'#N/A');
  audit.renderResults({});assert.equal(labourRows().length,1);assert.equal(labourRows()[0].children[0].textContent,'Labour breakdown is unavailable for this result.');passed++;

  // Labour output clears during calculation, rejects stale responses and cannot leave old totals after a failure.
  setup();audit.renderResults(labourResult);const olderLabour=deferred(),newerLabour=deferred();let labourRequests=0;
  audit.setRequest(()=>++labourRequests===1?olderLabour.promise:newerLabour.promise);
  const olderLabourRun=audit.calculate();assert.equal(labourRows()[0].children[0].textContent,'Calculating…');assert.equal(byId('labour-breakdown').getAttribute('aria-busy'),'true');
  const newerLabourRun=audit.calculate();const newerLabourResult=copy(labourResult);newerLabourResult.labour.total_days=22.5;newerLabourResult.summary.days=22.5;
  newerLabour.resolve(newerLabourResult);await newerLabourRun;olderLabour.resolve(labourResult);await olderLabourRun;
  assert.equal(labourRows().at(-1).children[1].textContent,'22.50');assert.equal(audit.state.result.labour.total_days,22.5);assert.equal(byId('labour-breakdown').getAttribute('aria-busy'),'false');
  audit.setRequest(async()=>{throw new Error('Calculation offline');});await audit.calculate();assert.equal(labourRows().length,1);assert.equal(labourRows()[0].children[0].textContent,'No current calculation is available.');assert.equal(byId('labour-breakdown').getAttribute('aria-busy'),'false');passed++;

  // Hidden saved B12 notes survive editing the main NOTES, saving, and reopening unchanged.
  for(const savedNotes of ['Allowances','Measured project note','']) {
    setup();audit.state.currentFields=copy(currentNotesFields);
    audit.setRequest(async()=>({id:'notes-quote',title:'Saved notes',configuration:oldConfig,fields:currentNotesFields,inputs:{D15:'New spray',B12:savedNotes},workflow:'Fire wrap to ductwork'}));
    await audit.openQuote('notes-quote',element('button'));assert.equal(audit.state.inputs.B12,savedNotes);
    audit.renderInputs();
    assert.ok(!['input-sections','adjustment-sections','material-inputs'].flatMap(id=>inputDescendants(byId(id))).some(node=>node.dataset?.cell==='B12'));
    byId('measurements').value='Edited main note';await byId('measurements').emit('input');assert.equal(audit.state.dirty,true);
    let notesBody;audit.setRequest(async(path,options)=>{notesBody=JSON.parse(options.body);return {id:'notes-quote',...notesBody,fields:currentNotesFields};});
    await audit.saveQuote();assert.equal(notesBody.inputs.B12,savedNotes);assert.equal(audit.reportPayload().inputs.B12,savedNotes);assert.equal(notesBody.measurements,'Edited main note');
    assert.equal(audit.state.fields.find(field=>field.cell==='B12').default,'Allowances');
    audit.setRequest(async()=>({id:'notes-quote',...notesBody,fields:currentNotesFields}));
    await audit.openQuote('notes-quote',element('button'));assert.equal(audit.state.inputs.B12,savedNotes);assert.equal(byId('measurements').value,'Edited main note');
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
  const actionCss=fs.readFileSync('static/styles.css','utf8');
  assert.match(markup,/id="save-quote"[^>]*class="button save-button"/);
  assert.match(markup,/id="download-quote-pdf"[^>]*class="button pdf-button"/);
  assert.ok(actionCss.includes('.button.save-button{color:#332600;background:#ffdb66;'));
  assert.ok(actionCss.includes('.button.pdf-button{color:#fff;background:#c5221f;'));
  for(const state of [':hover:not(:disabled)',':focus-visible',':disabled'])assert.ok(actionCss.includes(`.button:is(.excel-button,.save-button,.pdf-button)${state}`));
  assert.doesNotMatch(markup,/id="print-quote"/);assert.doesNotMatch(source,/function printQuote|window\.print/);
  assert.doesNotMatch(markup,/Estimating workflow|id="workflow"|Choose a workflow|Dimensions and takeoff notes/);
  assert.doesNotMatch(source,/\$\("workflow"\)|Choose a workflow/);
  assert.match(markup,/<span>NOTES <span class="optional">Optional<\/span><\/span><textarea id="measurements"/);
  assert.match(markup,/id="quote-title"[^>]*readonly/);assert.doesNotMatch(markup,/work-summary|Generated work summary|Updating work summary/);assert.doesNotMatch(source,/\$\("work-summary"\)/);passed++;
  assert.ok(markup.indexOf('id="breakdown-heading"')<markup.indexOf('id="labour-breakdown"'));assert.ok(markup.indexOf('id="labour-breakdown"')<markup.indexOf('id="notes-heading"'));
  assert.match(markup,/<th scope="col" class="numeric">Days<\/th>/);assert.match(markup,/Pinning is included in meshing days/);

  console.log(`${passed} UI metadata, precision, summary and race checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
