// Physical hierarchy and real component event tests. A separate browser journey
// proves rendered PDF/image interaction; these checks do not claim visual QA.
const assert = require('node:assert/strict');
const physical = require('../static/takeoff-physical.js');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const copy = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise=new Promise(done=>resolve=done); return {promise,resolve}; };
const flush = async () => { for(let i=0;i<80;i++)await Promise.resolve(); };
const make = (id,fields={},more={}) => ({id:uuid(id),revision:1,deleted:false,deleted_at_revision:null,fields,evidence:[],uncertainty:{state:'not_assessed',note:''},...more});
const legacyGraph = () => ({version:1,id:uuid(99),project_id:uuid(98),revision:1,state:'draft',barriers:[make(1,{label:'Wall A',substrate:'Concrete'})],defects:[make(2,{label:'Defect 01',frl:'-/120/120'},{barrier_id:uuid(1)})],openings:[make(3,{label:'Core A',opening_type:'Corehole'},{defect_id:uuid(2)}),make(4,{label:'Empty core'},{defect_id:uuid(2)})],services:[make(5,{label:'Pipe',service:'Copper pipe',size:'25 mm'},{opening_id:uuid(3),quantity:1}),make(6,{label:'Cable',service:'Cable bundle'},{opening_id:uuid(3),quantity:3})]});
const graph = () => ({version:2,id:uuid(99),project_id:uuid(98),revision:1,state:'draft',defects:[make(2,{label:'Defect 01',frl:'-/120/120'},{display_id:'D-0001'})],barriers:[make(1,{label:'Wall A',substrate:'Concrete'},{display_id:'B-0001',defect_id:uuid(2)}),make(4,{label:'Empty barrier'},{display_id:'B-0002',defect_id:uuid(2)})],services:[make(5,{label:'Pipe',service:'Copper pipe',size:'25 mm'},{display_id:'S-0001',barrier_id:uuid(1),quantity:1}),make(6,{label:'Cable',service:'Cable bundle'},{display_id:'S-0002',barrier_id:uuid(1),quantity:3})]});
const servicePlanGraph = () => { const value=graph();value.version=3;value.id=uuid(97);delete value.defects;for(const barrier of value.barriers){delete barrier.defect_id;barrier.fields.frl='-/90/90';}return value; };
const snapshot = value => ({version:1,project_id:uuid(98),revision:1,documents:[{id:uuid(80),sha256:'d'.repeat(64),name:'Inspection.pdf',pages:[{page:1},{page:2}]}],physical:value,image_extractions:[{id:uuid(90),document_id:uuid(80),pages:[1]}]});
const fieldChoices = {substrate:['Concrete','Masonry','Custom library substrate'],orientation:['Horizontal','Vertical'],service:['Mechanical','Electrical & Communications'],service_type:['Copper pipe','Cable bundle','Custom library service'],frl:['N/A','-/60/60','-/90/90','-/120/120','-/180/180','-/240/240']};
const optionsOf = control => control.children.filter(child=>child.tagName==='OPTION').map(child=>child.value).filter(value=>value!=='');
const definitionOptions = definition => definition[2].map(option=>Array.isArray(option)?option[0]:option);
function documentHarness(){
  let doc;
  class Element {
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.events={};this.className='';this._text='';this.value='';this.ownerDocument=doc;this.disabled=false;this.checked=false;
      this.classList={toggle:(value,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));on?set.add(value):set.delete(value);this.className=[...set].join(' ');},contains:value=>this.className.split(/\s+/).includes(value)};
    }
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this._text=String(value);this.children=[];}
    append(...values){for(const value of values){value.parentElement=this;this.children.push(value);}}
    replaceChildren(...values){this.children=[];this._text='';this.append(...values);}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
    setAttribute(key,value){this.attributes[key]=String(value);}
    addEventListener(name,listener){(this.events[name]||=[]).push(listener);}
    emit(name){for(const listener of this.events[name]||[])listener({target:this});}
    querySelectorAll(selector){const matches=element=>selector.split(',').some(part=>part.startsWith('[data-')?Object.hasOwn(element.dataset,part.slice(6,-1).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())):element.tagName===part.toUpperCase());return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);}
  }
  doc={createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag)};
  return {container:new Element('div'),all(root){return root.children.flatMap(child=>[child,...this.all(child)]);}};
}
function component(initial=graph(),extra={}){
  const dom=documentHarness(),calls={previews:[],applied:[],notifications:[],asks:[],confirmations:[],sources:[],exports:[],changed:0},answers=[],current=snapshot(initial);let controller,preview;
  if(extra.inspectorContainer===true){extra={...extra,inspectorContainer:dom.container.ownerDocument.createElement('div')};dom.inspectorHost=extra.inspectorContainer;dom.closeButton=dom.container.ownerDocument.createElement('button');dom.closeButton.textContent='Close Item Details';dom.inspectorHost.append(dom.closeButton);}
  const bridge={
    fieldOptions:async()=>copy(fieldChoices),
    async ask(title,definitions,text,button){calls.asks.push({title,definitions,text,button});return answers.shift()??null;},
    async confirm(title,text,button){calls.confirmations.push({title,text,button});return true;},
    async preview(commands){
      calls.previews.push(copy(commands)); preview=copy(commands);
      const prefixes={defect:'D',barrier:'B',service:'S'}, counters={};
      for(const command of preview)if(command.op==='create'){
        const prefix=prefixes[command.kind]; counters[prefix]??=Math.max(0,...[...physical.indexGraph(current.physical).values()].filter(entry=>entry.kind===command.kind).map(entry=>Number(entry.entity.display_id.slice(2))));
        command.entity.display_id=`${prefix}-${String(++counters[prefix]).padStart(4,'0')}`;
      }
      return {preview_id:'opaque-preview',affected_ids:commands.map(command=>command.entity_id||command.entity.id),changed_ids:commands.map(command=>command.entity_id||command.entity.id),relationships:preview.map(command=>({id:command.entity_id||command.entity.id,kind:command.kind||physical.indexGraph(current.physical).get(command.entity_id).kind,display_id:command.entity?.display_id||physical.indexGraph(current.physical).get(command.entity_id).entity.display_id,parent_before:null,parent_after:command.parent_id||command.entity?.defect_id||command.entity?.barrier_id||null,deleted_before:command.op==='create'?null:false,deleted_after:command.op==='delete'}))};
    },
    async apply(id){calls.applied.push(id);if(!current.physical)current.physical=extra.scope?.()==='service_plans'?{...servicePlanGraph(),barriers:[],services:[]}:{...graph(),barriers:[],defects:[],services:[]};const collections={barrier:'barriers',defect:'defects',service:'services'};
      for(const command of preview){current.physical.revision++;if(command.op==='create')current.physical[collections[command.kind]].push({...copy(command.entity),revision:1,deleted:false,deleted_at_revision:null});else if(command.op==='update'){const entry=physical.indexGraph(current.physical).get(command.entity_id);Object.assign(entry.entity,copy(command.changes));entry.entity.revision++;}}
      current.revision++;controller.render(copy(current));return {snapshot:copy(current)};
    },
    notify(text,error){calls.notifications.push({text,error});},source(ref){calls.sources.push(ref);},images:async()=>[],imageUrl:()=>'/api/takeoffs/local/images/asset',extract:async()=>({snapshot:copy(current)}),export:async format=>calls.exports.push(format),undo:async()=>({snapshot:copy(current)}),changed(){calls.changed++;},...extra,
  };
  controller=physical.mount(dom.container,bridge);controller.render(copy(current));
  const all=()=>[...dom.all(dom.container),...(dom.inspectorHost?dom.all(dom.inspectorHost):[])],button=label=>{const control=all().find(element=>element.tagName==='BUTTON'&&(element.textContent===label||element.attributes['aria-label']===label));assert.ok(control,`Missing button: ${label}`);return control;};
  return {dom,controller,calls,answers,current,bridge,all,button,async click(label){button(label).emit('click');await flush();},async select(id){const row=all().find(element=>element.dataset.physicalId===uuid(id));assert.ok(row);row.children[0].children[0].emit('change');await flush();},input(label){const control=all().find(element=>element.attributes['aria-label']===label);assert.ok(control,`Missing field: ${label}`);return control;}};
}
let passed=0;
async function check(label,test){await test();passed++;console.log(`ok - ${label}`);}
(async()=>{
  await check('Mixed services share a barrier while empty barriers remain explicit and quantity-free',()=>{
    const value=graph(),original=copy(value),rows=physical.hierarchyRows(value);
    assert.equal(rows.filter(row=>row.kind==='barrier').length,2);assert.equal(rows.filter(row=>row.kind==='service').length,2);
    assert.ok(!rows.some(row=>row.kind==='service'&&row.entity.barrier_id===uuid(4)));assert.deepEqual(value,original);
    assert.deepEqual(rows.filter(row=>row.kind==='service').map(row=>row.entity.quantity).sort(),[1,3]);
  });
  await check('Search retains ancestor context and ignores collapsed ancestors without inventing duplicate children',()=>{
    const rows=physical.hierarchyRows(graph(),{filter:'Cable bundle',collapsed:new Set([uuid(1),uuid(2),uuid(3)])});
    assert.deepEqual(rows.map(row=>row.entity.id),[uuid(2),uuid(1),uuid(6)]);assert.deepEqual(rows.map(row=>row.context),[true,true,false]);
    assert.equal(new Set(rows.map(row=>row.entity.id)).size,rows.length);
  });
  await check('Final hierarchy pagination repeats only necessary parent context around stable entity identities',()=>{
    const value=graph();value.services=Array.from({length:250},(_,i)=>make(100+i,{label:`Service ${i}`},{barrier_id:uuid(1),display_id:`S-${String(i+1).padStart(4,'0')}`,quantity:i+1}));
    const rows=physical.hierarchyRows(value),index=physical.indexGraph(value),page=physical.hierarchyPage(rows,index,100);
    assert.equal(page.length,102);assert.deepEqual(page.slice(0,2).map(row=>row.entity.id),[uuid(2),uuid(1)]);assert.ok(page.slice(0,2).every(row=>row.context&&row.continued));assert.equal(new Set(page.map(row=>row.entity.id)).size,page.length);
    assert.deepEqual(page.slice(2).map(row=>row.entity.id),rows.slice(100,200).map(row=>row.entity.id));
  });
  await check('Deleted hierarchy is hidden by default and retained with exact parent identities for restoration',()=>{
    const value=graph();value.barriers[1].deleted=true;value.barriers[1].deleted_at_revision=1;
    assert.ok(!physical.hierarchyRows(value).some(row=>row.entity.id===uuid(4)));assert.ok(physical.hierarchyRows(value,{showDeleted:true}).some(row=>row.entity.id===uuid(4)&&row.entity.defect_id===uuid(2)));
  });
  await check('Unknown fields stay absent and service quantity never receives a fallback',()=>{
    assert.deepEqual(physical.fieldsFromValues('barrier',{location:' L02 ',notes:''}),{location:'L02'});
    for(const invalid of ['',null,undefined,0,-1,1.5,Infinity,'NaN'])assert.throws(()=>physical.fieldValue('service','quantity',invalid),/explicit positive/);
    assert.equal(physical.fieldValue('service','quantity','2'),2);assert.equal(physical.fieldValue('service','insulation_mm','0'),0);assert.throws(()=>physical.fieldValue('service','width_height_mm','0x10'),/positive/);assert.throws(()=>physical.fieldValue('barrier','frl','120'),/belonging/);
  });
  await check('Combined service dimensions are strict, atomic and preserve untouched partial legacy dimensions',()=>{
    for(const [text,width_mm,height_mm] of [['100x200',100,200],[' .5 X 20.25 ',.5,20.25],['30 × 40',30,40]])assert.deepEqual(physical.parseDimensions(text),{width_mm,height_mm});
    for(const text of ['100','100x','x100','1x2x3','0x2','-1x2','NaNx2','Infinityx2','1000000000001x2'])assert.throws(()=>physical.parseDimensions(text),/Width x Height/);
    assert.deepEqual(physical.parseDimensions(''),{});
    const entry={kind:'service',entity:make(5,{label:'Hidden label',service:'Mechanical',width_mm:100,future_property:'Keep',diameter_mm:25},{quantity:2})},before=copy(entry);
    assert.equal(physical.formatDimensions(entry.entity.fields),'100 x ');
    const retained=physical.fieldsFromValues('service',{service:'Mechanical',width_height_mm:'100 x ',diameter_mm:'25',notes:'New note'},entry.entity.fields);
    assert.deepEqual(retained,{...entry.entity.fields,notes:'New note'});
    assert.throws(()=>physical.changedFields(entry,'width_height_mm','200x'),/Width x Height/);assert.deepEqual(entry,before);
    assert.deepEqual(physical.changedFields(entry,'width_height_mm','200x300').fields,{...entry.entity.fields,width_mm:200,height_mm:300});
    const cleared=physical.changedFields(entry,'width_height_mm','').fields;assert.equal(cleared.width_mm,undefined);assert.equal(cleared.height_mm,undefined);assert.equal(cleared.diameter_mm,25);
    const image={id:uuid(70),occurrence_id:uuid(71),sha256:'a'.repeat(64),document_id:uuid(80),document_sha256:'d'.repeat(64),page:1};
    assert.deepEqual(physical.imageEvidence(image,'Dimensions shown','width_height_mm').fields,['width_mm','height_mm']);
  });
  await check('Defect FRL is a shared native choice in create, inspector, table and bulk; legacy strings stay exact',async()=>{
    const value=graph();value.defects[0].fields.frl=' Historic FRL ';const h=component(value);await flush();
    await h.click('Add defect');const definitions=h.calls.asks.at(-1).definitions;assert.equal(definitions.find(([key])=>key==='label')[1],'Defect Ref.');assert.deepEqual(definitionOptions(definitions.find(([key])=>key==='frl')),fieldChoices.frl);
    await h.select(2);assert.equal(h.input('FRL').tagName,'SELECT');assert.equal(h.input('FRL for Defect 01').tagName,'SELECT');assert.equal(h.input('FRL').value,' Historic FRL ');assert.deepEqual(optionsOf(h.input('FRL')),[...fieldChoices.frl,' Historic FRL ']);
    h.input('Notes').value='Retain prior choice';h.input('Notes').emit('input');await h.click('Preview physical edits');assert.equal(h.current.physical.defects[0].fields.frl,' Historic FRL ');
    h.answers.push({field:'frl'},{value:'-/90/90'});await h.click('Bulk edit same-type records');assert.deepEqual(definitionOptions(h.calls.asks.at(-1).definitions[0]),[...fieldChoices.frl,' Historic FRL ']);assert.equal(h.current.physical.defects[0].fields.frl,'-/90/90');h.controller.destroy();
  });
  await check('Service creation and inspector expose one combined dimension field and Overall Diameter',async()=>{
    const h=component();await flush();h.answers.push({service:'Mechanical',service_type:'Copper pipe',width_height_mm:'120x80.5',diameter_mm:'25',quantity:2,uncertainty_state:'not_assessed'});await h.click('Add service to B-0001');
    const fields=h.calls.asks[0].definitions;assert.equal(fields.find(([key])=>key==='width_height_mm')[1],'Width x Height (mm)');assert.equal(fields.find(([key])=>key==='diameter_mm')[1],'Overall Diameter (mm)');assert.ok(!fields.some(([key])=>['width_mm','height_mm'].includes(key)));
    const created=h.calls.previews[0][0].entity;assert.equal(created.fields.width_mm,120);assert.equal(created.fields.height_mm,80.5);assert.equal(created.fields.width_height_mm,undefined);assert.equal(created.fields.diameter_mm,25);
    assert.equal(h.input('Width x Height (mm)').value,'120 x 80.5');assert.equal(h.input('Overall Diameter (mm)').value,25);h.controller.destroy();
  });
  await check('Register actions use compact accessible icons and Add defect follows the table before pagination',async()=>{
    const h=component(graph(),{history:async()=>{throw new Error('Removed history must not run');}});await flush();
    for(const label of ['Undo physical / takeoff edit','Physical / takeoff audit history'])assert.ok(!h.all().some(node=>node.tagName==='BUTTON'&&node.textContent===label));
    const table=h.all().find(node=>node.className==='takeoff-register-table'),siblings=table.parentElement.children,index=siblings.indexOf(table);assert.equal(siblings[index+1].className,'takeoff-physical-add-row');assert.equal(siblings[index+1].children[0],h.button('Add defect'));assert.ok(h.button('Add defect').className.includes('takeoff-physical-add-child'));assert.equal(h.button('Add defect').textContent,'+');assert.equal(h.button('Add defect').attributes['aria-label'],'Add defect');assert.equal(h.button('Add defect').title,'Add defect');assert.equal(siblings[index+2].className,'takeoff-register-controls');
    const disclosure=h.button('Collapse D-0001');assert.equal(disclosure.textContent,'<');assert.equal(disclosure.attributes['aria-expanded'],'true');await h.click('Collapse D-0001');assert.equal(h.button('Expand D-0001').textContent,'>');assert.equal(h.button('Expand D-0001').attributes['aria-expanded'],'false');
    for(const label of ['Discard unfinished physical edits','Delete selected records','Select filtered records','Clear physical selection','Bulk edit same-type records']){const button=h.button(label);assert.equal(button.textContent,'');assert.equal(button.children[0].tagName,'SVG');assert.equal(button.children[0].attributes['aria-hidden'],'true');assert.equal(button.attributes['aria-label'],label);}
    assert.deepEqual(siblings[index+1].children,[h.button('Add defect'),h.button('Delete selected records'),h.button('Discard unfinished physical edits')]);
    for(const format of ['CSV','XLSX']){const download=h.button(`Export draft ${format}`);assert.ok(download.className.includes('takeoff-download-button'));assert.equal(download.textContent,`⇩${format}`);}
    h.controller.destroy();
  });
  await check('Select-all spans collapsed pages, excludes deleted and ancestor-context rows, and preserves other selections',async()=>{
    const value=graph();value.services=Array.from({length:205},(_,index)=>make(100+index,{service:index<2?'Needle':'Other'},{display_id:`S-${String(index+1).padStart(4,'0')}`,barrier_id:uuid(1),quantity:1}));value.services[204].deleted=true;value.services[204].deleted_at_revision=1;
    let selected=[];const h=component(value,{viewChanged:(_visible,ids)=>selected=ids,confirm:async()=>false});await flush();await h.click('Collapse D-0001');let header=h.input('Select all matching physical records');header.checked=true;header.emit('change');await flush();assert.equal(selected.length,207);assert.ok(!selected.includes(uuid(304)));assert.equal(h.input('Select all matching physical records').checked,true);
    await h.click('Delete selected records');assert.deepEqual(h.calls.previews[0],[{op:'delete',entity_id:uuid(2),cascade:true}]);assert.equal(h.calls.applied.length,0);
    const filter=h.input('Filter physical hierarchy');filter.value='Needle';filter.emit('input');await flush();header=h.input('Select all matching physical records');assert.equal(header.checked,true);header.checked=false;header.emit('change');await flush();assert.equal(selected.length,205);assert.ok(selected.includes(uuid(2)));assert.ok(!selected.includes(uuid(100)));assert.ok(!selected.includes(uuid(101)));
    await h.click('Clear physical selection');header=h.input('Select all matching physical records');header.checked=true;header.emit('change');await flush();assert.deepEqual(selected,[uuid(100),uuid(101)]);await h.select(100);assert.equal(h.input('Select all matching physical records').indeterminate,true);h.controller.destroy();
  });
  await check('Bulk deletion deduplicates fully selected subtrees and requires explicit consent for additional descendants',async()=>{
    const value=graph(),index=physical.indexGraph(value),all=[...index.values()],plan=physical.deletionPlan(all,index);
    assert.deepEqual(plan.commands,[{op:'delete',entity_id:uuid(2),cascade:true}]);assert.deepEqual(plan.additional,[]);
    const parent=[index.get(uuid(1)),index.get(uuid(5))];assert.deepEqual(physical.deletionPlan(parent,index).additional.map(entry=>entry.entity.id),[uuid(6)]);assert.deepEqual(physical.deletionPlan(parent,index).commands,[]);assert.deepEqual(physical.deletionPlan(parent,index,true).commands,[{op:'delete',entity_id:uuid(1),cascade:true}]);
    const h=component(value);await flush();await h.select(1);h.answers.push({scope:'only'});await h.click('Delete selected records');assert.equal(h.calls.previews.length,0);assert.ok(h.calls.notifications.at(-1).text.includes('No records have been deleted'));
    h.answers.push({scope:'cascade'});await h.click('Delete selected records');assert.deepEqual(h.calls.previews[0],[{op:'delete',entity_id:uuid(1),cascade:true}]);assert.ok(h.calls.asks.at(-1).text.includes('2 unselected active descendants'));assert.equal(h.calls.confirmations.at(-1).title,'Review recoverable deletion');h.controller.destroy();
    const cancel=component(value,{confirm:async()=>false});await flush();await cancel.select(5);await cancel.select(6);await cancel.click('Delete selected records');assert.deepEqual(cancel.calls.previews[0],[{op:'delete',entity_id:uuid(5),cascade:false},{op:'delete',entity_id:uuid(6),cascade:false}]);assert.equal(cancel.calls.applied.length,0);assert.deepEqual(cancel.current.physical,value);cancel.controller.destroy();
  });
  await check('Bulk deletion enforces the backend command limit without partially deleting independent selections',()=>{
    const value=graph();value.services=Array.from({length:101},(_,n)=>make(100+n,{}, {display_id:`S-${n+1}`,barrier_id:uuid(1),quantity:1}));const index=physical.indexGraph(value),leaves=value.services.map(entity=>index.get(entity.id));
    assert.throws(()=>physical.deletionPlan(leaves,index),/at most 100 independent/);assert.equal(physical.deletionPlan(leaves.slice(0,100),index).commands.length,100);
    const complete=[index.get(uuid(1)),...leaves];assert.deepEqual(physical.deletionPlan(complete,index).commands,[{op:'delete',entity_id:uuid(1),cascade:true}]);assert.deepEqual(physical.deletionPlan(complete.slice(0,-1),index).additional.map(entry=>entry.entity.id),[uuid(200)]);assert.deepEqual(physical.deletionPlan(complete.slice(0,-1),index).commands,[]);
  });
  await check('Save completion applies pending inspector values through existing reviewed commands',async()=>{
    const h=component();await flush();await h.select(5);const size=h.input('Width x Height (mm)'),notes=h.input('Notes');size.value='100x';size.emit('input');notes.value='Keep pending note';notes.emit('input');
    await assert.rejects(h.controller.completePendingEdits(),/Width x Height/);assert.equal(h.calls.previews.length,0);assert.equal(size.value,'100x');assert.equal(notes.value,'Keep pending note');assert.equal(h.controller.hasUnfinishedChanges(),true);
    size.value='100x200';size.emit('input');await h.controller.completePendingEdits();assert.equal(h.calls.previews.length,1);assert.equal(h.calls.applied.length,1);assert.equal(h.calls.confirmations[0].title,'Review physical field changes');assert.equal(h.current.physical.services[0].fields.width_mm,100);assert.equal(h.current.physical.services[0].fields.height_mm,200);assert.equal(h.current.physical.services[0].fields.notes,'Keep pending note');assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();
  });
  await check('Cancelled or failed save reviews preserve pending inspector and table values',async()=>{
    for(const mode of ['inspector','table']){
      const h=component(graph(),{confirm:async()=>false});await flush();if(mode==='inspector')await h.select(1);const control=h.input(mode==='inspector'?'Notes':'Location for Wall A');control.value='Unsaved value';control.emit('input');
      await assert.rejects(h.controller.completePendingEdits(),/review was cancelled/);assert.equal(control.value,'Unsaved value');assert.equal(h.controller.hasUnfinishedChanges(),true);assert.equal(h.calls.applied.length,0);h.bridge.confirm=async()=>true;await h.controller.completePendingEdits();assert.equal(h.calls.applied.length,1);assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();
    }
    const h=component(graph(),{preview:async()=>{throw new Error('Preview unavailable');}});await flush();await h.select(1);const notes=h.input('Notes');notes.value='Keep on outage';notes.emit('input');await assert.rejects(h.controller.completePendingEdits(),/Preview unavailable/);assert.equal(notes.value,'Keep on outage');assert.equal(h.controller.hasUnfinishedChanges(),true);h.controller.destroy();
  });
  await check('Save completion rejects stale or unrelated physical pending controls before applying',async()=>{
    const h=component();await flush();await h.select(1);const notes=h.input('Notes');notes.value='Retain stale note';notes.emit('input');const next=copy(h.current);next.physical.revision++;next.physical.barriers[0].revision++;h.controller.render(next);await assert.rejects(h.controller.completePendingEdits(),/draft changed/);assert.equal(h.calls.applied.length,0);assert.equal(notes.value,'Retain stale note');h.controller.destroy();
    const separate=component();await flush();await separate.select(1);for(const label of ['Notes','Location for Wall A']){const control=separate.input(label);control.value='Unfinished';control.emit('input');}await assert.rejects(separate.controller.completePendingEdits(),/separate physical field edits/);assert.equal(separate.calls.previews.length,0);assert.equal(separate.controller.hasUnfinishedChanges(),true);separate.controller.destroy();
  });
  await check('A replacement project with the same entity IDs cannot receive a save started in the old inspector',async()=>{
    const h=component();await flush();await h.select(1);const notes=h.input('Notes');notes.value='Old project edit';notes.emit('input');
    const saving=h.controller.completePendingEdits(),replacement=copy(h.current);replacement.project_id=uuid(500);replacement.physical.project_id=uuid(500);replacement.physical.id=uuid(501);h.controller.render(replacement);
    await assert.rejects(saving,/draft changed/);assert.equal(h.calls.previews.length,0);assert.equal(h.calls.applied.length,0);assert.ok(!h.dom.container.textContent.includes('Old project edit'));h.controller.destroy();
  });
  await check('Barrier and service forms share catalogue dropdowns in creation, inspector and register',async()=>{
    const value=graph();Object.assign(value.barriers[0].fields,{barrier_type:'Core hole',orientation:'Vertical'});Object.assign(value.services[0].fields,{service:'Mechanical',service_type:'Copper pipe'});
    const h=component(value);await flush();
    await h.click('Add barrier to D-0001');const barrier=h.calls.asks.at(-1).definitions;
    assert.ok(!barrier.some(([key])=>['label','thickness_mm'].includes(key)));
    assert.deepEqual(definitionOptions(barrier.find(([key])=>key==='barrier_type')),['Empty Opening','Core hole','Oversized']);
    for(const key of ['substrate','orientation'])assert.deepEqual(definitionOptions(barrier.find(([name])=>name===key)),fieldChoices[key]);
    await h.click('Add service to B-0001');const service=h.calls.asks.at(-1).definitions;
    assert.ok(!service.some(([key])=>key==='label'));assert.equal(service.find(([key])=>key==='service')[1],'Category');assert.equal(service.find(([key])=>key==='size')[1],'Service Size (mm)');
    assert.equal(service.findIndex(([key])=>key==='quantity'),service.findIndex(([key])=>key==='service_type')+1);
    for(const key of ['service','service_type'])assert.deepEqual(definitionOptions(service.find(([name])=>name===key)),fieldChoices[key]);
    await h.select(1);
    for(const [label,choices] of [['Barrier type',['Empty Opening','Core hole','Oversized']],['Substrate',fieldChoices.substrate],['Substrate orientation',fieldChoices.orientation]]){const control=h.input(label);assert.equal(control.tagName,'SELECT');assert.deepEqual(optionsOf(control),choices);}
    for(const label of ['Barrier label','Thickness (mm)'])assert.ok(!h.all().some(control=>control.attributes['aria-label']===label));
    for(const [label,choices] of [['Substrate for Wall A',fieldChoices.substrate],['Substrate orientation for Wall A',fieldChoices.orientation]]){const control=h.input(label);assert.equal(control.tagName,'SELECT');assert.deepEqual(optionsOf(control),choices);}
    await h.click('Clear physical selection');await h.select(5);
    for(const [label,choices] of [['Category',fieldChoices.service],['Service type',fieldChoices.service_type],['Category for Pipe',fieldChoices.service],['Service type for Pipe',fieldChoices.service_type]]){const control=h.input(label);assert.equal(control.tagName,'SELECT');assert.deepEqual(optionsOf(control),choices);}
    const inspector=h.all().find(control=>control.tagName==='ASIDE'),controls=h.dom.all(inspector).filter(control=>['INPUT','SELECT','TEXTAREA'].includes(control.tagName));
    assert.equal(controls.findIndex(control=>control.name==='quantity'),controls.findIndex(control=>control.name==='service_type')+1);assert.equal(h.input('Service Size (mm)').value,'25 mm');assert.ok(!h.all().some(control=>control.attributes['aria-label']==='Service label'));
    h.controller.destroy();
  });
  await check('Hidden labels and barrier thickness survive visible-field edits and old dropdown values remain explicit',async()=>{
    const value=graph();Object.assign(value.barriers[0].fields,{thickness_mm:175,substrate:' Historic substrate ',orientation:'Historic orientation',barrier_type:'Historic barrier',future_property:'retained barrier data'});Object.assign(value.services[0].fields,{service:'Historic category',service_type:'Historic type',future_property:'retained service data'});
    const barrierBefore=copy(value.barriers[0].fields),serviceBefore=copy(value.services[0].fields);
    const h=component(value);await flush();await h.select(1);
    for(const [label,retained] of [['Barrier type','Historic barrier'],['Substrate',' Historic substrate '],['Substrate orientation','Historic orientation']]){const control=h.input(label);assert.equal(control.value,retained);assert.ok(optionsOf(control).includes(retained));assert.ok(control.children.some(option=>option.value===retained&&option.textContent.includes('retained')));}
    const location=h.input('Location');location.value='New location';location.emit('input');await h.click('Preview physical edits');
    assert.deepEqual(h.current.physical.barriers[0].fields,{...barrierBefore,location:'New location'});assert.equal(h.current.physical.barriers[0].defect_id,uuid(2));
    await h.click('Clear physical selection');await h.select(5);for(const [label,retained] of [['Category','Historic category'],['Service type','Historic type']]){const control=h.input(label);assert.equal(control.value,retained);assert.ok(optionsOf(control).includes(retained));}
    const size=h.input('Service Size (mm)');size.value='32';size.emit('input');await h.click('Preview physical edits');
    assert.deepEqual(h.current.physical.services[0].fields,{...serviceBefore,size:'32'});assert.equal(h.current.physical.services[0].quantity,1);assert.equal(h.current.physical.services[0].barrier_id,uuid(1));
    const retained=physical.fieldsFromValues('barrier',{location:'',notes:''},barrierBefore);assert.equal(retained.label,'Wall A');assert.equal(retained.thickness_mm,175);assert.equal(retained.future_property,'retained barrier data');assert.equal(retained.location,undefined);
    h.controller.destroy();
  });
  await check('Delayed catalogue choices preserve unfinished text and a failed load can retry before creation',async()=>{
    const held=defer(),h=component(graph(),{fieldOptions:()=>held.promise});await flush();await h.select(1);
    const notes=h.input('Notes'),substrate=h.input('Substrate');assert.equal(substrate.disabled,true);notes.value='Keep this unfinished inspection note';notes.emit('input');
    held.resolve(copy(fieldChoices));await flush();assert.equal(h.input('Notes'),notes);assert.equal(notes.value,'Keep this unfinished inspection note');assert.equal(h.controller.hasUnfinishedChanges(),true);assert.equal(substrate.disabled,false);assert.deepEqual(optionsOf(substrate),fieldChoices.substrate);assert.equal(h.calls.previews.length,0);h.controller.destroy();
    let attempts=0;const retry=component(graph(),{fieldOptions:async()=>{if(++attempts===1)throw new Error('Temporary catalogue outage');return copy(fieldChoices);}});await flush();assert.ok(retry.calls.notifications.some(notice=>notice.error&&notice.text.includes('Temporary catalogue outage')));
    await retry.click('Add barrier to D-0001');assert.equal(attempts,2);assert.deepEqual(definitionOptions(retry.calls.asks.at(-1).definitions.find(([key])=>key==='substrate')),fieldChoices.substrate);assert.equal(retry.calls.previews.length,0);retry.controller.destroy();
  });
  await check('Bulk service changes use the same typed catalogue values and preserve hidden labels and relationships',async()=>{
    const h=component(),before=copy(h.current.physical.services);await flush();await h.select(5);await h.select(6);h.answers.push({field:'service_type'},{value:'Custom library service'});await h.click('Bulk edit same-type records');
    assert.equal(h.calls.asks[0].title,'Choose field for 2 draft records');assert.ok(!definitionOptions(h.calls.asks[0].definitions[0]).includes('label'));
    assert.equal(h.calls.asks[1].title,'Edit 2 draft service records');assert.equal(h.calls.asks[1].definitions[0][1],'Service type');assert.deepEqual(definitionOptions(h.calls.asks[1].definitions[0]),fieldChoices.service_type);
    for(const [index,service] of h.current.physical.services.entries()){assert.deepEqual(service.fields,{...before[index].fields,service_type:'Custom library service'});assert.equal(service.barrier_id,before[index].barrier_id);assert.equal(service.quantity,before[index].quantity);}h.controller.destroy();
  });
  await check('Bulk field replacement preserves unrelated facts and every parent while counting unchanged entries explicitly',()=>{
    const index=physical.indexGraph(graph()),entries=[index.get(uuid(5)),index.get(uuid(6))],original=copy(entries),batch=physical.bulkCommands(entries,'size','25 mm');
    assert.equal(batch.commands.length,1);assert.deepEqual(batch.unchanged,[uuid(5)]);assert.equal(batch.commands[0].entity_id,uuid(6));assert.equal(batch.commands[0].changes.fields.service,'Cable bundle');assert.equal(batch.commands[0].changes.fields.size,'25 mm');assert.equal(batch.commands[0].changes.opening_id,undefined);assert.deepEqual(entries,original);
    assert.throws(()=>physical.bulkCommands([index.get(uuid(1)),index.get(uuid(5))],'label','Same'),/one entity type/);assert.throws(()=>physical.bulkCommands(Array(101).fill(entries[0]),'label','Same'),/at most 100/);
    const clear=physical.bulkCommands(entries,'size','');assert.equal(clear.commands[0].changes.fields.size,undefined);assert.equal(clear.commands[0].changes.fields.service,'Copper pipe');
  });
  await check('Image associations bind exact bytes, source and occurrence without changing object identity or count',()=>{
    const image={id:uuid(70),occurrence_id:uuid(71),sha256:'a'.repeat(64),document_id:uuid(80),document_sha256:'d'.repeat(64),page:2,region:[[1,2],[3,2],[3,4],[1,4]],name:'Source image'},original=copy(image);
    const association=physical.imageEvidence(image,'Copper shown here','service');assert.equal(association.image_id,image.id);assert.equal(association.image_sha256,image.sha256);assert.equal(association.occurrence_id,image.occurrence_id);assert.deepEqual(association.fields,['service']);assert.deepEqual(image,original);assert.equal(association.quantity,undefined);assert.equal(association.id,undefined);
    association.region[0][0]=999;assert.deepEqual(image,original);assert.equal(physical.imageEvidence({...image,issues:['Appearance unverified']}).image_sha256,image.sha256);assert.throws(()=>physical.imageEvidence({...image,association_available:false}),/verified source rendition/);assert.throws(()=>physical.imageEvidence({...image,document_sha256:'x'}),/exact source/);
  });
  await check('Preview displays exact ID/relationship counts, change values and explicit unapproved draft authority',()=>{
    const index=physical.indexGraph(graph()),preview={preview_id:'opaque',affected_ids:[uuid(3),uuid(5),uuid(6)],changed_ids:[uuid(3)],relationships:[{id:uuid(1),kind:'barrier',display_id:'B-0001',parent_before:uuid(2),parent_after:uuid(20),deleted_before:false,deleted_after:false}]};
    const text=physical.previewText(preview,index);for(const value of ['3 affected','1 changed','D-0001',uuid(20),'unapproved draft','Undo restores'])assert.ok(text.includes(value),value);
    const change=physical.commandText([{op:'update',entity_id:uuid(5),changes:{quantity:4,fields:{label:'Pipe',service:'Copper pipe'}}}],index);assert.ok(change.includes('quantity: 1 → 4'));assert.ok(change.includes('25 mm → unknown'));assert.throws(()=>physical.previewText({...preview,preview_id:null},index),/complete/);
  });
  await check('Mounted register leads with three serial ID columns, contextual creation and no Opening fields',async()=>{
    const h=component();await flush();const text=h.dom.container.textContent;
    for(const phrase of ['Defect ID','Barrier ID','Service ID','0 services','UNAPPROVED DRAFT','Image count is not physical quantity'])assert.ok(text.includes(phrase),phrase);
    assert.deepEqual(h.all().filter(element=>element.tagName==='TH').slice(0,4).map(element=>element.textContent),['Select','Defect ID','Barrier ID','Service ID']);
    assert.ok(!text.includes('Opening'));assert.ok(!h.all().some(element=>element.tagName==='BUTTON'&&['Add barrier','Add service','Add opening'].includes(element.textContent)));
    assert.equal(h.button('Add barrier to D-0001').textContent,'+');assert.equal(h.button('Add service to B-0001').textContent,'+');
    assert.ok(!text.includes(uuid(1)));assert.ok(text.includes('B-0001'));
    assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();assert.equal(h.dom.container.children.length,0);
  });
  await check('Manual create retains explicit parent IDs; invalid service quantity cannot reach preview or apply',async()=>{
    const h=component();await flush();await h.select(4);h.answers.push({label:'Unknown service',quantity:'',uncertainty_state:'missing',uncertainty_note:'Quantity not evidenced'});await h.click('Add service to B-0002');assert.equal(h.calls.previews.length,0);assert.ok(h.calls.notifications.at(-1).text.includes('explicit positive'));
    h.answers.push({label:'Pipe 2',service:'Copper',quantity:2,uncertainty_state:'human_review_required',uncertainty_note:''});await h.click('Add service to B-0002');
    const command=h.calls.previews[0][0];assert.equal(command.op,'create');assert.equal(command.kind,'service');assert.equal(command.entity.barrier_id,uuid(4));assert.equal(command.entity.quantity,2);assert.deepEqual(command.entity.evidence,[]);assert.equal(command.entity.confirmation,undefined);assert.equal(h.calls.applied[0],'opaque-preview');assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();
  });
  await check('New projects create root defects and display the server-assigned ID in the preview and row',async()=>{
    const h=component(null);await flush();h.answers.push({label:'First defect',uncertainty_state:'not_assessed'});await h.click('Add defect');
    const command=h.calls.previews[0][0];assert.equal(command.kind,'defect');assert.equal(command.entity.defect_id,undefined);assert.equal(command.entity.barrier_id,undefined);assert.equal(command.entity.display_id,undefined);
    assert.equal(h.current.physical.version,2);assert.equal(h.current.physical.defects[0].display_id,'D-0001');assert.ok(h.calls.confirmations[0].text.includes('D-0001'));assert.ok(!h.calls.confirmations[0].text.includes(command.entity.id));
    assert.equal(h.button('D-0001').className,'takeoff-row-link');assert.equal(h.calls.asks.length,1);h.controller.destroy();
  });
  await check('Row child buttons bind the clicked defect and barrier even when another row is selected',async()=>{
    const h=component();await flush();await h.select(6);h.answers.push({label:'Second wall',uncertainty_state:'not_assessed'});await h.click('Add barrier to D-0001');
    const barrier=h.calls.previews[0][0];assert.equal(barrier.kind,'barrier');assert.equal(barrier.entity.defect_id,uuid(2));assert.equal(barrier.entity.display_id,undefined);assert.equal(h.current.physical.barriers.at(-1).display_id,'B-0003');
    await h.click('Clear physical selection');await h.select(4);h.answers.push({label:'Another pipe',quantity:1,uncertainty_state:'not_assessed'});await h.click('Add service to B-0001');
    const service=h.calls.previews[1][0];assert.equal(service.entity.barrier_id,uuid(1));assert.equal(h.current.physical.services.at(-1).display_id,'S-0003');assert.equal(h.calls.asks.length,2);assert.ok(h.calls.asks[1].text.includes('Parent ID: B-0001'));h.controller.destroy();
  });
  await check('Serial IDs survive label changes and reparented snapshots and remain searchable',async()=>{
    const value=graph();value.defects.push(make(20,{label:'Defect B'},{display_id:'D-0002'}));const originalIds=value.barriers.map(entity=>entity.display_id),h=component(value);await flush();
    const next=copy(h.current);next.physical.revision++;next.physical.barriers[0].fields.label='Renamed wall';next.physical.barriers[0].defect_id=uuid(20);h.controller.render(next);await flush();
    assert.deepEqual(next.physical.barriers.map(entity=>entity.display_id),originalIds);assert.equal(h.button('B-0001').textContent,'B-0001');
    const filter=h.input('Filter physical hierarchy');filter.value='S-0002';filter.emit('input');await flush();
    assert.deepEqual(h.all().filter(element=>element.dataset.physicalId).map(element=>element.dataset.physicalId),[uuid(20),uuid(1),uuid(6)]);assert.ok(h.dom.container.textContent.includes('D-0002'));assert.ok(h.dom.container.textContent.includes('B-0001'));h.controller.destroy();
  });
  await check('Legacy hierarchy preserves original topology and evidence as read-only while exports remain available',async()=>{
    const value=legacyGraph();value.openings[0].evidence=[{document_id:uuid(80),document_sha256:'d'.repeat(64),page:1,note:'Legacy opening evidence'}];const original=copy(value),h=component(value);await flush();
    assert.deepEqual(physical.hierarchyRows(value).filter(row=>!row.context).map(row=>row.kind),['barrier','defect','opening','service','service','opening']);
    assert.ok(h.dom.container.textContent.includes('Legacy hierarchy — read-only'));assert.ok(h.dom.container.textContent.includes('Opening ID'));
    for(const label of ['Add defect','Bulk edit same-type records','Delete selected records','Extract images from selected PDF page'])assert.equal(h.button(label).disabled,true,label);
    for(const label of ['Undo physical / takeoff edit','Physical / takeoff audit history'])assert.ok(!h.all().some(element=>element.tagName==='BUTTON'&&element.textContent===label));
    await h.select(3);const inspector=h.all().find(element=>element.tagName==='ASIDE');assert.equal(inspector.querySelectorAll('input,select,textarea').length,0);assert.ok(inspector.textContent.includes('Opening type: Corehole'));assert.ok(inspector.textContent.includes('Legacy opening evidence'));
    for(const label of ['Preview physical edits','Delete draft record','Change physical parent','Remove source association'])assert.ok(!h.all().some(element=>element.tagName==='BUTTON'&&element.textContent===label));
    // Even a programmatically delivered event on a disabled mutation button cannot reach the bridge.
    await h.click('Add defect');assert.equal(h.calls.previews.length,0);assert.equal(h.calls.applied.length,0);assert.ok(h.calls.notifications.at(-1).text.includes('read-only'));
    h.answers.push({});await h.click('Export draft CSV');assert.deepEqual(h.calls.exports,['csv']);assert.deepEqual(h.current.physical,original);h.controller.destroy();
  });
  await check('Inherited locations follow the nearest location-bearing parent in each saved hierarchy version',async()=>{
    for(const value of [legacyGraph(),graph()]){
      value.barriers[0].fields.location='Barrier location';value.defects[0].fields.location='Defect location';
      const original=copy(value),h=component(value);await flush();
      const locationOf=id=>{const column=h.all().filter(element=>element.tagName==='TH').findIndex(element=>element.textContent==='Location');return h.all().find(element=>element.dataset.physicalId===uuid(id)).children[column].textContent;};
      const ids=value.version===1?[3,5]:[5],nearest=value.version===1?'Defect location':'Barrier location';
      for(const id of ids)assert.equal(locationOf(id),nearest);
      assert.deepEqual(h.current.physical,original);
      const next=copy(h.current);delete next.physical[value.version===1?'defects':'barriers'][0].fields.location;h.controller.render(next);await flush();
      for(const id of ids)assert.equal(locationOf(id),value.version===1?'Barrier location':'Defect location');
      h.controller.destroy();
    }
  });
  await check('Inline editing previews authoritative commands and restores an untouched value when review is cancelled',async()=>{
    const h=component(graph(),{confirm:async()=>false});await flush();const control=h.input('Substrate for Wall A');control.value='Masonry';control.emit('input');assert.equal(h.controller.hasUnfinishedChanges(),true);control.emit('change');await flush();
    assert.equal(h.calls.previews.length,1);assert.equal(h.calls.previews[0][0].changes.fields.substrate,'Masonry');assert.equal(h.calls.applied.length,0);assert.equal(h.input('Substrate for Wall A').value,'Concrete');assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();
  });
  await check('Draft changes during preview cannot apply a stale review receipt',async()=>{
    const pending=defer(),h=component(graph(),{preview:()=>pending.promise});await flush();const control=h.input('Substrate for Wall A');control.value='Masonry';control.emit('input');control.emit('change');await flush();
    const next=copy(h.current);next.physical.revision++;h.controller.render(next);pending.resolve({preview_id:'stale',affected_ids:[uuid(1)],changed_ids:[uuid(1)],relationships:[]});await flush();assert.equal(h.calls.applied.length,0);assert.ok(h.calls.notifications.some(value=>value.text.includes('changed before review')));h.controller.destroy();
  });
  await check('Inline table edits cannot discard unrelated unfinished inspector values',async()=>{
    const h=component();await flush();await h.select(1);const inspector=h.input('Substrate');inspector.value='Unfinished masonry inspection';inspector.emit('input');const table=h.input('Location for Wall A');table.value='New location';table.emit('input');table.emit('change');await flush();
    assert.equal(h.calls.previews.length,0);assert.equal(inspector.value,'Unfinished masonry inspection');assert.equal(table.value,'');assert.equal(h.controller.hasUnfinishedChanges(),true);assert.ok(h.calls.notifications.at(-1).text.includes('Those edits have been preserved'));await h.click('Discard unfinished physical edits');assert.equal(h.controller.hasUnfinishedChanges(),false);h.controller.destroy();
  });
  await check('Each later unfinished keystroke advances the project race fingerprint',async()=>{
    const h=component();await flush();await h.select(1);const notes=h.input('Notes'),before=h.controller.editRevision();notes.value='First unfinished note';notes.emit('input');const first=h.controller.editRevision();notes.value='Later unfinished note';notes.emit('input');assert.ok(first>before);assert.ok(h.controller.editRevision()>first);assert.equal(h.controller.hasUnfinishedChanges(),true);h.controller.destroy();
  });
  await check('Overlay selection can preserve its clicked source instead of navigating to the first evidence',async()=>{
    const calls=[],value=graph();value.services[0].evidence=[{document_id:uuid(80),document_sha256:'d'.repeat(64),page:2}];const h=component(value,{selection:(ids,reference,focus)=>calls.push({ids,reference,focus})});await flush();await h.controller.select(uuid(5),false,false);assert.equal(calls.at(-1).focus,false);await h.controller.select(uuid(5));assert.equal(calls.at(-1).focus,true);assert.equal(calls.at(-1).reference.page,2);h.controller.destroy();
  });
  await check('Reparent and cascade delete use explicit server-preview commands without local topology inference',async()=>{
    const value=graph();value.defects.push(make(20,{label:'Defect B'},{display_id:'D-0002'}));const h=component(value);await flush();await h.select(1);
    h.answers.push({search:'D-0002'},{parent_id:uuid(20)});await h.click('Change physical parent');assert.deepEqual(h.calls.previews[0],[{op:'reparent',entity_id:uuid(1),parent_id:uuid(20)}]);
    h.answers.push({scope:'cascade'});await h.click('Delete draft record');assert.deepEqual(h.calls.previews[1],[{op:'delete',entity_id:uuid(1),cascade:true}]);assert.ok(h.calls.asks.at(-1).text.includes('2 active descendants'));h.controller.destroy();
  });
  await check('Deleted records expose retained fields and evidence and selected restoration sends only the explicit IDs',async()=>{
    const value=graph();value.barriers[0].fields.notes='Retain original inspection';value.barriers[0].evidence=[{document_id:uuid(80),document_sha256:'d'.repeat(64),page:1,note:'Original source'}];
    for(const collection of ['barriers','defects','services'])for(const entity of value[collection]){entity.deleted=true;entity.deleted_at_revision=1;}
    const h=component(value);await flush();const showLabel=h.all().find(element=>element.tagName==='LABEL'&&element.textContent==='Show deleted records');showLabel.children[0].checked=true;showLabel.children[0].emit('change');await flush();await h.select(1);
    assert.ok(h.dom.container.textContent.includes('Retain original inspection'));assert.ok(h.dom.container.textContent.includes('Original source'));assert.ok(!h.all().some(element=>element.tagName==='BUTTON'&&element.textContent==='Remove source association'));
    h.answers.push({mode:'selected',entity_ids:`${uuid(1)}\n${uuid(2)}`});await h.click('Restore draft record');assert.deepEqual(h.calls.previews[0],[{op:'restore',entity_id:uuid(1),mode:'selected',entity_ids:[uuid(1),uuid(2)]}]);h.controller.destroy();
  });
  await check('Unchanged inspector values avoid a no-op command and image inventory cannot leak across replacement projects',async()=>{
    const first=defer(),second=defer();let count=0;const h=component(graph(),{images:()=>++count===1?first.promise:second.promise});await h.select(1);await h.click('Preview physical edits');assert.equal(h.calls.previews.length,0);
    const next=copy(h.current);next.project_id=uuid(500);h.controller.render(next);first.resolve([{name:'Old project image'}]);second.resolve([]);await flush();assert.ok(!h.dom.container.textContent.includes('Old project image'));assert.ok(h.dom.container.textContent.includes('0 selected'));h.controller.destroy();
  });
  await check('Closing a component while evidence inventory is pending prevents late rendering',async()=>{
    const pending=defer(),h=component(graph(),{images:()=>pending.promise});h.controller.destroy();pending.resolve([{name:'Late evidence'}]);await flush();assert.equal(h.dom.container.children.length,0);assert.equal(h.controller.hasUnfinishedChanges(),false);
  });
  await check('Closing a component during a modal review prevents application and clears unfinished state',async()=>{
    const pending=defer(),h=component(graph(),{confirm:()=>pending.promise});await flush();const control=h.input('Substrate for Wall A');control.value='Masonry';control.emit('input');control.emit('change');await flush();assert.equal(h.controller.hasUnfinishedChanges(),true);h.controller.destroy();pending.resolve(true);await flush();assert.equal(h.calls.applied.length,0);assert.equal(h.controller.hasUnfinishedChanges(),false);assert.equal(h.dom.container.children.length,0);
  });
  await check('Actual image gallery rejects arbitrary remote URLs before creating an image element',async()=>{
    const prior=global.location;global.location={href:'http://127.0.0.1:8765/',origin:'http://127.0.0.1:8765'};
    try{const image={id:uuid(70),occurrence_id:uuid(71),sha256:'a'.repeat(64),document_id:uuid(80),document_sha256:'d'.repeat(64),page:1,name:'Photo'},h=component(graph(),{images:async()=>[image],imageUrl:()=> 'https://example.invalid/photo.png'});await flush();const card=h.all().find(node=>node.tagName==='DETAILS');card.open=true;card.emit('toggle');assert.equal(h.all().filter(node=>node.tagName==='IMG').length,0);assert.ok(card.textContent.includes('same-origin evidence route'));h.controller.destroy();}finally{global.location=prior;}
  });
  await check('Draft exports require an explicit draft warning and preserve bridge authority separation',async()=>{
    const h=component();await flush();h.answers.push({});await h.click('Export draft CSV');assert.deepEqual(h.calls.exports,['csv']);assert.ok(h.calls.asks.at(-1).text.includes('does not represent approved quantities'));assert.equal(h.calls.previews.length,0);assert.equal(h.calls.applied.length,0);h.controller.destroy();
  });
  await check('Gallery scopes each fetch to one extraction and changes default with the selected source page',async()=>{
    const loaded=[];let sourcePage=1;const h=component(graph(),{images:async id=>{loaded.push(id);return [];},imageContext:()=>({document_id:uuid(80),page:sourcePage})});await flush();assert.deepEqual(loaded,[uuid(90)]);
    h.current.image_extractions.push({id:uuid(91),document_id:uuid(80),pages:[2]});h.controller.render(copy(h.current));await flush();assert.equal(loaded.at(-1),uuid(90));
    sourcePage=2;h.controller.render(copy(h.current));await flush();assert.equal(loaded.at(-1),uuid(91));const selector=h.input('Retained image extraction');selector.value=uuid(90);selector.emit('change');await flush();assert.equal(loaded.at(-1),uuid(90));h.controller.render(copy(h.current));await flush();assert.equal(h.input('Retained image extraction').value,uuid(90));
    h.current.image_extractions=[];h.controller.render(copy(h.current));await flush();assert.equal(loaded.length,4);assert.ok(h.dom.container.textContent.includes('No retained extraction'));h.controller.destroy();
  });
  await check('Gallery displays twelve records at a time and refuses oversized extraction inventories',async()=>{
    const images=Array.from({length:512},(_,index)=>({name:`Source ${index}`,occurrence_id:uuid(1000+index)})),h=component(graph(),{images:async()=>images});await flush();assert.equal(h.all().filter(node=>node.tagName==='DETAILS').length,12);await h.click('Next 12 image records');assert.ok(h.dom.container.textContent.includes('Source 12'));assert.ok(!h.dom.container.textContent.includes('Source 0 ·'));
    h.bridge.images=async()=>[...images,{name:'Excess'}];await h.click('Refresh retained images');assert.ok(h.calls.notifications.at(-1).text.includes('512-occurrence'));h.controller.destroy();
  });
  await check('Service Plans starts at Barrier with no defect columns, root parents or defect create flow',async()=>{
    const value=servicePlanGraph(),original=copy(value),rows=physical.hierarchyRows(value),index=physical.indexGraph(value);
    assert.deepEqual(rows.map(row=>[row.kind,row.depth]),[['barrier',0],['service',1],['service',1],['barrier',0]]);
    assert.deepEqual(physical.hierarchyRows(value,{filter:'Cable bundle',collapsed:new Set([uuid(1)])}).map(row=>row.entity.id),[uuid(1),uuid(6)]);
    assert.deepEqual(physical.deletionPlan([...index.values()],index).commands,[{op:'delete',entity_id:uuid(1),cascade:true},{op:'delete',entity_id:uuid(4),cascade:false}]);assert.deepEqual(value,original);
    const h=component(value,{scope:()=> 'service_plans'});await flush();assert.ok(!h.all().some(node=>node.tagName==='TH'&&node.textContent==='Defect ID'));assert.ok(h.dom.container.textContent.includes('SERVICE PLANS'));
    await h.click('Add substrate');assert.equal(h.calls.asks.at(-1).title,'Create draft barrier');assert.ok(!h.calls.asks.at(-1).definitions.some(([key])=>key==='defect_id'));assert.deepEqual(definitionOptions(h.calls.asks.at(-1).definitions.find(([key])=>key==='frl')),fieldChoices.frl);
    await h.controller.select(uuid(1));assert.ok(!h.all().some(node=>node.tagName==='BUTTON'&&node.textContent==='Change physical parent'));await assert.rejects(h.controller.create('defect'),/record type/);h.controller.destroy();
  });
  await check('Service Plan Barrier owns FRL through create, inspector, table and bulk with exact shared choices',async()=>{
    const h=component(null,{scope:()=> 'service_plans'});await flush();h.answers.push({location:'L03',frl:'-/120/120',substrate:'Concrete',uncertainty_state:'not_assessed'});const id=await h.controller.create('barrier');
    assert.equal(h.current.physical.version,3);assert.equal(h.current.physical.defects,undefined);const barrier=h.current.physical.barriers[0];assert.equal(barrier.id,id);assert.equal(barrier.defect_id,undefined);assert.equal(barrier.fields.frl,'-/120/120');assert.equal(h.input('FRL').tagName,'SELECT');assert.equal(h.input('FRL for B-0001').tagName,'SELECT');
    h.input('FRL').value='-/180/180';h.input('FRL').emit('input');await h.controller.completePendingEdits();assert.equal(barrier.fields.frl,'-/180/180');h.answers.push({field:'frl'},{value:'-/90/90'});await h.click('Bulk edit same-type records');assert.equal(barrier.fields.frl,'-/90/90');assert.deepEqual(definitionOptions(h.calls.asks.at(-1).definitions[0]),fieldChoices.frl);h.controller.destroy();
  });
  await check('External Item Details owns pending fields, survives option loading, and leaves the pane Close button intact',async()=>{
    const choices=defer(),h=component(servicePlanGraph(),{scope:()=> 'service_plans',inspectorContainer:true,fieldOptions:()=>choices.promise});await h.controller.select(uuid(1));
    assert.ok(!h.dom.all(h.dom.container).some(node=>node.attributes['aria-label']==='Item Details'));assert.equal(h.dom.inspectorHost.children[0],h.dom.closeButton);const notes=h.input('Notes');notes.value='Kept beside drawing';notes.emit('input');assert.equal(h.controller.hasUnfinishedChanges(),true);
    choices.resolve(copy(fieldChoices));await flush();assert.equal(notes.value,'Kept beside drawing');assert.deepEqual(optionsOf(h.input('FRL')),fieldChoices.frl);await h.controller.completePendingEdits();assert.equal(h.current.physical.barriers[0].fields.notes,'Kept beside drawing');assert.equal(h.controller.hasUnfinishedChanges(),false);
    const pending=defer(),preview=h.bridge.preview;h.bridge.preview=async commands=>{const result=await preview(commands);await pending.promise;return result;};const marking=h.controller.setMarker(uuid(1),{document_id:uuid(80),document_sha256:'d'.repeat(64),page:1,point:[10,20]});await flush();assert.equal(h.input('Notes').disabled,true);assert.equal(h.input('FRL').disabled,true);pending.resolve();await marking;assert.equal(h.input('Notes').disabled,false);
    h.controller.destroy();assert.deepEqual(h.dom.inspectorHost.children,[h.dom.closeButton]);
  });
  await check('Count creation and marker movement share reviewed atomic commands and never apply on cancellation',async()=>{
    const marker={document_id:uuid(80),document_sha256:'d'.repeat(64),page:2,point:[150,225]},selections=[],h=component(null,{scope:()=> 'service_plans',selection:(ids,reference,focus)=>selections.push({ids,reference,focus})});await flush();
    h.answers.push({substrate:'Concrete',frl:'-/120/120',uncertainty_state:'not_assessed'});const id=await h.controller.create('barrier',undefined,marker);assert.deepEqual(h.current.physical.barriers[0].marker,marker);assert.equal(h.calls.previews.length,1);assert.ok(h.calls.confirmations[0].text.includes('p2 · (150, 225)'));assert.equal(h.controller.selectedBarrier().id,id);assert.deepEqual(selections.at(-1),{ids:[id],reference:marker,focus:false});
    const moved={...marker,point:[300,350]};h.bridge.confirm=async()=>false;assert.equal(await h.controller.setMarker(id,moved),false);assert.deepEqual(h.current.physical.barriers[0].marker,marker);
    h.bridge.confirm=async()=>true;assert.equal(await h.controller.setMarker(id,moved),true);assert.deepEqual(h.current.physical.barriers[0].marker,moved);assert.equal(await h.controller.setMarker(id,moved),false);assert.equal(await h.controller.setMarker(id,null),true);assert.equal(h.current.physical.barriers[0].marker,null);
    const notes=h.input('Notes');notes.value='Pending';notes.emit('input');await assert.rejects(h.controller.setMarker(id,marker),/unfinished/);assert.equal(h.current.physical.barriers[0].marker,null);h.controller.destroy();
    const cancelled=component(null,{scope:()=> 'service_plans',confirm:async()=>false});await flush();cancelled.answers.push({substrate:'Concrete',uncertainty_state:'not_assessed'});assert.equal(await cancelled.controller.create('barrier',undefined,marker),undefined);assert.equal(cancelled.current.physical,null);assert.equal(cancelled.calls.applied.length,0);cancelled.controller.destroy();
  });
  await check('Callout summaries use the linked Barrier and active Services and refresh only from applied values',async()=>{
    const value=servicePlanGraph();Object.assign(value.barriers[0].fields,{location:'L02',orientation:'Vertical',thickness_mm:120});Object.assign(value.services[0].fields,{service:'Mechanical',service_type:'Copper pipe',width_mm:100,height_mm:80,diameter_mm:25,insulation_mm:0});value.services[1].deleted=true;
    const marker={document_id:uuid(80),document_sha256:'d'.repeat(64),page:2,point:[150,225]};value.barriers[0].marker=marker;
    const changes=[],selections=[],h=component(value,{scope:()=> 'service_plans',selectionChanged:change=>changes.push(change),selection:(ids,reference,focus)=>selections.push({ids,reference,focus})});await flush();await h.controller.select(uuid(5));assert.equal(h.controller.selectedBarrier().id,uuid(1));assert.deepEqual(h.controller.selection(),[uuid(5)]);assert.equal(changes.at(-1).barrierId,uuid(1));assert.equal(changes.length,1);assert.deepEqual(selections.at(-1),{ids:[uuid(5)],reference:marker,focus:true});
    const summary=h.controller.summary(uuid(5));assert.ok(summary.includes('B-0001 · Wall A · L02 · Concrete · Vertical · 120 mm thick · FRL -/90/90'));assert.ok(summary.includes('S-0001 · 1 × · Pipe · Mechanical · Copper pipe · 25 mm · 100 x 80 mm · Ø 25 mm · Insulation 0 mm'));assert.ok(!summary.includes('S-0002'));
    const type=h.input('Service type');type.value='Custom library service';type.emit('input');assert.equal(h.controller.summary(uuid(1)),summary);await h.controller.completePendingEdits();assert.ok(h.controller.summary(uuid(1)).includes('Custom library service'));assert.equal(changes.length,1);assert.equal(h.controller.summary(uuid(4)).split('\n').at(-1),'0 services');await assert.rejects(h.controller.setMarker(uuid(5),null),/active barrier/);h.controller.destroy();
    const defects=component(graph());await flush();assert.ok(defects.controller.summary(uuid(1)).includes('FRL -/120/120'));assert.ok(defects.controller.summary(uuid(1)).startsWith('B-0001 · D-0001 · Wall A'));defects.controller.destroy();
  });
  await check('Item Details creates children under its selected parent and retains unfinished fields before creation',async()=>{
    const h=component(servicePlanGraph(),{scope:()=> 'service_plans',inspectorContainer:true});await flush();await h.controller.select(uuid(1));assert.equal(h.button('Add service in Item Details').title,'Add service to B-0001');
    const notes=h.input('Notes');notes.value='Pending barrier details';notes.emit('input');await h.click('Add service in Item Details');assert.equal(h.calls.asks.length,0);assert.ok(h.calls.notifications.at(-1).text.includes('unfinished physical'));assert.equal(notes.value,'Pending barrier details');
    await h.controller.completePendingEdits();h.answers.push({service:'Mechanical',service_type:'Copper pipe',quantity:2,uncertainty_state:'not_assessed'});await h.click('Add service in Item Details');const command=h.calls.previews.at(-1)[0];assert.equal(command.kind,'service');assert.equal(command.entity.barrier_id,uuid(1));assert.equal(command.entity.quantity,2);assert.equal(h.current.physical.barriers[0].fields.notes,'Pending barrier details');h.controller.destroy();
    const defect=component();await flush();await defect.controller.select(uuid(2));assert.equal(defect.button('Add barrier in Item Details').title,'Add barrier to D-0001');defect.answers.push({substrate:'Concrete',uncertainty_state:'not_assessed'});await defect.click('Add barrier in Item Details');assert.equal(defect.calls.previews.at(-1)[0].entity.defect_id,uuid(2));defect.controller.destroy();
  });
  console.log(`${passed} physical draft UI checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
