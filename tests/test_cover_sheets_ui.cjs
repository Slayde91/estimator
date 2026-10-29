'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const copy=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const cover='data:application/pdf;base64,JVBERi0x';
function harness(){
  const element=tag=>({tagName:tag,children:[],handlers:{},attributes:{},files:[],value:'',textContent:'',disabled:false,
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
  const context={window,document:{getElementById:id=>id==='cover-sheets-rows'?host:status,createElement:element},FileReader,fetch,JSON,Map,Set,Array,Object,Number,Error,encodeURIComponent};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/cover-sheets.js','utf8'),context);
  function row(kind){const e=host.children.find(el=>el.attributes['data-cover-kind']===kind);return {element:e,file:e.children[1].children[0],filename:e.children[1].children[1],notice:e.children[1].children[2],save:e.children[2].children[0].children[0],remove:e.children[2].children[0].children[1]};}
  return {api:window.CeasefireCoverSheets,row,records,calls,host,status,window,response,serverError,metadata,
    override:fn=>{override=fn;},approve:value=>{approve=value;},loseReply:()=>{lostReply=true;},
    upload:async(kind,file={})=>{const input=row(kind).file;input.files=[{name:'Selected.pdf',type:'application/pdf',size:123,...file}];await input.emit('change');},
    completeRead:()=>pendingReads.shift()(),save:kind=>row(kind).save.emit('click'),remove:kind=>row(kind).remove.emit('click')};
}
let checks=0;
async function check(name,fn,{open=true}={}){const h=harness();if(open)await h.api.open();await fn(h);checks++;console.log('ok - '+name);}
(async()=>{
  await check('Cover settings load lazily, render saved metadata and require a selected file for Save',async h=>{
    assert.deepEqual(h.calls,[]);assert.equal(h.api.hasPendingOperation(),false);await h.api.open();
    assert.equal(h.host.children.length,2);assert.equal(h.row('certification').save.disabled,true);
    assert.equal(h.row('takeoff_markups').save.disabled,true);assert.equal(h.row('takeoff_markups').remove.disabled,false);
    assert.equal(h.row('takeoff_markups').filename.textContent,'Cover sheet: Saved.pdf');
    assert.equal(h.api.hasUnsavedChanges(),false);await h.api.open();assert.equal(h.calls.length,1);
  },{open:false});
  await check('Each row saves only its selected upload and retains unrelated rows',async h=>{
    const other=copy(h.records.get('takeoff_markups'));await h.upload('certification',{name:'<literal name>.pdf',type:'',dataURL:'data:application/octet-stream;base64,JVBERi0x'});
    assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.row('certification').save.disabled,false);
    assert.equal(h.row('certification').filename.textContent,'Cover sheet: <literal name>.pdf');await h.save('certification');
    assert.equal(h.records.get('certification').cover_pdf,cover);assert.equal(h.records.get('certification').cover_pdf_name,'<literal name>.pdf');
    assert.deepEqual(h.records.get('takeoff_markups'),other);assert.equal(h.api.hasUnsavedChanges(),false);assert.equal(h.row('certification').save.disabled,true);
    assert.equal(h.calls.filter(call=>call.body).length,1);assert.deepEqual(Object.keys(h.calls.at(-1).body),['cover_pdf','cover_pdf_name','expected_version']);
  });
  await check('Trash immediately persists removal and discards only that row upload',async h=>{
    await h.upload('certification');await h.remove('takeoff_markups');
    assert.equal(h.records.get('takeoff_markups').cover_pdf,null);assert.equal(h.records.get('takeoff_markups').cover_pdf_name,'');
    assert.equal(h.row('takeoff_markups').filename.textContent,'No cover sheet selected.');assert.equal(h.row('takeoff_markups').remove.disabled,true);
    assert.equal(h.row('certification').save.disabled,false);assert.equal(h.api.hasUnsavedChanges(),true);
    await h.remove('certification');assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Invalid or failed uploads keep the prior saved row usable',async h=>{
    await h.upload('takeoff_markups',{name:'bad.exe',type:'application/octet-stream'});assert.equal(h.row('takeoff_markups').filename.textContent,'Cover sheet: Saved.pdf');
    assert.match(h.row('takeoff_markups').notice.textContent,/Choose a PDF/);assert.equal(h.api.hasUnsavedChanges(),false);
    await h.upload('takeoff_markups',{fail:true});assert.equal(h.row('takeoff_markups').filename.textContent,'Cover sheet: Saved.pdf');assert.match(h.row('takeoff_markups').notice.textContent,/could not be read/);
  });
  await check('A pending read locks its row, guards project replacement and fingerprints the draft',async h=>{
    const before=h.api.fingerprint(),upload=h.upload('certification',{hold:true});await flush();
    assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.row('certification').save.disabled,true);
    await h.save('certification');assert.equal(h.calls.filter(call=>call.body).length,0);assert.notEqual(h.api.fingerprint(),before);
    h.completeRead();await upload;assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.row('certification').save.disabled,false);
  });
  await check('Independent row saves can proceed while another row is reading',async h=>{
    const upload=h.upload('certification',{hold:true});await flush();await h.remove('takeoff_markups');
    assert.equal(h.records.get('takeoff_markups').cover_pdf,null);assert.equal(h.api.hasPendingOperation(),true);h.completeRead();await upload;
  });
  await check('An uncertain committed Save retries the identical version and upload',async h=>{
    await h.upload('certification');h.loseReply();await h.save('certification');
    assert.equal(h.records.get('certification').version,2);assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.row('certification').file.disabled,true);
    await h.remove('certification');assert.equal(h.records.get('certification').cover_pdf,cover);await h.save('certification');
    const posts=h.calls.filter(call=>call.body);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(h.records.get('certification').version,2);
    assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('An uncertain committed Trash retries safely without recreating a deleted cover',async h=>{
    h.loseReply();await h.remove('takeoff_markups');assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.row('takeoff_markups').save.disabled,true);
    await h.remove('takeoff_markups');const posts=h.calls.filter(call=>call.body);assert.deepEqual(posts[0].body,posts[1].body);
    assert.equal(h.records.get('takeoff_markups').cover_pdf,null);assert.equal(h.records.get('takeoff_markups').version,3);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('A stale Save keeps the selection, permits cancellation, then refreshes the version only after approval',async h=>{
    await h.upload('certification',{name:'My selection.pdf'});Object.assign(h.records.get('certification'),{cover_pdf:cover+'X',cover_pdf_name:'Other window.pdf',version:2});
    await h.save('certification');assert.equal(h.api.hasPendingOperation(),false);assert.match(h.row('certification').notice.textContent,/another window/);
    h.approve(false);await h.save('certification');assert.equal(h.records.get('certification').cover_pdf_name,'Other window.pdf');assert.equal(h.row('certification').filename.textContent,'Cover sheet: My selection.pdf');
    h.approve(true);await h.save('certification');assert.equal(h.calls.at(-1).body.expected_version,2);assert.equal(h.records.get('certification').cover_pdf_name,'My selection.pdf');
  });
  await check('A stale Trash remains retryable even if another window added a previously empty cover',async h=>{
    await h.upload('certification');Object.assign(h.records.get('certification'),{cover_pdf:cover+'X',cover_pdf_name:'Other window.pdf',version:2});
    await h.remove('certification');assert.equal(h.row('certification').remove.disabled,false);h.approve(false);await h.remove('certification');
    assert.equal(h.records.get('certification').cover_pdf_name,'Other window.pdf');h.approve(true);await h.remove('certification');assert.equal(h.records.get('certification').cover_pdf,null);
  });
  await check('Cancelling a conflicted Trash preserves the selected upload and its fingerprint exactly',async h=>{
    await h.upload('certification',{name:'My selected.pdf'});Object.assign(h.records.get('certification'),{cover_pdf:cover+'X',cover_pdf_name:'Other window.pdf',version:2});
    await h.save('certification');const before=h.api.fingerprint(),posts=h.calls.filter(call=>call.body).length;
    h.approve(false);await h.remove('certification');assert.equal(h.api.fingerprint(),before);
    assert.equal(h.row('certification').filename.textContent,'Cover sheet: My selected.pdf');assert.equal(h.row('certification').save.disabled,false);
    assert.equal(h.calls.filter(call=>call.body).length,posts);assert.equal(h.records.get('certification').cover_pdf_name,'Other window.pdf');
    h.approve(true);await h.save('certification');assert.equal(h.records.get('certification').cover_pdf_name,'My selected.pdf');
  });
  await check('Confirmed validation errors preserve selected files and permit correction',async h=>{
    await h.upload('certification');h.override(async(path,body)=>body?h.serverError(400,'Invalid passive PDF'):undefined);await h.save('certification');
    assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.row('certification').file.disabled,false);assert.equal(h.row('certification').filename.textContent,'Cover sheet: Selected.pdf');
  });
  await check('Failed or malformed initial loading can retry without publishing partial rows',async h=>{
    let invalid=true;h.override(async path=>path==='/api/pdf-covers'&&invalid?h.response({items:[{kind:'bad',label:'Invalid'}]}):undefined);
    await h.api.open();assert.equal(h.host.children.length,0);assert.match(h.status.textContent,/Open Settings again/);assert.equal(h.api.hasPendingOperation(),false);
    invalid=false;await h.api.open();assert.equal(h.host.children.length,2);
  },{open:false});
  await check('A shared in-flight initial open cannot race duplicate table loads',async h=>{
    const held=deferred();h.override(async path=>path==='/api/pdf-covers'?held.promise:undefined);const first=h.api.open(),second=h.api.open();await flush();
    assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.calls.length,1);held.resolve(h.response({items:[...h.records.values()].map(h.metadata)}));await Promise.all([first,second]);assert.equal(h.host.children.length,2);
  },{open:false});
  console.log(checks+' cover-sheet UI checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
