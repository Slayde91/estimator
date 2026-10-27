const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const response = (receipt, extra = {}) => ({ok:true,status:200,headers:{get:()=> 'application/json; charset=utf-8'},json:async()=>receipt,...extra});
const receipt = {saved:true,path:'C:/Projects/One/APPENDIX A (1).pdf',filename:'APPENDIX A (1).pdf',destination:'project'};
const source = fs.readFileSync('static/downloads.js','utf8');

// A real progress element is indeterminate when it has no value attribute.
// Keep the clock and request responses controllable so tests can prove that
// waiting alone never earns a percentage or a successful save.
function progressHarness({ reducedMotion = false } = {}) {
  const history = [], timers = new Map(), frames = new Map();
  let now = 0, nextId = 0, latest = {percent:10,state:'preparing'}, pollResponse = null;
  let beginCount = 0, endCount = 0;
  const feedback = require('./helpers/download_sound_vm.cjs').downloadSoundHarness();
  class Element {
    constructor(tag) { this.tagName=tag;this.children=[];this.attributes=new Map();this.dataset={};this.parentElement=null;this.textContent=''; }
    append(...children) { for(const child of children){child.parentElement=this;this.children.push(child);} }
    remove() { if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;} }
    setAttribute(name,value) { this.attributes.set(name,String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    get value() { return Number(this.getAttribute('value')) || 0; }
    set value(value) { this.setAttribute('value',value);history.push(value); }
  }
  const host=new Element('div'), button={closest:()=>host}, pending=deferred();
  const context={
    window:{matchMedia:()=>({matches:reducedMotion}),CeasefireActivity:{begin:()=>{beginCount++;return()=>{endCount++;};}},CeasefireDownloadSound:feedback.sound},
    document:{activeElement:button,createElement:tag=>new Element(tag)},
    setTimeout:(callback,delay)=>{const id=++nextId;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),requestAnimationFrame:callback=>{const id=++nextId;frames.set(id,callback);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    fetch:async path=>{
      if(path==='/api/download-progress')return response({token:'progress-token'});
      if(path.startsWith('/api/download-progress/'))return pollResponse || response(latest);
      return pending.promise;
    },console,
  };
  vm.createContext(context);vm.runInContext(source,context);
  const settle=async()=>{for(let step=0;step<16;step++)await Promise.resolve();};
  return {
    host, history, context, pending, settle, frames,
    get view(){const box=host.children[0];return box?{box,label:box.children[0],bar:box.children[1].children[0]}:null;},
    get activity(){return{begin:beginCount,end:endCount};},
    get audioAttempts(){return feedback.audioAttempts;},
    setProgress(value){latest=value;},holdPoll(value){pollResponse=value;},
    start(){return context.window.CeasefireDownloads.save('/fixture-export',{}, {button});},
    frame(elapsed){now+=elapsed;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(now));},
    async advance(elapsed){
      const end=now+elapsed;
      while(true){const entry=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;
        now=entry[1].at;timers.delete(entry[0]);entry[1].callback();await settle();}
      now=end;await settle();
    },
  };
}

async function checkVisualProgress() {
  let checks=0;
  const h=progressHarness(), saved=h.start();await h.settle();
  assert.equal(h.audioAttempts,0,'Preparation never constructs, loads or plays audio');
  assert.equal(h.view.box.dataset.indeterminate,'true');assert.equal(h.view.bar.hasAttribute('value'),false);
  assert.equal(h.view.label.textContent,'Preparing file');assert.equal(h.view.label.getAttribute('role'),'status');
  await h.advance(8000);
  assert.equal(h.view.bar.hasAttribute('value'),false);assert.equal(h.frames.size,0);
  assert.equal(h.history.includes(100),false,'Eight seconds of opaque work cannot invent progress or success');checks++;

  h.setProgress({percent:35,state:'preparing'});await h.advance(400);
  assert.equal(h.view.box.dataset.indeterminate,'false');assert.equal(h.view.label.textContent,'Preparing file · 35%');
  assert.equal(h.view.bar.getAttribute('aria-valuetext'),'35% preparation completed');
  h.frame(0);h.frame(140);
  assert.ok(h.view.bar.value>10&&h.view.bar.value<35,'Measured work eases between the previous and reported bounds');
  h.frame(140);assert.equal(h.view.bar.value,35);
  await h.advance(8000);assert.equal(h.view.bar.value,35,'Time alone cannot advance measured work');checks++;

  h.setProgress({percent:60,state:'preparing'});await h.advance(400);h.frame(0);h.frame(280);
  assert.equal(h.view.bar.value,60);
  h.setProgress({percent:35,state:'preparing'});await h.advance(400);
  assert.equal(h.view.bar.value,60,'A stale receipt must not reverse completed work');checks++;

  h.setProgress({percent:90,state:'saving'});await h.advance(400);
  assert.equal(h.view.bar.hasAttribute('value'),false);assert.equal(h.view.label.textContent,'Saving file');
  h.setProgress({percent:100,state:'saved'});await h.advance(400);
  assert.equal(h.view.label.textContent,'Confirming file save');assert.equal(h.view.bar.hasAttribute('value'),false);
  assert.equal(h.history.includes(100),false,'A polled saved state cannot authorize 100% before the original receipt');checks++;
  assert.equal(h.audioAttempts,0,'Progress polling never accesses audio');

  h.pending.resolve(response(receipt));assert.deepEqual(await saved,receipt);
  assert.equal(h.view.bar.value,100);assert.equal(h.view.label.textContent,'File saved · 100%');
  assert.equal(h.view.box.dataset.indeterminate,'false');assert.deepEqual(h.activity,{begin:1,end:1});
  assert.equal(h.audioAttempts,0,'The save receipt and completion grace remain silent');
  assert.equal(h.frames.size,0);await h.advance(499);assert.ok(h.view);await h.advance(1);assert.equal(h.view,null);checks++;

  const reduced=progressHarness({reducedMotion:true}), reducedSaved=reduced.start();await reduced.settle();
  reduced.setProgress({percent:60,state:'preparing'});await reduced.advance(400);
  assert.equal(reduced.view.bar.value,60);assert.equal(reduced.frames.size,0,'Reduced motion skips easing');
  reduced.pending.resolve(response(receipt));await reducedSaved;await reduced.advance(500);checks++;

  // A late poll must not resurrect progress after completion or extend activity.
  const late=progressHarness(), polling=deferred();late.holdPoll(polling.promise);
  const lateSaved=late.start();await late.settle();late.pending.resolve(response(receipt));await lateSaved;
  await late.advance(500);assert.equal(late.view,null);
  polling.resolve(response({percent:85,state:'preparing'}));await late.settle();await late.advance(1000);
  assert.equal(late.view,null);assert.deepEqual(late.activity,{begin:1,end:1});checks++;
  assert.equal(late.audioAttempts,0,'Late polls cannot start audio');

  for(const [value,extra,pattern]of[
    [{error:'File preparation was cancelled.'},{ok:false,status:400},/cancelled/],
    [{...receipt,saved:false},{},/did not confirm/],
    [{...receipt,path:''},{},/did not confirm/],
  ]){
    const failed=progressHarness(), operation=failed.start();await failed.settle();
    failed.setProgress({percent:35,state:'preparing'});await failed.advance(400);assert.equal(failed.frames.size,1);
    failed.pending.resolve(response(value,extra));await assert.rejects(operation,pattern);
    assert.equal(failed.view,null);assert.equal(failed.frames.size,0);
    await failed.advance(2000);assert.equal(failed.history.includes(100),false);
    assert.deepEqual(failed.activity,{begin:1,end:1});checks++;
    assert.equal(failed.audioAttempts,0,'Cancelled, invalid and failed responses remain silent');
  }
  const aborted=progressHarness(), abortedOperation=aborted.start();await aborted.settle();
  // Native request cancellation is an error path; it must retire the activity
  // without fabricating a file-save receipt or leaving a running animation.
  aborted.pending.resolve(Promise.reject(Object.assign(new Error('Request cancelled'),{name:'AbortError'})));
  await assert.rejects(abortedOperation,/Request cancelled/);assert.equal(aborted.view,null);
  await aborted.advance(2000);assert.equal(aborted.history.includes(100),false);assert.deepEqual(aborted.activity,{begin:1,end:1});checks++;
  assert.equal(aborted.audioAttempts,0,'Native cancellation remains silent');
  return checks;
}
let projectToken = 'selected-project', calls = [], next = response(receipt);
const context = {
  window:{CeasefireProject:{downloadTarget:()=>({project_token:projectToken})}},
  document:{activeElement:null},setTimeout,clearTimeout,requestAnimationFrame:callback=>callback(),
  fetch:(path,options)=>{
    if(path==='/api/download-progress') return Promise.resolve(response({token:'progress-token'}));
    if(path.startsWith('/api/download-progress/')) return Promise.resolve(response({percent:10,state:'preparing'}));
    calls.push({path,...options,body:JSON.parse(options.body)});return Promise.resolve(next);
  },console
};
vm.createContext(context);
vm.runInContext(source,context);
let passed = 0;
(async()=>{
  const waiting=deferred();next=waiting.promise;
  const draft={inputs:{CALCULATOR:{B9:7.123456789012345}}};
  const saving=context.window.CeasefireDownloads.save('/api/calculators/steel_board/report.pdf',draft);
  projectToken='later-project';draft.inputs.CALCULATOR.B9=99;
  waiting.resolve(response(receipt));assert.deepEqual(await saving,receipt);
  assert.equal(calls[0].body.download.project_token,'selected-project');assert.equal(calls[0].body.inputs.CALCULATOR.B9,7.123456789012345);
  assert.equal(calls[0].method,'POST');assert.equal(calls[0].headers.Accept,'application/json');passed++;
  assert.equal(calls[0].headers['X-Estimator-Download-Progress'],'progress-token');passed++;

  projectToken=null;next=response({...receipt,destination:'downloads',path:'D:/Redirected Downloads/APPENDIX A.pdf'});
  const fallback=await context.window.CeasefireDownloads.save('/api/quote-report',{title:'Unsaved'});
  assert.equal(calls.at(-1).body.download.project_token,null);assert.equal(fallback.destination,'downloads');assert.match(fallback.path,/Redirected Downloads/);passed++;

  delete context.window.CeasefireProject;next=response({...receipt,destination:'downloads'});
  await context.window.CeasefireDownloads.save('/api/pricing/export',{});assert.equal(calls.at(-1).body.download.project_token,null);passed++;

  for(const [value,extra,pattern] of [
    [{error:'Project access expired. Reopen it.'},{ok:false,status:400},/Project access expired/],
    [null,{ok:false,status:500,headers:{get:()=> 'text/html'}},/\(500\)/],
    [null,{headers:{get:()=> 'application/pdf'}},/file-save confirmation/],
    [null,{},/did not confirm/],
    [{...receipt,saved:false},{},/did not confirm/],
    [{...receipt,path:''},{},/did not confirm/],
    [{...receipt,filename:null},{},/did not confirm/],
    [{...receipt,destination:'unknown'},{},/did not confirm/],
  ]) {
    next=response(value,extra);await assert.rejects(context.window.CeasefireDownloads.save('/api/quote-report'),pattern);passed++;
  }
  context.fetch=async()=>{throw new Error('Connection unavailable');};
  await assert.rejects(context.window.CeasefireDownloads.save('/api/quote-report'),/Connection unavailable/);passed++;
  passed+=await checkVisualProgress();
  console.log(`Download destination UI checks passed: ${passed}`);
})().catch(error=>{console.error(error);process.exitCode=1;});
