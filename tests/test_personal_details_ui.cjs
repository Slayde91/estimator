'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const names=['name','position','qualification','accreditation'];
const copy=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function harness(){
  const elements=new Map(),events={},calls=[];let approve=true,override=null,loseReply=false;
  let saved={version:1,fields:{accreditation:'A-001',name:'Example signer',position:'Manager',qualification:'Cert 2'},signature_image:'existing-image',signature_name:'Existing.png'};
  const element=id=>({id,value:'',disabled:false,attributes:{},listeners:{},textContent:'',hidden:true,
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);},
    async emit(k,event={}){event.preventDefault??=()=>{};for(const fn of this.listeners[k]||[])await fn(event);},reportValidity:()=>true});
  const byId=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};
  const form=byId('personal-details-form');form.elements=[...names.map(n=>byId('personal-'+n)),byId('personal-details-save')];
  const response=value=>({ok:true,status:200,json:async()=>copy(value)});
  async function fetch(url,options){
    assert.equal(url,'/api/certifications/defaults');const body=options?.body?JSON.parse(options.body):undefined;calls.push(body);
    if(override){const result=await override(body);if(result)return result;}
    if(!body)return response(saved);
    assert.deepEqual(Object.keys(body).sort(),['expected_version','fields']);
    const same=names.every(name=>body.fields[name]===saved.fields[name]);
    if(!same&&body.expected_version!==saved.version)return {ok:false,status:409,json:async()=>({error:'Changed in another window'})};
    if(!same)saved={...saved,version:saved.version+1,fields:copy(body.fields)};
    if(loseReply){loseReply=false;throw Error('Connection lost');}
    return response(saved);
  }
  const window={CeasefireDialogs:{confirm:async()=>approve},CeasefireActivity:{begin:()=>()=>{}},
    addEventListener(k,fn){(events[k]??=[]).push(fn);},dispatchEvent(event){for(const fn of events[event.type]||[])fn(event);}};
  const context={window,document:{getElementById:byId},fetch,JSON,Object,Array,Number,Error,
    CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/personal-details.js','utf8'),context);await flush();
  return {api:window.CeasefirePersonalDetails,form,byId,calls,events,window,response,
    get saved(){return saved;},external(fields){saved={...saved,version:saved.version+1,fields:{...saved.fields,...fields}};},
    approve(v){approve=v;},override(fn){override=fn;},loseReply(){loseReply=true;},
    async edit(name,value){byId('personal-'+name).value=value;await form.emit('input');},save:()=>form.emit('submit')};
}
let passed=0;
async function check(name,fn){const h=await harness();await fn(h);passed++;console.log('ok - '+name);}
(async()=>{
  await check('Existing signer defaults populate Personal Details with a stable field order',async h=>{
    assert.equal(h.byId('personal-name').value,'Example signer');assert.equal(h.api.hasUnsavedChanges(),false);
    assert.equal(h.byId('personal-details-save').disabled,false);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('Save changes shared text defaults without sending or clearing saved signature artwork',async h=>{
    await h.edit('qualification','<literal>\nSecond line');await h.save();
    assert.equal(h.saved.fields.qualification,'<literal>\nSecond line');assert.equal(h.saved.signature_image,'existing-image');
    assert.equal(h.saved.signature_name,'Existing.png');assert.equal(h.saved.version,2);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Conflicts retain entries, require approval, and refresh the version only after approval',async h=>{
    await h.edit('name','My entered signer');h.external({name:'Other signer'});await h.save();
    assert.equal(h.byId('personal-name').value,'My entered signer');assert.equal(h.saved.fields.name,'Other signer');
    h.approve(false);const posts=h.calls.filter(Boolean).length;await h.save();assert.equal(h.calls.filter(Boolean).length,posts);
    h.approve(true);await h.save();assert.equal(h.saved.fields.name,'My entered signer');assert.equal(h.calls.at(-1).expected_version,2);
  });
  await check('A lost committed Save reply safely retries unchanged fields and expected version',async h=>{
    await h.edit('name','Retry signer');h.loseReply();await h.save();
    assert.equal(h.saved.version,2);assert.equal(h.api.hasUnsavedChanges(),true);await h.save();
    assert.deepEqual(h.calls.filter(Boolean)[0],h.calls.filter(Boolean)[1]);assert.equal(h.saved.version,2);
    assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('A late refresh cannot overwrite input entered after the request began',async h=>{
    const held=deferred();h.override(body=>!body?held.promise:null);
    const opening=h.api.refresh();await flush();await h.edit('name','Later draft');h.external({name:'External signer'});
    held.resolve(h.response(h.saved));await opening;assert.equal(h.byId('personal-name').value,'Later draft');
    assert.equal(h.api.hasUnsavedChanges(),true);
  });
  await check('A changed field during a held Save remains dirty after the captured Save completes',async h=>{
    const held=deferred();h.override(body=>body?held.promise:null);await h.edit('name','Captured signer');
    const saving=h.save();await flush();assert.equal(h.byId('personal-name').disabled,true);
    await h.edit('name','Later signer');held.resolve(h.response({...h.saved,version:2,fields:{...h.saved.fields,name:'Captured signer'}}));await saving;
    assert.equal(h.byId('personal-name').value,'Later signer');assert.equal(h.api.hasUnsavedChanges(),true);
  });
  await check('Saved-default notifications update clean settings but preserve dirty personal entries',async h=>{
    h.external({name:'Certificate signer'});h.window.dispatchEvent({type:'ceasefire:signer-defaults-saved',detail:h.saved});
    assert.equal(h.byId('personal-name').value,'Certificate signer');await h.edit('name','Draft personal signer');
    h.external({name:'Other saved signer'});h.window.dispatchEvent({type:'ceasefire:signer-defaults-saved',detail:h.saved});
    assert.equal(h.byId('personal-name').value,'Draft personal signer');
  });
  await check('Unsaved personal entries protect browser close and expose a dirty fingerprint',async h=>{
    const before=h.api.fingerprint();await h.edit('accreditation','New accreditation');assert.notEqual(h.api.fingerprint(),before);
    let prevented=false;const event={preventDefault(){prevented=true;}};h.events.beforeunload[0](event);
    assert.equal(prevented,true);assert.equal(event.returnValue,'');
  });
  console.log(passed+' personal-details UI checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
