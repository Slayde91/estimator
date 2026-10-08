"use strict";
const assert=require("node:assert/strict");
const {copy,harness}=require("./helpers/penetration_ui.cjs");
let passed=0;
async function test(name,fn){const h=harness();h.api.applyProject(await h.api.prepareDefaults());await fn(h);++passed;console.log(`ok - ${name}`);}
(async()=>{
  const links=require('../static/takeoff-library-links.js');
  await test('New/Search Item chooser uses the workspace title and New Item needs no library or quantity mutation',async()=>{
    for(const context of [{},{title:'Add Service Plan Item'}]){
      const calls=[],choice=await links.choose({ask:async(title,fields,message)=>{calls.push({title,fields,message});return {action:'new'};}},false,context);
      assert.deepEqual(choice,{kind:'new'});assert.equal(calls.length,1);assert.equal(calls[0].title,context.title||'Add Defect');assert.deepEqual(calls[0].fields[0][2],[['search','Search Item'],['new','New Item']]);assert.match(calls[0].message,/Neither action changes the Firestopping Schedule/);
    }
  });
  async function picker(answers,context={},service=null){
    const calls=[],original=global.fetch,library={id:'chosen',library_id:'L-1',title:'Selected item',metadata_sha256:'a'.repeat(64),import_fields:{defect:{frl:'-/120/120'},barrier:{substrate:'Concrete'},service}};
    global.fetch=async()=>({ok:true,json:async()=>copy(library)});
    try{const result=await links.choose({ask:async(title,fields,message,submit,setup)=>{const controls=fields.map(field=>({control:{name:field[0]}}));if(title==='Complete selected item details')setup(controls);calls.push({title,fields,message,submit,controls});return answers.shift();}},true,context);return {result,calls,library};}finally{global.fetch=original;}
  }
  await test('selected blank seal asks missing Location and explicit integer seal count without mutating library metadata',async()=>{
    const value=await picker([{library_id:'chosen'},{location:'L02 north',quantity:'2'}]);
    assert.equal(value.calls[1].title,'Complete selected item details');assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Location','Item QTY']);
    assert.deepEqual(value.result.details,{item_quantity:2,draft_quantity:2,draft_location:'L02 north'});assert.deepEqual(value.result.record,value.library);assert.equal(value.result.record.import_fields.service,null);
    assert.match(value.calls[1].message,/blank seal count/);const control=value.calls[1].controls.find(field=>field.control.name==='quantity').control;assert.equal(control.min,'1');assert.equal(control.step,'1');
    assert.match(value.calls[1].message,/Confirm the physical records before transferring/i);
  });
  await test('known physical Location is retained and only missing Item QTY is requested',async()=>{
    const value=await picker([{library_id:'chosen'},{quantity:7}],{location:'Retained barrier location'});
    assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Item QTY']);assert.equal(value.result.details.draft_location,'Retained barrier location');assert.equal(value.result.details.draft_quantity,7);assert.equal(value.result.details.item_quantity,7);
  });
  await test('whitespace-only retained Location accepts the explicitly entered missing value',async()=>{
    const value=await picker([{library_id:'chosen'},{location:'L04 south',quantity:1}],{location:'   '});
    assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Location','Item QTY']);assert.equal(value.result.details.draft_location,'L04 south');
  });
  await test('Cancel at unknown item details yields no import or draft association',async()=>{
    const value=await picker([{library_id:'chosen'},null]);assert.equal(value.result,null);assert.equal(value.calls.length,2);
  });
  await test('invalid entered quantity cannot become a retained item or inferred count',async()=>{
    for(const service of [null,{service_type:'Copper pipe'}])for(const quantity of [0,-1,'',null,Infinity,1e13,1.5,'2.123456789012','999999999999.999999999999','1e-1000','0x2',true,[],{}])await assert.rejects(picker([{library_id:'chosen'},{location:'Fixture',quantity}],{},service),/positive integer Item QTY/);
  });
  await test('service Item QTY is an explicit count with integer controls and unchanged size precision',async()=>{
    const service={service_type:'Copper pipe',diameter_mm:25.123456789012},value=await picker([{library_id:'chosen'},{location:'L03',quantity:'700'}],{},service);
    assert.deepEqual(value.result.details,{item_quantity:700,draft_quantity:700,draft_location:'L03'});assert.deepEqual(value.result.record.import_fields.service,service);
    assert.match(value.calls[1].message,/physical service count/);const control=value.calls[1].controls.find(field=>field.control.name==='quantity').control;assert.equal(control.step,'1');assert.equal(control.max,'1000000000000');
    for(const quantity of ['1000000000000',1000000000000,'1.0']){const boundary=await picker([{library_id:'chosen'},{location:'L03',quantity}],{},service);assert.equal(boundary.result.details.item_quantity,Number(quantity));}
  });
  await test('assignment proposals distinguish physical services and explicit blank seals without migrating legacy calls',async()=>{
    const service={id:'chosen',metadata_sha256:'a'.repeat(64),import_fields:{service:{service_type:'Copper pipe'}}},blank={...service,import_fields:{service:null}},details={item_quantity:700,draft_quantity:700,draft_location:'L03'};
    const a=links.assignment('defect_reports',service,['service-1'],null,details),b=links.assignment('defect_reports',blank,['barrier-1'],null,details);
    assert.deepEqual(a.quantity_source,{version:1,kind:'services'});assert.deepEqual(b.quantity_source,{version:1,kind:'blank_seals',quantity:700});for(const value of [a,b]){assert.ok(!Object.hasOwn(value,'item_quantity'));assert.equal(value.draft_quantity,700);assert.equal(value.draft_location,'L03');}
    const legacy=links.assignment('defect_reports',service,['service-1'],null,{draft_quantity:1.123456789});assert.ok(!Object.hasOwn(legacy,'quantity_source'));assert.equal(legacy.draft_quantity,1.123456789);assert.deepEqual(details,{item_quantity:700,draft_quantity:700,draft_location:'L03'});
    assert.throws(()=>links.assignment('defect_reports',service,['service-1'],null,{item_quantity:1.5}),/positive integer/);
  });
  async function importPicker({servicePlans=true,existing=false,service={service_type:'Copper pipe'},decisions=[true],stale=false}={}){
    const original=global.fetch,calls=[],commands=[],confirmed=[],owner={id:'root-barrier',display_id:'B-0001',revision:7,fields:{location:'Observed level',barrier_type:'Oversized',substrate:'Brick',orientation:'Horizontal'}},
      defect={id:'root-defect',display_id:'D-0001',revision:3,fields:{location:'Defect level'}},library={id:'chosen',library_id:'L-1',metadata_sha256:'a'.repeat(64),import_fields:{defect:{frl:'-/120/120',location:'Literal library level'},barrier:{barrier_type:'Core Hole',substrate:'Concrete',orientation:'Vertical'},service}},
      context={scope:servicePlans?'service_plans':'defect_reports',...(servicePlans?{barrier:owner}:{defect}),selectedIds:['selected-service'],barriers:[owner]},before=copy(context);
    const answers=[{choice:existing?'existing':'new'},...(existing?[{barrier_id:owner.id}]:[]),{library_id:'chosen'},{quantity:'700'},...(decisions[0]===false?[{library_id:'chosen'},{quantity:'700'}]:[])];
    let guardCalls=0;
    global.fetch=async()=>({ok:true,json:async()=>copy(library)});
    try{
      const bridge={ask:async(title,fields,message)=>{calls.push({title,fields,message});return answers.shift();},confirm:async(title,message)=>{confirmed.push({title,message});return decisions.shift();},libraryCommand:async(op,payload)=>{commands.push({op,payload});return {snapshot:'retained'};}};
      const invoke=()=>links[servicePlans?'addUnderServicePlans':'addUnderDefect'](bridge,context,()=>{if(stale&&++guardCalls>1)throw new Error('Context changed');});
      if(stale){await assert.rejects(invoke(),/Context changed/);assert.equal(commands.length,0);return;}
      const result=await invoke();assert.deepEqual(context,before);assert.equal(commands.length,1);return {calls,commands,confirmed,result,owner,defect,library};
    }finally{global.fetch=original;}
  }
  await test('Service Plans New Barrier import pins root context and explains unplaced literal adoption without a Defect identity',async()=>{
    const value=await importPicker(),proposal=value.commands[0].payload.import;
    assert.equal(value.commands[0].op,'import_library_item');assert.equal(proposal.scope,'service_plans');assert.equal(proposal.context_barrier_id,value.owner.id);assert.equal(proposal.context_barrier_revision,7);
    assert.ok(!Object.hasOwn(proposal,'defect_id'));assert.equal(proposal.barrier_id,null);assert.equal(proposal.barrier_revision,null);assert.ok(proposal.ids.barrier);assert.ok(proposal.ids.service);
    assert.equal(proposal.item_quantity,700);assert.equal(proposal.draft_location,'Literal library level');assert.deepEqual(proposal.selected_ids,['selected-service']);
    assert.match(value.calls[0].message,/new unplaced root/);assert.match(value.calls[0].message,/copies no marker or source/);assert.equal(value.result.selected_id,proposal.ids.service);
  });
  await test('Service Plans Existing Barrier retains context and explicitly reviews mismatch; cancel returns to search without commands',async()=>{
    const value=await importPicker({existing:true,decisions:[false,true]}),proposal=value.commands[0].payload.import;
    assert.equal(proposal.barrier_id,value.owner.id);assert.equal(proposal.barrier_revision,7);assert.equal(proposal.ids.barrier,null);assert.equal(proposal.accept_mismatch,true);assert.equal(proposal.draft_location,'Observed level');
    assert.equal(value.confirmed.length,2);assert.equal(value.calls.filter(call=>call.title==='Search Firestopping Library').length,2);
    assert.match(value.confirmed[0].message,/Existing Barrier = Brick; selected library = Concrete/);assert.match(value.confirmed[0].message,/source location unchanged/);
  });
  await test('Service Plans Blank Seal import creates no new Service and stale owner stops before command',async()=>{
    const value=await importPicker({existing:true,service:null}),proposal=value.commands[0].payload.import;
    assert.equal(proposal.ids.service,null);assert.equal(value.result.selected_id,value.owner.id);assert.equal(proposal.item_quantity,700);
    await importPicker({stale:true});
    assert.throws(()=>links.addUnderServicePlans({}, {scope:'defect_reports'}),/Service Plans Barrier/);
  });
  await test('Defect Reports import retains historical Defect proposal and source-adoption explanation',async()=>{
    const value=await importPicker({servicePlans:false}),proposal=value.commands[0].payload.import;
    assert.equal(proposal.scope,'defect_reports');assert.equal(proposal.defect_id,value.defect.id);assert.equal(proposal.defect_revision,3);assert.ok(!Object.hasOwn(proposal,'context_barrier_id'));
    assert.equal(proposal.draft_location,'Defect level');assert.match(value.calls[0].message,/under D-0001/);
  });
  await test("commercial destination capture retains composer, manual values and frozen pricing",async h=>{
    h.audit.state.schedule.draft.rows.push({id:"line-1",library_item_id:"chosen",inputs:{O:7.123456789,T:"Manual description",J:"HVAC",W:"Installer"}});
    const before=copy(h.api.projectSnapshot()),capture=await h.api.captureTakeoffSchedule();
    assert.deepEqual(copy(capture.draft),before.draft);assert.deepEqual(copy(capture.configuration),h.pricing);assert.equal(capture.source_sha256,"penetration-source");
    assert.deepEqual(copy(h.api.projectSnapshot()),before);assert.equal(h.api.hasTakeoffReservation(),false);
  });
  await test("reservation gates project replacement, save capture, schedule and composer mutations",async h=>{
    const capture=await h.api.captureTakeoffSchedule(),before=copy(h.api.projectSnapshot()),lease=h.api.reserveTakeoffSchedule(capture);
    assert.equal(h.api.hasTakeoffReservation(),true);assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.api.hasUnfinishedChanges(),true);
    assert.throws(()=>h.api.applyProject({}),/still applying/);assert.throws(()=>h.api.markProjectSaved(before,before),/still applying/);
    await assert.rejects(h.api.completeProjectSnapshot(),/still applying/);await assert.rejects(h.api.openSchedule(),/still applying/);await assert.rejects(h.audit.addRow(),/still applying/);
    await assert.rejects(h.api.pricingChanged(),/still applying/);assert.throws(()=>h.audit.removeRow("line-1"),/still applying/);
    const control=h.control("T");assert.equal(control.disabled,true);control.value="Blocked replacement";await control.emit("input");
    assert.deepEqual(copy(h.api.projectSnapshot()),before);h.api.validateTakeoffScheduleReservation(lease);h.api.releaseTakeoffSchedule(lease);assert.equal(h.api.hasTakeoffReservation(),false);
  });
  await test("reserve rejects changes during human review and retains exact destination",async h=>{
    const capture=await h.api.captureTakeoffSchedule();h.audit.state.schedule.draft.rows.push({id:"manual",inputs:{O:.3,T:"After review"}});
    assert.throws(()=>h.api.reserveTakeoffSchedule(capture),/changed during link review/);assert.equal(h.api.hasTakeoffReservation(),false);
    const fresh=await h.api.captureTakeoffSchedule();h.pricing.rates.original.price=2;assert.throws(()=>h.api.reserveTakeoffSchedule(fresh),/frozen prices changed/);
  });
  await test("validated response installs once and exact retry preserves composer and quantities",async h=>{
    const composer=copy(h.api.projectSnapshot().composer),capture=await h.api.captureTakeoffSchedule(),lease=h.api.reserveTakeoffSchedule(capture);
    const reply={draft:copy(capture.draft),source_sha256:capture.source_sha256};reply.draft.rows.push({id:"line-1",library_item_id:"chosen",inputs:{O:2.123456789,J:"HVAC",T:"Confirmed selected item"}});
    h.api.applyTakeoffSchedule(reply,lease);h.api.applyTakeoffSchedule(copy(reply),lease);
    assert.deepEqual(copy(h.api.projectSnapshot().composer),composer);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,2.123456789);assert.equal(h.api.hasTakeoffReservation(),true);
    const changed=copy(reply);changed.draft.rows[0].inputs.O=3;assert.throws(()=>h.api.applyTakeoffSchedule(changed,lease),/different commercial destination/);
    h.api.releaseTakeoffSchedule(lease);assert.equal(h.api.hasPendingOperation(),false);
  });
  await test("invalid and wrong-source replies keep lease and original schedule recoverable",async h=>{
    const capture=await h.api.captureTakeoffSchedule(),lease=h.api.reserveTakeoffSchedule(capture);
    assert.throws(()=>h.api.applyTakeoffSchedule({draft:capture.draft,source_sha256:"wrong"},lease),/different Firestopping source/);
    assert.throws(()=>h.api.applyTakeoffSchedule({draft:{globals:{},rows:[{id:"bad"}]},source_sha256:capture.source_sha256},lease),/invalid or repeated row/);
    assert.deepEqual(copy(h.api.projectSnapshot().draft),copy(capture.draft));assert.equal(h.api.hasTakeoffReservation(),true);h.api.releaseTakeoffSchedule(lease);
  });
  await test("display exception during reserve rolls back the unreturned lease and controls",async h=>{
    const capture=await h.api.captureTakeoffSchedule(),before=copy(h.api.projectSnapshot()),changed=h.context.window.CeasefireProject.changed;
    h.context.window.CeasefireProject.changed=()=>{throw new Error("display interrupted");};assert.throws(()=>h.api.reserveTakeoffSchedule(capture),/display interrupted/);
    assert.equal(h.api.hasTakeoffReservation(),false);assert.equal(h.api.hasPendingOperation(),false);assert.deepEqual(copy(h.api.projectSnapshot()),before);assert.equal(!!h.control("T").disabled,false);
    h.context.window.CeasefireProject.changed=changed;h.api.releaseTakeoffSchedule(h.api.reserveTakeoffSchedule(await h.api.captureTakeoffSchedule()));
  });
  await test("committed destination display and release can be retried without lost or doubled quantity",async h=>{
    const capture=await h.api.captureTakeoffSchedule(),lease=h.api.reserveTakeoffSchedule(capture),reply={draft:copy(capture.draft),source_sha256:capture.source_sha256},changed=h.context.window.CeasefireProject.changed;
    reply.draft.rows.push({id:"line-1",library_item_id:"chosen",inputs:{O:1.123456789}});h.context.window.CeasefireProject.changed=()=>{throw new Error("display interrupted");};
    assert.throws(()=>h.api.applyTakeoffSchedule(reply,lease),/display interrupted/);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,1.123456789);assert.equal(h.api.hasTakeoffReservation(),true);
    h.context.window.CeasefireProject.changed=changed;h.api.applyTakeoffSchedule(reply,lease);h.context.window.CeasefireProject.changed=()=>{throw new Error("display interrupted");};assert.throws(()=>h.api.releaseTakeoffSchedule(lease),/display interrupted/);
    assert.equal(h.api.hasTakeoffReservation(),false);h.context.window.CeasefireProject.changed=changed;h.api.releaseTakeoffSchedule(lease);h.api.releaseTakeoffSchedule(lease);assert.equal(h.api.projectSnapshot().draft.rows[0].inputs.O,1.123456789);
  });
  await test("linked row editing checks exact retained library identity before replacing the composer",async h=>{
    h.audit.state.schedule.draft.rows.push({id:"line-1",library_item_id:"chosen",inputs:{O:2,T:"Bound row"}});const composer=copy(h.api.projectSnapshot().composer);
    await assert.rejects(h.api.editScheduleRow("line-1","other"),/removed or replaced/);assert.deepEqual(copy(h.api.projectSnapshot().composer),composer);
    await h.api.editScheduleRow("line-1","chosen");assert.equal(h.audit.state.edit.id,"line-1");assert.equal(h.api.projectSnapshot().composer.rows[0].inputs.T,"Bound row");
  });
  console.log(`${passed} Takeoff library destination lease contracts passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
