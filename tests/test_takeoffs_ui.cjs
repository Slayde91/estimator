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
  source=source.replace('  window.CeasefireTakeoffs = {', '  globalThis.audit = {state,accept,command,ensureSession,editableFields,settingsSelectedItems,renderSettingsPanel,applySettings,markSettingsEdited,appearanceOf,snapshotKey,reviewStatus,visibleItems,enrichInspectorOptions,transferSummary,boundInputDetails,notePdfWarning,documentWarnings,installPdfDiagnostics,releaseDocuments,boundedPdf,destroyPdfResources,pdfPage,discardPdf,recordPdfFailure,areaTraceLimit,transfer,detachSelected,manageLinkedRows,splitSelected,mergeSelected,renderRegister,renderOverlay,selectItem,startExclusion,editAreaBoundary,changeAreaCalibration,setTool,discardEditor,requireFinishedEdits,normalizePhysicalImages,button,creationFields,configureSteelCreation,createDrawnItem,itemEditChanges,lengthSummary,parsedLengthAddition,editLengthAddition,removeLengthAddition,confirmSelected,itemGroup,setApi(fn){api=fn;},setAsk(fn){ask=fn;},setCommand(fn){command=fn;}};\n  window.CeasefireTakeoffs = {');
  source=source.replace('setApi(fn){api=fn;}', 'renderControlPoints,pointReference,pointTarget,pointRemovalReason,removeControlPoint,planKeydown,handoffPlanWheel,downloadTakeoff,renderPage,drawingPointer,finishTrace,finishTraceFromDoubleClick,changeLength,itemCalibrations,useRectangularDuct,setFinishTrace(fn){finishTrace=fn;},setPdfTools(documentFn,pageFn){pdfDocument=documentFn;pdfPage=pageFn;},setApi(fn){api=fn;}');
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
    el.classList={add(...keys){const values=new Set(el.className.split(/\s+/).filter(Boolean));keys.forEach(key=>values.add(key));el.className=[...values].join(' ');},toggle(key,on){const values=new Set(el.className.split(/\s+/).filter(Boolean));on?values.add(key):values.delete(key);el.className=[...values].join(' ');},contains(key){return el.className.split(/\s+/).includes(key);}};
    return el;
  }
  h.context.document.createElement=element;h.context.document.createElementNS=(_,tag)=>element(tag);
  const ui={};for(const key of ['split','merge','bulk','selectionCount','tableWrap','pagination','overlay','message'])ui[key]=element();ui.statusFilter={value:''};h.audit.state.ui=ui;
  return {ui,element,all(root){return root.children.flatMap(child=>[child,...this.all(child)]);}};
}
let passed=0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async()=>{
  await check('Every point of one maximum-size trace is inspectable and larger selections disclose bounded handle coverage',()=>{
    const h=harness(),value=blank(),make=(id,n)=>({id,mode:'steel',fields:{mark:id},geometry:{document_id:'doc',page:3,points:Array.from({length:n},(_,i)=>[20+i*.001,30+i*.002])},measurement:{method:'calibrated',calibration_id:'scale'}});value.items=[make('long',10000),make('extra',3)];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'steel',tool:'select',selected:new Set(['long']),viewport:{transform:[0,2,2,0,-60,-40],width:200,height:200}});const dom=attachMinimalDom(h);dom.ui.controlStatus=dom.element();h.audit.renderControlPoints(dom.ui.overlay);let points=dom.all(dom.ui.overlay).filter(el=>el.className.includes('takeoff-control-point'));assert.equal(points.length,10000);assert.equal(points.at(-1).dataset.pointIndex,'9999');assert.ok(!dom.ui.controlStatus.textContent.includes('Showing'));
    h.audit.state.selected.add('extra');dom.ui.overlay.replaceChildren();h.audit.renderControlPoints(dom.ui.overlay);points=dom.all(dom.ui.overlay).filter(el=>el.className.includes('takeoff-control-point'));assert.equal(points.length,10000);assert.match(dom.ui.controlStatus.textContent,/Showing 10000 of 10003/);
  });
  await check('Control-point deletion binds the exact visible source revision and sends only its copied geometry',async()=>{
    const h=harness(),value=blank(),item={id:'a',mode:'steel',quantity:1,fields:{mark:'A'},geometry:{document_id:'doc',page:3,points:[[20.123456789,30],[40,50],[60,90],[80,100]]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'steel',selected:new Set(['a'])});
    const reference=h.audit.pointReference(item,1),before=copy(item);let sent;h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);sent={op,...copy(body)};});await h.audit.removeControlPoint(reference);
    assert.deepEqual(sent,{op:'update_item',item_id:'a',changes:{geometry:{...item.geometry,points:[item.geometry.points[0],item.geometry.points[2],item.geometry.points[3]]}}});assert.deepEqual(item,before);assert.equal(sent.changes.geometry.points[0][0],20.123456789);
    h.audit.state.session.revision++;await assert.rejects(h.audit.removeControlPoint(reference),/selection changed/);h.audit.state.session.revision--;h.audit.state.hidden.add('a');await assert.rejects(h.audit.removeControlPoint(reference),/selection changed/);h.audit.state.hidden.clear();h.audit.state.filter='absent';await assert.rejects(h.audit.removeControlPoint(reference),/visible selection/);h.audit.state.filter='';h.audit.state.formDirty=true;await assert.rejects(h.audit.removeControlPoint(reference),/unfinished/);
  });
  await check('Control-point removal keeps line/polygon minima and exclusion identities and never removes cited dimension markers',async()=>{
    const h=harness(),value=blank(),item={id:'a',mode:'wall',fields:{mark:'W'},geometry:{kind:'polygon',document_id:'doc',page:3,points:[[0,0],[100,0],[100,100],[0,100]],exclusions:[{id:'hole',note:'source opening',points:[[20,20],[40,20],[40,40],[20,40]]}]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'wall',selected:new Set(['a'])});let sent;h.audit.setCommand(async(op,body)=>{sent=copy(body);});
    await h.audit.removeControlPoint(h.audit.pointReference(item,1,'hole'));assert.equal(sent.changes.geometry.exclusions[0].id,'hole');assert.equal(sent.changes.geometry.exclusions[0].note,'source opening');assert.equal(sent.changes.geometry.exclusions[0].points.length,3);assert.deepEqual(sent.changes.geometry.points,item.geometry.points);
    const current=h.audit.state.session.snapshot.items[0];current.geometry.exclusions[0].points.pop();assert.match(h.audit.pointRemovalReason(h.audit.pointReference(current,0,'hole')),/at least 3/);current.geometry.points.pop();assert.match(h.audit.pointRemovalReason(h.audit.pointReference(current,0)),/at least 3/);
    current.mode='steel';h.audit.state.mode='steel';delete current.geometry.kind;delete current.geometry.exclusions;current.geometry.points.pop();assert.match(h.audit.pointRemovalReason(h.audit.pointReference(current,0)),/at least 2/);current.measurement.method='cited';assert.match(h.audit.pointRemovalReason(h.audit.pointReference(current,0)),/cited source region/);
  });
  await check('Control-Z removes one pending vertex but leaves native field undo, dirty traces and shifted shortcuts untouched',()=>{
    const h=harness();h.audit.state.tool='trace';h.audit.state.points=[[1,2],[3,4],[5,6]];let prevented=0;const event={key:'z',ctrlKey:true,preventDefault(){prevented++;},target:{closest(){return null;}}};h.audit.planKeydown(event);assert.deepEqual(copy(h.audit.state.points),[[1,2],[3,4]]);assert.equal(prevented,1);
    h.audit.planKeydown({...event,target:{closest(){return {};}}});assert.equal(h.audit.state.points.length,2);h.audit.planKeydown({...event,shiftKey:true});assert.equal(h.audit.state.points.length,2);h.audit.state.settingsDirty=true;h.audit.planKeydown(event);assert.equal(h.audit.state.points.length,2);
  });
  await check('Plan control-Z consumes unsupported selection undo without undoing earlier page or form inputs',()=>{
    const h=harness(),value=blank();value.items=[{id:'a',mode:'steel',fields:{}},{id:'b',mode:'steel',fields:{}}];h.audit.accept(response(value));const dom=attachMinimalDom(h);Object.assign(h.audit.state,{tool:'select',mode:'steel',selected:new Set(['a','b'])});let prevented=0;
    const event={key:'z',ctrlKey:true,preventDefault(){prevented++;},target:{closest(){return null;}}};h.audit.planKeydown(event);assert.equal(prevented,1);assert.match(dom.ui.message.textContent,/Choose one control point/);assert.deepEqual(copy(h.audit.state.session.snapshot),value);
    h.audit.state.selected.clear();h.audit.planKeydown(event);assert.equal(prevented,2);for(const tool of ['pan','trace']){h.audit.state.tool=tool;h.audit.planKeydown(event);}h.audit.state.mode='physical';h.audit.planKeydown(event);assert.equal(prevented,5);h.audit.planKeydown({...event,target:{closest(){return {};}}});assert.equal(prevented,5);
  });
  await check('Focused plan wheel hands off at both edges with explicit delta units and clamped outer bounds',()=>{
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollTop:200,scrollHeight:300,clientHeight:100};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;let prevented=0;
    const event={cancelable:true,deltaY:220,deltaX:0,deltaMode:0,preventDefault(){prevented++;}};assert.equal(h.audit.handoffPlanWheel(event),true);assert.equal(outer.scrollTop,320);assert.equal(viewport.scrollTop,200);
    viewport.scrollTop=0;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-3,deltaMode:1}),true);assert.equal(outer.scrollTop,272);assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-1,deltaMode:2}),true);assert.equal(outer.scrollTop,172);
    assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-500}),true);assert.equal(outer.scrollTop,0);viewport.scrollTop=200;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:2000}),true);assert.equal(outer.scrollTop,1000);assert.equal(prevented,5);
  });
  await check('Plan wheel leaves ordinary internal scrolling, native fields, modifiers and exhausted outer space untouched',()=>{
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollTop:100,scrollHeight:300,clientHeight:100};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;
    const event={cancelable:true,deltaY:20,deltaX:0,preventDefault(){throw new Error('Native wheel was intercepted');}};assert.equal(h.audit.handoffPlanWheel(event),false);viewport.scrollTop=200;
    for(const change of [{cancelable:false},{defaultPrevented:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{deltaX:40},{deltaY:0},{deltaY:NaN},{deltaX:Infinity},{target:{isContentEditable:true}},{target:{closest(){return {};}}}])assert.equal(h.audit.handoffPlanWheel({...event,...change}),false);
    h.audit.state.planActive=false;assert.equal(h.audit.handoffPlanWheel(event),false);h.audit.state.planActive=true;outer.scrollTop=1000;assert.equal(h.audit.handoffPlanWheel(event),false);outer.scrollTop=0;viewport.scrollTop=0;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-20}),false);assert.equal(viewport.scrollTop,0);assert.equal(outer.scrollTop,0);
  });
  await check('A changed calculator draft during export cannot publish the captured linked result',async()=>{
    const h=harness(),value=blank(),body=deferred();value.items=[{id:'a',mode:'steel',fields:{mark:'A'}}];h.audit.accept(response(value));
    let fingerprint='before',downloads=0,fetches=0;
    h.context.window.CeasefireCalculators={captureTakeoffTarget:async()=>({inputs:{},schedule_rows:1,fingerprint}),projectFingerprint:()=>fingerprint};
    h.context.fetch=async()=>{fetches++;return{ok:true,blob:()=>body.promise};};
    h.context.URL={createObjectURL(){downloads++;return'blob:unused';}};
    const pending=h.audit.downloadTakeoff('schedule-xlsx');await flush();assert.equal(fetches,1);fingerprint='manual-edit';body.resolve({});
    await assert.rejects(pending,/calculator draft changed during export/);assert.equal(downloads,0);assert.equal(h.audit.state.busy,false);
  });
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
      assert.ok(h.audit.state.selected.has(item.id));assert.ok(dom.ui.tableWrap.textContent.includes('Source markup missing'));assert.ok(h.audit.state.registerEditor.panel.textContent.includes('Source markup is missing'));
      const buttons=dom.all(h.audit.state.registerEditor.panel).filter(node=>node.tagName==='BUTTON');
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
      attachMinimalDom(h);Object.assign(h.audit.state.ui,{root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{}});
      h.audit.setTool(tool,{retraceId:'old-item'});assert.equal(h.audit.state.retraceId,'old-item');
      h.audit.setTool('select');assert.equal(h.audit.state.retraceId,null);h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.state.viewport=null;await h.audit.discardEditor();assert.equal(h.audit.state.retraceId,null);
    }
    const h=harness();h.audit.state.mode='wall';h.audit.state.viewport={};attachMinimalDom(h);Object.assign(h.audit.state.ui,{root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{}});
    h.audit.setTool('exclusion',{exclusionItemId:'old-surface'});assert.equal(h.audit.state.exclusionItemId,'old-surface');h.audit.setTool('pan');assert.equal(h.audit.state.exclusionItemId,null);assert.throws(()=>h.audit.setTool('exclusion'),/Select one surface/);
  });
  await check('Dirty register edits block every geometry-writing tool and zero-point manual calibration is cancellable',async()=>{
    const h=harness();h.audit.state.calibration='scale';h.audit.state.viewport={};h.audit.state.ui={root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{},overlay:{replaceChildren(){}}};
    h.audit.state.formDirty=true;
    for(const tool of ['trace','calibrate','viewport','polygon','exclusion']){h.audit.state.mode=['polygon','exclusion'].includes(tool)?'wall':'steel';assert.throws(()=>h.audit.setTool(tool),/unfinished/);assert.equal(h.audit.state.formDirty,true);}
    h.audit.state.formDirty=false;h.audit.state.viewport=null;h.audit.state.calibrationTarget='stale-viewport';h.audit.state.tool='calibrate';await h.audit.discardEditor();assert.equal(h.audit.state.calibrationTarget,null);assert.equal(h.audit.state.tool,'select');
    h.audit.state.calibrationTarget='stale-viewport';h.audit.state.tool='calibrate';h.audit.requireFinishedEdits();assert.equal(h.audit.state.calibrationTarget,null);assert.equal(h.audit.state.tool,'select');
    h.audit.state.calibrationTarget='active-viewport';h.audit.state.points=[[10,10]];assert.throws(()=>h.audit.requireFinishedEdits(),/unfinished/);assert.equal(h.audit.state.calibrationTarget,'active-viewport');assert.equal(h.audit.state.points.length,1);
  });
  await check('Active drawing tools recheck later register edits before recording or finishing geometry',async()=>{
    for(const tool of ['trace','polygon','exclusion','calibrate','viewport']){
      const h=harness();const dom=attachMinimalDom(h);h.audit.state.viewport={};h.audit.state.tool=tool;h.audit.state.points=[[1,1],[2,2]];h.audit.state.formDirty=true;
      h.audit.drawingPointer({button:0,detail:1,preventDefault(){throw new Error('Dirty drawing must stop before pointer transforms');}});
      assert.deepEqual(copy(h.audit.state.points),[[1,1],[2,2]]);assert.equal(h.audit.state.formDirty,true);assert.match(dom.ui.message.textContent,/unfinished item(?:\/settings)? edits/);
      await assert.rejects(h.audit.finishTrace(),/unfinished item(?:\/settings)? edits/);assert.deepEqual(copy(h.audit.state.points),[[1,1],[2,2]]);assert.equal(h.audit.state.formDirty,true);
    }
  });
  await check('Selecting an item uses final grouped pagination and expands its collapsed group',async()=>{
    const h=harness(),value=blank();value.items=Array.from({length:101},(_,i)=>({id:`surface-${i}`,mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:String(i),group:i===100?'A':'Z'},geometry:null,measurement:null,evidence:[],member_ids:[]}));
    h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.group='group';h.audit.state.sort='mark';h.audit.state.collapsed.add('A');const {ui}=attachMinimalDom(h);
    await h.audit.selectItem('surface-100',false,false);
    assert.equal(h.audit.state.offset,0);assert.ok(!h.audit.state.collapsed.has('A'));assert.ok(ui.tableWrap.querySelectorAll('[data-item-id]').some(row=>row.dataset.itemId==='surface-100'&&row.classList.contains('selected')));
    h.audit.state.collapsed.add('Z');await h.audit.selectItem('surface-99',false,false);
    assert.equal(h.audit.state.offset,100);assert.ok(!h.audit.state.collapsed.has('Z'));assert.deepEqual(ui.tableWrap.querySelectorAll('[data-item-id]').map(row=>row.dataset.itemId),['surface-99']);
  });
  await check('Register keeps the exact unfinished editor while filtering, grouping and paging hide its source row',async()=>{
    const h=harness(),value=blank(),item={id:'surface',mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:'W1',level:'L01',group:'West'},geometry:null,measurement:null,evidence:[],member_ids:[]};
    value.items=[item];h.audit.accept(response(value));h.audit.state.mode='wall';const dom=attachMinimalDom(h);await h.audit.selectItem(item.id,false,false);
    const editor=h.audit.state.registerEditor,level=editor.controls.find(field=>field.control.name==='level').control;
    assert.equal(editor.panel.dataset.editorItemId,item.id);assert.ok(dom.all(dom.ui.tableWrap).includes(editor.panel));assert.equal(dom.ui.inspector,undefined);
    level.value='L02';level.events.input();const before=copy(h.audit.state.session.snapshot);
    h.audit.state.filter='No matching item';h.audit.renderRegister();assert.equal(h.audit.state.registerEditor,editor);assert.equal(level.value,'L02');assert.ok(dom.ui.tableWrap.textContent.includes('unfinished edits are kept here'));
    h.audit.state.filter='';h.audit.state.group='group';h.audit.state.collapsed.add('West');h.audit.renderRegister();assert.equal(h.audit.state.registerEditor,editor);assert.ok(dom.all(dom.ui.tableWrap).includes(editor.panel));
    assert.throws(()=>h.api.projectSnapshot(),/unfinished/);assert.deepEqual(copy(h.audit.state.session.snapshot),before);
    const discard=dom.all(editor.panel).find(node=>node.tagName==='BUTTON'&&node.textContent==='Discard edits');discard.events.click();await flush();
    assert.equal(h.audit.state.formDirty,false);assert.notEqual(h.audit.state.registerEditor,editor);assert.equal(h.audit.state.registerEditor.controls.find(field=>field.control.name==='level').control.value,'L01');assert.deepEqual(copy(h.api.projectSnapshot()),before);
  });
  await check('Header select and hide actions cover every filtered match beyond pagination and preserve other modes',async()=>{
    const h=harness(),value=blank();value.items=Array.from({length:101},(_,n)=>({id:`wall-${n}`,mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:`W${n}`,level:n%2?'ODD':'EVEN'},geometry:null,measurement:null,evidence:[],member_ids:[]}));value.items.push({id:'other-mode',mode:'slab',fields:{mark:'Other'}});h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.selected.add('other-mode');h.audit.state.selected.add('wall-0');const dom=attachMinimalDom(h);
    const control=label=>dom.all(dom.ui.tableWrap).find(node=>node.attributes['aria-label']===label),toggle=async(label,checked)=>{const node=control(label);node.checked=checked;node.events.change();await flush();};
    h.audit.renderRegister();assert.equal(dom.ui.tableWrap.querySelectorAll('[data-item-id]').length,100);assert.equal(control('Select all matching items').indeterminate,true);
    await toggle('Select all matching items',true);assert.equal(h.audit.state.selected.size,102);assert.ok(h.audit.state.selected.has('wall-100'));assert.equal(control('Select all matching items').checked,true);
    await toggle('Hide all matching items',true);assert.equal(h.audit.state.hidden.size,101);assert.ok(h.audit.state.hidden.has('wall-100'));assert.ok(!h.audit.state.hidden.has('other-mode'));
    h.audit.state.filter='ODD'.toLowerCase();h.audit.renderRegister();await toggle('Select all matching items',false);await toggle('Hide all matching items',false);assert.equal(h.audit.state.selected.size,52);assert.equal(h.audit.state.hidden.size,51);assert.ok(h.audit.state.selected.has('other-mode'));assert.ok(h.audit.state.hidden.has('wall-100'));assert.ok(!h.audit.state.hidden.has('wall-99'));
    h.audit.state.filter='';h.audit.renderRegister();assert.equal(control('Hide all matching items').indeterminate,true);assert.equal(control('Select all matching items').indeterminate,true);
    h.audit.state.filter='no matches';h.audit.renderRegister();assert.equal(control('Select all matching items').disabled,true);assert.equal(control('Hide all matching items').disabled,true);
  });
  await check('Settings show the first selected record and apply only explicitly edited fields across heterogeneous items',async()=>{
    const h=harness(),value=blank();value.items=[{id:'a',mode:'steel',quantity:1,fields:{mark:'A',level:'L1',fire_period_min:120,zone:'keptA',notes:'originalA'}},{id:'b',mode:'steel',quantity:2,fields:{mark:'B',level:'L2',fire_period_min:90,zone:'keptB',notes:'originalB'}}];h.audit.accept(response(value));const dom=attachMinimalDom(h);dom.ui.settingsPanel=dom.element();dom.ui.layout=dom.element();dom.ui.tools={settings:dom.element()};dom.ui.target={value:'steel_vermiculite'};h.audit.state.settingsOpen=true;h.audit.state.selected=new Set(['b','a']);h.audit.setApi(async()=>({columns:[]}));h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor;assert.deepEqual(copy(editor.ids),['b','a']);assert.equal(editor.quantity.control.value,2);assert.equal(editor.fields.find(field=>field.control.name==='fire_period_min').control.value,90);assert.ok(editor.fields.every(field=>!['notes','zone','group'].includes(field.control.name)));
    const level=editor.fields.find(field=>field.control.name==='level').control;level.value='SHARED';level.events.input();assert.equal(h.audit.state.settingsDirty,true);assert.throws(()=>h.api.projectSnapshot(),/unfinished/);
    let sent;h.audit.setAsk(async()=>({}));h.audit.setCommand(async(op,body)=>{sent={op,...copy(body)};});await h.audit.applySettings(editor);assert.deepEqual(sent,{op:'bulk_update',item_ids:['b','a'],changes:{fields:{level:'SHARED'}}});assert.equal(h.audit.state.settingsDirty,false);assert.equal(value.items[0].fields.notes,'originalA');assert.equal(value.items[1].quantity,2);
    sent=null;await h.audit.applySettings(h.audit.state.settingsEditor);assert.equal(sent,null);
    const oldEditor=h.audit.state.settingsEditor,oldLevel=oldEditor.fields.find(field=>field.control.name==='level').control,held=deferred();oldLevel.value='CAPTURED';oldLevel.events.input();h.audit.setCommand(()=>held.promise);const applying=h.audit.applySettings(oldEditor);await flush();
    h.audit.state.settingsDirty=false;h.audit.state.settingsEditor=null;h.audit.renderSettingsPanel();const newer=h.audit.state.settingsEditor,newLevel=newer.fields.find(field=>field.control.name==='level').control;newLevel.value='LATER';newLevel.events.input();held.resolve({});await applying;
    assert.equal(h.audit.state.settingsEditor,newer);assert.equal(h.audit.state.settingsDirty,true);assert.equal(newLevel.value,'LATER');assert.throws(()=>h.api.projectSnapshot(),/unfinished/);
  });
  await check('Marquee bounds and geometry translation preserve source precision, exclusion identities and original evidence objects',()=>{
    const shape={kind:'polygon',document_id:'d',page:3,points:[[10.125,20.375],[30.625,20.375],[30.625,40.875],[10.125,40.875]],exclusions:[{id:'hole',note:'retained',points:[[12,23],[15,23],[15,26],[12,26]]}]},before=copy(shape),delta=[.123456789,5.987654321];
    assert.equal(geometry.enclosed(shape.points,[10,20,31,41]),true);assert.equal(geometry.enclosed(shape.points,[11,20,31,41]),false);
    const moved=geometry.translateGeometry(shape,delta);assert.deepEqual(shape,before);assert.equal(moved.exclusions[0].id,'hole');assert.equal(moved.exclusions[0].note,'retained');for(let n=0;n<shape.points.length;n++)for(let axis=0;axis<2;axis++)assert.equal(moved.points[n][axis],shape.points[n][axis]+delta[axis]);assert.deepEqual(moved.exclusions[0].points[0],[12+delta[0],23+delta[1]]);
    assert.throws(()=>geometry.translateGeometry(shape,[NaN,1]),/Invalid/);
  });
  await check('Opening an empty workspace does not create a project snapshot or mark the project dirty',async()=>{
    const h=harness();h.audit.setApi(async()=>response(blank()));await h.audit.ensureSession();
    assert.equal(h.api.projectSnapshot(),undefined);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Version-two physical-only drafts and retained image records are preserved even without linear items',()=>{
    const h=harness(),value={...blank(),version:2,physical:{id:'physical',revision:1,barriers:[{id:'barrier'}]},image_extractions:[]};h.audit.accept(response(value));assert.deepEqual(copy(h.api.projectSnapshot()),value);
    value.physical=null;value.image_extractions=[{id:'extraction',pages:[1]}];h.audit.accept(response(value));assert.deepEqual(copy(h.api.projectSnapshot()),value);
  });
  await check('Physical forms participate in save, dirty, fingerprint and project-reset protection',async()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));let dirty=true,destroyed=false,revision=1;h.audit.state.physicalUI={hasUnfinishedChanges:()=>dirty,editRevision:()=>revision,render(){},destroy(){destroyed=true;}};
    assert.equal(h.api.hasUnsavedChanges(),true);assert.throws(()=>h.api.projectSnapshot(),/physical edits/);assert.equal(JSON.parse(h.api.projectFingerprint()).physicalUnfinished,true);await assert.rejects(h.audit.discardEditor(),/physical edits/);
    const first=h.api.projectFingerprint();revision++;assert.notEqual(h.api.projectFingerprint(),first);assert.equal(JSON.parse(h.api.projectFingerprint()).physicalUnfinished,true);
    dirty=false;h.api.applyProject({session:null,saved:null});assert.equal(destroyed,true);assert.equal(h.audit.state.physicalUI,null);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Image inventory preserves failed occurrences and explicit page coverage without counting issue reports as images',()=>{
    const h=harness();h.audit.accept(response(blank()));const records=h.audit.normalizePhysicalImages({items:[{asset_id:'asset',image_id:'image',image_sha256:null,has_rendition:false,occurrence_id:'occurrence',document_id:'doc',page:1,issues:['Decode failed']}],extractions:[{document_id:'doc',document_sha256:'d'.repeat(64),pages:[1,2],page_results:[{page:1,status:'incomplete',occurrence_ids:['occurrence'],issues:['Image failed']},{page:2,status:'complete',occurrence_ids:[],issues:[]}]}]});
    assert.equal(records.length,3);assert.equal(records[0].coverage_only,undefined);assert.ok(records[0].issues.includes('Decode failed'));assert.ok(records[0].issues.some(issue=>issue.includes('no retained display bitmap')));assert.equal(records[1].coverage_only,true);assert.equal(records[1].page,1);assert.ok(records[2].coverage.includes('0 image occurrences'));assert.equal(records[2].page,2);
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
  await check('Confirmation labels collapse historic states without hiding evidence issues or trusting stale confirmations',()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const item={id:'item',state:'confirmed'};
    h.audit.state.resultMap.set('item',{issues:[{code:'PAGE_REVIEW_BLOCKED'}]});assert.equal(h.audit.reviewStatus(item).label,'Unconfirmed');assert.equal(h.audit.state.resultMap.get('item').issues[0].code,'PAGE_REVIEW_BLOCKED');
    h.audit.state.resultMap.set('item',{issues:[{code:'MISSING_MEASUREMENT'}]});assert.equal(h.audit.reviewStatus(item).label,'Unconfirmed');
    h.audit.state.resultMap.set('item',{issues:[]});assert.equal(h.audit.reviewStatus(item).label,'Confirmed');
    assert.equal(h.audit.reviewStatus({...item,state:'draft',version:1}).label,'Unconfirmed');
    assert.equal(h.audit.reviewStatus({...item,state:'draft',version:2}).label,'Unconfirmed');
    assert.equal(h.audit.reviewStatus({...item,state:'reviewed'}).label,'Unconfirmed');
    assert.equal(item.state,'confirmed');
  });
  await check('Icon actions keep original accessible names/tooltips and the Add to Schedule plus glyph',()=>{
    const h=harness(),dom=attachMinimalDom(h);
    for(const label of ['‹ Page','Page ›','Select','Pan','Trace length','Fit page','Cancel trace','Upload PDFs','Search','Stop search','Preview transfer']){
      const control=h.audit.button(label,()=>{});assert.equal(control.attributes['aria-label'],label);assert.equal(control.title,label);assert.ok(control.classList.contains('icon-only'));assert.equal(control.children.at(-1).textContent,label);assert.ok(control.children.at(-1).classList.contains('sr-only'));
      if(label==='Preview transfer')assert.equal(control.children[0].textContent,'+');else assert.equal(dom.all(control).filter(node=>node.tagName==='SVG').length,1);
    }
    const ordinary=h.audit.button('Confirm',()=>{});assert.equal(ordinary.textContent,'Confirm');assert.ok(!ordinary.classList.contains('icon-only'));
  });
  await check('Steel creation includes destination fields and new ducts default rectangular without replacing legacy shape data',async()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const definitions=copy(h.audit.creationFields('steel'));
    assert.deepEqual(definitions.map(field=>field[0]),['mark','level','member_type','section','fire_period_min','exposure','product','critical_temperature','quantity']);
    assert.equal(definitions.find(field=>field[0]==='product')[1],'Product');
    h.audit.state.ui={target:{value:'steel_board'}};assert.ok(h.audit.creationFields('steel').some(field=>field[0]==='sides'));
    for(const mode of ['steel','duct','wall','slab'])assert.ok(h.audit.editableFields(mode,'steel_board').every(field=>!['zone','group','notes'].includes(field[0])));
    assert.ok(!h.audit.editableFields('steel','steel_vermiculite').some(field=>field[0]==='sides'));assert.ok(h.audit.editableFields('steel','steel_board').some(field=>field[0]==='sides'));
    const legacy={fields:{mark:'Old circular',shape:'circular',diameter_mm:355,unexposed_sides:2}},changes=h.audit.itemEditChanges(legacy,[{control:{name:'mark'},read:()=> 'Updated mark'}],{read:()=>1});
    assert.deepEqual(copy(changes),{fields:{mark:'Updated mark'},quantity:1});assert.equal(legacy.fields.shape,'circular');assert.equal(legacy.fields.diameter_mm,355);assert.equal(legacy.fields.unexposed_sides,2);
    const dom=attachMinimalDom(h);dom.ui.target={value:'ductwork'};dom.ui.viewport={dataset:{}};h.audit.state.mode='duct';let created;
    h.audit.setAsk(async()=>({mark:'D1',quantity:1}));h.audit.setCommand(async(op,payload)=>{assert.equal(op,'create_item');created=copy(payload.item);});
    await h.audit.createDrawnItem({method:'cited',length_m:2,citation:'Dimension'},null,[]);assert.equal(created.fields.shape,'rectangular');assert.equal(created.quantity,1);assert.equal(created.fields.diameter_mm,undefined);
  });
  await check('Register patches only changed fields, leaves unknown blanks absent and retains full numeric precision',()=>{
    const h=harness(),item={quantity:2,fields:{mark:'B1',length_note:null,precise:1.123456789,shape:'circular',diameter_mm:355}},control=(name,value)=>({control:{name},read:()=>value});
    assert.deepEqual(copy(h.audit.itemEditChanges(item,[control('mark','B1'),control('notes',''),control('length_note',''),control('precise',1.123456789)],{read:()=>2})),{});
    assert.deepEqual(copy(h.audit.itemEditChanges(item,[control('mark','B2'),control('notes',''),control('precise',1.123456788)],{read:()=>3})),{fields:{mark:'B2',precise:1.123456788},quantity:3});
    assert.deepEqual(copy(h.audit.itemEditChanges(item,[control('mark','')],null)),{fields:{mark:''}});
    const current={...item,fields:{...item.fields,mark:'B2'}};assert.deepEqual(copy(h.audit.itemEditChanges(current,[control('mark','B1')],{read:()=>2})),{fields:{mark:'B1'}});
    assert.equal(item.fields.precise,1.123456789);assert.equal(item.fields.diameter_mm,355);
    assert.deepEqual(copy(h.audit.itemEditChanges({fields:{mark:'  retained legacy text  '}},[{control:{name:'mark',value:'  retained legacy text  '},read:()=> 'retained legacy text'}],null)),{});
  });
  await check('Steel creation reloads exact calculator options for chosen product/member and never rewrites entered profile',async()=>{
    const h=harness();h.audit.accept(response(blank()));const controls=['product','member_type','section'].map(name=>({control:{name,value:name==='member_type'?'Beam':name==='section'?'Explicit profile':'',isConnected:false,events:{},addEventListener(event,fn){this.events[event]=fn;}}})),calls=[];
    h.audit.setApi(async path=>{calls.push(new URL(path,'http://localhost'));return {columns:[]};});await h.audit.configureSteelCreation(controls,'steel_board');
    assert.equal(calls[0].searchParams.get('calculator'),'steel_board');assert.equal(calls[0].searchParams.get('member_type'),'Beam');
    controls[0].control.value='PROMATECT 250';controls[0].control.events.change();await flush();assert.equal(calls.at(-1).searchParams.get('product'),'PROMATECT 250');
    controls[1].control.value='Column';controls[1].control.events.change();await flush();assert.equal(calls.at(-1).searchParams.get('member_type'),'Column');assert.equal(controls[2].control.value,'Explicit profile');
  });
  await check('Direct Confirm sends one authoritative confirmation command and filters historical review states as Unconfirmed',async()=>{
    const h=harness(),value=blank();value.items=[{id:'old',mode:'steel',state:'reviewed',fields:{mark:'A'}},{id:'new',mode:'steel',state:'draft',fields:{mark:'B'}},{id:'confirmed',mode:'steel',state:'confirmed',fields:{mark:'C'}}];h.audit.accept(response(value));h.audit.state.selected.add('new');
    let action;h.audit.setAsk(async(title,definitions,detail,submit)=>{assert.equal(title,'Confirm 1 items?');assert.equal(submit,'Confirm items');assert.match(detail,/every riser\/drop/);return {};});h.audit.setCommand(async(op,payload)=>{action={op,...copy(payload)};});await h.audit.confirmSelected();assert.equal(action.op,'confirm_items');assert.deepEqual(action.item_ids,['new']);
    h.audit.state.ui={statusFilter:{value:'unconfirmed'}};assert.deepEqual(copy(h.audit.visibleItems()).map(item=>item.id),['old','new']);h.audit.state.group='state';assert.equal(h.audit.itemGroup(value.items[0]),'Unconfirmed');assert.equal(value.items[0].state,'reviewed');
  });
  await check('Riser/drop edits preserve IDs, explicit mm/citation and per-member meaning, and reject malformed or stale edits',async()=>{
    const h=harness(),value=blank(),item={id:'steel',mode:'steel',version:1,quantity:3,fields:{mark:'B1'},geometry:{document_id:'doc',page:1},length_additions:[]};value.documents=[{id:'doc',name:'Elevations.pdf',pages:[{page:1},{page:2}]}];value.items=[item];h.audit.accept(response(value));
    let calls=[],addition={kind:'riser',length_mm:2500,note:'Elevation dimension',document_id:'doc',page:2};h.audit.setAsk(async(title,definitions,detail)=>{assert.match(detail,/each member/);return {...addition};});h.audit.setCommand(async(op,payload,guard)=>{guard?.();calls.push(copy(payload));});
    await h.audit.editLengthAddition(item);const first=calls[0].changes.length_additions[0];assert.match(first.id,/^[a-f0-9-]{36}$/);assert.equal(first.length_mm,2500);assert.equal(first.page,2);
    h.audit.state.session.snapshot.items[0].length_additions=[first];item.length_additions=[first];addition.length_mm=3000;await h.audit.editLengthAddition(item,first);assert.equal(calls[1].changes.length_additions[0].id,first.id);assert.equal(calls[1].changes.length_additions[0].length_mm,3000);
    assert.match(h.audit.lengthSummary(item,{base_length_m:2,additions_length_m:3,length_m:5,total_length_m:15}),/Base: 2\.00 m \+ riser\/drop: 3\.00 m = 5\.00 m per member · Quantity 3 · Total: 15\.00 m/);
    for(const malformed of [{length_mm:0},{length_mm:Infinity},{note:''},{page:3},{page:1.5},{kind:'height'}])assert.throws(()=>h.audit.parsedLengthAddition({...addition,...malformed},first.id));
    h.audit.setAsk(async()=>{h.audit.state.session.snapshot.items[0].version++;return {...addition};});await assert.rejects(h.audit.editLengthAddition(item,first),/item changed/);assert.equal(calls.length,2);
  });
  await check('Calibration changes offer only current scales on the item source page, not the displayed page or retained predecessor',async()=>{
    const h=harness(),value=blank(),item={id:'item',mode:'steel',geometry:{document_id:'source',page:2},measurement:{method:'calibrated',calibration_id:'old'}};
    value.calibrations=[{id:'old',document_id:'source',page:2,name:'Old'},{id:'current',supersedes_id:'old',document_id:'source',page:2,name:'Current'},{id:'different-page',document_id:'source',page:1,name:'Other'},{id:'different-document',document_id:'displayed',page:2,name:'Other document'},{id:'deleted-original',document_id:'source',page:2,name:'Deleted viewport'},{id:'tombstone',supersedes_id:'deleted-original',deleted:true,document_id:'source',page:2,name:'Deleted viewport'}];h.audit.accept(response(value));h.audit.state.document='displayed';h.audit.state.page=1;
    h.audit.setAsk(async(title,definitions)=>{const definition=definitions.find(field=>field[0]==='calibration_id');assert.deepEqual(copy(definition[2]),[['current','Current']]);assert.equal(definition[3],'');return null;});
    await h.audit.changeLength(item);await h.audit.changeAreaCalibration({...item,mode:'wall'});assert.equal(h.audit.state.session.snapshot.calibrations.length,6);
    h.audit.setAsk(async()=>({method:'calibrated',calibration_id:'old'}));await assert.rejects(h.audit.changeLength(item),/current calibration/);await assert.rejects(h.audit.changeAreaCalibration({...item,mode:'wall'}),/current calibration/);
  });
  await check('Legacy unspecified duct shape can be explicitly repaired without converting circular ducts or replacing dimensions',async()=>{
    const h=harness(),value=blank(),item={id:'duct',mode:'duct',version:1,fields:{width_mm:500,height_mm:300}};value.items=[item];h.audit.accept(response(value));let saved;
    h.audit.setCommand(async(op,payload,guard)=>{guard?.();saved=copy(payload);});await h.audit.useRectangularDuct(item);assert.deepEqual(saved.changes,{fields:{shape:'rectangular'}});assert.equal(item.fields.width_mm,500);assert.equal(item.fields.height_mm,300);
    h.audit.state.session.snapshot.items[0].fields.shape='circular';await assert.rejects(h.audit.useRectangularDuct(item),/Existing shapes are preserved/);
  });
  await check('Loading or resetting a project clears an unfinished manual viewport and stale zoom anchor',()=>{
    const h=harness();h.audit.accept(response(blank()));h.audit.state.pendingViewport={region:[10,20,30,40],name:'Old detail',document_id:'old',page:2};h.audit.state.zoomAnchor={point:[30,40],offset:[50,60]};
    assert.equal(h.api.hasUnsavedChanges(),true);assert.throws(()=>h.api.projectSnapshot(),/unfinished/);h.api.applyProject({session:null,saved:null});assert.equal(h.audit.state.pendingViewport,null);assert.equal(h.audit.state.zoomAnchor,null);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.api.projectSnapshot(),undefined);
  });
  await check('Anchored PDF zoom keeps the new transform unavailable until its matching canvas has finished rendering',async()=>{
    const h=harness(),value=blank(),pending=deferred();value.documents=[{id:'doc',name:'Drawing.pdf',pages:[{page:1}]}];h.audit.accept(response(value));const dom=attachMinimalDom(h),create=h.context.document.createElement;
    h.context.document.createElement=tag=>{const element=create(tag);element.style={};element.getContext=()=>({});return element;};
    const viewport={width:400,height:400,transform:[2,0,0,-2,0,400]},page={getViewport(){return viewport;},render(){return {promise:pending.promise,cancel(){}};}};
    for(const key of ['page','pageCount','progress','zoom','pageWrap','empty'])dom.ui[key]={};let replacement;
    dom.ui.canvas={replaceWith(value){replacement=value;}};dom.ui.overlay.getBoundingClientRect=()=>({left:30,top:40});dom.ui.viewport={getBoundingClientRect:()=>({left:0,top:0}),scrollLeft:0,scrollTop:0};
    h.audit.setPdfTools(async()=>({}),async()=>page);h.audit.setCommand(async()=>{});h.audit.state.tool='trace';h.audit.state.points=[[10,10]];h.audit.state.viewport={width:200,height:200,transform:[1,0,0,-1,0,200]};
    const rendering=h.audit.renderPage({point:[10,10],offset:[50,60]});await flush();assert.equal(h.audit.state.viewport,null);assert.equal(replacement,undefined);
    h.audit.drawingPointer({button:0,detail:1,clientX:100,clientY:100,preventDefault(){throw new Error('Trace click must be ignored while display transform is unavailable');}});assert.deepEqual(copy(h.audit.state.points),[[10,10]]);
    pending.resolve();await rendering;assert.equal(h.audit.state.viewport,viewport);assert.equal(h.audit.state.ui.canvas,replacement);assert.ok(replacement);assert.equal(h.audit.state.zoomAnchor,null);
  });
  await check('A rejected double-click endpoint cannot finish earlier trace, polygon or exclusion geometry',async()=>{
    for(const tool of ['trace','polygon','exclusion']){
      const h=harness(),value=blank();value.documents=[{id:'doc',name:'Detail.pdf',pages:[{page:1,view:[0,0,200,200]}]}];value.calibrations=[{id:'detail',document_id:'doc',page:1,region:[0,0,100,100]}];h.audit.accept(response(value));const dom=attachMinimalDom(h);
      dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});h.audit.state.viewport={width:200,height:200,transform:[1,0,0,1,0,0]};h.audit.state.calibration='detail';h.audit.state.tool=tool;h.audit.state.points=[[10,10],[20,20],[30,10]];
      let finished=0;h.audit.setFinishTrace(async()=>{finished++;});const click=(x,y,detail=1)=>({clientX:x,clientY:y,button:0,detail,preventDefault(){}}),doubleClick={preventDefault(){}};
      h.audit.state.doubleClickEndpointValid=true;h.audit.drawingPointer(click(150,50));h.audit.drawingPointer(click(150,50,2));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,0);assert.equal(h.audit.state.points.length,3);
      h.audit.drawingPointer(click(250,50));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,0);
      h.audit.drawingPointer(click(40,40));h.audit.drawingPointer(click(40,40,2));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,1);assert.equal(h.audit.state.points.length,4);
      h.audit.drawingPointer(click(40,40));h.audit.drawingPointer(click(40,40,2));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,2);assert.equal(h.audit.state.points.length,4);
    }
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
  await check('Transfer review rounds displayed lengths to two decimals without changing mapped precision or native notes',()=>{
    const h=harness(),item={id:'member',mode:'steel',quantity:3,fields:{mark:'B17'}},binding={item_id:'member',sheet:'CALCULATOR',row:9,values:{A9:'B17',F9:.370370367,L9:0,X9:null}};
    const columns=[{column:'A',label:'Member mark'},{column:'F',label:'Lineal metres'},{column:'L',label:'Waste'},{column:'X',label:'Design reference'}];
    const preview={calculator_id:'steel_board',changes:[{item_id:'member',action:'append'}],bindings:[binding],warnings:[{item_id:'member',status:'CLADDING ESTIMATE',message:'Add supports separately.'}]};
    const before=copy({preview,item});
    const summary=h.audit.transferSummary(preview,[item],[{id:'member',length_m:.123456789,total_length_m:.370370367}],columns);
    assert.deepEqual(copy({preview,item}),before);assert.equal(preview.bindings[0].values.F9,.370370367);
    for(const text of ['Add: B17','Source ID: member','Steel Board · CALCULATOR row 9','Physical quantity: 3','Per-member length: 0.12 m','Total length: 0.37 m','Lineal metres: 0.37','Waste: 0','CLADDING ESTIMATE','Add supports separately.'])assert.ok(summary.includes(text),text);
    assert.ok(!summary.includes('Design reference:'));assert.ok(!summary.includes('"changes"'));
  });
  console.log(`${passed} takeoff UI and geometry checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
