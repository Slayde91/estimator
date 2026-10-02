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
const snapshot = value => ({version:1,project_id:uuid(98),revision:1,documents:[{id:uuid(80),sha256:'d'.repeat(64),name:'Inspection.pdf',pages:[{page:1},{page:2}]}],physical:value,image_extractions:[{id:uuid(90),document_id:uuid(80),pages:[1]}]});
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
    setAttribute(key,value){this.attributes[key]=String(value);}
    addEventListener(name,listener){(this.events[name]||=[]).push(listener);}
    emit(name){for(const listener of this.events[name]||[])listener({target:this});}
    querySelectorAll(selector){const matches=element=>selector.split(',').some(part=>part.startsWith('[data-')?Object.hasOwn(element.dataset,part.slice(6,-1).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())):element.tagName===part.toUpperCase());return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);}
  }
  doc={createElement:tag=>new Element(tag)};
  return {container:new Element('div'),all(root){return root.children.flatMap(child=>[child,...this.all(child)]);}};
}
function component(initial=graph(),extra={}){
  const dom=documentHarness(),calls={previews:[],applied:[],notifications:[],asks:[],confirmations:[],sources:[],exports:[],changed:0},answers=[],current=snapshot(initial);let controller,preview;
  const bridge={
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
    async apply(id){calls.applied.push(id);if(!current.physical)current.physical={...graph(),barriers:[],defects:[],services:[]};const collections={barrier:'barriers',defect:'defects',service:'services'};
      for(const command of preview){current.physical.revision++;if(command.op==='create')current.physical[collections[command.kind]].push({...copy(command.entity),revision:1,deleted:false,deleted_at_revision:null});else if(command.op==='update'){const entry=physical.indexGraph(current.physical).get(command.entity_id);Object.assign(entry.entity,copy(command.changes));entry.entity.revision++;}}
      current.revision++;controller.render(copy(current));return {snapshot:copy(current)};
    },
    notify(text,error){calls.notifications.push({text,error});},source(ref){calls.sources.push(ref);},images:async()=>[],imageUrl:()=>'/api/takeoffs/local/images/asset',extract:async()=>({snapshot:copy(current)}),export:async format=>calls.exports.push(format),undo:async()=>({snapshot:copy(current)}),changed(){calls.changed++;},...extra,
  };
  controller=physical.mount(dom.container,bridge);controller.render(copy(current));
  const all=()=>dom.all(dom.container),button=label=>{const control=all().find(element=>element.tagName==='BUTTON'&&(element.textContent===label||element.attributes['aria-label']===label));assert.ok(control,`Missing button: ${label}`);return control;};
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
    assert.deepEqual(physical.fieldsFromValues('barrier',{label:' B1 ',thickness_mm:'',notes:''}),{label:'B1'});
    for(const invalid of ['',null,undefined,0,-1,1.5,Infinity,'NaN'])assert.throws(()=>physical.fieldValue('service','quantity',invalid),/explicit positive/);
    assert.equal(physical.fieldValue('service','quantity','2'),2);assert.equal(physical.fieldValue('service','insulation_mm','0'),0);assert.throws(()=>physical.fieldValue('service','width_mm','0'),/positive/);assert.throws(()=>physical.fieldValue('barrier','frl','120'),/belonging/);
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
    for(const label of ['Add defect','Bulk edit same-type records','Undo physical / takeoff edit','Extract images from selected PDF page'])assert.equal(h.button(label).disabled,true,label);
    await h.select(3);const inspector=h.all().find(element=>element.tagName==='ASIDE');assert.equal(inspector.querySelectorAll('input,select,textarea').length,0);assert.ok(inspector.textContent.includes('Opening type: Corehole'));assert.ok(inspector.textContent.includes('Legacy opening evidence'));
    for(const label of ['Preview physical edits','Delete draft record','Change physical parent','Remove source association'])assert.ok(!h.all().some(element=>element.tagName==='BUTTON'&&element.textContent===label));
    // Even a programmatically delivered event on a disabled mutation button cannot reach the bridge.
    await h.click('Add defect');assert.equal(h.calls.previews.length,0);assert.equal(h.calls.applied.length,0);assert.ok(h.calls.notifications.at(-1).text.includes('read-only'));
    h.answers.push({});await h.click('Export draft CSV');assert.deepEqual(h.calls.exports,['csv']);assert.deepEqual(h.current.physical,original);h.controller.destroy();
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
  console.log(`${passed} physical draft UI checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
