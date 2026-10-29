const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const fieldNames = ['client','project','address','location_area','statement_of_compliance','australian_standards',
  'ncc_clauses','approved_design','additional_standards','other_references','exclusions','materials_manufacturers',
  'fire_resistance_level','name','position','qualification','accreditation'];
const copy = value => JSON.parse(JSON.stringify(value));
const blank = () => Object.fromEntries(fieldNames.map(key => [key, '']));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const flush = async () => { for(let n=0;n<20;n++) await Promise.resolve(); };
function harness() {
  const elements = new Map(), events = {}, calls = [], documents = new Map(), createKeys = new Map(), revisionKeys = new Map();
  let serial = 0, creates = 0, approve = true, routeOverride = null, loseGeneratedReply = false, loseCreatedReply = false;
  const element = tag => ({tagName:tag,value:'',textContent:'',children:[],listeners:{},disabled:false,attributes:{},
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
    if(path==='/api/certifications'&&!body)return response({items:[...documents.values()]});
    if(path==='/api/certifications'){
      if(createKeys.has(body.request_id))return response(createKeys.get(body.request_id));
      const id='00000000-0000-4000-8000-'+String(++creates).padStart(12,'0');
      const doc={id,version:1,fields:copy(body.fields),created_at:'2026-10-29T01:00:00Z',updated_at:'2026-10-29T01:00:00Z',revisions:[]};
      documents.set(id,doc);createKeys.set(body.request_id,copy(doc));if(loseCreatedReply){loseCreatedReply=false;throw Error('Lost committed creation response');}return response(doc);
    }
    const match=path.match(/^\/api\/certifications\/([^/]+)(\/revisions)?$/);
    if(!match)return serverError(404,'Not found');
    const doc=documents.get(decodeURIComponent(match[1]));if(!doc)return serverError(404,'Not found');
    if(!body)return response(doc);
    if(match[2]&&revisionKeys.has(body.request_id))return response({document:doc,revision:revisionKeys.get(body.request_id)});
    if(body.expected_version!==doc.version)return serverError(409,'Certification changed. Reload saved details before saving.');
    doc.fields=copy(body.fields);doc.version++;
    if(match[2]){
      const revision={revision:doc.revisions.length+1,created_at:'2026-10-29T02:00:00Z',sha256:'a'.repeat(64),
        pdf_url:'/api/certifications/'+doc.id+'/revisions/'+(doc.revisions.length+1)+'.pdf'};
      doc.revisions.push(revision);revisionKeys.set(body.request_id,revision);if(loseGeneratedReply){loseGeneratedReply=false;throw Error('Lost committed revision response');}return response({document:doc,revision});
    }
    return response(doc);
  };
  const window = {crypto:{randomUUID:()=> '00000000-0000-4000-8000-'+String(++serial).padStart(12,'0')},
    addEventListener(k,fn){(events[k]||=[]).push(fn);},CeasefireProject:{details:()=>({})},
    CeasefireDialogs:{confirm:async()=>approve},CeasefireActivity:{begin:()=>()=>{}}};
  const context={window,document:{getElementById:byId,createElement:element},fetch,console,Date,JSON,Object,Array,Number,Error,encodeURIComponent};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/certification.js','utf8'),context);
  const api=window.CeasefireCertification;
  return {api,byId,calls,documents,events,field:(key,value)=>{byId('certification-'+key).value=value;},
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
    h.field('project','Local');h.approve(false);await h.byId('certification-new').emit('click');
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
  await check('Initial metadata loading locks edit, New, Save and Generate until its saved document is ready',async h=>{
    const held=deferred();h.override(async(path,body)=>path==='/api/certifications'&&!body?held.promise:undefined);
    const opening=h.api.open();await flush();assert.equal(h.byId('certification-new').disabled,true);
    assert.equal(h.byId('certification-client').disabled,true);assert.equal(h.api.hasPendingOperation(),true);
    await h.save();await h.generate();await h.byId('certification-new').emit('click');
    assert.equal(h.calls.filter(call=>call.body).length,0);
    held.resolve(h.response({items:[]}));await opening;assert.equal(h.api.hasPendingOperation(),false);
    assert.equal(h.byId('certification-client').disabled,false);h.field('project','After metadata');await h.save();
    const id=[...h.documents.keys()][0];assert.equal(h.byId('certification-document').value,id);
    assert.ok(h.byId('certification-document').children.some(option=>option.value===id));
  },{open:false});
  await check('Reopening metadata cannot replace a new certificate or race Save with an older list',async h=>{
    h.field('project','Retained draft');const held=deferred();
    h.override(async(path,body)=>path==='/api/certifications'&&!body?held.promise:undefined);
    const opening=h.api.open();await flush();await h.save();await h.byId('certification-new').emit('click');
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
    h.approve(false);await h.byId('certification-new').emit('click');assert.equal(h.byId('certification-project').value,'Original creation');
  });
  const html=fs.readFileSync('static/index.html','utf8'),app=fs.readFileSync('static/app.js','utf8');
  for(const choiceClass of ['section-navigation-choice','projects-section-card']) {
    const choices=[...html.matchAll(/<button\b[^>]*data-project-section="([^"]+)"[^>]*>/g)].filter(match=>match[0].includes('class="'+choiceClass+'"')).map(match=>match[1]);
    assert.deepEqual(choices,['quotes','certification']);
  }
  assert.ok(html.includes('data-project-section="quotes"'));assert.ok(html.includes('data-project-section="certification"'));
  for(const key of fieldNames)assert.ok(html.includes('id="certification-'+key+'"'));
  const form=html.slice(html.indexOf('<form id="certification-form">'),html.indexOf('</form>',html.indexOf('<form id="certification-form">')));
  assert.ok(form.lastIndexOf('<button')===form.indexOf('<button id="certification-generate"'));
  console.log(passed+' Certification UI regression checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
