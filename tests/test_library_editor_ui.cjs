// Synthetic values only. The private workbook and report contents stay outside tests.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {copy,definition,result,harness:projectHarness}=require('./helpers/penetration_ui.cjs');
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
  const control=(column,global=false)=>walk(h.byId(global?'library-editor-globals':'library-editor-fields')).find(el=>el.dataset.libraryEditorField===column&&el.dataset.libraryEditorGlobal===String(global));
  return{...h,projectApi:h.api,api,audit,calls,returns,control,shows:()=>shows,invalidations:()=>invalidations};
}
let passed=0;
async function check(name,fn){const h=harness();h.projectApi.applyProject(await h.projectApi.prepareDefaults());await fn(h);passed++;console.log('ok - '+name);}
(async()=>{
  await check('Opening the library item leaves the full project state and raw invalid inputs intact',async h=>{
    const project=h.context.penAudit;project.state.draft.rows[0].inputs.T='Unsaved project';project.makeControl(definition().row_fields.find(f=>f.column==='O'),'line-1');
    const projectQuantity=h.byId('penetration-row-fields').querySelectorAll('[data-penetration-field]').find(el=>el.dataset.penetrationField==='O');projectQuantity.value='1e-';await projectQuantity.emit('input');
    const fingerprint=h.projectApi.projectFingerprint();await h.api.open('legacy-row-4');assert.equal(h.projectApi.projectFingerprint(),fingerprint);assert.equal(projectQuantity.value,'1e-');assert.equal(h.projectApi.hasUnsavedChanges(),true);
    assert.equal(h.api.hasUnsavedChanges(),false);assert.match(text(h.byId('library-editor-price')),/123\.46/);assert.equal(h.byId('firestopping-project-workspace').hidden,true);assert.equal(h.shows(),1);
  });
  await check('Precise numeric and percentage inputs stay exact; invalid text survives input groups',async h=>{
    await h.api.open('legacy-row-4');let input=h.control('O');input.value='12.3456789012345';await input.emit('input');await input.blur();assert.equal(input.value,'12.35');await input.focus();assert.equal(input.value,'12.3456789012345');assert.equal(input.selectionEnd,input.value.length);
    const percent=h.control('L',true);percent.value='12.3456789012345';await percent.emit('input');assert.equal(h.audit.state.draft.globals.L,0.123456789012345);
    input.value='1e-';await input.emit('input');h.audit.state.group='Products and labour';h.audit.renderFields();h.audit.state.group='Penetration';h.audit.renderFields();assert.equal(h.control('O').value,'1e-');assert.equal(h.audit.state.draft.rows[0].inputs.O,12.3456789012345);assert.equal(h.byId('library-editor-save').disabled,true);assert.equal(h.audit.state.result,null);
  });
  await check('Calculation sends only the one-row draft, item revision and opaque pricing token',async h=>{
    await h.api.open('legacy-row-4');assert.equal(h.control('T').getAttribute('aria-label'),'Library item: Items/Services');assert.equal(h.control('U').getAttribute('aria-label'),'Library item: System/Install');h.control('T').value='Exact service description';await h.control('T').emit('input');h.control('U').value='Exact installation description';await h.control('U').emit('input');h.control('O').value='1.23456789012345';await h.control('O').emit('input');await h.audit.calculate();
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
    assert.equal(h.control('J').value,'Legacy service');assert.equal(h.control('J').children.at(-1).disabled,true);assert.match(h.byId('library-editor-price').textContent,/#VALUE!/);assert.match(h.byId('library-editor-summary-notes').textContent,/H2: #VALUE!/);
    h.control('J').value='Invented';await h.control('J').emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.J,'Legacy service');assert.equal(h.byId('library-editor-save').disabled,true);
  });
  await check('Numeric range errors preserve prior values and block save without requests',async h=>{
    await h.api.open('legacy-row-4');h.control('O').value='1000000000001';await h.control('O').emit('input');const calls=h.calls.length;await h.audit.save();assert.equal(h.calls.length,calls);assert.equal(h.audit.state.draft.rows[0].inputs.O,undefined);assert.match(h.api.inputProblem(),/invalid/);
  });
  console.log(`${passed} library editor UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
