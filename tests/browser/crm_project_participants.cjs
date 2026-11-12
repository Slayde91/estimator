// Explicit project roles and automatic exact-address bid links; all files are disposable.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection,openCurrentProjectDetails}=require('./project_actions.cjs');
const root=path.resolve(__dirname,'../..'),folder=path.join(root,'.runtime/browser-qa','crm-participants-'+Date.now());
fs.mkdirSync(folder,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',folder,'--simulate-project-write-denial'],{cwd:root,windowsHide:true});
let stderr='',browser,page;server.stderr.on('data',d=>stderr+=d);
const ready=new Promise((resolve,reject)=>{let text='';server.on('error',reject);server.on('exit',()=>reject(Error(stderr)));
  server.stdout.on('data',d=>{text+=d;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]));});});
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  const timings={};
  browser=await chromium.launch({headless:true});page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+info.port);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await createNewProject(page,{client:'Builder A','site-address':'42 Example Lane'});
  const original=fs.readFileSync(info.project);
  const read=async path=>{const res=await page.request.get(new URL(path,page.url()).href);assert.equal(res.status(),200,await res.text());return res.json();};
  const directory=await read('/api/contacts/directory');
  const create=await page.request.post(new URL('/api/contacts/accounts',page.url()).href,{data:{version:directory.version,fields:{company:'Consulting team'}}});
  assert.equal(create.status(),200,await create.text());const consultant=(await create.json()).id;
  await openProjectSection(page,'quotes');await openCurrentProjectDetails(page);
  const panel=page.locator('#project-participants-panel');
  await expect(panel.locator('summary')).toHaveText('Linked Projects');
  await expect(panel.locator('h4')).toHaveCount(0);
  await expect(panel.getByText('No linked projects.',{exact:true})).toBeVisible();
  const companies=page.locator('#project-company-participants'), contacts=page.locator('#project-contact-participants');
  for(const [host,label] of [[companies,'Company'],[contacts,'Contact']]){
    await expect(host.locator('details')).toHaveCount(0);
    await expect(host.getByLabel('Role',{exact:true})).toBeVisible();
    await expect(host.getByRole('combobox',{name:label,exact:true})).toBeVisible();
    const ownPanel=host.locator('..');
    await ownPanel.locator(':scope > summary').click();
    await expect(host.getByRole('combobox',{name:label,exact:true})).toBeHidden();
    await expect(page.locator('#project-pane-client')).toBeVisible();
    await expect(page.locator('#project-pane-contact-name')).toBeVisible();
    await ownPanel.locator(':scope > summary').click();
  }
  const siteWrites=[];
  page.on('request',r=>{if(r.method()==='POST' && new URL(r.url()).pathname==='/api/crm/project-participants')siteWrites.push(r.postDataJSON());});

  await companies.getByLabel('Role',{exact:true}).selectOption('consultant');
  await companies.getByRole('button',{name:'New Company',exact:true}).click();
  await page.getByRole('dialog',{name:'New Company',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
  await companies.getByRole('combobox',{name:'Company',exact:true}).fill('Consulting');
  await companies.getByRole('option',{name:'Consulting team',exact:true}).click();
  await expect(companies.locator('li').filter({hasText:'Consulting team'}).locator('.helper')).toHaveText('Consultant');
  const currentPrimary=await page.locator('#project-pane-contact-name').inputValue();

  await contacts.getByRole('combobox',{name:'Contact',exact:true}).fill('Site manager');
  await contacts.getByRole('button',{name:'New Contact'}).click();
  const dialog=page.getByRole('dialog',{name:'New Contact',exact:true});
  await expect(dialog.getByLabel('Name',{exact:true})).toHaveValue('Site manager');
  await expect(dialog.getByLabel('Company',{exact:true})).toHaveValue('Builder A');
  await dialog.getByLabel('Company',{exact:true}).fill('Consulting team');
  await dialog.getByLabel('Phone',{exact:true}).fill('5551234');
  await dialog.getByLabel('Email',{exact:true}).fill('site@example.test');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(contacts.locator('li').filter({hasText:'Site manager'}).locator('.helper')).toHaveText('Site contact');
  await expect(page.locator('#project-pane-contact-name')).toHaveValue(currentPrimary);
  await contacts.getByRole('button',{name:'Remove',exact:true}).click();
  await expect(contacts.locator('li')).toHaveCount(0);
  const stray = await page.request.post(new URL('/api/contacts/contacts',page.url()).href,{data:{
    version:(await read('/api/contacts/directory')).version,fields:{name:'Site manager elsewhere',company:'Unrelated team',phone:'123',email:'other@example.test'}
  }});
  assert.equal(stray.status(),200,await stray.text());

  await contacts.getByRole('combobox',{name:'Contact',exact:true}).fill('Site manager');
  await expect(contacts.getByRole('listbox').getByRole('option')).toHaveText(['Site manager']);
  await contacts.getByRole('combobox',{name:'Contact',exact:true}).press('Escape');
  const siteCreate=await page.request.post(new URL('/api/crm/sites',page.url()).href,{data:{id:require('node:crypto').randomUUID(),name:'Shared school refurbishment',address:'42 Example Lane'}});
  assert.equal(siteCreate.status(),200,await siteCreate.text());const site=await siteCreate.json();
  await expect(panel.locator('input,button,[data-linked-site-id]')).toHaveCount(0);
  const linked=await read('/api/contacts/account-links?id='+consultant);
  assert.ok(linked.participant_projects.some(row=>row.role==='consultant' && row.client==='Builder A'));
  assert.deepEqual(fs.readFileSync(info.project),original,'Directory relationships never rewrite the saved project');
  const copy=JSON.parse(original);
  for(const estimate of [copy.estimate,...(copy.estimates || []).map(e=>e.workspace.estimate)]) {
    estimate.client='Builder B';estimate.account_id='';estimate.contact_id='';
  }
  const copyPath=path.join(path.dirname(info.project),'separate-builder.cf.json');
  fs.writeFileSync(copyPath,JSON.stringify(copy));const copyBytes=fs.readFileSync(copyPath);
  await page.locator('#project-details-close').click();await page.locator('#refresh-quotes').click();
  const selected=(await read('/api/projects')).files.find(row=>row.name==='separate-builder.cf.json');assert.ok(selected);
  await openCurrentProjectDetails(page);
  const targetB=panel.getByRole('button',{name:/Builder B/});
  await expect(targetB).toBeVisible();
  const currentAddress=page.locator('#project-pane-address');
  await currentAddress.fill('Draft should stay on cancel');
  await targetB.click();
  const navigation=page.locator('#discard-dialog');
  await navigation.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(currentAddress).toHaveValue('Draft should stay on cancel');
  await targetB.click();await navigation.getByRole('button',{name:'Open without saving'}).click();
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder B');
  assert.equal(await page.evaluate(()=>window.CeasefireProject.context().project_path),copyPath);
  assert.deepEqual(fs.readFileSync(info.project),original);
  await panel.getByRole('button',{name:/Builder A/}).click();
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder A');
  await page.locator('#project-details-close').click();
  await expect(page.locator('#project-list-card')).toBeVisible();
  await page.locator(`.project-kanban-card[data-project-id="${selected.id}"] .project-title-button`).click();
  await expect(page.locator('#project-details-pane')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder B');
  await expect(panel.locator('summary')).toBeVisible();
  await expect(panel.locator('li').filter({hasText:'Builder A'})).toHaveCount(1);
  const auto=await read('/api/crm/project-participants?project='+encodeURIComponent(selected.id));assert.equal(auto.site_mode,'automatic');assert.equal(auto.site_id,null);
  const sites=await read('/api/crm/sites?search=school');assert.equal(sites.sites.length,1);
  assert.equal(auto.linked_sites[0].id,site.id);
  assert.deepEqual(siteWrites.map(body=>body.site_id),[null,null,null],'Only adding and removing participants sent mutations');
  // Simulate a link saved before automatic linking, using the existing versioned API.
  const legacy=await page.request.post(new URL('/api/crm/project-participants',page.url()).href,{data:{
    project:selected.id,project_revision:auto.project_revision,version:auto.version,participants:[],site_id:site.id}});
  assert.equal(legacy.status(),200,await legacy.text());const manual=await legacy.json();
  assert.equal(manual.site_id,site.id);assert.equal(manual.linked_sites.length,1);
  const persisted=await read('/api/crm/project-participants?project='+encodeURIComponent(selected.id));
  assert.equal(persisted.site_id,site.id);assert.equal(persisted.version,manual.version);
  await expect(panel.locator('summary')).toBeVisible();
  await expect(panel.locator('li').filter({hasText:'Builder A'})).toHaveCount(1);
  assert.deepEqual(fs.readFileSync(info.project),original);assert.deepEqual(fs.readFileSync(copyPath),copyBytes);
  // The older open form must recover its version before adding a role and retain the explicit site.
  const addConsultant=async()=>{

    await companies.getByLabel('Role',{exact:true}).selectOption('consultant');
    await companies.getByRole('combobox',{name:'Company',exact:true}).fill('Consulting');
    await companies.getByRole('option',{name:'Consulting team',exact:true}).click();
  };
  await addConsultant();await expect(companies.getByRole('status')).toContainText('Review the updated list');
  await addConsultant();await expect(companies.locator('li').filter({hasText:'Consulting team'}).locator('.helper')).toHaveText('Consultant');
  // Edit a saved bid with a legacy explicit site and keep both valid relationships.
  const address=page.locator('#project-pane-address');
  const newAddress='77 Replacement Lane';
  const linkState=()=>read('/api/crm/project-participants?project='+encodeURIComponent(selected.id));
  await address.fill(newAddress);
  const saveDetails=page.locator('#project-details-save');
  const saveResponse=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects/details/save',{timeout:10000});
  const deniedMarker=path.join(folder,'deny-project-writes');
  fs.writeFileSync(deniedMarker,'');
  try {
    const started=Date.now();
    const denied=saveResponse();
    await panel.getByRole('button',{name:/Builder A/}).click();
    await navigation.getByRole('button',{name:'Save',exact:true}).click();
    assert.equal((await denied).status(),400);
    timings.deniedMetadataSaveMs=Date.now()-started;
    await expect(page.locator('#project-details-status')).toContainText('writable folder');
    await expect(address).toBeEditable();
    await expect(address).toHaveValue(newAddress);
    assert.deepEqual(fs.readFileSync(copyPath),copyBytes);
    assert.equal((await linkState()).site_id,site.id);
  } finally {
    fs.unlinkSync(deniedMarker);
  }
  // A slow project-list refresh after the retry must not lock the saved form.
  let allowRefresh,refreshStarted=false,finishedRefresh;
  const gate=new Promise(resolve=>{allowRefresh=resolve;});
  const continued=new Promise(resolve=>{finishedRefresh=resolve;});
  const listEndpoint=url=>url.pathname==='/api/projects';
  const delayList=async route=>{
    refreshStarted=true;
    await gate;
    try { await route.continue(); } finally { finishedRefresh(); }
  };
  await page.route(listEndpoint,delayList);
  try {
    const started=Date.now();
    const retry=saveResponse();
    await saveDetails.click();
    const savedAddress=await retry;assert.equal(savedAddress.status(),200,await savedAddress.text());
    await expect.poll(()=>refreshStarted).toBe(true);
    await expect(page.locator('#project-details-status')).toHaveText('Project details saved.');
    await expect(address).toBeEditable();
    await expect(page.locator('#project-details-close')).toBeEnabled();
    timings.metadataRetryUntilEditableMs=Date.now()-started;
  } finally {
    allowRefresh();
    if(refreshStarted)await continued;
    await page.unroute(listEndpoint,delayList);
  }
  await expect(address).toHaveValue(newAddress);
  const savedCopy=fs.readFileSync(copyPath);
  assert.equal(JSON.parse(savedCopy).estimate.site_address,newAddress);
  const afterAddressEdit=await linkState();
  assert.equal(afterAddressEdit.site_id,site.id);
  assert.equal(afterAddressEdit.site_mode,'automatic');
  assert.deepEqual(afterAddressEdit.linked_sites.map(link=>link.address),[newAddress,'42 Example Lane']);
  assert.equal(afterAddressEdit.linked_bids.length,0);
  assert.deepEqual(afterAddressEdit.other_site_bids.map(item=>item.client),['Builder A']);
  await expect(panel.locator('summary')).toBeVisible();
  const earlierBid=panel.getByText(/PN-.*Builder A.*42 Example Lane/);
  await expect(earlierBid).toBeVisible();
  await expect(panel.locator('li')).toHaveCount(1);
  await expect(panel.locator('input,details')).toHaveCount(0);
  assert.deepEqual(fs.readFileSync(copyPath),savedCopy,'Viewing links cannot reassign or rewrite the Project');
  assert.deepEqual(fs.readFileSync(info.project),original,'The other bid keeps its original address');
  await page.locator('#project-pane-contact-phone').fill('5550987');
  await earlierBid.click();
  await navigation.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder A');
  assert.equal(JSON.parse(fs.readFileSync(copyPath)).estimate.contact_phone,'5550987');
  await page.locator('#project-details-close').click();
  await expect(page.locator('#project-list-card')).toBeVisible();
  await page.locator(`.project-kanban-card[data-project-id="${selected.id}"] .project-title-button`).click();
  await expect(earlierBid).toBeVisible();
  const updatedCopy=fs.readFileSync(copyPath);
  // Removing the saved copy outside CLASSIFIRE must not erase or rebind the recorded site relationship.
  fs.renameSync(copyPath,copyPath+'.retained');
  const siteView=await read('/api/crm/sites?id='+sites.sites[0].id);
  const archived=siteView.linked_bids.find(bid=>bid.client==='Builder B');assert.equal(archived.availability,'unavailable');
  assert.deepEqual(fs.readFileSync(copyPath+'.retained'),updatedCopy);
  await earlierBid.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(folder,'participants.png')});
  await page.setViewportSize({width:390,height:884});await earlierBid.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,'Linked projects fit the mobile viewport');
  await page.screenshot({path:path.join(folder,'participants-mobile.png')});

  await companies.getByRole('combobox',{name:'Company',exact:true}).focus();
  const options=companies.getByRole('listbox');
  await expect(options).toBeVisible();const popupBox=await options.boundingBox();
  assert.ok(popupBox.width>0 && popupBox.x>=0 && popupBox.x+popupBox.width<=391,'Participant searches fit the mobile viewport');
  await page.locator('#project-details-close').click();await openCurrentProjectDetails(page);
  await expect(panel.getByText('Saved project unavailable',{exact:true})).toBeVisible();
  await address.fill('18 Current Project Way');
  const started=Date.now();
  const projectSave=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save');
  await page.locator('#save-current-project').click();
  const receipt=await projectSave;assert.equal(receipt.status(),200,await receipt.text());
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  timings.activeProjectSaveMs=Date.now()-started;
  assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.site_address,'18 Current Project Way');
  await expect(panel.getByText('No linked projects.',{exact:true})).toBeVisible();
  assert.deepEqual(siteWrites.map(body=>body.site_id),[null,null,null,null,site.id],'Only user-requested participant changes sent writes, including the retried conflict');
  // A current Project draft uses the full file save before following an available peer.
  const restored=JSON.parse(updatedCopy);
  for (const estimate of [restored.estimate, ...(restored.estimates || []).map(entry=>entry.workspace.estimate)]) {
    estimate.site_address='18 Current Project Way';
  }
  fs.writeFileSync(copyPath,JSON.stringify(restored));
  await page.locator('#project-details-close').click();
  const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects');
  await page.locator('#refresh-quotes').click();await refreshed;
  await openCurrentProjectDetails(page);await expect(targetB).toBeVisible();
  await page.locator('#project-pane-contact-phone').fill('5550101');
  await targetB.click();
  const onDisk=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save');
  await navigation.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await onDisk).status(),200);
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder B');
  assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.contact_phone,'5550101');
  // Older servers can mix current and historical addresses in one peer list.
  await page.route('**/api/crm/project-participants?*',async route=>{
    const response=await route.fetch(), data=await response.json();delete data.linked_sites;delete data.other_site_bids;
    data.linked_bids=[{project_no:'PN-older',client:'Earlier bid',site_address:'42 Example Lane'}];
    await route.fulfill({response,json:data});
  });
  await page.locator('#project-details-close').click();await openCurrentProjectDetails(page);
  await expect(panel.locator('summary')).toBeVisible();
  await expect(panel.getByText(/PN-older · Earlier bid/)).toBeVisible();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify({passed:true,checks:['Automatic site for the first project at an address','Unique named site reused','No Link button or automatic writes','Exact-address peers','Permission denial preserves edits and previous links','Successful retry permits continued editing during list refresh','Current and selected projects follow saved address changes','Historical explicit site retained alongside the current address','Distinct bid files and unavailable explicit sources remain recorded'],timings,output:folder},null,2));
  console.log('PASS automatic project sites, exact-address peers, legacy links, edits, permission recovery and mobile layout: '+folder);
})().catch(async error=>{console.error(error,stderr,await page?.locator('#project-participants-panel').innerText().catch(()=>''));await page?.screenshot({path:path.join(folder,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
