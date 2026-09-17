const assert=require('node:assert/strict');
const {copy,definition,result,harness}=require('./helpers/penetration_ui.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const text=node=>[node.textContent,...node.children.map(text)].join(' ');
let passed=0;
async function check(name,fn){const h=harness();h.api.applyProject(await h.api.prepareDefaults());await fn(h);passed++;console.log(`ok - ${name}`);}
(async()=>{
  await check('Blank schedules, metadata groups and server outputs retain source semantics',async h=>{
    assert.deepEqual(copy(h.api.projectSnapshot().draft),definition().defaults);assert.equal(h.api.hasUnsavedChanges(),false);
    await h.audit.calculate();assert.match(text(h.byId('penetration-summary')),/123\.46/);
    assert.match(text(h.byId('penetration-breakdown')),/0\.00/);assert.match(text(h.byId('penetration-breakdown')),/#VALUE!/);
    assert.equal(h.calls.at(-1).payload.draft.rows.length,1);assert.deepEqual(h.calls.at(-1).payload.configuration,h.pricing);
  });
  await check('Focus and blur preserve exact numeric precision; percentages use source fractions',async h=>{
    const quantity=h.control('O');quantity.value='12.3456789012345';await quantity.emit('input');await quantity.blur();assert.equal(quantity.value,'12.35');await quantity.focus();assert.equal(quantity.value,'12.3456789012345');assert.equal(quantity.selectionStart,0);assert.equal(quantity.selectionEnd,quantity.value.length);
    await quantity.blur();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,12.3456789012345);
    const global=h.control('L',null);global.value='12.3456789012345';await global.emit('input');assert.equal(h.api.projectSnapshot().draft.globals.L,0.123456789012345);await global.blur();await global.focus();assert.equal(global.value,'12.3456789012345');
    global.value='';await global.emit('input');assert.equal(h.api.projectSnapshot().draft.globals.L,null);
  });
  await check('Invalid raw text survives groups and row selection, blocks save/export and clears stale totals',async h=>{
    await h.audit.calculate();h.audit.addRow();await flush();h.audit.selectRow('line-1');
    h.control('O').value='1e-';await h.control('O').emit('input');assert.equal(h.control('O').getAttribute('aria-invalid'),'true');assert.equal(h.audit.state.result,null);
    h.audit.state.group='Products and labour';h.audit.renderFields();h.audit.selectRow('line-2');h.audit.selectRow('line-1');h.audit.state.group='Penetration';h.audit.renderFields();assert.equal(h.control('O').value,'1e-');
    await assert.rejects(h.api.completeProjectSnapshot(),/marked invalid/);assert.equal(h.byId('penetration-pdf').disabled,true);assert.equal(h.byId('penetration-add').disabled,true);
    let fetched=false;h.context.fetch=()=>{fetched=true;};await h.audit.download('pdf');assert.equal(fetched,false);
    h.control('O').value='1.00000000000001';await h.control('O').emit('input');assert.equal(h.api.inputProblem(),'');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,1.00000000000001);
  });
  await check('Historical dropdown values remain visible without a custom-value bypass',async h=>{
    h.audit.state.draft.rows[0].inputs.J='Legacy service';h.audit.renderFields();const control=h.control('J');
    assert.equal(control.value,'Legacy service');assert.equal(control.children.at(-1).disabled,true);assert.match(control.children.at(-1).textContent,/choose a listed value/);
    control.value='Invented';await control.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.J,'Legacy service');assert.match(h.api.inputProblem(),/invalid/);
    control.value='HVAC';await control.emit('change');assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.J,'HVAC');
  });
  await check('Add, accessible remove and Undo preserve all values; editing the sole placeholder invalidates Undo',async h=>{
    h.audit.state.draft.rows[0].inputs={T:'Exact marker',AG:0.123456789012345};h.audit.addRow();await flush();h.audit.removeRow('line-1');await flush();h.audit.undoRemove();await flush();
    assert.deepEqual(copy(h.audit.state.draft.rows[0].inputs),{T:'Exact marker',AG:0.123456789012345});
    const button=h.byId('penetration-schedule-body').querySelectorAll('[data-penetration-remove]')[0];assert.equal(button.getAttribute('aria-label'),'Remove penetration line 1');assert.equal(button.title,'Remove line 1');
    h.audit.removeRow('line-2');h.audit.removeRow('line-1');await flush();assert.equal(h.audit.state.draft.rows.length,1);assert.deepEqual(copy(h.audit.state.draft.rows[0].inputs),{});
    h.control('T').value='New placeholder data';await h.control('T').emit('input');h.audit.undoRemove();assert.equal(h.audit.state.draft.rows[0].inputs.T,'New placeholder data');
  });
  await check('A thousand rows render bounded pages while calculation retains offscreen precise values',async h=>{
    const d=definition().defaults;d.rows=Array.from({length:1000},(_,i)=>({id:`line-${i+1}`,inputs:i===999?{T:'Last',O:9.123456789012345}:{}}));
    h.api.applyProject(await h.api.prepareProject({draft:d}));assert.equal(h.byId('penetration-schedule-body').children.length,50);assert.equal(h.byId('penetration-add').disabled,true);
    h.audit.selectRow('line-1000');assert.equal(h.control('O','line-1000').value,'9.12');await h.audit.calculate();
    assert.equal(h.calls.at(-1).payload.draft.rows.length,1000);assert.equal(h.calls.at(-1).payload.draft.rows[999].inputs.O,9.123456789012345);assert.match(text(h.byId('penetration-row-count')),/951–1000/);
  });
  await check('Editing a reused placeholder ID prevents older Undo entries from creating duplicate rows',async h=>{
    h.audit.state.draft.rows[0].inputs.T='First item';h.audit.addRow();await flush();
    h.audit.removeRow('line-1');h.audit.removeRow('line-2');await flush();
    h.control('T').value='Replacement item';await h.control('T').emit('input');h.audit.undoRemove();
    const rows=h.api.projectSnapshot().draft.rows;assert.equal(rows.length,1);assert.equal(rows[0].inputs.T,'Replacement item');assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
  });
  for(const transition of ['edit','new project','pricing'])await check(`Late calculations cannot overwrite a later ${transition}`,async h=>{
    const old=deferred(),captured=copy(h.audit.state.draft);h.audit.setRequest(()=>old.promise);const calculating=h.audit.calculate();await flush();
    if(transition==='edit'){h.control('T').value='Later';await h.control('T').emit('input');}
    if(transition==='new project')h.api.applyProject(await h.api.prepareDefaults());
    if(transition==='pricing')h.pricing.rates.original.price=2;
    const receipt=result(captured);receipt.draft.rows[0].inputs.T='Stale';old.resolve(receipt);await calculating;
    assert.notEqual(h.audit.state.draft.rows[0].inputs.T,'Stale');assert.equal(h.audit.state.result,null);
  });
  await check('Detached controls cannot write into a replacement project with the same row IDs',async h=>{
    const old=h.control('T');h.api.applyProject(await h.api.prepareDefaults());old.value='Stale input';await old.emit('input');assert.deepEqual(copy(h.audit.state.draft.rows[0].inputs),{});
  });
  await check('Pricing metadata updates preserve focused precise text and apply only the current snapshot',async h=>{
    const quantity=h.control('O');quantity.value='3.14159265358979';await quantity.emit('input');await quantity.focus();
    const old=deferred();h.audit.setRequest((path,payload)=>path.endsWith('/definition')?old.promise:Promise.resolve(result(payload.draft)));
    h.pricing.rates.original.price=2;const changing=h.api.pricingChanged();await flush();h.pricing.rates.original.price=3;
    const stale=definition();stale.row_fields[4].options=['Wrong historical price'];old.resolve(stale);await changing;assert.deepEqual(copy(h.audit.state.definition.row_fields[4].options),['Installer']);
    assert.equal(quantity.value,'3.14159265358979');assert.equal(h.audit.state.draft.rows[0].inputs.O,3.14159265358979);
  });
  await check('Save receipts adopt canonical captured drafts but preserve later edits and invalid text',async h=>{
    const captured=h.api.projectSnapshot(),receipt=copy(captured);receipt.draft.rows[0].inputs.T='Canonical';h.api.markProjectSaved(receipt,captured);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.audit.state.draft.rows[0].inputs.T,'Canonical');
    const next=h.api.projectSnapshot();h.control('T').value='Later';await h.control('T').emit('input');h.api.markProjectSaved(next,next);assert.equal(h.audit.state.draft.rows[0].inputs.T,'Later');assert.equal(h.api.hasUnsavedChanges(),true);
    const invalidCapture=h.api.projectSnapshot();h.control('O').value='bad';await h.control('O').emit('input');h.api.markProjectSaved(invalidCapture,invalidCapture);assert.equal(h.control('O').value,'bad');assert.equal(h.api.hasUnsavedChanges(),true);
  });
  await check('Older files prepare blank defaults without mutating current inputs; wrong source hashes reject',async h=>{
    h.control('T').value='Keep';await h.control('T').emit('input');const before=h.api.projectSnapshot();const prepared=await h.api.prepareProject(undefined);
    assert.deepEqual(copy(prepared.draft),definition().defaults);assert.deepEqual(copy(h.api.projectSnapshot()),copy(before));
    await assert.rejects(h.api.prepareProject({source_sha256:'wrong',draft:before.draft}),/different source workbook/);assert.deepEqual(copy(h.api.projectSnapshot()),copy(before));
  });
  for(const kind of ['pdf','xlsx'])await check(`${kind} captures precise inputs, pricing, identity and destination synchronously`,async h=>{
    h.control('O').value='123.456789012345';await h.control('O').emit('input');const pending=deferred();let sent;
    h.context.fetch=(path,options)=>{sent={path,body:JSON.parse(options.body)};return pending.promise;};const saving=h.audit.download(kind);
    assert.equal(sent.body.draft.rows[0].inputs.O,123.456789012345);assert.equal(sent.body.download.project_token,'original-token');assert.equal(sent.body.project_details.client,'Original client');
    h.target.project_token='later-save-as';h.details.client='Later client';h.pricing.rates.original.price=99;h.api.applyProject(await h.api.prepareDefaults());
    pending.resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:true,path:`C:/Original/report.${kind}`,filename:`report.${kind}`,destination:'project'})});await saving;
    assert.match(h.byId('penetration-message').textContent,/C:\/Original\/report/);assert.match(h.byId('penetration-message').textContent,/later changes are not included/);assert.deepEqual(copy(h.audit.state.draft.rows[0].inputs),{});
  });
  await check('Failed or unconfirmed downloads leave the draft intact and show actionable errors',async h=>{
    h.context.fetch=async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:false})});await h.audit.download('pdf');assert.match(h.byId('penetration-message').textContent,/did not confirm/);assert.equal(h.byId('penetration-pdf').disabled,false);
    h.audit.setRequest(async()=>{throw new Error('Calculation unavailable');});await h.audit.calculate();assert.match(h.byId('penetration-message').textContent,/Calculation unavailable/);assert.equal(h.audit.state.result,null);
  });
  await check('Numeric API bounds remain visibly invalid without replacing the last valid input',async h=>{
    const input=h.control('O');input.value='1000000000000';await input.emit('input');assert.equal(h.api.inputProblem(),'');
    for(const value of ['1000000000000.01','-1000000000000.01','1e309']){input.value=value;await input.emit('input');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(h.audit.state.draft.rows[0].inputs.O,1000000000000);}
    input.value='-1000000000000';await input.emit('input');assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.O,-1000000000000);
  });
  await check('Summary formula errors disclose the affected cell and message alongside unavailable totals',async h=>{
    h.audit.setRequest(async(path,payload)=>({...result(payload.draft),summary:{grand_total:'#VALUE!'},errors:[{row_id:null,cell:'H2',message:'A source formula returned #VALUE!'}]}));
    await h.audit.calculate();assert.match(text(h.byId('penetration-summary')),/#VALUE!/);assert.match(h.byId('penetration-summary-notes').textContent,/H2: A source formula returned #VALUE!/);assert.equal(h.byId('penetration-status').textContent,'Review calculation');
  });
  console.log(`${passed} penetration UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
