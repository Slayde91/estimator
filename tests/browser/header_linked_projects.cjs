'use strict';
// Header shortcut and real same-address Project peers in disposable saved files.
const {chromium,expect:baseExpect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
const expect=baseExpect.configure({timeout:30000}),root=path.resolve(__dirname,'../..');
const output=path.join(root,'.runtime/browser-qa','header-linked-projects-'+Date.now());fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',stdout='',browser,page;server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exit '+code));});server.stdout.on('data',value=>{stdout+=value;if(stdout.includes('\n')){clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]));}});});
const errors=[],checks=[];
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);const base='http://127.0.0.1:'+info.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:1000}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
 const idle=()=>page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
 const read=async endpoint=>{const response=await page.request.get(base+endpoint);assert.equal(response.status(),200,await response.text());return response.json();};
 await page.goto(base);await idle();await createNewProject(page,{client:'Header owner A','site-address':'42 Linked Workspace Street'});
 if(await page.locator('#project-details-pane').isVisible())await page.locator('#project-details-close').click();
 await page.locator('.nav-button[data-view=home]').click();await expect(page.locator('#view-home')).toBeVisible();
 const header=page.locator('#header-project-name'),review=page.locator('#discard-dialog');
 const headerDialog=page.getByRole('dialog',{name:'Project Details',exact:true});
 await header.focus();await page.keyboard.press('Enter');assert.deepEqual(errors,[]);
 await expect(headerDialog).toBeVisible();await expect(headerDialog.locator('dd')).toHaveCount(8);
 await expect(headerDialog.getByText('42 Linked Workspace Street',{exact:true})).toBeVisible();
 await expect(headerDialog.getByText('Header owner A',{exact:true})).toBeVisible();
 await expect(review).toBeHidden();await expect(page.locator('#view-home')).toBeVisible();
 await headerDialog.screenshot({path:path.join(output,'header-project-details.png')});
 await page.keyboard.press('Escape');await expect(headerDialog).toBeHidden();await expect(header).toBeFocused();
 checks.push('Enter on the header opens the current Project fields over Home. Escape closes the dialog and restores keyboard focus.');
 const sibling=JSON.parse(fs.readFileSync(info.project,'utf8')),siblingPath=path.join(output,'header-peer-b.cf.json');
 const renumber=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(key==='client'&&typeof item==='string')value[key]='Header peer B';else if(key==='project_no'&&typeof item==='string')value[key]='PN-PEER-B';else if(item&&typeof item==='object')renumber(item);}};renumber(sibling);assert.equal(sibling.certifications?.document_count,0);assert.equal(sibling.certifications?.revision_count,0);
 // The empty peer has no certificate evidence to carry over. A copied automatic identity cannot legally be assigned a different Project No.
 delete sibling.certifications;fs.writeFileSync(siblingPath,JSON.stringify(sibling));const peerBytes=fs.readFileSync(siblingPath);
 await openProjectSection(page,'quotes');await page.locator('#link-project-folder').click();await idle();await page.locator('#refresh-quotes').click();await idle();
 const listing=await read('/api/projects'),a=listing.files.find(item=>path.resolve(item.path)===path.resolve(info.project)),b=listing.files.find(item=>path.resolve(item.path)===path.resolve(siblingPath));assert.ok(a&&b,JSON.stringify(listing));
 await page.locator(`.project-kanban-card[data-project-id="${b.id}"] .project-title-button`).click();
 const peerAddress=page.locator('#project-pane-address');
 await expect(peerAddress).toHaveValue('42 Linked Workspace Street');
 await peerAddress.fill('Unsaved address for peer B only');
 await peerAddress.evaluate(input=>input.setSelectionRange(3,11));
 const scrollBefore=await page.evaluate(()=>{window.scrollTo({top:170,behavior:'instant'});return window.scrollY;});
 assert.ok(scrollBefore>0,'Start the dialog check on a scrolled page');
 await header.click();await expect(headerDialog.getByText('Header owner A',{exact:true})).toBeVisible();
 await expect(headerDialog).not.toContainText('Unsaved address for peer B only');
 await headerDialog.getByRole('button',{name:'Close'}).click();
 await expect(peerAddress).toBeFocused();await expect(peerAddress).toHaveValue('Unsaved address for peer B only');
 await expect.poll(()=>peerAddress.evaluate(input=>[input.selectionStart,input.selectionEnd])).toEqual([3,11]);
 assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore);
 await page.locator('#project-details-close').click();await review.getByRole('button',{name:'Yes',exact:true}).click();
 assert.deepEqual(fs.readFileSync(siblingPath),peerBytes);
 checks.push('From the full-page editor for another Project, the header shows the active Project and preserves the edited address, text selection, focus and scroll.');
 const context=await page.evaluate(()=>window.CeasefireProject.context()),selector='native:'+context.project_token;
 let participants;await expect.poll(async()=>{participants=await read('/api/crm/project-participants?project='+encodeURIComponent(selector));return [...(participants.linked_bids||[]),...(participants.other_site_bids||[])].some(item=>item.client==='Header peer B'&&item.availability==='available'&&item.source);},{timeout:30000}).toBe(true);
 const peer=[...(participants.linked_bids||[]),...(participants.other_site_bids||[])].find(item=>item.client==='Header peer B');assert.equal(peer.site_address,'42 Linked Workspace Street');assert.equal(peer.project_no,'PN-PEER-B');
 checks.push('A second saved Project with its own client and number is discovered as an available exact-address peer through the real CRM participant API');
 const kinds=[['quote','quote','Quote','Quotes'],['work_order','work-orders','Work Order','Work Orders'],['purchase_order','purchase-orders','Purchase Order','Purchase Orders']];let quoteId;
 for(const [kind,section,label,plural]of kinds){
  await openProjectSection(page,section);const host=page.locator('#commercial-'+kind.replaceAll('_','-')+'-root');await host.getByRole('button',{name:'New '+label,exact:true}).click();await expect(host.locator('.commercial-editor')).toBeVisible();const peers=host.locator('.commercial-linked-projects');await expect(peers.locator(':scope>summary')).toHaveText('Linked Projects (1)');await expect(peers.getByRole('button',{name:/Header peer B/})).toHaveCount(1);await expect(peers.getByRole('button',{name:/Header peer B/})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),info.project);
  if(kind==='purchase_order'){await expect(host.locator('.commercial-sidebar').first().locator('.commercial-linked-company,.commercial-linked-contact')).toHaveCount(0);await expect(host.locator('.commercial-purchase-information').getByRole('combobox',{name:'Supplier company',exact:true})).toHaveValue('');await expect(host.locator('.commercial-purchase-information').getByRole('combobox',{name:'Supplier contact',exact:true})).toHaveValue('');}
  if(kind==='quote')await host.getByLabel('Introduction',{exact:true}).fill('Saved quotation text');
  const saved=page.waitForResponse(response=>/\/api\/commercial\/(?:saved-)?save$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');await host.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();const reply=await saved;assert.equal(reply.status(),200,await reply.text());const document=await reply.json();if(kind==='quote')quoteId=document.id;await idle();await page.screenshot({path:path.join(output,kind+'-linked-projects.png'),fullPage:true});await host.getByRole('button',{name:'Back to '+plural,exact:true}).click();await expect(host.locator('.commercial-list')).toBeVisible();
 }
 checks.push('Quote, Work Order and Purchase Order editors all show the same real peer once; an empty PO supplier sidebar does not hide Linked Projects');
 // Force partial availability in an otherwise real response. Only available peers may be actionable.
 await page.route('**/api/crm/project-participants?*',async route=>{const response=await route.fetch(),data=await response.json();data.linked_bids=[...(data.linked_bids||[]),{...peer,project_no:'PN-NOT-AVAILABLE',client:'Unavailable peer',availability:'unavailable'},{...peer,project_no:'PN-NOT-CHECKED',client:'Unverified peer',availability:'unverified'}];data.error_count=1;data.scan_pending=true;await route.fulfill({response,json:data});});
 await openProjectSection(page,'quote');const quote=page.locator('#commercial-quote-root');await quote.locator(`[data-document-id="${quoteId}"] .project-title-button`).click();const peers=quote.locator('.commercial-linked-projects');await expect(peers).toContainText('Some linked projects could not be checked.');await expect(peers).toContainText('Saved project unavailable');await expect(peers).toContainText('Availability not yet verified');await expect(peers.getByRole('button',{name:/Unavailable peer|Unverified peer/})).toHaveCount(0);await expect(peers.getByRole('button',{name:/Header peer B/})).toHaveCount(1);await page.unroute('**/api/crm/project-participants?*');
 checks.push('Partial-scan unavailable and unverified peers are readable, explicitly labelled and never offered as load buttons');
 const originalBytes=fs.readFileSync(info.project),intro=quote.getByLabel('Introduction',{exact:true});
 await intro.fill('Unsaved quotation draft must survive Cancel');
 await header.click();await expect(headerDialog).toBeVisible();await expect(review).toBeHidden();await page.keyboard.press('Escape');
 await expect(intro).toBeFocused();await expect(intro).toHaveValue('Unsaved quotation draft must survive Cancel');
 const target=peers.getByRole('button',{name:/Header peer B/});await target.click();await expect(review).toContainText('Discard the current quote?');await review.getByRole('button',{name:'Cancel',exact:true}).click();await expect(intro).toHaveValue('Unsaved quotation draft must survive Cancel');assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),info.project);
 // An independent Project draft still receives the existing Project replacement review after document discard.
 await page.locator('#measurements').evaluate(input=>{input.value='Independent unsaved Project notes';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await target.click();await expect(review).toContainText('Discard the current quote?');await review.getByRole('button',{name:'Yes',exact:true}).click();await expect(review).toContainText('Save changes before opening the linked project?');await review.getByRole('button',{name:'Open without saving',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.CeasefireProject.context().project_path)).toBe(siblingPath);await idle();await expect(page.locator('#project-details-pane')).toBeVisible();await expect(page.locator('#project-pane-client')).toHaveValue('Header peer B');await expect(page.locator('#project-pane-number')).toHaveValue('PN-PEER-B');assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),siblingPath);assert.deepEqual(fs.readFileSync(info.project),originalBytes,'Cancelled and discarded Quote/Project drafts never rewrite owner A');assert.deepEqual(fs.readFileSync(siblingPath),peerBytes,'Loading the peer never rewrites its file');
 checks.push('Dirty-document Cancel preserves the Quote and exact active file; confirmed document discard plus the normal Project Open without saving review loads the exact saved peer path');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors,projectA:a.id,projectB:b.id,peer},null,2));console.log('PASS Header and linked Projects: '+output);
})().catch(async error=>{console.error(error);console.error(logs);if(page){console.error(await page.locator('#app-message').textContent().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
