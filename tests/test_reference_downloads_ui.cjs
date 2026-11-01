const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
function harness({blocked=false, type='application/pdf', ok=true, size=100}={}) {
  const calls=[], urls=[], revoked=[], downloads=[], intervals=[], timers=[];
  const viewer={closed:false,opener:{},location:{replace:value=>calls.push(['view',value])},close(){this.closed=true;}};
  const context={window:{open:()=>{calls.push(['open']);return blocked?null:viewer;},
    CeasefireProject:{downloadTarget(){throw Error('Project Save must not be required');}},
    CeasefireDocumentation:{downloadHeaders(){throw Error('Must not create project history');}},
    CeasefireActivity:{begin:()=>()=>calls.push(['end'])}},
    document:{activeElement:null,body:{append(){}},createElement:()=>({click(){downloads.push(this.download);},remove(){}})},
    fetch:async(path,options)=>{calls.push(['fetch',path,JSON.parse(options.body)]);return {ok,status:ok?200:400,
      headers:{get:()=>type},blob:async()=>({size}),json:async()=>({error:'Actual source validation failed'})};},
    URL:{createObjectURL:blob=>{urls.push(blob);return 'blob:temporary';},revokeObjectURL:url=>revoked.push(url)},
    setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},console};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
  return {api:context.window.CeasefireDownloads,calls,viewer,urls,revoked,downloads,intervals,timers};
}
(async()=>{
  for(const path of ['/api/technical/item.pdf','/api/penetration/item.pdf']){
    const h=harness(),payload={id:'retained-item',download:{project_token:'must-not-leak'}};
    const result=await h.api.save(path,payload);
    assert.equal(result.preview,true);assert.equal(result.destination,'temporary');assert.equal(result.path,undefined);
    assert.deepEqual(h.calls.find(c=>c[0]==='fetch'),['fetch',path,{id:'retained-item'}]);
    assert.deepEqual(h.calls.filter(c=>c[0]==='view'),[['view','blob:temporary']]);
    assert.equal(h.viewer.opener,null);assert.equal(h.revoked.length,0);
    h.viewer.closed=true;h.intervals[0]();assert.deepEqual(h.revoked,['blob:temporary']);
  }
  for(const path of ['/api/technical/item.xlsx','/api/penetration/item.xlsx','/api/pricing/export']){
    const h=harness({type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const result=await h.api.save(path,{configuration:{captured:true}});
    assert.equal(result.destination,'browser');assert.equal(h.downloads.length,1);
    assert.equal(h.calls.some(c=>c[0]==='open'),false);h.timers[0]();assert.deepEqual(h.revoked,['blob:temporary']);
  }
  const blocked=harness({blocked:true});await assert.rejects(blocked.api.save('/api/technical/item.pdf',{}),/Allow a new PDF tab/);
  assert.equal(blocked.calls.some(c=>c[0]==='fetch'),false);
  for(const options of [{ok:false},{type:'text/html'},{size:0}]){
    const h=harness(options);await assert.rejects(h.api.save('/api/technical/item.pdf',{}));assert.equal(h.viewer.closed,true);
  }
  const ordinary=harness();await assert.rejects(ordinary.api.save('/api/calculators/ductwork/report.pdf',{}),/Project Save must not be required/);
  console.log('10 reference export checks passed: unsaved PDF viewing, optional browser downloads, cleanup and failure paths.');
})().catch(error=>{console.error(error);process.exitCode=1;});
