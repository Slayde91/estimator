const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const response = (receipt, extra = {}) => ({ok:true,status:200,headers:{get:()=> 'application/json; charset=utf-8'},json:async()=>receipt,...extra});
const receipt = {saved:true,path:'C:/Projects/One/APPENDIX A (1).pdf',filename:'APPENDIX A (1).pdf',destination:'project'};
let projectToken = 'selected-project', calls = [], next = response(receipt);
const context = {window:{CeasefireProject:{downloadTarget:()=>({project_token:projectToken})}},fetch:(path,options)=>{calls.push({path,...options,body:JSON.parse(options.body)});return Promise.resolve(next);},console};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
let passed = 0;
(async()=>{
  const waiting=deferred();next=waiting.promise;
  const draft={inputs:{CALCULATOR:{B9:7.123456789012345}}};
  const saving=context.window.CeasefireDownloads.save('/api/calculators/steel_board/report.pdf',draft);
  projectToken='later-project';draft.inputs.CALCULATOR.B9=99;
  waiting.resolve(response(receipt));assert.deepEqual(await saving,receipt);
  assert.equal(calls[0].body.download.project_token,'selected-project');assert.equal(calls[0].body.inputs.CALCULATOR.B9,7.123456789012345);
  assert.equal(calls[0].method,'POST');assert.equal(calls[0].headers.Accept,'application/json');passed++;

  projectToken=null;next=response({...receipt,destination:'downloads',path:'D:/Redirected Downloads/APPENDIX A.pdf'});
  const fallback=await context.window.CeasefireDownloads.save('/api/quote-report',{title:'Unsaved'});
  assert.equal(calls.at(-1).body.download.project_token,null);assert.equal(fallback.destination,'downloads');assert.match(fallback.path,/Redirected Downloads/);passed++;

  delete context.window.CeasefireProject;next=response({...receipt,destination:'downloads'});
  await context.window.CeasefireDownloads.save('/api/pricing/export',{});assert.equal(calls.at(-1).body.download.project_token,null);passed++;

  for(const [value,extra,pattern] of [
    [{error:'Project access expired. Reopen it.'},{ok:false,status:400},/Project access expired/],
    [null,{ok:false,status:500,headers:{get:()=> 'text/html'}},/\(500\)/],
    [null,{headers:{get:()=> 'application/pdf'}},/file-save confirmation/],
    [null,{},/did not confirm/],
    [{...receipt,saved:false},{},/did not confirm/],
    [{...receipt,path:''},{},/did not confirm/],
    [{...receipt,filename:null},{},/did not confirm/],
    [{...receipt,destination:'unknown'},{},/did not confirm/],
  ]) {
    next=response(value,extra);await assert.rejects(context.window.CeasefireDownloads.save('/api/quote-report'),pattern);passed++;
  }
  context.fetch=async()=>{throw new Error('Connection unavailable');};
  await assert.rejects(context.window.CeasefireDownloads.save('/api/quote-report'),/Connection unavailable/);passed++;
  console.log(`Download destination UI checks passed: ${passed}`);
})().catch(error=>{console.error(error);process.exitCode=1;});
