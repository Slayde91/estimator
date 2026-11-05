// Exercise the real shared broker with a deterministic clock and controlled
// exporter finalizers. No elapsed time is used as evidence of a native save.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const copy=v=>JSON.parse(JSON.stringify(v));
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
function harness(){
 const timers=new Map(),calls=[],saves=[],failures=[];let serial=0,now=0,busy=false,history=0,complete=null,saveError=null;
 let target={project_token:'initial',project_context:1,project_path:'C:/Projects/project.cf.json'};
 const response=(value,status=200)=>({ok:status===200,status,headers:{get:()=> 'application/json'},json:async()=>value});
 const project={downloadTarget:()=>copy(target),isCurrentDownloadTarget:t=>t?.project_context===target?.project_context&&t?.project_path===target?.project_path,
  changed(){},hasPendingOperation:()=>false,downloadSaveFailed:(...args)=>failures.push(args),
  saveAfterDownload:async captured=>{saves.push({captured:copy(captured),history});if(saveError)throw saveError;target.project_token='rotated';return {saved:true};}};
 const window={CeasefireProject:project,CeasefireCalculators:{hasPendingOperation:()=>busy},CeasefireDocumentation:{
  downloadHeaders:async()=>({record:'exact'}),downloadCompleted:async()=>{if(complete)await complete.promise;history++;}}};
 const c={window,document:{activeElement:null},console,
  setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
  fetch:async(path,options)=>{if(path==='/api/download-progress')return response({token:'progress'});if(path.startsWith('/api/download-progress/'))return response({percent:10,state:'preparing'});
   calls.push({path,body:JSON.parse(options.body)});return response({saved:true,path:'C:/Projects/REPORT.pdf',filename:'REPORT.pdf',destination:'project'});}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),c);const api=window.CeasefireDownloads;
 return {api,project,calls,saves,failures,c,setTarget:v=>target=v,setBusy:v=>busy=v,setComplete:v=>complete=v,setSaveError:v=>saveError=v,
  async tick(ms=50){const until=now+ms;while(true){const entry=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;now=entry[1].at;timers.delete(entry[0]);entry[1].fn();await flush();}now=until;await flush();}};
}
(async()=>{
 let checks=0;
 {
  const h=harness();h.setTarget(null);await assert.rejects(h.api.save('/api/quote-report'),/Save the current project/);await h.tick();
  assert.equal(h.calls.length,0);assert.equal(h.saves.length,0);assert.equal(h.api.hasPendingOperation(),false);checks++;
 }
 {
  const h=harness();h.project.hasPendingOperation=()=>true;
  await assert.rejects(h.api.save('/api/quote-report'),/Finish the current project save/);await h.tick();
  assert.equal(h.calls.length,0);assert.equal(h.saves.length,0);checks++;
 }
 {
  const h=harness(),done=deferred();h.setComplete(done);h.setBusy(true);const operation=h.api.save('/api/quote-report');await flush();
  assert.equal(h.api.hasInFlight(),true);await h.tick(100);assert.equal(h.saves.length,0);
  done.resolve();await operation;assert.equal(h.api.hasUnsavedProjectSave(),true);await h.tick(100);assert.equal(h.saves.length,0);
  h.setBusy(false);await h.tick();assert.deepEqual(h.saves.map(v=>v.history),[1]);assert.equal(h.api.hasUnsavedProjectSave(),false);
  assert.deepEqual(h.calls[0].body.download,{project_token:'initial'});checks++;
 }
 {
  const h=harness();h.setBusy(true);await Promise.all([h.api.save('/api/quote-report'),h.api.save('/api/project/full-schedule.pdf')]);
  await h.tick();assert.equal(h.saves.length,0);h.setBusy(false);await h.tick();assert.equal(h.saves.length,1);assert.equal(h.saves[0].history,2);
  await h.api.save('/api/quote-report');await h.tick();assert.equal(h.saves.length,2);assert.equal(h.calls[2].body.download.project_token,'rotated');checks++;
 }
 {
  const h=harness();let commercialBusy=true;
  h.c.window.CeasefireCommercial={hasPendingOperation:()=>commercialBusy};
  await h.api.save('/api/quote-report');await h.tick();assert.equal(h.saves.length,0);
  commercialBusy=false;await h.tick();assert.equal(h.saves.length,1);checks++;
 }
 {
  const h=harness();await h.api.save('/api/quote-report');h.setTarget({project_token:'other',project_context:2,project_path:'C:/Other/new.cf.json'});await h.tick();
  assert.equal(h.saves.length,0);assert.equal(h.api.hasPendingOperation(),false);checks++;
 }
 {
  const h=harness();h.setSaveError(new Error('Folder is read only'));await h.api.save('/api/quote-report');await h.tick();
  assert.equal(h.saves.length,1);assert.equal(h.failures.length,1);assert.match(h.failures[0][2].message,/read only/);
  assert.equal(h.api.hasUnsavedProjectSave(),true);assert.equal(h.api.hasPendingOperation(),false);await h.tick(500);assert.equal(h.saves.length,1);
  h.api.projectSaved({project_context:1,project_path:'C:/Projects/project.cf.json'});assert.equal(h.api.hasUnsavedProjectSave(),false);checks++;
 }
 {
  const h=harness();h.c.fetch=async path=>path==='/api/download-progress'?{ok:true,json:async()=>({token:'progress'})}:path.startsWith('/api/download-progress/')?{ok:true,json:async()=>({})}:{ok:false,status:400,headers:{get:()=> 'application/json'},json:async()=>({error:'Disk full'})};
  await assert.rejects(h.api.save('/api/quote-report'),/Disk full/);await h.tick();assert.equal(h.saves.length,0);assert.equal(h.api.hasUnsavedProjectSave(),false);checks++;
 }
 console.log(`${checks} post-download project-save checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
