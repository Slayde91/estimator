// Exercise the shared display-only controller without a calculator/server mock.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('static/calculators.js','utf8').replace(/\r\n/g,'\n').split('\n(() => {\n  const $')[0];
function harness(initial={},denied=false){
 const stored=new Map(Object.entries(initial)),events={},document={documentElement:{dir:'ltr'},activeElement:null};let writes=0;
 function element(tag){return {tagName:tag,children:[],dataset:{},style:{},attributes:{},listeners:{},hidden:false,
  append(...nodes){for(const node of nodes){if(node.parentElement){const siblings=node.parentElement.children;siblings.splice(siblings.indexOf(node),1);}node.parentElement=this;this.children.push(node);}},
  replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);},
  setAttribute(key,value){this.attributes[key]=value;},getAttribute(key){return this.attributes[key];},
  addEventListener(name,fn){this.listeners[name]=fn;},emit(name,event={}){this.listeners[name]?.(event);},focus(){document.activeElement=this;},
  contains(target){return this===target||this.children.some(child=>child.contains(target));},
  getBoundingClientRect(){return {left:600,right:700,bottom:130};},
  matches(selector){return selector.includes('[data-schedule-viewport]')&&this.dataset.scheduleViewport==='true';},
  querySelectorAll(selector){const found=[];function visit(node){if(selector==='[data-schedule-column]'&&node.dataset.scheduleColumn||selector==='[data-schedule-spacer]'&&node.dataset.scheduleSpacer||selector===node.tagName)found.push(node);node.children.forEach(visit);}this.children.forEach(visit);return found;},
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
 };}
 document.createElement=element;document.body=element('body');
 const window={innerWidth:800,innerHeight:600,localStorage:{getItem(key){if(denied)throw Error('denied');return stored.get(key)||null;},setItem(key,value){if(denied)throw Error('denied');writes++;stored.set(key,value);}},addEventListener(name,fn){events[name]=fn;}};
 vm.runInNewContext(source,{window,document,Set,Map,JSON,Array,Number,parseFloat});
 return {api:window.CeasefireScheduleColumns,stored,events,document,window,element,writes:()=>writes};
}
let passed=0;
const columns=[{id:'column:A',label:'Item'},{id:'column:L',label:'Waste'},{id:'virtual:report',label:'Report'},{id:'virtual:actions',label:'Actions'}];
const h=harness(),c=h.api.create();let changed=0;c.bind('steel_board:CALCULATOR',columns,()=>changed++);
assert.ok(c.inputs.every(({input})=>input.checked));assert.equal(c.all.checked,true);assert.equal(h.writes(),0);assert.equal(changed,0);passed++;
c.inputs[1].input.checked=false;c.inputs[1].input.emit('change');assert.equal(c.all.checked,false);assert.equal(c.all.indeterminate,true);assert.equal(changed,1);
assert.deepEqual(JSON.parse(h.stored.get('ceasefire.scheduleColumns.v1.steel_board:CALCULATOR')),{version:1,hidden:['column:L']});passed++;
const second=h.api.create();second.bind('steel_board:CALCULATOR',columns,()=>changed++);assert.equal(second.inputs[1].input.checked,false);
second.all.checked=false;second.all.emit('change');assert.ok(c.inputs.every(({input})=>!input.checked));assert.equal(c.all.indeterminate,false);passed++;
c.all.checked=true;c.all.emit('change');assert.ok(second.inputs.every(({input})=>input.checked));assert.equal(c.all.checked,true);passed++;
const other=h.api.create();other.bind('ductwork:CALCULATOR',columns,()=>{});other.inputs[0].input.checked=false;other.inputs[0].input.emit('change');assert.ok(c.inputs.every(({input})=>input.checked));passed++;
c.inputs[2].input.checked=false;c.inputs[2].input.emit('change');
const restored=harness(Object.fromEntries(h.stored)),r=restored.api.create();r.bind('steel_board:CALCULATOR',[...columns,{id:'column:M',label:'New advanced input'}],()=>{});
assert.equal(r.inputs[2].input.checked,false);assert.equal(r.inputs.at(-1).input.checked,true);passed++;
for(const value of ['{broken','{"version":2,"hidden":["column:A"]}','{"version":1,"hidden":[3]}','{"version":1,"hidden":["<script>"]}']){
 const fresh=harness({'ceasefire.scheduleColumns.v1.board:SCHEDULE':value}),control=fresh.api.create();control.bind('board:SCHEDULE',columns,()=>{});assert.ok(control.inputs.every(({input})=>input.checked));
}passed++;
const denied=harness({},true),d=denied.api.create();d.bind('board:SCHEDULE',columns,()=>{});d.inputs[0].input.checked=false;assert.doesNotThrow(()=>d.inputs[0].input.emit('change'));assert.equal(d.inputs[0].input.checked,false);passed++;
// Removing a redundant source display column does not reassign its saved
// hidden choice to Report, and an existing Report choice keeps its identity.
for(const hidden of [['column:X'],['column:X','virtual:report']]){
 const old=harness({'ceasefire.scheduleColumns.v1.spray:SCHEDULE':JSON.stringify({version:1,hidden})}),control=old.api.create();
 control.bind('spray:SCHEDULE',columns,()=>{});
 assert.equal(control.inputs.some(({id})=>id==='column:X'),false);
 assert.equal(control.inputs.find(({id})=>id==='virtual:report').input.checked,!hidden.includes('virtual:report'));
 assert.ok(control.inputs.filter(({id})=>id!=='virtual:report').every(({input})=>input.checked));
 assert.equal(old.writes(),0);
}passed++;
c.button.emit('click');assert.equal(c.button.getAttribute('aria-expanded'),'true');assert.equal(h.document.activeElement,c.all);assert.equal(c.panel.parentElement,h.document.body);
let prevented=false;c.panel.emit('keydown',{key:'Escape',preventDefault(){prevented=true;},stopPropagation(){}});assert.ok(prevented);assert.equal(c.panel.hidden,true);assert.equal(h.document.activeElement,c.button);passed++;
h.document.documentElement.dir='rtl';c.button.emit('click');assert.equal(c.panel.style.left,'448px');h.events.pointerdown({target:h.document.body});assert.equal(c.panel.hidden,true);passed++;
c.button.emit('click');c.inputs[2].input.focus();c.panel.scrollTop=90;c.bind('steel_board:CALCULATOR',columns,()=>changed++);
assert.ok(h.document.activeElement===c.inputs[2].input,'An open chooser retains its focused column after a response rebind');assert.equal(c.panel.scrollTop,90);c.close();passed++;
c.button.emit('click');h.events.scroll({target:h.element('input')});assert.equal(c.panel.hidden,false);
h.events.scroll({target:h.window});assert.equal(c.panel.hidden,false);c.close();passed++;
// Hiding is a DOM projection: exact input node/value/selection and scroll survive.
const scroll=h.element('div'),table=h.element('table'),cols=h.element('colgroup'),head=h.element('tr'),body=h.element('tr'),input=h.element('input'),spacer=h.element('td');
scroll.scrollLeft=125;scroll.scrollTop=456;scroll.dataset.scheduleViewport='true';scroll.append(table);table.append(cols,head,body,spacer);table.scheduleColumnLayout=columns.map(column=>({id:column.id,width:120}));
for(const column of columns){const th=h.element('th'),td=h.element('td');th.dataset.scheduleColumn=td.dataset.scheduleColumn=column.id;head.append(th);body.append(td);}
input.value='1.123456789012345';input.selectionStart=2;input.selectionEnd=8;body.children[0].append(input);spacer.dataset.scheduleSpacer='true';
const unchanged=JSON.stringify({value:input.value,start:input.selectionStart,end:input.selectionEnd});
h.api.applyTable(table,new Set(['column:L','virtual:report']));assert.equal(cols.children.length,2);assert.equal(table.style.width,'240px');assert.equal(spacer.colSpan,2);
assert.equal(head.children[1].hidden,true);assert.equal(body.children[2].hidden,true);assert.equal(body.children[0].children[0],input);assert.equal(scroll.scrollLeft,125);assert.equal(scroll.scrollTop,456);
assert.equal(JSON.stringify({value:input.value,start:input.selectionStart,end:input.selectionEnd}),unchanged);passed++;
assert.equal(h.api.isProjectionScroll(scroll),true);c.button.emit('click');h.events.scroll({target:scroll});assert.equal(c.panel.hidden,false);
scroll.scrollTop++;assert.equal(h.api.isProjectionScroll(scroll),false);h.events.scroll({target:scroll});assert.equal(c.panel.hidden,true);passed++;
h.api.applyTable(table,new Set(columns.map(column=>column.id)));assert.equal(table.hidden,true);assert.equal(table.scheduleColumnsEmpty.hidden,false);assert.equal(spacer.colSpan,1);
h.api.applyTable(table,new Set());assert.equal(table.hidden,false);assert.equal(cols.children.length,4);assert.equal(table.scheduleColumnsEmpty.hidden,true);assert.equal(body.children[0].children[0],input);passed++;
// Detached cached controls lose language bindings. A reused view must reclaim
// its owned labels without changing preferences, inputs or callback counts.
const localized=harness(),translations={Columns:'列','Visible columns':'可见列','Select a column to show the schedule.':'选择要显示的列。'};let chinese=false;
localized.window.CeasefireI18n={text(element,source){element.textContent=chinese?translations[source]||source:source;return element;},attr(element,attribute,source){element.setAttribute(attribute,chinese?translations[source]||source:source);return element;}};
const cached=localized.api.create();let localizedChanges=0;cached.bind('board:SCHEDULE',columns,()=>localizedChanges++);assert.equal(cached.button.textContent,'Columns');
chinese=true;cached.bind('board:SCHEDULE',columns,()=>localizedChanges++);assert.equal(cached.button.textContent,'列');assert.equal(cached.panel.getAttribute('aria-label'),'可见列');assert.equal(localizedChanges,0);assert.equal(localized.writes(),0);passed++;
console.log(`${passed} schedule column controller checks passed.`);
