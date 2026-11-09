'use strict';
// Disposable fixture: option colours and project-specific Quote suggestions.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','commercial-status-scope-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page;
server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exit '+code));});server.stdout.on('data',value=>{stdout+=value;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1213,height:884}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+info.port+'/');
 await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 await createNewProject(page,{client:'Scope client',site_address:'Scope site',contact_name:'Scope contact',contact_phone:'0400 111 222',contact_email:'scope@example.test'});
 await openProjectSection(page,'quote');
 const quote=page.locator('#commercial-quote-root');await quote.getByRole('button',{name:'New Quote',exact:true}).click();
 const colours={Draft:'rgb(48, 52, 60)',Review:'rgb(107, 77, 0)',Presented:'rgb(25, 75, 120)',Accepted:'rgb(18, 108, 70)',Lost:'rgb(164, 0, 32)'};
 const status=quote.getByLabel('Status',{exact:true});
 for(const [value,colour]of Object.entries(colours)){
  await status.selectOption(value);
  await expect.poll(()=>status.evaluate(control=>getComputedStyle(control).backgroundColor)).toBe(colour);
  const paint=await status.evaluate(control=>{const option=control.selectedOptions[0];return{selected:getComputedStyle(control).backgroundColor,option:getComputedStyle(option).backgroundColor,text:getComputedStyle(option).color};});
  assert.deepEqual(paint,{selected:colour,option:colour,text:'rgb(255, 255, 255)'});
 }
 await page.screenshot({path:path.join(output,'quote-status.png')});
 await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
 await page.getByRole('dialog',{name:'Discard the current quote?',exact:true}).getByRole('button',{name:'Yes',exact:true}).click();
 const projectNo=await page.evaluate(()=>window.CeasefireProject.details().project_no);
 const baseFields={title:'Owned Quote',details:{project_no:projectNo,client:'Scope client',site_address:'Scope site',contact:'Scope contact',phone:'0400 111 222',email:'scope@example.test',date:'2026-11-09'},order:{work_order_reference:'',quote_id:'',quote_reference:'',estimated_cost:''},sources:[],lines:[]};
 const owned={id:randomUUID(),kind:'quote',status:'Draft',version:1,last_number:'QU-01',updated_at:new Date().toISOString(),fields:baseFields};
 const foreign={...owned,id:randomUUID(),last_number:'QU-FOREIGN',fields:{...baseFields,title:'Other Project Quote',details:{...baseFields.details,project_no:'PN-OTHER'}}};
 await page.route('**/api/commercial/state?*',async route=>{const response=await route.fetch();const data=await response.json();data.documents.push(owned,foreign);await route.fulfill({response,json:data});});
 await openProjectSection(page,'work-orders');const work=page.locator('#commercial-work-order-root');await work.getByRole('button',{name:'New Work Order',exact:true}).click();
 await expect(work.getByLabel('Linked Quote',{exact:true}).locator('option')).toHaveText(['Select an issued Quote…','QU-01 · Owned Quote']);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,colours,projectNo,errors},null,2));console.log('PASS commercial status colours and Project-scoped Quote suggestions: '+output);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
