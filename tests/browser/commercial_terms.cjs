// Presentation-only Terms emphasis over an older native saved Project.
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {clickProjectControl,openProjectSection,fillProjectDetails}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`commercial-terms-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1575,height:1000}});
  const errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/commercial\/(?:save|saved-save|issue|saved-issue)$/.test(new URL(request.url()).pathname))writes.push(request.postDataJSON());});
  const idle=()=>page.waitForFunction(()=>{const value=window.CeasefireDesktop?.status();return value?.ready&&!value.busy;});
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
  await fillProjectDetails(page,{client:'Synthetic terms Company','site-address':'10 Synthetic Terms Road'});
  const firstSave=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');await clickProjectControl(page,'Save');assert.equal((await firstSave).status(),200);await idle();
  // Reuse the real saved certificate manifest/companions, exporting a portable
  // older quote with plain opening text and manually authored inline emphasis.
  const seed=`import json,re,sys,uuid
from pathlib import Path
from estimator.storage import Store
from estimator.project_file import export_project
from estimator.commercial_documents import default_fields
destination=Path(sys.argv[1]);saved=json.loads(destination.read_bytes())
fields=default_fields('quote',saved['estimate'])
body=next(p for p in re.findall(r'<p>(.*?)</p>',fields['terms']) if p.startswith('<b>These terms'))
body=re.sub(r'</?b>','',body).replace('Goods and Services','<i>Goods</i> and <u>Services</u>')
fields['terms']='<p>'+body+'</p><p>Regular custom paragraph marker with <i>custom italic</i> and <strong>authored bold</strong>.</p>'
fields['title']='Legacy terms presentation';fields['lines']=[{'estimate_id':saved.get('active_estimate_id','estimate-1'),'description':'Saved estimate scope','quantity':'1','unit_price':'100'}]
identity=str(uuid.uuid4());document={'id':identity,'kind':'quote','version':1,'status':'Draft','fields':fields,'created_at':'2026-11-01T01:00:00Z','updated_at':'2026-11-01T01:00:00Z','last_number':''}
request={'estimate':saved['estimate'],'calculators':{key:{'inputs':value['inputs'],'schedule_rows':value['schedule_rows']} for key,value in saved['calculators'].items()},'certifications':saved['certifications'],'commercial_documents':{'version':1,'project_id':saved['certifications']['project_id'],'documents':[document],'number_counters':{'quote':0,'work_order':0,'purchase_order':0}}}
if 'estimates' in saved:
    request.update(estimates=[{'id':entry['id'],'name':entry['name'],'workspace':{'estimate':entry['workspace']['estimate'],'calculators':{key:{'inputs':value['inputs'],'schedule_rows':value['schedule_rows']} for key,value in entry['workspace']['calculators'].items()}}} for entry in saved['estimates']],active_estimate_id=saved['active_estimate_id'])
destination.write_bytes(export_project(Store(destination.parent/'terms-seed.sqlite3'),request))
print(json.dumps({'id':identity,'terms':fields['terms']}))`;
  const seeded=JSON.parse(execFileSync(process.env.CEASEFIRE_PYTHON||'python',['-c',seed,info.project],{cwd:root,encoding:'utf8',windowsHide:true}));
  await clickProjectControl(page,'Load');await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();await idle();
  const before=fs.readFileSync(info.project);
  await openProjectSection(page,'quote');const host=page.locator('#commercial-quote-root');
  const preview=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commercial/derive');
  await host.getByRole('button',{name:'Legacy terms presentation',exact:true}).click();assert.equal((await preview).status(),200);
  await host.locator('details.commercial-rich > summary').filter({hasText:'Terms & Conditions'}).click();
  const editor=host.getByRole('textbox',{name:'Terms & Conditions',exact:true}),opening=editor.locator('p').first();
  const emphasis=await opening.evaluate(block=>{const values=[],walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;if(node.textContent.trim())values.push({text:node.textContent,weight:Number(getComputedStyle(node.parentElement).fontWeight)});}return values;});
  assert.ok(emphasis.length);assert.ok(emphasis.every(value=>value.weight>=700),'Every word of the canonical opening is bold');
  await expect(opening.locator('i')).toHaveText('Goods');await expect(opening.locator('u')).toHaveText('Services');
  const custom=editor.locator('p').last();await expect(custom.locator('i')).toHaveText('custom italic');await expect(custom.locator('strong')).toHaveText('authored bold');assert.ok(Number(await custom.evaluate(item=>getComputedStyle(item).fontWeight))<700,'Other authored paragraphs retain regular body weight');
  const fingerprint=await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()));
  assert.equal(fingerprint.editor.fields.terms,seeded.terms);assert.equal(fingerprint.dirty,false);assert.deepEqual(writes,[]);assert.deepEqual(fs.readFileSync(info.project),before);
  await editor.screenshot({path:path.join(output,'legacy-terms-opening.png')});
  await editor.press('Control+End');await page.keyboard.type(' Added by the user.');
  assert.equal(await page.evaluate(()=>JSON.parse(window.CeasefireCommercial.projectFingerprint()).dirty),true);assert.deepEqual(writes,[]);
  const save=page.waitForResponse(response=>/\/api\/commercial\/(?:save|saved-save)$/.test(new URL(response.url()).pathname));
  await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();assert.equal((await save).status(),200);await expect(host.locator('.commercial-message')).toContainText('Document saved.');
  assert.equal(writes.length,1);assert.ok(writes[0].fields.terms.includes('Added by the user.'));assert.ok(writes[0].fields.terms.includes('<i>Goods</i>'));assert.ok(writes[0].fields.terms.includes('<u>Services</u>'));assert.ok(writes[0].fields.terms.includes('<i>custom italic</i>'));assert.ok(writes[0].fields.terms.includes('<strong>authored bold</strong>'));
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:['Older plain Terms opening renders entirely bold','Authored italic/underline/custom paragraph preserved','Read-only opening/scope preview keeps fields, disk and dirty state unchanged','Only explicit user editing plus Save persists display emphasis'],errors},null,2));
  console.log('PASS commercial Terms presentation. '+output);
})().catch(async error=>{console.error(error);console.error(logs);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});})
  .finally(async()=>{await browser?.close();server.kill();});
