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
function harness(storage) {
  const context={window:{CeasefireTakeoffGeometry:geometry,CeasefireProject:{changed(){}}},document:{getElementById(){return null;},fonts:{load(){return Promise.resolve([]);},check(){return true;}}},crypto,
    Intl,Number,String,JSON,Object,Set,Map,Array,Promise,Error,URL,Math,console:{...console},setTimeout,clearTimeout};
  vm.createContext(context);
  if (storage !== undefined) Object.defineProperty(context.window,'localStorage',{get(){if(storage instanceof Error)throw storage;return storage;}});
  let source=fs.readFileSync('static/takeoffs.js','utf8');
  source=source.replace('  window.CeasefireTakeoffs = {', '  globalThis.audit = {state,accept,command,ensureSession,editableFields,settingsSelectedItems,renderSettingsPanel,applySettings,flushSettings,markSettingsEdited,appearanceOf,snapshotKey,reviewStatus,visibleItems,transferSummary,boundInputDetails,notePdfWarning,documentWarnings,installPdfDiagnostics,releaseDocuments,boundedPdf,destroyPdfResources,pdfPage,discardPdf,recordPdfFailure,areaTraceLimit,transfer,detachSelected,manageLinkedRows,splitSelected,mergeSelected,renderRegister,renderOverlay,selectItem,startExclusion,editAreaBoundary,changeAreaCalibration,setTool,discardEditor,requireFinishedEdits,normalizePhysicalImages,button,creationFields,configureSteelCreation,createDrawnItem,lengthSummary,parsedLengthAddition,editLengthAddition,removeLengthAddition,confirmSelected,itemGroup,registerFilters,setApi(fn){api=fn;},setAsk(fn){ask=fn;},setCommand(fn){command=fn;}};\n  window.CeasefireTakeoffs = {');
  source=source.replace('setApi(fn){api=fn;}', 'renderControlPoints,pointReference,pointTarget,pointRemovalReason,removeControlPoint,planKeydown,handoffPlanWheel,downloadTakeoff,renderPage,drawingPointer,finishTrace,finishTraceFromDoubleClick,changeLength,itemCalibrations,useRectangularDuct,setFinishTrace(fn){finishTrace=fn;},setPdfTools(documentFn,pageFn){pdfDocument=documentFn;pdfPage=pageFn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'pointGeometry,moveControlPoint,beginControlPointDrag,cancelSelectionGesture,markupTarget,deleteMarkup,surfacePreview,renderSurfaceLabel,renderPendingTrace,tracePointerMove,setSelectionRenderer(fn){renderSelection=fn;},setPointSelector(fn){selectControlPoint=fn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'stageCountMarker,queueCountLength,resetCountDraft,finishCount,cancelTrace,deleteCountMarker,beginCountMarkerDrag,changeCountLength,countBatchItems,selectedCountMemberIds,selectCountMarker,continueCount,beginSelectionGesture,working,setOverlayRenderer(fn){renderOverlay=fn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'build,renderRail,linkedCalculatorOperation,recoverLinkedOperation,openItemSettings,viewItem,formField,populateCalculatorOptions,loadSettingsOptions,parseDuctSize,formatDuctSize,bulkEdit,setFlushSettings(fn){flushSettings=fn;},requestApi:api,setDataRenderer(fn){renderData=fn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'physicalGraph,physicalSnapshot,physicalMarkerReference,physicalMarkerTarget,physicalCalloutLines,selectWorkspace,placePhysicalMarker,physicalSource,renderPhysicalOverlay,setNavigateDocument(fn){navigateDocument=fn;},setPositionPage(fn){positionPage=fn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'activateCountTool,defectLocationEvidence,armPhysicalMarker,choosePhysicalDrawing,choosePhysicalEvidence,ensurePhysicalUI,setCountTool(fn){setTool=fn;},setPhysicalDetails(fn){setPhysicalDetailsOpen=fn;},setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'bulkSelectionFields,syncBulkFields,renderItemSettingsActions,drawableItems,renderCountMarkers,askDialog:ask,setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'validatedMarkupDefaults,readMarkupDefaults,newMarkupAppearance,setMarkupDefaults,syncSurfaceDetailsSelection,clearDrawingSelection,setApi(fn){api=fn;}');
  source=source.replace('setApi(fn){api=fn;}', 'renderMeasurementValues,renderValueLabel,drawingClickOpensSettings,selectDrawingItem,setApi(fn){api=fn;}');
  vm.runInContext(source,context);
  return {context,audit:context.audit,api:context.window.CeasefireTakeoffs};
}
function attachMinimalDom(h) {
  function element(tag='div') {
    const el={tagName:tag.toUpperCase(),children:[],dataset:{},attributes:{},events:{},className:'',_text:'',value:'',
      append(...children){for(const child of children){if(child.parentNode){const siblings=child.parentNode.children;siblings.splice(siblings.indexOf(child),1);}child.parentNode=this;child.previousElementSibling=this.children.at(-1)||null;this.children.push(child);}},
      after(child){const siblings=this.parentNode.children,index=siblings.indexOf(this);child.parentNode=this.parentNode;child.previousElementSibling=this;siblings.splice(index+1,0,child);},
      replaceChildren(...children){this.children=[];this._text='';this.append(...children);},
      setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.className=String(value);},
      addEventListener(event,listener){this.events[event]=listener;},
      contains(value){return this===value||this.children.some(child=>child.contains?.(value));},
      querySelectorAll(selector){return this.children.flatMap(child=>[...((selector==='[data-item-id]'&&child.dataset.itemId)?[child]:[]),...child.querySelectorAll(selector)]);},
    };
    Object.defineProperty(el,'textContent',{get(){return this._text+this.children.map(child=>child.textContent).join('');},set(value){this._text=String(value);this.children=[];}});
    el.classList={add(...keys){const values=new Set(el.className.split(/\s+/).filter(Boolean));keys.forEach(key=>values.add(key));el.className=[...values].join(' ');},toggle(key,on){const values=new Set(el.className.split(/\s+/).filter(Boolean));on?values.add(key):values.delete(key);el.className=[...values].join(' ');},contains(key){return el.className.split(/\s+/).includes(key);}};
    return el;
  }
  h.context.document.createElement=element;h.context.document.createElementNS=(_,tag)=>element(tag);
  const documentEvents=[];h.context.document.addEventListener=(type,listener,options)=>documentEvents.push({type,listener,options});
  const ui={};for(const key of ['split','merge','bulk','selectionCount','tableWrap','pagination','overlay','message','selectFiltered'])ui[key]=element();ui.bulkField={value:'mark',querySelector(){return null;}};ui.statusFilter={value:''};h.audit.state.ui=ui;
  return {ui,element,documentEvents,all(root){return root.children.flatMap(child=>[child,...this.all(child)]);}};
}
function countHarness() {
  const h=harness(),value=blank();value.documents=[{id:'doc',name:'Count.pdf',pages:[{page:1,view:[0,0,200,200],user_unit:1}]}];h.audit.accept(response(value));
  const dom=attachMinimalDom(h);dom.ui.root=dom.element();dom.ui.viewport=dom.element();dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});
  dom.ui.viewport.focus=()=>{};dom.ui.progress=dom.element();
  Object.assign(h.audit.state,{document:'doc',page:1,tool:'count',viewport:{width:200,height:200,transform:[1,0,0,1,0,0]}});h.audit.setOverlayRenderer(()=>{});h.audit.setSelectionRenderer(()=>{});
  const timers=new Map();let timerId=0;h.context.setTimeout=fn=>{timers.set(++timerId,fn);return timerId;};h.context.clearTimeout=id=>timers.delete(id);
  return {...h,dom,timers,stage(point,timeStamp=10){h.audit.stageCountMarker(point,{timeStamp,clientX:point[0],clientY:point[1]});return h.audit.state.countEntries.at(-1);}};
}
function attachSettings(h, calculator='steel_vermiculite') {
  const dom=attachMinimalDom(h);
  dom.ui.settingsPanel=dom.element();dom.ui.layout=dom.element();dom.ui.tools={settings:dom.element()};dom.ui.target={value:calculator};
  h.audit.setApi(async()=>({columns:[{column:'C',options:[]}]}));
  return dom;
}
function linkedOperationHarness() {
  const h=harness();h.audit.accept(response(blank()));const dom=attachMinimalDom(h);dom.ui.root=dom.element();dom.ui.status=dom.element();
  const controls=[dom.element('input'),dom.element('button')];controls[0].disabled=false;controls[1].disabled=true;dom.ui.root.querySelectorAll=()=>controls;h.audit.setDataRenderer(()=>{});
  return {...h,controls};
}
const countItem=(id,countId,length,points)=>({id,count_id:countId,version:1,state:'unconfirmed',mode:'steel',quantity:points.length,fields:{mark:countId},member_ids:points.map((_,index)=>`${id}-member-${index}`),geometry:{kind:'count',document_id:'doc',page:1,points},measurement:{method:'manual',length_m:length},evidence:[]});
let passed=0;
async function check(label, test) { await test(); passed++; console.log(`ok - ${label}`); }
(async()=>{
  await check('Line Width and percent Opacity controls preserve untouched historical precision and bound explicit edits',async()=>{
    const h=harness(),value=blank(),opacity=.003333333333333333;value.items=[{id:'a',mode:'steel',quantity:1,fields:{mark:'A'},appearance:{stroke_width:.5,opacity}}];h.audit.accept(response(value));attachSettings(h);h.audit.state.selected=new Set(['a']);h.audit.state.settingsOpen=true;h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor,width=editor.appearance.find(field=>field.control.name==='stroke_width'),alpha=editor.appearance.find(field=>field.control.name==='opacity');
    assert.equal(width.control.attributes['aria-label'],'Line Width');assert.equal(editor.appearance.find(field=>field.control.name==='stroke_color').control.attributes['aria-label'],'Line Colour');
    for(const field of [width,alpha]){assert.equal(field.control.min,'1');assert.equal(field.control.max,'100');}
    assert.equal(width.read(),.5);assert.equal(alpha.read(),opacity);assert.equal(Number(alpha.control.value),opacity*100);
    width.control.value='100';assert.equal(width.read(),100);width.control.value='101';assert.throws(()=>width.read(),/1 to 100/);width.control.value='.75';assert.throws(()=>width.read(),/1 to 100/);
    alpha.control.value='75';assert.equal(alpha.read(),.75);alpha.control.value='.5';assert.throws(()=>alpha.read(),/1 to 100/);
    width.control.value='.5';alpha.control.value=String(opacity*100);let sent;h.audit.setCommand(async(op,body)=>{sent={op,...copy(body)};});const level=editor.fields.find(field=>field.control.name==='level');level.control.value='Historical retained';level.control.events.input();await h.audit.applySettings(editor);assert.deepEqual(sent.changes,{fields:{level:'Historical retained'}});assert.equal(h.audit.state.session.snapshot.items[0].appearance.opacity,opacity);
  });
  await check('Display Values edits only presentation and calibrated segment labels retain exact source lengths after rotation',async()=>{
    const h=harness(),value=blank();value.calibrations=[{id:'scale',document_id:'doc',page:1,points:[[0,0],[100,0]],distance_m:10,uniform_scale:true}];h.audit.accept(response(value));const dom=attachMinimalDom(h);Object.assign(h.audit.state,{document:'doc',page:1,viewport:{transform:[0,2,-2,0,400,0]}});
    const geometry={kind:'polyline',document_id:'doc',page:1,points:[[10,10],[30,10],[30,40]]},item={id:'a',mode:'steel',geometry,measurement:{method:'calibrated',calibration_id:'scale'},appearance:{display_values:true}};const before=copy(item);
    h.audit.renderMeasurementValues(dom.ui.overlay,item,geometry);assert.deepEqual(dom.ui.overlay.children.map(label=>Number(label.attributes['data-value'])),[2000,3000]);assert.deepEqual(dom.ui.overlay.children.map(label=>[Number(label.attributes.x),Number(label.attributes.y)]),[[380,30],[350,50]]);assert.deepEqual(item,before);
    dom.ui.overlay.replaceChildren();item.appearance.display_values=false;h.audit.renderMeasurementValues(dom.ui.overlay,item,geometry);assert.equal(dom.ui.overlay.children.length,0);item.appearance.display_values=true;h.audit.state.session.snapshot.calibrations[0].deleted=true;h.audit.renderMeasurementValues(dom.ui.overlay,item,geometry);assert.equal(dom.ui.overlay.children.length,0);
  });
  await check('Surface perimeter includes the closing edge and openings while Steel counts show only explicit cited member lengths',()=>{
    const h=harness(),value=blank();value.calibrations=[{id:'scale',document_id:'doc',page:1,points:[[0,0],[10,0]],distance_m:1,uniform_scale:true}];h.audit.accept(response(value));const dom=attachMinimalDom(h);Object.assign(h.audit.state,{document:'doc',page:1,viewport:{transform:[1,0,0,1,0,0]}});
    const geometry={kind:'polygon',document_id:'doc',page:1,points:[[0,0],[100,0],[100,100],[0,100]],exclusions:[{id:'hole',points:[[20,20],[30,20],[30,30],[20,30]]}]};h.audit.renderMeasurementValues(dom.ui.overlay,{id:'wall',mode:'wall',geometry,measurement:{method:'calibrated',calibration_id:'scale'},appearance:{display_values:true}},geometry);assert.deepEqual(dom.ui.overlay.children.map(label=>Number(label.attributes['data-value'])),[10000,10000,10000,10000,1000,1000,1000,1000]);
    const c=countHarness(),item=countItem('count','COUNT-1',6.123456789,[[30,30],[60,60]]);item.appearance={display_values:true};const original=copy(item);c.audit.renderCountMarkers(c.dom.ui.overlay,item,item.geometry);const labels=c.dom.ui.overlay.children.filter(label=>label.attributes['data-value-kind']==='cited-count');assert.equal(labels.length,2);assert.deepEqual(labels.map(label=>Number(label.attributes['data-value'])),[6123.456789,6123.456789]);assert.deepEqual(item,original);
  });
  await check('Markup defaults validate only the five visual properties and safely ignore corrupt or unavailable storage',()=>{
    const appearance={stroke_color:'#a020f0',stroke_width:3.75,fill_color:'#00cc88',fill_enabled:false,opacity:.45},saved={version:1,appearance:{...appearance,marker_shape:'diamond',marker_size:44,quantity:99}},writes=[];
    const storage={getItem(key){assert.equal(key,'ceasefire.takeoff-markup-defaults.v2');return JSON.stringify(saved);},setItem(...args){writes.push(args);}},h=harness(storage),expected={...appearance,stroke_color:'#A020F0',fill_color:'#00CC88',marker_size:25,display_values:false};
    assert.deepEqual(copy(h.audit.newMarkupAppearance()),expected);const external=h.audit.newMarkupAppearance();external.stroke_width=17;assert.deepEqual(copy(h.audit.newMarkupAppearance()),expected);assert.equal(writes.length,0);
    for(const altered of [{stroke_color:'red'},{fill_color:'#fff'},{stroke_width:0},{stroke_width:101},{stroke_width:'2'},{opacity:NaN},{opacity:1.01},{fill_enabled:1}])assert.equal(h.audit.validatedMarkupDefaults({...appearance,...altered}),null);
    for(const value of ['not JSON',JSON.stringify({...saved,version:2}),JSON.stringify({version:1,appearance:{...appearance,opacity:1.2}})])assert.deepEqual(copy(harness({getItem(){return value;}}).audit.newMarkupAppearance()),{stroke_width:5,fill_enabled:true,marker_size:25,display_values:false});
    assert.deepEqual(copy(harness(new Error('Storage blocked')).audit.newMarkupAppearance()),{stroke_width:5,fill_enabled:true,marker_size:25,display_values:false});
  });
  await check('Set as default flushes edits, stores visual preference only, and retains an in-window default if persistence is blocked',async()=>{
    for(const blocked of [false,true]){
      const writes=[],storage={getItem(){return null;},setItem(key,value){if(blocked)throw new Error('Blocked');writes.push({key,value:JSON.parse(value)});}},h=harness(storage),value=blank();value.items=[{id:'a',mode:'steel',quantity:1,fields:{mark:'A'},appearance:{}}];h.audit.accept(response(value));const dom=attachSettings(h);h.audit.state.selected=new Set(['a']);h.audit.state.settingsOpen=true;h.audit.renderSettingsPanel();
      const editor=h.audit.state.settingsEditor,desired={stroke_color:'#A020F0',stroke_width:3.75,fill_color:'#00CC88',fill_enabled:false,opacity:.45,display_values:false};
      for(const field of editor.appearance){const key=field.control.name;if(!(key in desired))continue;if(key==='fill_enabled')field.control.checked=desired[key];else field.control.value=String(key==='opacity'?desired[key]*100:desired[key]);field.control.events.input();}
      const held=deferred(),sent=[];h.audit.setCommand(async(op,body)=>{sent.push({op,...copy(body)});await held.promise;Object.assign(h.audit.state.session.snapshot.items[0].appearance,body.changes.appearance);});
      const setting=h.audit.setMarkupDefaults(editor);await flush();assert.equal(sent.length,1);assert.equal(writes.length,0);held.resolve();await setting;
      const canonical=copy(h.audit.state.session.snapshot),fingerprint=h.api.projectFingerprint();assert.deepEqual(copy(h.audit.newMarkupAppearance()),{marker_size:25,...desired,display_values:false});assert.equal(sent[0].op,'bulk_update');const {display_values,...changedAppearance}=desired;assert.deepEqual(sent[0].changes,{appearance:changedAppearance});
      assert.equal(writes.length,blocked?0:1);if(!blocked)assert.deepEqual(writes[0],{key:'ceasefire.takeoff-markup-defaults.v2',value:{version:1,appearance:desired}});
      await h.audit.setMarkupDefaults(h.audit.state.settingsEditor);assert.equal(sent.length,1);assert.equal(h.api.projectFingerprint(),fingerprint);assert.deepEqual(copy(h.audit.state.session.snapshot),canonical);assert.equal(h.audit.state.settingsDirty,false);
      const stale=editor;h.audit.state.selected.clear();await assert.rejects(h.audit.setMarkupDefaults(stale),/selection changed/);assert.deepEqual(copy(h.audit.newMarkupAppearance()),{marker_size:25,...desired,display_values:false});
    }
  });
  await check('Fresh Steel Duct Wall and Slab creations inherit defaults without changing existing items or source precision',async()=>{
    const desired={stroke_color:'#A020F0',stroke_width:3.75,fill_color:'#00CC88',fill_enabled:true,opacity:.45};
    for(const mode of ['steel','duct','wall','slab']){
      const h=harness({getItem(){return JSON.stringify({version:1,appearance:{marker_size:25,...desired,display_values:false}});}}),value=blank();value.items=[{id:'old',mode,quantity:1,fields:{mark:'Old'},appearance:{stroke_color:'#CC0000'}}];h.audit.accept(response(value));const dom=attachMinimalDom(h);dom.ui.target={value:mode==='duct'?'ductwork':'steel_vermiculite'};dom.ui.viewport={dataset:{}};h.audit.state.mode=mode;h.audit.setSelectionRenderer(()=>{});
      const geometry={kind:['wall','slab'].includes(mode)?'polygon':'polyline',document_id:'retained-doc',page:3,points:[[1.123456789,2],[20,2],[20,30]],...(['wall','slab'].includes(mode)?{exclusions:[]}:{})},measurement={method:'cited',length_m:6.123456789,citation:'Exact source dimension'},evidence=[{document_id:'retained-doc',page:3,note:'Exact source'}];let created;
      h.audit.setAsk(async()=>({mark:'New',quantity:['wall','slab'].includes(mode)?'1':1}));h.audit.setCommand(async(op,body)=>{assert.equal(op,'create_item');created=copy(body.item);});await h.audit.createDrawnItem(measurement,geometry,evidence);
      assert.deepEqual(created.appearance,{marker_size:25,...desired,display_values:false});assert.deepEqual(created.geometry,geometry);assert.deepEqual(created.measurement,measurement);assert.deepEqual(created.evidence,evidence);assert.deepEqual(copy(h.audit.state.session.snapshot),value);assert.deepEqual(copy(h.audit.appearanceOf(value.items[0])).stroke_color,'#CC0000');
    }
  });
  await check('Drawing body single clicks select, a stationary double click opens all four mode panes, and blank clears without source writes',async()=>{
    for(const mode of ['steel','duct','wall','slab']){
      const h=harness(),value=blank();value.items=[{id:'a',mode,quantity:1,fields:{mark:'A'}}];h.audit.accept(response(value));attachSettings(h,mode==='duct'?'ductwork':'steel_vermiculite');h.audit.state.mode=mode;h.audit.state.tool='select';h.audit.setSelectionRenderer(()=>h.audit.syncSurfaceDetailsSelection());
      let now=1000;h.context.Date={now:()=>now};const click={type:'click',clientX:40,clientY:60};
      let focusCount=0;h.audit.state.ui.viewport={focus(){focusCount++;}};
      await h.audit.selectDrawingItem('a',click);assert.equal(h.audit.state.settingsOpen,false);assert.deepEqual([...h.audit.state.selected],['a']);
      assert.equal(focusCount,1,'A drawing click owns the keyboard while Settings is closed');
      now+=150;await h.audit.selectDrawingItem('a',click);assert.equal(h.audit.state.settingsOpen,true);assert.deepEqual([...h.audit.state.selected],['a']);
      h.audit.state.settingsOpen=false;await h.audit.selectItem('a',false,false,false,false);h.audit.syncSurfaceDetailsSelection();assert.equal(h.audit.state.settingsOpen,false);assert.deepEqual([...h.audit.state.selected],['a']);
      await h.audit.selectItem('a',false,false,true);assert.equal(h.audit.state.settingsOpen,true);
      if(!h.audit.state.selected.size)await h.audit.selectItem('a',false,false,true);await h.audit.clearDrawingSelection();assert.equal(h.audit.state.settingsOpen,false);assert.equal(h.audit.state.selected.size,0);assert.deepEqual(copy(h.audit.state.session.snapshot),value);
    }
  });
  await check('Double-click intent rejects expired, moved, modified and stale source clicks, and blank clicks reset it',async()=>{
    const h=harness(),state=h.audit.state;h.audit.accept(response(blank()));attachSettings(h,'steel_vermiculite');Object.assign(state,{mode:'steel',tool:'select'});h.audit.setSelectionRenderer(()=>{});
    let now=1000;h.context.Date={now:()=>now};const click={type:'click',clientX:40,clientY:60},choose=(event=click,id='item:a')=>h.audit.drawingClickOpensSettings(event,id);
    assert.equal(choose(),false);now+=501;assert.equal(choose(),false);now+=100;assert.equal(choose({...click,clientX:45}),false);
    assert.equal(choose({...click,ctrlKey:true}),false);assert.equal(choose(),false);now+=100;state.page++;assert.equal(choose(),false);
    now+=100;state.session.revision++;assert.equal(choose(),false);now+=100;assert.equal(choose(click,'item:b'),false);
    await h.audit.clearDrawingSelection();now+=100;assert.equal(choose(click,'item:b'),false);assert.equal(choose({type:'keydown'}),true);
    assert.equal(state.lastDrawingClick,null);assert.deepEqual(copy(state.session.snapshot),blank());
  });
  await check('Viewer controls sit outside the scrolling drawing, with Select and Pan before zoom and source dropdown before search in the viewer',()=>{
    const h=harness(),dom=attachMinimalDom(h),root=dom.element();h.audit.state.ui=null;h.context.document.getElementById=id=>id==='takeoffs-workspace'?root:null;h.audit.build();
    const ui=h.audit.state.ui,all=dom.all(root),find=name=>all.find(el=>el.classList.contains(name)),viewer=find('takeoff-viewer'),top=find('takeoff-viewer-top'),bottom=find('takeoff-page-controls'),search=find('takeoff-search-controls');
    const bottomGroup=find('takeoff-viewer-bottom');assert.equal(bottomGroup.parentNode,viewer);
    assert.equal(ui.viewport.parentNode,viewer);assert.equal(top.parentNode,viewer);assert.equal(bottom.parentNode,bottomGroup);assert.deepEqual(top.children,[ui.scaleAnchor,ui.navigation,search]);
    assert.equal(ui.tools.select.parentNode,bottom);assert.equal(ui.tools.pan.parentNode,bottom);const labels=bottom.children.map(el=>el.attributes['aria-label']||el.textContent);assert.ok(labels.indexOf('Select')<labels.indexOf('Pan'));assert.ok(labels.indexOf('Pan')<labels.indexOf('−'));assert.ok(labels.includes('Rotate page'));
    assert.ok(!dom.all(ui.toolRail).includes(ui.tools.select));assert.ok(!dom.all(ui.viewport).includes(top));assert.ok(!dom.all(ui.viewport).includes(bottom));assert.equal(ui.tools.count.parentNode,ui.countAnchor);assert.equal(ui.scaleAnchor.parentNode,top);assert.ok(!dom.all(ui.toolRail).includes(ui.scaleAnchor));
    assert.deepEqual(ui.scaleControls.children,[ui.calibration,ui.tools.calibrate,ui.editCalibration]);assert.equal(ui.tools.calibrate.textContent,'Calibrate');assert.equal(ui.tools.calibrate.children.length,0);
    const pageNavigation=find('takeoff-page-navigation');assert.equal(pageNavigation.parentNode,bottom);assert.deepEqual(pageNavigation.children.map(el=>el.attributes['aria-label']||el.textContent),['First page','‹ Page','Page number','/ 0','Page ›','Last page']);
    assert.equal(ui.navigation.parentNode,top);assert.equal(ui.documentSelect.parentNode.attributes["aria-label"],"Source documents");assert.equal(search.attributes.role,"search");assert.equal(root.children[0],ui.title);
    const outside=dom.documentEvents.find(event=>event.type==='pointerdown');assert.ok(outside);assert.equal(outside.options.capture,true);
    h.audit.state.active=true;h.audit.state.searchHits=[{id:'retained-match'}];ui.searchResults.hidden=false;
    outside.listener({target:ui.search});assert.equal(ui.searchResults.hidden,false,'Inside-search pointer keeps the dropdown available');
    outside.listener({target:ui.documentSelect});assert.equal(ui.searchResults.hidden,true,'Outside pointer dismisses the dropdown');assert.equal(h.audit.state.searchDismissed,true);assert.deepEqual(copy(h.audit.state.searchHits),[{id:'retained-match'}],'Dismissal preserves search results/highlights');
  });
  await check('Source documents show retained names, page counts and sizes, refresh selection and empty state without mutating evidence',()=>{
    const h=harness(),value=blank();value.documents=[{id:'first',name:'First original.pdf',size:1048576,pages:[{page:1},{page:2}]},{id:'second',name:'<Retained name>.pdf',size:2097152,pages:[{page:1}]}];h.audit.accept(response(value));
    const dom=attachMinimalDom(h),root=dom.element();h.audit.state.ui=null;h.context.document.getElementById=id=>id==='takeoffs-workspace'?root:null;h.audit.build();h.audit.state.document='first';h.audit.renderRail();const ui=h.audit.state.ui;
    assert.deepEqual(ui.documentSelect.children.map(el=>el.value),["first","second"]);assert.equal(ui.documentSelect.children[0].textContent,"First original.pdf · 2 pages · 1 MiB");assert.ok(ui.documentSelect.textContent.includes("<Retained name>.pdf"));assert.deepEqual(copy(h.audit.state.session.snapshot),value);
    h.audit.state.document='second';h.audit.renderRail();assert.equal(ui.documentSelect.value,'second');assert.ok(ui.documentSelect.title.includes('<Retained name>.pdf'));
    h.audit.state.session.snapshot.documents=[];h.audit.state.document=null;h.audit.renderRail();assert.equal(ui.documentSelect.textContent,'No PDFs uploaded');assert.equal(ui.documentSelect.disabled,true);assert.equal(ui.removeDocument.disabled,true);
  });
  await check('Count placement requires explicit manual length and reuses it only after the checked first dialog',async()=>{
    const h=countHarness(),first=h.stage([10.123456789,20.987654321]),calls=[];const fingerprint=h.api.projectFingerprint();
    assert.throws(()=>h.api.projectSnapshot(),/unfinished/);assert.equal(h.api.hasUnsavedChanges(),true);
    h.audit.setAsk(async(title,definitions)=>{calls.push(title);assert.equal(title,'Counted member length');assert.deepEqual(copy(definitions.map(def=>def[0])),['length_m','reuse']);assert.equal(definitions[1][3],false);return {length_m:7.123456789,reuse:true};});
    await h.audit.queueCountLength(first);assert.equal(first.length_m,7.123456789);assert.notEqual(h.api.projectFingerprint(),fingerprint);
    const second=h.stage([80,90]);await h.audit.queueCountLength(second);assert.equal(second.length_m,7.123456789);assert.equal(calls.length,1);assert.deepEqual(copy(h.audit.state.points),[[10.123456789,20.987654321],[80,90]]);
    h.audit.cancelTrace();assert.equal(h.timers.size,0);assert.equal(h.audit.state.countDefaultLength,null);assert.equal(h.audit.state.countEntries.length,0);
  });
  await check('Unchecked Count lengths prompt per marker and cancellation removes only that provisional marker',async()=>{
    const h=countHarness(),answers=[{length_m:5,reuse:false},null,{length_m:8,reuse:false}],first=h.stage([10,10]);let calls=0;h.audit.setAsk(async()=>{calls++;return answers.shift();});
    await h.audit.queueCountLength(first);const cancelled=h.stage([20,20]);await h.audit.queueCountLength(cancelled);const third=h.stage([30,30]);await h.audit.queueCountLength(third);
    assert.equal(calls,3);assert.deepEqual(copy(h.audit.state.countEntries.map(entry=>({point:entry.point,length_m:entry.length_m}))),[{point:[10,10],length_m:5},{point:[30,30],length_m:8}]);assert.equal(h.audit.state.countDefaultLength,null);h.audit.cancelTrace();
  });
  await check('Count dialogs cannot revive cancelled drafts or mutate replacement projects and reject stale revisions',async()=>{
    for(const reason of ['cancel','project','revision']){
      const h=countHarness(),entry=h.stage([10,10]),answer=deferred();h.audit.setAsk(()=>answer.promise);const awaiting=h.audit.queueCountLength(entry);await flush();
      if(reason==='cancel')h.audit.cancelTrace();
      else if(reason==='project'){h.audit.state.ui=null;h.audit.setApi(async()=>({}));h.api.applyProject({session:response(blank(),'replacement'),saved:null});}
      else h.audit.state.session.revision++;
      answer.resolve({length_m:9,reuse:true});
      if(reason==='revision')await assert.rejects(awaiting,/changed during length entry/);else await awaiting;
      assert.equal(entry.length_m,null);assert.equal(h.audit.state.countDefaultLength,null);
      if(reason==='project'){assert.equal(h.audit.state.session.session_id,'replacement');assert.equal(h.audit.state.countEntries.length,0);assert.equal(h.timers.size,0);}
      if(reason==='cancel')assert.equal(h.audit.state.countEntries.length,0);
      h.audit.resetCountDraft();
    }
  });
  await check('Count double-click finish consumes detail-two clicks without relying on a replaced SVG target dblclick',async()=>{
    const h=countHarness();h.audit.state.countDefaultLength=6.123456789;const retained=h.stage([10,10],1);await h.audit.queueCountLength(retained);let sent,calls=0;h.audit.setAsk(async()=>{throw new Error('Finishing must not ask for an extra marker length');});
    h.audit.setCommand(async(op,body)=>{calls++;sent={op,...copy(body)};return {created_item_ids:['created']};});
    const click=detail=>({detail,button:0,clientX:100,clientY:120,timeStamp:100+detail,preventDefault(){}});
    h.audit.drawingPointer(click(1));assert.equal(h.audit.state.countEntries.length,2);h.audit.drawingPointer(click(2));await flush();await flush();
    assert.equal(calls,1);assert.deepEqual(sent,{op:'add_count_items',document_id:'doc',page:1,markers:[{point:[10,10],length_m:6.123456789}],fields:{},appearance:{stroke_width:5,fill_enabled:true,marker_size:25,display_values:false}});assert.equal(h.audit.state.tool,'select');assert.equal(h.audit.state.countEntries.length,0);assert.equal(h.timers.size,0);assert.equal(h.audit.state.settingsOpen,true);
  });
  await check('Count settings expand every same-batch length row, keep Qty read-only and preserve unrelated selections after regrouping',async()=>{
    const h=countHarness(),a=countItem('a','batch',5,[[10,10]]),b=countItem('b','batch',3.5,[[20,20],[30,30]]),other=countItem('other','different',5,[[40,40]]),trace={id:'trace',mode:'steel',quantity:2,fields:{mark:'trace'}};
    a.length_additions=b.length_additions=[{id:'rise',kind:'riser',length_mm:500,document_id:'doc',page:1,note:'Explicit 500 mm riser per member'}];h.audit.state.resultMap.set('b',{id:'b',base_length_m:3.5,additions_length_m:.5,length_m:4,total_length_m:8,issues:[]});
    h.audit.state.session.snapshot.items=[a,b,other,trace];h.audit.state.tool='select';h.audit.state.selected=new Set(['b']);
    assert.deepEqual(new Set(h.audit.settingsSelectedItems().map(item=>item.id)),new Set(['a','b']));
    const {ui,element,all}=h.dom;ui.settingsPanel=element();ui.layout=element();ui.tools={settings:element()};ui.target={value:'steel_vermiculite'};h.audit.state.settingsOpen=true;h.audit.setApi(async()=>({columns:[]}));h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor,quantity=all.call(h.dom,ui.settingsPanel).find(el=>el.attributes['aria-label']==='Count/QTY');assert.equal(quantity.value,2);assert.equal(quantity.readOnly,true);assert.equal(editor.quantity,null);assert.equal(editor.lengths.length,2);assert.deepEqual(copy(editor.lengths.map(entry=>entry.field.control.value)),[3.5,5]);assert.ok(!ui.settingsPanel.textContent.includes("Change length for group"));assert.ok(!ui.settingsPanel.textContent.includes("Apply settings"));assert.ok(!ui.settingsPanel.textContent.includes("Discard settings"));assert.equal(editor.appearance.find(field=>field.control.name==='marker_shape').control.value,'circle');assert.ok(ui.settingsPanel.textContent.includes('2 markers · Manual base: 3.50 m each + additions: 0.50 m each · Total: 8.00 m'));
    const level=editor.fields.find(field=>field.control.name==='level').control;level.value='L2';level.events.input();h.audit.setAsk(async()=>({}));let sent;h.audit.setCommand(async(op,body)=>{sent={op,...copy(body)};});await h.audit.applySettings(editor);assert.equal(sent.op,'bulk_update');assert.deepEqual(new Set(sent.item_ids),new Set(['a','b']));assert.deepEqual(sent.changes,{fields:{level:'L2'}});assert.equal(h.audit.state.settingsDirty,false);
    h.audit.state.selected=new Set(['b','trace']);const regrouped=copy(h.audit.state.session.snapshot),survivor=regrouped.items.find(item=>item.id==='a');survivor.member_ids.push(...b.member_ids);survivor.geometry.points.push(...b.geometry.points);survivor.quantity+=b.quantity;regrouped.items=regrouped.items.filter(item=>item.id!=='b');h.audit.accept({...response(regrouped),regrouped_item_ids:['a']});assert.deepEqual(new Set(h.audit.state.selected),new Set(['a','trace']));assert.deepEqual(copy(h.audit.selectedCountMemberIds(survivor)),b.member_ids);
  });
  await check('Continue Count keeps source identity pinned, prompts a fresh explicit length, and sends no client technical details',async()=>{
    const h=countHarness(),a=countItem('a','A',3.25,[[10,20],[40,50]]);h.audit.state.session.snapshot.items=[copy(a)];h.audit.state.tool='select';const ref=h.audit.pointReference(a,1);h.audit.continueCount(ref,a.member_ids[1]);
    assert.equal(h.audit.state.tool,'count');assert.equal(h.audit.state.countContinuation.itemId,ref.itemId);assert.equal(h.audit.state.countContinuation.geometry,ref.geometry);assert.equal(h.audit.state.countDefaultLength,null);let asked=0,sent;
    h.audit.setAsk(async(title,definitions)=>{asked++;assert.equal(title,'Counted member length');assert.equal(definitions[1][3],false);return{length_m:3.25,reuse:true};});
    h.audit.state.session.revision++;const entry=h.stage([80,90]);await h.audit.queueCountLength(entry);assert.equal(asked,1);
    h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);sent={op,...copy(body)};return{regrouped_item_ids:['a']};});await h.audit.finishCount();
    assert.deepEqual(sent,{op:'continue_count',item_id:'a',markers:[{point:[80,90],length_m:3.25}]});assert.equal(h.audit.state.countContinuation,null);assert.equal(h.audit.state.countDefaultLength,null);assert.equal(h.audit.state.tool,'select');assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a]);
  });
  await check('Continue Count cannot revive a cancelled or stale source and refuses unfinished edits',async()=>{
    for(const fault of ['cancel','details','geometry','page','dirty']){
      const h=countHarness(),a=countItem('a','A',3,[[10,20]]);h.audit.state.session.snapshot.items=[copy(a)];h.audit.state.tool='select';const ref=h.audit.pointReference(a,0);let commands=0;h.audit.setCommand(async()=>{commands++;return{created_item_ids:[]};});
      if(fault==='dirty'){h.audit.state.settingsDirty=true;assert.throws(()=>h.audit.continueCount(ref,a.member_ids[0]),/unfinished/);assert.equal(h.audit.state.countContinuation,null);continue;}
      h.audit.continueCount(ref,a.member_ids[0]);h.audit.state.countDefaultLength=3;const entry=h.stage([60,70]);await h.audit.queueCountLength(entry);
      if(fault==='cancel'){h.audit.cancelTrace();assert.equal(h.audit.state.countContinuation,null);assert.equal(h.audit.state.countEntries.length,0);}
      else{if(fault==='details'){h.audit.state.session.revision++;h.audit.state.session.snapshot.items[0].fields.mark='Changed';}else if(fault==='geometry'){h.audit.state.session.revision++;h.audit.state.session.snapshot.items[0].geometry.points[0]=[12,22];}else h.audit.state.page=2;const before=copy(h.audit.state.session.snapshot.items);await assert.rejects(h.audit.finishCount(),/changed/);assert.deepEqual(copy(h.audit.state.session.snapshot.items),before);}
      assert.equal(commands,0);h.audit.cancelTrace();
    }
  });
  await check('Marker selection is explicit, toggles exact members, and prunes deleted physical identities',async()=>{
    const h=countHarness(),a=countItem('a','A',3,[[10,20],[40,50]]),b=countItem('b','B',7,[[70,80]]);h.audit.state.session.snapshot.items=[copy(a),copy(b)];h.audit.state.tool='select';h.audit.state.selected=new Set(['a']);
    assert.deepEqual(copy(h.audit.selectedCountMemberIds(a)),a.member_ids);
    await h.audit.selectCountMarker('b',b.member_ids[0]);assert.deepEqual([...h.audit.state.selected],['b']);assert.deepEqual(copy(h.audit.selectedCountMemberIds(b)),b.member_ids);
    await h.audit.selectCountMarker('a',a.member_ids[1],true);assert.deepEqual(new Set(h.audit.state.selected),new Set(['a','b']));assert.deepEqual(copy(h.audit.selectedCountMemberIds(a)),[a.member_ids[1]]);
    await h.audit.selectCountMarker('a',a.member_ids[1],true);assert.deepEqual([...h.audit.state.selected],['b']);assert.equal(h.audit.state.countSelection.has('a'),false);
    const value=copy(h.audit.state.session.snapshot);value.items=value.items.filter(item=>item.id!=='b');value.revision++;h.audit.accept(response(value));assert.equal(h.audit.state.selected.size,0);assert.equal(h.audit.state.countSelection.size,0);
  });
  await check('Shared Count settings preserve the exact selected members when other length rows are returned',async()=>{
    const h=countHarness(),a=countItem('a','A',3,[[10,20],[40,50]]),b=countItem('b','A',7,[[70,80]]);h.audit.state.session.snapshot.items=[copy(a),copy(b)];h.audit.state.tool='select';h.audit.state.selected=new Set(['a']);h.audit.state.countSelection=new Map([['a',new Set([a.member_ids[0]])]]);
    const updated=copy(h.audit.state.session.snapshot);for(const item of updated.items)item.appearance={stroke_color:'#A020F0'};updated.revision++;h.audit.accept({...response(updated),regrouped_item_ids:['a','b']});
    assert.deepEqual([...h.audit.state.selected],['a']);assert.deepEqual(copy(h.audit.selectedCountMemberIds(updated.items[0])),[a.member_ids[0]]);assert.deepEqual(copy(h.audit.selectedCountMemberIds(updated.items[1])),[]);
  });
  await check('Count register Qty remains disabled after operations, and deleting a selected marker does not select other rows',async()=>{
    const h=countHarness(),a=countItem('a','batch',5,[[10,10]]),b=countItem('b','batch',8,[[20,20]]);h.audit.state.session.snapshot.items=[a,b];h.audit.state.tool='select';h.audit.state.selected=new Set(['a']);h.audit.state.settingsOpen=true;
    const option={disabled:false};h.dom.ui.bulkField={value:'quantity',querySelector(){return option;}};h.audit.renderRegister();const controls=h.dom.all(h.dom.ui.tableWrap).filter(el=>el.tagName==='INPUT'||el.tagName==='SELECT');const quantity=controls.filter(el=>el.attributes['aria-label']==='Quantity');assert.equal(quantity.length,2);quantity.forEach(el=>{assert.equal(el.readOnly,true);assert.equal(el.disabled,true);assert.equal(el.events.change,undefined);el.closest=()=>null;});assert.equal(option.disabled,true);assert.equal(h.dom.ui.bulkField.value,'mark');assert.equal(h.dom.ui.split.disabled,true);assert.equal(h.dom.ui.merge.disabled,true);
    h.dom.ui.tableWrap.querySelectorAll=()=>quantity;h.dom.ui.status=h.dom.element();h.audit.working(true);h.audit.working(false);quantity.forEach(el=>assert.equal(el.disabled,true));
    const reference=h.audit.pointReference(a,0);let sent;h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);sent={op,...copy(body)};const snapshot=copy(h.audit.state.session.snapshot);snapshot.items=snapshot.items.filter(item=>item.id!=='a');snapshot.revision++;h.audit.accept(response(snapshot));return response(snapshot);});await h.audit.deleteCountMarker(reference,a.member_ids[0]);assert.deepEqual(sent,{op:'delete_count_marker',item_id:'a',member_id:'a-member-0'});assert.deepEqual([...h.audit.state.selected],[]);await assert.rejects(h.audit.deleteCountMarker(reference,a.member_ids[0]),/changed/);
  });
  await check('Scale inspection disables drawing navigation and restores only available controls without unlocking unrelated fields',()=>{
    const h=countHarness(),{ui,element}=h.dom,mode=element('button'),unavailable=element('button'),tool=element('button'),unrelated=element('input');
    mode.dataset.mode='steel';unavailable.dataset.mode='unsupported';tool.dataset.tool='trace';unrelated.disabled=true;
    const pageControls=[element('button'),element('input'),element('button')];ui.root.querySelectorAll=()=>[mode,unavailable,tool,unrelated];ui.pageControls=element();ui.pageControls.querySelectorAll=()=>pageControls;ui.documentSelect=element('select');ui.status=element();
    h.audit.working(true);assert.equal(ui.root.attributes['aria-busy'],'true');assert.equal(ui.status.textContent,'Working…');for(const control of[mode,unavailable,tool,unrelated,...pageControls,ui.documentSelect])assert.equal(control.disabled,true);
    h.audit.working(false);assert.equal(ui.root.attributes['aria-busy'],'false');for(const control of[mode,tool,...pageControls,ui.documentSelect])assert.equal(control.disabled,false);assert.equal(unavailable.disabled,true);assert.equal(unrelated.disabled,true);
    h.audit.state.session.snapshot.documents=[];h.audit.working(false);assert.equal(ui.documentSelect.disabled,true,'An empty project has no selectable drawing');assert.equal(unrelated.disabled,true);
  });
  await check('Surface previews preserve area and interior labels across winding, translation, concavity and exclusions',()=>{
    const square=[[0,0],[10,0],[10,10],[0,10]],hole=[[2,2],[8,2],[8,8],[2,8]],original=copy(square);
    for(const points of [square,[...square].reverse()]){
      assert.deepEqual(geometry.ringMetrics(points),{area:100,centre:[5,5]});
      const result=geometry.surfaceMetrics({points,exclusions:[{points:hole}]});assert.equal(result.area,64);assert.deepEqual(result.centre,[5,5]);assert.ok(result.label[0]<2||result.label[0]>8);assert.ok(result.label[0]>0&&result.label[0]<10);
    }
    assert.deepEqual(square,original);const translated=square.map(p=>[p[0]+1e12,p[1]-1e12]);assert.deepEqual(geometry.ringMetrics(translated),{area:100,centre:[1e12+5,-1e12+5]});
    const concave=geometry.surfaceMetrics({points:[[0,0],[10,0],[10,2],[2,2],[2,10],[0,10]]});assert.equal(concave.area,36);assert.ok(concave.label[0]<2||concave.label[1]<2);
    const edge=geometry.surfaceMetrics({points:square,exclusions:[{points:[[1,1],[9,1],[9,6],[1,6]]}]});assert.equal(edge.area,60);assert.ok(edge.label[0]<1||edge.label[0]>9||edge.label[1]>6||edge.label[1]<1,'Label is strictly off the opening boundary');
    const fallback=geometry.surfaceMetrics({points:square,exclusions:[{points:[[.875,1],[9.125,1],[9.125,5],[.875,5]]},{points:[[1,5.5],[9,5.5],[9,6],[1,6]]}]});assert.equal(fallback.area,63);assert.deepEqual(fallback.label,[.5,5.75]);
    assert.equal(geometry.surfaceMetrics({points:[[1e16,0],[1e16+2,0],[1e16+2,2],[1e16,2]]}).label,null,'Omit labels when no interior coordinate is representable');
    assert.throws(()=>geometry.ringMetrics([[0,0],[1,1],[2,2]]),/positive area/);assert.throws(()=>geometry.surfaceMetrics({points:square,exclusions:[{points:square}]}),/positive surface/);
  });
  await check('Surface labels use the server quantity while provisional m2 requires the exact active uniform calibration',()=>{
    const h=harness(),value=blank(),surface={kind:'polygon',document_id:'doc',page:3,points:[[20,30],[120,30],[120,130],[20,130]],exclusions:[{id:'hole',points:[[40,50],[60,50],[60,70],[40,70]]}]};
    value.calibrations=[{id:'scale',document_id:'doc',page:3,points:[[20,30],[120,30]],distance_m:4,uniform_scale:true}];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,viewport:{transform:[0,2,2,0,-60,-40]}});const dom=attachMinimalDom(h);
    const preview=h.audit.surfacePreview(surface,'scale');assert.ok(Math.abs(preview.area_m2-15.36)<1e-12);h.audit.renderSurfaceLabel(dom.ui.overlay,surface,'scale',{area:9.87654321,itemId:'a'});assert.equal(dom.ui.overlay.children[0].textContent,'9.88 m²');assert.equal(dom.ui.overlay.children[0].dataset.areaItemId,'a');
    h.audit.renderSurfaceLabel(dom.ui.overlay,surface,'scale',{preview:true});assert.equal(dom.ui.overlay.children[1].textContent,'15.36 m² · Preview');
    h.audit.state.session.snapshot.calibrations.push({...value.calibrations[0],id:'retired',supersedes_id:'scale',deleted:true});assert.equal(h.audit.surfacePreview(surface,'scale').area_m2,null);
    h.audit.state.session.snapshot.calibrations=value.calibrations;h.audit.state.session.snapshot.calibrations[0].uniform_scale=false;assert.equal(h.audit.surfacePreview(surface,'scale').area_m2,null);
  });
  await check('Point movement copies only the chosen vertex and preserves holes, precision and stale-write guards',async()=>{
    const h=harness(),value=blank(),item={id:'a',mode:'wall',fields:{mark:'W'},geometry:{kind:'polygon',document_id:'doc',page:3,points:[[0,0],[100,0],[100,100],[0,100]],exclusions:[{id:'hole',note:'Window',points:[[20,20],[40,20],[40,40],[20,40]]}]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'wall',selected:new Set(['a'])});
    const reference=h.audit.pointReference(item,1,'hole'),original=copy(item);let calls=0,sent;h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);calls++;sent={op,...copy(body)};});await h.audit.moveControlPoint(reference,[40,20]);assert.equal(calls,0);await h.audit.moveControlPoint(reference,[43.123456789,21.987654321]);assert.equal(sent.op,'update_item');assert.deepEqual(Object.keys(sent.changes),['geometry']);assert.deepEqual(sent.changes.geometry.points,item.geometry.points);assert.deepEqual(sent.changes.geometry.exclusions[0],{...item.geometry.exclusions[0],points:[[20,20],[43.123456789,21.987654321],[40,40],[20,40]]});assert.deepEqual(item,original);
    await assert.rejects(h.audit.moveControlPoint(reference,[NaN,0]),/finite/);h.audit.state.formDirty=true;await assert.rejects(h.audit.moveControlPoint(reference,[45,25]),/unfinished/);h.audit.state.formDirty=false;h.audit.state.session.revision++;await assert.rejects(h.audit.moveControlPoint(reference,[45,25]),/selection changed/);assert.equal(calls,1);
  });
  await check('Delete markup confirms one exact target and rechecks replacement or hidden drawings before writing',async()=>{
    const h=harness(),value=blank(),item={id:'a',mode:'steel',fields:{mark:'A'},geometry:{document_id:'doc',page:3,points:[[0,0],[30,40]]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item,{...copy(item),id:'b'}];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'steel',selected:new Set(['a','b'])});h.audit.setSelectionRenderer(()=>{});const ref=h.audit.pointReference(item,0);let calls=0;
    h.audit.setAsk(async(title,definitions,detail,action)=>{assert.equal(title,'Delete markup?');assert.equal(action,'Delete markup');assert.match(detail,/Source documents are retained/);return {};});h.audit.setCommand(async(op,payload,guard)=>{assert.equal(guard(),true);assert.equal(op,'delete_items');assert.deepEqual(copy(payload),{item_ids:['a']});calls++;});await h.audit.deleteMarkup(ref);assert.equal(calls,1);
    h.audit.setAsk(async()=>{h.audit.state.session.revision++;return {};});await assert.rejects(h.audit.deleteMarkup(ref),/takeoff changed during deletion review/);assert.equal(calls,1);h.audit.state.session.revision--;h.audit.state.hidden.add('a');await assert.rejects(h.audit.deleteMarkup(ref),/markup or drawing changed/);assert.equal(calls,1);
  });
  await check('Linked calculator operations recheck dirty edits, stale sessions and target guards after asynchronous capture',async()=>{
    for(const change of ['register','settings','session','revision','guard']){
      const h=linkedOperationHarness(),capture=deferred();let reserved=0,sent=0,guardCalls=0;
      h.context.window.CeasefireCalculators={captureTakeoffTargets:()=>capture.promise,reserveTakeoffTargets(){reserved++;},releaseTakeoffTarget(){throw Error('No reservation should exist');},applyTakeoffTargets(){throw Error('No response should be applied');}};h.audit.setApi(async()=>{sent++;});
      const guard=()=>{guardCalls++;if(change==='guard'&&guardCalls>1)throw Error('The visible target changed');return true;},operation=h.audit.linkedCalculatorOperation('linked-delete',['steel_board'],{item_ids:['a']},guard);await flush();assert.equal(h.audit.state.busy,true);assert.deepEqual(h.controls.map(control=>control.disabled),[true,true]);
      if(change==='register')h.audit.state.formDirty=true;else if(change==='settings')h.audit.state.settingsDirty=true;else if(change==='session')h.audit.state.session.session_id='replacement';else if(change==='revision')h.audit.state.session.revision++;
      capture.resolve({fingerprint:'captured',calculators:{steel_board:{inputs:{},schedule_rows:[]}}});await assert.rejects(operation,change==='register'||change==='settings'?/unfinished/:change==='guard'?/visible target changed/:/project changed/);assert.equal(reserved,0);assert.equal(sent,0);assert.equal(h.audit.state.busy,false);assert.deepEqual(h.controls.map(control=>control.disabled),[false,true]);
    }
  });
  await check('Linked deletion retries one lost response with the same identity and releases the reservation after success or a definite server refusal',async()=>{
    for(const outcome of ['success','server-error']){
      const h=linkedOperationHarness(),lease={id:'lease'},captured={steel_board:{inputs:{Sheet:{A1:'Retained'}},schedule_rows:[5]}},calls=[],applied=[];let releases=0;
      h.context.window.CeasefireCalculators={async captureTakeoffTargets(ids){assert.deepEqual(copy(ids),['steel_board']);return{fingerprint:'captured',calculators:captured};},reserveTakeoffTargets(ids,fingerprint){assert.equal(fingerprint,'captured');return lease;},applyTakeoffTargets(value,reservation){assert.equal(reservation,lease);applied.push(copy(value));},releaseTakeoffTarget(reservation){assert.equal(reservation,lease);releases++;}};
      h.audit.setApi(async(endpoint,payload)=>{calls.push({endpoint,payload:copy(payload)});if(outcome==='server-error')throw Error('Linked row changed');if(calls.length===1)throw vm.runInContext('new TypeError("Connection lost")',h.context);const reply=response({...blank(),revision:1,audit_head:'a'.repeat(64)});reply.calculators={steel_board:{inputs:{Sheet:{A1:'Retained'}},schedule_rows:[]}};return reply;});
      const operation=h.audit.linkedCalculatorOperation('linked-delete',['steel_board'],{item_ids:['a']});if(outcome==='success'){await operation;assert.equal(h.audit.state.session.revision,1);assert.equal(applied.length,1);}else await assert.rejects(operation,/Linked row changed/);
      assert.equal(releases,1);assert.equal(h.audit.state.busy,false);assert.deepEqual(h.controls.map(control=>control.disabled),[false,true]);assert.equal(calls.length,outcome==='server-error'?1:2);assert.equal(calls[0].endpoint,'/sessions/session/linked-delete');assert.deepEqual(calls[0].payload.calculators,captured);assert.deepEqual(calls[0].payload.item_ids,['a']);assert.equal(calls[0].payload.expected_revision,0);assert.match(calls[0].payload.request_id,/^[a-f0-9-]{36}$/);if(calls.length===2)assert.deepEqual(calls[1],calls[0]);
    }
  });
  await check('Uncertain or malformed linked responses retain the exact request and locks until a single valid recovery updates both drafts',async()=>{
    for(const fault of ['network','unreadable','missing-snapshot','empty-snapshot','snapshot-revision','bad-results','missing-calculators','apply-error']){
      const h=linkedOperationHarness(),initial=blank();initial.items=[{id:'a',mode:'steel',quantity:1,fields:{mark:'Retained until recovery'}}];h.audit.accept(response(initial));
      const before=copy(h.audit.state.session),lease={id:'retained-lease'},captured={steel_board:{inputs:{Sheet:{A5:'Retained until recovery'}},schedule_rows:[5]}},valid=response({...blank(),revision:1,audit_head:'a'.repeat(64)});valid.calculators={steel_board:{inputs:{Sheet:{A5:null}},schedule_rows:[5]}};
      const calls=[],applied=[];let captures=0,reservations=0,releases=0,failing=true,retryResponse=null;
      h.context.window.CeasefireCalculators={async captureTakeoffTargets(){captures++;return{fingerprint:'original',calculators:captured};},reserveTakeoffTargets(){reservations++;return lease;},applyTakeoffTargets(value,reservation){assert.equal(reservation,lease);if(failing&&fault==='apply-error')throw Error('The captured calculator cannot accept this reply');if(!value?.steel_board?.inputs)throw Error('The linked calculator response is incomplete');applied.push(copy(value));},releaseTakeoffTarget(reservation){assert.equal(reservation,lease);releases++;}};
      h.audit.setApi(async(endpoint,payload)=>{calls.push({endpoint,payload:copy(payload)});if(!failing)return retryResponse?retryResponse.promise:copy(valid);if(fault==='network')throw vm.runInContext('new TypeError("Connection lost")',h.context);if(fault==='unreadable'){const error=Error('Unreadable response');error.uncertainOutcome=true;throw error;}const bad=copy(valid);if(fault==='missing-snapshot')delete bad.snapshot;else if(fault==='empty-snapshot')bad.snapshot={};else if(fault==='snapshot-revision')bad.snapshot.revision=99;else if(fault==='bad-results')bad.item_results={};else if(fault==='missing-calculators')delete bad.calculators;return bad;});
      await assert.rejects(h.audit.linkedCalculatorOperation('linked-delete',['steel_board'],{item_ids:['a']}),/Retry linked change/,fault);const pending=h.audit.state.linkedRecovery;assert.ok(pending,fault);assert.equal(pending.reservation,lease);assert.equal(h.audit.state.busy,true);assert.deepEqual(h.controls.map(control=>control.disabled),[true,true]);assert.equal(releases,0);assert.deepEqual(copy(h.audit.state.session),before);assert.equal(applied.length,0);assert.throws(()=>h.api.projectSnapshot(),/current takeoff operation/);await assert.rejects(h.api.prepareDefaults(),/takeoff operation/);assert.equal(h.api.hasUnsavedChanges(),true);
      const firstRequest=copy(calls[0]);assert.deepEqual(copy(pending.payload),firstRequest.payload);assert.equal(firstRequest.payload.expected_revision,0);assert.deepEqual(firstRequest.payload.calculators,captured);await h.audit.recoverLinkedOperation();assert.equal(h.audit.state.linkedRecovery,pending);assert.equal(pending.retrying,false);assert.equal(releases,0);assert.equal(h.audit.state.busy,true);assert.equal(applied.length,0);assert.ok(h.audit.state.ui.message.textContent.includes('Retry linked change'));
      failing=false;retryResponse=deferred();const priorCalls=calls.length,recovering=h.audit.recoverLinkedOperation();await flush();assert.equal(pending.retrying,true);await h.audit.recoverLinkedOperation();assert.equal(calls.length,priorCalls+1,'Concurrent recovery must share the active request');assert.equal(h.audit.state.busy,true);retryResponse.resolve(copy(valid));await recovering;
      assert.equal(h.audit.state.linkedRecovery,null);assert.equal(h.audit.state.busy,false);assert.deepEqual(h.controls.map(control=>control.disabled),[false,true]);assert.equal(releases,1);assert.equal(captures,1);assert.equal(reservations,1);assert.equal(applied.length,1);assert.deepEqual(applied[0],valid.calculators);assert.equal(h.audit.state.session.revision,1);assert.deepEqual(copy(h.audit.state.session.snapshot),valid.snapshot);for(const call of calls)assert.deepEqual(call,firstRequest,'Every retry must retain the original request identity and inputs');
    }
  });
  await check('Recovery after a display failure never reapplies calculator rows that already passed batch validation',async()=>{
    const h=linkedOperationHarness(),lease={id:'lease'},reply=response({...blank(),revision:1,audit_head:'b'.repeat(64)});reply.calculators={steel_board:{inputs:{Sheet:{A5:null}},schedule_rows:[5]}};const calls=[];let applies=0,releases=0,renders=0;
    h.context.window.CeasefireCalculators={async captureTakeoffTargets(){return{fingerprint:'captured',calculators:{steel_board:{inputs:{Sheet:{A5:'Original'}},schedule_rows:[5]}}};},reserveTakeoffTargets(){return lease;},applyTakeoffTargets(){applies++;},releaseTakeoffTarget(reservation){assert.equal(reservation,lease);releases++;}};
    h.audit.setApi(async(endpoint,payload)=>{calls.push({endpoint,payload:copy(payload)});return copy(reply);});h.audit.setDataRenderer(()=>{renders++;if(renders===1)throw Error('Temporary display failure');});
    await assert.rejects(h.audit.linkedCalculatorOperation('linked-delete',['steel_board'],{item_ids:['a']}),/Retry linked change/);assert.equal(h.audit.state.linkedRecovery.calculatorsApplied,true);assert.equal(h.audit.state.session.revision,1);assert.equal(applies,1);assert.equal(releases,0);assert.equal(h.audit.state.busy,true);
    await h.audit.recoverLinkedOperation();assert.equal(applies,1);assert.equal(renders,2);assert.equal(releases,1);assert.equal(h.audit.state.linkedRecovery,null);assert.equal(h.audit.state.busy,false);assert.deepEqual(h.controls.map(control=>control.disabled),[false,true]);assert.deepEqual(calls[1],calls[0]);
  });
  await check('An unreadable takeoff API response is explicitly marked as an uncertain outcome',async()=>{
    const h=harness();h.context.fetch=async()=>({ok:true,status:200,async json(){throw Error('Truncated JSON');}});await assert.rejects(h.audit.requestApi('/sessions/session/linked-delete',{}),error=>error.uncertainOutcome===true&&/unreadable response \(200\)/.test(error.message));
    h.context.fetch=async()=>({ok:false,status:409,async json(){return{error:'Stale revision'};}});await assert.rejects(h.audit.requestApi('/sessions/session/linked-delete',{}),error=>error.uncertainOutcome!==true&&error.message==='Stale revision');
  });
  await check('Point drag fingerprints track provisional movement and clear on click or cancellation without changing geometry',()=>{
    const h=harness(),value=blank(),item={id:'a',mode:'steel',fields:{mark:'A'},geometry:{document_id:'doc',page:3,points:[[10,20],[30,40]]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,mode:'steel',selected:new Set(['a']),viewport:{transform:[1,0,0,1,0,0],width:100,height:100},planController:{abort(){}}});
    const dom=attachMinimalDom(h),element=dom.element();dom.ui.viewport=element;element.focus=()=>{};element.setPointerCapture=()=>{};element.removeEventListener=(event)=>{delete element.events[event];};dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100});let notifications=0;h.context.window.CeasefireProject.changed=()=>{notifications++;};h.audit.setPointSelector(()=>{});
    const event={type:'pointerdown',button:0,pointerId:1,clientX:10,clientY:20,target:{closest(){return null;}},preventDefault(){},stopPropagation(){}};const ref=h.audit.pointReference(item,0),baseline=h.api.projectFingerprint();h.audit.beginControlPointDrag(event,ref);const first=h.api.projectFingerprint();assert.notEqual(first,baseline);element.events.pointerup({...event,type:'pointerup'});assert.equal(h.api.projectFingerprint(),baseline);assert.equal(notifications,2);
    h.audit.beginControlPointDrag(event,ref);element.events.pointermove({...event,clientX:20,clientY:30});const half=h.api.projectFingerprint();element.events.pointermove({...event,clientX:25,clientY:35});assert.notEqual(h.api.projectFingerprint(),half);assert.deepEqual(copy(h.audit.state.session.snapshot.items[0].geometry),item.geometry);h.audit.cancelSelectionGesture();assert.equal(h.api.projectFingerprint(),baseline);assert.equal(notifications,6);
  });
  await check('Dragging an unselected Count marker moves only that point and retains manual length and member identity',async()=>{
    const h=countHarness(),a=countItem('a','A',3.125,[[10,20],[40,50]]),b=countItem('b','B',7,[[70,80]]);h.audit.state.session.snapshot.items=[copy(a),copy(b)];Object.assign(h.audit.state,{tool:'select',selected:new Set(['b']),planController:{abort(){}}});
    const element=h.dom.ui.viewport;element.focus=()=>{};element.setPointerCapture=()=>{};element.removeEventListener=event=>{delete element.events[event];};let sent;
    h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);sent={op,...copy(body)};const value=copy(h.audit.state.session.snapshot);for(const marker of body.markers){const item=value.items.find(item=>item.id===marker.item_id),index=item.member_ids.indexOf(marker.member_id);item.geometry.points[index]=item.geometry.points[index].map((v,axis)=>v+body.delta_pdf[axis]);}value.revision++;h.audit.accept(response(value));});
    const event={type:'pointerdown',button:0,pointerId:1,clientX:40,clientY:50,target:{closest(){return null;}},preventDefault(){},stopPropagation(){}};
    h.audit.beginCountMarkerDrag(event,a,1,a.member_ids[1]);element.events.pointermove({...event,clientX:65,clientY:75});assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a,b]);element.events.pointerup({...event,clientX:65,clientY:75});await flush();
    assert.deepEqual(sent,{op:'move_count_markers',markers:[{item_id:'a',member_id:a.member_ids[1]}],delta_pdf:[25,25]});
    const expected=copy(a);expected.geometry.points[1]=[65,75];assert.deepEqual(copy(h.audit.state.session.snapshot.items),[expected,b]);assert.equal(h.audit.state.gesture,null);assert.match(h.dom.ui.message.textContent,/Manual lengths and quantities are unchanged/);
  });
  await check('Dragging selected Count markers sends one exact cross-row subset and keeps provisional geometry outside the snapshot',async()=>{
    const h=countHarness(),a=countItem('a','A',3.125,[[10,20],[40,50]]),b=countItem('b','A',7,[[70,80],[110,130]]);h.audit.state.session.snapshot.items=[copy(a),copy(b)];Object.assign(h.audit.state,{tool:'select',selected:new Set(['a','b']),countSelection:new Map([['a',new Set([a.member_ids[1]])],['b',new Set([b.member_ids[0]])]]),planController:{abort(){}}});
    const el=h.dom.ui.viewport;el.setPointerCapture=()=>{};el.removeEventListener=event=>{delete el.events[event];};let calls=0,sent;h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);calls++;sent={op,...copy(body)};});
    const event={type:'pointerdown',button:0,pointerId:1,clientX:40,clientY:50,target:{closest(){return null;}},preventDefault(){},stopPropagation(){}};
    const before=h.api.projectFingerprint();h.audit.beginCountMarkerDrag(event,a,1,a.member_ids[1]);el.events.pointermove({...event,clientX:45,clientY:56});const interim=h.api.projectFingerprint();assert.notEqual(interim,before);el.events.pointermove({...event,clientX:52,clientY:63});assert.notEqual(h.api.projectFingerprint(),interim);assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a,b]);el.events.pointerup({...event,clientX:52,clientY:63});await flush();
    assert.equal(calls,1);assert.deepEqual(sent,{op:'move_count_markers',markers:[{item_id:'a',member_id:a.member_ids[1]},{item_id:'b',member_id:b.member_ids[0]}],delta_pdf:[12,13]});assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a,b]);assert.equal(h.audit.state.gesture,null);assert.deepEqual(copy(h.audit.selectedCountMemberIds(a)),[a.member_ids[1]]);assert.deepEqual(copy(h.audit.selectedCountMemberIds(b)),[b.member_ids[0]]);
  });
  await check('Count marker drag rejects dirty settings and cancels stale gestures without moving any marker',async()=>{
    const h=countHarness(),a=countItem('a','A',3,[[10,20],[40,50]]);h.audit.state.session.snapshot.items=[copy(a)];Object.assign(h.audit.state,{tool:'select',selected:new Set(),planController:{abort(){}}});
    const element=h.dom.ui.viewport;element.focus=()=>{};element.setPointerCapture=()=>{};element.removeEventListener=event=>{delete element.events[event];};let commands=0;h.audit.setCommand(async()=>{commands++;});
    const event={type:'pointerdown',button:0,pointerId:1,clientX:10,clientY:20,target:{closest(){return null;}},preventDefault(){},stopPropagation(){}};
    h.audit.state.settingsDirty=true;assert.throws(()=>h.audit.beginCountMarkerDrag(event,a,0,a.member_ids[0]),/unfinished/);assert.equal(h.audit.state.selected.size,0);h.audit.state.settingsDirty=false;
    h.audit.beginCountMarkerDrag(event,a,0,a.member_ids[0]);element.events.pointermove({...event,clientX:20,clientY:35});h.audit.cancelSelectionGesture();assert.equal(h.audit.state.selected.size,0);assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a]);
    h.audit.beginCountMarkerDrag(event,a,0,a.member_ids[0]);element.events.pointermove({...event,clientX:20,clientY:35});h.audit.state.session.revision++;element.events.pointerup({...event,clientX:20,clientY:35});await flush();assert.equal(commands,0);assert.deepEqual(copy(h.audit.state.session.snapshot.items),[a]);assert.equal(h.audit.state.selected.size,0);assert.equal(h.audit.state.countSelection.size,0);
  });
  await check('Live surface cursor and provisional label never become saved vertices and undo clears them',()=>{
    const h=harness(),value=blank();value.calibrations=[{id:'scale',document_id:'doc',page:3,points:[[0,0],[100,0]],distance_m:10,uniform_scale:true}];h.audit.accept(response(value));Object.assign(h.audit.state,{document:'doc',page:3,tool:'polygon',calibration:'scale',points:[[0,0],[100,0],[100,100]],traceCursor:[0,100],viewport:{transform:[1,0,0,1,0,0]}});const dom=attachMinimalDom(h);const before=copy(h.audit.state.points);h.audit.renderPendingTrace(dom.ui.overlay);assert.deepEqual(copy(h.audit.state.points),before);assert.equal(dom.ui.overlay.children.filter(el=>el.tagName==='CIRCLE').length,3);assert.equal(dom.ui.overlay.children.at(-1).textContent,'100.00 m² · Preview');h.audit.planKeydown({key:'z',ctrlKey:true,preventDefault(){},target:{closest(){return null;}}});assert.equal(h.audit.state.traceCursor,null);assert.equal(h.audit.state.points.length,2);
  });
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
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollLeft:0,scrollWidth:200,clientWidth:200,scrollTop:200,scrollHeight:300,clientHeight:100};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;let prevented=0;
    const event={cancelable:true,deltaY:220,deltaX:0,deltaMode:0,preventDefault(){prevented++;}};assert.equal(h.audit.handoffPlanWheel(event),true);assert.equal(outer.scrollTop,320);assert.equal(viewport.scrollTop,200);
    viewport.scrollTop=0;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-3,deltaMode:1}),true);assert.equal(outer.scrollTop,272);assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-1,deltaMode:2}),true);assert.equal(outer.scrollTop,172);
    assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-500}),true);assert.equal(outer.scrollTop,0);viewport.scrollTop=200;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:2000}),true);assert.equal(outer.scrollTop,1000);assert.equal(prevented,5);
  });
  await check('Plan wheel leaves native fields, modifiers, unfocused drawing and exhausted outer space untouched',()=>{
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollLeft:0,scrollWidth:200,clientWidth:200,scrollTop:200,scrollHeight:300,clientHeight:100};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;
    const event={cancelable:true,deltaY:20,deltaX:0,preventDefault(){throw new Error('A reserved native wheel was intercepted');}};
    for(const change of [{cancelable:false},{defaultPrevented:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{deltaX:40},{deltaY:0},{deltaY:NaN},{deltaX:Infinity},{target:{isContentEditable:true}},{target:{closest(){return {};}}}])assert.equal(h.audit.handoffPlanWheel({...event,...change}),false);
    h.audit.state.planActive=false;assert.equal(h.audit.handoffPlanWheel(event),false);h.audit.state.planActive=true;outer.scrollTop=1000;assert.equal(h.audit.handoffPlanWheel(event),false);outer.scrollTop=0;viewport.scrollTop=0;assert.equal(h.audit.handoffPlanWheel({...event,deltaY:-20}),false);assert.equal(viewport.scrollTop,0);assert.equal(outer.scrollTop,0);
  });
  await check('Focused wheel preserves both axes through diagonal and circular movement without changing source data',()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const retained=copy(h.audit.state.session.snapshot);
    const outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollLeft:400,scrollTop:400,scrollWidth:1200,scrollHeight:1200,clientWidth:200,clientHeight:200};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;let cancelled=0;
    const wheel=(x,y,mode=0)=>h.audit.handoffPlanWheel({cancelable:true,deltaX:x,deltaY:y,deltaMode:mode,preventDefault(){cancelled++;}});
    assert.equal(wheel(35,20),true);assert.deepEqual([viewport.scrollLeft,viewport.scrollTop],[435,420]);
    for(const [x,y] of [[20,0],[14,14],[0,20],[-14,14],[-20,0],[-14,-14],[0,-20],[14,-14]])assert.equal(wheel(x,y),true);
    assert.deepEqual([viewport.scrollLeft,viewport.scrollTop],[435,420]);assert.equal(cancelled,9);assert.equal(outer.scrollTop,100);
    assert.equal(wheel(2,-1,1),true);assert.deepEqual([viewport.scrollLeft,viewport.scrollTop],[467,404]);
    assert.equal(wheel(-1,1,2),true);assert.deepEqual([viewport.scrollLeft,viewport.scrollTop],[267,604]);
    assert.deepEqual(copy(h.audit.state.session.snapshot),retained);
  });
  await check('A diagonal wheel stays in the drawing when either axis can move and clamps at the true limits',()=>{
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollLeft:10,scrollTop:200,scrollWidth:400,scrollHeight:300,clientWidth:200,clientHeight:100};h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;
    let cancelled=0;const wheel=(x,y)=>h.audit.handoffPlanWheel({cancelable:true,deltaX:x,deltaY:y,deltaMode:0,preventDefault(){cancelled++;}});
    assert.equal(wheel(500,20),true);assert.equal(viewport.scrollLeft,200);assert.equal(viewport.scrollTop,200);assert.equal(outer.scrollTop,100);
    assert.equal(wheel(40,20),false);assert.equal(outer.scrollTop,100);assert.equal(wheel(0,40),true);assert.equal(outer.scrollTop,140);
    assert.equal(wheel(-500,-500),true);assert.deepEqual([viewport.scrollLeft,viewport.scrollTop],[0,0]);assert.equal(outer.scrollTop,140);assert.equal(cancelled,3);
  });
  await check('Fractional native scroll limits hand exhausted wheel input to the outer page',()=>{
    const h=harness(),outer={scrollTop:100,scrollHeight:1300,clientHeight:300},viewport={scrollWidth:400,clientWidth:200,scrollHeight:300,clientHeight:100};
    // The true native maxima are half a pixel below rounded DOM dimensions.
    let left=199.5,top=199.5;
    Object.defineProperties(viewport,{scrollLeft:{get(){return left;},set(value){left=Math.max(0,Math.min(199.5,value));}},scrollTop:{get(){return top;},set(value){top=Math.max(0,Math.min(199.5,value));}}});
    h.context.document.scrollingElement=outer;h.audit.state.ui={viewport};h.audit.state.planActive=true;
    let cancelled=0;const wheel=(x,y)=>h.audit.handoffPlanWheel({cancelable:true,deltaX:x,deltaY:y,deltaMode:0,preventDefault(){cancelled++;}});
    assert.equal(wheel(0,220),true);assert.equal(outer.scrollTop,320);assert.deepEqual([left,top],[199.5,199.5]);
    assert.equal(wheel(-10,20),true);assert.deepEqual([left,top],[189.5,199.5]);assert.equal(outer.scrollTop,320);
    assert.equal(cancelled,2);
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
  await check('Surface registers ignore hidden legacy sorting and combine search with column filters while preserving selected identities',()=>{
    const h=harness(),value=blank();value.items=[{id:'wall-large',mode:'wall',fields:{mark:'W1',treatment:'Board'},state:'draft',version:1},{id:'wall-small',mode:'wall',fields:{mark:'W2',treatment:'Spray'},state:'draft',version:1},{id:'slab',mode:'slab',fields:{mark:'S1'},state:'draft',version:1}];
    h.audit.accept({...response(value),item_results:[{id:'wall-large',net_area_m2:72},{id:'wall-small',net_area_m2:18},{id:'slab',net_area_m2:5}]});h.audit.state.mode='wall';h.audit.state.sort='area';h.audit.state.selected.add('wall-large');
    assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),['wall-large','wall-small']);
    h.audit.state.filter='spray';assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),['wall-small']);assert.ok(h.audit.state.selected.has('wall-large'));
    h.audit.registerFilters().set('treatment',new Set(['Board']));assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),[]);h.audit.state.filter='';assert.deepEqual(copy(h.audit.visibleItems()).map(value=>value.id),['wall-large']);
    assert.equal(h.audit.state.resultMap.get('wall-large').net_area_m2,72);assert.equal(h.audit.state.resultMap.get('wall-small').net_area_m2,18);
  });
  await check('Area records cannot invoke calculator transfers, option lookup, link changes or linear split/merge',async()=>{
    const h=harness();let calls=0;h.audit.setApi(async()=>{calls++;throw new Error('Unexpected area calculator request');});
    for(const mode of ['wall','slab']){
      h.audit.state.mode=mode;
      await assert.rejects(h.audit.transfer(false),/cannot transfer/);await assert.rejects(h.audit.transfer(true),/cannot transfer/);
      await assert.rejects(h.audit.detachSelected(),/no calculator/);await assert.rejects(h.audit.manageLinkedRows(),/no calculator/);
      await assert.rejects(h.audit.splitSelected(),/splitting is unavailable/);await assert.rejects(h.audit.mergeSelected(),/merging is unavailable/);
      const value=blank();value.items=[{id:'surface',mode,fields:{}}];h.audit.accept(response(value));h.audit.state.selected=new Set(['surface']);await h.audit.loadSettingsOptions({});
    }
    assert.equal(calls,0);
  });
  await check('Missing surface geometry remains inspectable with a trash-only action group and confirmation warning',async()=>{
    for(const mode of ['wall','slab']){
      const h=harness(),value=blank(),item={id:'diagnostic-surface',mode,version:1,state:'draft',quantity:1,fields:{mark:'Missing source'},geometry:null,measurement:null,evidence:[],member_ids:[]};value.items=[item];
      h.audit.accept({...response(value),item_results:[{id:item.id,issues:[{code:'MISSING_GEOMETRY',message:'Source geometry required.'}]}]});h.audit.state.mode=mode;
      const dom=attachSettings(h);await h.audit.openItemSettings(item);
      assert.ok(h.audit.state.selected.has(item.id));assert.ok(dom.ui.tableWrap.textContent.includes('Source markup missing'));assert.ok(dom.ui.settingsPanel.textContent.includes('Source markup is missing'));
      const buttons=dom.all(dom.ui.settingsPanel).filter(node=>node.tagName==='BUTTON');
      assert.ok(!buttons.find(button=>button.attributes['aria-label']==='Delete item').disabled);
      for(const label of ['Change surface calibration','Re-trace geometry','Edit surface vertices','Add excluded opening','Attach source on current page','Change length basis','Replace source on current page','Add evidence reference','Riser/Drop'])assert.ok(!buttons.some(button=>button.textContent===label),label);
      assert.match(dom.ui.settingsPanel.textContent,/review and confirmation remain blocked/);
      await assert.rejects(h.audit.startExclusion(),/no source boundary/);await assert.rejects(h.audit.editAreaBoundary(item),/Attach source geometry/);await assert.rejects(h.audit.changeAreaCalibration(item),/Attach source geometry/);
      h.audit.state.retraceId=item.id;assert.equal(h.audit.areaTraceLimit(),1000);
    }
  });
  await check('Every traced item keeps only the labelled trash icon in its Item Details action group',async()=>{
    for(const mode of ['steel','duct','wall','slab']){
      const h=harness(),value=blank(),item={id:'traced-item',mode,version:1,state:'draft',quantity:1,fields:{mark:'A1',...(mode==='duct'?{shape:'rectangular'}:{})},geometry:{document_id:'doc',page:1,points:[[0,0],[50,0],[50,50]],...(mode==='wall'||mode==='slab'?{kind:'polygon',exclusions:[]}:{})},measurement:{method:'calibrated',calibration_id:'scale'},evidence:[]};value.items=[item];h.audit.accept(response(value));h.audit.state.mode=mode;
      const dom=attachSettings(h);await h.audit.openItemSettings(item);const actions=h.audit.state.settingsEditor.tools.children.find(node=>node.classList.contains('actions'));
      assert.equal(actions.children.length,1,mode);const control=actions.children[0];assert.equal(control.attributes['aria-label'],'Delete item');assert.equal(control.title,'Delete item');assert.ok(control.classList.contains('icon-only'));assert.equal(dom.all(control).filter(node=>node.tagName==='SVG').length,1);
    }
  });
  await check('Legacy traces with an omitted default geometry kind offer Rise/Drop from their control-point menu',()=>{
    const h=harness(),value=blank(),item={id:'trace',mode:'steel',version:1,quantity:1,fields:{mark:'B1'},geometry:{document_id:'doc',page:1,points:[[20,20],[150,150]]},measurement:{method:'calibrated',calibration_id:'scale'}};value.items=[item];h.audit.accept(response(value));const dom=attachMinimalDom(h);dom.ui.viewport=dom.element();dom.ui.viewport.clientWidth=200;dom.ui.viewport.clientHeight=200;dom.ui.viewport.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});Object.assign(h.audit.state,{document:'doc',page:1,mode:'steel',tool:'select',selected:new Set([item.id]),viewport:{width:200,height:200,transform:[1,0,0,1,0,0]},controlMenu:true});h.audit.state.controlPoint=h.audit.pointReference(item,0);h.audit.renderControlPoints(dom.ui.overlay);
    const buttons=dom.all(dom.ui.overlay).filter(el=>el.tagName==='BUTTON');assert.ok(buttons.some(el=>el.textContent==='Insert Rise / Drop'));assert.equal(buttons.find(el=>el.textContent==='Delete control point').disabled,true);
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
      attachMinimalDom(h);Object.assign(h.audit.state.ui,{root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{classList:{toggle(){}}}});
      h.audit.setTool(tool,{retraceId:'old-item'});assert.equal(h.audit.state.retraceId,'old-item');
      h.audit.setTool('select');assert.equal(h.audit.state.retraceId,null);h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.setTool(tool);assert.equal(h.audit.state.retraceId,null);
      h.audit.setTool(tool,{retraceId:'old-item'});h.audit.state.viewport=null;await h.audit.discardEditor();assert.equal(h.audit.state.retraceId,null);
    }
    const h=harness();h.audit.state.mode='wall';h.audit.state.viewport={};attachMinimalDom(h);Object.assign(h.audit.state.ui,{root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{classList:{toggle(){}}}});
    h.audit.setTool('exclusion',{exclusionItemId:'old-surface'});assert.equal(h.audit.state.exclusionItemId,'old-surface');h.audit.setTool('pan');assert.equal(h.audit.state.exclusionItemId,null);assert.throws(()=>h.audit.setTool('exclusion'),/Select one surface/);
  });
  await check('Dirty register edits block every geometry-writing tool and zero-point manual calibration is cancellable',async()=>{
    const h=harness();h.audit.state.calibration='scale';h.audit.state.viewport={};h.audit.state.ui={root:{querySelectorAll(){return[];}},viewport:{dataset:{},focus(){}},progress:{classList:{toggle(){}}},overlay:{replaceChildren(){}}};
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
  await check('Selecting a surface uses final numeric-mark pagination while ignoring hidden legacy groups',async()=>{
    const h=harness(),value=blank();value.items=Array.from({length:101},(_,i)=>({id:`surface-${i}`,mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:String(i),group:i===100?'A':'Z'},geometry:null,measurement:null,evidence:[],member_ids:[]}));
    h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.group='group';h.audit.state.sort='mark';h.audit.state.collapsed.add('A');const {ui}=attachMinimalDom(h);
    await h.audit.selectItem('surface-100',false,false);
    assert.equal(h.audit.state.offset,100);assert.ok(h.audit.state.collapsed.has('A'));assert.ok(ui.tableWrap.querySelectorAll('[data-item-id]').some(row=>row.dataset.itemId==='surface-100'&&row.classList.contains('selected')));
    h.audit.state.collapsed.add('Z');await h.audit.selectItem('surface-99',false,false);
    assert.equal(h.audit.state.offset,0);assert.ok(h.audit.state.collapsed.has('Z'));assert.equal(ui.tableWrap.querySelectorAll('[data-item-id]').length,100);assert.ok(ui.tableWrap.querySelectorAll('[data-item-id]').some(row=>row.dataset.itemId==='surface-99'&&row.classList.contains('selected')));
  });
  await check('Register View/Edit actions open left settings without an inline editor and retain pending edits through register filtering',async()=>{
    const h=harness(),value=blank(),item={id:'surface',mode:'wall',version:1,state:'draft',quantity:1,fields:{mark:'W1',level:'L01',group:'West'},geometry:null,measurement:null,evidence:[],member_ids:[]};
    value.items=[item];h.audit.accept(response(value));h.audit.state.mode='wall';const dom=attachSettings(h);await h.audit.openItemSettings(item);
    const editor=h.audit.state.settingsEditor,level=editor.fields.find(field=>field.control.name==='level').control;
    assert.equal(h.audit.state.settingsOpen,true);assert.equal(dom.ui.settingsPanel.scrollTop,0);assert.ok(dom.ui.tableWrap.textContent.includes('View/Edit'));assert.ok(!dom.ui.tableWrap.textContent.includes('ITEM DETAILS'));
    const actions=dom.all(dom.ui.tableWrap).filter(node=>node.tagName==='BUTTON');assert.ok(actions.some(node=>(node.attributes['aria-label']||node.textContent)==='View'));assert.ok(actions.some(node=>(node.attributes['aria-label']||node.textContent)==='Edit item'));
    level.value='L02';level.events.input();const before=copy(h.audit.state.session.snapshot);
    h.audit.state.filter='No matching item';h.audit.renderRegister();assert.equal(h.audit.state.settingsEditor,editor);assert.equal(level.value,'L02');assert.ok(dom.all(dom.ui.settingsPanel).includes(level));
    h.audit.state.filter='';h.audit.registerFilters().set('level',new Set(['L01']));h.audit.renderRegister();assert.equal(h.audit.state.settingsEditor,editor);assert.ok(dom.all(dom.ui.settingsPanel).includes(level));assert.equal(dom.ui.tableWrap.querySelectorAll('[data-item-id]').length,1);
    assert.throws(()=>h.api.projectSnapshot(),/unfinished/);assert.deepEqual(copy(h.audit.state.session.snapshot),before);
    let sent;h.audit.setCommand(async(op,body)=>{sent={op,...copy(body)};Object.assign(h.audit.state.session.snapshot.items[0].fields,body.changes.fields);});await h.audit.flushSettings();
    assert.deepEqual(sent,{op:'bulk_update',item_ids:['surface'],changes:{fields:{level:'L02'}}});assert.equal(h.audit.state.settingsDirty,false);assert.equal(h.api.projectSnapshot().items[0].fields.level,'L02');
  });
  await check('Register fields, View/Edit and settings tools reject a replacement project after a pending settings flush',async()=>{
    for(const action of ['register','view','edit','delete']){
      const h=harness(),value=blank(),item={id:'same-id',version:1,mode:'duct',quantity:1,fields:{mark:'Original',shape:'rectangular',width_mm:100,height_mm:200}};value.items=[item];h.audit.accept(response(value));h.audit.state.mode='duct';const dom=attachSettings(h,'ductwork');
      if(action==='delete')await h.audit.openItemSettings(item);else h.audit.renderRegister();
      const pending=deferred();h.audit.setFlushSettings(()=>pending.promise);let commands=0,dialogs=0;h.audit.setCommand(async()=>{commands++;});h.audit.setAsk(async()=>{dialogs++;return {};});let operation;
      if(action==='register'){const field=dom.all(dom.ui.tableWrap).find(node=>node.attributes['aria-label']==='WxH (mm)');field.value='150x250';field.events.change();}
      else if(action==='delete')dom.all(dom.ui.settingsPanel).find(node=>node.tagName==='BUTTON'&&(node.attributes['aria-label']||node.textContent)==='Delete item').events.click();
      else operation=action==='view'?h.audit.viewItem(item):h.audit.openItemSettings(item);
      await flush();const replacement=blank();replacement.items=[{...copy(item),fields:{...item.fields,mark:'Replacement'}}];h.audit.accept(response(replacement,'replacement-session'));pending.resolve();
      if(operation)await assert.rejects(operation,/project changed/);else{await flush();assert.match(dom.ui.message.textContent,/project changed/);}
      assert.equal(commands,0);assert.equal(dialogs,0);assert.equal(h.audit.state.session.snapshot.items[0].fields.mark,'Replacement');assert.equal(h.audit.state.session.snapshot.items[0].fields.width_mm,100);
    }
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
  await check('Automatic settings debounce typing, serialize later edits, and retain values after a failed request',async()=>{
    const h=countHarness(),item=countItem('a','batch',3,[[10,10]]),{ui,element}=h.dom;
    h.audit.state.session.snapshot.items=[item];h.audit.state.selected=new Set(['a']);h.audit.state.tool='select';h.audit.state.settingsOpen=true;
    ui.settingsPanel=element();ui.layout=element();ui.tools={settings:element()};ui.target={value:'steel_vermiculite'};h.audit.setApi(async()=>({columns:[]}));h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor,field=editor.fields.find(entry=>entry.control.name==='level').control,calls=[],held=deferred();
    h.audit.setAsk(async()=>{throw new Error('Automatic settings must not ask for confirmation');});
    h.audit.setCommand(async(op,body)=>{calls.push({op,...copy(body)});if(calls.length===1)await held.promise;Object.assign(item.fields,body.changes.fields);});
    field.value='F';field.events.input();field.value='FIRST';field.events.input();assert.equal(calls.length,0);assert.equal(h.timers.size,1);
    [...h.timers.values()][0]();await flush();assert.equal(calls.length,1);assert.equal(calls[0].changes.fields.level,'FIRST');
    field.value='LATEST';field.events.input();const settling=h.audit.flushSettings();held.resolve();await settling;await flush();
    assert.equal(calls.length,2);assert.equal(calls[1].changes.fields.level,'LATEST');assert.equal(h.audit.state.settingsDirty,false);assert.equal(h.audit.state.settingsEditor,editor);assert.equal(field.value,'LATEST');
    h.audit.setCommand(async()=>{throw new Error('Synthetic server refusal');});field.value='RETRY';field.events.input();await assert.rejects(h.audit.flushSettings(),/Synthetic server refusal/);assert.equal(field.value,'RETRY');assert.equal(h.audit.state.settingsDirty,true);
    h.audit.setCommand(async(op,body)=>Object.assign(item.fields,body.changes.fields));await h.audit.flushSettings();assert.equal(item.fields.level,'RETRY');assert.equal(h.audit.state.settingsDirty,false);
    field.value='SAVED';field.events.input();const saved=await h.api.completeProjectSnapshot();assert.equal(saved.items[0].fields.level,'SAVED');assert.equal(h.audit.state.settingsDirty,false);
    field.value='CLOSED';field.events.input();assert.equal(await h.audit.discardEditor(),true);assert.equal(item.fields.level,'CLOSED');assert.equal(h.audit.state.settingsDirty,false);
  });
  await check('Inline Count lengths pin exact member identities and invalid input blocks writes without losing edits',async()=>{
    const h=countHarness(),a=countItem('a','batch',3,[[10,10]]),b=countItem('b','batch',4,[[20,20]]),{ui,element}=h.dom;
    h.audit.state.session.snapshot.items=[a,b];h.audit.state.selected=new Set(['a']);h.audit.state.tool='select';h.audit.state.settingsOpen=true;
    ui.settingsPanel=element();ui.layout=element();ui.tools={settings:element()};ui.target={value:'steel_vermiculite'};h.audit.setApi(async()=>({columns:[]}));h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor,first=editor.lengths[0],second=editor.lengths[1],held=deferred(),sent=[];
    h.audit.setCommand(async(op,body,guard)=>{guard();sent.push({op,...copy(body)});if(sent.length===1){await held.promise;const merged=copy(a);merged.measurement.length_m=4;merged.member_ids.push(...b.member_ids);merged.geometry.points.push(...b.geometry.points);merged.quantity=2;const value=copy(h.audit.state.session.snapshot);value.items=[merged];value.revision++;h.audit.accept(response(value));h.audit.renderSettingsPanel();}});
    first.field.control.value='4';first.field.control.events.input();const applying=h.audit.applySettings(editor);await flush();second.field.control.value='6';second.field.control.events.input();held.resolve();await applying;
    assert.deepEqual(sent,[{op:'update_count_lengths',groups:[{member_ids:a.member_ids,length_m:4}]},{op:'update_count_lengths',groups:[{member_ids:b.member_ids,length_m:6}]}]);
    const current=h.audit.state.settingsEditor,entry=current.lengths[0];entry.field.control.value='0';entry.field.control.events.input();const count=sent.length;h.context.document.activeElement=entry.field.control;entry.field.control.validity={rangeUnderflow:true};ui.settingsPanel.contains=element=>element===entry.field.control;[...h.timers.values()].at(-1)();await flush();assert.equal(sent.length,count);assert.notEqual(ui.message.attributes.role,'alert');await assert.rejects(h.audit.flushSettings(),/positive finite/);assert.equal(sent.length,count);assert.equal(entry.field.control.value,'0');assert.equal(h.audit.state.settingsDirty,true);
    h.audit.state.ui=null;h.api.applyProject({session:null,saved:null});assert.equal(h.audit.state.settingsEditor,null);assert.equal(h.audit.state.settingsDirty,false);
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
  await check('Icon actions keep original accessible names/tooltips, the Add to Schedule plus glyph and the linked-row clock',async()=>{
    const h=harness(),dom=attachMinimalDom(h);
    for(const label of ['‹ Page','Page ›','Select','Pan','Trace length','Fit page','Upload PDFs','Search','Stop search','Preview transfer','Update linked rows','Detach links']){
      const control=h.audit.button(label,()=>{});assert.equal(control.attributes['aria-label'],label);assert.equal(control.title,label);assert.ok(control.classList.contains('icon-only'));assert.equal(control.children.at(-1).textContent,label);assert.ok(control.children.at(-1).classList.contains('sr-only'));
      if(label==='Preview transfer')assert.equal(control.children[0].textContent,'+');else assert.equal(dom.all(control).filter(node=>node.tagName==='SVG').length,1);
    }
    let updates=0;const update=h.audit.button('Update linked rows',()=>{updates++;});const clock=dom.all(update).find(node=>node.tagName==='SVG');
    assert.equal(clock.children.length,1);assert.equal(clock.children[0].attributes.d,'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 6v6h6');
    assert.equal(clock.attributes.stroke,'currentColor');assert.equal(clock.attributes.fill,'none');assert.equal(clock.attributes['stroke-linecap'],'round');assert.equal(clock.attributes['stroke-linejoin'],'round');
    update.events.click();await flush();assert.equal(updates,1);
    assert.equal(dom.all(h.audit.button('Detach links',()=>{})).find(node=>node.tagName==='PATH').attributes.d,'M15 7h2a5 5 0 0 1 0 10h-2M9 17H7A5 5 0 0 1 7 7h2');
    const ordinary=h.audit.button('Confirm',()=>{});assert.equal(ordinary.textContent,'Confirm');assert.ok(!ordinary.classList.contains('icon-only'));
  });
  await check('Steel creation includes destination fields and new ducts default rectangular without replacing legacy shape data',async()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const definitions=copy(h.audit.creationFields('steel'));
    assert.deepEqual(definitions.map(field=>field[0]),['mark','level','member_type','section','fire_period_min','exposure','product','critical_temperature','quantity']);
    assert.equal(definitions.find(field=>field[0]==='product')[1],'Product');
    h.audit.state.ui={target:{value:'steel_board'}};assert.ok(h.audit.creationFields('steel').some(field=>field[0]==='sides'));
    for(const mode of ['steel','duct','wall','slab'])assert.ok(h.audit.editableFields(mode,'steel_board').every(field=>!['zone','group','notes'].includes(field[0])));
    assert.ok(!h.audit.editableFields('steel','steel_vermiculite').some(field=>field[0]==='sides'));assert.ok(h.audit.editableFields('steel','steel_board').some(field=>field[0]==='sides'));
    const dom=attachMinimalDom(h);dom.ui.target={value:'ductwork'};dom.ui.viewport={dataset:{}};h.audit.state.mode='duct';let created;
    h.audit.setAsk(async()=>({mark:'D1',quantity:1}));h.audit.setCommand(async(op,payload)=>{assert.equal(op,'create_item');created=copy(payload.item);});
    await h.audit.createDrawnItem({method:'cited',length_m:2,citation:'Dimension'},null,[]);assert.equal(created.fields.shape,'rectangular');assert.equal(created.quantity,1);assert.equal(created.fields.diameter_mm,undefined);
  });
  await check('Wall and slab creation retain all entered Item Details with exact source geometry and single-surface evidence',async()=>{
    for(const mode of ['wall','slab']){
      const h=harness();h.audit.accept(response(blank()));const dom=attachMinimalDom(h);dom.ui.viewport={dataset:{}};h.audit.state.mode=mode;
      const entered={mark:mode==='wall'?'W-02':'S-04',surface_basis:mode==='wall'?'wall-face':'slab-soffit',level:'L03',substrate:'Concrete 180 mm',treatment:'Fire protection',system:'Specified system',product:'Specified product',frl:'-/120/120',surface_citation:'Elevation A-301, true projection'},geometry={kind:'polygon',document_id:'original-doc',page:3,points:[[1.123456789,2],[20,2],[20,30]],exclusions:[]},measurement={method:'calibrated',calibration_id:'retained-scale'},evidence=[{document_id:'original-doc',page:3,note:'Retained source citation'}];let created;
      h.audit.setAsk(async(title,definitions,detail,submit)=>{
        assert.equal(title,`Add ${mode} surface`);assert.equal(submit,'Add surface');assert.match(detail,/true projection/);assert.match(detail,/No height, second face or multiplier is inferred/);
        assert.deepEqual(copy(definitions.map(field=>field[0])),[...Object.keys(entered),'quantity']);
        for(const key of ['mark','surface_basis','surface_citation','quantity'])assert.equal(definitions.find(field=>field[0]===key)[4],true,key);
        for(const key of ['level','substrate','treatment','system','product','frl'])assert.equal(definitions.find(field=>field[0]===key)[4],false,key);
        assert.deepEqual(copy(definitions.find(field=>field[0]==='quantity').slice(2)),[[['1','One physical treatment surface']],'',true]);
        assert.deepEqual(copy(definitions.find(field=>field[0]==='surface_basis')[2]),mode==='wall'?[['wall-face','Wall face (true elevation)']]:[['slab-soffit','Slab soffit'],['slab-top','Slab top']]);
        return {...entered,quantity:'1'};
      });
      h.audit.setCommand(async(op,payload)=>{assert.equal(op,'create_item');created=copy(payload.item);});await h.audit.createDrawnItem(measurement,geometry,evidence);
      assert.deepEqual(created.fields,entered);assert.equal(created.mode,mode);assert.equal(created.quantity,1);assert.deepEqual(created.geometry,geometry);assert.deepEqual(created.measurement,measurement);assert.deepEqual(created.evidence,evidence);assert.ok(h.audit.state.selected.has(created.id));
      for(const quantity of ['',null,1,'2']){h.audit.setAsk(async()=>({...entered,quantity}));h.audit.setCommand(async()=>{throw new Error('Invalid physical quantity must not create an item');});await assert.rejects(h.audit.createDrawnItem(measurement,geometry,evidence),/Identify one physical treatment surface/);}
    }
  });
  await check('Steel creation reloads exact calculator options for chosen product/member and never rewrites entered profile',async()=>{
    const h=harness();h.audit.accept(response(blank()));const controls=['product','member_type','section'].map(name=>({control:{name,value:name==='member_type'?'Beam':name==='section'?'Explicit profile':'',isConnected:false,events:{},addEventListener(event,fn){this.events[event]=fn;}}})),calls=[];
    h.audit.setApi(async path=>{const url=new URL(path,'http://localhost');if(url.searchParams.get('calculator')==='steel_board')calls.push(url);return {columns:[{column:'C',options:[]}]};});await h.audit.configureSteelCreation(controls,'steel_board');
    assert.equal(calls[0].searchParams.get('calculator'),'steel_board');assert.equal(calls[0].searchParams.get('member_type'),'Beam');
    controls[0].control.value='PROMATECT 250';controls[0].control.events.change();await flush();assert.equal(calls.at(-1).searchParams.get('product'),'PROMATECT 250');
    controls[1].control.value='Column';controls[1].control.events.change();await flush();assert.equal(calls.at(-1).searchParams.get('member_type'),'Column');assert.equal(controls[2].control.value,'Explicit profile');
  });
  await check('Direct Confirm sends one authoritative confirmation command and filters historical review states as Unconfirmed',async()=>{
    const h=harness(),value=blank();value.items=[{id:'old',mode:'steel',state:'reviewed',fields:{mark:'A'}},{id:'new',mode:'steel',state:'draft',fields:{mark:'B'}},{id:'confirmed',mode:'steel',state:'confirmed',fields:{mark:'C'}}];h.audit.accept(response(value));h.audit.state.selected.add('new');
    let action;h.audit.setAsk(async(title,definitions,detail,submit)=>{assert.equal(title,'Confirm 1 items?');assert.equal(submit,'Confirm items');assert.match(detail,/every riser\/drop/);return {};});h.audit.setCommand(async(op,payload)=>{action={op,...copy(payload)};});await h.audit.confirmSelected();assert.equal(action.op,'confirm_items');assert.deepEqual(action.item_ids,['new']);
    h.audit.state.ui={statusFilter:{value:'unconfirmed'}};h.audit.registerFilters().set('confirmation',new Set(['Unconfirmed']));assert.deepEqual(copy(h.audit.visibleItems()).map(item=>item.id),['old','new']);h.audit.state.group='state';assert.equal(h.audit.itemGroup(value.items[0]),null);assert.equal(value.items[0].state,'reviewed');
  });
  await check('Rise/drop dialogs ask only Type and length, retain the exact anchor and legacy citation, and reject stale edits',async()=>{
    const h=harness(),value=blank(),item={id:'steel',mode:'steel',version:1,quantity:3,fields:{mark:'B1'},geometry:{document_id:'doc',page:1,points:[[1.123456789,2.987654321],[4,6]]},measurement:{method:'calibrated',calibration_id:'scale'},length_additions:[]};value.documents=[{id:'doc',name:'Elevations.pdf',pages:[{page:1},{page:2}]}];value.items=[item];h.audit.accept(response(value));h.audit.state.document='doc';h.audit.state.page=1;h.audit.state.selected.add(item.id);
    let calls=[],addition={kind:'riser',length_mm:2500};h.audit.setAsk(async(title,definitions,detail)=>{assert.match(detail,/each member/);assert.deepEqual(copy(definitions.map(field=>field[0])),['kind','length_mm']);return {...addition};});h.audit.setCommand(async(op,payload,guard)=>{guard?.();calls.push(copy(payload));});
    await h.audit.editLengthAddition(item,null,h.audit.pointReference(item,0));const first=calls[0].changes.length_additions[0];assert.match(first.id,/^[a-f0-9-]{36}$/);assert.equal(first.length_mm,2500);assert.equal(first.document_id,'doc');assert.equal(first.page,1);assert.deepEqual(first.anchor,{point_index:0,point:[1.123456789,2.987654321]});assert.equal(first.note,undefined);
    first.note='Retained legacy elevation citation';h.audit.state.session.snapshot.items[0].length_additions=[first];item.length_additions=[first];addition.length_mm=3000;await h.audit.editLengthAddition(item,first);assert.equal(calls[1].changes.length_additions[0].id,first.id);assert.equal(calls[1].changes.length_additions[0].length_mm,3000);assert.equal(calls[1].changes.length_additions[0].note,first.note);assert.deepEqual(calls[1].changes.length_additions[0].anchor,first.anchor);
    assert.match(h.audit.lengthSummary(item,{base_length_m:2,additions_length_m:3,length_m:5,total_length_m:15}),/Base: 2\.00 m \+ riser\/drop: 3\.00 m = 5\.00 m per member · Quantity 3 · Total: 15\.00 m/);
    for(const malformed of [{length_mm:0},{length_mm:Infinity},{page:3},{page:1.5},{kind:'height'}])assert.throws(()=>h.audit.parsedLengthAddition({...addition,document_id:'doc',page:1,...malformed},first.id));
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
    for(const key of ['page','pageCount','progress','zoom','pageWrap','empty'])dom.ui[key]=dom.element();let replacement;
    dom.ui.pageWrap.style={};dom.ui.panSpace={style:{}};dom.ui.canvas={replaceWith(value){replacement=value;}};dom.ui.overlay.getBoundingClientRect=()=>({left:30,top:40});dom.ui.viewport={getBoundingClientRect:()=>({left:0,top:0}),clientWidth:500,clientHeight:500,scrollLeft:0,scrollTop:0};
    h.audit.state.autoScalePages=new Set([JSON.stringify([h.audit.state.session.session_id,'doc',1])]);
    h.audit.setPdfTools(async()=>({}),async()=>page);h.audit.setCommand(async()=>{});h.audit.state.tool='trace';h.audit.state.points=[[10,10]];h.audit.state.viewport={width:200,height:200,transform:[1,0,0,-1,0,200]};
    const rendering=h.audit.renderPage({point:[10,10],offset:[50,60]});await flush();assert.equal(h.audit.state.viewport,null);assert.equal(replacement,undefined);
    h.audit.drawingPointer({button:0,detail:1,clientX:100,clientY:100,preventDefault(){throw new Error('Trace click must be ignored while display transform is unavailable');}});assert.deepEqual(copy(h.audit.state.points),[[10,10]]);
    pending.resolve();await rendering;assert.equal(h.audit.state.viewport,viewport);assert.equal(h.audit.state.ui.canvas,replacement);assert.ok(replacement);assert.equal(h.audit.state.zoomAnchor,null);
  });
  await check('Viewport second-click completion survives SVG replacement and finishes once even if dblclick also arrives',async()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',name:'Detail.pdf',pages:[{page:1,view:[0,0,200,200]}]}];h.audit.accept(response(value));const dom=attachMinimalDom(h);
    dom.ui.viewport=dom.element();dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});Object.assign(h.audit.state,{document:'doc',page:1,viewport:{width:200,height:200,transform:[1,0,0,1,0,0]},tool:'viewport'});
    const held=deferred();let calls=0,finished;h.audit.setFinishTrace(async()=>{calls++;finished=copy(h.audit.state.points);await held.promise;});const click=(x,y,detail=1)=>({clientX:x,clientY:y,button:0,detail,preventDefault(){}});
    h.audit.drawingPointer(click(20,30));const priorShape=dom.ui.overlay.children[0];h.audit.drawingPointer(click(120,140));assert.notEqual(dom.ui.overlay.children[0],priorShape,'The first click replaces SVG children');assert.equal(calls,0);
    h.audit.drawingPointer(click(120,140,2));await flush();assert.equal(calls,1,'The detail-two click completes without requiring a native dblclick');assert.deepEqual(finished,[[20,30],[120,140]]);
    await h.audit.finishTraceFromDoubleClick(click(120,140,2));assert.equal(calls,1,'A later native dblclick does not complete the same viewport again');held.resolve();await flush();assert.equal(calls,1);
  });
  await check('Viewport corners remain rectangular and require a valid explicit finish without inheriting another scale boundary',async()=>{
    const h=harness(),value=blank();value.documents=[{id:'doc',name:'Detail.pdf',pages:[{page:1,view:[0,0,200,200]}]}];value.calibrations=[{id:'detail',document_id:'doc',page:1,region:[0,0,30,30]}];h.audit.accept(response(value));const dom=attachMinimalDom(h);
    dom.ui.viewport=dom.element();dom.ui.overlay.getBoundingClientRect=()=>({left:0,top:0,width:200,height:200});Object.assign(h.audit.state,{document:'doc',page:1,viewport:{width:200,height:200,transform:[1,0,0,1,0,0]},calibration:'detail',tool:'viewport'});
    let finished=0;h.audit.setFinishTrace(async()=>{finished++;});const click=(x,y,detail=1)=>({clientX:x,clientY:y,button:0,detail,preventDefault(){}}),doubleClick={preventDefault(){}};
    h.audit.drawingPointer(click(50,50));h.audit.tracePointerMove(click(120,140));assert.deepEqual(copy(h.audit.state.points),[[50,50]]);assert.deepEqual(copy(h.audit.state.traceCursor),[120,140]);
    const preview=dom.ui.overlay.children.find(el=>el.className.includes('takeoff-viewport-preview'));assert.equal(preview.tagName,'POLYGON');assert.equal(preview.attributes.points,'50,50 120,50 120,140 50,140');assert.equal(dom.ui.overlay.children.filter(el=>el.tagName==='CIRCLE').length,2);
    h.audit.drawingPointer(click(120,140));assert.equal(finished,0);assert.deepEqual(copy(h.audit.state.points),[[50,50],[120,140]]);
    h.audit.drawingPointer(click(130,150));assert.deepEqual(copy(h.audit.state.points),[[50,50],[130,150]],'Further clicks adjust the opposite corner instead of introducing polygon vertices');
    h.audit.drawingPointer(click(250,150));h.audit.drawingPointer(click(250,150,2));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,0,'An outside-page endpoint cannot finish the earlier rectangle');
    h.audit.drawingPointer(click(130,150));h.audit.drawingPointer(click(130,150,2));await h.audit.finishTraceFromDoubleClick(doubleClick);assert.equal(finished,1);assert.equal(h.audit.state.points.length,2);
    h.audit.planKeydown({key:'Backspace',preventDefault(){},target:{closest(){return null;}}});assert.deepEqual(copy(h.audit.state.points),[[50,50]]);assert.equal(h.audit.state.traceCursor,null);
  });
  await check('Viewport preview transforms original corners without rounding or fabricating surface quantities',async()=>{
    const h=harness(),value=blank();h.audit.accept(response(value));const dom=attachMinimalDom(h);Object.assign(h.audit.state,{tool:'viewport',points:[[20.125,30.25],[80.75,90.5]],viewport:{transform:[0,2,2,0,-60,-40]}});
    h.audit.renderPendingTrace(dom.ui.overlay);const preview=dom.ui.overlay.children.find(el=>el.className.includes('takeoff-viewport-preview'));assert.equal(preview.attributes.points,'0.5,0.25 0.5,121.5 121,121.5 121,0.25');assert.deepEqual(copy(h.audit.state.points),[[20.125,30.25],[80.75,90.5]]);assert.ok(dom.ui.overlay.children.every(el=>el.tagName!=='TEXT'),'A scale viewport has no inferred m² quantity');
    h.audit.state.points=[[20,30]];await assert.rejects(h.audit.finishTrace(),/two opposite corners/);h.audit.state.points=[[20,30],[20,90]];await assert.rejects(h.audit.finishTrace(),/nonzero viewport/);
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
  await check('Board settings load choices from current controls and retain independent physical Exposure options',async()=>{
    const h=countHarness(),item={id:'member',version:1,mode:'steel',quantity:1,fields:{member_type:'Column',product:'Old product',exposure:'Historic physical exposure'}};
    h.audit.state.session.snapshot.items=[item];h.audit.state.selected=new Set([item.id]);h.audit.state.tool='select';h.audit.state.settingsOpen=true;const dom=attachSettings(h,'steel_board'),paths=[];
    h.audit.setApi(async path=>{const query=new URL(path,'http://localhost').searchParams;paths.push(query);return query.get('calculator')==='steel_board'?{columns:[{column:'C',options:['TRAFALGAR COREX','PROMATECT 250']},{column:'J',options:query.get('member_type')==='Beam'?[620]:[550]}]}:{columns:[{column:'C',options:['Re-entrant - 3 sides','Hollow - 4 sides']}]};});
    h.audit.renderSettingsPanel();const editor=h.audit.state.settingsEditor;for(const field of editor.fields)field.control.isConnected=true;
    const member=editor.fields.find(field=>field.control.name==='member_type').control,product=editor.fields.find(field=>field.control.name==='product').control,temp=editor.fields.find(field=>field.control.name==='critical_temperature').control,exposure=editor.fields.find(field=>field.control.name==='exposure').control;
    member.value='Beam';product.value='TRAFALGAR COREX';await h.audit.loadSettingsOptions(editor);let query=paths.filter(query=>query.get('calculator')==='steel_board').at(-1);assert.equal(query.get('member_type'),'Beam');assert.equal(query.get('product'),'TRAFALGAR COREX');assert.deepEqual(temp.children.map(option=>String(option.value)),['','620']);
    assert.deepEqual(exposure.children.map(option=>option.value),['','Re-entrant - 3 sides','Hollow - 4 sides','Historic physical exposure']);assert.equal(exposure.value,'Historic physical exposure');
    member.value='Column';product.value='PROMATECT 250';await h.audit.loadSettingsOptions(editor);query=paths.filter(query=>query.get('calculator')==='steel_board').at(-1);assert.equal(query.get('member_type'),'Column');assert.equal(query.get('product'),'PROMATECT 250');assert.deepEqual(temp.children.map(option=>String(option.value)),['','550']);assert.equal(item.fields.product,'Old product');assert.equal(h.audit.state.settingsDirty,false);
  });
  await check('Native calculator selects preserve returned order and historical values while numeric choices remain JSON numbers',()=>{
    const h=harness();attachMinimalDom(h);
    for(const key of ['product','exposure','fire_period_min','critical_temperature']){
      const initial=key==='product'?'  Legacy product  ':key==='exposure'?'Legacy exposure':key==='fire_period_min'?'135':'615',field=h.audit.formField([key,key,[]],initial);field.control.isConnected=true;
      const column={product:'B',exposure:'C',fire_period_min:'H',critical_temperature:'D'}[key],values=['product','exposure'].includes(key)?['Second','First']:[120,60];
      h.audit.populateCalculatorOptions([field],{columns:[{column,options:values}]},'steel_vermiculite');assert.equal(field.control.tagName,'SELECT');assert.deepEqual(field.control.children.map(option=>String(option.value)),['',...values.map(String),initial]);assert.equal(field.control.value,initial);assert.equal(field.control.children.at(-1).textContent,`${initial} (retained)`);
      assert.equal(field.read(),['product','exposure'].includes(key)?initial:Number(initial));field.control.value='';assert.equal(field.read(),['product','exposure'].includes(key)?'':null);
    }
  });
  await check('Late options cannot replace newer choices or pending field values after selection changes',async()=>{
    const h=countHarness(),item={id:'duct',version:1,mode:'duct',quantity:1,fields:{mark:'D1',shape:'rectangular',width_mm:100,height_mm:200,product:'CAFCO 300',exposure:'Historical exposure'}};
    h.audit.state.session.snapshot.items=[item];h.audit.state.mode='duct';h.audit.state.tool='select';h.audit.state.selected=new Set(['duct']);h.audit.state.settingsOpen=true;attachSettings(h,'ductwork');h.audit.renderSettingsPanel();await flush();
    const editor=h.audit.state.settingsEditor;for(const field of editor.fields)field.control.isConnected=true;
    const product=editor.fields.find(field=>field.control.name==='product').control,exposure=editor.fields.find(field=>field.control.name==='exposure').control,level=editor.fields.find(field=>field.control.name==='level').control,pending=[];
    h.audit.setApi(path=>{const result=deferred();pending.push({path,...result});return result.promise;});const older=h.audit.loadSettingsOptions(editor);
    product.value='FyreWrap';level.value='Unsubmitted level';level.events.input();const newer=h.audit.loadSettingsOptions(editor);assert.equal(new URL(pending[1].path,'http://localhost').searchParams.get('product'),'FyreWrap');
    pending[1].resolve({columns:[{column:'C',options:['CAFCO 300','FyreWrap']},{column:'H',options:['External','Both']}]});await newer;const newest=exposure.children.map(option=>option.value);
    pending[0].resolve({columns:[{column:'C',options:['Old product']},{column:'H',options:['Old exposure']}]});await older;assert.deepEqual(exposure.children.map(option=>option.value),newest);assert.equal(product.value,'FyreWrap');assert.equal(level.value,'Unsubmitted level');assert.equal(h.audit.state.settingsDirty,true);
    const abandoned=h.audit.loadSettingsOptions(editor);h.audit.state.settingsEditor=null;pending[2].resolve({columns:[{column:'H',options:['Replacement project value']}]});await abandoned;assert.deepEqual(exposure.children.map(option=>option.value),newest);assert.equal(level.value,'Unsubmitted level');clearTimeout(editor.timer);h.timers.clear();
  });
  await check('WxH settings reject the entire pending edit atomically and preserve circular geometry and hidden data',async()=>{
    const h=countHarness(),first={id:'d1',version:1,mode:'duct',quantity:1,fields:{mark:'D1',shape:'rectangular',width_mm:100.123456789,height_mm:200.987654321,system:'Supply',notes:'keep'}},second={id:'d2',version:1,mode:'duct',quantity:1,fields:{mark:'D2',shape:'circular',diameter_mm:355,width_mm:80,height_mm:90,system:'Historical'}};
    h.audit.state.session.snapshot.items=[first,second];h.audit.state.mode='duct';h.audit.state.tool='select';h.audit.state.selected=new Set(['d1','d2']);h.audit.state.settingsOpen=true;attachSettings(h,'ductwork');h.audit.renderSettingsPanel();
    const editor=h.audit.state.settingsEditor,size=editor.fields.find(field=>field.control.name==='duct_size').control,level=editor.fields.find(field=>field.control.name==='level').control,before=copy(h.audit.state.session.snapshot),sent=[];
    h.audit.setCommand(async(op,body)=>{sent.push({op,...copy(body)});for(const item of h.audit.state.session.snapshot.items)Object.assign(item.fields,body.changes.fields);});level.value='L2';level.events.input();
    for(const invalid of ['100','100x','0x100','-2x100','Infinityx100','100x200x300','1000000000001x100']){size.value=invalid;size.events.input();await assert.rejects(h.audit.flushSettings(),/WxH/);assert.equal(sent.length,0);assert.deepEqual(copy(h.audit.state.session.snapshot),before);assert.equal(size.value,invalid);assert.equal(level.value,'L2');assert.equal(h.audit.state.settingsDirty,true);}
    size.value='125.123456789 × 250.987654321';size.events.input();await h.audit.flushSettings();assert.deepEqual(sent,[{op:'bulk_update',item_ids:['d1','d2'],changes:{fields:{level:'L2',width_mm:125.123456789,height_mm:250.987654321}}}]);assert.equal(second.fields.shape,'circular');assert.equal(second.fields.diameter_mm,355);assert.equal(second.fields.system,'Historical');assert.equal(first.fields.notes,'keep');assert.equal(h.audit.state.settingsDirty,false);
    size.value='125.123456789x250.987654321';size.events.input();await h.audit.flushSettings();assert.equal(sent.length,1,'Equivalent size text must not write or change precision');
  });
  await check('Duct creation includes its details and parses WxH before any item command',async()=>{
    const h=harness();h.audit.accept(response(blank()));const dom=attachMinimalDom(h);dom.ui.target={value:'ductwork'};dom.ui.viewport={dataset:{}};h.audit.state.mode='duct';
    const definitions=copy(h.audit.creationFields('duct'));assert.deepEqual(definitions.map(field=>field[0]),['mark','level','duct_size','product','exposure','frl','orientation','wall_penetrations','floor_penetrations','quantity']);assert.equal(definitions.find(field=>field[0]==='duct_size')[1],'WxH (mm)');assert.ok(!definitions.some(field=>field[0]==='system'));
    let entered={mark:'D1',level:'L1',duct_size:'100x',product:'FyreWrap',exposure:'External',frl:'120/120/120',orientation:'Horizontal',wall_penetrations:0,floor_penetrations:0,quantity:1},sent=[];h.audit.setAsk(async()=>copy(entered));h.audit.setCommand(async(op,body)=>sent.push({op,...copy(body)}));
    await assert.rejects(h.audit.createDrawnItem({method:'cited',length_m:2,citation:'Dimension'},null,[]),/WxH/);assert.equal(sent.length,0);
    entered.duct_size='100.123456789X200.987654321';await h.audit.createDrawnItem({method:'cited',length_m:2,citation:'Dimension'},null,[]);assert.equal(sent.length,1);const item=sent[0].item;assert.equal(item.fields.width_mm,100.123456789);assert.equal(item.fields.height_mm,200.987654321);assert.equal(item.fields.duct_size,undefined);assert.equal(item.fields.shape,'rectangular');assert.equal(item.fields.wall_penetrations,0);assert.equal(item.fields.product,'FyreWrap');
  });
  await check('Bulk fields preserve numeric steel selections and serialize WxH as two atomic numeric dimensions',async()=>{
    const h=harness(),value=blank();value.items=[{id:'a',mode:'steel',fields:{mark:'A'}}];h.audit.accept(response(value));h.audit.state.selected=new Set(['a']);const dom=attachMinimalDom(h);dom.ui.bulkValue={value:''};h.audit.setAsk(async()=>({}));const sent=[];h.audit.setCommand(async(op,body)=>sent.push({op,...copy(body)}));
    for(const [key,raw,expected] of [['fire_period_min','120',120],['critical_temperature','620',620],['fire_period_min','',null]]){dom.ui.bulkField.value=key;dom.ui.bulkValue.value=raw;await h.audit.bulkEdit();assert.equal(sent.at(-1).changes.fields[key],expected);}
    h.audit.state.mode='duct';h.audit.state.session.snapshot.items[0].mode='duct';dom.ui.bulkField.value='duct_size';dom.ui.bulkValue.value='100.123456789 x 200.987654321';await h.audit.bulkEdit();assert.deepEqual(sent.at(-1).changes,{fields:{width_mm:100.123456789,height_mm:200.987654321}});
    dom.ui.bulkValue.value='100x';const count=sent.length;await assert.rejects(h.audit.bulkEdit(),/WxH/);assert.equal(sent.length,count);
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
  await check('Add to schedule skips all linked selections without a review, calculator reservation or apply request',async()=>{
    const h=harness(),value=blank();value.items=[{id:'a',mode:'steel',fields:{mark:'Retained'},state:'unconfirmed'}];h.audit.accept(response(value));const dom=attachMinimalDom(h);dom.ui.target={value:'steel_board'};h.audit.state.selected.add('a');let requests=0;
    h.context.window.CeasefireCalculators={async captureTakeoffTarget(){return{inputs:{},schedule_rows:[],fingerprint:'f'};},reserveTakeoffTarget(){throw Error('Unexpected reservation');}};
    h.audit.setAsk(async()=>{throw Error('Unexpected review');});h.audit.setApi(async(path,body)=>{requests++;assert.ok(path.endsWith('/transfer-preview'));assert.deepEqual(copy(body.item_ids),['a']);return{revision:0,preview_id:null,changes:[],skipped:[{item_id:'a',calculator_id:'steel_board',row:9}]};});
    await h.audit.transfer(false);assert.equal(requests,1);assert.deepEqual(copy(h.audit.state.session.snapshot),value);assert.match(dom.ui.message.textContent,/No rows were added or changed/);assert.equal(dom.ui.message.attributes.role,'status');
  });
  await check('Mixed transfer review counts only unlinked items and explains which linked rows are skipped',async()=>{
    const h=harness(),value=blank();value.items=[{id:'a',mode:'steel',quantity:1,fields:{mark:'Retained'},state:'unconfirmed'},{id:'b',mode:'steel',quantity:2,fields:{mark:'New'},state:'confirmed'}];h.audit.accept(response(value));const dom=attachMinimalDom(h);dom.ui.target={value:'steel_board'};h.audit.state.selected=new Set(['a','b']);h.audit.state.resultMap.set('b',{id:'b',length_m:3,total_length_m:6});
    h.context.window.CeasefireCalculators={async captureTakeoffTarget(){return{inputs:{},schedule_rows:[],fingerprint:'f'};}};
    h.audit.setApi(async path=>path.endsWith('/transfer-preview')?{revision:0,preview_id:'p',calculator_id:'steel_board',changes:[{item_id:'b',action:'append',row:10}],bindings:[{item_id:'b',sheet:'CALCULATOR',row:10,values:{}}],skipped:[{item_id:'a',row:9,calculator_id:'steel_board'}]}:{columns:[]});
    h.audit.setAsk(async(title,definitions,detail,action)=>{assert.equal(title,'Transfer 1 confirmed items?');assert.equal(action,'Add to schedule');assert.match(detail,/Skipped 1 already-linked item.*Retained/);assert.match(detail,/Add: New/);return null;});await h.audit.transfer(false);assert.deepEqual(copy(h.audit.state.session.snapshot),value);
  });
  await check('Project snapshot awaits reviewed physical edits and their queued apply before capturing', async()=>{
    const h=harness(),value=blank();value.physical={revision:1};h.audit.accept(response(value));
    const review=deferred(),applied=deferred(),order=[];let unfinished=true;
    h.audit.setFlushSettings(async()=>order.push('settings'));
    h.audit.state.physicalUI={hasUnfinishedChanges:()=>unfinished,async completePendingEdits(){order.push('review');await review.promise;h.audit.state.queue=applied.promise.then(()=>{h.audit.state.session.snapshot.physical.revision=2;unfinished=false;order.push('applied');});}};
    let saved=false;const pending=h.api.completeProjectSnapshot().then(snapshot=>{saved=true;return snapshot;});await flush();assert.deepEqual(order,['settings','review']);assert.equal(saved,false);
    review.resolve();await flush();assert.equal(saved,false);applied.resolve();const captured=await pending;assert.equal(captured.physical.revision,2);assert.deepEqual(order,['settings','review','applied']);
  });
  await check('Cancelled physical review prevents a project snapshot and retains unfinished state', async()=>{
    const h=harness(),value=blank();value.physical={revision:1};h.audit.accept(response(value));
    h.audit.setFlushSettings(async()=>{});h.audit.state.physicalUI={hasUnfinishedChanges:()=>true,async completePendingEdits(){throw new Error('Physical review cancelled');}};
    await assert.rejects(h.api.completeProjectSnapshot(),/Physical review cancelled/);assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.audit.state.session.snapshot.physical.revision,1);
  });
  await check('Service Plans scope projects only its own graph into the editor without replacing saved Defect Reports',()=>{
    const h=harness(), value={...blank(),version:2,physical:{version:2,id:'defects',barriers:[{id:'report-barrier'}]},service_plans:{version:3,id:'plans',barriers:[{id:'plan-barrier',fields:{frl:'-/120/120'}}]},image_extractions:[]};
    h.audit.accept(response(value));assert.equal(h.audit.physicalGraph().id,'defects');
    h.audit.state.physicalScope='service_plans';const projected=h.audit.physicalSnapshot();assert.equal(projected.physical.id,'plans');assert.equal(h.audit.state.session.snapshot.physical.id,'defects');
    assert.deepEqual(copy(h.api.projectSnapshot()),value);
  });
  await check('Service Plans without drawings or defect records are still included by project Save',()=>{
    const h=harness(), value={...blank(),version:2,physical:null,service_plans:{version:3,barriers:[{id:'plan-barrier'}],services:[]},image_extractions:[]};h.audit.accept(response(value));
    assert.deepEqual(copy(h.api.projectSnapshot()),value);h.audit.state.physicalPlacing=true;assert.throws(()=>h.api.projectSnapshot(),/Finish the current/);assert.equal(h.api.hasUnsavedChanges(),true);
  });
  await check('Barrier marker references reject wrong scope, stale source, changed markers and deleted records',()=>{
    const h=harness(), marker={document_id:'doc',document_sha256:'a'.repeat(64),page:3,point:[31.25,47.75]}, entity={id:'barrier',revision:2,deleted:false,marker};
    h.audit.accept(response({...blank(),version:2,physical:null,service_plans:{version:3,barriers:[entity],services:[]},image_extractions:[]}));Object.assign(h.audit.state,{mode:'physical',physicalScope:'service_plans',document:'doc',page:3});
    const ref=h.audit.physicalMarkerReference(entity);assert.equal(h.audit.physicalMarkerTarget(ref).id,'barrier');
    h.audit.state.physicalScope='defect_reports';assert.throws(()=>h.audit.physicalMarkerTarget(ref),/changed/);h.audit.state.physicalScope='service_plans';
    h.audit.state.page=2;assert.throws(()=>h.audit.physicalMarkerTarget(ref),/changed/);h.audit.state.page=3;
    const retained=h.audit.physicalGraph().barriers[0];retained.marker.point[0]++;assert.throws(()=>h.audit.physicalMarkerTarget(ref),/changed/);retained.marker.point[0]--;
    retained.deleted=true;assert.throws(()=>h.audit.physicalMarkerTarget(ref),/changed/);retained.deleted=false;
    retained.revision++;assert.throws(()=>h.audit.physicalMarkerTarget(ref),/changed/);
  });
  await check('Callouts keep pane visibility; marker single clicks select, double clicks open and modifier deselection closes',async()=>{
    const h=harness(),state=h.audit.state,entity={id:'barrier',revision:1,deleted:false,marker:{document_id:'doc',document_sha256:'a'.repeat(64),page:1,point:[20,30]}},calls=[],opened=[];
    h.audit.accept(response({...blank(),version:2,physical:null,service_plans:{version:3,barriers:[entity],services:[]},image_extractions:[]}));Object.assign(state,{mode:'physical',physicalScope:'service_plans',document:'doc',page:1,physicalSelected:new Set(),physicalDetailsOpen:false});h.audit.setOverlayRenderer(()=>{});
    h.audit.setPhysicalDetails(open=>{opened.push(open);state.physicalDetailsOpen=open;});
    state.physicalUI={completePendingEdits:async()=>calls.push('flush'),selectDrawing:async(id,multiple,focus,openDetails)=>{calls.push({id,multiple:!!multiple,focus,openDetails});if(!multiple)state.physicalSelected.clear();if(multiple&&state.physicalSelected.has(id))state.physicalSelected.delete(id);else state.physicalSelected.add(id);},clearSelection:async()=>{calls.push('clear');state.physicalSelected.clear();}};
    for(const open of [false,true]){state.physicalDetailsOpen=open;opened.length=0;for(let i=0;i<2;i++)await h.audit.choosePhysicalDrawing(entity,{},true);assert.equal(state.physicalDetailsOpen,open);assert.deepEqual(opened,[]);assert.equal(calls.at(-1).openDetails,false);assert.ok(state.physicalSelected.has(entity.id));}
    await h.audit.choosePhysicalDrawing(entity,{ctrlKey:true},true);assert.equal(state.physicalSelected.size,0);assert.equal(state.physicalDetailsOpen,true,'Modifier deselection of a callout preserves the open pane');
    let now=1000;h.context.Date={now:()=>now};const click={type:'click',clientX:40,clientY:60};
    state.physicalDetailsOpen=false;await h.audit.choosePhysicalDrawing(entity,click);assert.equal(state.physicalDetailsOpen,false);assert.equal(calls.at(-1).openDetails,false);
    now+=150;await h.audit.choosePhysicalDrawing(entity,click);assert.equal(state.physicalDetailsOpen,true);assert.equal(calls.at(-1).openDetails,true);
    now+=150;await h.audit.choosePhysicalDrawing(entity,click);assert.equal(state.physicalDetailsOpen,true);assert.equal(state.physicalSelected.size,1);
    await h.audit.choosePhysicalDrawing(entity,{...click,ctrlKey:true});assert.equal(state.physicalSelected.size,0);assert.equal(state.physicalDetailsOpen,false);
    assert.equal(calls.filter(value=>value==='flush').length,9);
  });
  await check('Physical source regions open on double click and reject source replacement during a pending edit',async()=>{
    const h=harness(),state=h.audit.state,reference={document_id:'doc',document_sha256:'a'.repeat(64),page:1,region:[[1,1],[2,1],[2,2]]},entity={id:'service',fields:{},evidence:[reference],deleted:false};
    h.audit.accept(response({...blank(),version:2,physical:null,service_plans:{version:3,barriers:[],services:[entity]},image_extractions:[]}));Object.assign(state,{mode:'physical',tool:'select',physicalScope:'service_plans',document:'doc',page:1,physicalDetailsOpen:false});h.audit.setOverlayRenderer(()=>{});h.audit.setPhysicalDetails(open=>{state.physicalDetailsOpen=open;});
    const calls=[];state.physicalUI={completePendingEdits:async()=>{},selectDrawing:async(id,_multiple,_focus,open)=>{calls.push(open);state.physicalSelected.add(id);}};
    let now=1000;h.context.Date={now:()=>now};const click={type:'click',clientX:40,clientY:60};await h.audit.choosePhysicalEvidence(entity,reference,click);assert.equal(state.physicalDetailsOpen,false);
    now+=100;await h.audit.choosePhysicalEvidence(entity,reference,click);assert.equal(state.physicalDetailsOpen,true);assert.deepEqual(calls,[false,true]);
    const hold=deferred();state.physicalUI.completePendingEdits=()=>hold.promise;const pending=h.audit.choosePhysicalEvidence(entity,reference,click);state.session.snapshot.service_plans.services[0].evidence=[];hold.resolve();await assert.rejects(pending,/evidence or drawing changed/);assert.equal(calls.length,2);
  });
  await check('Both physical selection bridge callbacks respect presentation-only callout selection',async()=>{
    const h=harness(),dom=attachMinimalDom(h),state=h.audit.state,opened=[];let bridge;Object.assign(state,{mode:'physical',physicalDetailsOpen:false});dom.ui.physicalContainer=dom.element();dom.ui.physicalDetails=dom.element();h.audit.setOverlayRenderer(()=>{});h.audit.setPhysicalDetails(open=>opened.push(open));
    h.context.window.CeasefireTakeoffPhysical={mount(_container,value){bridge=value;return {};}};h.audit.ensurePhysicalUI();
    bridge.selectionChanged({selected:['barrier'],openDetails:false});await bridge.selection(['barrier'],null,false,false);assert.deepEqual(opened,[]);assert.deepEqual([...state.physicalSelected],['barrier']);
    bridge.selectionChanged({selected:['barrier']});await bridge.selection(['barrier'],null,false);assert.deepEqual(opened,[true,true]);
    bridge.selectionChanged({selected:[]});assert.deepEqual(opened,[true,true,false]);
  });
  await check('Physical workspace switching preserves unfinished forms instead of losing pending edits',async()=>{
    const h=harness();attachMinimalDom(h);h.audit.accept(response(blank()));let destroyed=false;h.audit.state.physicalUI={hasUnfinishedChanges:()=>true,destroy(){destroyed=true;}};
    await assert.rejects(h.audit.selectWorkspace('physical','service_plans'),/unfinished physical/);assert.equal(h.audit.state.physicalScope,'defect_reports');assert.equal(destroyed,false);
  });
  await check('Defect Count arms a source placement without opening a form or creating a physical record',()=>{
    const h=countHarness(),state=h.audit.state;state.mode='physical';state.tool='select';state.physicalUI={hasUnfinishedChanges:()=>false,create(){assert.fail('Count must wait for the drawing click');}};
    h.dom.ui.scaleControls=h.dom.element();h.dom.ui.scaleToggle=h.dom.element();h.audit.setCountTool(tool=>{state.tool=tool;});const before=copy(state.session.snapshot);
    h.audit.activateCountTool();assert.equal(state.tool,'count');assert.equal(state.physicalPlacementTarget.kind,'defect');assert.equal(state.physicalPlacementTarget.documentId,'doc');assert.deepEqual(copy(state.session.snapshot),before);assert.match(h.dom.ui.progress.textContent,/Click the drawing.*defect/);
  });
  await check('Defect source-location annotations retain the exact clicked point and clip to the PDF crop without measurements',()=>{
    const h=countHarness(),state=h.audit.state;state.viewport.transform=[0,2,2,0,0,0];const source={document_id:'doc',document_sha256:'a'.repeat(64),page:1,point:[0,200]};
    const evidence=copy(h.audit.defectLocationEvidence(source));assert.deepEqual(evidence.region,[[0,197.5],[2.5,197.5],[2.5,200],[0,200]]);assert.equal(evidence.document_sha256,source.document_sha256);assert.match(evidence.note,/\[0,200\]/);assert.match(evidence.note,/does not represent physical size or quantity/);assert.equal(evidence.measurement,undefined);assert.equal(evidence.point,undefined);
    assert.throws(()=>h.audit.defectLocationEvidence({...source,point:[-1,200]}),/inside/);state.viewport.transform=[0,0,0,0,0,0];assert.throws(()=>h.audit.defectLocationEvidence(source),/transform/);
  });
  await check('Defect drawing placement uses one source annotation, displays a pending marker, and cancels without a mutation',async()=>{
    const h=countHarness(),state=h.audit.state;h.dom.ui.status=h.dom.element();state.session.snapshot.documents[0].sha256='a'.repeat(64);Object.assign(state,{mode:'physical',points:[]});
    const before=copy(state.session.snapshot);let calls=0;state.physicalUI={hasUnfinishedChanges:()=>false,selectedBarrier:()=>null,async create(kind,parent,marker,evidence){calls++;assert.equal(kind,'defect');assert.equal(parent,undefined);assert.equal(marker,undefined);assert.deepEqual(copy(state.physicalPlacementTarget.pendingPoint),[12.3456789,23.9876543]);assert.equal(state.physicalPlacing,true);assert.match(evidence.note,/12.3456789,23.9876543/);return undefined;}};
    state.physicalPlacementTarget={kind:'defect',sessionId:'session',documentId:'doc',page:1,controller:state.physicalUI};await h.audit.placePhysicalMarker([12.3456789,23.9876543]);assert.equal(calls,1);assert.equal(state.physicalPlacing,false);assert.equal(state.physicalPlacementTarget.pendingPoint,undefined);assert.equal(state.tool,'count');assert.deepEqual(copy(state.session.snapshot),before);
    state.physicalPlacementTarget.page=2;await assert.rejects(h.audit.placePhysicalMarker([12,23]),/previous drawing/);assert.equal(calls,1);assert.deepEqual(copy(state.session.snapshot),before);
  });
  await check('Placed Defect creation carries an exact session, revision, controller, scope and original-source guard',async()=>{
    for(const replace of [state=>{state.session.session_id='replacement';},state=>{state.session.revision++;},state=>{state.physicalUI=null;},state=>{state.physicalScope='service_plans';},state=>{state.document='other';},state=>{state.page=2;},state=>{state.session.snapshot.documents[0].sha256='b'.repeat(64);},state=>{state.mode='steel';}]){
      const h=countHarness(),state=h.audit.state;h.dom.ui.status=h.dom.element();state.session.snapshot.documents[0].sha256='a'.repeat(64);state.mode='physical';let checked=0;
      state.physicalUI={hasUnfinishedChanges:()=>false,selectedBarrier:()=>null,async create(kind,parent,marker,evidence,requirePlacement){assert.equal(kind,'defect');requirePlacement();replace(state);assert.throws(requirePlacement,/drawing or physical draft changed/);checked++;return undefined;}};
      state.physicalPlacementTarget={kind:'defect',sessionId:'session',documentId:'doc',page:1,controller:state.physicalUI};await h.audit.placePhysicalMarker([50,60]);assert.equal(checked,1);assert.equal(state.physicalPlacing,false);assert.equal(state.physicalPlacementTarget.pendingPoint,undefined);
    }
  });
  await check('Explicit marker placement requires Penetrations and rechecks its scope after asynchronous selection',async()=>{
    const h=harness(), state=h.audit.state, pending=deferred();h.audit.accept(response({...blank(),physical:{barriers:[{id:'barrier',deleted:false}]}}));
    Object.assign(state,{mode:'steel',viewport:{width:200},tool:'select'});let armed=0;h.audit.setCountTool(()=>armed++);
    state.physicalUI={hasUnfinishedChanges:()=>false,select:()=>pending.promise};
    await assert.rejects(h.audit.armPhysicalMarker('barrier'),/Penetrations/);assert.equal(armed,0);
    state.mode='physical';const work=h.audit.armPhysicalMarker('barrier');await flush();state.physicalScope='service_plans';pending.resolve();await work;
    assert.equal(armed,0);assert.equal(state.physicalPlacementTarget,undefined);
  });
  await check('Callouts wrap by measured width and preserve every generated summary line',()=>{
    const h=harness(), summary=['Barrier B-0001 '+ 'Z'.repeat(110),...Array.from({length:20},(_,i)=>`S-${i} electrical cable 1 x 100 mm`)].join('\n');
    h.context.document.createElement=()=>({getContext:()=>({font:'',measureText:value=>({width:value.length*5})})}); const lines=copy(h.audit.physicalCalloutLines(summary,120,9)); assert.ok(lines.every(line=>line.length<=24)); assert.ok(lines.join(' ').includes('S-19')); const wider=copy(h.audit.physicalCalloutLines(summary,240,9)); assert.ok(wider.length<lines.length); assert.match(summary,/S-19/);
  });
  await check('Physical source focus waits for successful navigation and rejects replacement scope or source',async()=>{
    const h=harness(), doc={id:'doc',sha256:'a'.repeat(64),pages:[{}]}, ref={document_id:'doc',document_sha256:doc.sha256,page:1,point:[12.5,23.75]};
    h.audit.accept(response({...blank(),documents:[doc]}));Object.assign(h.audit.state,{document:'doc',page:1,viewport:{transform:[1,0,0,1,0,0]},ui:{viewport:{clientWidth:400,clientHeight:300}}});
    let focused=0;h.audit.setPositionPage(()=>focused++);h.audit.setOverlayRenderer(()=>{});
    h.audit.state.busy=true;await assert.rejects(h.audit.physicalSource(ref),/finish loading/);h.audit.state.busy=false;
    h.audit.setNavigateDocument(async()=>false);await h.audit.physicalSource(ref);assert.equal(focused,0);
    h.audit.setNavigateDocument(async()=>{h.audit.state.physicalScope='service_plans';return true;});await h.audit.physicalSource(ref);assert.equal(focused,0);
    h.audit.setNavigateDocument(async()=>{h.audit.state.session.snapshot.documents[0].sha256='b'.repeat(64);return true;});await h.audit.physicalSource(ref);assert.equal(focused,0);
    h.audit.state.session.snapshot.documents[0].sha256=doc.sha256;h.audit.setNavigateDocument(async()=>true);await h.audit.physicalSource(ref);assert.equal(focused,1);
  });
  await check('Scope mounting defers marker rendering until the new controller exists',()=>{
    const h=harness();h.audit.accept(response({...blank(),physical:{barriers:[{id:'barrier',marker:{document_id:'doc',page:1,point:[2,3]}}]}}));Object.assign(h.audit.state,{document:'doc',page:1,physicalUI:null});
    assert.doesNotThrow(()=>h.audit.renderPhysicalOverlay(null));
  });
  await check('Standalone bulk fields include count dimensions and ratings while mixed selections expose only common fields',async()=>{
    const h=countHarness(),count={...countItem('count','unused',0,[[10,20]]),purpose:'count-only',geometry:{kind:'count-only',document_id:'doc',page:1,points:[[10,20]]},measurement:null},standard={id:'standard',mode:'steel',quantity:2,fields:{mark:'B1',section:'100UC15'}};
    delete count.count_id;h.audit.state.session.snapshot.items=[count,standard];h.audit.state.tool='select';h.audit.state.selected=new Set(['count']);
    const dom=h.dom;dom.ui.bulkField=dom.element('select');dom.ui.bulkValue={value:'125.123456789 x 250.987654321'};h.audit.syncBulkFields();
    assert.deepEqual(dom.ui.bulkField.children.map(option=>option.value),['mark','level','duct_size','frl','orientation']);assert.equal(dom.ui.bulkField.children[0].textContent,'Item');
    const sent=[],before=copy(h.audit.state.session.snapshot);h.audit.setAsk(async()=>({}));h.audit.setCommand(async(op,body)=>sent.push({op,...copy(body)}));
    dom.ui.bulkField.value='duct_size';await h.audit.bulkEdit();assert.deepEqual(sent[0],{op:'bulk_update',item_ids:['count'],changes:{fields:{width_mm:125.123456789,height_mm:250.987654321}}});
    dom.ui.bulkField.value='section';await assert.rejects(h.audit.bulkEdit(),/supported by every selected item/);dom.ui.bulkField.value='quantity';await assert.rejects(h.audit.bulkEdit(),/derived|come from markers/);assert.equal(sent.length,1);
    h.audit.state.selected.add('standard');h.audit.syncBulkFields();assert.deepEqual(dom.ui.bulkField.children.map(option=>option.value),['mark','level']);
    dom.ui.bulkField.value='frl';await assert.rejects(h.audit.bulkEdit(),/supported by every selected item/);dom.ui.bulkField.value='level';dom.ui.bulkValue.value='L2';await h.audit.bulkEdit();assert.deepEqual(new Set(sent[1].item_ids),new Set(['count','standard']));assert.deepEqual(sent[1].changes,{fields:{level:'L2'}});assert.deepEqual(copy(h.audit.state.session.snapshot),before);
  });
  await check('Length measurements repair missing calibration with the existing identity and only current source-page scales',async()=>{
    const h=harness(),value=blank(),item={id:'length',version:1,state:'draft',mode:'wall',purpose:'length-only',quantity:1,fields:{mark:'Edge'},member_ids:['member'],geometry:{document_id:'source',page:2,points:[[10.123456789,20],[110.987654321,20]]},measurement:null,evidence:[]};
    value.items=[item];value.calibrations=[{id:'old',document_id:'source',page:2,name:'Old'},{id:'current',supersedes_id:'old',document_id:'source',page:2,name:'Current'},{id:'other',document_id:'source',page:1,name:'Other page'}];h.audit.accept(response(value));h.audit.state.mode='wall';h.audit.state.selected.add(item.id);h.audit.state.document='displayed';h.audit.state.page=1;
    const dom=attachSettings(h);h.audit.state.settingsOpen=true;h.audit.renderSettingsPanel();const controls=dom.all(dom.ui.settingsPanel),repair=controls.find(control=>control.tagName==='BUTTON'&&control.textContent==='Attach length calibration');assert.ok(repair);assert.ok(!controls.some(control=>['Change length basis','Re-trace geometry','Add excluded opening','Riser/Drop'].includes(control.textContent)));
    let sent,asks=0;h.audit.setAsk(async(title,definitions)=>{asks++;assert.equal(title,'Change length calibration');assert.deepEqual(copy(definitions.map(def=>def[0])),['calibration_id']);assert.deepEqual(copy(definitions[0][2]),[['current','Current']]);assert.equal(definitions[0][4],true);return{calibration_id:'current'};});h.audit.setCommand(async(op,body,guard)=>{assert.equal(guard(),true);sent={op,...copy(body)};});
    const before=copy(h.audit.state.session.snapshot);await h.audit.changeLength(item);assert.equal(asks,1);assert.deepEqual(sent,{op:'update_item',item_id:'length',changes:{measurement:{method:'calibrated',calibration_id:'current'}}});assert.deepEqual(copy(h.audit.state.session.snapshot),before);
    for(const reason of ['project','item','scale']){const stale=harness();stale.audit.accept(response(value));stale.audit.setCommand(async()=>assert.fail('A stale repair must not send a command'));stale.audit.setAsk(async()=>{if(reason==='project')stale.audit.state.session.session_id='replacement';if(reason==='item')stale.audit.state.session.snapshot.items[0].version++;if(reason==='scale')stale.audit.state.session.snapshot.calibrations.find(scale=>scale.id==='current').deleted=true;return{calibration_id:'current'};});await assert.rejects(stale.audit.changeLength(item),/changed|current calibration/);}
  });
  await check('Count-only markers with null measurements are drawable without admitting unrelated or incomplete length markups',()=>{
    const h=countHarness(),count={...countItem('count','unused',0,[[10,20]]),purpose:'count-only',geometry:{kind:'count-only',document_id:'doc',page:1,points:[[10,20]]},measurement:null};delete count.count_id;
    const other={...copy(count),id:'other',geometry:{...count.geometry,page:2}},incomplete={id:'length',mode:'steel',fields:{mark:'No basis'},geometry:{document_id:'doc',page:1,points:[[20,20],[30,30]]},measurement:null};h.audit.state.session.snapshot.items=[count,other,incomplete];h.audit.state.tool='select';h.audit.state.selected.add(count.id);
    assert.deepEqual(copy(h.audit.drawableItems()).map(item=>item.id),['count']);const overlay=h.dom.element();assert.doesNotThrow(()=>h.audit.renderCountMarkers(overlay,count,count.geometry));const hit=overlay.children.find(control=>control.attributes.role==='button');assert.equal(hit.attributes['aria-label'],'Count marker 1 · unused');h.audit.state.hidden.add(count.id);assert.equal(h.audit.drawableItems().length,0);
  });
  await check('A stale setup completion cannot enable a dialog while a newer choices request still reports loading',async()=>{
    const h=harness();h.audit.accept(response(blank()));const dom=attachMinimalDom(h),create=h.context.document.createElement;h.context.document.body=dom.element('body');
    h.context.document.createElement=tag=>{const control=create(tag);if(tag==='dialog'){control.showModal=()=>{control.open=true;};control.close=value=>{control.returnValue=value;control.open=false;control.events.close();};control.remove=()=>{control.parentNode.children.splice(control.parentNode.children.indexOf(control),1);};}return control;};
    const initial=deferred();let ready;const pending=h.audit.askDialog('Choices',[],'','Apply',(_,report)=>{ready=report;ready(false);return initial.promise;});await flush();const dialog=h.context.document.body.children[0],apply=dom.all(dialog).find(control=>control.tagName==='BUTTON'&&control.textContent==='Apply');assert.equal(dialog.open,true);assert.equal(apply.disabled,true);
    ready(true);assert.equal(apply.disabled,false);ready(false);initial.resolve();await flush();assert.equal(apply.disabled,true,'Finishing the older setup must not override the newer loading state');ready(true);assert.equal(apply.disabled,false);dialog.close('cancel');assert.equal(await pending,null);assert.equal(h.audit.state.modal,false);assert.equal(h.context.document.body.children.length,0);
  });
  await check('Standalone and mixed selections reject every calculator transfer before capturing a calculator draft',async()=>{
    for(const [mode,purpose] of [['steel','count-only'],['duct','count-only'],['wall','length-only'],['slab','length-only']]){
      const h=harness(),value=blank();value.items=[{id:'only',mode,purpose,fields:{mark:'Only'}},{id:'regular',mode,fields:{mark:'Regular'}}];h.audit.accept(response(value));h.audit.state.mode=mode;h.audit.state.selected=new Set(['only','regular']);let captures=0,requests=0;h.context.window.CeasefireCalculators={captureTakeoffTarget(){captures++;throw new Error('Must not capture');}};h.audit.setApi(async()=>{requests++;throw new Error('Must not request');});
      await assert.rejects(h.audit.transfer(false),/cannot transfer to any calculator/);await assert.rejects(h.audit.transfer(true),/cannot transfer to any calculator/);assert.equal(captures,0);assert.equal(requests,0);assert.deepEqual(copy(h.audit.state.session.snapshot),value);
    }
  });
  console.log(`${passed} takeoff UI and geometry checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
