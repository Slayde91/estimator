"use strict";
const assert=require("node:assert/strict");
const {copy,harness}=require("./helpers/penetration_ui.cjs");
let passed=0;
async function test(name,fn){const h=harness();h.api.applyProject(await h.api.prepareDefaults());await fn(h);++passed;console.log(`ok - ${name}`);}
(async()=>{
  const links=require('../static/takeoff-library-links.js');
  async function picker(answers,context={}){
    const calls=[],original=global.fetch,library={id:'chosen',library_id:'L-1',title:'Selected item',metadata_sha256:'a'.repeat(64),import_fields:{defect:{frl:'-/120/120'},barrier:{substrate:'Concrete'},service:null}};
    global.fetch=async()=>({ok:true,json:async()=>copy(library)});
    try{const result=await links.choose({ask:async(title,fields,message,submit)=>{calls.push({title,fields,message,submit});return answers.shift();}},true,context);return {result,calls,library};}finally{global.fetch=original;}
  }
  await test('selected blank seal asks missing Location and draft schedule quantity without mutating library metadata',async()=>{
    const value=await picker([{library_id:'chosen'},{location:'L02 north',quantity:'2.123456789012'}]);
    assert.equal(value.calls[1].title,'Complete selected item details');assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Location','Item QTY']);
    assert.deepEqual(value.result.details,{draft_quantity:2.123456789012,draft_location:'L02 north'});assert.deepEqual(value.result.record,value.library);assert.equal(value.result.record.import_fields.service,null);
    assert.match(value.calls[1].message,/schedule changes only after you review and confirm/i);
  });
  await test('known physical Location is retained and only missing Item QTY is requested',async()=>{
    const value=await picker([{library_id:'chosen'},{quantity:7.123456789}],{location:'Retained barrier location'});
    assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Item QTY']);assert.equal(value.result.details.draft_location,'Retained barrier location');assert.equal(value.result.details.draft_quantity,7.123456789);
  });
  await test('whitespace-only retained Location accepts the explicitly entered missing value',async()=>{
    const value=await picker([{library_id:'chosen'},{location:'L04 south',quantity:1}],{location:'   '});
    assert.deepEqual(value.calls[1].fields.map(field=>field[1]),['Location','Item QTY']);assert.equal(value.result.details.draft_location,'L04 south');
  });
  await test('Cancel at unknown item details yields no import or draft association',async()=>{
    const value=await picker([{library_id:'chosen'},null]);assert.equal(value.result,null);assert.equal(value.calls.length,2);
  });
  await test('invalid entered quantity cannot become a retained item or inferred count',async()=>{
    for(const quantity of [0,-1,'',null,Infinity,1e13])await assert.rejects(picker([{library_id:'chosen'},{location:'Fixture',quantity}]),/positive finite Item QTY/);
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
