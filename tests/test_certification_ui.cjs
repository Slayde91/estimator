const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const fieldNames = ['client','project','address','location_area','statement_of_compliance','australian_standards',
  'ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers',
  'fire_resistance_level','name','position','qualification','accreditation'];
const copy = value => JSON.parse(JSON.stringify(value));
const blank = () => Object.fromEntries(fieldNames.map(key => [key, '']));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve(); };
function harness() {
  const elements = new Map(), events = {}, calls = [], documents = new Map(), createKeys = new Map(), revisionKeys = new Map(), timers = new Map(), pendingReads=[];
  let project={}, defaults={fields:Object.fromEntries(['name','position','qualification','accreditation'].map(key=>[key,''])),version:1};
  let serial = 0, creates = 0, approve = true, routeOverride = null, loseGeneratedReply = false, loseCreatedReply = false;
  const element = tag => ({tagName:tag,value:'',textContent:'',children:[],listeners:{},disabled:false,attributes:{},files:[],checked:false,open:false,
    contains(target){return target===this;},querySelector(){return {focus(){}};},
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);},
    async emit(k,event={}){for(const fn of this.listeners[k]||[])await fn(event);},
    reportValidity(){return true;}});
  const byId = id => { if(!elements.has(id))elements.set(id,element('div'));return elements.get(id); };
  fieldNames.forEach(key=>byId('certification-'+key));
  const response = value => ({ok:true,status:200,json:async()=>copy(value)});
  const serverError = (status,message) => ({ok:false,status,json:async()=>({error:message})});
  const fetch = async (path, options={}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({path,body});
    if(routeOverride){const value=await routeOverride(path,body);if(value!==undefined)return value;}
    if(path==='/api/company-settings')return response({name:'EXAMPLE & Sons'});
    if(path==='/api/certifications/defaults'){
      if(!body)return response(defaults);
      if(body.expected_version!==defaults.version&&JSON.stringify(body.fields)!==JSON.stringify(defaults.fields))return serverError(409,'Signer details changed');
      if(JSON.stringify(body.fields)!==JSON.stringify(defaults.fields))defaults={fields:copy(body.fields),version:defaults.version+1};
      return response(defaults);
    }
    if(path==='/api/certifications'&&!body)return response({items:[...documents.values()]});
    if(path==='/api/certifications'){
      if(createKeys.has(body.request_id))return response(createKeys.get(body.request_id));
      const id='00000000-0000-4000-8000-'+String(++creates).padStart(12,'0');
      const doc={id,version:1,fields:copy(body.fields),options:copy(body.options||{cover_pdf:null,cover_pdf_name:'',scopes:[]}),created_at:'2026-10-29T01:00:00Z',updated_at:'2026-10-29T01:00:00Z',revisions:[]};
      documents.set(id,doc);createKeys.set(body.request_id,copy(doc));if(loseCreatedReply){loseCreatedReply=false;throw Error('Lost committed creation response');}return response(doc);
    }
    const match=path.match(/^\/api\/certifications\/([^/]+)(\/revisions)?$/);
    if(!match)return serverError(404,'Not found');
    const doc=documents.get(decodeURIComponent(match[1]));if(!doc)return serverError(404,'Not found');
    if(!body)return response(doc);
    if(match[2]&&revisionKeys.has(body.request_id))return response({document:doc,revision:revisionKeys.get(body.request_id)});
    if(body.expected_version!==doc.version)return serverError(409,'Certification changed. Reload saved details before saving.');
    doc.fields=copy(body.fields);if(body.options)doc.options=copy(body.options);doc.version++;
    if(match[2]){
      const revision={fields:copy(doc.fields),options:copy(doc.options),revision:doc.revisions.length+1,created_at:'2026-10-29T02:00:00Z',sha256:'a'.repeat(64),
        pdf_url:'/api/certifications/'+doc.id+'/revisions/'+(doc.revisions.length+1)+'.pdf'};
      doc.revisions.push(revision);revisionKeys.set(body.request_id,revision);if(loseGeneratedReply){loseGeneratedReply=false;throw Error('Lost committed revision response');}return response({document:doc,revision});
    }
    return response(doc);
  };
  const window = {crypto:{randomUUID:()=> '00000000-0000-4000-8000-'+String(++serial).padStart(12,'0')},
    addEventListener(k,fn){(events[k]||=[]).push(fn);},CeasefireProject:{details:()=>copy(project)},
    CeasefireDialogs:{confirm:async()=>approve},CeasefireActivity:{begin:()=>()=>{}}};
  class FileReader {readAsDataURL(file){this.result=file.dataURL||'data:application/pdf;base64,JVBERi0x';const done=()=>file.fail?this.onerror():this.onload();if(file.hold)pendingReads.push(done);else Promise.resolve().then(done);}}
  const context={FileReader,setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),window,document:{getElementById:byId,createElement:element},fetch,console,Date,JSON,Object,Array,Number,Error,encodeURIComponent};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/certification.js','utf8'),context);
  const api=window.CeasefireCertification;
  return {api,byId,calls,documents,events,field:(key,value)=>{byId('certification-'+key).value=value;void byId('certification-'+key).emit('input');},
    project:value=>{project=copy(value);},defaults:()=>copy(defaults),setDefaults:value=>{defaults=copy(value);},window,
    autoSave:async()=>{for(const [id,fn]of timers){timers.delete(id);fn();}await flush();},
    scope:async(ids)=>{for(const id of ['structural_steel','structural_steel_columns','ductwork','service_penetrations'])byId('certification-scope-'+id).checked=ids.includes(id);await byId('certification-scope-'+(ids[0]||'structural_steel')).emit('change');},
    upload:async(file)=>{byId('certification-cover-pdf').files=[file];await byId('certification-cover-pdf').emit('change');},
    completeFileRead:()=>pendingReads.shift()(),
    generate:()=>byId('certification-generate').emit('click'),save:()=>byId('certification-save').emit('click'),
    select:async id=>{byId('certification-document').value=id;await byId('certification-document').emit('change');},
    approve:value=>{approve=value;},override:fn=>{routeOverride=fn;},loseNextGeneratedReply:()=>{loseGeneratedReply=true;},loseNextCreatedReply:()=>{loseCreatedReply=true;},serverError,response};
}
let passed=0;
async function check(name,fn,{open=true}={}){const h=harness();if(open)await h.api.open();await fn(h);passed++;console.log('ok - '+name);}
(async()=>{
  await check('Blank certificate does not invent standards or qualifications; company wording remains literal text',async h=>{
    await h.api.open();assert.equal(h.byId('certification-australian_standards').value,'');
    assert.equal(h.byId('certification-qualification').value,'');
    assert.match(h.byId('certification-declaration').textContent,/EXAMPLE & Sons are approved/);
    assert.match(h.byId('certification-exclusions-intro').textContent,/completed by EXAMPLE & Sons/);
  });
  await check('Generate saves one document and one revision with all 17 edited fields',async h=>{
    await h.api.open();fieldNames.forEach(key=>h.field(key,'Edited '+key));await h.generate();
    assert.equal(h.documents.size,1);const doc=[...h.documents.values()][0];assert.equal(doc.revisions.length,1);
    assert.deepEqual(Object.keys(doc.fields),fieldNames);assert.equal(h.api.hasUnsavedChanges(),false);
    assert.match(h.byId('certification-status').textContent,/Revision 1 saved/);
    const links=h.byId('certification-revisions').children[0].children[1].children[0].children[2].children;
    assert.equal(links[0].href,'/api/certifications/'+doc.id+'/revisions/1.pdf');assert.equal(links[0].target,'_blank');
  });
  await check('Saving a draft does not create a certificate revision',async h=>{
    h.field('project','Draft project');await h.save();assert.equal(h.documents.size,1);
    assert.equal([...h.documents.values()][0].revisions.length,0);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Repeated generate creates separate immutable revision links on the same page',async h=>{
    h.field('project','A');await h.generate();h.field('exclusions','Revised exclusions');await h.generate();
    const doc=[...h.documents.values()][0];assert.equal(doc.revisions.length,2);
    const rows=h.byId('certification-revisions').children[0].children[1].children;
    assert.equal(rows.length,2);assert.match(rows[0].children[2].children[0].href,/\/2\.pdf$/);
    assert.match(rows[1].children[2].children[0].href,/\/1\.pdf$/);
  });
  await check('Double-click and document switching cannot race a pending generation',async h=>{
    const held=deferred();h.override(async(path)=>path==='/api/certifications'?held.promise:undefined);
    const generation=h.generate();await flush();assert.equal(h.api.hasPendingOperation(),true);
    assert.equal(h.byId('certification-client').disabled,true);await h.generate();await h.select('');
    assert.equal(h.calls.filter(c=>c.path==='/api/certifications'&&c.body).length,1);
    held.resolve(h.serverError(400,'Enter details'));await generation;assert.equal(h.api.hasPendingOperation(),false);
    assert.equal(h.byId('certification-client').disabled,false);
  });
  await check('Unknown generation response retries exactly the same request and expected version',async h=>{
    h.field('project','Retried');await h.save();let fails=true;
    h.override(async path=>{if(path.endsWith('/revisions')&&fails){fails=false;throw Error('Connection lost');}});
    await h.generate();assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.byId('certification-name').disabled,true);
    await h.generate();assert.equal(h.api.hasPendingOperation(),false);
    const requests=h.calls.filter(c=>c.path.endsWith('/revisions'));assert.equal(requests.length,2);
    assert.deepEqual(requests[0].body,requests[1].body);assert.equal([...h.documents.values()][0].revisions.length,1);
  });
  await check('Unknown initial create response retains the same creation key and fields',async h=>{
    h.field('project','Create retry');let fails=true;
    h.override(async path=>{if(path==='/api/certifications'&&fails){fails=false;throw Error('Lost create response');}});
    await h.generate();assert.equal(h.api.hasPendingOperation(),true);await h.generate();
    const requests=h.calls.filter(c=>c.path==='/api/certifications'&&c.body);assert.deepEqual(requests[0].body,requests[1].body);
    assert.equal(h.documents.size,1);assert.equal([...h.documents.values()][0].revisions.length,1);
  });
  await check('Server validation leaves entered text intact and permits correction',async h=>{
    h.field('statement_of_compliance','My unsaved statement');
    h.override(async path=>path==='/api/certifications'?h.serverError(400,'Check the statement'):undefined);
    await h.generate();assert.equal(h.byId('certification-statement_of_compliance').value,'My unsaved statement');
    assert.match(h.byId('certification-status').textContent,/Check the statement/);assert.equal(h.api.hasUnsavedChanges(),true);
    assert.equal(h.byId('certification-statement_of_compliance').disabled,false);
  });
  await check('Conflict does not overwrite the current user draft',async h=>{
    h.field('project','Saved');await h.save();h.field('project','Locally revised');
    h.override(async path=>path.endsWith('/revisions')?h.serverError(409,'Reload saved details'):undefined);
    await h.generate();assert.equal(h.byId('certification-project').value,'Locally revised');
    assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('Cancelled document replacement preserves the unsaved fields',async h=>{
    h.field('project','Local');h.approve(false);await h.select('');
    assert.equal(h.byId('certification-project').value,'Local');
  });
  await check('Late saved-document loading cannot race a second selection',async h=>{
    h.field('project','One');await h.save();const id=[...h.documents.keys()][0],held=deferred();
    h.override(async path=>path.endsWith('/'+id)?held.promise:undefined);
    const a=h.select(id),b=h.select(id);await flush();assert.equal(h.calls.filter(c=>c.path.endsWith('/'+id)).length,1);
    held.resolve(h.response([...h.documents.values()][0]));await Promise.all([a,b]);
    assert.equal(h.byId('certification-project').value,'One');
  });
  await check('Current company name refresh does not alter the edited certificate fields',async h=>{
    h.field('project','Edited project');h.events['ceasefire:company-settings-saved'][0]({detail:{name:'New Company <literal>'}});
    assert.match(h.byId('certification-declaration').textContent,/New Company <literal> are approved/);
    assert.equal(h.byId('certification-project').value,'Edited project');
  });
  await check('Lost committed revision response recovers the same saved revision',async h=>{
    h.field('project','Lost committed response');await h.save();h.loseNextGeneratedReply();await h.generate();
    assert.equal([...h.documents.values()][0].revisions.length,1);assert.equal(h.api.hasPendingOperation(),true);
    await h.generate();assert.equal([...h.documents.values()][0].revisions.length,1);
    assert.equal(h.api.hasPendingOperation(),false);assert.match(h.byId('certification-status').textContent,/Revision 1 saved/);
  });
  await check('Second click in a browser double-click does not create a second fast revision',async h=>{
    h.field('project','Fast document');await h.byId('certification-generate').emit('click',{detail:1});
    await h.byId('certification-generate').emit('click',{detail:2});
    assert.equal([...h.documents.values()][0].revisions.length,1);
    await h.byId('certification-generate').emit('click',{detail:1});assert.equal([...h.documents.values()][0].revisions.length,2);
  });
  await check('Initial metadata loading locks edit, dropdown, Save and Generate until defaults are ready',async h=>{
    const held=deferred();h.override(async(path,body)=>path==='/api/certifications'&&!body?held.promise:undefined);
    const opening=h.api.open();await flush();assert.equal(h.byId('certification-document').disabled,true);
    assert.equal(h.byId('certification-client').disabled,true);assert.equal(h.api.hasPendingOperation(),true);
    await h.save();await h.generate();await h.select('');
    assert.equal(h.calls.filter(call=>call.body).length,0);
    held.resolve(h.response({items:[]}));await opening;assert.equal(h.api.hasPendingOperation(),false);
    assert.equal(h.byId('certification-client').disabled,false);h.field('project','After metadata');await h.save();
    const id=[...h.documents.keys()][0];assert.equal(h.byId('certification-document').value,id);
    assert.ok(h.byId('certification-document').children.some(option=>option.value===id));
  },{open:false});
  await check('Reopening metadata cannot replace a new certificate or race Save with an older list',async h=>{
    h.field('project','Retained draft');const held=deferred();
    h.override(async(path,body)=>path==='/api/certifications'&&!body?held.promise:undefined);
    const opening=h.api.open();await flush();await h.save();await h.select('');
    assert.equal(h.documents.size,0);assert.equal(h.byId('certification-project').value,'Retained draft');
    held.resolve(h.response({items:[]}));await opening;assert.equal(h.byId('certification-project').value,'Retained draft');
    await h.save();const id=[...h.documents.keys()][0];assert.equal(h.byId('certification-document').value,id);
    assert.ok(h.byId('certification-document').children.some(option=>option.value===id));
  });
  await check('Lost creation retry cannot certify over another window edit or discard the original draft silently',async h=>{
    h.field('project','Original creation');h.loseNextCreatedReply();await h.generate();
    const doc=[...h.documents.values()][0];doc.version=2;doc.fields.project='Other window edit';
    await h.generate();assert.equal(doc.fields.project,'Other window edit');assert.equal(doc.revisions.length,0);
    assert.equal(h.byId('certification-project').value,'Original creation');assert.equal(h.api.hasPendingOperation(),false);
    assert.equal(h.api.hasUnsavedChanges(),true);assert.match(h.byId('certification-status').textContent,/Reload/);
    h.approve(false);await h.select('');assert.equal(h.byId('certification-project').value,'Original creation');
  });
  const exactStatement="This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule. All materials have been installed at the above location and comply with:";
  const as1530='AS 1530.4: 2014 Methods for fire tests on building materials, components & structures';
  await check('Fresh form uses Estimates and global signer defaults without auto-loading a recent certificate',async h=>{
    h.project({client:'Current estimate client',site_address:'Current estimate address',project_no:'CF-2042'});
    h.setDefaults({version:3,fields:{name:'Global signer',position:'Director',qualification:'Qualification as entered',accreditation:'Accreditation as entered'}});
    h.documents.set('old-document',{id:'old-document',version:1,fields:{...blank(),client:'Old saved client',statement_of_compliance:'Old saved statement'},revisions:[]});
    await h.api.open();assert.equal(h.byId('certification-client').value,'Current estimate client');
    assert.equal(h.byId('certification-address').value,'Current estimate address');
    assert.equal(h.byId('certification-exclusions').value,'Project No.: CF-2042');
    assert.equal(h.byId('certification-statement_of_compliance').value,exactStatement);
    assert.equal(h.byId('certification-name').value,'Global signer');assert.equal(h.byId('certification-document').value,'__draft__');
    assert.equal(h.calls.filter(c=>c.path==='/api/certifications/old-document').length,0);assert.equal(h.api.hasUnsavedChanges(),false);
  },{open:false});
  await check('Reopening after Estimates changes refreshes only untouched defaults; saved fields remain literal',async h=>{
    h.project({client:'Client one',site_address:'Address one',project_no:'ONE'});await h.api.open();
    h.field('client','My custom certificate client');h.field('statement_of_compliance','My custom statement');
    h.project({client:'Client two',site_address:'Address two',project_no:'TWO'});await h.api.open();
    assert.equal(h.byId('certification-client').value,'My custom certificate client');
    assert.equal(h.byId('certification-address').value,'Address two');assert.equal(h.byId('certification-exclusions').value,'Project No.: TWO');
    assert.equal(h.byId('certification-statement_of_compliance').value,'My custom statement');
    await h.save();h.project({client:'Third',site_address:'Third address',project_no:'THREE'});await h.api.open();
    assert.equal(h.byId('certification-address').value,'Address two');assert.equal(h.byId('certification-exclusions').value,'Project No.: TWO');
  },{open:false});
  await check('Edited signer details auto-save globally and are inherited on New certificate',async h=>{
    for(const key of ['name','position','qualification','accreditation'])h.field(key,'Literal '+key);
    await h.autoSave();assert.deepEqual(h.defaults().fields,{name:'Literal name',position:'Literal position',qualification:'Literal qualification',accreditation:'Literal accreditation'});
    assert.equal(h.documents.size,0);await h.select('');
    assert.equal(h.byId('certification-name').value,'Literal name');assert.equal(h.byId('certification-accreditation').value,'Literal accreditation');
    assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Failed signer persistence retains editable fields and defers Save/New until shared defaults are safe',async h=>{
    h.field('name','Signer kept');h.field('project','Draft kept');
    h.override(async(path,body)=>path==='/api/certifications/defaults'&&body?h.serverError(400,'Preference validation'):undefined);
    await h.autoSave();assert.equal(h.byId('certification-name').disabled,false);assert.equal(h.api.hasPendingOperation(),false);
    assert.match(h.byId('certification-signer-status').textContent,/entries are kept/);await h.select('');
    assert.equal(h.byId('certification-project').value,'Draft kept');await h.save();
    assert.equal(h.documents.size,0);assert.equal(h.byId('certification-name').value,'Signer kept');assert.equal(h.api.hasUnsavedChanges(),true);assert.equal(h.byId('certification-name').disabled,false);
    h.override(null);await h.save();assert.equal(h.defaults().fields.name,'Signer kept');assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Conflicting signer defaults require a fresh version and explicit approval without losing certificate edits',async h=>{
    h.setDefaults({fields:{name:'Other window',position:'',qualification:'',accreditation:''},version:2});
    h.field('name','My signer');await h.autoSave();assert.match(h.byId('certification-signer-status').textContent,/another window/);
    h.approve(false);await h.save();assert.equal(h.defaults().fields.name,'Other window');assert.equal(h.byId('certification-name').value,'My signer');
    h.approve(true);await h.save();assert.equal(h.defaults().fields.name,'My signer');
    const posts=h.calls.filter(c=>c.path==='/api/certifications/defaults'&&c.body);assert.equal(posts.at(-1).body.expected_version,2);
  });
  await check('Scope presets use exact literal lines, stable deduplicated unions and preserve manual additions',async h=>{
    h.field('australian_standards','My additional standard');h.field('ncc_clauses','My additional clause');
    await h.scope(['structural_steel','structural_steel_columns','ductwork','service_penetrations']);
    const standards=h.byId('certification-australian_standards').value.split('\n'),clauses=h.byId('certification-ncc_clauses').value.split('\n');
    assert.deepEqual(standards,[as1530,'AS 4072.1: 2005 Protection of openings in fire-resistant separating elements','My additional standard']);
    assert.deepEqual(clauses,[
      'BCA 2022: C2D9 Lightweight Construction',
      'BCA 2022: C4D17 Columns protected with lightweight construction to achieve an FRL',
      'BCA 2022: Specification 13, Penetration of walls, floors and ceilings by services',
      'BCA 2022: C4D13 Openings in floors and ceilings for services',
      'BCA 2022: C4D15 Openings for service installations',
      'BCA 2022: C4D16 Construction joints','My additional clause']);
    h.field('australian_standards',h.byId('certification-australian_standards').value.replace(as1530,'My edited standard wording'));
    await h.scope([]);assert.equal(h.byId('certification-australian_standards').value,'My edited standard wording\nMy additional standard');
    assert.equal(h.byId('certification-ncc_clauses').value,'My additional clause');
  });
  await check('A manually entered matching standard survives selecting, saving and clearing a scope',async h=>{
    h.field('australian_standards',as1530);await h.scope(['structural_steel']);await h.save();await h.scope([]);
    assert.equal(h.byId('certification-australian_standards').value,as1530);
  });
  await check('Saved scope options do not replace edited standards or legacy saved fields on reopen',async h=>{
    await h.scope(['service_penetrations']);h.field('australian_standards','User-edited standards');await h.save();
    const doc=[...h.documents.values()][0];assert.deepEqual(doc.options.scopes,['service_penetrations']);
    await h.select('');await h.select(doc.id);assert.equal(h.byId('certification-australian_standards').value,'User-edited standards');
    assert.equal(h.byId('certification-scope-service_penetrations').checked,true);
    const legacy={id:'legacy',version:1,fields:{...blank(),client:'Legacy literal client',statement_of_compliance:''},revisions:[]};
    h.documents.set(legacy.id,legacy);await h.select(legacy.id);await h.api.open();
    assert.equal(h.byId('certification-client').value,'Legacy literal client');assert.equal(h.byId('certification-statement_of_compliance').value,'');
  });
  await check('Per-certificate PDF cover is safely named, saved with options and removed without touching company settings',async h=>{
    await h.scope(['ductwork']);await h.upload({name:'<literal cover>.pdf',type:'',size:10,dataURL:'data:application/octet-stream;base64,JVBERi0x'});
    assert.match(h.byId('certification-cover-name').textContent,/<literal cover>\.pdf/);await h.save();
    const doc=[...h.documents.values()][0];assert.deepEqual(doc.options,{cover_pdf:'data:application/pdf;base64,JVBERi0x',cover_pdf_name:'<literal cover>.pdf',scopes:['ductwork']});
    assert.equal(h.calls.filter(c=>c.path==='/api/company-settings'&&c.body).length,0);
    await h.byId('certification-cover-delete').emit('click');await h.save();assert.equal(doc.options.cover_pdf,null);assert.equal(doc.options.cover_pdf_name,'');
  });
  await check('Invalid cover selections retain the prior cover and file reading locks replacement and Save',async h=>{
    await h.upload({name:'valid.pdf',type:'application/pdf',size:10});
    await h.upload({name:'invalid.exe',type:'application/octet-stream',size:10});assert.match(h.byId('certification-cover-name').textContent,/valid.pdf/);
    const upload=h.upload({name:'next.pdf',type:'application/pdf',size:10,hold:true});await flush();
    assert.equal(h.api.hasPendingOperation(),true);assert.equal(h.byId('certification-document').disabled,true);
    await h.save();await h.select('');assert.equal(h.documents.size,0);h.completeFileRead();await upload;
    assert.match(h.byId('certification-cover-name').textContent,/next.pdf/);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('Lost creation and generation requests retain the exact cover and scope snapshot across retry',async h=>{
    await h.scope(['structural_steel_columns','service_penetrations']);await h.upload({name:'retry.pdf',type:'application/pdf',size:10});
    h.loseNextCreatedReply();await h.generate();await h.generate();
    const creates=h.calls.filter(c=>c.path==='/api/certifications'&&c.body);assert.deepEqual(creates[0].body,creates[1].body);
    const doc=[...h.documents.values()][0];assert.equal(doc.revisions.length,1);assert.equal(doc.revisions[0].options.cover_pdf_name,'retry.pdf');
    assert.deepEqual(doc.revisions[0].options.scopes,['structural_steel_columns','service_penetrations']);
  });
  await check('Document conflict recovery works through the Saved certification reload option and respects cancellation',async h=>{
    h.field('project','Saved project');await h.save();h.field('project','Local unsaved project');
    h.override(async path=>path.endsWith('/revisions')?h.serverError(409,'Reload saved details'):undefined);await h.generate();
    assert.ok(h.byId('certification-document').children.some(option=>option.value==='__reload__'));
    h.approve(false);await h.select('__reload__');assert.equal(h.byId('certification-project').value,'Local unsaved project');
    h.approve(true);await h.select('__reload__');assert.equal(h.byId('certification-project').value,'Saved project');assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('A fresh native dropdown keeps New distinct from the current draft so repeated reset remains available',async h=>{
    assert.equal(h.byId('certification-document').value,'__draft__');
    h.field('location_area','First draft');await h.select('');assert.equal(h.byId('certification-location_area').value,'');
    assert.equal(h.byId('certification-document').value,'__draft__');
    assert.ok(h.byId('certification-document').children.some(option=>option.value===''));
    h.field('location_area','Second draft');await h.select('');assert.equal(h.byId('certification-location_area').value,'');
  });
  await check('Unknown saved standard text is preserved conservatively when clearing a reopened scope',async h=>{
    const doc={id:'unknown-saved',version:2,fields:{...blank(),australian_standards:as1530},options:{cover_pdf:null,cover_pdf_name:'',scopes:['structural_steel']},revisions:[]};
    h.documents.set(doc.id,doc);await h.select(doc.id);await h.scope([]);assert.equal(h.byId('certification-australian_standards').value,as1530);
  });
  await check('A language refresh keeps selected scope names through the dynamic summary binding',async h=>{
    const bindings=new Map();h.window.CeasefireI18n={term:source=>({source,args:[]}),translate:source=>'Translated '+source,text:(element,source,args=[])=>{
      const apply=()=>{element.textContent=source.replace(/\{(\d+)\}/g,(_,i)=>typeof args[i]==='function'?args[i]():args[i]??'');};bindings.set(element,apply);apply();
    }};
    await h.scope(['structural_steel','service_penetrations']);
    for(const apply of bindings.values())apply();
    assert.equal(h.byId('certification-scopes-summary').textContent,'Translated Structural steel, Translated Service penetrations');
    for(const handler of h.events['ceasefire:languagechange'])handler();
    assert.match(h.byId('certification-scopes-summary').textContent,/Translated Service penetrations/);
  });
  await check('Scope changes retain manual paragraph spacing and indentation exactly',async h=>{
    const manual='First custom clause.\n\n  Indented second clause.\n\n';h.field('ncc_clauses',manual);
    await h.scope(['service_penetrations']);assert.ok(h.byId('certification-ncc_clauses').value.endsWith(manual));
    await h.scope([]);assert.equal(h.byId('certification-ncc_clauses').value,manual);
  });
  await check('Lost generation replay returning a newer document treats its text as authored',async h=>{
    await h.scope(['structural_steel']);await h.save();h.loseNextGeneratedReply();await h.generate();
    const doc=[...h.documents.values()][0];doc.version=3;doc.fields.other_references='Other window edit';
    await h.generate();assert.equal(h.byId('certification-other_references').value,'Other window edit');
    await h.scope([]);assert.equal(h.byId('certification-australian_standards').value,as1530);
    assert.equal(doc.revisions.length,1);
  });
  await check('An exact acknowledged generation replay retains known local preset ownership',async h=>{
    await h.scope(['structural_steel']);await h.save();h.loseNextGeneratedReply();await h.generate();await h.generate();
    await h.scope([]);assert.equal(h.byId('certification-australian_standards').value,'');
    assert.equal([...h.documents.values()][0].revisions.length,1);
  });
  await check('Scope summary resolves live callback arguments correctly without an i18n runtime',async h=>{
    assert.equal(h.window.CeasefireI18n,undefined);await h.scope(['structural_steel','service_penetrations']);
    assert.equal(h.byId('certification-scopes-summary').textContent,'Structural steel, Service penetrations');
    await h.scope([]);assert.equal(h.byId('certification-scopes-summary').textContent,'Choose…');
  });
  const html=fs.readFileSync('static/index.html','utf8'),app=fs.readFileSync('static/app.js','utf8');
  const projectsHub=html.match(/<section id="view-projects"[^>]*>[\s\S]*?<\/section>/)?.[0];
  const projectsMenu=html.match(/<div id="projects-navigation-menu"[^>]*>[\s\S]*?<\/div>/)?.[0];
  for(const [name,markup] of [['Projects hub',projectsHub],['Projects navigation menu',projectsMenu]]){
    assert.ok(markup, name+' is present');
    assert.deepEqual([...markup.matchAll(/data-project-section="([^"]+)"/g)].map(match=>match[1]),
      ['quotes','certification'], name+' has exactly its Projects and Certification choices');
  }
  for(const key of fieldNames)assert.ok(html.includes('id="certification-'+key+'"'));
  assert.ok(!html.includes('id="certification-new"'));assert.ok(!html.includes('id="certification-reload"'));
  assert.ok(html.includes('<details id="certification-scopes"'));assert.ok(html.includes('id="certification-cover-pdf"'));
  const form=html.slice(html.indexOf('<form id="certification-form">'),html.indexOf('</form>',html.indexOf('<form id="certification-form">')));
  assert.ok(form.lastIndexOf('<button')===form.indexOf('<button id="certification-generate"'));
  console.log(passed+' Certification UI regression checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
