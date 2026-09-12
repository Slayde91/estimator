const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const elements = new Map();
function element(tag='div') {
  return {
    tagName: tag, value: '', textContent: '', dataset: {}, children: [], disabled: false,
    listeners: {}, parts: new Map(), options: [{value:'workflow'}], files: [],
    classList: {add(){},toggle(){}}, setAttribute(){},removeAttribute(){},focus(){},
    addEventListener(event, fn, options={}) { (this.listeners[event] ||= []).push({fn,once:options.once}); },
    emit(event) { const callbacks = [...(this.listeners[event] || [])]; this.listeners[event] = (this.listeners[event]||[]).filter(x=>!x.once); return Promise.all(callbacks.map(x=>x.fn())); },
    append(...children){this.children.push(...children);this.options=this.children;},
    replaceChildren(...children){this.children=children;this.options=children;},
    querySelector(selector){if(!this.parts.has(selector))this.parts.set(selector,element());return this.parts.get(selector);},
    showModal(){assert.ok(!this.open);this.open=true;},
    close(value){this.returnValue=value;this.open=false;return this.emit('close');},
    click(){this.clicked=true;}, remove(){},
  };
}
function byId(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}
const context = {
  document:{getElementById:byId,querySelectorAll:()=>[],createElement:element,createTextNode:text=>text,body:element()},
  window:{addEventListener(){},print(){}}, Intl, Number, JSON, Object, Set, Array, String, Promise, Error,
  setTimeout:()=>0,clearTimeout(){},AbortController, console,
  FileReader:class { readAsDataURL(){this.result='data:application/octet-stream;base64,AAAA';queueMicrotask(()=>this.onload());} },
};
vm.createContext(context);
let source=fs.readFileSync('static/app.js','utf8');
source=source.replace(/  bootstrap\(\);\s*\}\)\(\);\s*$/, `
  globalThis.audit={state,savePricing,openQuote,newQuote,confirmReplace,importPricing,exportPricing,makeControl,
    setRequest(fn){request=fn;}, setFetch(fn){globalThis.fetch=fn;}};
  renderInputs=()=>{}; renderPricing=()=>{state.pricingDirty=JSON.stringify(state.draft)!==JSON.stringify(state.configuration);};
  scheduleCalculation=()=>{};
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
  Object.assign(audit.state,{configuration:copy(oldConfig),draft:copy(newConfig),fields:copy(oldFields),currentFields:copy(oldFields),baseline:{inventory:[],rate_groups:{}},quote:null,quoteConfiguration:null,inputs:{D15:'Old spray'},dirty:false,quoteLoadRevision:0});
  byId('workflow').options=[{value:'workflow'}]; byId('workflow').value='workflow';
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
  const historical=audit.makeControl(audit.state.fields[0],true);
  assert.equal(historical.value,'Old spray');
  assert.ok(historical.options.some(x=>x.value==='Old spray'));
  await audit.newQuote();
  assert.equal(audit.state.quoteConfiguration,null);
  assert.equal(audit.state.fields[0].options[0],'New spray');
  assert.equal(audit.state.inputs.D15,'New spray'); passed++;

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

  console.log(`${passed} UI race/isolation checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
