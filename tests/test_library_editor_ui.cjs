// Synthetic values only. The private workbook and report contents stay outside tests.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {copy,definition,result,allowanceDefinition,allowanceResult,harness:projectHarness}=require('./helpers/penetration_ui.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const walk=node=>[node,...node.children.flatMap(walk)],text=node=>walk(node).map(el=>el.textContent).join(' ');
const fixture=(draft=definition().defaults,extra={})=>({id:'legacy-row-4',library_id:'FL-ID-001',title:'FL-ID-001 — Synthetic item',revision:0,
  source_price:{amount:123.456789,currency:'AUD',label:'Workbook price'},price:{amount:123.456789,currency:'AUD',label:'Library price'},
  draft:copy(draft),definition:definition(),result:result(draft),pricing_token:'workbook-token',pricing_basis:'workbook',pricing_label:'Original workbook rates',...extra});
function harness(){
  const h=projectHarness(),calls=[],returns=[];let shows=0,invalidations=0;
  h.context.window.CeasefireLibraryEditorNavigation={show(){shows++;},returnToLibrary(id){returns.push(id);}};
  h.context.window.CeasefireLibraries={invalidate(){invalidations++;}};
  vm.runInContext(fs.readFileSync('static/library-editor.js','utf8').replace(/\}\)\(\);\s*$/,`globalThis.libraryAudit={state,calculate,refreshPricing,save,cancel,makeControl,renderFields,present,setRequest(fn){request=fn;}};})();`),h.context);
  const audit=h.context.libraryAudit,api=h.context.window.CeasefireLibraryEditor;
  audit.setRequest(async(id,action,payload)=>{calls.push({id,action,payload:payload&&copy(payload)});return fixture(payload?.draft,{revision:action==='save'?payload.revision+1:payload?.revision||0,pricing_token:payload?.pricing_token||'workbook-token'});});
  const control=(column,global=false)=>walk(h.byId('library-editor-fields')).find(el=>el.dataset.libraryEditorField===column&&el.dataset.libraryEditorGlobal===String(global));
  return{...h,projectApi:h.api,api,audit,calls,returns,control,shows:()=>shows,invalidations:()=>invalidations};
}
let passed=0;
async function check(name,fn){const h=harness();h.projectApi.applyProject(await h.projectApi.prepareDefaults());await fn(h);passed++;console.log('ok - '+name);}
(async()=>{
  await check('Library editor shows only the pipe category and Bulkhead relevant to the item',async h=>{
    const metadata=definition();metadata.groups=['Penetration','Unlagged Pipes','Plastic Pipes','Cables/Bundles','Bulkhead'];metadata.group_visibility={
      'Unlagged Pipes':{column:'K',values:['Unlagged Pipes']},'Plastic Pipes':{column:'K',values:['Plastic Pipes']},
      'Cables/Bundles':{column:'K',values:['Cable Bundles']},Bulkhead:{column:'J',values:['Bulkheads']}};
    for(const group of metadata.groups.slice(1))metadata.row_fields.push({column:`field-${group}`,label:group,group,type:'number',format:'number',units:'',options:[],default:null});
    metadata.row_fields.push({column:'AL',label:'Diameter',group:'Pipes',display_groups:['Unlagged Pipes','Plastic Pipes','Cables/Bundles'],type:'number',format:'number',units:'mm',options:[],default:null});
    const draft=copy(metadata.defaults);draft.rows[0].inputs={J:'Bulkheads',K:'Cable Bundles'};h.api.present(fixture(draft,{definition:metadata,result:result(draft,metadata)}));
    assert.match(text(h.byId('library-editor-groups')),/Penetration.*Cables\/Bundles.*Bulkhead/);assert.doesNotMatch(text(h.byId('library-editor-groups')),/Unlagged Pipes|Plastic Pipes/);
    h.audit.state.group='Cables/Bundles';h.audit.renderFields();assert.match(text(h.byId('library-editor-fields')),/Diameter/);
  });
  await check('Library automatic allowances remain raw and clean until manual input, retaining precise and zero overrides and reset',async h=>{
    const metadata=allowanceDefinition(),source=fixture(undefined,{definition:metadata,result:allowanceResult(definition().defaults,metadata)});h.api.present(source);h.audit.state.group='Products and labour';h.audit.renderFields();let control=h.control('register_allowance_hours');const before=copy(h.audit.state.draft);
    assert.equal(control.value,'0.25');assert.equal(h.api.hasUnsavedChanges(),false);await control.focus();await control.blur();assert.deepEqual(copy(h.audit.state.draft),before);
    h.audit.setRequest(async(id,action,payload)=>fixture(payload.draft,{definition:metadata,result:allowanceResult(payload.draft,metadata)}));
    for(const value of [0,.123456789012345]){control=h.control('register_allowance_hours');await control.focus();control.value=String(value);await control.emit('input');await control.blur();await h.audit.calculate();control=h.control('register_allowance_hours');assert.equal(h.audit.state.draft.rows[0].inputs.register_allowance_hours,value);await control.focus();assert.equal(control.value,String(value));await control.blur();}
    control=h.control('register_allowance_hours');control.value='-1';await control.emit('input');assert.match(h.api.inputProblem(),/invalid/);assert.equal(h.audit.state.draft.rows[0].inputs.register_allowance_hours,.123456789012345);await control.parentNode.children[3].children[1].emit('click');await h.audit.calculate();assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.register_allowance_hours,null);assert.equal(h.control('register_allowance_hours').value,'0.25');
  });
  await check('Library automatic defaults update from backend only, preserve focused input, and missing defaults never become guessed values',async h=>{
    const metadata=allowanceDefinition(),source=fixture(undefined,{definition:metadata,result:allowanceResult(definition().defaults,metadata)});h.api.present(source);h.audit.state.group='Pipes';h.audit.renderFields();const pipe=h.control('pipe_labour_hours');await pipe.focus();
    h.audit.setRequest(async(id,action,payload)=>fixture(payload.draft,{definition:metadata,result:allowanceResult(payload.draft,metadata,{pipe_labour_hours:.7123456789,register_allowance_hours:.25})}));await h.audit.calculate();assert.equal(pipe.value,'0.3');assert.match(text(pipe.parentNode),/Automatic: 0\.71 hrs/);await pipe.blur();assert.equal(h.control('pipe_labour_hours').value,'0.71');assert.equal(h.api.hasUnsavedChanges(),false);
    const diameter=h.control('AL');await diameter.focus();diameter.value='200';await diameter.emit('input');assert.equal(h.control('pipe_labour_hours').value,'');await h.audit.calculate();assert.equal(h.control('pipe_labour_hours').value,'0.71');assert.equal(diameter.value,'200');await diameter.blur();const large=h.control('AL');large.value='500';await large.emit('input');assert.equal(h.control('pipe_labour_hours').value,'');
    h.audit.setRequest(async(id,action,payload)=>fixture(payload.draft,{definition:metadata,result:allowanceResult(payload.draft,metadata,{pipe_labour_hours:null,register_allowance_hours:.25})}));await h.audit.calculate();assert.equal(h.control('pipe_labour_hours').value,'');assert.match(text(h.control('pipe_labour_hours').parentNode),/No automatic value/);assert.equal(h.audit.state.draft.rows[0].inputs.pipe_labour_hours,undefined);
  });
  await check('Library named allowances are captured by Save and reopen while later edits survive an in-flight receipt',async h=>{
    const metadata=allowanceDefinition(),draft=copy(definition().defaults);draft.rows[0].inputs={T:'Library fixture',O:1,register_allowance_hours:0,pipe_labour_hours:.3456789012345};h.api.present(fixture(draft,{definition:metadata,result:allowanceResult(draft,metadata)}));h.audit.state.group='Pipes';h.audit.renderFields();
    const pending=deferred();let capture;h.audit.setRequest(async(id,action,payload)=>{capture=copy(payload);return pending.promise;});const saving=h.audit.save();await flush();const pipe=h.control('pipe_labour_hours');pipe.value='.4567890123456';await pipe.emit('input');pending.resolve(fixture(capture.draft,{definition:metadata,revision:1,result:allowanceResult(capture.draft,metadata)}));await saving;
    assert.equal(capture.draft.rows[0].inputs.register_allowance_hours,0);assert.equal(capture.draft.rows[0].inputs.pipe_labour_hours,.3456789012345);assert.equal(h.audit.state.draft.rows[0].inputs.pipe_labour_hours,.4567890123456);assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.api.isOpen(),true);
    let saved;h.audit.setRequest(async(id,action,payload)=>saved=fixture(payload.draft,{definition:metadata,revision:2,result:allowanceResult(payload.draft,metadata)}));await h.audit.save();h.api.present(saved);assert.equal(h.audit.state.draft.rows[0].inputs.pipe_labour_hours,.4567890123456);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Library price uses the item total independently of the server summary total',async h=>{
    const item=fixture();item.result.summary.grand_total=523.456789;
    h.api.present(item);assert.match(text(h.byId('library-editor-price')),/123\.46/);assert.doesNotMatch(text(h.byId('library-editor-price')),/523\.46/);assert.match(text(h.byId('library-editor-summary')),/523\.46/);
  });
  await check('Unavailable current library prices never fall back to historical workbook charges and zero remains a valid current price',async h=>{
    for(const value of [null,undefined,'#VALUE!',0]){
      const item=fixture();item.price.amount=987.65;item.source_price.amount=654.32;item.result.rows[0].outputs.H=value;const original=copy(item);
      h.api.present(item);assert.equal(h.byId('library-editor-price').textContent,value===0?'$0.00':value==='#VALUE!'?'#VALUE!':'—');assert.deepEqual(copy(item),original);
    }
    const unavailable=fixture(undefined,{result:null,price:{amount:null},source_price:{amount:654.32}});h.api.present(unavailable);assert.equal(h.byId('library-editor-price').textContent,'—');
    const current=fixture(undefined,{result:null,price:{amount:321.09},source_price:{amount:654.32}});h.api.present(current);assert.equal(h.byId('library-editor-price').textContent,'$321.09');
  });
  await check('Raw library globals remain portable but uneditable and the breakdown uses the source projection',async h=>{
    const item=fixture();item.draft.globals={J:'Yes',K:3.14159265358979,L:.123456789012345,M:27.123456789};h.api.present(item);const original=copy(item.draft.globals);
    for(const group of item.definition.groups){h.audit.state.group=group;h.audit.renderFields();assert.ok(walk(h.byId('library-editor-fields')).filter(node=>node.dataset.libraryEditorField).every(control=>control.dataset.libraryEditorGlobal==='false'));assert.equal(h.control('L',true),undefined);}
    const nodes=walk(h.byId('library-editor-breakdown')),table=nodes.find(node=>node.tagName==='table');assert.ok(table);
    assert.match(text(table),/Unit Prices.*Material Quantities.*Material Costs.*Labour Costs.*Task Hours/);
    assert.match(text(table),/Pipes.*0.*#VALUE!/);assert.match(text(table),/Subtotal.*65\.43.*58\.02.*#VALUE!/);
    assert.doesNotMatch(text(h.byId('library-editor-summary')),/Labour hours/);
    h.audit.state.group='Penetration';h.audit.renderFields();h.control('T').value='Edited row only';await h.control('T').emit('input');await h.audit.calculate();assert.deepEqual(h.calls.at(-1).payload.draft.globals,original);await h.audit.save();const saved=copy(h.calls.at(-1).payload.draft);assert.deepEqual(saved.globals,original);h.api.present(fixture(saved));assert.deepEqual(copy(h.audit.state.draft.globals),original);
    const html=fs.readFileSync('static/index.html','utf8');for(const id of ['library-editor-project-allowances','library-editor-globals'])assert.ok(!html.includes(`id="${id}"`),`${id} must not remain in HTML`);
  });
  await check('Opening the library item leaves the full project state and raw invalid inputs intact',async h=>{
    const project=h.context.penAudit;project.state.draft.rows[0].inputs.T='Unsaved project';project.makeControl(definition().row_fields.find(f=>f.column==='O'),'line-1');
    const projectQuantity=h.byId('penetration-row-fields').querySelectorAll('[data-penetration-field]').find(el=>el.dataset.penetrationField==='O');projectQuantity.value='1e-';await projectQuantity.emit('input');
    const fingerprint=h.projectApi.projectFingerprint();await h.api.open('legacy-row-4');assert.equal(h.projectApi.projectFingerprint(),fingerprint);assert.equal(projectQuantity.value,'1e-');assert.equal(h.projectApi.hasUnsavedChanges(),true);
    assert.equal(h.api.hasUnsavedChanges(),false);assert.match(text(h.byId('library-editor-price')),/123\.46/);assert.equal(h.byId('firestopping-project-workspace').hidden,true);assert.equal(h.shows(),1);
  });
  await check('Precise numeric and percentage inputs stay exact; invalid text survives input groups',async h=>{
    await h.api.open('legacy-row-4');let input=h.control('O');input.value='12.3456789012345';await input.emit('input');await input.blur();assert.equal(input.value,'12.35');await input.focus();assert.equal(input.value,'12.3456789012345');assert.equal(input.selectionEnd,input.value.length);
    h.audit.state.group='Additional Allowances';h.audit.renderFields();const percent=h.control('AG');percent.value='12.3456789012345';await percent.emit('input');await percent.blur();assert.equal(percent.value,'12.35');await percent.focus();assert.equal(percent.value,'12.3456789012345');assert.equal(h.audit.state.draft.rows[0].inputs.AG,0.123456789012345);
    h.audit.state.group='Penetration';h.audit.renderFields();input=h.control('O');input.value='1e-';await input.emit('input');h.audit.state.group='Additional Allowances';h.audit.renderFields();assert.equal(h.control('AG').value,'12.35');h.audit.state.group='Penetration';h.audit.renderFields();assert.equal(h.control('O').value,'1e-');assert.equal(h.audit.state.draft.rows[0].inputs.O,12.3456789012345);assert.equal(h.byId('library-editor-save').disabled,true);assert.equal(h.audit.state.result,null);
  });
  await check('Calculation sends only the one-row draft, item revision and opaque pricing token',async h=>{
    await h.api.open('legacy-row-4');assert.equal(h.control('T').getAttribute('aria-label'),'Library item: Items/Services');assert.equal(h.control('U').getAttribute('aria-label'),'Library item: System/Install Details');h.control('T').value='Exact service description';await h.control('T').emit('input');h.control('U').value='Exact installation description';await h.control('U').emit('input');h.control('O').value='1.23456789012345';await h.control('O').emit('input');await h.audit.calculate();
    const call=h.calls.at(-1);assert.equal(call.action,'calculate');assert.deepEqual(Object.keys(call.payload).sort(),['draft','pricing_token','revision']);assert.equal(call.payload.pricing_token,'workbook-token');assert.equal(call.payload.draft.rows[0].inputs.O,1.23456789012345);assert.equal(call.payload.draft.rows.length,1);
    assert.equal(call.payload.draft.rows[0].inputs.T,'Exact service description');assert.equal(call.payload.draft.rows[0].inputs.U,'Exact installation description');assert.equal(h.audit.state.definition.row_fields.find(field=>field.column==='T').label,'Item(s)');assert.equal(h.audit.state.definition.row_fields.find(field=>field.column==='U').label,'System');
  });
  await check('A late calculation cannot overwrite later library inputs',async h=>{
    await h.api.open('legacy-row-4');const pending=deferred(),captured=copy(h.audit.state.draft);h.audit.setRequest(()=>pending.promise);const work=h.audit.calculate();await flush();h.control('O').value='88.123456789';await h.control('O').emit('input');pending.resolve(fixture(captured));await work;
    assert.equal(h.audit.state.draft.rows[0].inputs.O,88.123456789);assert.equal(h.audit.state.result,null);assert.equal(h.audit.state.busy,false);
  });
  await check('Refreshing saved shared pricing stays unsaved and all subsequent requests retain its token',async h=>{
    await h.api.open('legacy-row-4');h.audit.setRequest(async(id,action,payload)=>{h.calls.push({id,action,payload:copy(payload)});return fixture(payload.draft,{revision:payload.revision,pricing_token:action==='refresh-pricing'?'shared-token':payload.pricing_token,pricing_basis:'shared',pricing_label:'Saved Pricing Library rates'});});
    await h.audit.refreshPricing();assert.equal(h.audit.state.record.pricing_token,'shared-token');assert.equal(h.api.hasUnsavedChanges(),true);assert.match(h.byId('library-editor-message').textContent,/Save Library Item/);
    await h.audit.calculate();assert.equal(h.calls.at(-1).payload.pricing_token,'shared-token');assert.equal(h.api.hasUnsavedChanges(),true);await h.audit.save();assert.equal(h.calls.at(-1).payload.pricing_token,'shared-token');assert.equal(h.returns.at(-1),'legacy-row-4');
  });
  await check('Pricing refresh preserves edits made while waiting and recalculates using the new token',async h=>{
    await h.api.open('legacy-row-4');const pending=deferred(),before=copy(h.audit.state.draft);h.audit.setRequest(()=>pending.promise);const work=h.audit.refreshPricing();await flush();h.control('O').value='7.7654321';await h.control('O').emit('input');pending.resolve(fixture(before,{pricing_token:'new-shared',pricing_basis:'shared'}));await work;
    assert.equal(h.audit.state.draft.rows[0].inputs.O,7.7654321);assert.equal(h.audit.state.record.pricing_token,'new-shared');assert.equal(h.audit.state.result,null);assert.equal(h.api.hasUnsavedChanges(),true);
    h.audit.setRequest(async(id,action,payload)=>{assert.equal(payload.pricing_token,'new-shared');assert.equal(payload.draft.rows[0].inputs.O,7.7654321);return fixture(payload.draft,{pricing_token:payload.pricing_token});});await h.audit.calculate();assert.equal(h.audit.state.result.rows[0].inputs.O,7.7654321);
  });
  await check('Successful save invalidates reference caches and returns to the original library record only',async h=>{
    const project=h.projectApi.projectFingerprint();await h.api.open('legacy-row-4');h.control('T').value='Library-only description';await h.control('T').emit('input');await h.audit.save();
    assert.equal(h.invalidations(),1);assert.deepEqual(h.returns,['legacy-row-4']);assert.equal(h.api.isOpen(),false);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.projectApi.projectFingerprint(),project);assert.equal(h.byId('firestopping-project-workspace').hidden,false);
  });
  await check('Save receipts retain later edits, update the item revision and do not navigate away',async h=>{
    await h.api.open('legacy-row-4');h.control('T').value='Captured';await h.control('T').emit('input');const pending=deferred(),captured=copy(h.audit.state.draft);h.audit.setRequest(()=>pending.promise);const work=h.audit.save();await flush();h.control('T').value='Later unsaved';await h.control('T').emit('input');pending.resolve(fixture(captured,{revision:1}));await work;
    assert.equal(h.api.isOpen(),true);assert.equal(h.audit.state.draft.rows[0].inputs.T,'Later unsaved');assert.equal(h.audit.state.record.revision,1);assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.returns.length,0);assert.match(h.byId('library-editor-message').textContent,/later edits/);
    h.audit.setRequest(async(id,action,payload)=>{assert.equal(payload.revision,1);assert.equal(payload.draft.rows[0].inputs.T,'Later unsaved');return fixture(payload.draft,{revision:2});});await h.audit.save();assert.equal(h.api.isOpen(),false);
  });
  await check('A stale item conflict leaves the complete local draft and pricing token visible',async h=>{
    await h.api.open('legacy-row-4');h.control('O').value='3.141592653589';await h.control('O').emit('input');const before=copy(h.audit.state.draft);h.audit.setRequest(async()=>{throw new Error('The item changed. Reopen it before saving.');});await h.audit.save();
    assert.deepEqual(copy(h.audit.state.draft),before);assert.equal(h.audit.state.record.pricing_token,'workbook-token');assert.equal(h.api.isOpen(),true);assert.equal(h.returns.length,0);assert.match(h.byId('library-editor-message').textContent,/not saved.*item changed/);assert.equal(h.byId('library-editor-save').disabled,false);
  });
  await check('Cancel discards only the library session and detached controls cannot alter a later item',async h=>{
    await h.api.open('legacy-row-4');const project=h.projectApi.projectFingerprint(),old=h.control('T');old.value='Discarded library edit';await old.emit('input');h.audit.cancel();assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.projectApi.projectFingerprint(),project);
    h.api.present(fixture(undefined,{id:'second',library_id:'FL-ID-002'}));old.value='Late detached event';await old.emit('input');assert.equal(h.audit.state.draft.rows[0].inputs.T,undefined);assert.equal(h.audit.state.record.id,'second');
  });
  await check('Opening another record cannot silently replace an unfinished library editor',async h=>{
    await h.api.open('legacy-row-4');h.control('T').value='Keep this';await h.control('T').emit('input');const calls=h.calls.length;await h.api.open('second');assert.equal(h.calls.length,calls);assert.equal(h.audit.state.record.id,'legacy-row-4');assert.equal(h.audit.state.draft.rows[0].inputs.T,'Keep this');assert.match(h.byId('library-editor-message').textContent,/Finish editing/);
  });
  await check('Old session responses cannot reopen or mutate a cancelled editor',async h=>{
    await h.api.open('legacy-row-4');const pending=deferred(),captured=copy(h.audit.state.draft);h.audit.setRequest(()=>pending.promise);const work=h.audit.calculate();await flush();h.api.close();h.api.present(fixture(undefined,{id:'second'}));pending.resolve(fixture(captured));await work;assert.equal(h.audit.state.record.id,'second');assert.equal(h.audit.state.version,0);
  });
  await check('Formula errors remain readable and unknown historical choices are retained for correction',async h=>{
    const source=fixture();source.draft.rows[0].inputs.J='Legacy service';source.result.errors=[{row_id:null,cell:'H2',message:'#VALUE!'}];source.result.summary.grand_total='#VALUE!';h.api.present(source);
    assert.equal(h.control('J').value,'Legacy service');assert.equal(h.control('J').children.at(-1).disabled,true);assert.match(h.byId('library-editor-price').textContent,/123\.46/);assert.match(text(h.byId('library-editor-summary')),/#VALUE!/);assert.match(h.byId('library-editor-summary-notes').textContent,/H2: #VALUE!/);source.result.rows[0].outputs.H='#VALUE!';h.api.present(source);assert.match(h.byId('library-editor-price').textContent,/#VALUE!/);
    h.control('J').value='Invented';await h.control('J').emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.J,'Legacy service');assert.equal(h.byId('library-editor-save').disabled,true);
  });
  await check('Numeric range errors preserve prior values and block save without requests',async h=>{
    await h.api.open('legacy-row-4');h.control('O').value='1000000000001';await h.control('O').emit('input');const calls=h.calls.length;await h.audit.save();assert.equal(h.calls.length,calls);assert.equal(h.audit.state.draft.rows[0].inputs.O,undefined);assert.match(h.api.inputProblem(),/invalid/);
  });
  await check('Known manufacturer casing displays clear names and preserves original raw values through calculation and unrelated edits',async h=>{
    for(const [raw,label] of [['FIREFLY','Firefly'],['tRaFaLgAr','Trafalgar']]){
      const item=fixture();item.definition.row_fields.push({column:'V',label:'Manufacturer',type:'select',group:'Penetration',format:'text',options:['Firefly','Trafalgar'],default:null});item.draft.rows[0].inputs.V=raw;h.api.present(item);
      const control=h.control('V'),selected=control.children.find(option=>option.value===raw);assert.equal(control.value,raw);assert.equal(selected.textContent,label);assert.notEqual(selected.disabled,true);assert.equal(control.children.filter(option=>option.textContent===label).length,1);assert.doesNotMatch(text(control),/Saved value/);assert.equal(h.api.hasUnsavedChanges(),false);
      h.control('T').value='Unrelated edit';await h.control('T').emit('input');assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);await control.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);assert.equal(h.api.inputProblem(),'');
      let payload;h.audit.setRequest(async(id,action,captured)=>{payload=copy(captured);return fixture(captured.draft,{definition:item.definition});});await h.audit.calculate();assert.equal(payload.draft.rows[0].inputs.V,raw);
    }
  });
  await check('Manufacturer options retain their values and unknown manufacturers or other fields keep strict saved-value handling',async h=>{
    const item=fixture();item.definition.row_fields.push({column:'V',label:'Manufacturer',type:'select',group:'Penetration',format:'text',options:['FIREFLY','TRAFALGAR'],default:null});item.draft.rows[0].inputs.V='Unknown supplier';item.draft.rows[0].inputs.J='FIREFLY';h.api.present(item);
    const control=h.control('V');assert.deepEqual(control.children.slice(1,3).map(option=>[option.textContent,option.value]),[['Firefly','FIREFLY'],['Trafalgar','TRAFALGAR']]);assert.match(control.children.at(-1).textContent,/Saved value: Unknown supplier/);assert.equal(control.children.at(-1).disabled,true);assert.match(h.control('J').children.at(-1).textContent,/Saved value: FIREFLY/);
    control.value='Invented';await control.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.V,'Unknown supplier');assert.match(h.api.inputProblem(),/invalid/);control.value='TRAFALGAR';await control.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.V,'TRAFALGAR');assert.equal(h.api.inputProblem(),'');
  });
  await check('Prototype-key and ordinary unknown manufacturers retain literal disabled saved labels and raw values',async h=>{
    for(const raw of ['constructor','toString','__proto__','Unlisted supplier']){
      const item=fixture();item.definition.row_fields.push({column:'V',label:'Manufacturer',type:'select',group:'Penetration',format:'text',options:['Firefly','Trafalgar'],default:null});item.draft.rows[0].inputs.V=raw;h.api.present(item);const control=h.control('V'),saved=control.children.find(option=>option.value===raw);
      assert.equal(control.value,raw);assert.equal(saved.textContent,`Saved value: ${raw} (choose a listed value)`);assert.equal(saved.disabled,true);assert.equal(h.api.hasUnsavedChanges(),false);assert.deepEqual(copy(h.audit.state.draft),item.draft);assert.deepEqual(copy(h.audit.state.definition.row_fields.at(-1).options),['Firefly','Trafalgar']);
      h.control('T').value='Unrelated edit';await h.control('T').emit('input');let captured;h.audit.setRequest(async(id,action,payload)=>{captured=copy(payload);return fixture(payload.draft,{definition:item.definition});});await h.audit.calculate();assert.equal(captured.draft.rows[0].inputs.V,raw);assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);
      const current=h.control('V');current.value=raw;await current.emit('change');assert.match(h.api.inputProblem(),/invalid/);assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);current.value='Trafalgar';await current.emit('change');assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.V,'Trafalgar');
    }
  });
  console.log(`${passed} library editor UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
