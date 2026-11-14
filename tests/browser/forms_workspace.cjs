'use strict';
const {chromium,expect}=require('@playwright/test');
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const root=path.resolve(__dirname,'../..'), output=path.join(root,'.runtime/browser-qa','forms-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output,'--real-auth'],{cwd:root,windowsHide:true});
let browser,stderr='';
server.stderr.on('data',chunk=>stderr+=chunk);
const ready=new Promise((resolve,reject)=>{
  let stdout='';const timer=setTimeout(()=>reject(Error('Forms fixture timeout '+stderr)),90000);
  server.stdout.on('data',s=>{stdout+=s;if(stdout.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});
  server.on('error',reject);server.once('exit',()=>{clearTimeout(timer);reject(Error(stderr || 'Fixture exited'));});
});
(async()=>{
  const {port}=await ready;assert.notEqual(port,8765);
  const origin='http://127.0.0.1:'+port, issues=[];
  browser=await chromium.launch({headless:true});
  const admin=await browser.newContext({viewport:{width:1350,height:850}}), viewer=await browser.newContext();
  const page=await admin.newPage(), view=await viewer.newPage();
  const owner={name:'Forms manager',email:'forms-admin@example.test',password:'Fixture-manager-password'};
  const reader={name:'Forms reader',email:'forms-reader@example.test',password:'Fixture-reader-password'};
  async function post(ctx,url,body,actor) {
    const res=await ctx.request.post(origin+url,{data:body,headers:actor?{'X-CRM-Member':actor}:{}});
    assert.equal(res.status(),200,await res.text());return res.json();
  }
  for (const p of [page,view]) {p.on('pageerror',e=>issues.push(e.message));p.setDefaultTimeout(15000);}
  await post(admin,'/api/access/setup',owner);
  const me=(await(await admin.request.get(origin+'/api/access/session')).json()).user;
  const worker=await post(admin,'/api/scheduler/members/save',{...reader,role:'worker',active:true,base_rate:'0'},me.id);
  await post(admin,'/api/access/roles',{member_id:worker.id,role:'viewer',version:0},me.id);
  await post(viewer,'/api/access/login',{email:reader.email,password:reader.password});
  async function open(p) {
    await p.goto(origin);await p.waitForFunction(()=>window.CeasefireDesktop?.status().ready);
    await p.locator('#documents-navigation-toggle').hover();
    await p.locator('#documents-navigation-menu [data-document-section=forms]').click();
    await expect(p.locator('#forms-root').getByRole('heading',{name:'Form templates'})).toBeVisible();
  }
  await open(page);
  const forms=page.locator('#forms-root'), b=(name)=>forms.getByRole('button',{name,exact:true});
  await b('Create template').click();await page.getByRole('button',{name:/^Timeline/}).click();
  await forms.getByLabel('Template name',{exact:true}).fill('Site QA inspection');
  await forms.locator('[data-field-type=text]').dragTo(forms.locator('.form-builder-canvas'));
  await forms.getByLabel('Field label',{exact:true}).fill('Inspection site');
  await forms.locator('[data-field-type=date]').click();
  await forms.locator('[data-field-type=table]').click();
  for(let i=0;i<3;i++) await b('Add column').click();
  await b('Preview').click();const preview=page.getByRole('dialog',{name:'Template preview'});
  await expect(preview.getByLabel('Inspection site',{exact:true})).toBeVisible();
  for(const width of [1350,688,360]) {
    await page.setViewportSize({width,height:880});
    const box=await preview.evaluate(d=>({left:d.getBoundingClientRect().left,width:d.getBoundingClientRect().width,
      inner:d.clientWidth,scroll:d.scrollWidth}));
    assert.ok(box.width>=width*.94 && Math.abs(box.left-(width-box.width)/2)<2,JSON.stringify(box));
    assert.ok(box.scroll<=box.inner+1,JSON.stringify(box));
    const scroll=await preview.locator('.form-repeat:has(.form-repeat-table)').evaluate(t=>t.scrollWidth-t.clientWidth);
    if(width===1350) assert.ok(scroll<=1,'Wide desktop should fit the table');
    if(width===360) assert.ok(scroll>1,'Wide table should scroll inside the preview');
  }
  await page.screenshot({path:path.join(output,'form-preview-mobile.png')});
  await page.setViewportSize({width:1350,height:850});
  await page.screenshot({path:path.join(output,'form-preview-desktop.png')});
  await preview.getByRole('button',{name:'Close',exact:true}).click();
  await b('Publish').click();await expect(forms).toContainText('Template published.');
  await b('Back').click();await expect(b('Site QA inspection')).toBeVisible();
  await open(view);const viewRoot=view.locator('#forms-root');
  await expect(viewRoot).not.toContainText('Site QA inspection');await expect(viewRoot.getByRole('button',{name:'Create template'})).toHaveCount(0);
  await b('Edit').click();await b('Settings').click();await forms.getByRole('checkbox',{name:'Viewer',exact:true}).check();
  await b('Save changes').click();await expect(forms).toContainText('Template published.');await b('Back').click();
  await b('Fill out').click();await forms.getByLabel('Inspection site',{exact:true}).fill('QA site, bay A');
  await b('Save draft').click();await expect(forms.getByRole('heading',{name:'Form record'})).toBeVisible();
  await forms.getByLabel('Inspection site',{exact:true}).fill('QA site, bay B');await b('Submit form').click();
  await expect(forms).toContainText('QA site, bay B');await expect(b('Submit form')).toHaveCount(0);
  await b('Back to forms').click();await b('Site QA inspection').click();await b('Version history').click();
  const versions=page.getByRole('dialog',{name:'Version history'});await expect(versions.locator('tbody tr')).toHaveCount(2);
  await versions.getByRole('button',{name:'Compare changes',exact:true}).click();
  const comparison=page.getByRole('dialog',{name:'Changes in version 2'});
  await expect(comparison.getByRole('cell',{name:/viewer/})).toBeVisible();
  await comparison.getByRole('button',{name:'Close',exact:true}).click();
  await versions.getByRole('button',{name:'Close'}).click();await b('Edit template').click();
  await forms.getByLabel('Template name',{exact:true}).fill('Site QA inspection revised');await b('Save changes').click();await expect(forms).toContainText('Template published.');
  await b('Back').click();await b('Form records').click();await b('Site QA inspection').click();
  await expect(forms).toContainText('Template version 2');await expect(forms).toContainText('QA site, bay B');
  await open(view);await expect(viewRoot).toContainText('Site QA inspection revised');
  await expect(viewRoot.getByRole('button',{name:'Fill out'})).toHaveCount(0);
  await viewRoot.getByRole('button',{name:'Form records'}).click();
  await viewRoot.getByRole('button',{name:'Site QA inspection',exact:true}).click();await expect(viewRoot).toContainText('QA site, bay B');
  await b('Back to forms').click();await b('Templates').click();await b('Create template').click();
  await page.getByRole('button',{name:/Build from an outline/}).click();
  const choice=page.getByRole('dialog',{name:'Build from an outline'});await choice.getByLabel('Template name').fill('Daily handover');
  await choice.getByLabel('Field outline').fill('Site\nInspection date\nTable: Tasks | Activity, Hours\nSignature');
  await choice.getByRole('button',{name:'Create editable draft'}).click();
  await expect(forms.locator('[data-field-id]')).toHaveCount(4);
  await forms.locator('.form-builder-field-select').nth(2).click();
  await forms.locator('.form-builder-tabs').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'forms-builder-desktop.png')});
  await page.setViewportSize({width:688,height:884});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(output,'forms-builder.png')});
  await b('Publish').click();await expect(forms).toContainText('Template published.');
  await b('Back').click();
  // Exercise the same calculation and stage checks on the HTTP server as in the live application.
  const tid=crypto.randomUUID(), stages=[{id:'prepare',name:'Preparation',roles:['admin'],
    approval_conditions:[{field_id:'ready',value:'Ready'}]},{id:'review',name:'Inspection review',roles:['admin']}];
  const table={id:'cost',type:'table',label:'Cost',table_mode:'fixed',default:[{qty:3},{qty:4}],columns:[
    {id:'qty',type:'number',label:'Quantity'},{id:'subtotal',type:'formula',label:'Subtotal',formula:'=A1*2'}]};
  const totals={id:'totals',type:'table',label:'Cost summary',table_mode:'fixed',default:[{}],columns:[
    {id:'overall',type:'formula',label:'Grand total',formula:'=SUM(Table1!B$1:B$2)'}]};
  await post(admin,'/api/forms/template/save',{id:tid,version:0,name:'QA approval workflow',status:'published',mode:'workflow',roles:['admin'],
    settings:{stages,summary_cells:[{field_id:'totals',row:0,column_id:'overall'}],orientation:'landscape',header_layout:[{kind:'text',text:'QA header',align:'center'}],footer_layout:[{kind:'form_version',align:'right'}]},
    fields:[table,totals,{id:'ready',type:'choice',label:'Ready for review',options:['Hold','Ready'],default:'Hold'},
      {id:'comment',type:'text',label:'Reviewer notes',stage_id:'review',required:true}]},me.id);
  await open(page);await b('QA approval workflow').click();await expect(forms.getByRole('heading',{name:'QA approval workflow',exact:true})).toBeVisible();await b('Fill out').click();
  await forms.getByLabel('PDF colour theme').selectOption('forest');
  await expect(forms.locator('[data-field-id=subtotal]').first()).toContainText('6');
  await expect(forms.locator('[data-field-id=subtotal]').last()).toContainText('8');
  await expect(forms.locator('[data-field-id=overall]')).toContainText('14');
  await forms.getByLabel('Quantity',{exact:true}).first().fill('5');
  await expect(forms.locator('[data-field-id=subtotal]').first()).toContainText('10');
  await expect(forms.locator('[data-field-id=overall]')).toContainText('18');
  const rejected = page.waitForResponse(r=>r.url().endsWith('/api/forms/entry/approve'));
  await b('Approve stage').click();
  assert.equal((await rejected).ok(),false);
  await expect(forms.getByLabel('Ready for review')).toHaveValue('Hold');
  await expect(forms.getByLabel('PDF colour theme')).toHaveValue('forest');
  await forms.getByLabel('Ready for review').selectOption('Ready');
  await b('Approve stage').click();await expect(forms).toContainText('Inspection review');
  await forms.getByLabel('Reviewer notes').fill('Reviewed for fixture');await b('Approve stage').click();
  await expect(forms).toContainText('submitted');
  // Intercept the native print dialog and render the same prepared document via Chromium.
  await page.evaluate(()=>{window.print=()=>{};});await b('Print / Save PDF').click();
  await page.emulateMedia({media:'print'});
  await expect(page.locator('.forms-print')).toContainText('QA header');
  await expect(page.locator('.forms-print')).toContainText('Reviewed for fixture');
  await expect(page.locator('.forms-print')).toHaveAttribute('data-pdf-theme','forest');
  await expect(page.locator('.forms-print h2')).toHaveCSS('color','rgb(22, 101, 52)');
  await expect(page.locator('.forms-print [data-field-id=overall]')).toContainText('18');
  await page.pdf({path:path.join(output,'form.pdf'),preferCSSPageSize:true});
  assert.ok(fs.statSync(path.join(output,'form.pdf')).size>1000);
  const pages=JSON.parse(execFileSync(process.env.CEASEFIRE_PYTHON || 'python',['-c',
    'import json,sys; from pypdf import PdfReader; print(json.dumps([[float(p.mediabox.width),float(p.mediabox.height),p.extract_text()] for p in PdfReader(sys.argv[1]).pages]))',
    path.join(output,'form.pdf')],{encoding:'utf8',windowsHide:true}));
  assert.ok(pages.every(([w,h])=>Math.abs(w-842)<2 && Math.abs(h-595)<2),'Expected every PDF page in A4 landscape');
  assert.match(pages.map(p=>p[2]).join(' '),/Form\s+version\s+\d+/);
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await page.emulateMedia({media:'screen'});
  await b('Reopen previous stage').click();await page.getByRole('dialog').getByRole('button',{name:'Reopen stage',exact:true}).click();
  await expect(forms.getByLabel('Reviewer notes')).toHaveValue('Reviewed for fixture');
  await expect(forms).toContainText('Reopened stage');
  await b('Print / Save PDF').click();
  await page.emulateMedia({media:'print'});
  await expect(page.locator('.forms-print')).toContainText('Reopened stage');
  await expect(page.locator('.forms-print')).toHaveAttribute('data-pdf-theme','forest');
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await page.emulateMedia({media:'screen'});
  await b('Back to forms').click();await b('Templates').click();await b('QA approval workflow').last().click();
  await expect(forms.getByRole('columnheader',{name:'Cost summary · Grand total (row 1)'})).toBeVisible();
  await expect(forms.getByRole('cell',{name:'18',exact:true})).toBeVisible();
  assert.deepEqual(issues,[]);console.log('Forms browser checks passed. '+output);
})().catch(error=>{console.error(error,stderr);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
