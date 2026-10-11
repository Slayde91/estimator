"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = path.resolve(__dirname, "../static/takeoff-graphics-ui.js");
const code = fs.readFileSync(source, "utf8");
const X = require("../static/takeoff-graphics.js"), G = require("../static/takeoff-geometry.js");

// Only the bridge runs: fonts are controlled promises and the host contains no
// network, browser, storage, calculator, or persisted Takeoff implementation.
function fixture(initial = {}, commandOverride) {
  const fonts = [], calls = { cancel: 0, render: 0, command: 0, messages: [], ask:0, answer:{stamp_type:"text",text:"APPROVED"} };
  const clock={now:1000}, listeners=new Map(), listenerOptions=new Map();
  const element={addEventListener(name,fn,capture=false){listeners.set(name,fn);listenerOptions.set(name,capture);},removeEventListener(name,fn,capture=false){if(listeners.get(name)===fn&&listenerOptions.get(name)===capture){listeners.delete(name);listenerOptions.delete(name);}},setPointerCapture(){},hasPointerCapture(){return false;}};
  const state = { active: true, busy: false, modal: false, navigationBusy: false,
    viewport: { transform: [1,0,0,-1,0,800] }, document: "document-A", page: 1, mode: "wall", physicalScope: "defect_reports",
    tool: "select", points: [], selected: new Set(), countSelection: new Set(), physicalSelected: new Set(),
    annotationSelected: null, signatureSelected: null, graphicSelected: null, legendSelected: null,
    formDirty: false, settingsDirty: false, settingsOpen: false, settingsEditor: null, stampTemplate:null,
    physicalPlacing: false, gesture: null, pendingViewport: null,
    session: { session_id: "session-A", revision: 7 }, ...initial };
  // DOM methods are not application draft data and cannot be structured-cloned.
  Object.defineProperty(state,"ui",{value:{viewport:element},enumerable:false});
  const originals = [{id:"document-A",sha256:"a".repeat(64)}, {id:"document-B",sha256:"b".repeat(64)}];
  const snapshot = { graphics: { version:1, records:[] }, items:[], calibrations:[], transfers:[] };
  const document = { fonts: { load() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); fonts.push({promise,resolve,reject}); return promise; } },
    createElement(tag) { assert.equal(tag,"canvas"); return { getContext() { return {}; } }; } };
  const context = { window: {CeasefireTakeoffAnnotations:{text:value=>value.blocks.map(block=>block.runs.map(run=>run.text).join("")).join("\n")}}, document, Date:{now:()=>clock.now}, setTimeout, clearTimeout }; vm.createContext(context); vm.runInContext(code, context, {filename:source});
  const host = { state, X, G, clone:structuredClone,
    snapshot:()=>snapshot, documents:()=>originals, currentDocument:()=>originals.find(v=>v.id===state.document),
    pageDisplayKey:()=>JSON.stringify([state.session?.session_id,state.document,state.page,state.mode]),
    signatureMode:()=>state.mode==="physical"?state.physicalScope:state.mode,
    signatureInWorkspace:value=>value.mode===(state.mode==="physical"?state.physicalScope:state.mode),
    selectedSignature:()=>null, selectedAnnotation:()=>null,
    flushSettings:async()=>{}, requireFinishedEdits() {
      if(state.formDirty||state.settingsDirty||state.gesture||state.points.length||state.pendingViewport||state.physicalPlacing||state.physicalUI?.hasUnfinishedChanges()) throw new Error("Finish the newer edit first.");
    }, cancelTrace() { calls.cancel++; ui.cancel(true); state.points=[]; state.tool="select"; },
    setTool(tool) { if(state.busy||state.modal||state.navigationBusy) throw new Error("Finish the current operation first."); state.tool=tool; },
    command(...args) { calls.command++; if(commandOverride) return commandOverride(...args); throw new Error("Activation must not issue a persisted command."); },
    pageMetadata:()=>({view:[0,0,600,800]}),drawingPoint:event=>event.pdf,
    ask:async()=>{calls.ask++;if(calls.answerPromise)return calls.answerPromise;return calls.answer;},
    safely:async fn=>{try{return await fn();}catch(error){calls.error=error;throw error;}},
    renderOverlay(){calls.render++;},renderSelection() { calls.render++; }, message(value) { calls.messages.push(value); } };
  const ui = context.window.CeasefireTakeoffGraphicsUI(host);
  async function start(kind="rectangle") {
    const before = fonts.length, pending = ui.activate(kind); pending.catch(()=>{});
    for(let attempt=0;attempt<12&&fonts.length<before+2;attempt++) await Promise.resolve();
    assert.equal(fonts.length,before+2,"Activation reaches both delayed drawing-font loads");
    return { pending, complete() { fonts.slice(before,before+2).forEach(value=>value.resolve([])); }, fail() { fonts[before].reject(new Error("Drawing font unavailable")); fonts[before+1].resolve([]); } };
  }
  return {state,calls,snapshot,start,ui,listeners,listenerOptions,clock,fonts};
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

const pointer=(pdf,extra={})=>({button:0,detail:1,pdf,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},pointerId:11,clientX:pdf[0],clientY:pdf[1],...extra});
test("Editing one graphic appearance field sends only that field, retaining other pages' fitted font sizes and untouched precision",async()=>{
  const writes=[],f=fixture({graphicSelected:"textbox",settingsDirty:true,queue:Promise.resolve()},async(op,body,guard)=>{assert.equal(op,"update_graphic");assert.equal(guard(),true);writes.push(structuredClone(body));return{revision:++f.state.session.revision};});
  f.snapshot.graphics.records.push({id:"textbox",mode:"wall",document_id:"document-A",page:1,appearance:{...X.defaults(),font_size:11.54321,opacity:.756789123}});
  const editor={kind:"graphic",id:"textbox",sessionId:"session-A",key:JSON.stringify([JSON.stringify(["session-A","document-A",1,"wall"]),"wall","textbox"]),appearance:[{control:{name:"font_color"},read:()=>"#112233"},{control:{name:"font_size"},read:()=>{throw new Error("Untouched font size must not be read");}}],touched:new Map([["appearance:font_color",1]])};f.state.settingsEditor=editor;
  await f.ui.apply(editor);assert.deepEqual(writes[0].changes,{appearance:{font_color:"#112233"}});assert.equal(f.state.settingsDirty,false);
});
function stampFixture(initial={}) {
  const writes=[];let f;
  f=fixture(initial,async(op,body,guard)=>{
    if(!guard())return null;
    assert.equal(op,"create_graphic");writes.push(structuredClone(body));
    const id=`stamp-${writes.length}`;f.snapshot.graphics.records.push({id,version:1,...structuredClone(body.graphic)});f.state.session.revision++;
    return {created_graphic_id:id};
  });
  return {...f,writes};
}
async function configureTextStamp(f) {
  const activation=await f.start("stamp");activation.complete();await activation.pending;
  f.state.points=[[100,200],[220,260]];await f.ui.finish();
}
test("Continue Stamp uses the current saved size, text, image and appearance without carrying linked identities",async()=>{
  for(const image of [false,true]) {
    const f=stampFixture({graphicSelected:"existing"}), original={id:"existing",version:4,mode:"wall",document_id:"document-A",source_sha256:"a".repeat(64),page:1,kind:"stamp",geometry:{quad_pdf:[[40,50],[160,50],[160,90],[40,90]]},text:image?"":"LATEST",appearance:{...X.defaults(),opacity:.61,font_color:"#123456"},initial_pages:{version:1,group_id:"group",role:"text"},...(image?{stamp_image:{version:1,mime_type:"image/png",width:1,height:1,data_base64:"canonical"}}:{})};
    f.snapshot.graphics.records.push(original);
    const pending=f.ui.continueStamp(original.id);for(let i=0;i<12;i++)await Promise.resolve();f.fonts.forEach(value=>value.resolve([]));await pending;
    assert.equal(f.calls.command,0,"Resuming only arms the tool");assert.equal(f.state.tool,"graphic-stamp");
    await f.ui.point(pointer([300,400]));await f.ui.point(pointer([400,500]));
    assert.equal(f.writes.length,2);for(const {graphic}of f.writes){assert.equal(graphic.text,original.text);assert.deepEqual(graphic.appearance,original.appearance);assert.equal(graphic.initial_pages,undefined);assert.equal(graphic.id,undefined);if(image)assert.deepEqual(graphic.stamp_image,original.stamp_image);}
    assert.deepEqual(original.geometry,{quad_pdf:[[40,50],[160,50],[160,90],[40,90]]});
  }
});
test("Continue Stamp cannot replace a newer selection while its fonts load",async()=>{
  const f=fixture({graphicSelected:"existing"});f.snapshot.graphics.records.push({id:"existing",version:1,mode:"wall",document_id:"document-A",page:1,kind:"stamp",geometry:{quad_pdf:[[40,50],[160,50],[160,90],[40,90]]},text:"ST",appearance:X.defaults()});
  const pending=f.ui.continueStamp("existing");for(let i=0;i<12;i++)await Promise.resolve();f.state.graphicSelected="newer";const retained=structuredClone(f.state);f.fonts.forEach(value=>value.resolve([]));await assert.rejects(pending,/drawing changed/);assert.deepEqual(f.state,retained);assert.equal(f.calls.command,0);
});
async function dragTextStamp(f) {
  assert.equal(f.ui.beginStampBox(pointer([100,200])),true);
  f.listeners.get('pointermove')(pointer([220,260]));f.listeners.get('pointerup')(pointer([220,260]));
  for(let i=0;i<24&&!f.state.stampTemplate;i++)await Promise.resolve();
  assert.equal(f.calls.error,undefined);assert.equal(f.writes.length,1);assert.equal(f.ui.hasStampTemplate(),true);
}
async function capturedClick(f,pdf,extra={}) {
  const event=pointer(pdf,{type:'click',...extra});f.listeners.get('click')?.(event);
  event.captureSuppressed=event.stopped===true;
  if(!event.captureSuppressed)await f.ui.point(event);
  return event;
}
async function freshClick(f,pdf,extra={}) {
  f.listeners.get('pointerdown')?.(pointer(pdf,{type:'pointerdown',...extra}));
  return capturedClick(f,pdf,extra);
}
test("First Stamp configures once and left clicks create independent same-size PDF-only copies",async()=>{
  const f=stampFixture(), baseline=structuredClone(f.snapshot);await configureTextStamp(f);
  assert.equal(f.state.tool,"graphic-stamp");assert.equal(f.state.graphicSelected,null);assert.equal(f.state.settingsOpen,false);assert.equal(f.calls.ask,1);assert.equal(f.ui.hasStampTemplate(),true);
  const first=structuredClone(f.writes[0].graphic);
  for(const p of [[300,400],[450,600]])await f.ui.point(pointer(p));
  assert.equal(f.writes.length,3);assert.equal(f.calls.ask,1);assert.equal(new Set(f.snapshot.graphics.records.map(v=>v.id)).size,3);assert.equal(f.state.tool,"graphic-stamp");
  for(const value of f.writes.slice(1).map(v=>v.graphic)){
    for(const key of ['mode','document_id','source_sha256','page','kind','text','appearance'])assert.deepEqual(value[key],first[key]);
    const quad=value.geometry.quad_pdf, original=first.geometry.quad_pdf;for(const i of [1,2,3])for(const axis of [0,1])assert.ok(Math.abs(quad[i][axis]-quad[0][axis]-original[i][axis]+original[0][axis])<1e-10);
  }
  for(const key of ['items','calibrations','transfers'])assert.deepEqual(f.snapshot[key],baseline[key]);
  await assert.rejects(f.ui.point(pointer([1,1])),/whole stamp/);assert.equal(f.writes.length,3);
});
test("Stamp cancellation forgets its template, and reactivation requires a new configuration",async()=>{
  const f=stampFixture();await configureTextStamp(f);f.ui.cancel(true);f.state.tool="select";
  assert.equal(f.ui.hasStampTemplate(),false);await f.ui.point(pointer([300,400]));assert.equal(f.writes.length,1);
  await configureTextStamp(f);assert.equal(f.calls.ask,2);assert.equal(f.writes.length,2);
  const priorCancel=f.calls.cancel;await f.ui.activate("stamp");assert.equal(f.state.tool,"select");assert.equal(f.calls.cancel,priorCancel+1);assert.equal(f.ui.hasStampTemplate(),false);assert.equal(f.writes.length,2);
});
for(const[name,transition]of[["page",s=>s.page=2],["source",s=>s.document="document-B"],["session",s=>s.session={session_id:"new-session",revision:7}],["workspace",s=>s.mode="duct"],["physical scope",s=>{s.mode="physical";s.physicalScope="service_plans";}]])test(`A Stamp template cannot cross a changed ${name}`,async()=>{
  const f=stampFixture();await configureTextStamp(f);transition(f.state);assert.equal(f.ui.hasStampTemplate(),false);assert.equal(f.state.stampTemplate,null);assert.equal(f.writes.length,1);
});
test("Repeated image Stamp submits only the same canonical embedded payload",async()=>{
  const image={version:1,mime_type:"image/png",content_base64:"AQID",width:1,height:1,sha256:"c".repeat(64)}, f=stampFixture({tool:"graphic-stamp"});
  f.state.stampTemplate={key:JSON.stringify(['session-A','document-A','a'.repeat(64),1,'wall']),geometry:{quad_pdf:[[100,200],[220,200],[220,260],[100,260]]},text:"",appearance:X.defaults(),stamp_image:structuredClone(image)};
  await f.ui.point(pointer([300,400]));await f.ui.point(pointer([450,600]));assert.equal(f.writes.length,2);assert.equal(f.calls.ask,0);
  for(const v of f.writes){assert.deepEqual(v.graphic.stamp_image,image);assert.equal(v.graphic.text,"");assert.equal(v.graphic.kind,"stamp");assert.equal(v.graphic.source_sha256,'a'.repeat(64));}
  assert.deepEqual(f.state.stampTemplate.stamp_image,image);
});
for(const[name,transition]of[["page",s=>{s.page=2;s.points=[[9,9]];}],["session",s=>s.session={session_id:"new-session",revision:20}],["drawing tool",s=>s.tool="pan"]])test(`Late Stamp dialog completion preserves the newer ${name}`,async()=>{
  const f=stampFixture();let release;f.calls.answerPromise=new Promise(resolve=>release=resolve);
  const activation=await f.start('stamp');activation.complete();await activation.pending;f.state.points=[[100,200],[220,260]];
  const pending=f.ui.finish();pending.catch(()=>{});await Promise.resolve();transition(f.state);const retained=structuredClone(f.state);release({stamp_type:"text",text:"old request"});
  await assert.rejects(pending,/drawing changed/);assert.deepEqual(f.state,retained);assert.equal(f.writes.length,0);
});
test("Cancelling a stale Stamp dialog cannot clear a newer drawing",async()=>{
  const f=stampFixture();let release;f.calls.answerPromise=new Promise(resolve=>release=resolve);
  const activation=await f.start('stamp');activation.complete();await activation.pending;f.state.points=[[100,200],[220,260]];
  const pending=f.ui.finish();await Promise.resolve();f.state.page=2;f.state.tool="polygon";f.state.points=[[9,9]];const retained=structuredClone(f.state);release(null);await pending;
  assert.deepEqual(f.state,retained);assert.equal(f.writes.length,0);
});
test("Initial Stamp drag captures its two PDF corners and cancelling releases its listeners",async()=>{
  const f=stampFixture({tool:"graphic-stamp"});assert.equal(f.ui.beginStampBox(pointer([100,200])),true);assert.equal(f.state.gesture.kind,"stamp-box");assert.equal(f.listeners.size,4);
  f.listeners.get('pointermove')(pointer([220,260]));assert.deepEqual(Array.from(f.state.traceCursor),[220,260]);f.ui.cancel();assert.equal(f.state.gesture,null);assert.equal(f.state.points.length,0);assert.equal(f.listeners.size,0);assert.equal(f.writes.length,0);
  assert.equal(f.ui.beginStampBox(pointer([100,200],{button:2})),false);assert.equal(f.writes.length,0);
});
test("Completed initial Stamp drag consumes its release click and immediately accepts the next genuine click",async()=>{
  const f=stampFixture({tool:"graphic-stamp"});await dragTextStamp(f);
  assert.equal(f.calls.ask,1);assert.equal(f.state.tool,"graphic-stamp");assert.equal(f.state.points.length,0);assert.equal(f.state.gesture,null);
  assert.deepEqual([...f.listeners.keys()].sort(),['click','pointerdown']);
  assert.equal(f.listenerOptions.get('click'),true);assert.equal(f.listenerOptions.get('pointerdown'),true);
  assert.equal(f.listeners.has('lostpointercapture'),false,"Normal capture cleanup leaves the release-click guard active");
  assert.deepEqual(f.writes[0].graphic.geometry,X.box([[100,200],[220,260]],p=>G.transform(p,f.state.viewport.transform),p=>G.inverse(p,f.state.viewport.transform)));
  const bounced=await capturedClick(f,[220,260]);assert.equal(bounced.stopped,true);assert.equal(bounced.prevented,true);assert.equal(f.writes.length,1);assert.equal(f.listeners.size,0);
  const next=await freshClick(f,[300,400]);assert.equal(next.captureSuppressed,false);assert.equal(f.writes.length,2);
  assert.equal(f.clock.now,1000,"No time elapses between release and genuine placement");assert.equal(f.state.suppressSelectionClickUntil,undefined);
});
test("A new pointerdown clears an unreceived Stamp release click before immediate repeated placement",async()=>{
  const f=stampFixture({tool:"graphic-stamp"});await dragTextStamp(f);
  const next=await freshClick(f,[300,400]);assert.equal(next.captureSuppressed,false);assert.equal(f.writes.length,2);assert.equal(f.listeners.size,0);assert.equal(f.clock.now,1000);
});
for(const[name,extra]of[['keyboard activation',{detail:0,pointerId:-1}],['another pointer',{pointerId:12}]])test(`A pending Stamp release click allows ${name} and still consumes its own pointer click`,async()=>{
  const f=stampFixture({tool:"graphic-stamp"});await dragTextStamp(f);
  const unrelated=await capturedClick(f,[300,400],extra);assert.equal(unrelated.captureSuppressed,false);assert.equal(f.writes.length,2);assert.equal(f.listeners.size,2);
  const bounced=await capturedClick(f,[220,260]);assert.equal(bounced.stopped,true);assert.equal(f.writes.length,2);assert.equal(f.listeners.size,0);
});
test("A legacy mouse release click without pointerId consumes only the pending Stamp bounce",async()=>{
  const f=stampFixture({tool:"graphic-stamp"});await dragTextStamp(f);
  const bounced=await capturedClick(f,[220,260],{pointerId:undefined});assert.equal(bounced.stopped,true);assert.equal(f.writes.length,1);assert.equal(f.listeners.size,0);
  await freshClick(f,[300,400]);assert.equal(f.writes.length,2);
});
test("Explicit Stamp cancellation removes both pending release-click handlers",async()=>{
  const f=stampFixture({tool:"graphic-stamp"});await dragTextStamp(f);f.ui.cancel();
  assert.equal(f.listeners.size,0);assert.equal(f.ui.hasStampTemplate(),false);assert.equal(f.writes.length,1);
});
test("Stamp release-click cleanup preserves an unrelated selection-gesture time guard",async()=>{
  const f=stampFixture({tool:"graphic-stamp",suppressSelectionClickUntil:1500});await dragTextStamp(f);
  const bounced=await capturedClick(f,[220,260]);assert.equal(bounced.stopped,true);
  await freshClick(f,[300,400]);assert.equal(f.writes.length,1);assert.equal(f.state.suppressSelectionClickUntil,1500);
  f.clock.now=1500;await freshClick(f,[300,400]);assert.equal(f.writes.length,2);assert.equal(f.state.suppressSelectionClickUntil,1500);
});
test("A late repeated Stamp result cannot clear a newer page draft",async()=>{
  let release;const held=new Promise(resolve=>release=resolve);
  const f=fixture({tool:"graphic-stamp"},async(op,body,guard)=>{assert.equal(guard(),true);await held;return {created_graphic_id:"accepted-old-stamp"};});
  f.state.stampTemplate={key:JSON.stringify(['session-A','document-A','a'.repeat(64),1,'wall']),geometry:{quad_pdf:[[100,200],[220,200],[220,260],[100,260]]},text:"REVIEWED",appearance:X.defaults()};
  const pending=f.ui.point(pointer([300,400]));await Promise.resolve();f.state.page=2;f.state.tool="polygon";f.state.points=[[9,9]];const retained=structuredClone(f.state);release();await pending;
  assert.deepEqual(f.state,retained);assert.equal(f.calls.render,0);assert.equal(f.calls.command,1);
});
test("An invalidated initial Stamp drag releases only its own listeners",()=>{
  const f=stampFixture({tool:"graphic-stamp"});f.ui.beginStampBox(pointer([100,200]));const release=f.listeners.get('pointerup');f.state.page=2;f.state.tool="polygon";f.state.points=[[9,9]];f.state.gesture={kind:"new-draft"};const retained=structuredClone(f.state);
  release(pointer([220,260]));assert.deepEqual(f.state,retained);assert.equal(f.listeners.size,0);assert.equal(f.calls.command,0);
});
