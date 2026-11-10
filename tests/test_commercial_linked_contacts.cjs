'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/commercial-panels.js'),'utf8'),context);
const linked=context.window.ClassifireCommercialDirectory.linkedContacts;
const rows=value=>JSON.parse(JSON.stringify(value));
const directory={contacts:[{id:'primary',name:'Same name',phone:'111'},{id:'other',name:'Same name',phone:'222'},{id:'employee',name:'Not linked',phone:'333'}]};
test('Primary is first; explicit IDs deduplicate roles without collapsing equal names or including company employees',()=>{
  const result=rows(linked('quote',{details:{contact:'Old snapshot'},billing:{contact_id:'other'}},{contact_id:'primary'},
    {participants:[{id:'primary',kind:'contacts',role:'site_contact'},{id:'other',kind:'contacts',role:'consultant'},{id:'company',kind:'accounts',role:'supplier'}],roles:{site_contact:'Site contact',consultant:'Consultant'}},directory));
  assert.deepEqual(result.map(row=>row.id),['primary','other']);
  assert.deepEqual(result[0].roles,['Primary contact','Site contact']);assert.equal(result[0].phone,'111');
  assert.deepEqual(result[1].roles,['Billing contact','Consultant']);assert.equal(result[1].phone,'222');
});
test('Only recorded merge aliases canonicalize identity; unknown IDs remain visible and cannot edit a same-named contact',()=>{
  const result=rows(linked('work_order',{details:{contact:'Same name'}},{contact_id:'old'},
    {participants:[{id:'primary',kind:'contacts',role:'supplier'},{id:'gone',kind:'contacts',role:'consultant',label:'Same name'}]},
    {...directory,identity_aliases:{contacts:{old:'primary'}}}));
  assert.deepEqual(result.map(row=>row.id),['primary','gone']);assert.equal(result[1].contact,null);
  assert.equal(result[1].name,'Same name');assert.equal(result[0].roles.length,2);
});
test('PO supplier is primary, with explicit project/site/billing and participant contacts retained once each',()=>{
  const result=rows(linked('purchase_order',{details:{},order:{supplier_contact_id:'other',site_contact_id:'primary'},billing:{contact_id:'other'}},
    {contact_id:'primary'},{participants:[{id:'other',kind:'contacts',role:'supplier'}]},directory));
  assert.deepEqual(result.map(row=>row.id),['other','primary']);assert.equal(result[0].primary,true);
  assert.deepEqual(result[0].roles,['Primary contact','Billing contact','supplier']);
  assert.deepEqual(result[1].roles,['Project contact','Site contact']);
});
test('An explicit document Contact differing from the Project primary is retained by ID without changing the primary',()=>{
  const result=rows(linked('quote',{details:{contact_id:'other',contact:'Same name',phone:'Snapshot'}},
    {contact_id:'primary',contact_name:'Same name'},null,directory));
  assert.deepEqual(result.map(row=>row.id),['primary','other']);
  assert.deepEqual(result[0].roles,['Primary contact']);assert.deepEqual(result[1].roles,['Client contact']);
});
