'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/commercial-panels.js'),'utf8'),context);
const linked=context.window.ClassifireCommercialDirectory.linkedContacts;
const companies=context.window.ClassifireCommercialDirectory.linkedCompanies;
const rows=value=>JSON.parse(JSON.stringify(value));
const directory={contacts:[{id:'primary',name:'Same name',phone:'111'},{id:'other',name:'Same name',phone:'222'},{id:'employee',name:'Not linked',phone:'333'}]};
test('Primary is first; explicit IDs deduplicate roles without collapsing equal names or including company employees',()=>{
  const result=rows(linked('quote',{details:{contact:'Same name',contact_id:'primary'},billing:{contact_id:'other'}},{contact_id:'primary'},
    {participants:[{id:'primary',kind:'contacts',role:'site_contact'},{id:'other',kind:'contacts',role:'consultant'},{id:'company',kind:'accounts',role:'supplier'}],roles:{site_contact:'Site contact',consultant:'Consultant'}},directory));
  assert.deepEqual(result.map(row=>row.id),['primary','other']);
  assert.deepEqual(result[0].roles,['Primary contact','Site contact']);assert.equal(result[0].phone,'111');
  assert.deepEqual(result[1].roles,['Billing contact','Consultant']);assert.equal(result[1].phone,'222');
});
test('Only recorded merge aliases canonicalize identity; unknown IDs remain visible and cannot edit a same-named contact',()=>{
  const result=rows(linked('work_order',{details:{contact:'Same name',contact_id:'old'}},{contact_id:'old'},
    {participants:[{id:'primary',kind:'contacts',role:'supplier'},{id:'gone',kind:'contacts',role:'consultant',label:'Same name'}]},
    {...directory,identity_aliases:{contacts:{old:'primary'}}}));
  assert.deepEqual(result.map(row=>row.id),['primary','gone']);assert.equal(result[1].contact,null);
  assert.equal(result[1].name,'Same name');assert.equal(result[0].roles.length,2);
});
test('PO cards mirror its supplier and supplier contact and keep the Project client, site and billing contacts out of the pane',()=>{
  const result=rows(linked('purchase_order',{details:{},order:{supplier_contact_id:'other',supplier_email:'override@example.test',site_contact_id:'primary'},billing:{contact_id:'other'}},
    {contact_id:'primary'},{participants:[{id:'other',kind:'contacts',role:'supplier'}]},directory));
  assert.deepEqual(result.map(row=>row.id),['other']);assert.equal(result[0].primary,true);
  assert.deepEqual(result[0].roles,['Supplier contact']);assert.equal(result[0].email,'override@example.test');
  assert.deepEqual(rows(linked('purchase_order',{order:{}},{contact_id:'primary'},null,directory)),[]);
  assert.deepEqual(rows(companies('purchase_order',{order:{}},{account_id:'project',client:'Main'},null,{})),[]);
  assert.deepEqual(rows(companies('purchase_order',{order:{supplier_account_id:'supplier',supplier:'Selected supplier'}},
    {account_id:'project',client:'Main'},null,{})).map(row=>row.id),['supplier']);
});
test('An explicit document Contact differing from the Project primary is retained by ID without changing the primary',()=>{
  const result=rows(linked('quote',{details:{contact_id:'other',contact:'Same name',phone:'Snapshot'}},
    {contact_id:'primary',contact_name:'Same name'},null,directory));
  assert.deepEqual(result.map(row=>row.id),['other','primary']);
  assert.deepEqual(result[0].roles,['Client contact']);assert.deepEqual(result[1].roles,['Project contact']);
});
test('All exact saved-Project Contact roles join the list, but Company affiliation alone never imports employees',()=>{
  const result=rows(linked('quote',{details:{}},{contact_id:'primary'},
    {linked_parties:[{id:'other',kind:'contacts',role:'Supplier contact'},{id:'other',kind:'contacts',role:'Billing contact'},{id:'company',kind:'accounts',role:'Client'}]},directory));
  assert.deepEqual(result.map(row=>row.id),['primary','other']);
  assert.deepEqual(result[1].roles,['Supplier contact','Billing contact']);
});
test('Companies are primary-first and include explicit Project links and employers of linked Contacts by canonical ID',()=>{
  const data={accounts:[{id:'builder',company:'Same company'},{id:'supplier',company:'Same company'},{id:'manual',company:'Manual'}],
    contacts:[{id:'primary',name:'Person',account_id:'builder'},{id:'other',name:'Participant',account_id:'supplier'}],identity_aliases:{accounts:{old:'supplier'}}};
  const result=rows(companies('quote',{details:{account_id:'builder'},billing:{account_id:'old'}},{account_id:'builder',contact_id:'primary'},
    {participants:[{kind:'contacts',id:'other',role:'consultant'},{kind:'accounts',id:'supplier',role:'supplier'}],linked_parties:[{kind:'accounts',id:'manual',role:'Linked company'}]},data));
  assert.deepEqual(result.map(row=>row.id),['builder','supplier','manual']);assert.equal(result[0].primary,true);
  assert.deepEqual(result[1].roles,['Billing company','supplier','Contact company']);
  assert.equal(result[0].name,result[1].name,'Equal display names never merge companies');
});
