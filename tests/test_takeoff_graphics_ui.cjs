"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = path.resolve(__dirname, "../static/takeoff-graphics-ui.js");
const code = fs.readFileSync(source, "utf8");

// Only the bridge runs: fonts are controlled promises and the host contains no
// network, browser, storage, calculator, or persisted Takeoff implementation.
function fixture(initial = {}, commandOverride) {
  const fonts = [], calls = { cancel: 0, render: 0, command: 0, messages: [] };
  const state = { active: true, busy: false, modal: false, navigationBusy: false,
    viewport: { transform: [1,0,0,-1,0,800] }, document: "document-A", page: 1, mode: "wall", physicalScope: "defect_reports",
    tool: "select", points: [], selected: new Set(), countSelection: new Set(), physicalSelected: new Set(),
    annotationSelected: null, signatureSelected: null, graphicSelected: null, legendSelected: null,
    formDirty: false, settingsDirty: false, settingsOpen: false, settingsEditor: null,
    physicalPlacing: false, gesture: null, pendingViewport: null,
    session: { session_id: "session-A", revision: 7 }, ...initial };
  const originals = [{id:"document-A",sha256:"a".repeat(64)}, {id:"document-B",sha256:"b".repeat(64)}];
  const snapshot = { graphics: { version:1, records:[] }, items:[], calibrations:[], transfers:[] };
  const document = { fonts: { load() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); fonts.push({promise,resolve,reject}); return promise; } },
    createElement(tag) { assert.equal(tag,"canvas"); return { getContext() { return {}; } }; } };
  const context = { window: {CeasefireTakeoffAnnotations:{text:value=>value.blocks.map(block=>block.runs.map(run=>run.text).join("")).join("\n")}}, document, setTimeout, clearTimeout }; vm.createContext(context); vm.runInContext(code, context, {filename:source});
  const host = { state, X: { kinds:["rectangle","circle"], boxes:new Set(["rectangle","circle"]), labels:{rectangle:"Rectangle",circle:"Circle"} },
    snapshot:()=>snapshot, documents:()=>originals, currentDocument:()=>originals.find(v=>v.id===state.document),
    pageDisplayKey:()=>JSON.stringify([state.session?.session_id,state.document,state.page,state.mode]),
    signatureMode:()=>state.mode==="physical"?state.physicalScope:state.mode,
    signatureInWorkspace:value=>value.mode===(state.mode==="physical"?state.physicalScope:state.mode),
    selectedSignature:()=>null, selectedAnnotation:()=>null,
    flushSettings:async()=>{}, requireFinishedEdits() {
      if(state.formDirty||state.settingsDirty||state.gesture||state.points.length||state.pendingViewport||state.physicalPlacing||state.physicalUI?.hasUnfinishedChanges()) throw new Error("Finish the newer edit first.");
    }, cancelTrace() { calls.cancel++; state.points=[]; state.tool="select"; },
    setTool(tool) { if(state.busy||state.modal||state.navigationBusy) throw new Error("Finish the current operation first."); state.tool=tool; },
    command(...args) { calls.command++; if(commandOverride) return commandOverride(...args); throw new Error("Activation must not issue a persisted command."); },
    renderSelection() { calls.render++; }, message(value) { calls.messages.push(value); } };
  const ui = context.window.CeasefireTakeoffGraphicsUI(host);
  async function start(kind="rectangle") {
    const before = fonts.length, pending = ui.activate(kind); pending.catch(()=>{});
    for(let attempt=0;attempt<12&&fonts.length<before+2;attempt++) await Promise.resolve();
    assert.equal(fonts.length,before+2,"Activation reaches both delayed drawing-font loads");
    return { pending, complete() { fonts.slice(before,before+2).forEach(value=>value.resolve([])); }, fail() { fonts[before].reject(new Error("Drawing font unavailable")); fonts[before+1].resolve([]); } };
  }
  return {state,calls,snapshot,start,ui};
}

test("Unchanged graphic activation waits for fonts and only arms a drawing tool", async()=>{
  const f=fixture(), unchanged=structuredClone(f.snapshot), activation=await f.start();
  assert.equal(f.state.tool,"select"); assert.equal(f.calls.cancel,0);
  activation.complete(); await activation.pending;
  assert.equal(f.state.tool,"graphic-rectangle"); assert.equal(f.calls.cancel,1); assert.equal(f.calls.render,1);
  assert.equal(f.calls.command,0); assert.deepEqual(f.snapshot,unchanged);
});

const transitions = [
  ["source PDF", state=>state.document="document-B"],
  ["page", state=>state.page=2],
  ["workspace", state=>state.mode="duct"],
  ["session", state=>state.session={session_id:"session-B",revision:7}],
  ["session revision", state=>state.session.revision++],
  ["drawing tool", state=>state.tool="pan"],
  ["measured selection", state=>state.selected.add("retained-item")],
  ["free Call-out selection", state=>state.annotationSelected="retained-callout"],
  ["signature selection", state=>state.signatureSelected="retained-signature"],
  ["physical selection", state=>state.physicalSelected.add("retained-barrier")],
  ["graphic selection", state=>state.graphicSelected="retained-graphic"],
  ["new polygon point", state=>{state.tool="polygon";state.points=[[10,20]];}],
  ["new item edit", state=>state.formDirty=true],
  ["new appearance edit", state=>state.settingsDirty=true],
  ["busy operation", state=>state.busy=true],
  ["open review dialog", state=>state.modal=true],
  ["workspace navigation", state=>state.navigationBusy=true],
];
for(const [name,transition] of transitions) test(`Late font completion retains a newer ${name}`, async()=>{
  const f=fixture(name==="physical selection"?{mode:"physical"}:{}), activation=await f.start(); transition(f.state); const retained=structuredClone(f.state);
  activation.complete(); await activation.pending.catch(()=>{});
  assert.deepEqual(f.state,retained,"Late activation cannot clear newer selection, source, tool, or draft points");
  assert.equal(f.calls.cancel,0); assert.equal(f.calls.command,0);
});
test("Late font completion retains a changed physical workspace scope", async()=>{
  const f=fixture({mode:"physical"}), activation=await f.start(); f.state.physicalScope="service_plans";
  const retained=structuredClone(f.state); activation.complete(); await activation.pending.catch(()=>{});
  assert.deepEqual(f.state,retained); assert.equal(f.calls.cancel,0); assert.equal(f.calls.command,0);
});

for(const latestFirst of [false,true]) test(`Only the latest activation arms its tool when ${latestFirst?"newer":"older"} fonts finish first`, async()=>{
  const f=fixture(), older=await f.start("rectangle"), newer=await f.start("circle");
  if(latestFirst) { newer.complete(); await newer.pending; older.complete(); await older.pending.catch(()=>{}); }
  else { older.complete(); await older.pending.catch(()=>{}); assert.equal(f.state.tool,"select"); assert.equal(f.calls.cancel,0); newer.complete(); await newer.pending; }
  assert.equal(f.state.tool,"graphic-circle"); assert.equal(f.calls.cancel,1); assert.equal(f.calls.command,0);
});
test("A rejected font load preserves the current drawing and selection", async()=>{
  const f=fixture({annotationSelected:"retained-callout"}), activation=await f.start(), retained=structuredClone(f.state);
  activation.fail(); await assert.rejects(activation.pending,/font unavailable/);
  assert.deepEqual(f.state,retained); assert.equal(f.calls.cancel,0); assert.equal(f.calls.command,0);
});

test("Textbox formatting edited during a queued update remains atomic and keeps the next draft", async()=>{
  let release, first=true; const held=new Promise(resolve=>{release=resolve;}), writes=[];
  const f=fixture({graphicSelected:"textbox",settingsDirty:true,queue:Promise.resolve()},async(op,body,guard)=>{
    assert.equal(op,"update_graphic"); assert.equal(guard(),true); writes.push(structuredClone(body));
    if(first){first=false;await held;} return {revision:++f.state.session.revision};
  });
  f.snapshot.graphics.records.push({id:"textbox",mode:"wall",document_id:"document-A",page:1,appearance:{}});
  let content={version:1,blocks:[{kind:"paragraph",runs:[{text:"literal",bold:true}]}]};
  const editor={kind:"graphic",id:"textbox",sessionId:"session-A",key:JSON.stringify([JSON.stringify(["session-A","document-A",1,"wall"]),"wall","textbox"]),appearance:[],touched:new Map([["text",1]]),rich:{read:()=>structuredClone(content)}};
  f.state.settingsEditor=editor;
  const pending=f.ui.apply(editor);for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(writes.length,1);content.blocks[0].runs[0].italic=true;editor.touched.set("text",2);release();await pending;
  assert.equal(writes.length,2);assert.equal(writes[0].changes.text,"literal");assert.equal(writes[0].changes.text_content.blocks[0].runs[0].italic,undefined);assert.equal(writes[1].changes.text_content.blocks[0].runs[0].italic,true);assert.equal(f.state.settingsDirty,false);
});
