const assert=require('node:assert/strict'),fs=require('node:fs');
const {copy,definition,result,allowanceDefinition,allowanceResult,harness}=require('./helpers/penetration_ui.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const text=node=>[node.textContent,...node.children.map(text)].join(' ');
let passed=0;
async function check(name,fn){const h=harness();h.api.applyProject(await h.api.prepareDefaults());await fn(h);passed++;console.log(`ok - ${name}`);}
(async()=>{
  await check('Conditional Firestopping groups follow Type and Service Type without changing inputs',async h=>{
    const metadata=definition();metadata.groups=['Penetration','Unlagged Pipes','Plastic Pipes','Cables/Bundles','Cabletrays','Bulkhead'];metadata.group_visibility={
      'Unlagged Pipes':{column:'K',values:['Unlagged Pipes']},'Plastic Pipes':{column:'K',values:['Plastic Pipes']},
      'Cables/Bundles':{column:'K',values:['Cable Bundles','D1 Power Cables']},Cabletrays:{column:'K',values:['D1 Power Cables','D2 Comms Cables','Cable Trays']},Bulkhead:{column:'J',values:['Bulkheads']}};
    for(const group of metadata.groups.slice(1))metadata.row_fields.push({column:`field-${group}`,label:group,group,type:'number',format:'number',units:'',options:[],default:null});
    metadata.row_fields.push({column:'AL',label:'Diameter',group:'Pipes',display_groups:['Unlagged Pipes','Plastic Pipes','Cables/Bundles'],type:'number',format:'number',units:'mm',options:[],default:null});
    h.audit.state.definition=metadata;h.audit.state.draft.rows[0].inputs={J:'HVAC',K:'Unlagged Pipes',T:'Long source description'};h.audit.renderFields();
    assert.equal(h.byId('penetration-row-heading').textContent,'Current item · HVAC · Unlagged Pipes');
    assert.match(text(h.byId('penetration-input-groups')),/Penetration.*Unlagged Pipes/);assert.doesNotMatch(text(h.byId('penetration-input-groups')),/Plastic Pipes|Cables\/Bundles|Cabletrays|Bulkhead/);
    h.audit.state.draft.rows[0].inputs.K='Plastic Pipes';h.audit.renderFields();assert.match(text(h.byId('penetration-input-groups')),/Plastic Pipes/);assert.doesNotMatch(text(h.byId('penetration-input-groups')),/Unlagged Pipes/);
    h.audit.state.draft.rows[0].inputs={J:'Bulkheads',K:'Cable Bundles'};h.audit.renderFields();assert.match(text(h.byId('penetration-input-groups')),/Cables\/Bundles.*Bulkhead/);
    h.audit.state.draft.rows[0].inputs={J:'Electrical',K:'D1 Power Cables'};h.audit.renderFields();assert.match(text(h.byId('penetration-input-groups')),/Cables\/Bundles.*Cabletrays/);
    h.audit.state.edit={rowId:'line-1'};h.audit.renderFields();assert.equal(h.byId('penetration-row-heading').textContent,'Editing schedule item · Electrical · D1 Power Cables');
    h.audit.state.group='Cables/Bundles';h.audit.renderFields();assert.match(text(h.byId('penetration-row-fields')),/Diameter/);
  });
  await check('Requested estimator numbers use native step controls without changing stored precision',async h=>{
    let quantity=h.control('O');assert.equal(quantity.type,'number');assert.equal(quantity.step,'1');
    h.audit.state.group='Substrate';h.audit.renderFields();const length=h.control('AW');assert.equal(length.type,'number');assert.equal(length.step,'5');
    length.value='12.3456789012345';await length.emit('input');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.AW,12.3456789012345);
    const metadata=allowanceDefinition();h.audit.state.definition=metadata;h.audit.state.group='Products and labour';h.audit.renderFields();const allowance=h.control('register_allowance_hours');assert.equal(allowance.type,'number');assert.equal(allowance.step,'0.05');
  });
  await check('Automatic allowances display server defaults without dirtying inputs and support precise manual, zero and reset values',async h=>{
    const metadata=allowanceDefinition();h.audit.state.definition=metadata;h.audit.state.group='Products and labour';h.audit.renderFields();
    h.audit.setRequest(async(path,payload)=>allowanceResult(payload.draft,metadata));const before=copy(h.api.projectSnapshot());
    let control=h.control('register_allowance_hours');await control.focus();assert.equal(control.value,'');await h.audit.calculate();assert.equal(control.value,'');assert.match(text(control.parentNode),/Automatic: 0\.25 hrs/);await control.blur();assert.equal(control.value,'0.25');assert.deepEqual(copy(h.api.projectSnapshot()),before);assert.equal(h.api.hasUnsavedChanges(),false);
    await control.focus();assert.equal(control.value,'0.25');await control.blur();assert.deepEqual(copy(h.api.projectSnapshot()),before);
    for(const value of [0,.123456789012345]){await control.focus();control.value=String(value);await control.emit('input');await control.blur();await h.audit.calculate();assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.register_allowance_hours,value);await control.focus();assert.equal(control.value,String(value));await control.blur();assert.match(text(control.parentNode),/Manual allowance/);}
    control.value='-1';await control.emit('input');assert.match(h.api.inputProblem(),/invalid/);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.register_allowance_hours,.123456789012345);
    await control.parentNode.children[3].children[1].emit('click');await h.audit.calculate();assert.equal(h.api.inputProblem(),'');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.register_allowance_hours,null);assert.equal(control.value,'0.25');
    await control.focus();control.value='';await control.emit('input');await control.blur();await h.audit.calculate();assert.equal(control.value,'0.25');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.register_allowance_hours,null);
  });
  await check('Changed backend defaults refresh idle automatic fields without overwriting focused or manual values and stale responses stay rejected',async h=>{
    const metadata=allowanceDefinition();h.audit.state.definition=metadata;h.audit.state.group='Pipes';h.audit.renderFields();let automatic=.3123456789;
    h.audit.setRequest(async(path,payload)=>allowanceResult(payload.draft,metadata,{pipe_labour_hours:automatic,register_allowance_hours:.25}));await h.audit.calculate();const pipe=h.control('pipe_labour_hours'),diameter=h.control('AL');await pipe.focus();assert.equal(pipe.value,String(automatic));
    automatic=.7123456789;await h.audit.calculate();assert.equal(pipe.value,'0.3123456789');await pipe.blur();assert.equal(pipe.value,'0.71');assert.equal(h.api.hasUnsavedChanges(),false);
    diameter.value='200';await diameter.emit('input');assert.equal(pipe.value,'');await h.audit.calculate();assert.equal(pipe.value,'0.71');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.pipe_labour_hours,undefined);
    pipe.value='0';await pipe.emit('input');automatic=null;await h.audit.calculate();assert.equal(pipe.value,'0.00');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.pipe_labour_hours,0);
    const pending=deferred(),captured=copy(h.audit.state.draft);h.audit.setRequest(()=>pending.promise);const calculating=h.audit.calculate();await flush();pipe.value='0.987654321';await pipe.emit('input');pending.resolve(allowanceResult(captured,metadata));await calculating;assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.pipe_labour_hours,.987654321);assert.equal(h.audit.state.result,null);
    h.audit.setRequest(async(path,payload)=>allowanceResult(payload.draft,metadata,{pipe_labour_hours:null,register_allowance_hours:.25}));await pipe.parentNode.children[3].children[1].emit('click');await h.audit.calculate();assert.equal(pipe.value,'');assert.match(text(pipe.parentNode),/No automatic value/);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.pipe_labour_hours,null);
  });
  await check('Named allowance overrides survive Add, explicit Update, Remove Undo and project Save Open without changing independent composer state',async h=>{
    const metadata=allowanceDefinition();h.audit.setRequest(async(path,payload)=>path.endsWith('/definition')?metadata:allowanceResult(payload.draft,metadata));h.audit.state.definition=metadata;
    Object.assign(h.audit.state.draft.rows[0].inputs,{T:'Allowance fixture',O:2,register_allowance_hours:0,pipe_labour_hours:.3456789012345});await h.audit.addToSchedule();const original=copy(h.api.projectSnapshot());assert.deepEqual(original.draft.rows[0].inputs,original.composer.rows[0].inputs);
    const id=original.draft.rows[0].id;await h.audit.selectRow(id);h.audit.state.group='Pipes';h.audit.renderFields();const pipe=h.control('pipe_labour_hours',id);pipe.value='.4567890123456';await pipe.emit('input');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.pipe_labour_hours,.3456789012345);await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.pipe_labour_hours,.4567890123456);
    h.audit.removeRow(id);h.audit.undoRemove();const saved=copy(h.api.projectSnapshot());h.api.markProjectSaved(saved,saved);assert.equal(h.api.hasUnsavedChanges(),false);h.api.applyProject(await h.api.prepareProject(saved));assert.deepEqual(copy(h.api.projectSnapshot()),saved);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('The shared breakdown preserves eight server rows, separate register and additional labour, and server subtotals without deriving amounts',async h=>{
    const labels=['Additional Labour','Register allowance','Board','Collars','Mastic','Framing','Wrap','Other'];
    const rows=labels.map((label,index)=>({label,unit_prices:[{value:10+index,format:'currency'}],material_quantities:[],material_costs:index,labour_costs:index*2,task_hours:index/10}));
    rows[2].material_quantities=[{label:'Substrate',value:1.23456789,units:'m²'},{label:'Bulkhead',value:2.3456789,units:'m²'}];
    rows[5].material_quantities=[{label:'Bulkhead',value:3.456789,units:'m'}];rows[6].material_quantities=[{label:'Pipes',value:4.56789,units:'m²'},{label:'Cabletrays',value:5.6789,units:'m²'}];
    const row={inputs:{AC:989898,AN:878787,AF:767676},outputs:{BQ:656565},errors:[],breakdown:{rows,totals:{material_costs:999.12,labour_costs:888.23,task_hours:777.34},note:'Server calculation basis'}};
    const original=copy(row),rendered=h.context.window.CeasefirePenetrationBreakdown.render(definition(),row),table=rendered.children[0].children[0],body=table.children[2],foot=table.children[3];
    assert.deepEqual(body.children.map(line=>line.children[0].textContent),labels);assert.deepEqual(copy(row),original);
    assert.deepEqual(table.children[1].children[0].children.map(cell=>cell.textContent),['Item','Unit Prices','Material Quantities','Material Costs','Labour Costs','Task Hours']);
    assert.equal(body.children.flatMap(line=>line.children[2].children).length,5);assert.match(text(body),/Substrate.*1\.23.*Bulkhead.*2\.35/);assert.match(text(body),/Pipes.*4\.57.*Cabletrays.*5\.68/);
    for(const index of [0,1,3,4,7])assert.equal(body.children[index].children[2].textContent,'—');
    assert.deepEqual(foot.children[0].children.map(cell=>cell.textContent),['Subtotal','$999.12','$888.23','777.34']);assert.doesNotMatch(text(rendered),/989898|878787|767676|656565/);
    assert.equal(rendered.children[0].tabIndex,0);assert.equal(rendered.children[0].getAttribute('aria-label'),'Item cost breakdown');
  });
  await check('The shared breakdown exposes source errors, distinguishes zero and blank, and retains literal labels',async h=>{
    const row={errors:[{cell:'F4',message:'#VALUE!'}],breakdown:{rows:[{label:'<img src=x>',unit_prices:[{value:0}],material_quantities:[],material_costs:0,labour_costs:null,task_hours:'#DIV/0!'}],totals:{material_costs:0,labour_costs:'#VALUE!',task_hours:null}}};
    const rendered=h.context.window.CeasefirePenetrationBreakdown.render(definition(),row),content=text(rendered);
    assert.match(content,/F4: #VALUE!/);assert.match(content,/<img src=x>/);assert.match(content,/\$0\.00/);assert.match(content,/#DIV\/0!/);assert.match(content,/—/);
    const table=rendered.children[1].children[0],line=table.children[2].children[0];assert.equal(line.children[0].children.length,0);assert.equal(line.children[3].textContent,'$0.00');assert.equal(line.children[4].textContent,'—');
    assert.match(text(h.context.window.CeasefirePenetrationBreakdown.render(definition(),{outputs:{},errors:[]})),/unavailable/);
  });
  await check('Summary retains item totals while removed allowance outputs and Multipliers stay absent without changing source values',async h=>{
    const metadata=definition();metadata.output_fields.push({column:'B',label:'Substrate cost',group:'Summary',format:'currency'},{column:'BI',label:'Complexity',group:'Multipliers',format:'percent'},{column:'BJ',label:'Access',group:'Multipliers',format:'percent'});
    const row=result(metadata.defaults).rows[0];Object.assign(row.outputs,{B:37.89123,BI:.123456789,BJ:'#VALUE!'});
    const original=copy(row),rendered=h.context.window.CeasefirePenetrationBreakdown.render(metadata,row),sections=rendered.children.filter(child=>child.tagName==='details');
    assert.deepEqual(sections.map(section=>section.children[0].textContent),['Summary']);assert.match(text(sections[0]),/Item total.*\$123\.46/);assert.deepEqual(copy(row),original);
    assert.doesNotMatch(text(rendered),/Substrate cost|37\.89|Multipliers|Complexity|12\.35%|Access|Material quantities|Unit prices|Labour days/);
    delete row.breakdown;const unavailable=h.context.window.CeasefirePenetrationBreakdown.render(metadata,row);assert.match(text(unavailable),/unavailable.*Summary.*Item total/);assert.doesNotMatch(text(unavailable),/Substrate cost|Multipliers|Complexity|Access/);
  });
  await check('An uncertain library save retries the same key and does not claim success',async h=>{
    h.context.crypto={randomUUID:()=> 'stable-capture'};const keys=[];h.audit.state.draft.rows[0].inputs={T:'Pipe',O:1};
    h.audit.setRequest(async(path,payload)=>{keys.push(payload.idempotency_key);throw new Error('Connection lost');});
    await h.audit.addToLibrary();assert.match(h.byId('penetration-message').textContent,/not confirmed/);await h.audit.addToLibrary();assert.deepEqual(keys,['stable-capture','stable-capture']);
    assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,'Pipe');assert.equal(h.byId('penetration-add-to-library').disabled,false);
  });
  await check('Calculation normalization and object ordering do not duplicate an uncertain library capture',async h=>{
    let sequence=0;h.context.crypto={randomUUID:()=>`canonical-capture-${++sequence}`};const captured=[];
    h.audit.state.draft.globals={L:0};h.audit.state.draft.rows[0].inputs={T:'Pipe',U:'',O:1};
    h.audit.setRequest(async(path,payload)=>{
      if(path==='/api/libraries/penetration'){
        captured.push(copy(payload));if(captured.length===1)throw new Error('Connection lost after save');
        return{id:'new-1',library_id:'FL-ID-100001',draft:copy(payload.draft),price:{amount:12.34},created:false};
      }
      const normalized=copy(payload.draft);normalized.globals={M:0,L:0,K:null,J:'No'};normalized.rows[0].inputs={O:1,U:null,T:'Pipe'};return result(normalized);
    });
    await h.audit.addToLibrary();assert.match(h.byId('penetration-message').textContent,/not confirmed/);
    await h.audit.calculate();const inventory=h.pricing.inventory;delete h.pricing.inventory;h.pricing.inventory=inventory;
    await h.audit.addToLibrary();assert.equal(captured[0].idempotency_key,captured[1].idempotency_key);assert.deepEqual(captured[0].draft,captured[1].draft);
    assert.deepEqual(captured[0].draft.globals,{J:'No',K:null,L:0,M:0});assert.equal(captured[0].draft.rows[0].inputs.U,null);
    assert.match(h.byId('penetration-message').textContent,/already in/);assert.doesNotMatch(h.byId('penetration-message').textContent,/later edits/);
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
  await check('Numeric API bounds remain visibly invalid without replacing the last valid input',async h=>{
    const input=h.control('O');input.value='1000000000000';await input.emit('input');assert.equal(h.api.inputProblem(),'');
    for(const value of ['1000000000000.01','-1000000000000.01','1e309']){input.value=value;await input.emit('input');assert.equal(input.getAttribute('aria-invalid'),'true');assert.equal(h.audit.state.draft.rows[0].inputs.O,1000000000000);}
    input.value='-1000000000000';await input.emit('input');assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.O,-1000000000000);
  });
  await check('Summary formula errors disclose the affected cell and message alongside unavailable totals',async h=>{
    h.audit.setRequest(async(path,payload)=>({...result(payload.draft),summary:{grand_total:'#VALUE!'},errors:[{row_id:null,cell:'H2',message:'A source formula returned #VALUE!'}]}));
    await h.audit.calculate();assert.match(text(h.byId('penetration-summary')),/#VALUE!/);assert.match(h.byId('penetration-summary-notes').textContent,/H2: A source formula returned #VALUE!/);
  });

  await check('Fresh projects have an empty schedule and one independent composer; opening schedule does not calculate composer',async h=>{
    assert.deepEqual(copy(h.api.projectSnapshot().draft),definition().schedule_defaults);assert.deepEqual(copy(h.api.projectSnapshot().composer),definition().defaults);
    const count=h.calls.length;await h.api.openSchedule();assert.equal(h.calls.length,count+1);assert.equal(h.calls.at(-1).payload.draft.rows.length,0);assert.equal(h.audit.state.result,null);
    await h.api.open();assert.equal(h.calls.at(-1).payload.draft.rows.length,1);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Raw composer and schedule globals survive editing, calculation and reopening without editable allowance controls',async h=>{
    const snapshot={draft:copy(definition().schedule_defaults),composer:copy(definition().defaults)};
    snapshot.composer.globals={J:'Yes',K:3.14159265358979,L:.123456789012345,M:27.123456789};snapshot.draft.globals={J:'No',K:null,L:.076543210987654,M:0};
    h.api.applyProject(await h.api.prepareProject(snapshot));
    h.control('O').value='2.3456789012345';await h.control('O').emit('input');
    assert.equal(h.api.projectSnapshot().draft.rows.length,0);
    await h.audit.calculate();assert.equal(h.calls.at(-1).payload.draft.rows[0].inputs.O,2.3456789012345);assert.deepEqual(copy(h.calls.at(-1).payload.draft.globals),snapshot.composer.globals);assert.equal(h.audit.state.schedule.result,null);
    await h.audit.calculateSchedule();assert.deepEqual(copy(h.calls.at(-1).payload.draft.globals),snapshot.draft.globals);
    for(const group of h.audit.state.definition.groups){h.audit.state.group=group;h.audit.renderFields();assert.ok(h.byId('penetration-row-fields').querySelectorAll('[data-penetration-field]').every(control=>control.dataset.penetrationRow==='line-1'));assert.equal(h.control('L',null),undefined);}
    const captured=h.api.projectSnapshot();h.api.markProjectSaved(captured,captured);assert.equal(h.api.hasUnsavedChanges(),false);h.api.applyProject(await h.api.prepareProject(captured));
    assert.deepEqual(copy(h.api.projectSnapshot().composer.globals),snapshot.composer.globals);assert.deepEqual(copy(h.api.projectSnapshot().draft.globals),snapshot.draft.globals);
    const html=fs.readFileSync('static/index.html','utf8');for(const id of ['penetration-project-allowances','penetration-global-fields','penetration-schedule-global-fields'])assert.ok(!html.includes(`id="${id}"`),`${id} must not remain in HTML`);
  });
  await check('Substrate inputs remain available in the current item after allowance controls are removed',async h=>{
    const button=h.byId('penetration-input-groups').children.find(button=>button.textContent==='Substrate');assert.ok(button);await button.emit('click');assert.equal(button.dataset.penetrationGroup,'Substrate');
    const length=h.control('AW');assert.ok(length);length.value='450.123456789';await length.emit('input');await h.audit.calculate();assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.AW,450.123456789);assert.equal(h.api.projectSnapshot().draft.rows.length,0);
  });
  await check('Adding composer copies inputs only, preserves independent raw globals and displays recalculated schedule receipt',async h=>{
    h.audit.state.draft.rows[0].inputs={T:'Pipe',O:1.23456789012345};h.audit.state.draft.globals.L=.9;h.audit.state.schedule.draft.globals.L=.17;
    const composer=copy(h.api.projectSnapshot().composer);const receipt=await h.audit.addToSchedule();assert.equal(receipt.added,true);assert.equal(receipt.total,123.456789);
    assert.deepEqual(copy(h.api.projectSnapshot().composer),composer);assert.deepEqual(copy(h.api.projectSnapshot().draft.rows[0].inputs),composer.rows[0].inputs);assert.equal(h.calls.at(-1).payload.draft.globals.L,.17);
    await h.audit.addToSchedule();assert.equal(h.api.projectSnapshot().draft.rows.length,2);assert.match(receipt.message,/current schedule prices/);assert.doesNotMatch(receipt.message,/allowances/);
  });
  await check('Inline schedule quantity retains focus, exact precision and stable DOM without touching the composer',async h=>{
    await h.audit.addToSchedule();const body=h.byId('penetration-schedule-body'),row=body.children[0],quantity=row.children[5].querySelectorAll('[data-penetration-field]')[0];
    await quantity.focus();quantity.value='2.345678901234';quantity.selectionStart=quantity.selectionEnd=14;await quantity.emit('input');assert.equal(body.children[0],row);assert.equal(h.context.document.activeElement,quantity);assert.equal(quantity.selectionEnd,14);
    assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,2.345678901234);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.O,undefined);
    h.audit.setRequest(async(path,payload)=>{const r=result(payload.draft);r.rows[0].outputs.H=payload.draft.rows[0].inputs.O*10;return r;});await h.audit.calculateSchedule();assert.equal(body.children[0],row);assert.equal(quantity.value,'2.345678901234');assert.equal(row.children[6].textContent,'$23.46');
    await quantity.blur();assert.equal(quantity.value,'2.35');await quantity.focus();assert.equal(quantity.value,'2.345678901234');
  });
  await check('Invalid text stays in its own scope, blocks persistence, and schedule exports ignore unrelated invalid composer input',async h=>{
    await h.audit.addToSchedule();const quantity=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];
    quantity.value='1e-';await quantity.emit('input');assert.equal(h.control('O').value,'');assert.equal(h.byId('penetration-pdf').disabled,true);await assert.rejects(h.api.completeProjectSnapshot(),/marked invalid/);
    quantity.value='3.14159265358979';await quantity.emit('input');h.control('O').value='bad';await h.control('O').emit('input');assert.equal(h.byId('penetration-pdf').disabled,false);assert.equal(quantity.value,'3.14');
    h.audit.state.group='Products and labour';h.audit.renderFields();h.audit.state.group='Penetration';h.audit.renderFields();assert.equal(h.control('O').value,'bad');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,3.14159265358979);
  });
  await check('Edit creates a copy; Update is explicit and Cancel restores the previous composer including raw invalid input',async h=>{
    h.audit.state.draft.rows[0].inputs={T:'Scheduled',O:2};await h.audit.addToSchedule();h.control('T').value='Prior current item';await h.control('T').emit('input');h.control('O').value='1e-';await h.control('O').emit('input');
    await h.audit.selectRow('line-1');assert.equal(h.control('T').value,'Scheduled');h.control('T').value='Edited copy';await h.control('T').emit('input');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Scheduled');
    await h.audit.cancelEdit();assert.equal(h.control('T').value,'Prior current item');assert.equal(h.control('O').value,'1e-');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Scheduled');
    await h.audit.selectRow('line-1');h.control('T').value='Updated';await h.control('T').emit('input');await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Updated');assert.equal(h.audit.state.edit,null);
  });
  await check('New item preserves schedule, applies defaults, and declined replacement keeps dirty composer',async h=>{
    h.control('T').value='Keep';await h.control('T').emit('input');await h.audit.addToSchedule();h.audit.state.definition.row_fields.push({column:'Q',type:'select',group:'Penetration',label:'Access',default:'Standard',options:['Standard']});
    h.context.window.CeasefirePenetrationNavigation.confirm=async()=>false;await h.audit.addRow();assert.equal(h.control('T').value,'Keep');
    h.context.window.CeasefirePenetrationNavigation.confirm=async()=>true;await h.audit.addRow();assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.Q,'Standard');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,undefined);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Keep');
  });
  for(const transition of ['composer edit','project replacement','remove and reuse'])await check(`Deferred Edit confirmation cannot overwrite after ${transition}`,async h=>{
    h.control('T').value='Before';await h.control('T').emit('input');await h.audit.addToSchedule();const pending=deferred();h.context.window.CeasefirePenetrationNavigation.confirm=()=>pending.promise;const editing=h.audit.selectRow('line-1');await flush();
    if(transition==='composer edit'){h.control('T').value='Later';await h.control('T').emit('input');}
    if(transition==='project replacement')h.api.applyProject(await h.api.prepareDefaults());
    if(transition==='remove and reuse'){h.audit.removeRow('line-1');await flush();await h.audit.addToSchedule();}
    pending.resolve(true);await editing;assert.equal(h.audit.state.edit,null);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,transition==='project replacement'?undefined:transition==='composer edit'?'Later':'Before');
  });
  await check('Deleted or changed schedule targets cannot be overwritten by an earlier edited copy, even after ID reuse or Undo',async h=>{
    await h.audit.addToSchedule();await h.audit.selectRow('line-1');h.control('T').value='Old edit';await h.control('T').emit('input');h.audit.removeRow('line-1');await flush();h.audit.undoRemove();await flush();await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,undefined);
    await h.audit.selectRow('line-1');const qty=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];qty.value='4';await qty.emit('input');await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,4);
  });
  await check('Add another copy while editing does not update the original target',async h=>{
    await h.audit.addToSchedule();await h.audit.selectRow('line-1');h.control('T').value='Copy';await h.control('T').emit('input');await h.audit.addToSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,undefined);assert.equal(h.api.projectSnapshot().draft.rows[1].inputs.T,'Copy');assert.equal(h.audit.state.edit.id,'line-1');
  });
  await check('Library transfer preserves composer including invalid text and view, uses schedule prices and returns a receipt',async h=>{
    h.control('T').value='Unsaved composer';await h.control('T').emit('input');h.control('O').value='bad';await h.control('O').emit('input');h.audit.state.schedule.draft.globals.L=.17345;let navigation=0;h.context.window.CeasefirePenetrationNavigation.show=()=>navigation++;
    const item={library_id:'FL-ID-898',definition:definition(),draft:{globals:{L:.99},rows:[{id:'library-row',inputs:{T:'Library pipe',O:1.23456789012345}}]}};
    h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?item:result(payload.draft));const before=copy(h.api.projectSnapshot().composer),receipt=await h.api.addLibraryItem('library-id');
    assert.deepEqual(copy(h.api.projectSnapshot().composer),before);assert.equal(h.control('O').value,'bad');assert.equal(navigation,0);assert.equal(receipt.total,123.456789);assert.match(receipt.message,/123\.46/);assert.equal(h.api.projectSnapshot().draft.globals.L,.17345);
  });
  await check('Failed library schedule calculation leaves the added item with an explicit unavailable price',async h=>{
    h.audit.setRequest(async(path)=>{if(path.endsWith('/edit'))return{library_id:'FL-ID-1',definition:definition(),draft:definition().defaults};throw new Error('Service unavailable');});const receipt=await h.api.addLibraryItem('one');assert.equal(receipt.added,true);assert.equal(receipt.total,null);assert.match(receipt.message,/price is unavailable/);assert.equal(h.api.projectSnapshot().draft.rows.length,1);
  });
  for(const transition of ['project','editor','source'])await check(`Library transfer rejects a late ${transition} mismatch without adding rows`,async h=>{
    const pending=deferred();h.audit.setRequest(()=>pending.promise);const transfer=h.api.addLibraryItem('one');await flush();
    if(transition==='project')h.api.applyProject(await h.api.prepareDefaults());if(transition==='editor')h.context.window.CeasefireLibraryEditor={isOpen:()=>true};
    const metadata=definition();if(transition==='source')metadata.source_sha256='other';pending.resolve({library_id:'FL-ID-1',definition:metadata,draft:metadata.defaults});await assert.rejects(transfer);assert.equal(h.api.projectSnapshot().draft.rows.length,0);
  });
  await check('Double library clicks, capacity and invalid schedule inputs cannot add duplicate or hidden rows',async h=>{
    const pending=deferred();h.audit.setRequest((path,payload)=>path.endsWith('/edit')?pending.promise:Promise.resolve(result(payload.draft)));const transfer=h.api.addLibraryItem('one');await assert.rejects(h.api.addLibraryItem('one'),/already being added/);pending.resolve({definition:definition(),draft:definition().defaults,library_id:'FL-ID-1'});await transfer;
    h.audit.state.definition.capacity=1;await h.api.addLibraryItem('one');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,2);h.audit.state.definition.capacity=1;h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{definition:definition(),draft:{...definition().defaults,rows:[{id:'source',inputs:{T:'Other'}}]},library_id:'FL-ID-2'}:result(payload.draft));await assert.rejects(h.api.addLibraryItem('two'),/full/);assert.equal(h.api.projectSnapshot().draft.rows.length,1);
    h.audit.state.schedule.invalid.set('["line-1","O"]',{value:'bad',error:'bad'});await assert.rejects(h.api.addLibraryItem('one'),/marked invalid/);
  });
  await check('Add to Library captures composer only and preserves later edits while reusing its retry key',async h=>{
    let sequence=0;h.context.crypto={randomUUID:()=>`capture-${++sequence}`};h.control('T').value='Captured';await h.control('T').emit('input');await h.audit.addToSchedule();const pending=deferred(),calls=[];
    h.audit.setRequest(async(path,payload)=>{calls.push(copy(payload));return pending.promise;});const capture=h.audit.addToLibrary();assert.equal(h.byId('penetration-add-to-library').disabled,true);await h.audit.addToLibrary();assert.equal(calls.length,1);
    h.control('T').value='Later';await h.control('T').emit('input');pending.resolve({id:'new',library_id:'FL-ID-100001',draft:calls[0].draft,price:{amount:1}});await capture;assert.equal(calls[0].draft.rows.length,1);assert.equal(calls[0].draft.rows[0].inputs.T,'Captured');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Captured');assert.equal(h.control('T').value,'Later');assert.match(h.byId('penetration-message').textContent,/later edits/);
    h.control('T').value='Captured';await h.control('T').emit('input');await h.audit.addToLibrary();assert.equal(calls[1].idempotency_key,calls[0].idempotency_key);
  });
  await check('Remove and Undo allow a truly empty schedule and retain precision without affecting composer',async h=>{
    h.audit.state.draft.rows[0].inputs={T:'Marker',AG:.123456789012345};await h.audit.addToSchedule();const composer=copy(h.api.projectSnapshot().composer),button=h.byId('penetration-schedule-body').querySelectorAll('[data-penetration-remove]')[0];assert.equal(button.title,'Remove item 1');assert.equal(button.getAttribute('aria-label'),'Remove firestopping item 1');
    h.audit.removeRow('line-1');await flush();assert.equal(h.api.projectSnapshot().draft.rows.length,0);h.audit.undoRemove();await flush();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.AG,.123456789012345);assert.deepEqual(copy(h.api.projectSnapshot().composer),composer);
  });
  await check('A thousand scheduled rows render bounded pages and retain every precise row in calculations',async h=>{
    const draft=definition().schedule_defaults;draft.rows=Array.from({length:1000},(_,i)=>({id:`line-${i+1}`,inputs:i===999?{K:'Last service',L:'Core hole',M:'Floor',N:'120/120/120',O:9.123456789012345}:{}}));h.api.applyProject(await h.api.prepareProject({draft}));assert.equal(h.byId('penetration-schedule-body').children.length,50);assert.equal(h.byId('penetration-add-to-schedule').disabled,true);assert.equal(h.byId('penetration-add').disabled,false);
    h.audit.state.page=19;h.audit.renderSchedule();await h.audit.calculateSchedule();assert.equal(h.calls.at(-1).payload.draft.rows.length,1000);assert.equal(h.calls.at(-1).payload.draft.rows[999].inputs.O,9.123456789012345);assert.match(text(h.byId('penetration-row-count')),/951–1000/);const row=h.byId('penetration-schedule-body').children[49];assert.deepEqual(row.children.slice(1,5).map(el=>el.textContent),['Last service','Core hole','Floor','120/120/120']);
  });
  for(const transition of ['edit','new project','pricing'])await check(`Late schedule calculations cannot overwrite a later ${transition}`,async h=>{
    await h.audit.addToSchedule();const pending=deferred(),captured=copy(h.api.projectSnapshot().draft);h.audit.setRequest(()=>pending.promise);const calculating=h.audit.calculateSchedule();await flush();
    if(transition==='edit'){const qty=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];qty.value='7.123456789';await qty.emit('input');}if(transition==='new project')h.api.applyProject(await h.api.prepareDefaults());if(transition==='pricing')h.pricing.rates.original.price=2;
    const stale=result(captured);stale.draft.rows[0].inputs.O=999;pending.resolve(stale);await calculating;assert.notEqual(h.api.projectSnapshot().draft.rows[0]?.inputs.O,999);
  });
  await check('Detached composer and schedule controls cannot mutate replacements with reused row IDs',async h=>{
    await h.audit.addToSchedule();const oldComposer=h.control('T'),oldQty=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];await h.audit.addRow();oldComposer.value='stale';await oldComposer.emit('input');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,undefined);
    h.audit.removeRow('line-1');await flush();await h.audit.addToSchedule();oldQty.value='999';await oldQty.emit('input');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,undefined);
  });
  await check('Save receipts preserve both scopes, later edits and invalid text; reopening clears edit mode only',async h=>{
    await h.audit.addToSchedule();await h.audit.selectRow('line-1');const captured=h.api.projectSnapshot(),receipt=copy(captured);receipt.composer.rows[0].inputs.T='Canonical';h.api.markProjectSaved(receipt,captured);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.control('T').value,'Canonical');
    const next=h.api.projectSnapshot();h.control('T').value='Later';await h.control('T').emit('input');const qty=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];qty.value='8.123456789';await qty.emit('input');h.api.markProjectSaved(next,next);assert.equal(h.control('T').value,'Later');assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,8.123456789);assert.equal(h.api.hasUnsavedChanges(),true);
    h.control('O').value='bad';await h.control('O').emit('input');h.api.markProjectSaved(next,next);assert.equal(h.control('O').value,'bad');const prepared=await h.api.prepareProject(h.api.projectSnapshot());h.api.applyProject(prepared);assert.equal(h.audit.state.edit,null);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,'Later');
  });
  await check('Legacy schedules stay exact and get a separate fresh composer; wrong source hashes reject',async h=>{
    const draft={globals:{L:.12345},rows:[{id:'old',inputs:{T:'Historical',Q:null,R:null}}]},prepared=await h.api.prepareProject({draft});assert.deepEqual(copy(prepared.draft),draft);assert.deepEqual(copy(prepared.composer),definition().defaults);assert.equal(h.api.projectSnapshot().draft.rows.length,0);await assert.rejects(h.api.prepareProject({draft,source_sha256:'wrong'}),/different source workbook/);
  });
  await check('Historical dropdown values stay visible without custom input and percentage focus retains precision',async h=>{
    h.audit.state.draft.rows[0].inputs.J='Legacy';h.audit.renderFields();const input=h.control('J');assert.equal(input.children.at(-1).disabled,true);input.value='Invented';await input.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.J,'Legacy');input.value='HVAC';await input.emit('change');assert.equal(h.api.inputProblem(),'');
    h.audit.state.group='Additional Allowances';h.audit.renderFields();const allowance=h.control('AG');allowance.value='12.3456789012345';await allowance.emit('input');await allowance.blur();assert.equal(allowance.value,'12.35');await allowance.focus();assert.equal(allowance.value,'12.3456789012345');assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.AG,.123456789012345);
  });
  for(const kind of ['pdf','xlsx'])await check(`${kind} exports schedule only and captures precision, prices, details and destination before later edits`,async h=>{
    h.control('O').value='123.456789012345';await h.control('O').emit('input');await h.audit.addToSchedule();h.control('O').value='99';await h.control('O').emit('input');const pending=deferred();let sent;h.context.fetch=(path,options)=>{sent={path,body:JSON.parse(options.body)};return pending.promise;};const saving=h.audit.download(kind);
    assert.equal(sent.body.draft.rows[0].inputs.O,123.456789012345);assert.equal(sent.body.composer,undefined);assert.equal(sent.body.download.project_token,'original-token');assert.equal(sent.body.project_details.client,'Original client');h.target.project_token='later';h.details.client='Later';h.pricing.rates.original.price=99;h.api.applyProject(await h.api.prepareDefaults());
    pending.resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:true,path:`C:/Original/report.${kind}`,filename:`report.${kind}`,destination:'project'})});await saving;assert.match(h.byId('penetration-schedule-message').textContent,/C:\/Original\/report/);assert.match(h.byId('penetration-schedule-message').textContent,/later changes are not included/);
  });
  await check('Unconfirmed downloads preserve drafts and disclose an actionable error',async h=>{
    const before=h.api.projectSnapshot();h.context.fetch=async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({saved:false})});await h.audit.download('pdf');assert.match(h.byId('penetration-schedule-message').textContent,/did not confirm/);assert.deepEqual(copy(h.api.projectSnapshot()),copy(before));
  });
  await check('Aggregate renderer retains server totals and line-labelled Summary while hiding allowance outputs and Multipliers without deriving amounts',async h=>{
    const projection={rows:[{label:'<Wrap>',unit_prices:[{label:'Line 1 Product A',value:12.3,format:'currency'},{label:'Line 2 Product B',value:99,format:'currency'}],material_quantities:[{label:'Line 1 Pipes',value:0,units:'m²'}],material_costs:888.12,labour_costs:'#VALUE!',task_hours:0}],totals:{material_costs:777.65,labour_costs:'#VALUE!',task_hours:0},source_groups:[{label:'Summary',rows:[{row_id:'line-1',label:'Line 1',values:[{column:'B',label:'Substrate cost',value:41.23,format:'currency'},{column:'H',label:'Item total',value:123.456789,format:'currency'}]}]},{label:'Multipliers',rows:[{row_id:'line-2',label:'Line 2',values:[{column:'BJ',label:'Access',value:.125,format:'percent'}]}]}]};
    const output={schedule_breakdown:projection,errors:[]},original=copy(output);const rendered=h.context.window.CeasefirePenetrationBreakdown.renderSchedule(definition(),output),content=text(rendered);assert.match(content,/<Wrap>/);assert.match(content,/777\.65/);assert.match(content,/#VALUE!/);assert.match(content,/Summary.*Line 1.*Item total.*123\.46/);assert.doesNotMatch(content,/Multipliers|Access|12\.50%|Substrate cost|41\.23/);assert.deepEqual(copy(output),original);
  });
  await check('Pending composer Add appends once, disables its action, and shows recalculated feedback in the current item view',async h=>{
    const pending=deferred(),calls=[];h.audit.setRequest(async(path,payload)=>{calls.push(copy(payload));return pending.promise;});
    const adding=h.audit.addToSchedule();await flush();assert.equal(h.byId('penetration-add-to-schedule').disabled,true);await h.audit.addToSchedule();assert.equal(h.api.projectSnapshot().draft.rows.length,1);assert.equal(calls.length,1);
    h.control('T').value='Later composer edit';await h.control('T').emit('input');pending.resolve(result(calls[0].draft));await adding;assert.equal(h.byId('penetration-add-to-schedule').disabled,false);assert.match(h.byId('penetration-message').textContent,/Recalculated item price: \$123\.46/);assert.match(h.byId('penetration-message').textContent,/Later edits to the current item are not included/);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,undefined);
    h.audit.setRequest(async(path,payload)=>result(payload.draft));await h.audit.addToSchedule();assert.equal(h.api.projectSnapshot().draft.rows.length,2);
  });
  await check('A pending receipt cannot report a replacement row as the original item or overwrite a new composer message',async h=>{
    const pending=deferred();let captured;h.audit.setRequest(async(path,payload)=>{captured=copy(payload.draft);return pending.promise;});const adding=h.audit.addToSchedule();await flush();
    h.audit.removeRow('line-1');h.audit.state.schedule.draft.rows.push({id:'line-1',inputs:{T:'Replacement'}});h.audit.state.rowEpochs.set('line-1',++h.audit.state.nextEpoch);h.audit.state.composerEpoch++;h.byId('penetration-message').textContent='New item feedback';
    pending.resolve(result(captured));const receipt=await adding;assert.equal(receipt.total,null);assert.match(receipt.message,/row has since changed/);assert.equal(h.byId('penetration-message').textContent,'New item feedback');
  });
  await check('Pending Update writes once, keeps later composer edits, and does not announce success on a replacement project',async h=>{
    await h.audit.addToSchedule();await h.audit.selectRow('line-1');h.control('T').value='Updated';await h.control('T').emit('input');const pending=deferred();let calls=0,captured;h.audit.setRequest(async(path,payload)=>{calls++;captured=copy(payload.draft);return pending.promise;});const updating=h.audit.updateSchedule();await flush();await h.audit.updateSchedule();assert.equal(calls,1);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Updated');
    h.api.applyProject(await h.api.prepareDefaults());pending.resolve(result(captured));await updating;assert.equal(h.api.projectSnapshot().draft.rows.length,0);assert.doesNotMatch(h.byId('penetration-message').textContent,/updated/);
  });
  await check('A schedule initialization failure reveals its error in the schedule workspace',async h=>{
    h.audit.state.draft=null;h.audit.state.schedule.draft=null;h.pricing.rates.original.price=99;h.audit.setRequest(async()=>{throw new Error('Definition unavailable');});h.byId('penetration-schedule-workspace').hidden=true;await h.api.openSchedule();assert.equal(h.byId('penetration-schedule-workspace').hidden,false);assert.match(h.byId('penetration-schedule-message').textContent,/Definition unavailable/);
  });
  for(const route of ['save','calculate'])await check(`Accepted ${route} normalization keeps a matching schedule Edit target usable`,async h=>{
    h.audit.state.draft.rows[0].inputs.T='';await h.audit.addToSchedule();await h.audit.selectRow('line-1');const captured=h.api.projectSnapshot(),canonical=copy(captured);canonical.draft.rows[0].inputs.T=null;canonical.composer.rows[0].inputs.T=null;
    if(route==='save')h.api.markProjectSaved(canonical,captured);
    else{h.audit.setRequest(async()=>result(canonical.draft));await h.audit.calculateSchedule();}
    assert.equal(h.audit.state.schedule.draft.rows[0].inputs.T,null);assert.equal(h.byId('penetration-update-schedule').disabled,false);
    h.control('T').value='Updated after normalization';await h.control('T').emit('input');h.audit.setRequest(async(path,payload)=>result(payload.draft));await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Updated after normalization');
  });
  for(const route of ['save','calculate'])for(const conflict of ['later edit','removed and restored'])await check(`${route} normalization cannot unlock an Edit target after a ${conflict}`,async h=>{
    h.audit.state.draft.rows[0].inputs.T='';await h.audit.addToSchedule();await h.audit.selectRow('line-1');
    if(conflict==='later edit'){const qty=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];qty.value='3.123456789';await qty.emit('input');}
    else{h.audit.removeRow('line-1');await flush();h.audit.undoRemove();await flush();}
    const captured=h.api.projectSnapshot(),canonical=copy(captured);canonical.draft.rows[0].inputs.T=null;
    if(route==='save')h.api.markProjectSaved(canonical,captured);
    else{h.audit.setRequest(async()=>result(canonical.draft));await h.audit.calculateSchedule();}
    assert.equal(h.byId('penetration-update-schedule').disabled,true);h.control('T').value='Obsolete edited copy';await h.control('T').emit('input');await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,null);if(conflict==='later edit')assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,3.123456789);
  });
  for(const scopeName of ['composer','schedule'])await check(`${scopeName} normalization during Save preserves the snapshot, fingerprint and clean saved state`,async h=>{
    h.audit.state.draft.rows[0].inputs={T:'Item',U:'',O:1.23456789012345};await h.audit.addToSchedule();await h.audit.selectRow('line-1');
    const scope=scopeName==='composer'?h.audit.state:h.audit.state.schedule;scope.draft.globals={L:0,J:'No'};scope.draft.rows[0].inputs={U:'',T:'Item',O:1.23456789012345};
    const captured=h.api.projectSnapshot(),stamp=h.api.projectFingerprint(),pending=deferred();h.audit.setRequest(()=>pending.promise);const calculating=scopeName==='composer'?h.audit.calculate():h.audit.calculateSchedule();await flush();
    const normalized=copy(scope.draft);normalized.globals={M:0,K:null,J:'No',L:0};normalized.rows[0].inputs={O:1.23456789012345,T:'Item',U:null};pending.resolve(result(normalized));await calculating;
    assert.equal(JSON.stringify(h.api.projectSnapshot()),JSON.stringify(captured));assert.equal(h.api.projectFingerprint(),stamp);h.api.markProjectSaved(copy(captured),captured);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.byId('penetration-update-schedule').disabled,false);assert.equal(h.api.projectSnapshot()[scopeName==='composer'?'composer':'draft'].rows[0].inputs.O,1.23456789012345);
  });
  for(const scopeName of ['composer','schedule'])await check(`${scopeName} genuine later changes remain dirty despite an earlier canonical save receipt`,async h=>{
    h.audit.state.draft.rows[0].inputs={U:'',O:0};await h.audit.addToSchedule();const captured=h.api.projectSnapshot(),stamp=h.api.projectFingerprint();
    const scope=scopeName==='composer'?h.audit.state:h.audit.state.schedule;scope.draft.rows[0].inputs.U=' ';scope.draft.rows[0].inputs.O=.00000000000001;h.audit.changed('line-1',scope);assert.notEqual(h.api.projectFingerprint(),stamp);h.api.markProjectSaved(copy(captured),captured);
    assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(scope.draft.rows[0].inputs.U,' ');assert.equal(scope.draft.rows[0].inputs.O,.00000000000001);assert.equal(captured[scopeName==='composer'?'composer':'draft'].rows[0].inputs.O,0);
  });
  await check('Canonical fingerprints retain invalid raw text and transient project/composer/edit identities',async h=>{
    await h.audit.addToSchedule();const original=h.api.projectFingerprint();h.audit.state.invalid.set('["line-1","O"]',{value:'1e-',error:'Invalid'});const invalid=h.api.projectFingerprint();assert.notEqual(invalid,original);h.audit.state.invalid.get('["line-1","O"]').value='1e+';assert.notEqual(h.api.projectFingerprint(),invalid);h.audit.state.invalid.clear();
    assert.equal(h.api.projectFingerprint(),original);await h.audit.selectRow('line-1');const edited=h.api.projectFingerprint();assert.notEqual(edited,original);h.audit.state.composerEpoch++;assert.notEqual(h.api.projectFingerprint(),edited);const beforeContext=h.api.projectFingerprint();h.audit.state.context++;assert.notEqual(h.api.projectFingerprint(),beforeContext);
  });
  await check('Canonical snapshots preserve row order, literal whitespace, nulls and zero independently',async h=>{
    h.audit.state.draft.rows[0].inputs={U:' ',O:0,T:''};await h.audit.addToSchedule();await h.audit.addToSchedule();const captured=h.api.projectSnapshot(),stamp=h.api.projectFingerprint();assert.equal(captured.composer.rows[0].inputs.U,' ');assert.equal(captured.composer.rows[0].inputs.O,0);assert.equal(captured.composer.rows[0].inputs.T,null);
    h.audit.state.schedule.draft.rows.reverse();assert.notEqual(h.api.projectFingerprint(),stamp);assert.notEqual(h.api.projectSnapshot().draft.rows[0].id,captured.draft.rows[0].id);
  });
  await check('Repeated library Add retains one row and increments quantity using current schedule prices',async h=>{
    let reads=0;const item={library_id:'FL-ID-002',definition:definition(),draft:{globals:{L:.9},rows:[{id:'source',inputs:{T:'Library pipe',O:8,AC:.5}}]}};
    h.audit.state.schedule.draft.globals.L=.17;
    h.audit.setRequest(async(path,payload)=>{if(path.endsWith('/edit')){reads++;return copy(item);}const response=result(payload.draft);response.rows[0].outputs.H=payload.draft.rows[0].inputs.O*10;return response;});
    assert.equal(h.api.libraryQuantity('pkb-002'),undefined);
    for(let qty=1;qty<=4;qty++){const receipt=await h.api.addLibraryItem('pkb-002');assert.equal(receipt.quantity,qty);assert.equal(receipt.total,qty*10);assert.equal(h.api.libraryQuantity('pkb-002'),qty);assert.equal(h.api.projectSnapshot().draft.rows.length,1);}
    const thumbnail=h.byId('penetration-schedule-body').children[0].children[8].children[0];assert.equal(thumbnail.tagName,'img');assert.equal(thumbnail.src,'/api/libraries/penetration/pkb-002/thumbnail');assert.match(thumbnail.alt,/Library pipe source diagram/);
    h.api.libraryDiagramChanged('pkb-002');const refreshed=h.byId('penetration-schedule-body').children[0].children[8].children[0];assert.notEqual(refreshed,thumbnail);assert.equal(refreshed.src,'/api/libraries/penetration/pkb-002/thumbnail?v=1');
    assert.equal(reads,1);assert.equal(item.draft.rows[0].inputs.O,8);assert.equal(h.api.projectSnapshot().draft.globals.L,.17);assert.equal(h.api.projectSnapshot().draft.rows[0].library_item_id,'pkb-002');
  });
  await check('Library identity survives calculate, Save and Open; Add preserves edited row inputs and the composer',async h=>{
    h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:{...definition().defaults,rows:[{id:'source',inputs:{T:'Original',O:1}}]}}:result(payload.draft));
    await h.api.addLibraryItem('pkb-002');await h.audit.selectRow('line-1');h.control('T').value='Edited schedule item';await h.control('T').emit('input');await h.audit.updateSchedule();
    const snapshot=h.api.projectSnapshot();h.api.markProjectSaved(copy(snapshot),snapshot);assert.equal(h.api.hasUnsavedChanges(),false);h.api.applyProject(await h.api.prepareProject(copy(snapshot)));assert.equal(h.api.libraryQuantity('pkb-002'),1);
    const composer=copy(h.api.projectSnapshot().composer);await h.api.addLibraryItem('pkb-002');const row=h.api.projectSnapshot().draft.rows[0];assert.equal(row.inputs.T,'Edited schedule item');assert.equal(row.inputs.O,2);assert.equal(row.library_item_id,'pkb-002');assert.deepEqual(copy(h.api.projectSnapshot().composer),composer);
  });
  await check('Quantity notifications follow precise manual edits, invalid text, zero, remove, Undo and project replacement',async h=>{
    let notifications=0;h.context.window.CeasefireLibraries={scheduleChanged(){notifications++;}};
    h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:definition().defaults}:result(payload.draft));await h.api.addLibraryItem('pkb-002');
    const quantity=h.byId('penetration-schedule-body').children[0].children[5].querySelectorAll('[data-penetration-field]')[0];quantity.value='2.1234567890123';await quantity.emit('input');assert.equal(h.api.libraryQuantity('pkb-002'),2.1234567890123);await h.api.addLibraryItem('pkb-002');assert.equal(h.api.libraryQuantity('pkb-002'),3.1234567890123);
    quantity.value='1e-';await quantity.emit('input');assert.equal(h.api.libraryQuantity('pkb-002'),null);await assert.rejects(h.api.addLibraryItem('pkb-002'),/marked invalid/);
    quantity.value='0';await quantity.emit('input');assert.equal(h.api.libraryQuantity('pkb-002'),0);h.audit.removeRow('line-1');assert.equal(h.api.libraryQuantity('pkb-002'),undefined);h.audit.undoRemove();assert.equal(h.api.libraryQuantity('pkb-002'),0);
    h.api.applyProject(await h.api.prepareDefaults());assert.equal(h.api.libraryQuantity('pkb-002'),undefined);assert.ok(notifications>=7);
  });
  await check('Legacy Add adopts one exact row and preserves all other rows and fixed per-row charges',async h=>{
    const snapshot={draft:{...definition().schedule_defaults,rows:[{id:'a',inputs:{T:'Pipe',U:'',O:1.5}},{id:'b',inputs:{T:'Pipe',U:null,O:2.25}},{id:'c',inputs:{T:'Different',O:5}},{id:'d',inputs:{T:'Pipe',O:4},library_item_id:'other-id'}]}};
    h.api.applyProject(await h.api.prepareProject(snapshot));h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:{...definition().defaults,rows:[{id:'source',inputs:{T:'Pipe',O:9}}]}}:result(payload.draft));
    assert.equal(h.api.projectSnapshot().draft.rows.length,4);await h.api.addLibraryItem('pkb-002');const rows=h.api.projectSnapshot().draft.rows;assert.equal(rows.length,4);assert.equal(rows[0].id,'a');assert.equal(rows[0].inputs.O,2.5);assert.equal(rows[0].library_item_id,'pkb-002');assert.deepEqual(copy(rows.slice(1)),snapshot.draft.rows.slice(1));
    const fixed={draft:{...definition().schedule_defaults,rows:[{id:'a',inputs:{T:'Fixed',O:1,AJ:25}},{id:'b',inputs:{T:'Fixed',O:1,AJ:25}}]}};h.api.applyProject(await h.api.prepareProject(fixed));h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:{...definition().defaults,rows:[{id:'source',inputs:{T:'Fixed',O:1,AJ:25}}]}}:result(payload.draft));await h.api.addLibraryItem('pkb-002');assert.equal(h.api.projectSnapshot().draft.rows.length,2);assert.equal(h.api.projectSnapshot().draft.rows.reduce((sum,row)=>sum+row.inputs.AJ,0),50);assert.equal(h.api.libraryQuantity('pkb-002'),2);
  });
  await check('Removed library items cannot be restored by a late receipt or mistaken for a reused row ID',async h=>{
    const pending=deferred();h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:definition().defaults}:result(payload.draft));await h.api.addLibraryItem('pkb-002');
    h.audit.setRequest(()=>pending.promise);const adding=h.api.addLibraryItem('pkb-002');await flush();h.audit.removeRow('line-1');const replacement=h.audit.addToSchedule();assert.equal(h.api.libraryQuantity('pkb-002'),undefined);pending.resolve(result(h.api.projectSnapshot().draft));await Promise.all([adding,replacement]);assert.equal(h.api.libraryQuantity('pkb-002'),undefined);
  });
  await check('Library quantity bounds and metadata validation reject changes without losing current rows',async h=>{
    const draft={...definition().schedule_defaults,rows:[{id:'line-1',inputs:{O:1e12},library_item_id:'pkb-002'}]};h.api.applyProject(await h.api.prepareProject({draft}));await assert.rejects(h.api.addLibraryItem('pkb-002'),/supported range/);assert.equal(h.api.libraryQuantity('pkb-002'),1e12);
    await assert.rejects(h.api.prepareProject({draft:{...draft,rows:[...draft.rows,{...draft.rows[0],id:'other'}]}}),/repeated library/);await assert.rejects(h.api.addLibraryItem('../invalid'),/invalid/);
  });
  for(const [raw,label] of [['FIREFLY','Firefly'],['TRAFALGAR','Trafalgar']])await check(`Known manufacturer ${raw} has one clean label and preserves its stored value`,async h=>{
    h.audit.state.definition.row_fields.push({column:'V',label:'Manufacturer',type:'select',group:'Penetration',format:'text',options:['Firefly','Trafalgar','Promat']});h.audit.state.draft.rows[0].inputs.V=raw;h.audit.renderFields();const control=h.control('V');assert.equal(control.value,raw);assert.equal(control.children.filter(option=>option.textContent===label).length,1);assert.equal(control.children.find(option=>option.value===raw).textContent,label);await control.emit('change');assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);assert.equal(h.api.inputProblem(),'');
  });
  await check('Adding an open library edit preserves its copy and prevents Update from overwriting the new quantity',async h=>{
    h.audit.setRequest(async(path,payload)=>path.endsWith('/edit')?{library_id:'FL-ID-002',definition:definition(),draft:{...definition().defaults,rows:[{id:'source',inputs:{T:'Original',O:1}}]}}:result(payload.draft));await h.api.addLibraryItem('pkb-002');await h.audit.selectRow('line-1');h.control('T').value='Unsaved edit';await h.control('T').emit('input');await h.api.addLibraryItem('pkb-002');assert.equal(h.control('T').value,'Unsaved edit');assert.equal(h.api.libraryQuantity('pkb-002'),2);assert.equal(h.byId('penetration-update-schedule').disabled,true);await h.audit.updateSchedule();assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.T,'Original');assert.equal(h.api.libraryQuantity('pkb-002'),2);await h.audit.cancelEdit();await h.audit.selectRow('line-1');assert.equal(h.control('O').value,'2.00');
  });
  await check('Prototype-key and ordinary unknown manufacturers remain disabled saved values without mapping or mutation',async h=>{
    const metadata=definition();metadata.row_fields.push({column:'V',label:'Manufacturer',type:'select',group:'Penetration',format:'text',options:['Firefly','Trafalgar'],default:null});
    for(const raw of ['constructor','toString','__proto__','Unlisted supplier']){
      h.audit.state.definition=copy(metadata);h.audit.state.draft.rows[0].inputs.V=raw;const before=h.api.projectFingerprint();h.audit.renderFields();const control=h.control('V'),saved=control.children.find(option=>option.value===raw);
      assert.equal(control.value,raw);assert.equal(saved.textContent,`Saved value: ${raw} (choose a listed value)`);assert.equal(saved.disabled,true);assert.equal(h.api.projectFingerprint(),before);assert.deepEqual(copy(h.audit.state.definition.row_fields.at(-1).options),['Firefly','Trafalgar']);
      h.control('T').value='Unrelated edit';await h.control('T').emit('input');let captured;h.audit.setRequest(async(path,payload)=>{captured=copy(payload.draft);return result(payload.draft,metadata);});await h.audit.calculate();assert.equal(captured.rows[0].inputs.V,raw);assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.V,raw);
      control.value=raw;await control.emit('change');assert.match(h.api.inputProblem(),/invalid/);assert.equal(h.audit.state.draft.rows[0].inputs.V,raw);control.value='Firefly';await control.emit('change');assert.equal(h.api.inputProblem(),'');assert.equal(h.audit.state.draft.rows[0].inputs.V,'Firefly');
    }
  });
  console.log(`${passed} penetration UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
