'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(id) { this.id=id; this.value=''; this.files=[]; this.disabled=false; this.hidden=false; this.handlers={}; this.textContent=''; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  async fire(type) { for(const handler of this.handlers[type] || []) await handler({preventDefault(){}}); }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name,value) { this[name]=value; }
}
async function fixture(initial, deferReads=false) {
  const ids=['company-settings-form','company-settings-status','company-logo-preview','company-logo','company-settings-save','company-cover-pdf','company-cover-name','company-cover-delete','company-logo-delete','company-name','company-abn','company-phone','company-email'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
  elements['company-settings-form'].elements=ids.filter(id=>!['company-settings-form','company-settings-status','company-logo-preview','company-cover-name'].includes(id)).map(id=>elements[id]);
  let current={...initial}, requests=[], events=[], pending=[];
  class Reader {
    readAsDataURL(file) {
      const finish=()=>{this.result=file.payload || 'data:application/pdf;base64,JVBERi0='; this.onload();};
      if(deferReads) pending.push(finish); else queueMicrotask(finish);
    }
  }
  class CustomEvent { constructor(type, options){this.type=type;this.detail=options.detail;} }
  const window={CustomEvent,dispatchEvent:event=>events.push(event)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/company-settings.js'),'utf8'),{
    window,document:{getElementById:id=>elements[id]}, FileReader:Reader,
    fetch:async (url,options)=>{
      assert.equal(url,'/api/company-settings');
      if(options){current=JSON.parse(options.body);requests.push(current);}
      return {ok:true,json:async()=>({...current})};
    }, console
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,requests,events,pending,form:elements['company-settings-form']};
}
const original={name:'Company',abn:'123',phone:'456',email:'test@example.test',logo:'data:image/png;base64,bG9nbw==',cover_pdf:'data:application/pdf;base64,b2xk',cover_pdf_name:'Original.pdf'};
(async()=>{
  const qa=await fixture(original);
  assert.equal(qa.elements['company-cover-name'].textContent,'Cover sheet: Original.pdf');
  assert.equal(qa.elements['company-cover-delete'].disabled,false);
  qa.elements['company-cover-pdf'].files=[{name:'New cover.pdf',type:'',size:123,payload:'data:application/octet-stream;base64,bmV3'}];
  await qa.elements['company-cover-pdf'].fire('change');
  assert.equal(qa.elements['company-cover-name'].textContent,'Cover sheet: New cover.pdf');
  assert.equal(qa.elements['company-settings-status'].textContent,'Unsaved changes');
  await qa.form.fire('submit');
  assert.equal(qa.requests[0].cover_pdf,'data:application/pdf;base64,bmV3');
  assert.equal(qa.requests[0].cover_pdf_name,'New cover.pdf');
  assert.equal(qa.requests[0].logo,original.logo);
  assert.equal(qa.elements['company-settings-status'].textContent,'Saved');
  assert.equal(qa.events[0].type,'ceasefire:company-settings-saved');
  assert.deepEqual(Object.keys(qa.events[0].detail),['name']);
  assert.equal(qa.events[0].detail.name,'Company');
  await qa.elements['company-cover-delete'].fire('click');
  assert.equal(qa.elements['company-cover-delete'].disabled,true);
  await qa.form.fire('submit');
  assert.equal(qa.requests[1].cover_pdf,null);
  assert.equal(qa.requests[1].cover_pdf_name,'');
  assert.equal(qa.requests[1].logo,original.logo);

  const invalid=await fixture(original);
  invalid.elements['company-cover-pdf'].files=[{name:'large.pdf',type:'application/pdf',size:10*1024*1024+1}];
  await invalid.elements['company-cover-pdf'].fire('change');
  assert.match(invalid.elements['company-settings-status'].textContent,/10 MB/);
  await invalid.form.fire('submit');
  assert.equal(invalid.requests[0].cover_pdf,original.cover_pdf,'Rejected upload retains the earlier cover');

  const concurrent=await fixture(original,true);
  concurrent.elements['company-cover-pdf'].files=[{name:'next.pdf',type:'application/pdf',size:1}];
  const reading=concurrent.elements['company-cover-pdf'].fire('change');
  assert.equal(concurrent.elements['company-settings-save'].disabled,true);
  assert.equal(concurrent.elements['company-logo'].disabled,true);
  await concurrent.form.fire('submit');
  assert.equal(concurrent.requests.length,0,'Do not save incomplete PDF reads');
  concurrent.pending.shift()(); await reading;
  await concurrent.form.fire('submit');
  assert.equal(concurrent.requests.length,1);
  assert.equal(concurrent.requests[0].cover_pdf_name,'next.pdf');
  console.log('PASS company cover upload, save, remove, legacy logo retention, validation and pending-read controls');
})().catch(error=>{console.error(error);process.exitCode=1;});
