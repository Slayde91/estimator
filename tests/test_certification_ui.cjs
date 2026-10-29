const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const fieldNames = ['client','project','address','location_area','statement_of_compliance','australian_standards',
  'ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers',
  'fire_resistance_level','name','position','qualification','accreditation'];
const copy = value => JSON.parse(JSON.stringify(value));
const signature = 'data:image/png;base64,c2lnbmF0dXJl';
const coverData = 'data:application/pdf;base64,JVBERi0x';
const blank = () => Object.fromEntries(fieldNames.map(key => [key, '']));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve(); };
function harness() {
  const elements = new Map(), events = {}, calls = [], documents = new Map(), workspaces=new Map(), createKeys = new Map(), revisionKeys = new Map(), timers = new Map();
  let project={}, defaults={fields:Object.fromEntries(['name','position','qualification','accreditation'].map(key=>[key,''])),signature_image:null,signature_name:'',version:1};
  let serial = 0, creates = 0, approve = true, routeOverride = null, loseGeneratedReply = false, loseCreatedReply = false;
  let canvasData=signature;
  const element = tag => ({tagName:tag,value:'',textContent:'',children:[],listeners:{},disabled:false,attributes:{},files:[],checked:false,open:false,captures:new Set(),width:900,height:270,
    contains(target){return target===this;},querySelector(){return {focus(){}};},
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
    setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];delete this[k];},addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);},
    async emit(k,event={}){event.preventDefault??=()=>{};for(const fn of this.listeners[k]||[])await fn(event);},
    setCustomValidity(value){this.validationMessage=value;},
    getBoundingClientRect(){return {left:0,top:0,width:600,height:180};},
    getContext(){return {clearRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},stroke(){}};},
    toDataURL(){return canvasData;},setPointerCapture(id){this.captures.add(id);},releasePointerCapture(id){this.captures.delete(id);},hasPointerCapture(id){return this.captures.has(id);},
    showModal(){this.open=true;},close(value){this.open=false;this.returnValue=value;void this.emit('close');},
    reportValidity(){if(this.id==='certification-legacy-document')return !!this.value;return fieldNames.every(key=>{const item=byId('certification-'+key);return !item.validationMessage&&(!item.required||item.value.trim());});}});
  const byId = id => { if(!elements.has(id))elements.set(id,{...element('div'),id});return elements.get(id); };
  fieldNames.forEach(key=>byId('certification-'+key));
  const response = value => ({ok:true,status:200,json:async()=>copy(value)});
  const serverError = (status,message) => ({ok:false,status,json:async()=>({error:message})});
  const fetch = async (url, options={}) => {
    const [path,query='']=url.split('?'),workspace=new URLSearchParams(query).get('workspace');
    const scopedDocuments=workspace?workspaces.get(workspace)?.documents:documents;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({path,url,workspace,body});
    if(routeOverride){const value=await routeOverride(path,body);if(value!==undefined)return value;}
    if(path==='/api/company-settings')return response({name:'EXAMPLE & Sons'});
    if(path==='/api/certifications/workspaces'){
      const token='workspace-'+(++serial),value={workspace_id:token,project_id:'project-'+serial,items:[],draft:null,snapshot:{version:1},documents:new Map(),imports:new Map()};
      workspaces.set(token,value);return response({...value,documents:undefined});
    }
    const workspaceRoute=path.match(/^\/api\/certifications\/workspaces\/([^/]+)(\/discard)?$/);
    if(workspaceRoute){const value=workspaces.get(workspaceRoute[1]);if(!value)return serverError(404,'Workspace not found');if(workspaceRoute[2]){workspaces.delete(workspaceRoute[1]);return response({discarded:true});}return response({...value,items:[...value.documents.values()],documents:undefined});}
    if(path==='/api/certifications/legacy')return response({items:[...documents.values()]});
    const importing=path.match(/^\/api\/certifications\/workspaces\/([^/]+)\/import$/);
    if(importing){const value=workspaces.get(importing[1]),source=documents.get(body.document_id);if(!source)return serverError(404,'Not found');
      if(value.imports.has(source.id))return response({document:value.documents.get(value.imports.get(source.id)),already_imported:true});
      const doc={...copy(source),id:'imported-'+(++serial)};doc.revisions.forEach(revision=>{revision.pdf_url='/api/certifications/'+doc.id+'/revisions/'+revision.revision+'.pdf?workspace='+importing[1];});value.documents.set(doc.id,doc);value.imports.set(source.id,doc.id);return response({document:doc,already_imported:false});}
    if(path==='/api/certifications/defaults'){
      if(!body)return response(defaults);
      const image=Object.hasOwn(body,'signature_image')?body.signature_image:(defaults.signature_image||null),imageName=Object.hasOwn(body,'signature_name')?body.signature_name:(defaults.signature_name||'');
      const same=JSON.stringify(body.fields)===JSON.stringify(defaults.fields)&&image===(defaults.signature_image||null)&&imageName===(defaults.signature_name||'');
      if(body.expected_version!==defaults.version&&!same)return serverError(409,'Signer details changed');
      if(!same)defaults={fields:copy(body.fields),signature_image:image,signature_name:imageName,version:defaults.version+1};
      return response(defaults);
    }
    if(path==='/api/certifications'&&!body)return response({items:[...scopedDocuments.values()]});
    if(path==='/api/certifications'){
      if(createKeys.has(body.request_id))return response(createKeys.get(body.request_id));
      const id='00000000-0000-4000-8000-'+String(++creates).padStart(12,'0');
      const doc={id,version:1,fields:copy(body.fields),options:copy(body.options||{cover_pdf:null,cover_pdf_name:'',scopes:[]}),created_at:'2026-10-29T01:00:00Z',updated_at:'2026-10-29T01:00:00Z',revisions:[]};
      scopedDocuments.set(id,doc);createKeys.set(body.request_id,copy(doc));if(loseCreatedReply){loseCreatedReply=false;throw Error('Lost committed creation response');}return response(doc);
    }
    const match=path.match(/^\/api\/certifications\/([^/]+)(\/revisions)?$/);
    if(!match)return serverError(404,'Not found');
    const doc=scopedDocuments.get(decodeURIComponent(match[1]));if(!doc)return serverError(404,'Not found');
    if(!body)return response(doc);
    if(match[2]&&revisionKeys.has(body.request_id))return response({document:doc,revision:revisionKeys.get(body.request_id)});
    if(body.expected_version!==doc.version)return serverError(409,'Certification changed. Reload saved details before saving.');
    doc.fields=copy(body.fields);if(body.options)doc.options=copy(body.options);doc.version++;
    if(match[2]){
      const revision={fields:copy(doc.fields),options:copy(doc.options),revision:doc.revisions.length+1,created_at:'2026-10-29T02:00:00Z',sha256:'a'.repeat(64),
        pdf_url:'/api/certifications/'+doc.id+'/revisions/'+(doc.revisions.length+1)+'.pdf?workspace='+workspace};
      doc.revisions.push(revision);revisionKeys.set(body.request_id,revision);if(loseGeneratedReply){loseGeneratedReply=false;throw Error('Lost committed revision response');}return response({document:doc,revision});
    }
    return response(doc);
  };
  const window = {crypto:{randomUUID:()=> '00000000-0000-4000-8000-'+String(++serial).padStart(12,'0')},
    addEventListener(k,fn){(events[k]||=[]).push(fn);},CeasefireProject:{details:()=>copy(project)},
    CeasefireDialogs:{confirm:async()=>approve},CeasefireActivity:{begin:()=>()=>{}}};
  const context={setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),window,document:{getElementById:byId,createElement:element},fetch,console,Date,JSON,Object,Array,Number,Error,encodeURIComponent};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/certification.js','utf8'),context);
  const api=window.CeasefireCertification;
  const fillRequired=()=>fieldNames.slice(0,13).forEach(key=>{const field=byId('certification-'+key);if(!field.value.trim()){field.value='Required fixture '+key;void field.emit('input');}});
  const draw=async()=>{const canvas=byId('certification-signature-canvas');await canvas.emit('pointerdown',{pointerId:7,clientX:30,clientY:50,button:0});await canvas.emit('pointermove',{pointerId:7,clientX:90,clientY:80});await canvas.emit('pointerup',{pointerId:7,clientX:150,clientY:30});};
  return {api,byId,calls,get documents(){return workspaces.get(api.sessionId())?.documents||documents;},legacyDocuments:documents,workspaces,events,fillRequired,draw,canvasData:value=>{canvasData=value;},field:(key,value)=>{byId('certification-'+key).value=value;void byId('certification-'+key).emit('input');},
    project:value=>{project=copy(value);},defaults:()=>copy(defaults),setDefaults:value=>{defaults=copy(value);},window,
    autoSave:async()=>{for(const [id,fn]of timers){timers.delete(id);fn();}await flush();},
    scope:async(ids)=>{for(const id of ['structural_steel','structural_steel_columns','ductwork','service_penetrations'])byId('certification-scope-'+id).checked=ids.includes(id);await byId('certification-scope-'+(ids[0]||'structural_steel')).emit('change');},
    saveSignature:async()=>{await draw();await byId('certification-signature-save').emit('click');},
    generate:()=>{fillRequired();return byId('certification-generate').emit('click');},save:()=>{fillRequired();return byId('certification-save').emit('click');},
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
    assert.equal(links[0].href,'/api/certifications/'+doc.id+'/revisions/1.pdf?workspace='+h.api.sessionId());assert.equal(links[0].target,'_blank');
  });
  await check('Saving a draft does not create a certificate revision',async h=>{
    h.field('project','Draft project');await h.save();assert.equal(h.documents.size,1);
    assert.equal([...h.documents.values()][0].revisions.length,0);assert.equal(h.api.hasUnsavedChanges(),false);
  });
  await check('Repeated generate creates separate immutable revision links on the same page',async h=>{
    h.field('project','A');await h.generate();h.field('exclusions','Revised exclusions');await h.generate();
    const doc=[...h.documents.values()][0];assert.equal(doc.revisions.length,2);
    const rows=h.byId('certification-revisions').children[0].children[1].children;
    assert.equal(rows.length,2);assert.match(rows[0].children[2].children[0].href,/\/2\.pdf\?workspace=/);
    assert.match(rows[1].children[2].children[0].href,/\/1\.pdf\?workspace=/);
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
    h.field('project','Fast document');h.fillRequired();await h.byId('certification-generate').emit('click',{detail:1});
    await h.byId('certification-generate').emit('click',{detail:2});
    assert.equal([...h.documents.values()][0].revisions.length,1);
    await h.byId('certification-generate').emit('click',{detail:1});assert.equal([...h.documents.values()][0].revisions.length,2);
  });
  await check('Initial metadata loading locks edit, dropdown, Save and Generate until defaults are ready',async h=>{
    const held=deferred();h.override(async(path,body)=>path==='/api/certifications'&&!body?held.promise:undefined);
    const opening=h.api.open();await flush();assert.equal(h.byId('certification-document').disabled,true);
    assert.equal(h.byId('certification-client').disabled,true);assert.equal(h.api.hasPendingOperation(),true);
    await h.save();await h.generate();await h.select('');
    assert.equal(h.calls.filter(call=>call.body&&call.path!=='/api/certifications/workspaces').length,0);
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
    const legacy={id:'legacy-document',version:1,fields:{...blank(),client:'Legacy literal client',statement_of_compliance:''},revisions:[]};
    h.documents.set(legacy.id,legacy);await h.select(legacy.id);await h.api.open();
    assert.equal(h.byId('certification-client').value,'Legacy literal client');assert.equal(h.byId('certification-statement_of_compliance').value,'');
  });
  await check('Signature is safely named, saved with signer defaults and snapshotted in document options',async h=>{
    await h.scope(['ductwork']);await h.saveSignature();
    assert.match(h.byId('certification-signature-name').textContent,/Drawn signature\.png/);await h.save();
    const doc=[...h.documents.values()][0];assert.deepEqual(doc.options,{cover_pdf:null,cover_pdf_name:'',scopes:['ductwork'],signature_image:signature,signature_name:'Drawn signature.png'});
    assert.equal(h.defaults().signature_image,signature);assert.equal(h.byId('certification-signature-preview').src,signature);
    assert.equal(h.calls.filter(c=>c.path==='/api/company-settings'&&c.body).length,0);
    await h.byId('certification-signature-delete').emit('click');await h.save();assert.equal(doc.options.signature_image,null);assert.equal(doc.options.signature_name,'');assert.equal(h.defaults().signature_image,null);
  });
  await check('Drawing is explicit, cancels a partial pointer, survives resizing, and clearing preserves the saved signature',async h=>{
    await h.saveSignature();await h.autoSave();const saved=h.defaults().signature_image;
    const canvas=h.byId('certification-signature-canvas');
    await canvas.emit('pointerdown',{pointerId:4,clientX:60,clientY:30,button:0});
    await canvas.emit('pointercancel',{pointerId:4});
    assert.equal(h.byId('certification-signature-save').disabled,true);assert.equal(h.defaults().signature_image,saved);
    await h.draw();const fingerprint=h.api.fingerprint();
    await h.byId('certification-save').emit('click');assert.equal(h.documents.size,0);
    assert.match(h.byId('certification-status').textContent,/Save or clear/);
    h.window.devicePixelRatio=2;h.events.resize[0]();assert.equal(canvas.width,1200);assert.equal(h.api.fingerprint(),fingerprint);
    await h.byId('certification-signature-clear').emit('click');assert.equal(h.defaults().signature_image,saved);
    assert.equal(h.byId('certification-signature-save').disabled,true);assert.equal(h.byId('certification-signature-preview').src,saved);
    await h.draw();h.canvasData('data:image/png;base64,');await h.byId('certification-signature-save').emit('click');
    assert.match(h.byId('certification-status').textContent,/could not be saved/);assert.equal(h.defaults().signature_image,saved);
  });
  await check('Lost creation and generation requests retain the exact signature and scope snapshot across retry',async h=>{
    await h.scope(['structural_steel_columns','service_penetrations']);await h.saveSignature();
    h.loseNextCreatedReply();await h.generate();await h.generate();
    const creates=h.calls.filter(c=>c.path==='/api/certifications'&&c.body);assert.deepEqual(creates[0].body,creates[1].body);
    const doc=[...h.documents.values()][0];assert.equal(doc.revisions.length,1);assert.equal(doc.revisions[0].options.signature_name,'Drawn signature.png');assert.equal(doc.revisions[0].options.signature_image,signature);
    assert.deepEqual(doc.revisions[0].options.scopes,['structural_steel_columns','service_penetrations']);
  });
  await check('Only new certificates inherit N/A fields and a shared signature; old and manually edited values stay literal',async h=>{
    h.setDefaults({fields:{name:'Signer',position:'',qualification:'',accreditation:''},signature_image:signature,signature_name:'Shared.png',version:2});await h.api.open();
    for(const key of ['approved_design','additional_standards','other_references'])assert.equal(h.byId('certification-'+key).value,'N/A');
    assert.equal(h.byId('certification-signature-preview').src,signature);h.field('approved_design','My manual approval text');h.field('additional_standards','');
    await h.api.open();assert.equal(h.byId('certification-approved_design').value,'My manual approval text');assert.equal(h.byId('certification-additional_standards').value,'');
    const old={id:'old-no-signature',version:1,fields:{...blank(),approved_design:'Old design'},options:{cover_pdf:coverData,cover_pdf_name:'Legacy.pdf',scopes:[]},revisions:[]};
    h.documents.set(old.id,old);await h.select(old.id);assert.equal(h.byId('certification-approved_design').value,'Old design');assert.equal(h.byId('certification-additional_standards').value,'');
    assert.equal(h.byId('certification-signature-preview').hidden,true);await h.save();assert.equal(old.options.cover_pdf,coverData);assert.equal(old.options.signature_image,null);
  });
  await check('New certificates and changed projects retain globally saved signer images without altering an old document',async h=>{
    await h.saveSignature();await h.autoSave();await h.save();const old=[...h.documents.values()][0];
    h.project({client:'A new project',site_address:'New address',project_no:'NEW'});await h.select('');assert.equal(h.byId('certification-client').value,'A new project');assert.equal(h.byId('certification-signature-preview').src,signature);
    await h.byId('certification-signature-delete').emit('click');await h.autoSave();await h.select('');assert.equal(h.byId('certification-signature-preview').hidden,true);assert.equal(old.options.signature_image,signature);
  });
  await check('Editing an older unsigned certificate does not implicitly clear the shared future signature',async h=>{
    h.setDefaults({fields:{name:'Shared signer',position:'',qualification:'',accreditation:''},signature_image:signature,signature_name:'Shared.png',version:2});
    const old={id:'older-unsigned',version:1,fields:{...blank(),name:'Old signer'},revisions:[]};h.documents.set(old.id,old);await h.select(old.id);
    assert.equal(h.byId('certification-signature-preview').hidden,true);h.field('name','Updated old signer');await h.autoSave();
    assert.equal(h.defaults().signature_image,signature);assert.equal(h.defaults().signature_name,'Shared.png');
    const post=h.calls.filter(call=>call.path==='/api/certifications/defaults'&&call.body).at(-1);assert.equal(Object.hasOwn(post.body,'signature_image'),false);
    await h.select('');assert.equal(h.byId('certification-signature-preview').src,signature);
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
  await check('All thirteen main fields are required and whitespace cannot Save or Generate',async h=>{
    for(const key of fieldNames.slice(0,13))assert.equal(h.byId('certification-'+key).required,true,key);
    await h.byId('certification-save').emit('click');assert.equal(h.documents.size,0);
    h.fillRequired();h.field('materials_manufacturers',' \n\t');
    await h.byId('certification-generate').emit('click');assert.equal(h.documents.size,0);
    assert.match(h.byId('certification-materials_manufacturers').validationMessage,/Complete all required/);
    h.field('materials_manufacturers','Explicit manufacturer');await h.byId('certification-save').emit('click');
    assert.equal(h.documents.size,1);assert.equal([...h.documents.values()][0].revisions.length,0);
    assert.ok(fieldNames.slice(13).every(key=>h.byId('certification-'+key).value===''));
  });
  await check('Project capture preserves an incomplete draft without creating a certificate and marks only unchanged captures saved',async h=>{
    h.field('location_area','Partial area');const capture=await h.api.completeProjectSnapshot();
    assert.equal(h.documents.size,0);assert.deepEqual(Object.keys(capture.draft.fields),fieldNames);
    assert.equal(capture.draft.fields.australian_standards,'');assert.equal(h.api.hasProjectChanges(),true);
    h.api.markProjectSaved({},capture);assert.equal(h.api.hasProjectChanges(),false);assert.equal(h.api.hasUnsavedChanges(),false);
    const older=await h.api.completeProjectSnapshot();h.field('location_area','New unsaved area');h.api.markProjectSaved({},older);
    assert.equal(h.api.hasProjectChanges(),true);assert.equal(h.api.hasUnsavedChanges(),true);
    await assert.rejects(h.api.prepareProject({version:1}),/Load this saved project through Projects/);
  });
  await check('New and restored projects have isolated lists and cannot load the previous project certificate',async h=>{
    await h.saveSignature();await h.autoSave();h.field('project','PROJECT A');await h.generate();
    const id=[...h.documents.keys()][0],capture=await h.api.completeProjectSnapshot(),tokenA=h.api.sessionId();
    h.workspaces.get(tokenA).draft=copy(capture.draft);h.api.markProjectSaved({},capture);
    const preparedB=await h.api.prepareProject();h.api.applyProject(preparedB);
    assert.notEqual(h.api.sessionId(),tokenA);assert.equal(h.documents.size,0);assert.equal(h.byId('certification-document').children.some(option=>option.value===id),false);
    assert.equal(h.byId('certification-signature-preview').src,signature);await h.select(id);
    assert.equal(h.byId('certification-document').value,'__draft__');assert.match(h.byId('certification-status').textContent,/Not found/);
    h.field('project','PROJECT B');await h.save();assert.equal(h.documents.size,1);
    const restoredA=await h.api.prepareProject({version:1},tokenA);h.api.applyProject(restoredA);await h.api.open();
    assert.equal(h.byId('certification-project').value,'PROJECT A');assert.equal(h.documents.size,1);
    assert.equal(h.byId('certification-document').value,id);assert.equal(h.api.hasProjectChanges(),false);
    const link=h.byId('certification-revisions').children[0].children[1].children[0].children[2].children[0];
    assert.equal(link.href,'/api/certifications/'+id+'/revisions/1.pdf?workspace='+tokenA);
    assert.ok(h.calls.filter(call=>call.path==='/api/certifications'||/^\/api\/certifications\/[^/]+(?:\/revisions)?$/.test(call.path)&&!['/defaults','/workspaces','/legacy'].some(suffix=>call.path.endsWith(suffix))).every(call=>call.workspace));
  });
  await check('Restored unsaved draft text is retained when defaults and estimate details refresh',async h=>{
    const prepared=await h.api.prepareProject();prepared.draft={id:null,version:null,fields:{...blank(),client:'ARCHIVED CLIENT',approved_design:'',location_area:'ARCHIVED AREA'},options:{cover_pdf:null,cover_pdf_name:'',scopes:[]}};
    h.api.applyProject(prepared);h.project({client:'UNRELATED ESTIMATE',project_no:'OTHER',site_address:'OTHER'});await h.api.open();
    assert.equal(h.byId('certification-client').value,'ARCHIVED CLIENT');assert.equal(h.byId('certification-approved_design').value,'');
    assert.equal(h.byId('certification-location_area').value,'ARCHIVED AREA');assert.equal(h.api.hasProjectChanges(),false);
  });
  await check('Uncommitted drawing cannot be silently dropped by project Save or cancelled replacement',async h=>{
    await h.draw();const original=h.api.fingerprint();await assert.rejects(h.api.completeProjectSnapshot(),/Save or clear/);
    h.approve(false);await h.select('');assert.equal(h.api.fingerprint(),original);assert.equal(h.byId('certification-signature-save').disabled,false);
    await h.byId('certification-signature-clear').emit('click');assert.equal((await h.api.completeProjectSnapshot()).draft.options.signature_image,null);
    const pending=deferred();h.override(async path=>path==='/api/certifications'?pending.promise:undefined);
    const saving=h.save();await flush();await assert.rejects(h.api.completeProjectSnapshot(),/Finish the current certificate/);
    pending.resolve(h.serverError(400,'Fixture stopped'));await saving;
  });
  await check('Older certificate recovery requires explicit selection, preserves source revisions and deduplicates repeat imports',async h=>{
    const legacy={id:'old-global-document',version:2,fields:{...blank(),client:'Legacy recovery client'},options:{cover_pdf:null,cover_pdf_name:'',scopes:[]},revisions:[{revision:1,created_at:'2026-10-29T02:00:00Z',pdf_url:'/api/certifications/old-global-document/revisions/1.pdf'}]};
    h.legacyDocuments.set(legacy.id,legacy);const source=copy(legacy);await h.api.open();
    assert.equal(h.byId('certification-document').children.some(option=>option.value===legacy.id),false);
    h.field('location_area','Current unsaved area');await h.byId('certification-legacy-open').emit('click');
    assert.equal(h.byId('certification-legacy-dialog').open,true);assert.equal(h.api.hasPendingOperation(),true);
    h.byId('certification-legacy-document').value=legacy.id;h.approve(false);await h.byId('certification-legacy-import').emit('click');
    assert.equal(h.documents.size,0);assert.equal(h.byId('certification-location_area').value,'Current unsaved area');
    h.approve(true);await h.byId('certification-legacy-import').emit('click');
    assert.equal(h.documents.size,1);assert.equal(h.byId('certification-client').value,'Legacy recovery client');
    assert.equal([...h.documents.values()][0].revisions.length,1);assert.deepEqual(legacy,source);
    assert.equal(h.byId('certification-legacy-dialog').open,false);assert.equal(h.api.hasProjectChanges(),true);
    await h.byId('certification-legacy-open').emit('click');h.byId('certification-legacy-document').value=legacy.id;
    await h.byId('certification-legacy-import').emit('click');assert.equal(h.documents.size,1);assert.deepEqual(legacy,source);
  });
  const html=fs.readFileSync('static/index.html','utf8'),app=fs.readFileSync('static/app.js','utf8');
  for(const choiceClass of ['section-navigation-choice','projects-section-card']) {
    const choices=[...html.matchAll(/<button\b[^>]*data-project-section="([^"]+)"[^>]*>/g)].filter(match=>match[0].includes('class="'+choiceClass+'"')).map(match=>match[1]);
    assert.deepEqual(choices,['quotes','certification']);
  }
  assert.ok(html.includes('data-project-section="quotes"'));assert.ok(html.includes('data-project-section="certification"'));
  const projectsHub=html.match(/<section id="view-projects"[^>]*>[\s\S]*?<\/section>/)?.[0];
  const projectsMenu=html.match(/<div id="projects-navigation-menu"[^>]*>[\s\S]*?<\/div>/)?.[0];
  for(const [name,markup] of [['Projects hub',projectsHub],['Projects navigation menu',projectsMenu]]){
    assert.ok(markup, name+' is present');
    assert.deepEqual([...markup.matchAll(/data-project-section="([^"]+)"/g)].map(match=>match[1]),
      ['quotes','certification'], name+' has exactly its Projects and Certification choices');
  }
  for(const key of fieldNames)assert.ok(html.includes('id="certification-'+key+'"'));
  assert.ok(!html.includes('id="certification-new"'));assert.ok(!html.includes('id="certification-reload"'));
  assert.ok(html.includes('<details id="certification-scopes"'));assert.ok(!html.includes('id="certification-cover-pdf"'));
  assert.ok(!html.includes('id="certification-signature-image"'));assert.ok(html.includes('id="certification-signature-canvas"'));assert.ok(html.includes('id="cover-sheets-settings"'));
  for(const key of ['approved_design','additional_standards','other_references','exclusions','materials_manufacturers','fire_resistance_level','name','position','qualification','accreditation'])assert.match(html,new RegExp('id="certification-'+key+'" name="'+key+'" rows="1"'));
  for(const key of fieldNames.slice(0,13))assert.match(html,new RegExp('<textarea id="certification-'+key+'"[^>]* required>'));
  const form=html.slice(html.indexOf('<form id="certification-form">'),html.indexOf('</form>',html.indexOf('<form id="certification-form">')));
  assert.ok(form.lastIndexOf('<button')===form.indexOf('<button id="certification-generate"'));
  console.log(passed+' Certification UI regression checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
