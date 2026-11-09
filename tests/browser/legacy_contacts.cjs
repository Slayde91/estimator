'use strict';
// Opt-in legacy fixture path. Sparse historical rows remain importable even
// though explicit New Contact now requires four fields. Use no live storage.
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
async function importLegacyContacts(page,base,records){
 const response=await page.request.get(base+'/api/contacts/directory');assert.equal(response.status(),200);
 const before=await response.json();
 const file=execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c',
  "import base64,json,sys;from io import BytesIO;from openpyxl import Workbook;b=Workbook();s=b.active;s.title='Contacts';fields=['name','phone','company','title','email'];s.append(['Name','Phone','Company','Title','Email']);[s.append([row.get(key,'') for key in fields]) for row in json.loads(sys.argv[1])];out=BytesIO();b.save(out);print(base64.b64encode(out.getvalue()).decode())",JSON.stringify(records)],{encoding:'utf8',windowsHide:true}).trim();
 const imported=await page.request.post(base+'/api/contacts/contacts/import',{data:{version:before.version,filename:'legacy-contacts.xlsx',file}});assert.equal(imported.status(),200,await imported.text());
 const directory=await(await page.request.get(base+'/api/contacts/directory')).json();
 return records.map(record=>{const contact=directory.contacts.find(item=>!before.contacts.some(old=>old.id===item.id)&&item.name===record.name&&item.email===(record.email||''));assert.ok(contact,'Imported legacy Contact '+record.name);return {id:contact.id,contact};});
}
module.exports={importLegacyContacts};
