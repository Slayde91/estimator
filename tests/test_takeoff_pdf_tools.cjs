"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const T = require("../static/takeoff-pdf-tools.js"), copy = value => JSON.parse(JSON.stringify(value));
const documents = [{id:"alpha",name:"Alpha.pdf",size:1200,pages:Array.from({length:4},(_,page)=>({page:page+1}))},
  {id:"beta",name:"Beta.pdf",size:800,pages:[{page:1},{page:2}]}];
test("Page ranges preserve explicit descending/reordered pages and format round trips", () => {
  for (const text of ["1, 3-4", "4-2, 1", "2, 4, 1, 3"]) {
    const parsed = T.parsePages(text,4); assert.deepEqual(T.parsePages(T.formatPages(parsed),4),parsed);
  }
  assert.deepEqual(T.parsePages("4-2, 1",4),[4,3,2,1]); assert.equal(T.formatPages([3,1,2,4]),"3, 1-2, 4");
});
test("Malformed, empty, repeated and out-of-bounds page ranges are declined", () => {
  for (const text of ["", " ", "1,", "1;2", "1.5", "0", "5", "1-3, 3", "1e2", "1--2", "NaN", "999999999999999999999"]) assert.throws(()=>T.parsePages(text,4));
  for (const max of [true,0,2001,1.5]) assert.throws(()=>T.parsePages("1",max));
});
test("Request contract pins current retained IDs and revision and never adds file paths", () => {
  const ids=["beta","alpha"],pages=[4,1],before=copy(documents);
  assert.deepEqual(T.request("merge",ids,[],7,documents),{expected_revision:7,operation:"merge",document_ids:ids});
  assert.deepEqual(T.request("organise",["alpha"],pages,7,documents),{expected_revision:7,operation:"organise",document_ids:["alpha"],page_order:pages});
  const request=T.request("extract",["alpha"],pages,7,documents); request.page_order[0]=2;
  assert.deepEqual(pages,[4,1]); assert.deepEqual(documents,before);
});
test("Request helper declines stale-shaped metadata, invalid revisions and resource overruns", () => {
  for (const args of [["delete",["alpha"],[1],7], ["extract",["missing"],[1],7], ["merge",["alpha"],[],7],
    ["extract",["alpha","beta"],[1],7], ["extract",["alpha"],[1,1],7], ["extract",["alpha"],[true],7],
    ["extract",["alpha"],[],7], ["extract",["alpha"],[1],true], ["merge",["alpha","alpha"],[],7]]) assert.throws(()=>T.request(...args,documents));
  for (const size of [undefined,NaN,-1,Infinity,"12"]) assert.throws(()=>T.request("extract",["alpha"],[1],7,[{...documents[0],size}]));
  assert.throws(()=>T.request("merge",["alpha","beta"],[],7,documents.map(value=>({...value,size:140*1024*1024}))));
});

function harness() {
  let root, current; const downloads=[], revoked=[];
  function element(tag) {
    const el={tagName:tag.toUpperCase(),children:[],events:{},attributes:{},value:"",disabled:false,
      append(...children){this.children.push(...children);}, replaceChildren(...children){this.children=[...children];},
      setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},
      addEventListener(name,fn){(this.events[name]??=[]).push(fn);},
      querySelectorAll(selector){return descendants(this).filter(value=>selector.split(",").includes(value.tagName?.toLowerCase()));},
      showModal(){current=this;},close(reason){this.returnValue=reason;for(const fn of this.events.close||[])fn({});},
      remove(){this.removed=true;},click(){downloads.push({href:this.href,name:this.download});}};
    return el;
  }
  function descendants(el=current){return [el,...el.children.flatMap(child=>child.children?descendants(child):[child])];}
  root={Blob,URL:{createObjectURL:()=>"blob:disposable-pdf",revokeObjectURL:value=>revoked.push(value)},setTimeout:fn=>fn(),
    document:{createElement:element,createTextNode:text=>({textContent:text}),body:element("body")}};
  const context={window:root};vm.createContext(context);vm.runInContext(fs.readFileSync("static/takeoff-pdf-tools.js","utf8"),context);
  const find=predicate=>descendants().find(predicate), button=name=>find(el=>el.tagName==="BUTTON"&&el.textContent===name),
    input=name=>find(el=>el.tagName==="INPUT"&&el.attributes["aria-label"]===name),
    aria=name=>find(el=>el.attributes?.["aria-label"]===name), dispatch=(el,name="click",event={})=>Promise.all((el.events[name]||[]).map(fn=>fn(event)));
  return {root,api:root.CeasefireTakeoffPDFTools,descendants,button,input,aria,dispatch,downloads,revoked,dialog:()=>current,
    output:()=>descendants().filter(el=>el.tagName==="SELECT").at(-1), status:()=>find(el=>el.attributes?.role==="status")};
}
const pdf=()=>new Blob(["%PDF-1.7\nDisposable bytes"],{type:"application/pdf"});
function open(h,operation="organise",options={}){return h.api.open({operation,documents:copy(documents),expectedRevision:7,requestPDF:async()=>pdf(),...options});}
test("Organise defaults to download, applies ranges/deletion and never mutates source metadata", async () => {
  const h=harness(),before=copy(documents),requests=[],outputs=[],promise=open(h,"organise",{requestPDF:async body=>{requests.push(copy(body));return pdf();},onResult:async value=>outputs.push(value)});
  assert.equal(h.output().value,"download"); h.input("Page order").value="4, 1-3";await h.dispatch(h.button("Apply page order"));
  h.input("Pages to delete").value="2-3";await h.dispatch(h.button("Delete selected pages"));
  assert.equal(h.input("Page order").value,"4, 1");assert.match(h.descendants().find(el=>el.className==="helper takeoff-pdf-tools-summary").textContent,/2 pages.*2 removed/);
  await h.dispatch(h.button("Create PDF"));assert.equal((await promise).action,"download");
  assert.deepEqual(requests,[{expected_revision:7,operation:"organise",document_ids:["alpha"],page_order:[4,1]}]);
  assert.equal(outputs[0].filename,"CEASEFIRE-Organised-Pages.pdf");assert.deepEqual(documents,before);assert.equal(h.api.hasOpenDialog(),false);
});
test("Delete all pages is refused and invalid typed order survives a failed Create without request", async () => {
  const h=harness(),requests=[],promise=open(h,"organise",{requestPDF:async body=>{requests.push(body);return pdf();}});
  h.input("Pages to delete").value="1-4";await h.dispatch(h.button("Delete selected pages"));assert.match(h.status().textContent,/Keep at least one/);
  assert.equal(h.input("Page order").value,"1-4");h.input("Page order").value="1, 1";await h.dispatch(h.button("Create PDF"));
  assert.equal(requests.length,0);assert.equal(h.input("Page order").value,"1, 1");assert.match(h.status().textContent,/more than once/);
  await h.dispatch(h.button("Cancel"));assert.equal(await promise,null);
});
test("Merge document controls create the selected source order and require at least two", async () => {
  const h=harness(),requests=[],promise=open(h,"merge",{requestPDF:async body=>{requests.push(copy(body));return pdf();}});
  await h.dispatch(h.aria("Move Beta.pdf up"));assert.equal(h.aria("Move Beta.pdf up").disabled,true);
  const check=h.descendants().find(el=>el.tagName==="INPUT"&&el.type==="checkbox");check.checked=false;await h.dispatch(check,"change");assert.equal(h.button("Create PDF").disabled,true);
  check.checked=true;await h.dispatch(check,"change");await h.dispatch(h.button("Create PDF"));await promise;
  assert.deepEqual(requests[0].document_ids,["beta","alpha"]);assert.equal(h.downloads.length,1);assert.deepEqual(h.revoked,["blob:disposable-pdf"]);
});
test("Extract accepts typed order on Create and explicit add-source invokes only the supplied callback", async () => {
  const h=harness(),requests=[],outputs=[],promise=open(h,"extract",{onResult:async value=>outputs.push(value),requestPDF:async body=>{requests.push(copy(body));return {blob:pdf(),filename:"../../ignored.pdf"};}});
  h.input("Pages to extract").value="1, 3-4";h.output().value="add-source";await h.dispatch(h.button("Create PDF"));await promise;
  assert.deepEqual(requests[0].page_order,[1,3,4]);assert.equal(outputs[0].action,"add-source");assert.equal(outputs[0].filename,"CEASEFIRE-Extracted-Pages.pdf");assert.equal(h.downloads.length,0);
});
test("An in-flight request freezes controls, rejects a second dialog and ignores duplicate Create/cancel", async () => {
  const h=harness();let resolve,calls=0;const promise=open(h,"extract",{requestPDF:()=>{calls++;return new Promise(done=>{resolve=done;});}});
  const work=h.dispatch(h.button("Create PDF"));assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.button("Cancel").disabled,true);
  await assert.rejects(()=>open(h),/Finish the open/);await h.dispatch(h.button("Create PDF"));await h.dispatch(h.button("Cancel"));assert.equal(calls,1);
  let prevented=false;await h.dispatch(h.dialog(),"cancel",{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.api.hasOpenDialog(),true);
  resolve(pdf());await work;await promise;assert.equal(h.api.hasPendingOperation(),false);
});
test("Callback retry reuses validated bytes while a changed page order requires a new operation", async () => {
  const h=harness();let calls=0,deliveries=0;const promise=open(h,"organise",{requestPDF:async()=>{calls++;return pdf();},onResult:async()=>{if(++deliveries<3)throw new Error("Output temporarily unavailable");}});
  await h.dispatch(h.button("Create PDF"));assert.equal(h.api.hasPendingOperation(),false);assert.match(h.status().textContent,/temporarily/);
  await h.dispatch(h.button("Create PDF"));assert.equal(calls,1);h.input("Page order").value="4, 2";
  await h.dispatch(h.button("Create PDF"));await promise;assert.equal(calls,2);assert.equal(deliveries,3);
});
test("Invalid MIME or magic never downloads or publishes and leaves dialog available for cancellation", async () => {
  for(const value of [new Blob(["%PDF-1.7"],{type:"text/plain"}),new Blob(["not PDF"],{type:"application/pdf"})]) {
    const h=harness(),promise=open(h,"extract",{requestPDF:async()=>value});await h.dispatch(h.button("Create PDF"));assert.equal(h.downloads.length,0);assert.match(h.status().textContent,/PDF/);
    await h.dispatch(h.button("Cancel"));assert.equal(await promise,null);
  }
});
test("Long page lists paginate at 100 while row moves preserve full order and selected source resets safely", async () => {
  const h=harness(),long=[{...documents[0],pages:Array.from({length:125},(_,i)=>({page:i+1}))},documents[1]],promise=open(h,"organise",{documents:long});
  assert.equal(h.aria("Output page order").children.length,100);await h.dispatch(h.button("Next pages"));assert.equal(h.aria("Output page order").children.length,25);
  await h.dispatch(h.aria("Move page 101 up"));assert.match(h.input("Page order").value,/1-99, 101, 100, 102-125/);
  const source=h.descendants().find(el=>el.tagName==="SELECT");source.value="beta";await h.dispatch(source,"change");assert.equal(h.input("Page order").value,"1-2");
  await h.dispatch(h.button("Cancel"));await promise;
});
