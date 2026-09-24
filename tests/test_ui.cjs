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
  window:{addEventListener(){},scrollTo(options){scrollCalls.push(options);},CeasefireCalculators:{projectFingerprint:()=>'',hasUnsavedChanges:()=>false,prepareDefaults:async()=>({}),applyProject(){}}}, Intl, Number, JSON, Object, Set, Array, String, Promise, Error,
  setTimeout:()=>0,clearTimeout(){},AbortController, console,
  FileReader:class { readAsDataURL(){this.result='data:application/octet-stream;base64,AAAA';queueMicrotask(()=>this.onload());} },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
let source=fs.readFileSync('static/app.js','utf8');
source=source.replace(/  bootstrap\(\);\s*\}\)\(\);\s*$/, `
  globalThis.audit={state,savePricing,requestSavePricing,saveQuote,openQuote,newQuote,confirmReplace,confirmLeavePricingLibrary,requestViewNavigation,requestLibraryNavigation,requestPricingScopeSwitch,importPricing,exportPricing,makeControl,priceInput,
    quoteDetails,updateQuoteTitle,reportPayload,downloadQuotePdf,controlValue,formatNumber,formatMoney,calculate,renderInputs,renderResults,showView,bootstrap,renderPricing,refreshPricingCatalog,projectStamp,addWorkItem,removeWorkItem,
    setRequest(fn){request=fn;}, setFetch(fn){globalThis.fetch=fn;},setRenderPricing(fn){renderPricing=fn;},setRenderInputs(fn){renderInputs=fn;}};
  renderInputs=()=>{}; renderPricing=()=>{state.pricingDirty=JSON.stringify(state.draft)!==JSON.stringify(state.configuration);};
  globalThis.scheduled=0; scheduleCalculation=()=>{globalThis.scheduled++;};
})();`);
vm.runInContext(source,context);
const {audit}=context;
const copy=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const savedResponse=(filename='CEASEFIRE-Estimate.pdf')=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:true,path:`C:/Projects/Original/${filename}`,filename,destination:'project'})});
const oldFields=[{cell:'D15',label:'Spray material',type:'select',default:'Old spray',options:['Old spray']}];
const newFields=[{cell:'D15',label:'Spray material',type:'select',default:'New spray',options:['New spray']}];
const oldConfig={inventory:{},rates:{},version:'old'};
const newConfig={inventory:{},rates:{},version:'new'};
function setup(){
  Object.assign(audit.state,{configuration:copy(oldConfig),draft:copy(newConfig),fields:copy(oldFields),currentFields:copy(oldFields),baseline:{inventory:[],rate_groups:{}},quote:null,quoteConfiguration:null,inputs:{D15:'Old spray'},workItems:[],workItemErrors:new Map(),workItemDrafts:new Map(),nextWorkItem:1,dirty:false,quoteLoadRevision:0,legacyTitle:'',workflow:'workflow',defaultWorkflow:'Intumescent spray to ductwork',inputErrors:new Map(),inputDrafts:new Map(),inputRevision:0,projectPricingDraft:null,libraryDraft:null,pricingScope:'library',pricingRevision:0,projectFile:null,projectBusy:false,initialized:false});
  for(const id of ['project-no','client','site-address','measurements'])byId(id).value='';
}
async function openOlder(id, button) {
  const pending=audit.openQuote(id,button); await flush();
  if(byId('discard-dialog').open) await byId('discard-dialog').close('confirm');
  await pending;
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
  await openOlder('old-quote',element('button'));
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
  const first=audit.confirmReplace('First action','First detail','First confirm','Cancel');
  const second=audit.confirmReplace('Second action','Second detail','Second confirm');
  await flush(); const dialog=byId('discard-dialog');
  assert.equal(dialog.querySelector('h2').textContent,'First action');
  assert.equal(dialog.querySelector('[value="cancel"]').textContent,'Cancel');
  await dialog.close('cancel'); assert.equal(await first,false); await flush();
  assert.equal(dialog.querySelector('h2').textContent,'Second action');
  assert.equal(dialog.querySelector('[value="cancel"]').textContent,'Keep editing');
  await dialog.close('confirm');assert.equal(await second,true);passed++;

  // Shared pricing asks before navigation, keeps the draft on Cancel and uses
  // the exact requested choices before continuing.
  setup();audit.state.currentView='pricing';audit.state.libraryKind='pricing';
  let leaving=audit.requestViewNavigation('estimate');await flush();
  assert.equal(dialog.querySelector('p').textContent,'The Pricing Library has unsaved changes. Are you sure you want to continue?');
  assert.equal(dialog.querySelector('[value="confirm"]').textContent,'Continue');assert.equal(dialog.querySelector('[value="cancel"]').textContent,'Cancel');
  await dialog.close('cancel');assert.equal(await leaving,false);assert.equal(audit.state.currentView,'pricing');
  leaving=audit.requestViewNavigation('estimate');await flush();await dialog.close('confirm');assert.equal(await leaving,true);assert.equal(audit.state.currentView,'estimate');passed++;

  // Switching away from a dirty shared library is guarded and Cancel restores
  // the shared-library selector.
  setup();audit.state.currentView='pricing';audit.state.libraryKind='pricing';byId('pricing-scope').value='project';
  let switching=audit.requestPricingScopeSwitch('project');await flush();assert.equal(byId('pricing-scope').value,'library');
  await dialog.close('cancel');assert.equal(await switching,false);assert.equal(audit.state.pricingScope,'library');
  switching=audit.requestPricingScopeSwitch('project');await flush();await dialog.close('confirm');assert.equal(await switching,true);assert.equal(audit.state.pricingScope,'project');passed++;

  // Saving the shared library requires the explicit Save/Cancel confirmation.
  setup();const savedRequests=[];audit.setRequest(async(path)=>{savedRequests.push(path);return path==='/api/configuration'?copy(newConfig):{configuration:copy(newConfig),fields:copy(newFields)};});
  let confirmedSave=audit.requestSavePricing();await flush();
  assert.equal(dialog.querySelector('p').textContent,'The changes in this Pricing Library will be saved for future projects. Are you sure you want to save?');
  assert.equal(dialog.querySelector('[value="confirm"]').textContent,'Save');assert.equal(dialog.querySelector('[value="cancel"]').textContent,'Cancel');
  await dialog.close('cancel');await confirmedSave;assert.deepEqual(savedRequests,[]);
  confirmedSave=audit.requestSavePricing();await flush();await dialog.close('confirm');await confirmedSave;
  assert.deepEqual(savedRequests,['/api/configuration','/api/bootstrap']);assert.equal(audit.state.fields[0].options[0],'New spray');passed++;

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
  exported.resolve(savedResponse('ceasefire-pricing.xlsx'));
  await exportRun;
  assert.equal(exportBody.configuration.rates.concurrent,undefined);
  assert.equal(audit.state.draft.rates.concurrent.price,45);
  assert.match(byId('app-message').textContent,/Later edits are not included/);passed++;

  // Only a selected project capability determines the download destination.
  setup();assert.deepEqual(copy(context.window.CeasefireProject.downloadTarget()),{project_token:null});
  audit.state.projectFile={path:'C:/Projects/One.json',save_token:'original-target'};
  const originalTarget=context.window.CeasefireProject.downloadTarget();audit.state.projectFile={save_token:'new-target'};
  assert.equal(originalTarget.project_token,'original-target');assert.equal(context.window.CeasefireProject.downloadTarget().project_token,'new-target');
  audit.state.projectFile={name:'browser-import.json'};assert.equal(context.window.CeasefireProject.downloadTarget().project_token,null);passed++;

  // Both draft and saved downloads retain snapshots and later edits with the common filename.
  for(const saved of [false,true]) {
    setup();audit.state.quote=saved?{id:'saved-report'}:null;audit.state.quoteConfiguration=saved?copy(oldConfig):null;
    audit.state.projectFile={save_token:'original-target'};
    audit.state.inputs.B12='Preserved workbook note';byId('measurements').value='Captured general note';
    const beforeInputs=copy(audit.state.inputs),beforeConfig=copy(audit.state.quoteConfiguration||audit.state.configuration);
    const pending=deferred();let reportPath,reportOptions;
    audit.setFetch((path,options)=>{reportPath=path;reportOptions=options;return pending.promise;});
    const download=audit.downloadQuotePdf();
    assert.equal(byId('download-quote-pdf').disabled,true);assert.equal(byId('download-quote-pdf').getAttribute('aria-busy'),'true');
    assert.equal(byId('download-quote-pdf').getAttribute('aria-label'),'Preparing PDF Estimate…');
    audit.state.inputs.B12='Later workbook note';byId('measurements').value='Later general note';audit.state.dirty=true;
    audit.state.projectFile={save_token:'new-target'};
    pending.resolve(savedResponse());
    await download;
    assert.equal(reportPath,saved?'/api/quotes/saved-report/report.pdf':'/api/quote-report');
    assert.equal(reportOptions.method,'POST');
    assert.equal(JSON.parse(reportOptions.body).download.project_token,'original-target');
    if(saved)assert.deepEqual(JSON.parse(reportOptions.body),{download:{project_token:'original-target'}});
    else {
      const captured=JSON.parse(reportOptions.body);
      assert.deepEqual(captured.inputs,beforeInputs);assert.deepEqual(captured.configuration,beforeConfig);
      assert.equal(captured.measurements,'Captured general note');
    }
    assert.match(byId('app-message').textContent,/PDF saved to C:\/Projects\/Original\/CEASEFIRE-Estimate.pdf/);
    assert.equal(audit.state.inputs.B12,'Later workbook note');assert.equal(byId('measurements').value,'Later general note');
    assert.deepEqual(copy(audit.state.quoteConfiguration||audit.state.configuration),beforeConfig);assert.equal(audit.state.dirty,true);
    assert.match(byId('app-message').textContent,/Later edits are not included/);
    assert.equal(byId('download-quote-pdf').disabled,false);assert.equal(byId('download-quote-pdf').getAttribute('aria-busy'),undefined);
    assert.equal(byId('download-quote-pdf').getAttribute('aria-label'),'Download PDF Estimate');
  }passed++;

  // Failed writes never claim success or mutate the current draft, and release
  // the download control so users can retry after resolving folder access.
  setup();const failedInputs=copy(audit.state.inputs);
  audit.setFetch(async()=>({ok:false,status:400,headers:{get:()=> 'application/json'},json:async()=>({error:'Folder is not writable.'})}));
  await audit.downloadQuotePdf();assert.match(byId('app-message').textContent,/not downloaded.*Folder is not writable/);
  assert.deepEqual(copy(audit.state.inputs),failedInputs);assert.equal(byId('download-quote-pdf').disabled,false);assert.equal(byId('download-quote-pdf').getAttribute('aria-busy'),undefined);passed++;

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
  await openOlder('metadata',element('button'));
  assert.equal(byId('quote-title').value,'P-1- Client- Site');
  for(const id of ['project-no','client','site-address'])byId(id).value='';
  audit.updateQuoteTitle();assert.equal(byId('quote-title').value,'Untitled quote');
  audit.setRequest(async()=>({id:'legacy',title:'Original legacy quote',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'workflow'}));
  await openOlder('legacy',element('button'));
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
  const renderedNumeric=cell=>['project-input-fields','input-sections','post-material-input-sections','adjustment-sections','material-inputs'].flatMap(id=>numericNodes(byId(id))).find(node=>node.dataset?.cell===cell);
  assert.equal(renderedNumeric('B15').value,'1.5');assert.equal(renderedNumeric('B28').value,'$invalid');
  assert.equal(renderedNumeric('B15').getAttribute('aria-invalid'),'true');assert.equal(audit.state.inputs.B15,12);assert.equal(audit.state.inputs.B28,0);
  assert.equal(audit.state.inputErrors.size,2);assert.equal(audit.state.dirty,true);assert.match(byId('app-message').textContent,/still need to be saved/);
  await byId('use-current-pricing').emit('click');assert.equal(renderedNumeric('B15').value,'1.5');assert.equal(renderedNumeric('B28').value,'$invalid');assert.equal(audit.state.inputErrors.size,2);passed++;

  // Identical validation messages cannot hide later invalid edits from a project-load guard.
  const originalCalculators=context.window.CeasefireCalculators;
  const invalidStamp=audit.projectStamp(),firstError=audit.state.inputErrors.get('B15');
  renderedNumeric('B15').value='1.6';await renderedNumeric('B15').emit('input');
  assert.equal(audit.state.inputErrors.get('B15'),firstError);assert.equal(audit.state.inputs.B15,12);
  assert.notEqual(audit.projectStamp(),invalidStamp);assert.equal(audit.state.inputDrafts.get('B15'),'1.6');
  context.window.CeasefireCalculators=originalCalculators;passed++;

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

  // One editable display label and scalar yield; distinct saved values survive viewing.
  const pricingFixture={inventory:[
    {id:'coat',item_code:'P-1',name:'Coating <literal>',sales_description:'Coating',supplier_price:100.123456,markup:.2,sales_price:120.1481472,pricing_mode:'supplier_markup'},
    {id:'unused',item_code:'P-2',name:'Fire collar product',sales_description:'Fire collar',supplier_price:20,markup:.1,sales_price:22,pricing_mode:'supplier_markup'},
    {id:'manual',item_code:'P-3',name:'Manual inventory',sales_description:'Manual',supplier_price:null,markup:0,sales_price:400,pricing_mode:'manual'}],
    rate_groups:{primers:[{id:'primer',inventory_id:'coat',name:'Primer choice',price:120.1481472,yield:10.123456,uses_yield:true,price_mode:'inventory'}],
      topcoats:[{id:'topcoat',inventory_id:'coat',name:'Topcoat choice',price:180.123456,yield:8,uses_yield:true,price_mode:'override'}],
      labour_rates:[{id:'team',inventory_id:null,name:'Site team',price:1000,yield:null,uses_yield:false,price_mode:'override'}],
      sprays:[{id:'duplicate-name',inventory_id:null,name:'Coating <literal>',price:55,yield:null,uses_yield:false,price_mode:'override'}]},
    rate_group_rules:{primers:{yield_column:'AR'},topcoats:{yield_column:'AV'},labour_rates:{yield_column:null},sprays:{yield_column:null}}};
  const pricingNodes=()=>{const walk=node=>[node,...(node.children||[]).flatMap(walk)];return walk(byId('pricing-body'));};
  const productRows=()=>byId('pricing-body').children.filter(row=>row.dataset.priceId);
  const productInput=(id,field)=>productRows().find(row=>row.dataset.priceId===id).children.flatMap(cell=>cell.children||[]).find(node=>node.dataset.priceField===field);
  const editList=async(id,field,value)=>{const input=productInput(id,field);input.value=value;await input.emit('input');await input.emit('change');return input;};
  setup();audit.state.baseline=copy(pricingFixture);audit.state.configuration={inventory:{},rates:{}};audit.state.draft={inventory:{},rates:{}};
  audit.state.pricingUsage={firestopping:{label:'Firestopping Estimator',source_field:'sales_description',keywords:['collar'],groups:[
    {key:'collars',label:'Collar Type',list_column:'B',keywords:['collar']},
    {key:'wraps',label:'Wrap Type',list_column:'E',keywords:['wrap']},
    {key:'materials',label:'Materials',list_column:'AR',keywords:['material']}]}};
  byId('pricing-search').value='';byId('rate-group').value='';audit.setRenderPricing(audit.renderPricing);audit.refreshPricingCatalog();audit.renderPricing();
  assert.deepEqual(byId('rate-group').children.map(option=>[option.value,option.textContent]),[
    ['','All estimator availability'],['main-estimator','Main Estimator'],['primers','Main Estimator — Primers'],['topcoats','Main Estimator — Topcoats'],['labour_rates','Main Estimator — Labour'],['sprays','Main Estimator — Sprays'],
    ['firestopping','Firestopping Estimator'],['firestopping:collars','Firestopping Estimator — Collar Type'],['firestopping:wraps','Firestopping Estimator — Wrap Type'],['firestopping:materials','Firestopping Estimator — Materials'],['not-used','Not used in either estimator']]);
  const originalPricing=JSON.stringify(pricingFixture);
  assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat','unused','manual','team','duplicate-name']);
  assert.equal(byId('pricing-body').children.length,5);assert.ok(!pricingNodes().some(node=>node.tagName==='details'));
  assert.equal(byId('pricing-head').children[0].children.length,10);
  assert.deepEqual(byId('pricing-head').children[0].children.filter(cell=>!cell.hidden).map(cell=>cell.textContent),['Item code','Product/Service','Supplier price','Markup %','Sell price','Estimator availability','Yield','Yield unit','Actions']);
  assert.equal(productInput('coat','Product/Service').value,'Coating <literal>');assert.equal(productInput('coat','Selection name'),undefined);
  assert.equal(productInput('coat','Main Estimator groups').value,'Primers; Topcoats');
  const firestoppingRow=productRows().find(row=>row.dataset.priceId==='unused');
  assert.equal(productInput('unused','Firestopping Estimator groups').value,'Collar Type');
  assert.equal(productInput('coat','Firestopping Estimator groups').value,'');
  assert.equal(productInput('team','Firestopping Estimator groups').disabled,true);
  assert.equal(productInput('coat','Yield').value,'Mixed');assert.equal(productInput('coat','Yield unit'),undefined);assert.equal(productRows()[0].children[7].textContent,'m² / unit');
  assert.equal(productInput('coat','Sell rate override').value,'; 180.123456');assert.equal(productInput('team','Yield'),undefined);
  assert.equal(productRows()[0].children[8].hidden,true);assert.match(productRows()[0].children[4].children[1].textContent,/Topcoats \$180.12/);
  assert.equal(audit.state.pricingDirty,false);assert.equal(JSON.stringify(pricingFixture),originalPricing);passed++;

  // Pricing items can be added and removed in the UI without leaving linked estimator rates behind.
  await byId('add-pricing-item').emit('click');const created=audit.state.catalog.inventory.find(item=>item.id==='inv-user-000001');assert.ok(created);assert.equal(created.product_service,'New pricing item');
  await editList(created.id,'Main Estimator groups','Primers');const createdRate=audit.state.catalog.rate_groups.primers.find(rate=>rate.inventory_id===created.id);assert.ok(createdRate);
  assert.equal(byId('app-message').textContent,"Estimator groups changed in the shared library draft. Click Save pricing to update dropdowns for new estimates. Existing projects keep their saved groups.");
  const removeCreated=pricingNodes().find(node=>node.dataset.pricingRemove===created.id);assert.equal(removeCreated.getAttribute('aria-label'),'Remove New pricing item');
  const removing=removeCreated.emit('click');await flush();assert.equal(byId('discard-dialog').open,true);await byId('discard-dialog').close('confirm');await removing;
  assert.ok(!audit.state.catalog.inventory.some(item=>item.id===created.id));assert.ok(!Object.values(audit.state.catalog.rate_groups).flat().some(rate=>rate.inventory_id===created.id));assert.equal(audit.state.draft.catalog,undefined);passed++;

  // Returning to unchanged pricing retains its controls and exact stored values.
  const unchangedRow=productRows()[0],unchangedHeading=byId('pricing-head').children[0],untouchedDraft=JSON.stringify(audit.state.draft);
  audit.showView('pricing');audit.showView('estimate');audit.showView('pricing');audit.showView('pricing');
  assert.equal(productRows()[0],unchangedRow);assert.equal(byId('pricing-head').children[0],unchangedHeading);
  assert.equal(JSON.stringify(audit.state.draft),untouchedDraft);assert.equal(audit.state.catalog.inventory[0].supplier_price,100.123456);passed++;

  // Reference library navigation preserves pending pricing text and lazy rendering.
  const libraryVisits=[],pendingPrice=productInput('coat','Product/Service'),pricingRow=productRows()[0];
  context.window.CeasefireLibraries={open:(...args)=>libraryVisits.push(args)};
  pendingPrice.value='Unfinished product description';await pendingPrice.emit('input');const pendingPricing=JSON.stringify(audit.state.draft);
  let libraryMove=context.window.CeasefireLibraryNavigation.open('penetration');await flush();
  assert.equal(byId('discard-dialog').querySelector('[value="confirm"]').textContent,'Continue');
  await byId('discard-dialog').close('confirm');await libraryMove;
  await context.window.CeasefireLibraryNavigation.open('technical','synthetic-reference');
  audit.showView('estimate');audit.showView('pricing');
  assert.equal(audit.state.libraryKind,'technical');assert.equal(byId('library-pricing').hidden,true);assert.equal(byId('library-technical').hidden,false);
  assert.ok(productRows()[0]===pricingRow);assert.equal(pendingPrice.value,'Unfinished product description');assert.equal(JSON.stringify(audit.state.draft),pendingPricing);
  assert.deepEqual(libraryVisits.map(args=>args[0]),['penetration','technical','technical']);
  await context.window.CeasefireLibraryNavigation.open('pricing');assert.ok(productRows()[0]===pricingRow);assert.equal(pendingPrice.value,'Unfinished product description');assert.equal(byId('library-pricing').hidden,false);
  pendingPrice.value='Coating <literal>';await pendingPrice.emit('input');await pendingPrice.emit('change');delete context.window.CeasefireLibraries;passed++;

  // In-place edits and replacement drafts invalidate navigation reuse.
  audit.state.draft.inventory.coat={supplier_price:234.567891};audit.showView('estimate');audit.showView('pricing');
  assert.notEqual(productRows()[0],unchangedRow);assert.equal(productInput('coat','supplier_price').value,'234.57');
  assert.equal(audit.state.draft.inventory.coat.supplier_price,234.567891);
  const previousDraftRow=productRows()[0];audit.state.draft=copy(audit.state.draft);audit.showView('pricing');
  assert.notEqual(productRows()[0],previousDraftRow);
  delete audit.state.draft.inventory.coat;audit.renderPricing();passed++;

  // Scope changes show the separate draft, then unchanged visits reuse that scope.
  const sharedRow=productRows()[0];audit.state.quoteConfiguration={inventory:{coat:{supplier_price:333.123456}},rates:{}};
  byId('pricing-scope').value='project';await byId('pricing-scope').emit('change');
  assert.notEqual(productRows()[0],sharedRow);assert.equal(productInput('coat','supplier_price').value,'333.12');
  assert.equal(byId('save-pricing-label').textContent,'Apply');assert.equal(byId('save-pricing').title,'Apply project pricing');assert.equal(byId('save-pricing').getAttribute('aria-label'),'Apply project pricing');
  const projectRow=productRows()[0];audit.showView('estimate');audit.showView('pricing');assert.equal(productRows()[0],projectRow);
  byId('pricing-scope').value='library';await byId('pricing-scope').emit('change');
  assert.equal(productInput('coat','supplier_price').value,'100.12');assert.equal(audit.state.projectPricingDraft.inventory.coat.supplier_price,333.123456);
  audit.state.quoteConfiguration=null;audit.state.projectPricingDraft=null;passed++;

  // Display labels never change the option value used by Calculator lookups.
  audit.state.inputs.D15='Old spray';
  const relabelled=audit.makeControl({...oldFields[0],option_labels:{'Old spray':'Descriptive product; 20 kg'}},true);
  assert.equal(relabelled.value,'Old spray');assert.equal(relabelled.options.find(option=>option.value==='Old spray').textContent,'Descriptive product; 20 kg');passed++;
  audit.state.inputs.D15='constructor';
  const unmatched=audit.makeControl({...oldFields[0],option_labels:{}},true);
  assert.equal(unmatched.options.find(option=>option.value==='constructor').textContent,'constructor');
  audit.state.inputs.D15='Old spray';passed++;

  // Viewing or leaving precise values alone never produces rounding overrides.
  const initialPricing=JSON.stringify(audit.state.draft);
  await productInput('coat','supplier_price').emit('blur');await productInput('coat','Yield').emit('change');
  assert.equal(JSON.stringify(audit.state.draft),initialPricing);assert.equal(productInput('coat','Yield').value,'Mixed');passed++;

  // Filters find every use, standalone rate and unused inventory item without changing membership.
  byId('rate-group').value='primers';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat']);
  assert.equal(productInput('coat','Main Estimator groups').value,'Primers; Topcoats');
  byId('rate-group').value='main-estimator';await byId('rate-group').emit('change');assert.ok(productRows().some(row=>row.dataset.priceId==='coat'));assert.ok(!productRows().some(row=>row.dataset.priceId==='unused'));
  byId('rate-group').value='firestopping';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused']);
  byId('rate-group').value='firestopping:collars';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused']);
  byId('rate-group').value='not-used';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['manual']);
  byId('rate-group').value='';await byId('rate-group').emit('change');
  await editList('unused','Firestopping Estimator groups','Wrap Type; Materials');
  assert.deepEqual(audit.state.catalog.inventory.find(item=>item.id==='unused').firestopping_groups,['wraps','materials']);
  byId('rate-group').value='firestopping:wraps';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused']);
  await editList('unused','Firestopping Estimator groups','');
  assert.deepEqual(audit.state.catalog.inventory.find(item=>item.id==='unused').firestopping_groups,[]);
  byId('rate-group').value='not-used';await byId('rate-group').emit('change');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused','manual']);
  byId('rate-group').value='';await byId('rate-group').emit('change');
  await productRows().find(row=>row.dataset.priceId==='unused').children.at(-1).children[0].emit('click');
  assert.equal(productInput('unused','Firestopping Estimator groups').value,'Collar Type');
  byId('rate-group').value='';byId('pricing-search').value='Topcoat choice';await byId('pricing-search').emit('input');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['coat']);
  byId('pricing-search').value='P-2';await byId('pricing-search').emit('input');assert.deepEqual(productRows().map(row=>row.dataset.priceId),['unused']);
  byId('pricing-search').value='no match';await byId('pricing-search').emit('input');assert.equal(productRows().length,0);
  byId('pricing-search').value='';audit.renderPricing();assert.equal(JSON.stringify(audit.state.draft),initialPricing);passed++;

  // Supplier edits update shared price while each explicit use override remains independent.
  productInput('coat','supplier_price').value='200';await productInput('coat','supplier_price').emit('input');
  assert.equal(productRows()[0].querySelector('[data-sell-preview]').textContent,'$240.00');
  byId('show-rate-overrides').checked=true;await byId('show-rate-overrides').emit('change');assert.equal(productRows()[0].children[8].hidden,false);
  assert.equal(productInput('team','Sell rate override'),undefined);
  assert.equal(productRows()[0].children[8].children[1].textContent,'$240.00; $180.12');
  await editList('coat','Sell rate override','250; 199');await editList('coat','Yield','12.75');
  productInput('coat','supplier_price').value='210';await productInput('coat','supplier_price').emit('input');
  assert.equal(productRows()[0].children[8].children[1].textContent,'$250.00; $199.00');
  assert.equal(audit.state.draft.catalog.rate_groups.primers[0].price_mode,'override');assert.equal(audit.state.draft.rates.primer.yield,12.75);
  await editList('coat','Sell rate override','; 199');
  assert.equal(productRows()[0].children[8].children[1].textContent,'$252.00; $199.00');assert.equal(audit.state.draft.rates.primer.yield,12.75);assert.equal(audit.state.draft.rates.topcoat.yield,12.75);passed++;

  // A scalar yield validates atomically; malformed input cannot export stale accepted data.
  const beforeBadList=JSON.stringify(audit.state.draft);const bad=await editList('coat','Yield','99; 100');
  assert.equal(bad.getAttribute('aria-invalid'),'true');assert.equal(JSON.stringify(audit.state.draft),beforeBadList);
  audit.showView('estimate');audit.showView('pricing');
  assert.equal(productInput('coat','Yield'),bad);assert.equal(bad.value,'99; 100');assert.equal(bad.getAttribute('aria-invalid'),'true');
  assert.equal(JSON.stringify(audit.state.draft),beforeBadList);passed++;
  audit.renderPricing();assert.equal(productInput('coat','Yield').value,'99; 100');
  let invalidExport=false;audit.setFetch(async()=>{invalidExport=true;throw new Error('unexpected');});await audit.exportPricing();assert.equal(invalidExport,false);
  for (const [legacyText, storedValue] of [['blank', null], ['empty text', '']]) {
    await editList('coat','Yield',legacyText);
    assert.equal(audit.state.draft.rates.primer.yield,storedValue);assert.equal(audit.state.draft.rates.topcoat.yield,storedValue);
    assert.equal(productInput('coat','Yield').value,'');
    const untouchedBlank=JSON.stringify(audit.state.draft);
    await productInput('coat','Yield').emit('change');audit.showView('estimate');audit.showView('pricing');
    assert.equal(productInput('coat','Yield').value,'');assert.equal(JSON.stringify(audit.state.draft),untouchedBlank);
  }
  await editList('coat','Yield','0');assert.equal(audit.state.draft.rates.primer.yield,0);assert.equal(audit.state.draft.rates.topcoat.yield,0);assert.equal(productInput('coat','Yield').value,'0');
  await editList('coat','Yield','142');assert.equal(audit.state.draft.rates.topcoat.yield,142);passed++;

  // Group edits retain matched identities and their values, and can add or remove uses on the same row.
  await editList('coat','Main Estimator groups','Topcoats; Primers; Labour');
  const added=audit.state.catalog.rate_groups.labour_rates.find(rate=>rate.inventory_id==='coat');assert.ok(added);
  assert.equal(audit.state.catalog.rate_groups.primers[0].id,'primer');assert.equal(audit.state.catalog.rate_groups.topcoats[0].price,199);
  await editList('coat','Main Estimator groups','Topcoats');assert.equal(audit.state.catalog.rate_groups.primers.length,0);
  assert.equal(audit.state.catalog.rate_groups.topcoats[0].id,'topcoat');assert.equal(audit.state.draft.rates.topcoat.yield,142);assert.equal(audit.state.draft.rates.primer,undefined);
  assert.ok(!audit.state.catalog.rate_groups.labour_rates.some(rate=>rate.inventory_id==='coat'));
  await editList('unused','Main Estimator groups','Primers');assert.equal(audit.state.catalog.rate_groups.primers[0].inventory_id,'unused');passed++;
  await editList('unused','Yield','44');await editList('unused','Main Estimator groups','Primers; Topcoats');
  assert.equal(audit.state.catalog.rate_groups.topcoats.find(rate=>rate.inventory_id==='unused').yield,44);assert.equal(productInput('unused','Yield').value,'44');passed++;

  // Product/Service accepts literal semicolons and preserves existing lookup keys.
  await editList('coat','Product/Service','Topcoat; <literal> ');await editList('coat','Item code','NEW-204');
  assert.equal(audit.state.catalog.rate_groups.topcoats[0].name,'Topcoat choice');assert.equal(productInput('coat','Product/Service').value,'Topcoat; <literal> ');assert.equal(audit.state.draft.inventory.coat.product_service,'Topcoat; <literal> ');assert.equal(audit.state.catalog.rate_groups.topcoats[0].yield_unit,undefined);
  assert.equal(audit.state.catalog.inventory[0].item_code,'NEW-204');assert.equal(audit.state.draft.rates.topcoat.yield,142);
  assert.equal(productInput('team','Yield unit'),undefined);assert.equal(productRows().find(row=>row.dataset.priceId==='team').children[7].textContent,'');
  // Legacy descriptive labels cannot misrepresent the unit used by the calculation.
  audit.state.catalog.rate_groups.topcoats[0].yield_unit='m² / drum; explanatory text';audit.renderPricing();
  assert.equal(productRows()[0].children[7].textContent,'m² / unit');delete audit.state.catalog.rate_groups.topcoats[0].yield_unit;passed++;

  // Export includes every product and use, irrespective of current search; the saved configuration is untouched.
  productInput('manual','sales_price').value='450';await productInput('manual','sales_price').emit('input');productInput('team','price').value='1050';await productInput('team','price').emit('input');
  byId('pricing-search').value='Topcoat;';await byId('pricing-search').emit('input');let unifiedExport;
  audit.setFetch(async(path,options)=>{unifiedExport=JSON.parse(options.body).configuration;return savedResponse('ceasefire-pricing.xlsx');});await audit.exportPricing();
  assert.equal(unifiedExport.inventory.manual.sales_price,450);assert.equal(unifiedExport.rates.team.price,1050);
  assert.equal(unifiedExport.catalog.rate_groups.topcoats[0].yield_unit,undefined);assert.equal(audit.state.configuration.inventory.manual,undefined);
  assert.equal(JSON.stringify(pricingFixture),originalPricing);assert.match(byId('app-message').textContent,/all inventory and rate groups/);passed++;

  // Reset row restores all saved fields and uses for this item without losing another item's edits.
  byId('pricing-search').value='';audit.renderPricing();
  const unaffected=JSON.stringify(audit.state.draft.inventory.manual);
  await productRows().find(row=>row.dataset.priceId==='coat').children.at(-1).children[0].emit('click');
  assert.equal(productInput('coat','Item code').value,'P-1');assert.equal(productInput('coat','Main Estimator groups').value,'Primers; Topcoats');
  assert.equal(productInput('coat','Yield').value,'Mixed');assert.equal(productInput('coat','Sell rate override').value,'; 180.123456');
  assert.equal(productRows()[0].children[7].textContent,'m² / unit');assert.equal(audit.state.draft.rates.topcoat,undefined);
  assert.equal(audit.state.draft.inventory.coat,undefined);assert.equal(JSON.stringify(audit.state.draft.inventory.manual),unaffected);
  assert.equal(audit.state.draft.rates.team.price,1050);passed++;

  // A new use without a yield does not receive a yield override.
  await editList('coat','Main Estimator groups','Primers; Topcoats; Labour');
  const noYieldRate=audit.state.catalog.rate_groups.labour_rates.find(rate=>rate.inventory_id==='coat');
  await editList('coat','Yield','10.123456789');
  assert.equal(audit.state.draft.rates.primer.yield,10.123456789);assert.equal(audit.state.draft.rates.topcoat.yield,10.123456789);
  assert.equal(audit.state.draft.rates[noYieldRate.id],undefined);passed++;

  // An item spanning area and length units cannot silently share one scalar.
  audit.state.draft.catalog.rate_groups.mastic=[{id:'linear-use',name:'Linear use',inventory_id:'coat',price:120,price_mode:'inventory',yield:3,uses_yield:true}];
  audit.refreshPricingCatalog();audit.renderPricing();const beforeMixedUnits=JSON.stringify(audit.state.draft);
  assert.equal(productInput('coat','Yield').readOnly,true);
  const mixedEdit=await editList('coat','Yield','5');assert.equal(mixedEdit.getAttribute('aria-invalid'),'true');assert.equal(JSON.stringify(audit.state.draft),beforeMixedUnits);passed++;

  // The same row reset restores the project's frozen overrides, never shared-library prices.
  const frozenPricing={catalog:copy(pricingFixture),inventory:{coat:{supplier_price:333}},rates:{primer:{price:555,yield:71}}};
  audit.state.quoteConfiguration=copy(frozenPricing);audit.state.pricingScope='project';audit.state.draft=copy(frozenPricing);
  audit.refreshPricingCatalog();audit.renderPricing();await editList('coat','Item code','CHANGED');await editList('coat','Sell rate override','; 199');
  await productRows().find(row=>row.dataset.priceId==='coat').children.at(-1).children[0].emit('click');
  assert.equal(JSON.stringify(audit.state.draft),JSON.stringify(frozenPricing));assert.equal(productInput('coat','Sell rate override').value,'555; 180.123456');
  assert.deepEqual(copy(audit.state.configuration),{inventory:{},rates:{}});audit.state.pricingScope='library';audit.state.quoteConfiguration=null;passed++;

  // Reset confirmation cannot replace a different scope or a newer draft, and a reset stays unsaved.
  audit.state.pricingScope='project';audit.state.quoteConfiguration=copy(frozenPricing);audit.state.draft=copy(frozenPricing);
  let resetting=byId('reset-pricing').emit('click');await flush();
  assert.match(byId('discard-dialog').querySelector('p').textContent,/Apply project pricing/);
  audit.state.pricingScope='library';const newerDraft={inventory:{manual:{sales_price:450}},rates:{}};audit.state.draft=newerDraft;
  await byId('discard-dialog').close('confirm');await resetting;assert.equal(audit.state.draft,newerDraft);
  assert.match(byId('app-message').textContent,/changed during reset/);passed++;
  resetting=byId('reset-pricing').emit('click');await flush();await byId('discard-dialog').close('confirm');await resetting;
  assert.deepEqual(copy(audit.state.draft),{inventory:{},rates:{}});assert.deepEqual(copy(audit.state.configuration),{inventory:{},rates:{}});
  assert.match(byId('app-message').textContent,/ready as a draft/);audit.state.quoteConfiguration=null;passed++;
  audit.setRenderPricing(()=>{audit.state.pricingDirty=JSON.stringify(audit.state.draft)!==JSON.stringify(audit.state.configuration);});byId('pricing-search').value='';byId('rate-group').value='';

  // Saved workflow labels and summary data remain available without either removed UI control.
  setup();audit.setRequest(async()=>({id:'wrap',title:'Saved wrap quote',configuration:oldConfig,fields:oldFields,inputs:{D15:'Old spray'},workflow:'Fire wrap to ductwork'}));
  await openOlder('wrap',element('button'));let calculationBody;
  audit.setRequest(async(path,options)=>{calculationBody=JSON.parse(options.body);return {summary:{total:1.2345,days:2.345},cells:{},materials:[],errors:{},notes:'Literal product 1.2345',work_summary:'Fire wrap to ductwork\nWrap: 12.35 m² <b>literal label</b>'};});
  await audit.calculate();assert.equal(calculationBody.workflow,'Fire wrap to ductwork');
  assert.equal(audit.state.result.work_summary,'Fire wrap to ductwork\nWrap: 12.35 m² <b>literal label</b>');
  assert.equal(byId('sum-days').textContent,'2.35');assert.equal(byId('sum-total').textContent,'$1.23');
  assert.equal(audit.state.result.notes,'Literal product 1.2345');
  assert.ok(!fs.readFileSync('static/index.html','utf8').includes('id="calculated-notes"'));passed++;

  // New estimates keep normal defaults but start Notes blank without mutating source metadata.
  const notesField=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields.find(field=>field.cell==='B12');
  assert.equal(notesField.default,'Allowances');
  const currentNotesFields=[...copy(newFields),notesField],sourceNotesFields=JSON.stringify(currentNotesFields);
  setup();audit.setRequest(async path=>{assert.equal(path,'/api/bootstrap');return {configuration:newConfig,fields:currentNotesFields,workflows:['Intumescent spray to ductwork','Fire wrap to ductwork']};});
  await audit.bootstrap();assert.equal(audit.state.workflow,'Intumescent spray to ductwork');assert.equal(audit.state.defaultWorkflow,'Intumescent spray to ductwork');assert.equal(audit.state.currentView,'home');
  assert.equal(audit.reportPayload().workflow,'Intumescent spray to ductwork');assert.deepEqual(copy(audit.state.inputs),{D15:'New spray',B12:''});
  assert.equal(audit.makeControl(audit.state.fields.find(field=>field.cell==='B12'),true).value,'');
  assert.equal(JSON.stringify(currentNotesFields),sourceNotesFields);assert.equal(audit.state.currentFields.find(field=>field.cell==='B12').default,'Allowances');
  audit.renderResults({});passed++;

  // B12 has no second editor anywhere in the form; all other inputs and the main NOTES remain.
  setup();audit.state.fields=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields;
  audit.state.fields.find(field=>field.cell==='D7').label='Masking/Cleaning labour';
  audit.state.inputs=Object.fromEntries(audit.state.fields.map(field=>[field.cell,field.default??'']));
  audit.state.inputs.B12='Historical workbook note';byId('measurements').value='Visible main note';
  const hiddenNotesInputs=JSON.stringify(audit.state.inputs),hiddenNotesFields=JSON.stringify(audit.state.fields);
  audit.renderInputs();
  const inputDescendants=node=>[node,...(node.children||[]).flatMap(inputDescendants)];
  const visibleCells=['project-input-fields','input-sections','post-material-input-sections','adjustment-sections','material-inputs'].flatMap(id=>inputDescendants(byId(id))).filter(node=>node.dataset?.cell).map(node=>node.dataset.cell);
  assert.ok(!visibleCells.includes('B12'));assert.equal(visibleCells.length,audit.state.fields.length-1);
  assert.deepEqual(visibleCells.slice().sort(),audit.state.fields.filter(field=>field.cell!=='B12').map(field=>field.cell).sort());
  assert.equal(JSON.stringify(audit.state.inputs),hiddenNotesInputs);assert.equal(JSON.stringify(audit.state.fields),hiddenNotesFields);
  assert.equal(audit.reportPayload().inputs.B12,'Historical workbook note');assert.equal(audit.reportPayload().measurements,'Visible main note');
  assert.match(fs.readFileSync('static/index.html','utf8'),/<textarea[^>]*id="measurements"/);passed++;

  // Material requirement rows follow their labour selections, and masking help explains its basis.
  setup();audit.setRenderInputs(audit.renderInputs);audit.state.fields=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields;
  audit.state.fields.find(field=>field.cell==='D7').label='Masking/Cleaning labour';
  audit.state.inputs=Object.fromEntries(audit.state.fields.map(field=>[field.cell,field.default??'']));
  for(const cell of ['D2','D3','D4','D5','D6','D7','D8','D9','D10'])audit.state.inputs[cell]='N/A';
  audit.renderInputs();
  assert.deepEqual(byId('material-inputs').children.map(row=>row.hidden),[true,true,true,true,true,true,true,true,true]);
  assert.ok(!inputDescendants(byId('post-material-input-sections')).some(node=>node.textContent==='Masking/Cleaning'));
  let maskingTeam=inputDescendants(byId('input-sections')).find(node=>node.dataset?.cell==='D7');
  assert.equal(maskingTeam.parent.children[0].textContent,'Masking/Cleaning labour');
  maskingTeam.value='1 Team - 1x';await maskingTeam.emit('input');
  assert.ok(inputDescendants(byId('post-material-input-sections')).some(node=>node.textContent==='Masking/Cleaning'));
  const maskingControl=inputDescendants(byId('post-material-input-sections')).find(node=>node.dataset?.cell==='B9');
  assert.equal(maskingControl.title,'Masking/cleaning is a percentage of Spray labour.');
  assert.equal(maskingControl.getAttribute('aria-description'),'Masking/cleaning is a percentage of Spray labour.');
  assert.equal(maskingControl.parent.children[0].title,'Masking/cleaning is a percentage of Spray labour.');
  maskingTeam=inputDescendants(byId('input-sections')).find(node=>node.dataset?.cell==='D7');maskingTeam.value='N/A';await maskingTeam.emit('input');
  assert.ok(!inputDescendants(byId('post-material-input-sections')).some(node=>node.textContent==='Masking/Cleaning'));
  const sprayTeam=inputDescendants(byId('input-sections')).find(node=>node.dataset?.cell==='D2');sprayTeam.value='1 Team - 1x';await sprayTeam.emit('input');
  assert.equal(byId('material-inputs').children[0].hidden,false);assert.ok(byId('material-inputs').children.slice(1).every(row=>row.hidden));
  const html=fs.readFileSync('static/index.html','utf8');
  assert.ok(html.indexOf('id="penetration-add-to-library"')<html.indexOf('id="penetration-recalculate"'));
  assert.ok(html.indexOf('id="input-sections"')<html.indexOf('id="materials-heading"'));assert.ok(html.indexOf('id="materials-heading"')<html.indexOf('id="post-material-input-sections"'));
  assert.ok(html.indexOf('id="project-save-state"')<html.indexOf('<nav aria-label="Main navigation">'));assert.doesNotMatch(html,/id="project-file-name"/);
  assert.match(html,/id="penetration-add-to-schedule"[^>]*penetration-add-action[^>]*title="Add to Schedule"/);assert.match(html,/id="penetration-update-schedule"[^>]*penetration-update-action/);
  for(const id of ['penetration-recalculate','penetration-schedule-recalculate','penetration-estimator-schedule-recalculate','calculator-recalculate','library-editor-recalculate'])assert.match(html,new RegExp(`id="${id}"[^>]*recalculate-button`));
  assert.match(html,/id="link-project-folder"[^>]*link-action-button/);assert.match(html,/id="penetration-pdf"[\s\S]*?<span class="download-arrow">Σ<\/span>/);
  assert.doesNotMatch(html,/id="calculator-page-status"/);
  const penetrationCss=fs.readFileSync('static/penetration.css','utf8'),libraryCss=fs.readFileSync('static/libraries.css','utf8'),stylesCss=fs.readFileSync('static/styles.css','utf8');
  assert.match(penetrationCss,/\.penetration-add-action,.penetration-new-item-action\{[^}]*border-radius:10px/);assert.match(libraryCss,/\.library-summary-table\{[^}]*border:0/);
  assert.match(stylesCss,/\.button\.recalculate-button\{[^}]*background:#fff[^}]*box-shadow:none/);assert.doesNotMatch(stylesCss,/\.button\.recalculate-button\{[^}]*#257a45/);assert.match(stylesCss,/\.button\.link-action-button\{[^}]*background:#d97706/);
  assert.match(stylesCss,/\.button\.library-edit-button,\.button\.library-delete-button\{[^}]*background:#fff[^}]*box-shadow:none/);
  assert.match(libraryCss,/\.library-item-actions \.button\{[^}]*height:48px[^}]*min-height:48px/);assert.match(libraryCss,/\.library-delete\{[^}]*width:48px[^}]*height:48px/);
  assert.ok(html.indexOf('id="penetration-item-quantity"')<html.indexOf('id="penetration-add-to-schedule"'));
  assert.match(html,/data-view="home"[^>]*aria-current="page"[^>]*>Home</);assert.match(html,/data-view="help"[^>]*>Help</);
  assert.match(html,/data-home-view="estimate"/);assert.match(html,/data-home-view="pricing"/);assert.match(html,/data-home-view="calculators"/);assert.match(html,/data-home-view="quotes"/);
  assert.match(html,/id="penetration-add"[^>]*penetration-new-item-action[^>]*title="Add new item"/);
  assert.ok(html.indexOf('id="penetration-schedule-heading"')<html.indexOf('id="penetration-schedule-recalculate"'));assert.ok(html.indexOf('id="penetration-schedule-recalculate"')<html.indexOf('<div class="table-scroll"><table><thead><tr><th scope="col">Item</th>'));
  assert.match(html,/<th scope="col">Total<\/th><th scope="col">Diagram<\/th><th scope="col">Actions<\/th>/);
  assert.doesNotMatch(html,/<th scope="col">Status<\/th>/);
  assert.match(html,/<details class="card expandable-breakdown firestopping-breakdown"[^>]*>\s*<summary><h2>Firestopping Breakdown<\/h2><\/summary>/);
  assert.doesNotMatch(html,/<details class="card expandable-breakdown firestopping-breakdown"[^>]*\sopen>/);
  assert.doesNotMatch(html,/firestopping-breakdown-part|Schedule breakdown/);
  assert.match(html,/<details class="card expandable-breakdown material-breakdown-section"[^>]*><summary><h2 id="breakdown-heading">Material Breakdown<\/h2><\/summary>/);
  assert.doesNotMatch(html,/<details class="card expandable-breakdown material-breakdown-section"[^>]*\sopen>/);
  assert.match(html,/<details class="card expandable-breakdown labour-breakdown-section" id="labour-breakdown"[^>]*><summary><h2 id="labour-heading">Labour Breakdown<\/h2><\/summary>/);
  assert.doesNotMatch(html,/<details class="card expandable-breakdown labour-breakdown-section"[^>]*\sopen>/);
  assert.ok(html.indexOf('id="penetration-schedule-breakdown-card"')<html.indexOf('id="breakdown-heading"'));
  assert.match(html,/id="penetration-schedule-breakdown-card"[^>]*>\s*<summary><h2>Firestopping Breakdown<\/h2><\/summary>\s*<div id="penetration-schedule-breakdown"/);
  assert.match(html,/<section class="penetration-schedule-summary-section"[^>]*>\s*<h3[^>]*>Summary<\/h3>/);
  assert.doesNotMatch(html,/<summary><h3[^>]*>Summary<\/h3><\/summary>/);
  assert.match(html,/<details class="card expandable-breakdown penetration-item-breakdown"[^>]*>\s*<summary><h3[^>]*>Item Breakdown<\/h3><\/summary>/);
  assert.doesNotMatch(html,/Selected item breakdown|Calculation source|id="penetration-source"/);
  assert.match(html,/<th scope="col">Item<\/th><th scope="col">Service Type<\/th>/);passed++;

  // Every material row can be duplicated with the same editable inputs and its
  // extra row is included in calculation/report payloads until removed.
  setup();audit.state.fields=JSON.parse(fs.readFileSync('data/calculator.json','utf8')).fields;
  audit.state.inputs=Object.fromEntries(audit.state.fields.map(field=>[field.cell,field.default??'']));audit.state.inputs.D4='1 Team - 1x';audit.setRenderInputs(audit.renderInputs);audit.renderInputs();
  audit.addWorkItem(20);const duplicate=audit.state.workItems[0];
  assert.equal(duplicate.source_row,20);assert.deepEqual(copy(duplicate.inputs),Object.fromEntries(['B','C','D','E'].map(column=>[column,audit.state.inputs[`${column}20`]])));
  assert.equal(byId('material-inputs').children.length,10);assert.equal(audit.reportPayload().work_items[0].id,duplicate.id);
  const duplicateCoverage=inputDescendants(byId('material-inputs')).find(node=>node.id===`work-item-${duplicate.id}-B`);
  duplicateCoverage.value='12';await duplicateCoverage.emit('input');assert.equal(duplicate.inputs.B,12);assert.equal(audit.state.dirty,true);
  const duplicateRow=byId('material-inputs').children.find(row=>row.dataset.workItem===duplicate.id);
  const duplicateAction=inputDescendants(duplicateRow).find(node=>node.title==='Duplicate Primer work item');
  await duplicateAction.emit('click');assert.equal(audit.state.workItems.length,2);
  const removeAction=inputDescendants(duplicateRow).find(node=>node.title==='Remove Primer duplicated work item');
  await removeAction.emit('click');assert.equal(audit.state.workItems.length,1);passed++;

  // Main Estimator sections from Access & Travel onwards are expandable and closed by default.
  assert.match(html,/<details class="card expandable-breakdown" aria-labelledby="materials-heading">\s*<summary><h2 id="materials-heading">Material Requirements &amp; Output<\/h2><\/summary>/);
  assert.match(html,/<details class="card expandable-breakdown penetration-schedule" aria-labelledby="penetration-schedule-heading">\s*<summary><h2 id="penetration-schedule-heading">Firestopping Schedule<\/h2>/);
  assert.doesNotMatch(html,/<details class="card expandable-breakdown(?: penetration-schedule)?"[^>]*\sopen/);
  assert.match(html,/<dialog id="notice-dialog"[^>]*>[\s\S]*?<button id="notice-button"[^>]*>OK<\/button>[\s\S]*?<\/dialog>/);
  assert.doesNotMatch(html,/<dialog id="notice-dialog"[^>]*>[\s\S]*?notice-cancel/);
  for(const section of [...byId('input-sections').children,...byId('post-material-input-sections').children,...byId('adjustment-inputs').children]) {
    assert.equal(section.tagName,'details');assert.equal(section.open,undefined);
  }
  passed++;

  // Montserrat is bundled locally and all primary section cards use the red accent.
  const css=fs.readFileSync('static/styles.css','utf8');
  assert.match(css,/@font-face\{font-family:"Montserrat"/);assert.match(css,/:root\{[^}]*font-family:"Montserrat",Arial,sans-serif/);
  assert.doesNotMatch(css,/"Segoe UI"/);assert.match(css,/\.card\{[^}]*border-top:3px solid var\(--red\)/);passed++;

  // Labour rows display source-projected days, preserve literal labels, and read the authoritative total.
  setup();const labourResult={summary:{days:16.987654321},cells:{},errors:{},materials:[],labour:{
    tasks:[{name:'Spray / wrap',days:1.23456789},{name:'Mesh <literal>',days:2},{name:'Access panels',days:0},{name:'Fan enclosure mesh',days:3},{name:'Primer',days:0},{name:'Topcoat',days:0},{name:'Board',days:1},{name:'Mastic',days:0}],
    task_days:7.23456789,masking_days:0.123456789,extra_days:1.5,mobilisation_days:.75,total_days:16.987654321}};
  const labourBefore=JSON.stringify(labourResult);audit.renderResults(labourResult);
  const labourRows=()=>byId('labour-results').children;
  assert.equal(labourRows().length,12);assert.equal(labourRows()[0].children[1].textContent,'1.23');assert.equal(labourRows()[1].children[0].textContent,'Mesh <literal>');assert.equal(labourRows()[2].children[1].textContent,'0.00');
  assert.ok(!labourRows().some(row=>row.children[0].textContent==='Task labour subtotal'));assert.equal(labourRows()[10].children[0].textContent,'Mobilisation allowance');assert.equal(labourRows()[10].children[1].textContent,'0.75');
  assert.equal(labourRows()[11].children[0].textContent,'Total project days');assert.equal(labourRows()[11].children[1].textContent,'16.99');assert.equal(byId('sum-days').textContent,'16.99');
  assert.equal(labourRows()[0].children[0].scope,'row');assert.equal(JSON.stringify(labourResult),labourBefore);assert.equal(byId('labour-breakdown').getAttribute('aria-busy'),'false');passed++;

  // Detailed Firestopping tasks reconcile to one Labour Breakdown row.
  const reconciled=copy(labourResult);reconciled.labour.tasks.push(
    {source:'firestopping',name:'Firestopping · Collars',days:.1875},
    {source:'firestopping',name:'Firestopping · Mastic',days:.3125});reconciled.labour.firestopping_days=.5;
  audit.renderResults(reconciled);assert.equal(labourRows().filter(row=>row.children[0].textContent==='Firestopping').length,1);assert.equal(labourRows().find(row=>row.children[0].textContent==='Firestopping').children[1].textContent,'0.50');assert.ok(!labourRows().some(row=>row.children[0].textContent.startsWith('Firestopping ·')));passed++;

  // Missing and failed labour values remain unavailable or explicit errors rather than plausible zero days.
  const missingLabour=copy(labourResult);missingLabour.labour.tasks[0].days=null;missingLabour.labour.masking_days='#DIV/0!';missingLabour.labour.mobilisation_days='';missingLabour.labour.total_days='#N/A';
  audit.renderResults(missingLabour);assert.equal(labourRows()[0].children[1].textContent,'—');assert.equal(labourRows()[8].children[1].textContent,'#DIV/0!');assert.equal(labourRows()[10].children[1].textContent,'—');assert.equal(labourRows()[11].children[1].textContent,'#N/A');
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
    await openOlder('notes-quote',element('button'));assert.equal(audit.state.inputs.B12,savedNotes);
    audit.renderInputs();
    assert.ok(!['project-input-fields','input-sections','post-material-input-sections','adjustment-sections','material-inputs'].flatMap(id=>inputDescendants(byId(id))).some(node=>node.dataset?.cell==='B12'));
    byId('measurements').value='Edited main note';await byId('measurements').emit('input');assert.equal(audit.state.dirty,true);
    let notesBody;audit.setRequest(async(path,options)=>{notesBody=JSON.parse(options.body);return {id:'notes-quote',...notesBody,fields:currentNotesFields};});
    await audit.saveQuote();assert.equal(notesBody.inputs.B12,savedNotes);assert.equal(audit.reportPayload().inputs.B12,savedNotes);assert.equal(notesBody.measurements,'Edited main note');
    assert.equal(audit.state.fields.find(field=>field.cell==='B12').default,'Allowances');
    audit.setRequest(async()=>({id:'notes-quote',...notesBody,fields:currentNotesFields}));
    await openOlder('notes-quote',element('button'));assert.equal(audit.state.inputs.B12,savedNotes);assert.equal(byId('measurements').value,'Edited main note');
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
    await openOlder('historical-workflow',element('button'));
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

  // A library editing session uses the Firestopping view without opening or
  // replacing the project controller, its draft, or an unsaved pricing draft.
  setup();let librarySession=true,projectOpens=0;const libraryReturns=[];
  const priorPenetrations=context.window.CeasefirePenetrations,priorLibraries=context.window.CeasefireLibraries;
  context.window.CeasefirePenetrations={open(){projectOpens++;}};
  context.window.CeasefireLibraries={open(kind,id){libraryReturns.push({kind,id});}};
  context.window.CeasefireLibraryEditor={isOpen:()=>librarySession};
  audit.state.inputs.D15='Unchanged project input';audit.state.draft.rates.unsaved={price:77.123456789};const protectedState=copy({inputs:audit.state.inputs,draft:audit.state.draft});
  context.window.CeasefireLibraryEditorNavigation.show();assert.equal(audit.state.currentView,'calculators');assert.equal(audit.state.estimatorKind,'penetration');assert.equal(projectOpens,0);
  assert.equal(byId('firestopping-project-workspace').hidden,true);assert.equal(byId('firestopping-library-editor').hidden,false);assert.equal(byId('estimator-penetration').getAttribute('aria-labelledby'),'library-editor-heading');
  context.window.CeasefireLibraryEditorNavigation.returnToLibrary('legacy-row-4');assert.deepEqual(libraryReturns,[{kind:'penetration',id:'legacy-row-4'}]);assert.equal(audit.state.currentView,'pricing');
  librarySession=false;audit.showView('estimate');assert.equal(projectOpens,0);assert.equal(byId('firestopping-project-workspace').hidden,false);assert.equal(byId('firestopping-library-editor').hidden,true);
  assert.deepEqual(copy({inputs:audit.state.inputs,draft:audit.state.draft}),protectedState);assert.equal(byId('estimator-penetration').getAttribute('aria-labelledby'),'penetration-heading');
  context.window.CeasefirePenetrations=priorPenetrations;context.window.CeasefireLibraries=priorLibraries;delete context.window.CeasefireLibraryEditor;passed++;

  // Main Estimator navigation opens only the committed schedule calculation;
  // the independent current item is opened explicitly in its own workspace.
  setup();const workspaceOpens=[];
  context.window.CeasefirePenetrations={open(){workspaceOpens.push('item');},openSchedule(){workspaceOpens.push('schedule');}};
  context.window.CeasefirePenetrationNavigation.showSchedule();assert.equal(audit.state.estimatorKind,'estimate');assert.equal(byId('estimator-main').hidden,false);
  context.window.CeasefirePenetrationNavigation.show();assert.equal(audit.state.estimatorKind,'penetration');
  assert.deepEqual(workspaceOpens,['schedule','item']);context.window.CeasefirePenetrations=priorPenetrations;passed++;

  const markup=fs.readFileSync('static/index.html','utf8');
  const actionCss=fs.readFileSync('static/styles.css','utf8');
  assert.doesNotMatch(markup,/id="save-quote"/);assert.match(markup,/id="save-project"[^>]*class="button save-button"/);
  assert.match(markup,/id="save-current-project"[^>]*class="button save-button icon-only"[^>]*aria-label="Save"[^>]*title="Save"/);
  assert.match(markup,/id="download-quote-pdf"[^>]*class="[^"]*pdf-button[^"]*icon-only[^"]*"[^>]*aria-label="Download PDF Estimate"[^>]*title="Download PDF Estimate"/);
  assert.match(markup,/id="download-quote-pdf"[\s\S]*?<span class="download-arrow">Σ<\/span>/);
  assert.ok(actionCss.includes('.button.save-button{color:#332600;background:#ffdb66;'));
  assert.ok(actionCss.includes('.button.pdf-button{color:#fff;background:#c5221f;'));
  assert.ok(actionCss.includes('.button[aria-busy=true]::after'));
  assert.match(actionCss,/@media\(max-width:570px\).*\.app-header nav\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  for(const state of [':hover:not(:disabled)',':focus-visible',':disabled'])assert.ok(actionCss.includes(`.button:is(.excel-button,.save-button,.pdf-button)${state}`));
  assert.doesNotMatch(markup,/id="print-quote"/);assert.doesNotMatch(source,/function printQuote|window\.print/);
  assert.match(markup,/id="new-quote"[^>]*>New<\/button>/);assert.doesNotMatch(markup,/id="edit-project-details"/);assert.match(markup,/id="load-project"[^>]*>Load<\/button>/);
  assert.match(markup,/id="libraries-heading">Price &amp; Technical Libraries<\/h1>/);
  assert.match(markup,/id="add-pricing-item"[^>]*>\+ Add item<\/button>/);assert.match(markup,/id="link-project-folder"[^>]*aria-label="Link Project Folder"/);assert.match(markup,/id="refresh-quotes"[^>]*aria-label="Refresh"/);
  const pricingTable=markup.indexOf('class="pricing-table"');
  for(const id of ['export-pricing','import-pricing','discard-pricing','reset-pricing','save-pricing'])assert.ok(markup.indexOf(`id="${id}"`)<pricingTable);
  assert.match(markup,/id="save-pricing"[^>]*class="button save-button icon-only"[^>]*aria-label="Save pricing"[^>]*title="Save pricing"/);
  assert.ok((markup.match(/class="button-symbol save-symbol"/g)||[]).length>=2);assert.ok(actionCss.includes('.save-symbol,.save-symbol svg{display:block;width:24px;height:24px}'));
  assert.match(markup,/id="pricing-scope"><option value="library">Main Library<\/option><option value="project">Current Project<\/option>/);
  for(const [id,label] of [['export-pricing','Export Excel'],['import-pricing','Import Excel'],['discard-pricing','Discard Changes'],['reset-pricing','Reset Library']])assert.match(markup,new RegExp(`id="${id}"[^>]*class="[^"]*icon-only[^"]*"[^>]*aria-label="${label}"[^>]*title="${label}"`));
  assert.ok(markup.indexOf('id="add-pricing-item"')>markup.indexOf('id="pricing-body"'));
  assert.match(markup,/id="penetration-undo"[^>]*class="button secondary icon-only"[^>]*aria-label="Undo remove"[^>]*title="Undo remove"/);
  assert.match(markup,/id="penetration-excel"[^>]*class="button excel-button icon-only schedule-download-button"[^>]*aria-label="Download schedule XLSX"[^>]*title="Download schedule XLSX"/);
  assert.match(markup,/id="penetration-pdf"[^>]*class="button pdf-button icon-only schedule-download-button"[^>]*aria-label="Download schedule PDF"[^>]*title="Download schedule PDF"/);
  assert.match(markup,/<div class="penetration-row-tools penetration-schedule-recalculate-tools"><button id="penetration-schedule-recalculate"[\s\S]*?<button id="penetration-excel"[\s\S]*?<button id="penetration-pdf"/);
  assert.ok(markup.indexOf('id="penetration-schedule-recalculate"')<markup.indexOf('id="penetration-excel"'));assert.ok(markup.indexOf('id="penetration-pdf"')<markup.indexOf('id="penetration-schedule-body"'));
  assert.doesNotMatch(markup,/id="estimator-view-heading"|Build and review the project's material, labour and firestopping totals/);
  assert.match(markup,/id="calculators-heading">Product Calculators<\/h1>/);assert.doesNotMatch(markup,/Proposal Calculators/);
  assert.ok(markup.indexOf('id="calculator-template"')<markup.indexOf('id="calculator-reset"'));assert.ok(markup.indexOf('id="calculator-reset"')<markup.indexOf('id="calculator-recalculate"'));
  for(const id of ['calculator-template','calculator-reset','calculator-recalculate'])assert.match(markup,new RegExp(`id="${id}"[^>]*class="[^"]*secondary[^"]*"`));
  assert.doesNotMatch(markup,/id="calculator-template"[^>]*(?:excel-button|calculator-export-excel)/);assert.doesNotMatch(markup,/id="calculator-reset"[^>]*pricing-reset-button/);
  for(const id of ['penetration-item-excel','penetration-item-pdf','penetration-estimator-schedule-body','penetration-estimator-schedule-recalculate','penetration-estimator-add','penetration-estimator-undo'])assert.match(markup,new RegExp(`id="${id}"`));
  assert.ok(markup.indexOf('id="penetration-item-excel"')<markup.indexOf('id="penetration-item-pdf"'));
  for(const [id,label] of [['penetration-recalculate','Recalculate'],['penetration-settings','Settings'],['penetration-schedule-recalculate','Recalculate Schedule'],['penetration-estimator-schedule-recalculate','Recalculate Schedule']])assert.match(markup,new RegExp(`id="${id}"[^>]*icon-only[^>]*aria-label="${label}"[^>]*title="${label}"`));
  assert.match(markup,/id="penetration-add-to-library"[^>]*icon-only[^>]*aria-label="Add to Library"[^>]*title="Add to Library"[\s\S]*?book-symbol/);
  assert.match(markup,/id="discard-pricing"[\s\S]*?pricing-action-symbol[\s\S]*?<circle cx="12" cy="12" r="9">/);
  assert.match(markup,/id="reset-pricing"[\s\S]*?pricing-reset-symbol[\s\S]*?<path d="M20 7v5h-5">/);
  assert.match(actionCss,/\.pricing-discard-button\{[^}]*background:var\(--navy\)[^}]*color:#fff|\.pricing-discard-button\{[^}]*color:#fff[^}]*background:var\(--navy\)/);
  assert.match(actionCss,/\.pricing-reset-button\{[^}]*color:#fff[^}]*background:var\(--red\)/);
  assert.match(actionCss,/\.project-tools \.actions \.button\{[^}]*height:48px[^}]*min-height:48px/);
  assert.match(markup,/id="project-list-card"/);assert.match(markup,/id="project-browser"[^>]*hidden/);
  assert.ok(actionCss.includes('.pricing-table-actions{'));assert.ok(actionCss.includes('.pricing-add-item-action{'));assert.ok(actionCss.includes('.schedule-download-button{'));
  assert.doesNotMatch(markup,/Estimating workflow|id="workflow"|Choose a workflow|Dimensions and takeoff notes/);
  assert.doesNotMatch(source,/\$\("workflow"\)|Choose a workflow/);
  assert.match(markup,/<span>NOTES <span class="optional">Optional<\/span><\/span><textarea id="measurements"/);
  assert.match(markup,/id="quote-title"[^>]*readonly/);assert.doesNotMatch(markup,/work-summary|Generated work summary|Updating work summary/);assert.doesNotMatch(source,/\$\("work-summary"\)/);passed++;
  assert.ok(markup.indexOf('id="breakdown-heading"')<markup.indexOf('id="labour-breakdown"'));assert.doesNotMatch(markup,/id="notes-heading"|id="calculated-notes"|Quote notes and material requirements/);
  assert.match(markup,/<th scope="col" class="numeric">Days<\/th>/);assert.match(markup,/Pinning is included in meshing days/);

  // Every material's own team gates entry; pins/clips stay independent.
  const teamMap={B15:'D2',B16:'D3',B18:'D6',B19:'D8',B20:'D4',B21:'D5',B22:'D9',B23:'D10'};
  for(const [cell,team] of Object.entries(teamMap)){
    setup();audit.state.inputs={...Object.fromEntries(Object.values(teamMap).map(key=>[key,'1 Team - 1x'])),[cell]:0,[team]:'N/A'};
    const coverage=audit.makeControl({cell,label:'Coverage required',type:'number'},true),selector=audit.makeControl({cell:team,label:'Labour',type:'select',options:['N/A','1 Team - 1x']},true);
    for(const rejected of ['2','-2','2.5']){coverage.value=rejected;await coverage.emit('input');assert.equal(audit.state.inputs[cell],0);assert.equal(coverage.value,'0');assert.equal(byId('app-message').textContent,'Select Teams');}
    selector.value='1 Team - 1x';await selector.emit('input');coverage.value='3';await coverage.emit('input');assert.equal(audit.state.inputs[cell],3);assert.equal(audit.state.inputErrors.size,0);
    selector.value='N/A';await selector.emit('input');assert.equal(audit.state.inputs[cell],3);assert.equal(audit.state.inputErrors.get(cell),'Select Teams');assert.equal(byId('app-message').textContent,'Select Teams');
    let requests=0;audit.setRequest(async()=>{requests++;});await audit.calculate();await audit.saveQuote();assert.equal(requests,0);assert.equal(byId('calculation-errors').textContent,'Select Teams');assert.equal(byId('sum-total').textContent,'—');
    selector.value='1 Team - 1x';await selector.emit('input');assert.equal(audit.state.inputs[cell],3);assert.equal(audit.state.inputErrors.has(cell),false);
    selector.value='N/A';await selector.emit('input');coverage.value='0';await coverage.emit('input');assert.equal(audit.state.inputs[cell],0);assert.equal(audit.state.inputErrors.size,0);
  }passed++;
  setup();audit.state.inputs={B17:0,...Object.fromEntries(Object.values(teamMap).map(key=>[key,'N/A']))};const pins=audit.makeControl({cell:'B17',label:'Pins / clips coverage',type:'number'},true);pins.value='12';await pins.emit('input');assert.equal(audit.state.inputs.B17,12);assert.equal(audit.state.inputErrors.size,0);passed++;
  // Loaded forbidden coverage is retained for correction; direct recalculation cannot display stale totals.
  setup();audit.state.fields=copy(numericFields);audit.state.inputs=Object.fromEntries(numericFields.map(field=>[field.cell,field.default]));audit.state.inputs.B22=14.123456789;audit.state.inputs.D9='n/a';audit.renderInputs();assert.equal(audit.state.inputs.B22,14.123456789);assert.equal(audit.state.inputErrors.get('B22'),'Select Teams');
  let blockedCalls=0;audit.setRequest(async()=>{blockedCalls++;});await audit.calculate();assert.equal(blockedCalls,0);assert.equal(byId('calculation-errors').textContent,'Select Teams');passed++;
  // Selecting a team never removes an unrelated malformed number or its exact raw text.
  setup();audit.state.inputs={B15:5,D2:'N/A',B28:0};audit.state.inputErrors.set('B28','Invalid money');audit.state.inputDrafts.set('B28','$bad');const fixTeam=audit.makeControl({cell:'D2',label:'Team',type:'select',options:['N/A','1 Team - 1x']},true);fixTeam.value='1 Team - 1x';await fixTeam.emit('input');assert.equal(audit.state.inputErrors.get('B28'),'Invalid money');assert.equal(audit.state.inputDrafts.get('B28'),'$bad');assert.equal(audit.state.inputs.B15,5);passed++;
  console.log(`${passed} UI metadata, precision, summary and race checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
