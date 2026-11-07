'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const copy=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const cover='data:application/pdf;base64,JVBERi0x';
function harness(){
  const element=tag=>({tagName:tag,children:[],handlers:{},attributes:{},dataset:{},files:[],value:'',textContent:'',disabled:false,
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name]??null;},
    addEventListener(name,handler){(this.handlers[name]||=[]).push(handler);},async emit(name){for(const handler of this.handlers[name]||[])await handler({});}});
  const host=element('tbody'),status=element('p'),calls=[],pendingReads=[],events={},records=new Map([
    ['certification',{kind:'certification',label:'Certification',cover_pdf:null,cover_pdf_name:'',version:1}],
    ['takeoff_markups',{kind:'takeoff_markups',label:'Takeoff markups',cover_pdf:cover,cover_pdf_name:'Saved.pdf',version:2}],
  ]);
  let override=null,approve=true,lostReply=false;
  const metadata=value=>{const {cover_pdf,...other}=value;return {...copy(other),has_cover:!!cover_pdf};};
  const response=value=>({ok:true,status:200,json:async()=>copy(value)});
  const serverError=(status,message)=>({ok:false,status,json:async()=>({error:message})});
  async function fetch(path,options){
    const body=options?.body?JSON.parse(options.body):undefined;calls.push({path,body});
    if(override){const result=await override(path,body);if(result!==undefined)return result;}
    if(path==='/api/pdf-covers')return response({items:[...records.values()].map(metadata)});
    const item=records.get(path.split('/').at(-1));
    if(!item)return serverError(404,'Missing row');
    if(item.cover_pdf===body.cover_pdf&&item.cover_pdf_name===body.cover_pdf_name)return response(metadata(item));
    if(item.version!==body.expected_version)return serverError(409,'Changed');
    Object.assign(item,{cover_pdf:body.cover_pdf,cover_pdf_name:body.cover_pdf_name,version:item.version+1});
    if(lostReply){lostReply=false;throw Error('Connection lost after commit');}
    return response(metadata(item));
  }
  class FileReader{readAsDataURL(file){this.result=file.dataURL||cover;const finish=()=>file.fail?this.onerror():this.onload();if(file.hold)pendingReads.push(finish);else Promise.resolve().then(finish);}}
  const window={CeasefireDialogs:{confirm:async()=>approve},CeasefireActivity:{begin:()=>()=>{}},addEventListener:(name,handler)=>{(events[name]||=[]).push(handler);}};
  for(const documentKind of ['certification','takeoff.markups.pdf']) {
    const tr=element('tr');tr.dataset.documentKind=documentKind;
    tr.append(element('td'),element('td'),element('td'));tr.querySelectorAll=()=>[];
    host.append(tr);
  }
  host.querySelectorAll=()=>host.children;
  const context={window,document:{getElementById:id=>id==='documentation-pdf-rows'?host:status,createElement:element},FileReader,fetch,JSON,Map,Set,Array,Object,Number,Error,encodeURIComponent};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/cover-sheets.js','utf8'),context);
  function row(kind){const e=host.children.find(el=>el.dataset.coverKind===kind);return {element:e,file:e.children[3].children[0],filename:e.children[3].children[1],notice:e.children[3].children[2],actions:e.children[4].children[0],remove:e.children[4].children[0].children[0]};}
  return {api:window.CeasefireCoverSheets,row,records,calls,host,status,window,response,serverError,metadata,
    override:fn=>{override=fn;},approve:value=>{approve=value;},loseReply:()=>{lostReply=true;},
    upload:async(kind,file={})=>{const input=row(kind).file;input.files=[{name:'Selected.pdf',type:'application/pdf',size:123,...file}];await input.emit('change');},
    completeRead:()=>pendingReads.shift()(),save:()=>window.CeasefireCoverSheets.saveAll(),remove:kind=>row(kind).remove.emit('click')};
}

let checks=0;
async function check(name,fn){const h=harness();await h.api.open();await fn(h);checks++;console.log('ok - '+name);}
(async()=>{
  await check('Rows expose only Trash and uploads remain drafts until main Save',async h=>{
    assert.equal(h.row('certification').actions.children.length,1);
    await h.upload('certification',{name:'<literal name>.pdf'});
    assert.equal(h.records.get('certification').cover_pdf,null);
    assert.equal(h.api.hasUnsavedChanges(),true);
    assert.equal(h.row('certification').filename.textContent,'Cover sheet: <literal name>.pdf');
    await h.api.saveAll();assert.equal(h.records.get('certification').cover_pdf,cover);
    assert.equal(h.records.get('certification').cover_pdf_name,'<literal name>.pdf');
    assert.equal(h.api.hasUnsavedChanges(),false);
    assert.equal(h.calls.filter(call=>call.body).length,1);
  });
  await check('Trash stages removal until main Save, without touching another row',async h=>{
    await h.upload('certification');await h.remove('takeoff_markups');
    assert.equal(h.records.get('takeoff_markups').cover_pdf,cover);
    assert.equal(h.row('takeoff_markups').filename.textContent,'No cover sheet selected.');
    await h.api.saveAll();assert.equal(h.records.get('takeoff_markups').cover_pdf,null);
    assert.equal(h.records.get('certification').cover_pdf,cover);
    assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Cancel keeps cover drafts and Yes discards them without a write',async h=>{
    await h.upload('certification');await h.remove('takeoff_markups');
    const stamp=h.api.fingerprint();h.approve(false);assert.equal(await h.api.leave(),false);
    assert.equal(h.api.fingerprint(),stamp);h.approve(true);assert.equal(await h.api.leave(),true);
    assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.records.get('takeoff_markups').cover_pdf,cover);
    assert.equal(h.row('takeoff_markups').filename.textContent,'Cover sheet: Saved.pdf');
    assert.equal(h.calls.filter(call=>call.body).length,0);
  });
  await check('Invalid or unreadable uploads retain the saved cover',async h=>{
    await h.upload('takeoff_markups',{name:'bad.exe',type:'application/octet-stream'});
    assert.match(h.row('takeoff_markups').notice.textContent,/Choose a PDF/);
    await h.upload('takeoff_markups',{fail:true});assert.equal(h.api.hasUnsavedChanges(),false);
    assert.equal(h.row('takeoff_markups').filename.textContent,'Cover sheet: Saved.pdf');
  });
  await check('Main Save cannot race a pending read',async h=>{
    const upload=h.upload('certification',{hold:true});await flush();
    assert.equal(h.api.hasPendingOperation(),true);
    await assert.rejects(h.api.saveAll(),/Finish the cover-sheet upload/);
    assert.equal(h.calls.filter(call=>call.body).length,0);
    h.completeRead();await upload;await h.api.saveAll();assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('An uncertain committed Save retries identical payload and version',async h=>{
    await h.upload('certification');h.loseReply();await assert.rejects(h.api.saveAll(),/not all saved/);
    assert.equal(h.records.get('certification').version,2);assert.equal(h.api.hasPendingOperation(),true);
    assert.equal(h.row('certification').file.disabled,true);
    await h.api.saveAll();const posts=h.calls.filter(call=>call.body);
    assert.deepEqual(posts[0].body,posts[1].body);assert.equal(h.records.get('certification').version,2);
    assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('An uncertain committed removal retries without restoring deleted cover',async h=>{
    await h.remove('takeoff_markups');h.loseReply();await assert.rejects(h.api.saveAll());
    await h.api.saveAll();const posts=h.calls.filter(call=>call.body);
    assert.deepEqual(posts[0].body,posts[1].body);assert.equal(h.records.get('takeoff_markups').cover_pdf,null);
    assert.equal(h.records.get('takeoff_markups').version,3);
  });
  await check('Conflict cancellation retains upload; approval refreshes version',async h=>{
    await h.upload('certification',{name:'My selection.pdf'});
    Object.assign(h.records.get('certification'),{cover_pdf:cover+'X',cover_pdf_name:'Other window.pdf',version:2});
    await assert.rejects(h.api.saveAll());h.approve(false);await assert.rejects(h.api.saveAll());
    assert.equal(h.records.get('certification').cover_pdf_name,'Other window.pdf');
    assert.equal(h.row('certification').filename.textContent,'Cover sheet: My selection.pdf');
    h.approve(true);await h.api.saveAll();assert.equal(h.calls.at(-1).body.expected_version,2);
    assert.equal(h.records.get('certification').cover_pdf_name,'My selection.pdf');
  });
  await check('A failed later row keeps it dirty and does not repeat the saved earlier row',async h=>{
    await h.upload('certification');await h.remove('takeoff_markups');
    h.override(async(path,body)=>body&&path.endsWith('takeoff_markups')?h.serverError(400,'Invalid'):undefined);
    await assert.rejects(h.api.saveAll());assert.equal(h.records.get('certification').cover_pdf,cover);
    assert.equal(h.api.hasUnsavedChanges(),true);h.override(null);await h.api.saveAll();
    assert.equal(h.calls.filter(call=>call.body&&call.path.endsWith('certification')).length,1);
  });
  console.log(checks+' cover-sheet UI checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
