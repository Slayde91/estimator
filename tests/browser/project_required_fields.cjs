'use strict';
// Required metadata is checked before first-save numbering and native dialogs.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa','project-required-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let stdout='',logs='',browser,page;
server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});server.stdout.on('data',value=>{stdout+=value;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const errors=[],writes=[],geometry=[];
const fields={client:'project-pane-client',site_address:'project-pane-address',contact_name:'project-pane-contact-name',contact_email:'project-pane-contact-email',contact_phone:'project-pane-contact-phone'};
const values={client:'Synthetic Required Company',site_address:'1 Synthetic Required Street',contact_name:'Synthetic Contact',contact_email:'required@example.test',contact_phone:'0400 000 001'};
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(30000);
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname==='/api/project/save-as')writes.push(request.postDataJSON());});
 await page.goto('http://127.0.0.1:'+info.port+'/');await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
 const next=async()=>(await(await page.request.get(new URL('/api/project-details',page.url()).href)).json()).next_reference;
 const initial=await next();
 await openProjectSection(page,'quotes');await page.getByRole('button',{name:'New',exact:true}).click();
 const modal=page.locator('#project-new-dialog');await expect(modal).toBeVisible();
 await expect(page.locator('#project-pane-number')).toHaveAttribute('readonly','');await expect(page.locator('#project-pane-number')).toHaveAttribute('aria-required','true');await expect(page.locator('#project-pane-number')).toHaveValue('');
 await page.locator('#project-account-new').click();const company=page.getByRole('dialog',{name:'New Company',exact:true});await company.getByLabel('Company',{exact:true}).fill(values.client);await company.getByRole('button',{name:'Save',exact:true}).click();await expect(company).toBeHidden();
 for(const [key,id] of Object.entries(fields)){await expect(page.locator('#'+id)).toHaveAttribute('required','');await page.locator('#'+id).fill(values[key]);}
 const restore=async()=>{await page.locator('#project-pane-client').fill(values.client);await page.locator('#project-pane-client').focus();await page.locator('#project-account-options').getByRole('option',{name:values.client,exact:true}).click();for(const [key,id] of Object.entries(fields))if(key!=='client')await page.locator('#'+id).fill(values[key]);};
 await restore();
 for(const [key,id] of Object.entries(fields)){
  await page.locator('#'+id).fill('');await page.locator('#project-details-save').click();assert.ok(Object.values(fields).includes(await page.evaluate(()=>document.activeElement.id)));assert.equal(writes.length,0,key);assert.equal(await next(),initial);await expect(modal).toBeVisible();await restore();
 }
 // Native required handles empty text; the explicit trimmed check catches spaces.
 await page.locator('#project-pane-contact-phone').fill('   ');await page.locator('#project-details-save').click();await expect(page.locator('#project-details-status')).toContainText('Contact phone');await expect(page.locator('#project-pane-contact-phone')).toBeFocused();assert.equal(writes.length,0);await page.locator('#project-pane-contact-phone').fill(values.contact_phone);
 await page.locator('#project-pane-contact-email').fill('not-an-email');await page.locator('#project-details-save').click();await expect(page.locator('#project-pane-contact-email')).toBeFocused();assert.equal(writes.length,0);await page.locator('#project-pane-contact-email').fill(values.contact_email);
 const saving=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');await page.locator('#project-details-save').click();const reply=await saving;assert.equal(reply.status(),200,await reply.text());const saved=await reply.json();assert.equal(saved.file.project_no,initial);await expect(modal).toBeHidden();
 await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);await expect(page.locator('#app-message')).not.toContainText('Project saved to');
 await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();await expect(page.locator('#snapshot-message')).toBeVisible();
 for(const width of [1915,1213,390]){
  await page.setViewportSize({width,height:1000});const boxes=await page.evaluate(()=>{const pane=document.querySelector('#project-details-pane').getBoundingClientRect(),notice=document.querySelector('#snapshot-message').getBoundingClientRect();return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,pane:{x:pane.x,right:pane.right,bottom:pane.bottom},notice:{x:notice.x,right:notice.right,top:notice.top},inRightPane:document.querySelector('#project-workspace-links').contains(document.querySelector('#snapshot-message'))};});
  assert.ok(boxes.inRightPane);if(width>1050)assert.ok(boxes.notice.x>=boxes.pane.right);else assert.ok(boxes.notice.top>=boxes.pane.bottom);assert.ok(boxes.documentWidth<=boxes.width);geometry.push(boxes);await page.screenshot({path:path.join(output,'project-required-'+width+'.png'),fullPage:true});
 }
 await page.locator('#project-details-close').click();await expect(page.locator('#project-workspace-side')).toBeHidden();await expect(page.locator('#project-workspace-links')).toBeHidden();await expect(page.locator('#snapshot-message')).toBeHidden();
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,requiredFields:Object.keys(fields),numberAssignedAfterValidation:initial,blockedFirstSaves:7,geometry,errors},null,2));console.log('PASS Project required fields and pricing notice: '+output);
})().catch(async error=>{console.error(error);console.error(logs.slice(-2000));if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
