'use strict';
// Native presentation and delivery controls against disposable synthetic storage.
const {chromium,expect:baseExpect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const {chooseCalculator}=require('./calculator_actions.cjs');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','commercial-toolbar-layout-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture startup timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});});
const checks=[],errors=[],geometry=[];
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireProject.hasPendingOperation()&&!document.querySelector('dialog[open],[aria-busy="true"],.commercial-editor-actions button:disabled'));}
async function save(host){const pending=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/commercial/save'&&reply.request().method()==='POST');await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();const reply=await pending;assert.equal(reply.status(),200,await reply.text());await idle();return reply.json();}
async function pdfControl(host,kind){const pdf=host.locator('.commercial-editor-actions').getByRole('button',{name:'Download PDF',exact:true});await expect(pdf).toHaveCount(1);await expect(pdf).toHaveAttribute('title','Download PDF');await expect(pdf).toHaveClass(/icon-only/);await expect(pdf.locator('.download-format-icon')).toHaveAttribute('aria-hidden','true');await expect(pdf.locator('.download-arrow')).toHaveText('⇩');await expect(pdf.locator('.download-format')).toHaveText('PDF');
 await expect(host.getByLabel('Document title',{exact:true})).toHaveCount(0);
 await expect(pdf).toBeEnabled();
 const status=host.locator('.commercial-action-status select');
 if(kind==='quote')await expect(host.locator('.commercial-editor-actions .primary:has(+ .commercial-action-status)')).toHaveText('Create WO');
 await expect(status).toHaveValue('Draft');
 await expect(status).toHaveAccessibleName('Status');
 await expect(host.locator('.commercial-action-status>span')).toBeHidden();
 for(const width of [1515,390]){
   await page.setViewportSize({width,height:1000});
   const box=await pdf.boundingBox();assert.equal(box.width,52);assert.equal(box.height,44);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const statusBox=await status.boundingBox();
   if(width===1515){assert.ok(statusBox.x>box.x);assert.equal(statusBox.y,box.y);}
   {
     const labels=kind==='quote'?['Document date','Project number','Linked Project','Quote No.']:kind==='work_order'?['Document date','Project number','Linked Quote','Work order reference']:['Document date','Project number','Linked Work Order','Purchase Order No.'];
     const [date,second,third,fourth]=await Promise.all(labels.map(label=>host.locator('.commercial-details').getByLabel(label,{exact:true}).locator('..').boundingBox()));
     if(width===1515 && kind!=='purchase_order'){
       assert.equal(date.y,second.y);assert.equal(third.y,fourth.y);assert.ok(third.y>=date.y+date.height);
       assert.equal(date.x,third.x);assert.equal(second.x,fourth.x);
     }else if(width===1515){
       assert.ok([second,third,fourth].every(control=>control.y===date.y));
       assert.ok(date.x<second.x && second.x<third.x && third.x<fourth.x);
     }else assert.ok(date.y<second.y && second.y<third.y && third.y<fourth.y);
   }
   await host.locator('.commercial-details').screenshot({path:path.join(output,kind+'-metadata-'+width+'.png')});
   await host.locator('.commercial-editor-actions').screenshot({path:path.join(output,kind+'-toolbar-'+width+'.png')});
   geometry.push({kind,width,button:box,status:statusBox});
 }
 await page.setViewportSize({width:1515,height:1000});
}

async function appearance(control){return control.evaluate(element=>({background:getComputedStyle(element).backgroundColor,color:getComputedStyle(element).color}));}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1515,height:1000}});page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+info.port);await idle();await createNewProject(page,{client:'Toolbar Company','site-address':'14 Synthetic Toolbar Road'});
 await page.getByRole('button',{name:'Estimates',exact:true}).click();for(const id of ['project-estimate-create','project-estimate-quote','project-estimate-swms'])await expect(page.locator('#'+id)).toHaveCount(0);await expect(page.locator('#project-estimate-new')).toBeVisible();await expect(page.locator('[aria-controls="firestopping-document-actions"]')).toBeVisible();
 checks.push('Estimate keeps its compact inline New shortcut and Document menu without the three removed standalone actions');
 await openProjectSection(page,'quote');let host=page.locator('#commercial-quote-root');await host.getByRole('button',{name:'New Quote',exact:true}).click();await idle();await pdfControl(host,'quote');await save(host);const quoteIssue=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/commercial/issue'&&reply.request().method()==='POST');await host.getByRole('button',{name:'Download PDF',exact:true}).click();const issued=await quoteIssue;assert.equal(issued.status(),200,await issued.text());await idle();const issuedModel=await(await page.request.get(new URL('/api/commercial/state?workspace='+await page.evaluate(()=>window.CeasefireCertification.sessionId()),page.url()).href)).json(),issuedQuote=issuedModel.documents.find(item=>item.kind==='quote'),quoteId=issuedQuote.id;await host.getByRole('button',{name:'Back to Quotes',exact:true}).click();await expect(host.locator('.commercial-card .project-title-button')).toHaveText(issuedQuote.last_number+': Toolbar Company');
 await openProjectSection(page,'work-orders');host=page.locator('#commercial-work-order-root');await host.getByRole('button',{name:'New Work Order',exact:true}).click();await idle();await expect(host.getByLabel('Document title',{exact:true})).toHaveCount(0);await expect(host.locator('.commercial-editor-actions').getByLabel('Status',{exact:true})).toHaveValue('Draft');await pdfControl(host,'work_order');await host.getByLabel('Linked Quote',{exact:true}).selectOption(quoteId);
 const toolbar=await host.locator('.commercial-editor-actions').evaluate(actions=>{const status=actions.querySelector('select').getBoundingClientRect(),pdf=actions.querySelector('.commercial-download-pdf').getBoundingClientRect();return{status:{x:status.x,y:status.y,height:status.height},pdf:{x:pdf.x,y:pdf.y,height:pdf.height}};});assert.ok(toolbar.status.x>toolbar.pdf.x);assert.equal(toolbar.status.y,toolbar.pdf.y);assert.equal(toolbar.status.height,toolbar.pdf.height);
 await save(host);const model=await(await page.request.get(new URL('/api/commercial/state?workspace='+await page.evaluate(()=>window.CeasefireCertification.sessionId()),page.url()).href)).json(),record=model.documents.find(item=>item.kind==='work_order');assert.ok(record.reference);assert.equal(record.fields.title,'Work Order');const title=record.reference+': '+record.fields.details.client;
 await host.getByRole('button',{name:'Back to Work Orders',exact:true}).click();await expect(host.locator('.commercial-card').getByRole('button',{name:title,exact:true})).toHaveCount(1);await expect(host.locator('.commercial-card summary')).toHaveAttribute('aria-label','Actions for '+title);await host.getByLabel('Search documents',{exact:true}).fill(title);await expect(host.locator('.commercial-card')).toHaveCount(1);await host.getByLabel('Search documents',{exact:true}).fill('');checks.push('Work Order title is its assigned reference and Company; stored title is preserved, and Status shares the action toolbar');
 await openProjectSection(page,'purchase-orders');host=page.locator('#commercial-purchase-order-root');await host.getByRole('button',{name:'New Purchase Order',exact:true}).click();await idle();await pdfControl(host,'purchase_order');const method=host.getByLabel('Delivery or pickup',{exact:true}),group=host.getByRole('group',{name:'Delivery date and time',exact:true}),date=host.getByLabel('Delivery date',{exact:true}),time=host.getByLabel('Delivery time',{exact:true});await expect(method).toHaveValue('');await expect(group).toBeHidden();
 const order=await host.locator('.commercial-purchase-information').evaluate(section=>[...section.children].filter(child=>child.classList.contains('field')).map(child=>child.querySelector('[data-order-field]')?.dataset.orderField));assert.ok(order.indexOf('delivery_method')<order.indexOf('ship_to_address'));assert.ok(order.indexOf('ship_to_address')<order.indexOf('delivery_date'));
 await host.getByLabel('Supplier company',{exact:true}).fill('Toolbar supplier');await method.selectOption('Delivery');await expect(group).toBeVisible();await date.fill('2026-12-12');await time.fill('15:20');await method.selectOption('Pickup');await expect(group).toBeHidden();await expect(date).toHaveValue('2026-12-12');await expect(time).toHaveValue('15:20');await save(host);await host.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();await expect(host.locator('.commercial-card .project-title-button')).toHaveText(/^PO-\d+: Toolbar supplier$/);await host.locator('.commercial-card .project-title-button').click();await idle();await expect(method).toHaveValue('Pickup');await expect(group).toBeHidden();await method.selectOption('Delivery');await expect(group).toBeVisible();await expect(date).toHaveValue('2026-12-12');await expect(time).toHaveValue('15:20');await save(host);await host.getByRole('button',{name:'Back to Purchase Orders',exact:true}).click();checks.push('Delivery precedes shipping/date controls; its date/time group is conditional while hidden values survive Save and reopen');
 await chooseCalculator(page,'Steel (spray)');await page.locator('#calculator-pages').getByRole('button',{name:'SCHEDULE',exact:true}).click();await idle();const table=page.locator('#calculator-grid .calculator-schedule-table'),notesHead=table.locator('thead [data-schedule-column="virtual:notes"]'),notes=table.locator('tbody [data-schedule-column="virtual:notes"]').first(),report=table.locator('tbody [data-schedule-column="virtual:report"]').first();
 for(const control of [notesHead,notes]){await control.scrollIntoViewIfNeeded();await page.mouse.move(0,0);const before=await appearance(control);await control.hover();assert.deepEqual(await appearance(control),before,'Notes header and body retain their default colour on hover');}
 await report.scrollIntoViewIfNeeded();await page.mouse.move(0,0);const before=await appearance(report);await report.hover();const after=await appearance(report);assert.equal(after.background,'rgb(163, 18, 34)');assert.equal(after.color,'rgb(255, 255, 255)');assert.notEqual(after.background,before.background);checks.push('Actual calculator Notes header/body retain their colours on hover while Report still shows its red/white hover control');
 await page.screenshot({path:path.join(output,'calculator-report-hover.png'),fullPage:false});assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,geometry,errors},null,2));console.log('PASS commercial toolbar layout: '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
