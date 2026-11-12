// Project-scoped document history, immutable links and late-reply protection.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
const token=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const project=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const identity=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const PDF='application/pdf',XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const model=(n,items=[],revision=items.length)=>({workspace_id:token(n),project_id:project(n),workspace_revision:revision,items});
const item=(n,scope=1,values={})=>({id:identity(n),kind:'estimate.summary.pdf',label:'Estimate Summary',filename:'Estimate-Revision-'+n+'.pdf',revision:n,
  media_type:PDF,created_at:'2026-10-30T01:00:00Z',url:'/api/documentation/'+identity(n)+'?workspace='+token(scope),...values});
const catalog=[{id:'estimate.summary.pdf',label:'Breakdown',format:'pdf',adapter:'estimate',spec:{action:'summary'}},
  {id:'calculator.ductwork.register.xlsx',label:'Ductwork Register',format:'xlsx',adapter:'calculator',spec:{calculatorId:'ductwork',action:'register'}},
  {id:'firestopping.current_item.pdf',label:'Firestopping Item Details',format:'pdf',adapter:'firestopping',spec:{scope:'current_item',format:'pdf'}},
  {id:'firestopping.current_item.xlsx',label:'Firestopping Item Details',format:'xlsx',adapter:'firestopping',spec:{scope:'current_item',format:'xlsx'}},
  {id:'library.technical.item.pdf',label:'Technical Library item',format:'pdf',adapter:'library',spec:{source:'technical',format:'pdf'}},
  {id:'library.technical.item.xlsx',label:'Technical Library item',format:'xlsx',adapter:'library',spec:{source:'technical',format:'xlsx'}},
  {id:'takeoff.pdf_tools.pdf',label:'PDF tools',format:'pdf',adapter:'takeoff',spec:{action:'pdf_tools'}}];
function harness(){
  const elements=new Map(),calls=[],events={},adapters=[];let selected=1,serial=20,changed=0,override=null,adapterOverride=null,created=true;
  const models=new Map([[token(1),model(1)],[token(2),model(2)]]);
  function element(tag){return {tagName:tag.toUpperCase(),children:[],textContent:'',dataset:{},attributes:{},listeners:{},disabled:false,
    classList:{values:new Set(),toggle(name,on){if(on)this.values.add(name);else this.values.delete(name);}},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},
    focus(){this.focused=true;},addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},async emit(name,event={}){for(const fn of this.listeners[name]||[])await fn(event);await flush();}};}
  const byId=id=>{if(!elements.has(id))elements.set(id,element('div'));return elements.get(id);};
  const response=(value,status=200)=>({ok:status===200,status,json:async()=>copy(value)});
  const fetch=async(path,options={})=>{calls.push({path,options});if(override){const value=await override(path,options);if(value!==undefined)return value;}
    if(path==='/api/documentation/catalog')return response({documents:catalog});
    const query=new URL(path,'http://fixture').searchParams,workspace=query.get('workspace');
    if(path.startsWith('/api/documentation?')&&models.has(workspace))return response(models.get(workspace));
    return response({error:'Not found'},404);};
  const adapter=(owner)=>async(spec,button)=>{adapters.push({owner,spec:copy(spec),button});return adapterOverride?adapterOverride(owner,spec,button):{saved:true};};
  const window={addEventListener(name,fn){(events[name]||=[]).push(fn);},
    CeasefireCertification:{sessionId:()=>token(selected),projectWorkspace:async()=>({workspace_id:token(selected),project_id:project(selected)})},
    CeasefireProject:{changed(){changed++;},hasCreatedProject:()=>created},CeasefireDocumentationApp:{run:async(owner,spec,button)=>adapter(owner)(spec,button)},
    CeasefireCalculators:{documentationExport:adapter('calculator')},CeasefirePenetrations:{documentationExport:adapter('firestopping')},
    CeasefireLibraryEditor:{documentationExport:adapter('library-editor')},CeasefireLibraries:{documentationExport:adapter('library')},
    CeasefireTakeoffs:{documentationExport:adapter('takeoff')}};
  const context={window,document:{getElementById:byId,createElement:element},fetch,console,Date,JSON,Object,Array,Number,Error,Set,Map,WeakMap,
    crypto:{randomUUID:()=>identity(++serial)}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/documentation.js','utf8'),context);
  const descendants=(host,predicate)=>host.children.filter(child=>typeof child==='object').flatMap(child=>[...(predicate(child)?[child]:[]),...descendants(child,predicate)]);
  return {api:window.CeasefireDocumentation,window,calls,adapters,models,byId,response,events,
    override:fn=>{override=fn;},adapterOverride:fn=>{adapterOverride=fn;},scope:n=>{selected=n;},created:value=>{created=value;},changed:()=>changed,
    links:()=>descendants(byId('documentation-revisions-list'),e=>e.tagName==='A'),
    tableLinks:()=>['pdf','xlsx'].flatMap(fmt=>descendants(byId('documentation-'+fmt+'-rows'),e=>e.tagName==='A')),
    buttons:()=>['pdf','xlsx'].flatMap(fmt=>descendants(byId('documentation-'+fmt+'-rows'),e=>e.tagName==='BUTTON'&&!!e.dataset.documentKind)),
    revisions:kind=>['pdf','xlsx'].flatMap(fmt=>descendants(byId('documentation-'+fmt+'-rows'),e=>e.tagName==='BUTTON'&&e.dataset.revisionsKind===kind))[0],
    select:()=>descendants(byId('documentation-xlsx-rows'),e=>e.tagName==='SELECT')[0],
    adopt:n=>{selected=n;window.CeasefireDocumentation.applyProject({scope:{workspace_id:token(n),project_id:project(n)},model:copy(models.get(token(n)))});}};
}
let passed=0;
async function check(name,fn){await fn(harness());passed++;console.log('ok - '+name);}
(async()=>{
  await check('Documentation rejects unsaved access while initial project capture remains possible',async h=>{
    h.created(false);await assert.rejects(h.api.open(),/Create or load a project/);assert.equal(h.calls.length,0);
    assert.deepEqual(copy(await h.api.downloadHeaders('/api/quote-report')),{});assert.equal(h.calls.length,0);
    const capture=await h.api.completeProjectSnapshot();assert.equal(capture.expected_revision,0);
    h.created(true);await h.api.open();const first=h.buttons()[0];h.created(false);await first.emit('click');
    assert.equal(h.adapters.length,0);assert.match(h.byId('documentation-status').textContent,/Create or load a project/);
  });
  await check('Both document tables place their download action after names and revision history',async h=>{
    const html=fs.readFileSync('static/index.html','utf8');
    const tables=[...html.matchAll(/<table class="documentation-table([^"]*)"><thead><tr>(.*?)<\/tr><\/thead>/g)];
    assert.equal(tables.length,2);
    for(const [,extra,head] of tables)assert.deepEqual([...head.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(match=>match[1]),['Document','Previous revisions','Download',...(extra.includes('documentation-pdf-table')?['PDF cover sheet','Actions']:[])]);
    await h.api.open();
    for(const format of ['pdf','xlsx'])for(const row of h.byId('documentation-'+format+'-rows').children.filter(row=>row.dataset.documentKind)){
      assert.equal(row.children[2].className,'documentation-action');
      const button=h.buttons().find(control=>control.dataset.documentKind===row.dataset.documentKind);
      const icon=button.children[0];
      assert.equal(icon.className,'download-format-icon');
      assert.equal(icon.attributes['aria-hidden'],'true');
      assert.deepEqual(icon.children.map(child=>[child.className,child.textContent]),[['download-arrow','⇩'],['download-format',format.toUpperCase()]]);
    }
  });
  await check('PDF schedules and product summaries are grouped without changing export identities or frozen history',async h=>{
    const rows=[catalog[0],
      {id:'calculator.ductwork.product_summary.pdf',label:'Ductwork product summary',format:'pdf',adapter:'calculator',spec:{calculatorId:'ductwork',action:'product_summary'}},
      {id:'project.full_schedule.pdf',label:'Full Schedule',format:'pdf',adapter:'estimate',spec:{action:'full_schedule'}},
      {id:'certification',label:'Installation Certificate',format:'pdf',adapter:'certification',spec:{}},
      {id:'project.full_product_summary.pdf',label:'Full Product Summary',format:'pdf',adapter:'estimate',spec:{action:'full_product_summary'}},
      {id:'firestopping.schedule.pdf',label:'Firestopping Schedule',format:'pdf',adapter:'firestopping',spec:{scope:'schedule',format:'pdf'}}];
    h.override(path=>path==='/api/documentation/catalog'?h.response({documents:rows}):undefined);
    const legacy=item(1,1,{kind:'calculator.legacy.schedule.pdf',label:'Legacy schedule'});h.models.set(token(1),model(1,[legacy]));
    await h.api.open();
    const rendered=h.byId('documentation-pdf-rows').children;
    assert.deepEqual(rendered.filter(row=>row.children[0].tagName==='TH').map(row=>row.children[0].children[0].children[0].textContent),['Schedules','Product summaries','Other documents']);
    assert.deepEqual(rendered.filter(row=>row.dataset.documentKind).map(row=>row.dataset.documentKind),['project.full_schedule.pdf','firestopping.schedule.pdf','calculator.legacy.schedule.pdf','calculator.ductwork.product_summary.pdf','project.full_product_summary.pdf','estimate.summary.pdf','certification']);
    const toggle=rendered[0].children[0].children[0].children[0];
    assert.equal(toggle.attributes['aria-expanded'],'false');assert.equal(rendered[1].hidden,true);
    await toggle.emit('click');assert.equal(toggle.attributes['aria-expanded'],'true');assert.equal(rendered[1].hidden,false);
    assert.deepEqual(h.links(),[]);assert.deepEqual(h.tableLinks(),[]);
    await h.revisions(legacy.kind).emit('click');assert.deepEqual(h.links().map(link=>link.href),[legacy.url]);
    const first=rendered.find(row=>row.dataset.documentKind==='estimate.summary.pdf');assert.equal(first.children.length,3);assert.equal(first.children[0].textContent,'Breakdown');assert.equal(first.hidden,true);
    assert.equal(first.children[1].children[0].textContent,'View Revisions (0)');
    assert.equal(first.children[2].className,'documentation-action');
    assert.ok(rendered.filter(row=>row.children[0].tagName==='TH').every(row=>row.children[0].colSpan===5));
    assert.equal(h.buttons().find(button=>button.dataset.documentKind===legacy.kind).disabled,true);
    await h.buttons().find(button=>button.dataset.documentKind==='project.full_product_summary.pdf').emit('click');
    assert.equal(h.adapters[0].owner,'estimate');assert.deepEqual(h.adapters[0].spec,{action:'full_product_summary'});
  });
  await check('Catalog separates PDF and XLSX and displays exact project-scoped immutable revision links',async h=>{
    h.models.set(token(1),model(1,[item(1),item(2,1,{kind:'calculator.ductwork.register.xlsx',media_type:XLSX,filename:'Ductwork.xlsx'})]));
    await h.api.open();assert.equal(h.byId('documentation-pdf-rows').children.length,2);assert.equal(h.byId('documentation-xlsx-rows').children.length,4);
    assert.deepEqual(h.tableLinks(),[]);await h.revisions('estimate.summary.pdf').emit('click');assert.deepEqual(h.links().map(link=>link.href),[item(1).url]);
    await h.revisions('calculator.ductwork.register.xlsx').emit('click');assert.deepEqual(h.links().map(link=>link.href),[item(2).url]);assert.ok(h.links().every(link=>link.target==='_blank'&&link.rel==='noopener'));
    assert.equal(h.api.hasProjectChanges(),false);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('Removed PDF rows stay absent with saved revisions while XLSX choices and project history survive',async h=>{
    const kinds=['firestopping.current_item.pdf','library.technical.item.pdf','takeoff.pdf_tools.pdf'];
    const history=kinds.map((kind,index)=>item(index+1,1,{kind}));
    h.models.set(token(1),model(1,history));await h.api.open();
    const rows=h.byId('documentation-pdf-rows').children.map(row=>row.dataset.documentKind).filter(Boolean);
    assert.deepEqual(rows,['estimate.summary.pdf']);assert.deepEqual(h.links(),[]);
    assert.ok(h.buttons().some(button=>button.dataset.documentKind==='firestopping.current_item.xlsx'));
    assert.ok(h.buttons().some(button=>button.dataset.documentKind==='library.technical.item.xlsx'));
    const prepared=await h.api.prepareProject(null,token(1));
    assert.deepEqual(copy(prepared.model.items),history);
    const snapshot=await h.api.completeProjectSnapshot();assert.equal(snapshot.expected_revision,3);
  });
  await check('Malformed revision identities and URLs cannot become links or replace a prepared project',async h=>{
    await h.api.open();const before=h.api.projectFingerprint();
    for(const url of ['https://foreign.invalid/file.pdf','javascript:alert(1)',item(1,2).url,item(1).url+'&extra=1','/api/documentation/'+identity(8)+'?workspace='+token(1)]){
      h.models.set(token(1),model(1,[item(1,1,{url})]));await assert.rejects(h.api.prepareProject(null,token(1)),/invalid identity or link/);
      assert.equal(h.api.projectFingerprint(),before);assert.deepEqual(h.links(),[]);
    }
    for(const bad of [{id:'not-an-id'},{revision:0},{media_type:'text/html'},{filename:'x'.repeat(256)}]){
      h.models.set(token(1),model(1,[item(1,1,bad)]));await assert.rejects(h.api.prepareProject(null,token(1)),/invalid identity or link/);
    }
  });
  await check('Invalid workspace and mismatched saved manifest are rejected before adoption',async h=>{
    await assert.rejects(h.api.prepareProject(null,'../other'),/workspace is invalid/);assert.equal(h.calls.length,0);
    await assert.rejects(h.api.prepareProject({project_id:project(2),revision_count:0},token(1)),/does not match/);
    await assert.rejects(h.api.prepareProject({project_id:project(1),revision_count:1},token(1)),/does not match/);
    const duplicate=item(1);h.models.set(token(1),model(1,[duplicate,duplicate]));await assert.rejects(h.api.prepareProject(null,token(1)),/invalid identity or link/);
  });
  await check('An old initial history reply cannot overwrite a newly adopted project',async h=>{
    const held=deferred();h.override(path=>path==='/api/documentation?workspace='+token(1)?held.promise:undefined);
    const opening=h.api.open();await flush();assert.equal(h.api.hasPendingOperation(),true);h.adopt(2);const fingerprint=h.api.projectFingerprint();
    held.resolve(h.response(model(1,[item(1)])));await assert.rejects(opening,/project changed/);
    assert.equal(h.api.projectFingerprint(),fingerprint);assert.deepEqual(h.links(),[]);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('A late refresh reply cannot overwrite the next project or its saved baseline',async h=>{
    await h.api.open();const held=deferred();h.override(path=>path==='/api/documentation?workspace='+token(1)?held.promise:undefined);
    const old=h.api.open();await flush();h.adopt(2);const fingerprint=h.api.projectFingerprint();held.resolve(h.response(model(1,[item(1)])));await old;
    assert.equal(h.api.projectFingerprint(),fingerprint);assert.equal(h.api.hasProjectChanges(),false);assert.deepEqual(h.links(),[]);
  });
  await check('Out-of-order refreshes keep the newest history response',async h=>{
    await h.api.open();const older=deferred(),newer=deferred();let count=0;
    h.override(path=>path==='/api/documentation?workspace='+token(1)?(++count===1?older.promise:newer.promise):undefined);
    const first=h.api.open();await flush();const second=h.api.open();await flush();newer.resolve(h.response(model(1,[item(2)])));await second;
    older.resolve(h.response(model(1,[item(1)])));await first;await h.revisions('estimate.summary.pdf').emit('click');assert.deepEqual(h.links().map(link=>link.href),[item(2).url]);assert.equal(h.api.hasProjectChanges(),true);
  });
  await check('Only actual supported export paths acquire project recording headers',async h=>{
    for(const path of ['/api/calculars/invalid','/api/quote-report?foreign=1','https://foreign.invalid/api/quote-report','/api/documentation/catalog','/api/calculators/unknown/report.pdf','/api/takeoffs/sessions/a/export/csv']){
      assert.deepEqual(copy(await h.api.downloadHeaders(path)),{});assert.equal(h.api.hasPendingOperation(),false);
    }
    assert.equal(h.calls.length,0);
    for(const path of ['/api/quote-report','/api/pricing/export','/api/calculators/ductwork/register.xlsx','/api/penetration/report.pdf','/api/technical/item.pdf','/api/takeoffs/sessions/a/pdf-tools']){
      const headers=await h.api.downloadHeaders(path);assert.equal(headers['X-Estimator-Documentation-Workspace'],token(1));assert.match(headers['X-Estimator-Documentation-Request'],/^30000000-/);
      assert.equal(h.api.hasPendingOperation(),true);await h.api.downloadCompleted(headers,{saved:true});assert.equal(h.api.hasPendingOperation(),false);
    }
  });
  await check('Pending export blocks project capture until its matching completion refreshes history',async h=>{
    await h.api.open();const headers=await h.api.downloadHeaders('/api/quote-report');
    await assert.rejects(h.api.completeProjectSnapshot(),/Finish the current document download/);
    await h.api.downloadCompleted({'X-Estimator-Documentation-Request':identity(999)},{saved:true});assert.equal(h.api.hasPendingOperation(),true);
    h.models.set(token(1),model(1,[item(1)]));await h.api.downloadCompleted(headers,{saved:true});assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasProjectChanges(),true);
    const captured=await h.api.completeProjectSnapshot();assert.deepEqual(copy(captured),{workspace_id:token(1),expected_revision:1});
    h.api.markProjectSaved({project_id:project(1),revision_count:1},captured);assert.equal(h.api.hasProjectChanges(),false);
  });
  await check('Completion from a prior project never refreshes the new project with the old capability',async h=>{
    await h.api.open();const headers=await h.api.downloadHeaders('/api/pricing/export');h.adopt(2);const calls=h.calls.length;
    await h.api.downloadCompleted(headers,{saved:true});assert.equal(h.calls.length,calls);assert.equal(h.api.hasPendingOperation(),false);assert.deepEqual(h.links(),[]);
  });
  await check('The export stays pending until its final history reply completes, then captures that exact revision',async h=>{
    await h.api.open();const headers=await h.api.downloadHeaders('/api/quote-report'),held=deferred();
    h.override(path=>path==='/api/documentation?workspace='+token(1)?held.promise:undefined);
    const completion=h.api.downloadCompleted(headers,{saved:true});await flush();assert.equal(h.api.hasPendingOperation(),true);
    await assert.rejects(h.api.completeProjectSnapshot(),/Finish the current document download/);
    held.resolve(h.response(model(1,[item(1)])));await completion;assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasProjectChanges(),true);
    h.override(null);h.models.set(token(1),model(1,[item(1)]));assert.equal((await h.api.completeProjectSnapshot()).expected_revision,1);
  });
  await check('A failed final history read is dirty and cannot accept an old Save receipt until recovery verifies history',async h=>{
    await h.api.open();const captured=await h.api.completeProjectSnapshot(),headers=await h.api.downloadHeaders('/api/pricing/export');
    h.override(path=>path==='/api/documentation?workspace='+token(1)?h.response({error:'Fixture history unavailable'},503):undefined);
    await h.api.downloadCompleted(headers,{saved:true});assert.equal(h.api.hasPendingOperation(),false);assert.equal(h.api.hasProjectChanges(),true);
    assert.match(h.byId('documentation-status').textContent,/history unavailable/);const uncertain=h.api.projectFingerprint();
    h.api.markProjectSaved({project_id:project(1),revision_count:0},captured);assert.equal(h.api.hasProjectChanges(),true);
    await assert.rejects(h.api.completeProjectSnapshot(),/history unavailable/);assert.equal(h.api.projectFingerprint(),uncertain);
    h.override(null);h.models.set(token(1),model(1,[item(1)]));await h.api.open();assert.notEqual(h.api.projectFingerprint(),uncertain);assert.equal(h.api.hasProjectChanges(),true);
    const recovered=await h.api.completeProjectSnapshot();h.api.markProjectSaved({project_id:project(1),revision_count:1},recovered);assert.equal(h.api.hasProjectChanges(),false);
  });
  await check('A stale or forged Save receipt cannot mark newer document revisions saved',async h=>{
    await h.api.open();h.models.set(token(1),model(1,[item(1)]));await h.api.open();const captured=await h.api.completeProjectSnapshot();
    h.models.set(token(1),model(1,[item(1),item(2)]));await h.api.open();h.api.markProjectSaved({project_id:project(1),revision_count:1},captured);assert.equal(h.api.hasProjectChanges(),true);
    h.api.markProjectSaved({project_id:project(1),revision_count:2},{workspace_id:token(1),expected_revision:2});assert.equal(h.api.hasProjectChanges(),true);
    const current=await h.api.completeProjectSnapshot();h.api.markProjectSaved({project_id:project(1),revision_count:2},current);assert.equal(h.api.hasProjectChanges(),false);
  });
  await check('Reviewing old revisions only renders frozen links and performs no generation or mutation requests',async h=>{
    h.models.set(token(1),model(1,[item(1)]));await h.api.open();const before=h.api.projectFingerprint();await h.api.open();
    await h.revisions('estimate.summary.pdf').emit('click');const link=h.links()[0];assert.equal(link.href,item(1).url);assert.equal(Object.keys(link.listeners).length,0);
    assert.equal(h.adapters.length,0);assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));assert.equal(h.api.projectFingerprint(),before);
  });
  await check('Revision counts use actual stored documents, update in the open pane, and reset on project replacement',async h=>{
    h.models.set(token(1),model(1,[item(3),item(9)]));await h.api.open();
    assert.equal(h.revisions('estimate.summary.pdf').textContent,'View Revisions (2)');
    const stale=h.revisions('estimate.summary.pdf');await stale.emit('click');
    assert.equal(h.byId('documentation-revisions-pane').hidden,false);assert.equal(h.links().length,2);
    assert.equal(h.revisions('estimate.summary.pdf').attributes['aria-expanded'],'true');
    assert.equal(h.byId('documentation-revisions-heading').focused,true);
    h.models.set(token(1),model(1,[item(3),item(9),item(12)]));await h.api.open();
    assert.equal(h.revisions('estimate.summary.pdf').textContent,'View Revisions (3)');assert.equal(h.links().length,3);
    await h.byId('documentation-revisions-close').emit('click');assert.equal(h.byId('documentation-revisions-pane').hidden,true);
    assert.equal(h.revisions('estimate.summary.pdf').focused,true);assert.deepEqual(h.links(),[]);
    await h.revisions('calculator.ductwork.register.xlsx').emit('click');assert.equal(h.links().length,0);
    assert.match(h.byId('documentation-revisions-list').children[0].textContent,/No revisions/);
    h.adopt(2);assert.equal(h.byId('documentation-revisions-pane').hidden,true);await stale.emit('click');
    assert.equal(h.byId('documentation-revisions-pane').hidden,true);assert.deepEqual(h.links(),[]);
    assert.equal(h.revisions('estimate.summary.pdf').textContent,'View Revisions (0)');
  });
  await check('Documentation uses the selected existing adapter and retains explicit source preparation',async h=>{
    await h.api.open();h.adapterOverride(()=>({selectionRequired:true}));const select=h.select();select.value='library';await select.emit('change');
    await h.buttons().find(button=>button.dataset.documentKind==='firestopping.current_item.xlsx').emit('click');await flush();
    assert.equal(h.adapters[0].owner,'library-editor');assert.deepEqual(h.adapters[0].spec,{format:'xlsx'});
    assert.match(h.byId('documentation-status').textContent,/Complete the document options/);assert.equal(h.api.hasPendingOperation(),false);
  });
  await check('Failed source export is visible without claiming a saved revision or leaving a pending action',async h=>{
    await h.api.open();h.adapterOverride(()=>{throw Error('The existing calculator rejected the selected inputs.');});
    await h.buttons().find(button=>button.dataset.documentKind==='calculator.ductwork.register.xlsx').emit('click');await flush();
    assert.match(h.byId('documentation-status').textContent,/calculator rejected/);assert.equal(h.api.hasPendingOperation(),false);assert.deepEqual(h.links(),[]);
  });
  console.log(`${passed} Documentation UI checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
