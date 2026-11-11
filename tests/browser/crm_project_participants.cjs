// Explicit project roles and automatic exact-address bid links; all files are disposable.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createNewProject,openProjectSection}=require('./project_actions.cjs');
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
  await openProjectSection(page,'quotes');await page.locator('#project-current-details').click();
  const panel=page.locator('#project-participants-panel');
  await panel.locator('summary').first().click();await expect(panel.getByRole('heading',{name:'Project participants'})).toBeVisible();
  await expect(panel.getByRole('heading',{name:'Linked Sites',exact:true})).toBeVisible();
  await expect(panel.locator('[data-linked-site-id]')).toHaveText('42 Example Lane');
  const siteWrites=[];
  page.on('request',r=>{if(r.method()==='POST' && new URL(r.url()).pathname==='/api/crm/project-participants')siteWrites.push(r.postDataJSON());});
  await panel.getByLabel('Role',{exact:true}).selectOption('consultant');
  await panel.getByLabel('Search directory',{exact:true}).fill('Consulting');
  await panel.getByLabel('Participant',{exact:true}).selectOption(consultant);
  await panel.getByRole('button',{name:'Add participant',exact:true}).click();
  await expect(panel.locator('li')).toContainText('Consulting team');
  const siteCreate=await page.request.post(new URL('/api/crm/sites',page.url()).href,{data:{id:require('node:crypto').randomUUID(),name:'Shared school refurbishment',address:'42 Example Lane'}});
  assert.equal(siteCreate.status(),200,await siteCreate.text());const site=await siteCreate.json();
  await panel.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(panel.getByLabel('Search site addresses',{exact:true})).toHaveValue('42 Example Lane');
  await expect(panel.getByText('New site',{exact:true})).toHaveCount(0);
  await expect(panel.getByRole('button',{name:/^Link(?: |$)/})).toHaveCount(0);
  await expect(panel.locator(`[data-linked-site-id="${site.id}"]`)).toBeVisible();
  await expect(panel.getByText('Shared school refurbishment · 42 Example Lane',{exact:true}).first()).toBeVisible();
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
  await page.locator(`[data-project-details-id="${selected.id}"]`).click();
  await expect(page.locator('#project-details-pane')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#project-pane-client')).toHaveValue('Builder B');
  await panel.locator('summary').first().click();await expect(panel.getByText('Bids with the same site address are linked automatically.',{exact:true})).toBeVisible();
  await expect(panel.locator('li').filter({hasText:'Builder A'})).toHaveCount(1);
  const auto=await read('/api/crm/project-participants?project='+encodeURIComponent(selected.id));assert.equal(auto.site_mode,'automatic');assert.equal(auto.site_id,null);
  const sites=await read('/api/crm/sites?search=school');assert.equal(sites.sites.length,1);
  assert.equal(auto.linked_sites[0].id,site.id);
  assert.deepEqual(siteWrites.map(body=>body.site_id),[null],'Opening and viewing an automatically linked site never sends a mutation');
  // Simulate a link saved before automatic linking, using the existing versioned API.
  const legacy=await page.request.post(new URL('/api/crm/project-participants',page.url()).href,{data:{
    project:selected.id,project_revision:auto.project_revision,version:auto.version,participants:[],site_id:site.id}});
  assert.equal(legacy.status(),200,await legacy.text());const manual=await legacy.json();
  assert.equal(manual.site_id,site.id);assert.equal(manual.linked_sites.length,1);
  await panel.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(panel.getByText('Shared school refurbishment · 42 Example Lane',{exact:true}).first()).toBeVisible();
  await expect(panel.getByRole('button',{name:'Use site address',exact:true})).toBeVisible();
  await expect(panel.getByText('Bids with the same site address are linked automatically.',{exact:true})).toBeVisible();
  const persisted=await read('/api/crm/project-participants?project='+encodeURIComponent(selected.id));
  assert.equal(persisted.site_id,site.id);assert.equal(persisted.version,manual.version);
  await expect(panel.getByRole('heading',{name:'Other bids at this address'})).toBeVisible();
  await expect(panel.locator('li').filter({hasText:'Builder A'})).toHaveCount(1);
  assert.deepEqual(fs.readFileSync(info.project),original);assert.deepEqual(fs.readFileSync(copyPath),copyBytes);
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
    await saveDetails.click();
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
  if(!await panel.evaluate(el=>el.open))await panel.locator('summary').first().click();
  await expect(panel.getByLabel('Search site addresses',{exact:true})).toHaveValue(newAddress);
  await expect(panel.locator('[data-linked-site-id]').filter({hasText:newAddress})).toHaveCount(1);
  assert.equal(afterAddressEdit.linked_bids.length,0);
  assert.deepEqual(afterAddressEdit.other_site_bids.map(item=>item.client),['Builder A']);
  await expect(panel.getByRole('heading',{name:'Other bids at this address'})).toHaveCount(0);
  const recordedLink=panel.getByText('Other recorded site links',{exact:true});
  const earlierBid=panel.getByText(/PN-.*Builder A.*42 Example Lane/);
  await expect(recordedLink).toBeVisible();await expect(earlierBid).toBeHidden();
  await recordedLink.click();await expect(earlierBid).toBeVisible();
  await recordedLink.click();await expect(earlierBid).toBeHidden();
  const search=panel.getByLabel('Search site addresses',{exact:true});
  await search.fill('42 Example Lane');
  await expect(panel.locator(`[data-site-id="${site.id}"]`)).toBeVisible();
  await expect(panel.getByRole('button',{name:/^Link(?: |$)/})).toHaveCount(0);
  assert.deepEqual(fs.readFileSync(copyPath),savedCopy,'Searching cannot reassign or rewrite the Project');
  assert.deepEqual(fs.readFileSync(info.project),original,'The other bid keeps its original address');
  const unlinkResponse=page.waitForResponse(response=>response.request().method()==='POST' &&
    new URL(response.url()).pathname==='/api/crm/project-participants');
  await panel.getByRole('button',{name:'Use site address',exact:true}).click();
  const cleared=await unlinkResponse;assert.equal(cleared.status(),200,await cleared.text());
  const current=await cleared.json();assert.equal(current.site_id,null);
  await expect(panel.locator('[data-linked-site-id]')).toHaveText(newAddress);
  await expect(panel.getByRole('button',{name:'Use site address',exact:true})).toHaveCount(0);
  const archivedLink=await page.request.post(new URL('/api/crm/project-participants',page.url()).href,{data:{
    project:selected.id,project_revision:current.project_revision,version:current.version,participants:[],site_id:site.id}});
  assert.equal(archivedLink.status(),200,await archivedLink.text());
  // Removing the saved copy outside CLASSIFIRE must not erase or rebind the recorded site relationship.
  fs.renameSync(copyPath,copyPath+'.retained');
  const siteView=await read('/api/crm/sites?id='+sites.sites[0].id);
  const archived=siteView.linked_bids.find(bid=>bid.client==='Builder B');assert.equal(archived.availability,'unavailable');
  assert.deepEqual(fs.readFileSync(copyPath+'.retained'),savedCopy);
  await search.fill('42 Example Lane');
  await expect(panel.locator(`[data-site-id="${site.id}"]`)).toBeVisible();
  await panel.locator(`[data-site-id="${site.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(folder,'participants.png')});
  await page.setViewportSize({width:390,height:884});await panel.locator(`[data-site-id="${site.id}"]`).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,'Address search fits the mobile viewport');
  await page.screenshot({path:path.join(folder,'participants-mobile.png')});
  await page.locator('#project-details-close').click();await page.locator('#project-current-details').click();
  await panel.locator('summary').first().click();
  await expect(panel.getByText('Shared school refurbishment · 42 Example Lane',{exact:true}).first()).toBeVisible();
  await address.fill('18 Current Project Way');
  const started=Date.now();
  const projectSave=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/project/save');
  await page.locator('#save-current-project').click();
  const receipt=await projectSave;assert.equal(receipt.status(),200,await receipt.text());
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  timings.activeProjectSaveMs=Date.now()-started;
  assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.site_address,'18 Current Project Way');
  if(!await panel.evaluate(el=>el.open))await panel.locator('summary').first().click();
  await expect(panel.locator('[data-linked-site-id]')).toHaveText('18 Current Project Way');
  assert.deepEqual(siteWrites.map(body=>body.site_id),[null,null],'Only user-requested participant changes sent writes');
  // Older servers can mix current and historical addresses in one peer list.
  await page.route('**/api/crm/project-participants?*',async route=>{
    const response=await route.fetch(), data=await response.json();delete data.linked_sites;delete data.other_site_bids;
    data.linked_bids=[{project_no:'PN-older',client:'Earlier bid',site_address:'42 Example Lane'}];
    await route.fulfill({response,json:data});
  });
  const legacyRefresh=page.waitForResponse(r=>r.request().method()==='GET' && new URL(r.url()).pathname==='/api/crm/project-participants');
  await panel.getByRole('button',{name:'Refresh',exact:true}).click();await legacyRefresh;
  await expect(panel.locator('[data-linked-site-id]')).toHaveText('18 Current Project Way');
  await expect(panel.getByRole('heading',{name:'Other bids at this address'})).toHaveCount(0);
  await expect(panel.getByText('Other recorded site links',{exact:true})).toBeVisible();
  await expect(panel.getByText(/PN-older · Earlier bid/)).toBeHidden();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify({passed:true,checks:['Automatic site for the first project at an address','Unique named site reused','No Link button or automatic writes','Exact-address peers','Permission denial preserves edits and previous links','Successful retry permits continued editing during list refresh','Current and selected projects follow saved address changes','Historical explicit site retained alongside the current address','Distinct bid files and unavailable explicit sources remain recorded'],timings,output:folder},null,2));
  console.log('PASS automatic project sites, exact-address peers, legacy links, edits, permission recovery and mobile layout: '+folder);
})().catch(async error=>{console.error(error,stderr,await page?.locator('#project-participants-panel').innerText().catch(()=>''));await page?.screenshot({path:path.join(folder,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
