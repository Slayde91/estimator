const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const runtime=fs.readFileSync(path.join(__dirname,'../static/language.js'),'utf8');
class Element {
  constructor(tag='DIV',text=''){this.tagName=tag;this.nodeType=tag==='#text'?3:1;this.children=[];this.attrs={};this.dataset={};this.listeners={};this.isConnected=true;this.raw=text;}
  get childNodes(){return this.children;}
  get textContent(){return this.raw+this.children.map(n=>n.textContent).join('');}
  set textContent(text){this.raw=String(text);for(const n of this.children)n.isConnected=false;this.children=[];}
  append(...nodes){for(const n of nodes){this.children.push(n);n.isConnected=this.isConnected;}}
  replaceChildren(...nodes){this.textContent='';for(const n of nodes)this.append(n);}
  cloneNode(){return new Element(this.tagName,this.textContent);}
  getAttribute(name){return this.attrs[name]??null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  hasAttribute(name){return name in this.attrs;}
  removeAttribute(name){delete this.attrs[name];}
  set value(value){this.attrs.value=String(value);}
  get value(){return this.attrs.value??this.textContent;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  matches(){return false;}
  querySelectorAll(){return [];}
}
function harness(saved=null,denied=false,messages=null){
  const root=new Element('HTML'),select=new Element('SELECT'),status=new Element(),events=[],writes=[],listeners={};let observer;
  const store={getItem(){if(denied)throw Error('denied');return saved;},setItem(k,v){if(denied)throw Error('denied');writes.push([k,v]);}};
  const document={documentElement:root,body:new Element(),querySelectorAll(){return[];},getElementById(id){return id==='application-language'?select:id==='language-status'?status:null;},createTextNode(text){return new Element('#text',text);},createElement(tag){return new Element(tag.toUpperCase());}};
  const window={CeasefireMessages:{Home:['主页','मुखपृष्ठ','Inicio','الرئيسية','หน้าหลัก'],'Open {0}':['打开 {0}','{0} खोलें','Abrir {0}','فتح {0}','เปิด {0}']},addEventListener(k,fn){listeners[k]=fn;},dispatchEvent(e){events.push(e);}};
  if(messages)window.CeasefireMessages=messages;
  const context={window,document,localStorage:store,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},MutationObserver:class{constructor(fn){observer=fn;}observe(){}}};
  vm.createContext(context);vm.runInContext(runtime,context);return {ui:window.CeasefireI18n,context,root,select,status,events,writes,listeners,observe:n=>observer([{addedNodes:[n]}])};
}
function catalogs(){return Object.assign({},...fs.readdirSync(path.join(__dirname,'../static/locales')).filter(name=>name.endsWith('.json')).sort().map(name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../static/locales',name),'utf8'))));}
test('six locales persist independently and invalid preference falls back to English',()=>{
  const h=harness('invalid');assert.equal(h.ui.language,'en');assert.equal(h.root.lang,'en-AU');assert.equal(h.writes.length,0);
  for(const locale of ['zh-Hans','hi','es','ar','th','en']){assert.equal(h.ui.setLanguage(locale),true);assert.equal(h.select.value,locale);assert.equal(h.root.dir,locale==='ar'?'rtl':'ltr');assert.equal(h.writes.at(-1)[0],'ceasefire.ui.language.v1');}
  assert.equal(h.ui.setLanguage('fr'),false);assert.equal(h.ui.language,'en');
});
test('existing text, accessible attributes and nested terms update without reloading or losing child icons',()=>{
  const h=harness(),label=new Element(),icon=new Element('SVG'),button=new Element('BUTTON');
  h.ui.nodeText(button,'Home');button.append(icon);h.ui.text(label,'Open {0}',[h.ui.term('Home')]);h.ui.attr(button,'aria-label','Home');
  h.ui.setLanguage('es');assert.equal(button.textContent,'Inicio');assert.equal(button.children[1],icon);assert.equal(label.textContent,'Abrir Inicio');assert.equal(button.getAttribute('aria-label'),'Inicio');assert.equal(h.ui.source(button),'Home');
  h.ui.setLanguage('en');assert.equal(button.textContent,'Home');assert.equal(label.textContent,'Open Home');
});
test('raw user data and option values stay canonical and stale bindings never overwrite later source content',()=>{
  const h=harness(),raw=new Element('DIV','Home'),field=new Element('INPUT'),label=new Element(),option=new Element('OPTION');field.value='Home';
  h.ui.text(label,'Home');h.ui.text(option,'Home');label.textContent='User document Home';h.ui.setLanguage('ar');
  assert.equal(raw.textContent,'Home');assert.equal(field.value,'Home');assert.equal(label.textContent,'User document Home');assert.equal(option.value,'Home');assert.equal(option.textContent,'الرئيسية');
  h.ui.setLanguage('en');h.ui.text(label,'Home');label.replaceChildren(new Element('#text','Home'));
  h.ui.setLanguage('es');assert.equal(label.textContent,'Home','replacement by identical raw text retires the old UI binding');assert.equal(h.ui.source(label),'Home');
});
test('session changes work with blocked storage; storage sync and unknown keys are safe',()=>{
  const h=harness(null,true),node=new Element();h.ui.text(node,'Unknown {0}',['<img>']);h.ui.setLanguage('th');assert.equal(node.textContent,'Unknown <img>');assert.equal(h.writes.length,0);
  h.listeners.storage({key:'unrelated',newValue:'es'});assert.equal(h.ui.language,'th');h.listeners.storage({key:'ceasefire.ui.language.v1',newValue:'ar'});assert.equal(h.ui.language,'ar');
});
test('Mandarin breakdown tables translate owned tasks and contexts while retaining source products, precision and data',()=>{
  const h=harness(null,false,catalogs());vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/penetration-breakdown.js'),'utf8'),h.context);
  const labels=['Additional Labour','Register allowance','Board','Collars','Mastic','Framing','Wrap','Other'];
  const rows=labels.map(label=>({label,unit_prices:[],material_quantities:[],material_costs:12.3456789012345,labour_costs:0,task_hours:null}));
  rows[2].unit_prices=['Board','Primer','Home'].map(product=>({column:'CX',label:product,product,value:2.1234567890123}));
  rows[2].material_quantities=[{column:'CJ',label:'Board · Substrate',product:'Board',value:1.23456789,units:'m²'},{column:'CQ',label:'Line 2 · Bulkhead',product:null,value:3.45678901,units:'m²'},{column:'CJ',label:'Home',value:4}];
  rows[6].material_quantities=[{column:'BS',label:'Pipes',value:8.76543210,units:'m²'},{column:'CB',label:'Cabletrays',value:'#VALUE!'}];
  const projection={rows,totals:{material_costs:77.777777777,labour_costs:0,task_hours:'#DIV/0!'},note:'Costs and task hours include schedule quantities.'};
  const result={schedule_breakdown:projection,errors:[]},before=JSON.stringify(result),api=h.context.window.CeasefirePenetrationBreakdown;
  const output=api.renderSchedule({},result),table=output.children[0].children[0],body=table.children[2],foot=table.children[3];
  h.ui.setLanguage('zh-Hans');
  assert.deepEqual(body.children.map(row=>row.children[0].textContent),['附加人工','登记工时预留','板材','防火圈','密封胶','框架','防火包裹材料','其他']);
  assert.deepEqual(table.children[1].children[0].children.map(cell=>cell.textContent),['项目','单价','材料数量','材料费用','人工费用','任务工时']);
  assert.deepEqual(body.children[2].children[1].children.map(entry=>entry.children[0].textContent),['Board','Primer','Home']);
  assert.deepEqual(body.children[2].children[2].children.map(entry=>entry.children[0].textContent),['Board · 基材','第 2 行 · 封堵隔板','Home']);
  assert.deepEqual(body.children[6].children[2].children.map(entry=>entry.children[0].textContent),['管道','电缆桥架']);
  assert.equal(body.children[6].children[2].children[1].children[1].textContent,'检查输入');
  assert.equal(foot.children[0].children[0].textContent,'小计');assert.equal(foot.children[0].children[1].textContent,'$77.78');
  assert.equal(foot.children[0].children[3].textContent,'检查输入');assert.equal(output.children.length,1,'schedule helper note is omitted');
  for(const locale of ['hi','es','ar','th','en']){h.ui.setLanguage(locale);assert.equal(JSON.stringify(result),before);assert.deepEqual(body.children[2].children[1].children.map(entry=>entry.children[0].textContent),['Board','Primer','Home']);}
  assert.deepEqual(body.children.map(row=>row.children[0].textContent),labels);assert.equal(body.children[2].children[2].children[0].children[0].textContent,'Board · Substrate');
  const item=api.render({}, {errors:[],breakdown:projection});assert.equal(item.children.at(-1).textContent,projection.note,'current-item note is retained');
});
test('Generated estimate material descriptions translate without altering selected product names or canonical results',()=>{
  const h=harness(null,false,catalogs());
  const source=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').match(/  function materialNameCell\(material\) \{[\s\S]*?\n  \}\n/)[0];
  h.context.node=(tag,cls,text)=>new Element(tag.toUpperCase(),text??'');
  h.context.uiNode=(tag,cls,source,args)=>h.ui.text(new Element(tag.toUpperCase()),source,args);
  vm.runInContext(source,h.context);
  const records=[{source:'firestopping',product:null,name:'Item 3 Wrap · Pipes',context:'Pipes',quantity:1.23456789012345},{source:'firestopping',product:null,name:'Line 4 · Material adjustment',context:'Material adjustment',total:99.987654321},{source:'firestopping',product:'Board',name:'Board',context:'Substrate'},{source:'firestopping',product:'Home',name:'Home'},{source:'firestopping',product:null,name:'User supplied <literal>',context:'Pipes'}],before=JSON.stringify(records);
  const cells=records.map(h.context.materialNameCell);h.ui.setLanguage('zh-Hans');
  assert.deepEqual(cells.map(cell=>cell.textContent),['项目 3 防火包裹材料 · 管道','第 4 行 · 材料调整','Board','Home','User supplied <literal>']);
  h.ui.setLanguage('en');assert.deepEqual(cells.map(cell=>cell.textContent),records.map(record=>record.name));assert.equal(JSON.stringify(records),before);
});
test('Firestopping settings tables translate schema routes and band context while preserving raw option text and thresholds',()=>{
  const h=harness(null,false,catalogs()),source=fs.readFileSync(path.join(__dirname,'../static/penetration.js'),'utf8');
  h.context.node=(tag,cls,text)=>{const element=new Element(tag.toUpperCase(),text??'');element.className=cls;return element;};
  h.context.uiNode=(tag,cls,source,args)=>h.ui.text(h.context.node(tag,cls),source,args);h.context.uiAttr=h.ui.attr;h.context.uiTerm=h.ui.term;
  const routes=['Unlagged Pipes','Lagged Pipes','Plastic Pipes','Cables/Bundles','Cabletrays'];
  h.context.state={definition:{settings:{service_routes:routes.map(label=>({key:label,label})),labour_bands:[{key:'pipe',label:'Pipe Labour',basis:'Pipe diameter',overflow:'manual',units:'mm'}]}},schedule:{draft:{globals:{service_routes:Object.fromEntries(routes.map(key=>[key,['Board','Home']])),labour_bands:{pipe:[{maximum:75.1234567890123,hours:.3456789012345}]}}}}};
  for(const name of ['renderServiceRoutes','renderLabourBands'])vm.runInContext(source.match(new RegExp(`  function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}\\n`))[0],h.context);
  const before=JSON.stringify(h.context.state),routing=h.context.renderServiceRoutes(),bands=h.context.renderLabourBands(),descendants=node=>[node,...node.children.flatMap(descendants)];
  h.ui.setLanguage('zh-Hans');const routeRows=routing.children[1].children[0].children[1].children;
  assert.ok(routeRows.every(row=>/[\u3400-\u9fff]/.test(row.children[0].textContent)));
  assert.ok(routeRows.every(row=>row.children[1].children[0].value==='Board; Home'));
  const bandNodes=descendants(bands),context=bandNodes.find(node=>node.className==='helper');assert.ok(/[\u3400-\u9fff]/.test(context.textContent));assert.doesNotMatch(context.textContent,/Pipe diameter|Values above the final band/);
  const maximum=bandNodes.find(node=>node.dataset.penetrationBand==='labour_bands.pipe.0.maximum');assert.equal(maximum.value,'75.1234567890123');assert.ok(/[\u3400-\u9fff]/.test(maximum.getAttribute('aria-label')));assert.match(maximum.getAttribute('aria-label'),/mm/);
  h.ui.setLanguage('en');assert.deepEqual(routeRows.map(row=>row.children[0].textContent),routes.map(label=>label.toUpperCase()));assert.equal(JSON.stringify(h.context.state),before);
});
test('Operational calculator START prose translates its actual display wording and retains source ownership on language changes',()=>{
  const h=harness(null,false,catalogs()),source=fs.readFileSync(path.join(__dirname,'../static/calculators.js'),'utf8');
  for(const name of ['factorLookupDirections','estimatingDensityDirections'])vm.runInContext(source.match(new RegExp(`^  const ${name} = [^\\n]+;`,'m'))[0],h.context);
  for(const name of ['browserPresentation','calculatorLabelSources','sourceDirections'])vm.runInContext(source.match(new RegExp(`^  const ${name} = \\{[\\s\\S]*?^  \\};`,'m'))[0],h.context);
  vm.runInContext(source.match(/^  function sheetMetadata[^\n]+/m)[0],h.context);
  for(const name of ['parseAddress','sourceDisplayText','bindCalculatorLabel'])vm.runInContext(source.match(new RegExp(`^  function ${name}[^\\n]+\\n[\\s\\S]*?^  \\}`,'m'))[0],h.context);
  const entry={definition:{id:'steel_vermiculite',sheets:[{name:'SETTINGS'}]},sheet:'SETTINGS',inputs:{SETTINGS:{D346:1.23456789012345}}},before=JSON.stringify(entry),bindings=[];
  for(const address of ['A7','A273']){
    const raw=vm.runInContext(`calculatorLabelSources.steel_vermiculite.SETTINGS.${address}`,h.context),cell={address,value:raw,editable:false,calculated:false},display=h.context.sourceDisplayText(raw,entry,address),element=new Element('P',display);
    assert.notEqual(display,raw,'the existing browser wording is resolved before translation');assert.equal(h.context.bindCalculatorLabel(element,cell,entry,address,display),true);
    bindings.push({element,cell,display});
  }
  assert.equal(bindings[0].display,'SCHEDULE = members  |  SCHEDULE = take-off  |  SUMMARY = ordering  |  Open FACTOR CALCS for the Section Factor Helper.');
  const probes=[{...bindings[0].cell,editable:true},{...bindings[0].cell,calculated:true},{...bindings[0].cell,address:'A285'},{...bindings[0].cell,value:'User '+bindings[0].cell.value}].map(cell=>{
    const element=new Element('P',cell.value);assert.equal(h.context.bindCalculatorLabel(element,cell,entry,cell.address),false);return{element,cell};
  });
  h.ui.setLanguage('zh-Hans');
  assert.equal(bindings[0].element.textContent,'清单 = 构件 | 清单 = 工程量提取 | 汇总 = 订购 | 打开“系数计算”使用截面系数助手。');
  assert.match(bindings[1].element.textContent,/[\u3400-\u9fff]/);assert.doesNotMatch(bindings[1].element.textContent,/Use SCHEDULE/);
  for(const {element,cell} of probes)assert.equal(element.textContent,cell.value,'formula, input and arbitrary source strings remain literal');
  h.ui.setLanguage('en');for(const {element,cell,display} of bindings){assert.equal(element.textContent,display);assert.equal(h.context.sourceDisplayText(cell.value,entry,cell.address),display);}
  assert.equal(JSON.stringify(entry),before,'presentation never edits the calculator draft or precision');
  for(const address of ['A281','A285','A289','A297'])assert.equal(vm.runInContext(`calculatorLabelSources.steel_vermiculite.SETTINGS.${address}`,h.context),undefined,'assessment summaries stay outside owned START copy');
});
