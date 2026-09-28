// Exercise geometry and real workspace lifecycle/operation code without a PDF
// or a supplier source. Real rendering is covered by the browser journey.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const geometry = require('../static/takeoff-geometry.js');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const blank = () => ({version:1,project_id:'project',revision:0,documents:[],calibrations:[],items:[],transfers:[],render_checks:[],audit_head:null});
const response = (snapshot, session_id='session') => ({session_id,revision:snapshot.revision,snapshot:copy(snapshot),item_results:[],issues:[]});
function harness() {
  const context={window:{CeasefireTakeoffGeometry:geometry,CeasefireProject:{changed(){}}},document:{getElementById(){return null;}},crypto,
    Intl,Number,String,JSON,Object,Set,Map,Array,Promise,Error,URL,Math,console:{...console},setTimeout,clearTimeout};
  vm.createContext(context);
  let source=fs.readFileSync('static/takeoffs.js','utf8');
  source=source.replace('  window.CeasefireTakeoffs = {', '  globalThis.audit = {state,accept,command,ensureSession,snapshotKey,reviewStatus,visibleItems,enrichInspectorOptions,transferSummary,boundInputDetails,notePdfWarning,documentWarnings,installPdfDiagnostics,releaseDocuments,boundedPdf,destroyPdfResources,pdfPage,discardPdf,recordPdfFailure,areaTraceLimit,transfer,detachSelected,manageLinkedRows,splitSelected,mergeSelected,renderInspector,renderRegister,renderOverlay,selectItem,startExclusion,editAreaBoundary,changeAreaCalibration,setTool,discardEditor,setApi(fn){api=fn;}};\n  window.CeasefireTakeoffs = {');
  vm.runInContext(source,context);
  return {context,audit:context.audit,api:context.window.CeasefireTakeoffs};
}
function attachMinimalDom(h) {
  function element(tag='div') {
    const el={tagName:tag.toUpperCase(),children:[],dataset:{},attributes:{},events:{},className:'',_text:'',value:'',
      append(...children){for(const child of children){child.previousElementSibling=this.children.at(-1)||null;this.children.push(child);}},
      replaceChildren(...children){this.children=[];this._text='';this.append(...children);},
      setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.className=String(value);},
      addEventListener(event,listener){this.events[event]=listener;},
      querySelectorAll(selector){return this.children.flatMap(child=>[...((selector==='[data-item-id]'&&child.dataset.itemId)?[child]:[]),...child.querySelectorAll(selector)]);},
    };
    Object.defineProperty(el,'textContent',{get(){return this._text+this.children.map(child=>child.textContent).join('');},set(value){this._text=String(value);this.children=[];}});
    el.classList={toggle(key,on){const values=new Set(el.className.split(/\s+/).filter(Boolean));on?values.add(key):values.delete(key);el.className=[...values].join(' ');},contains(key){return el.className.split(/\s+/).includes(key);}};
    return el;
  }
  h.context.document.createElement=element;h.context.document.createElementNS=(_,tag)=>element(tag);
  const ui={};for(const key of ['inspector','split','merge','bulk','selectionCount','tableWrap','pagination','overlay','message'])ui[key]=element();ui.statusFilter={value:''};h.audit.state.ui=ui;
  return {ui,all(root){return root.children.flatMap(child=>[child,...this.all(child)]);}};
}
let passed=0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async()=>{
  await check('PDF-space round trips preserve original coordinates at rotations, crop offsets and UserUnit scales',()=>{
    for(const matrix of [[2,0,0,-2,-30,200],[0,3,3,0,-120,-60],[-4,0,0,4,900,-24],[0,-.25,-.25,0,200,100]])
      for(const point of [[0,0],[17.125,32.875],[489,792]]){
        const back=geometry.inverse(geometry.transform(point,matrix),matrix);
        assert.ok(Math.abs(back[0]-point[0])<1e-10);assert.ok(Math.abs(back[1]-point[1])<1e-10);
      }
    assert.throws(()=>geometry.inverse([1,2],[1,1,1,1,0,0]),/invertible/);
    assert.throws(()=>geometry.transform([Infinity,0],[1,0,0,1,0,0]),/Invalid/);
  });
  await check('Polyline splits conserve length and vertices without zero-length duplicate split points',()=>{
    const line=[[0,0],[30,0],[30,40]];
    for(const fraction of [0.2,3/7,0.5,0.9]){
      const [first,second]=geometry.split(line,fraction);
      assert.ok(Math.abs(geometry.length(first)+geometry.length(second)-70)<1e-10);
      assert.deepEqual(first.at(-1),second[0]);
      assert.ok(first.every((p,i)=>!i||p[0]!==first[i-1][0]||p[1]!==first[i-1][1]));
      assert.ok(second.every((p,i)=>!i||p[0]!==second[i-1][0]||p[1]!==second[i-1][1]));
    }
    assert.throws(()=>geometry.split(line,1),/inside/);
    assert.deepEqual(geometry.region([20,30],[5,10]),[5,10,15,20]);
  });
  await check('Area paths retain separate closed holes under rotated PDF transforms without changing original geometry',()=>{
    const surface={kind:'polygon',points:[[10,20],[110,20],[110,120],[10,120]],exclusions:[{id:'opening',points:[[30,40],[50,40],[50,60],[30,60]],note:'Window'}]};
    const original=copy(surface),matrix=[0,2,2,0,-40,-20];
    assert.equal(geometry.polygonPath(surface,matrix),'M0,0 L0,200 L200,200 L200,0 Z M40,40 L40,80 L80,80 L80,40 Z');
    assert.deepEqual(surface,original);
    for(const ring of [surface.points,...surface.exclusions.map(value=>value.points)])for(const point of ring)assert.deepEqual(geometry.inverse(geometry.transform(point,matrix),matrix),point);
    assert.throws(()=>geometry.polygonPath({...surface,kind:'polyline'},matrix),/polygon/);
  });
  await check('Source-coordinate editing rejects malformed or duplicated vertices and bounds ring memory',()=>{
    assert.deepEqual(geometry.parseVertices('10, 20\n110 20\n1.1e2, 120\n10, 120'),[[10,20],[110,20],[110,120],[10,120]]);
    for(const text of ['1,2\n3,4','1,2\n3,4\n1,2','1,2\n3,4\nNaN,5','1,2,3\n4,5\n6,7','1,2\n3,4\n5,Infinity','1,2\n3,4\n5,6\n']){
      if(text.endsWith('\n'))assert.deepEqual(geometry.parseVertices(text),[[1,2],[3,4],[5,6]]);else assert.throws(()=>geometry.parseVertices(text));
    }
    assert.throws(()=>geometry.ring(Array.from({length:1001},(_,i)=>[i,i%2])),/1,000/);
  });
  await check('Area tracing reserves the total vertex budget for existing exclusion rings',()=>{
    const h=harness(),value=blank();value.items=[{id:'surface',mode:'wall',geometry:{points:Array.from({length:12},(_,i)=>[i,i]),exclusions:[{points:Array.from({length:20},(_,i)=>[i,i])}]}}];h.audit.accept(response(value));
    h.audit.state.tool='polygon';h.audit.state.retraceId='surface';assert.equal(h.audit.areaTraceLimit(),980);
    h.audit.state.tool='exclusion';h.audit.state.exclusionItemId='surface';assert.equal(h.audit.areaTraceLimit(),968);
    h.audit.state.retraceId=null;h.audit.state.exclusionItemId=null;assert.equal(h.audit.areaTraceLimit(),1000);
  });
  await check('Area sorting and filtering use net square metres and preserve stable selected identities',()=>{
    const h=harness(),value=blank();value.items=[{id:'wall-large',mode:'wall',fields:{mark:'W1',treatment:'Board'},state:'draft',version:1},{id:'wall-small',mode:'wall',fields:{mark:'W2',treatment:'Spray'},state:'draft',version:1},{id:'slab',mode:'slab',fields:{mark:'S1'},state:'draft',version:1}];
    h.audit.accept({...response(value),item_results:[{id:'wall-large',net_area_m2:72},{id:'wall-small',net_area_m2:18},{id:'slab',net_area_m2:5}]});h.audit.state.mode='wall';h.audit.state.sort='area';h.audit.state.selected.add('wall-large');
    assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),['wall-small','wall-large']);
    h.audit.state.filter='spray';assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),['wall-small']);assert.ok(h.audit.state.selected.has('wall-large'));
  });
  await check('Area records cannot invoke calculator transfers, option lookup, link changes or linear split/merge',async()=>{
    const h=harness();let calls=0;h.audit.setApi(async()=>{calls++;throw new Error('Unexpected area calculator request');});
    for(const mode of ['wall','slab']){
      h.audit.state.mode=mode;
      await assert.rejects(h.audit.transfer(false),/cannot transfer/);await assert.rejects(h.audit.transfer(true),/cannot transfer/);
      await assert.rejects(h.audit.detachSelected(),/no calculator/);await assert.rejects(h.audit.manageLinkedRows(),/no calculator/);
      await assert.rejects(h.audit.splitSelected(),/splitting is unavailable/);await assert.rejects(h.audit.mergeSelected(),/merging is unavailable/);
      await h.audit.enrichInspectorOptions({mode},[]);
    }
    assert.equal(calls,0);
  });
  await check('Missing surface geometry remains selectable and editable while geometry tools explain the missing source',async()=>{
    for(const mode of ['wall','slab']){
      const h=harness(),value=blank(),item={id:'diagnostic-surface',mode,version:1,state:'draft',quantity:1,fields:{mark:'Missing source'},geometry:null,measurement:null,evidence:[],member_ids:[]};value.items=[item];
      h.audit.accept({...response(value),item_results:[{id:item.id,issues:[{code:'MISSING_GEOMETRY',message:'Source geometry required.'}]}]});h.audit.state.mode=mode;
      const dom=attachMinimalDom(h);await h.audit.selectItem(item.id);
      assert.ok(h.audit.state.selected.has(item.id));assert.ok(dom.ui.tableWrap.textContent.includes('Source markup missing'));assert.ok(dom.ui.inspector.textContent.includes('Source markup is missing'));
      const buttons=dom.all(dom.ui.inspector).filter(node=>node.tagName==='BUTTON');
      for(const label of ['Change surface calibration','Re-trace geometry','Edit surface vertices','Add excluded opening']){const control=buttons.find(button=>button.textContent===label);assert.equal(control.disabled,true,label);assert.match(control.title,/Attach source geometry/);}
      for(const label of ['Apply item edits','Attach source on current page','Add evidence reference'])assert.ok(!buttons.find(button=>button.textContent===label).disabled,label);
      await assert.rejects(h.audit.startExclusion(),/no source boundary/);await assert.rejects(h.audit.editAreaBoundary(item),/Attach source geometry/);await assert.rejects(h.audit.changeAreaCalibration(item),/Attach source geometry/);
      h.audit.state.retraceId=item.id;assert.equal(h.audit.areaTraceLimit(),1000);
    }
  });
  await check('Area markup and register hover synchronize in both directions using stable identities',()=>{
    const h=harness(),value=blank();value.items=[{id:'surface',mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:'W1'},measurement:{method:'calibrated'},geometry:{kind:'polygon',document_id:'doc',page:1,points:[[0,0],[100,0],[100,100],[0,100]],exclusions:[]},evidence:[]}];
    h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.document='doc';h.audit.state.page=1;h.audit.state.viewport={transform:[1,0,0,-1,0,100]};const {ui}=attachMinimalDom(h);h.audit.renderRegister();h.audit.renderOverlay();
    const row=ui.tableWrap.querySelectorAll('[data-item-id]')[0],hit=ui.overlay.querySelectorAll('[data-item-id]')[0],shape=hit.previousElementSibling;
    hit.events.pointerenter();assert.ok(row.classList.contains('hovered'));assert.ok(shape.classList.contains('hovered'));assert.equal(h.audit.state.hovered,'surface');
    hit.events.pointerleave();assert.ok(!row.classList.contains('hovered'));assert.ok(!shape.classList.contains('hovered'));
    row.events.pointerenter();assert.ok(shape.classList.contains('hovered'));assert.ok(row.classList.contains('hovered'));
    row.events.pointerleave();assert.ok(!shape.classList.contains('hovered'));assert.equal(h.audit.state.hovered,null);
  });
  await check('Changing tools or selection clears abandoned retrace targets before a new linear or surface trace',async()=>{
    for(const [mode,tool] of [['steel','trace'],['duct','trace'],['wall','polygon'],['slab','polygon']]){
      const h=harness();h.audit.state.mode=mode;h.audit.state.calibration='calibration';h.audit.state.viewport={};
      h.audit.state.ui={root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{},overlay:{replaceChildren(){}}};
      h.audit.setTool(tool,{retraceId:'old-item'});assert.equal(h.audit.state.retraceId,'old-item');
      h.audit.setTool('select');assert.equal(h.audit.state.retraceId,null);h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.state.viewport=null;await h.audit.discardEditor();assert.equal(h.audit.state.retraceId,null);
    }
    const h=harness();h.audit.state.mode='wall';h.audit.state.viewport={};h.audit.state.ui={root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{}};
    h.audit.setTool('exclusion',{exclusionItemId:'old-surface'});assert.equal(h.audit.state.exclusionItemId,'old-surface');h.audit.setTool('pan');assert.equal(h.audit.state.exclusionItemId,null);assert.throws(()=>h.audit.setTool('exclusion'),/Select one surface/);
  });
  await check('Selecting an item uses final grouped pagination and expands its collapsed group',async()=>{
    const h=harness(),value=blank();value.items=Array.from({length:101},(_,i)=>({id:`surface-${i}`,mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:String(i),group:i===100?'A':'Z'},geometry:null,measurement:null,evidence:[],member_ids:[]}));
    h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.group='group';h.audit.state.sort='mark';h.audit.state.collapsed.add('A');const {ui}=attachMinimalDom(h);
    await h.audit.selectItem('surface-100',false,false);
    assert.equal(h.audit.state.offset,0);assert.ok(!h.audit.state.collapsed.has('A'));assert.ok(ui.tableWrap.querySelectorAll('[data-item-id]').some(row=>row.dataset.itemId==='surface-100'&&row.classList.contains('selected')));
    h.audit.state.collapsed.add('Z');await h.audit.selectItem('surface-99',false,false);
    assert.equal(h.audit.state.offset,100);assert.ok(!h.audit.state.collapsed.has('Z'));assert.deepEqual(ui.tableWrap.querySelectorAll('[data-item-id]').map(row=>row.dataset.itemId),['surface-99']);
  });
  await check('Opening an empty workspace does not create a project snapshot or mark the project dirty',async()=>{
    const h=harness();h.audit.setApi(async()=>response(blank()));await h.audit.ensureSession();
    assert.equal(h.api.projectSnapshot(),undefined);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Persisted snapshot excludes derived quantities and transient session capabilities',()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',name:'Source.pdf',pages:[]}];
    h.audit.accept({...response(value),item_results:[{id:'a',length_m:123.45}]});
    const saved=h.api.projectSnapshot();assert.equal(saved.session_id,undefined);assert.equal(saved.item_results,undefined);assert.deepEqual(copy(saved),value);
    saved.documents[0].name='Changed';assert.equal(h.api.projectSnapshot().documents[0].name,'Source.pdf');
  });
  await check('Companion-folder publication is a locator update, and edits made during a save remain dirty',()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',pages:[]}];h.audit.accept(response(value));
    const captured=h.api.projectSnapshot();h.api.markProjectSaved({...captured,companion_folder:'Job.takeoffs'},captured);assert.equal(h.api.hasUnsavedChanges(),false);
    h.audit.state.session.snapshot.revision++;h.api.markProjectSaved(captured,captured);assert.equal(h.api.hasUnsavedChanges(),true);
  });
  await check('Unapplied geometry or form edits and in-flight mutations block project snapshots',()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',pages:[]}];h.audit.accept(response(value));
    for(const field of ['busy','modal','formDirty']){h.audit.state[field]=true;assert.throws(()=>h.api.projectSnapshot(),/Finish|Apply/);h.audit.state[field]=false;}
    h.audit.state.points=[[1,2]];assert.throws(()=>h.api.projectSnapshot(),/unfinished/);
  });
  await check('Commands are serialized against the immediately preceding server revision',async()=>{
    const h=harness();h.audit.accept(response(blank()));const calls=[],first=deferred();
    h.audit.setApi(async(path,body)=>{calls.push(copy(body));if(calls.length===1)return first.promise;const value=blank();value.revision=2;return response(value);});
    const a=h.audit.command('undo'),b=h.audit.command('undo');await flush();assert.equal(calls.length,1);assert.equal(calls[0].expected_revision,0);
    const value=blank();value.revision=1;first.resolve(response(value));await Promise.all([a,b]);assert.equal(calls[1].expected_revision,1);assert.notEqual(calls[0].request_id,calls[1].request_id);
  });
  await check('A queued command cannot mutate a replacement project',async()=>{
    const h=harness();h.audit.accept(response(blank(),'old'));const pending=deferred();h.audit.state.queue=pending.promise;let called=false;h.audit.setApi(async()=>{called=true;});
    const command=h.audit.command('undo');h.audit.accept(response(blank(),'new'));pending.resolve();await assert.rejects(command,/project changed/);assert.equal(called,false);
  });
  await check('A late workspace-open response is closed instead of populating a new project',async()=>{
    const h=harness(),pending=deferred(),closed=[];h.audit.setApi(async(path)=>{if(path==='/sessions')return pending.promise;closed.push(path);return {};});
    const opening=h.audit.ensureSession();h.api.applyProject({session:null,saved:null});pending.resolve(response(blank(),'stale'));await assert.rejects(opening,/project changed/);await flush();assert.equal(h.audit.state.session,null);assert.ok(closed.includes('/sessions/stale/close'));
  });
  await check('Prepared loads require an authorised evidence session and do not mutate the current workspace',async()=>{
    const h=harness();h.audit.accept(response(blank(),'current'));await assert.rejects(h.api.prepareProject(blank()),/authorised/);
    h.audit.setApi(async()=>response(blank(),'prepared'));const prepared=await h.api.prepareProject(blank(),'prepared');assert.equal(h.api.sessionId(),'current');assert.equal(prepared.session.session_id,'prepared');
  });
  await check('PDF deadlines abort stalled operations but preserve successful and rejected results',async()=>{
    const h=harness();let aborted=0;
    await assert.rejects(h.audit.boundedPdf(new Promise(()=>{}),'Opening PDF',()=>{aborted++;},5),error=>error.name==='PdfTimeoutError' && /timed out/.test(error.message));assert.equal(aborted,1);
    assert.equal(await h.audit.boundedPdf(Promise.resolve('page'),'Loading PDF page',()=>{aborted++;},20),'page');
    await assert.rejects(h.audit.boundedPdf(Promise.reject(new Error('source changed')),'Loading PDF page',()=>{aborted++;},20),/source changed/);
    assert.equal(aborted,1);
  });
  await check('PDF cleanup terminates workers immediately without waiting for a stalled destroy acknowledgement',()=>{
    const h=harness(),calls=[];
    h.audit.destroyPdfResources({destroy(){calls.push('task');return new Promise(()=>{});}},{destroy(){calls.push('pdfWorker');}},{terminate(){calls.push('terminate');}});
    assert.deepEqual(calls,['task','pdfWorker','terminate']);
  });
  await check('Late PDF callbacks cannot terminate a replacement project or a newer cached worker',async()=>{
    const h=harness(),oldPdf={getPage(){throw new Error('stale PDF should not be accessed');}},newPdf={};let destroyed=0;h.audit.accept(response(blank(),'new'));
    h.audit.state.pdfs.set('new/doc',{document:newPdf,destroy(){destroyed++;}});
    await assert.rejects(h.audit.pdfPage(oldPdf,'doc',1,'old'),error=>error.name==='RenderingCancelledException');assert.equal(destroyed,0);
    h.audit.discardPdf('doc','new',oldPdf);assert.equal(destroyed,0);assert.equal(h.audit.state.pdfs.size,1);
  });
  await check('A stale queued render failure cannot overwrite a newer successful retry',async()=>{
    const h=harness();h.audit.accept(response(blank()));const pending=deferred();h.audit.state.queue=pending.promise;let current=true,requested=false;h.audit.setApi(async()=>{requested=true;return response(blank());});
    const failure=h.audit.recordPdfFailure('doc',1,new Error('old timeout'),'session',false,()=>current);current=false;pending.resolve();await failure;assert.equal(requested,false);
  });
  await check('Worker diagnostics preserve console output, bound payloads, and signal readiness after upstream import',()=>{
    const messages=[],logged=[],context={console:{warn:(...args)=>logged.push(args),error:(...args)=>logged.push(args)},self:{postMessage:data=>messages.push(data)},String};
    vm.createContext(context);let source=fs.readFileSync('static/takeoff-pdf-worker.mjs','utf8');
    assert.ok(source.includes('await import("/vendor/pdfjs/build/pdf.worker.mjs");'));
    source=source.replace('await import("/vendor/pdfjs/build/pdf.worker.mjs");','');vm.runInContext(source,context);
    for(let i=0;i<25;i++)context.console.warn('X'.repeat(700));
    assert.equal(messages[0].ceasefire_pdf_ready,true);assert.equal(messages.length,21);assert.equal(messages[1].ceasefire_pdf_warning.length,500);assert.equal(logged.length,25);
  });
  await check('Late document warnings invalidate all prior render proofs and remain bounded and deduplicated',async()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',pages:[{page:1},{page:2}]}];value.render_checks=[{document_id:'doc',page:1,success:true,warnings:[]},{document_id:'doc',page:2,success:true,warnings:[]}];h.audit.accept(response(value));h.audit.state.document='doc';h.audit.state.page=1;
    const calls=[];h.audit.setApi(async(path,body)=>{calls.push(copy(body));const next=copy(h.audit.state.session.snapshot);next.revision++;next.render_checks=next.render_checks.filter(row=>row.page!==body.page);next.render_checks.push({document_id:body.document_id,page:body.page,success:body.success,warnings:body.warnings});return response(next);});
    h.audit.notePdfWarning('doc','Image removed after failed decoding');await h.audit.state.queue;
    assert.equal(calls.length,2);assert.ok(calls.every(row=>row.success===false));
    h.audit.notePdfWarning('doc','Image removed after failed decoding');await h.audit.state.queue;assert.equal(calls.length,2);
    h.audit.notePdfWarning('doc','Old project warning','discarded-session');assert.equal(calls.length,2);
    h.audit.state.pdfWarnings.clear();assert.equal(h.audit.documentWarnings('doc').length,1);
  });
  await check('Main-thread PDF warnings affect the active drawing without contaminating other cached documents',async()=>{
    const h=harness(),value=blank();value.documents=[{id:'original',pages:[{page:1}]},{id:'failing',pages:[{page:1}]}];value.render_checks=[{document_id:'original',page:1,success:true,warnings:[]}];h.audit.accept(response(value));h.audit.state.document='failing';h.audit.state.pdfs.set('session/original',{});h.audit.state.pdfs.set('session/failing',{});h.context.console.warn=()=>{};
    const calls=[];h.audit.setApi(async(path,body)=>{calls.push(copy(body));const next=copy(h.audit.state.session.snapshot);next.revision++;return response(next);});h.audit.installPdfDiagnostics();
    vm.runInContext('console.warn("Corrupt image")',h.context,{filename:'http://localhost/vendor/pdfjs/build/pdf.mjs'});await h.audit.state.queue;
    assert.equal(calls.length,1);assert.equal(calls[0].document_id,'failing');assert.equal(h.audit.documentWarnings('original').length,0);h.audit.state.consoleRestore();
  });
  await check('PDF resources and global diagnostics are released when a project is discarded',async()=>{
    const h=harness();let destroyed=0,cancelled=0;h.audit.state.pdfs.set('session/doc',{destroy:async()=>{destroyed++;}});h.audit.state.thumbnailTasks.set('canvas',{cancel(){cancelled++;}});h.audit.state.pdfWarnings.set('doc',['warning']);
    h.audit.installPdfDiagnostics();assert.equal(typeof h.audit.state.consoleRestore,'function');await h.audit.releaseDocuments();
    assert.equal(destroyed,1);assert.equal(cancelled,1);assert.equal(h.audit.state.pdfs.size,0);assert.equal(h.audit.state.pdfWarnings.size,0);assert.equal(h.audit.state.consoleRestore,null);
  });
  await check('Review labels expose blocked and incomplete evidence ahead of a claimed confirmation',()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const item={id:'item',state:'confirmed'};
    h.audit.state.resultMap.set('item',{issues:[{code:'PAGE_REVIEW_BLOCKED'}]});assert.equal(h.audit.reviewStatus(item).label,'Blocked');
    h.audit.state.resultMap.set('item',{issues:[{code:'MISSING_MEASUREMENT'}]});assert.equal(h.audit.reviewStatus(item).label,'Insufficient evidence');
    h.audit.state.resultMap.set('item',{issues:[]});assert.equal(h.audit.reviewStatus(item).label,'Confirmed');
    assert.equal(h.audit.reviewStatus({...item,state:'draft',version:1}).label,'Draft');
    assert.equal(h.audit.reviewStatus({...item,state:'draft',version:2}).label,'Needs review');
    assert.equal(h.audit.reviewStatus({...item,state:'reviewed'}).label,'Reviewed');
  });
  await check('Board choices follow the current unsaved member type and product instead of stale saved requirements',async()=>{
    const h=harness(),value=blank(),item={id:'member',mode:'steel',fields:{member_type:'Column',product:'Old product'}};
    value.items=[item];h.audit.accept(response(value));h.audit.state.selected.add(item.id);h.audit.state.ui={target:{value:'steel_board'}};
    const control=(name,value)=>({name,value,dataset:{},addEventListener(event,callback){this[event]=callback;}});
    const member=control('member_type','Beam'),product=control('product','TRAFALGAR COREX'),controls=[{control:member},{control:product}],paths=[];
    h.audit.setApi(async path=>{paths.push(path);return {columns:[]};});
    await h.audit.enrichInspectorOptions(item,controls);
    assert.equal(new URL(paths.at(-1),'http://localhost').searchParams.get('member_type'),'Beam');
    member.value='Column';member.change();await flush();
    let query=new URL(paths.at(-1),'http://localhost').searchParams;assert.equal(query.get('member_type'),'Column');assert.equal(query.get('product'),'TRAFALGAR COREX');
    product.value='PROMATECT 250';product.change();await flush();query=new URL(paths.at(-1),'http://localhost').searchParams;
    assert.equal(query.get('product'),'PROMATECT 250');assert.equal(query.get('member_type'),'Column');
  });
  await check('Transfer review shows exact mapped values, physical quantities and native notes in readable labels',()=>{
    const h=harness(),item={id:'member',mode:'steel',quantity:3,fields:{mark:'B17'}},binding={item_id:'member',sheet:'CALCULATOR',row:9,values:{A9:'B17',F9:.370370367,L9:0,X9:null}};
    const columns=[{column:'A',label:'Member mark'},{column:'F',label:'Lineal metres'},{column:'L',label:'Waste'},{column:'X',label:'Design reference'}];
    const preview={calculator_id:'steel_board',changes:[{item_id:'member',action:'append'}],bindings:[binding],warnings:[{item_id:'member',status:'CLADDING ESTIMATE',message:'Add supports separately.'}]};
    const summary=h.audit.transferSummary(preview,[item],[{id:'member',length_m:.123456789,total_length_m:.370370367}],columns);
    for(const text of ['Add: B17','Source ID: member','Steel Board · CALCULATOR row 9','Physical quantity: 3','Per-member length: 0.123456789 m','Total length: 0.370370367 m','Lineal metres: 0.370370367','Waste: 0','CLADDING ESTIMATE','Add supports separately.'])assert.ok(summary.includes(text),text);
    assert.ok(!summary.includes('Design reference:'));assert.ok(!summary.includes('"changes"'));
  });
  console.log(`${passed} takeoff UI and geometry checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
