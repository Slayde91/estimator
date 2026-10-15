const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const runtime=fs.readFileSync(path.join(__dirname,'../static/language.js'),'utf8');
class Element {
  constructor(tag='DIV',text=''){this.tagName=tag;this.nodeType=tag==='#text'?3:1;this.children=[];this.attrs={};this.dataset={};this.listeners={};this.isConnected=true;this.raw=text;}
  get childNodes(){return this.children;}
  get textContent(){return this.raw+this.children.map(n=>n.textContent).join('');}
  set textContent(text){this.raw=String(text);for(const n of this.children)n.isConnected=false;this.children=[];}
  append(n){this.children.push(n);n.isConnected=this.isConnected;}
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
function harness(saved=null,denied=false){
  const root=new Element('HTML'),select=new Element('SELECT'),status=new Element(),events=[],writes=[],listeners={};let observer;
  const store={getItem(){if(denied)throw Error('denied');return saved;},setItem(k,v){if(denied)throw Error('denied');writes.push([k,v]);}};
  const document={documentElement:root,body:new Element(),querySelectorAll(){return[];},getElementById(id){return id==='application-language'?select:id==='language-status'?status:null;},createTextNode(text){return new Element('#text',text);}};
  const window={CeasefireMessages:{Home:['主页','मुखपृष्ठ','Inicio','الرئيسية','หน้าหลัก'],'Open {0}':['打开 {0}','{0} खोलें','Abrir {0}','فتح {0}','เปิด {0}']},addEventListener(k,fn){listeners[k]=fn;},dispatchEvent(e){events.push(e);}};
  const context={window,document,localStorage:store,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},MutationObserver:class{constructor(fn){observer=fn;}observe(){}}};
  vm.runInNewContext(runtime,context);return {ui:window.CeasefireI18n,root,select,status,events,writes,listeners,observe:n=>observer([{addedNodes:[n]}])};
}
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
