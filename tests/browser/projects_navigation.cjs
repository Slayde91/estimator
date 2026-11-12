// Project and document navigation use an isolated disposable app.
const {chromium, expect} = require('@playwright/test');
const {openProjectSection,openProjectTools,clickProjectControl,prepareProjectForSave} = require('./project_actions.cjs');
const {openCertificateEditor}=require('./certification_generation.cjs');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `projects-navigation-${Date.now()}`);
fs.mkdirSync(output, {recursive: true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd: root, windowsHide: true});
let logs = '', browser, page;
server.stderr.on('data', value => logs += value);
const ready = new Promise((resolve, reject) => {
  let data = '';
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')), 120000);
  server.stdout.on('data', value => { data += value; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
  server.once('error', reject);
  server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
});
const errors = [], evidence = {widths: [], checks: []};
async function idle() { await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function expectSavedProjects() {
  await expect(page.locator('#view-projects')).toHaveCount(0);
  await expect(page.locator('#view-quotes')).toBeVisible();
  await expect(page.locator('#project-pages [aria-current="page"]')).toHaveAttribute('data-project-section','quotes');
}
async function expectDocumentDestination(section='documentation') {
  await expect(page.locator('#view-documents')).toHaveCount(0);
  await expect(page.locator('#view-'+section)).toBeVisible();
  await expect(page.locator('#document-pages [aria-current="page"]')).toHaveAttribute('data-document-section',section);
}
async function home() { await idle();await page.locator('nav .nav-button[data-view="home"]').click();await expect(page.locator('#view-home')).toBeVisible(); }
async function headerDestination(section) {
  await home();await page.locator(['documentation','swms','certification'].includes(section)?'#documents-navigation-toggle':'#projects-navigation-toggle').click();
  if (['documentation','swms','certification'].includes(section)) await expectDocumentDestination(section);
  await expect(page.locator('#view-'+section)).toBeVisible();
  if(section==='certification')await expect(page.locator('#certification-client')).toHaveValue('Navigation draft retained');
}
async function snapshot() { return page.evaluate(()=>({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details(),certificate:window.CeasefireCertification.projectFingerprint()})); }
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({headless: true});
  page = await browser.newPage({viewport: {width: 1084, height: 764}});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('ceasefire.projects.section', 'certification');
    window.qaCsp = [];
    document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective));
  });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  assert.deepEqual(await page.locator('nav[aria-label="Main navigation"] [data-view]').evaluateAll(nodes => nodes.slice(0,4).map(el=>el.dataset.view)), ['home','contacts','projects','documents']);
  const before = await page.evaluate(() => ({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));
  await page.locator('#projects-navigation-toggle').click();await expectSavedProjects();
  await idle();await page.screenshot({path:path.join(output,'projects-first-saved-files.png')});
  await page.locator('#documents-navigation-toggle').click();
  await expect(page.locator('#app-message')).toContainText('Create or load a project before creating documents.');
  await expectSavedProjects();await expect(page.locator('#view-documentation')).toBeHidden();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),false);
  assert.equal(fs.existsSync(info.project),false);
  assert.deepEqual(await page.evaluate(()=>({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})),before);
  evidence.checks.push('Documentation requires a saved Project and leaves the current workspace unchanged when denied');
  // Use the real native Save As fixture; client-side identity fields cannot
  // grant the Project permission needed by subsequent Documentation navigation.
  await prepareProjectForSave(page);
  const saving=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');
  await clickProjectControl(page,'Save');const saved=await saving;assert.equal(saved.status(),200,await saved.text());
  const receipt=await saved.json();assert.equal(receipt.cancelled,false);assert.ok(receipt.file.save_token);await idle();
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),true);
  assert.equal(JSON.parse(fs.readFileSync(info.project)).estimate.project_no,receipt.file.project_no);
  assert.ok(receipt.file.project_no);
  await page.locator('#documents-navigation-toggle').click();await expectDocumentDestination();
  await page.locator('#document-pages [data-document-section="certification"]').click();
  await expect(page.locator('#view-certification')).toBeVisible();
  await expect(page.locator('#certification-board')).toHaveCount(0);await expect(page.locator('#certification-editor')).toBeVisible();
  await openCertificateEditor(page);
  await expect(page.locator('#certification-client')).toBeEnabled();
  await page.locator('#certification-client').fill('Navigation draft retained');
  const draftBefore=await snapshot();
  await page.locator('#certification-back').click();await expect(page.locator('#view-documentation')).toBeVisible();
  await expect(page.locator('#certification-editor')).toBeHidden();
  await page.locator('#document-pages [data-document-section="certification"]').click();await openCertificateEditor(page);await expect(page.locator('#certification-client')).toHaveValue('Navigation draft retained');
  assert.deepEqual(await snapshot(),draftBefore,'Back and Resume preserve the exact certificate draft and project state');
  await headerDestination('certification');
  const menu = page.locator('#projects-navigation-menu'), documentsMenu = page.locator('#documents-navigation-menu');
  await page.locator('#projects-navigation-toggle').hover();await expect(menu).toBeVisible();
  assert.deepEqual(await menu.locator('button').allTextContents(), ['Projects', 'Quotes', 'Work Orders', 'Purchase Orders']);
  await menu.locator('[data-project-section="quotes"]').click();
  await expect(page.locator('#view-quotes')).toBeVisible();
  await page.mouse.move(0,0);await expect(menu).toBeHidden();
  const tabs=page.locator('#project-pages'),sections=['quotes','quote','work-orders','purchase-orders'];
  assert.deepEqual(await tabs.locator('button').allTextContents(),['Projects','Quotes','Work Orders','Purchase Orders']);
  const tabStyles=nav=>{const style=getComputedStyle(nav);return Object.fromEntries(['height','minHeight','paddingTop','paddingBottom','alignItems','backgroundColor'].map(key=>[key,style[key]]));};
  await page.locator('#contacts-navigation-toggle').click();await expect(page.locator('.contacts-tabs')).toBeVisible();
  const contactsTabStyles=await page.locator('.contacts-tabs').evaluate(tabStyles);
  await openProjectSection(page,'quotes');assert.deepEqual(await tabs.evaluate(tabStyles),contactsTabStyles,'Project tabs share Contacts tab styling');
  for(const section of [...sections,'quotes']){
    await tabs.locator(`[data-project-section="${section}"]`).click();await idle();
    await expect(page.locator('#view-'+section)).toBeVisible();await expect(tabs).toBeVisible();
    await expect(tabs.locator('[aria-current="page"]')).toHaveAttribute('data-project-section',section);
    assert.equal(await tabs.evaluate(nav=>nav.previousElementSibling?.classList.contains('page-heading')),true,'Tabs follow the active page heading');
    assert.equal(await page.locator('#project-pages').count(),1);assert.deepEqual(await snapshot(),draftBefore);
  }
  evidence.checks.push('Projects tabs open all four sections, retain one navigation element after render, and keep the current Project and drafts');
  await headerDestination('quotes');assert.deepEqual(await snapshot(),draftBefore);
  await openProjectSection(page,'work-orders');await headerDestination('work-orders');
  await home();await page.locator('[data-home-view="projects"]').click();await expect(page.locator('#view-work-orders')).toBeVisible();
  const work=page.locator('#view-work-orders');
  await work.getByRole('button',{name:'New Work Order',exact:true}).click();
  const cost=work.getByLabel('Estimated cost (AUD)',{exact:true});await cost.fill('182.47');
  await page.locator('#projects-navigation-toggle').click();
  await expect(cost).toHaveValue('182.47');await expect(page.locator('#discard-dialog')).toBeHidden();
  await tabs.locator('[data-project-section="quotes"]').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(cost).toHaveValue('182.47');
  await expect(tabs.locator('[aria-current="page"]')).toHaveAttribute('data-project-section','work-orders');
  await tabs.locator('[data-project-section="quotes"]').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  await expectSavedProjects();
  await openProjectSection(page,'quotes');
  await headerDestination('quotes');await headerDestination('certification');
  await page.locator('#documents-navigation-toggle').hover();await expect(documentsMenu).toBeVisible();
  assert.deepEqual(await documentsMenu.locator('button').allTextContents(),['Documentation','SWMS','Certification']);
  await page.locator('#documents-navigation-toggle').click();await expectDocumentDestination('certification');
  await headerDestination('certification');
  await home();assert.equal(await openProjectTools(page),'home');await expect(page.locator('#view-quotes')).toBeVisible();
  await openProjectSection(page,'certification');await expect(page.locator('#certification-client')).toHaveValue('Navigation draft retained');
  for(const [owner,first,last] of [['projects','quotes','purchase-orders'],['documents','documentation','certification']]){
    await home();const toggle=page.locator(`#${owner}-navigation-toggle`), choices=page.locator(`#${owner}-navigation-menu`), attr=owner==='documents'?'document':'project';
    await toggle.focus();await toggle.press('ArrowDown');await expect(choices.locator(`[data-${attr}-section="${first}"]`)).toBeFocused();
    await page.keyboard.press('End');await expect(choices.locator(`[data-${attr}-section="${last}"]`)).toBeFocused();
    await page.keyboard.press('Home');await page.keyboard.press('Enter');await expect(page.locator('#view-'+first)).toBeVisible();
    await toggle.press('ArrowUp');await expect(choices.locator(`[data-${attr}-section="${last}"]`)).toBeFocused();
    await page.keyboard.press('Escape');await expect(choices).toBeHidden();await expect(toggle).toBeFocused();
  }
  await openProjectSection(page,'documentation');await idle();await headerDestination('documentation');
  await expect(page.locator('#view-documentation #cover-sheets-settings')).toBeVisible();
  await expect(page.locator('#view-settings #cover-sheets-settings')).toHaveCount(0);
  await openProjectSection(page,'scheduler');await expect(page.locator('#scheduler-navigation')).toHaveAttribute('aria-current','page');
  await expect(page.locator('#projects-navigation-menu [data-project-section="scheduler"]')).toHaveCount(0);
  await headerDestination('documentation');await headerDestination('quotes');
  assert.deepEqual(await snapshot(),draftBefore);
  const documentTabs=page.locator('#document-pages'),documentSections=['documentation','swms','certification'];
  for(const section of documentSections){
    await openProjectSection(page,section);await idle();
    await expect(documentTabs).toBeVisible();
    assert.deepEqual(await documentTabs.locator('button').allTextContents(),['Documentation','SWMS','Certification']);
    await expect(documentTabs.locator('[aria-current="page"]')).toHaveAttribute('data-document-section',section);
    assert.equal(await documentTabs.count(),1,'Only one document navigation element is retained');
    assert.equal(await documentTabs.evaluate(nav=>Boolean(nav.closest('#swms-root'))),false,'SWMS cannot replace its navigation when rendering');
    await expect(page.locator('#view-'+section+' .eyebrow').filter({hasText:'DOCUMENTS'})).toHaveCount(0);
    const next=documentSections[(documentSections.indexOf(section)+1)%documentSections.length];
    const button=documentTabs.locator(`[data-document-section="${next}"]`);await button.focus();await button.press('Enter');
    await expect(page.locator('#view-'+next)).toBeVisible();
    await expect(documentTabs.locator('[aria-current="page"]')).toHaveAttribute('data-document-section',next);
  }
  await documentTabs.locator('[data-document-section="swms"]').click();
  const swms=page.locator('#swms-root');await swms.getByRole('button',{name:'New SWMS',exact:true}).click();
  await swms.getByLabel('Project Name',{exact:true}).fill('Document tab guard QA');
  await documentTabs.locator('[data-document-section="documentation"]').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#view-swms')).toBeVisible();await expect(documentTabs).toBeVisible();
  await expect(documentTabs.locator('[aria-current="page"]')).toHaveAttribute('data-document-section','swms');
  await expect(swms.getByLabel('Project Name',{exact:true})).toHaveValue('Document tab guard QA');
  await documentTabs.locator('[data-document-section="documentation"]').click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Yes',exact:true}).click();
  await expect(page.locator('#view-documentation')).toBeVisible();await expect(documentTabs).toBeVisible();
  await expect(documentTabs.locator('[aria-current="page"]')).toHaveAttribute('data-document-section','documentation');
  await openProjectSection(page,'quotes');assert.deepEqual(await snapshot(),draftBefore);
  evidence.checks.push('Three shared Document tabs retain active state through real keyboard navigation and SWMS list/editor rebuilds; Cancel preserves an unsaved statement and Yes discards only after confirmation');
  evidence.checks.push('saved Projects opens first, with independent remembered destinations','Contacts beside Home and Documents beside Projects','Home entry and Documents navigation retain their last child','Certification draft survives all navigation','Cover sheets live only in Documentation','standalone Scheduler clock navigation','keyboard navigation and Escape');
  for (const width of [390,671,825,1084,1864]) {
    await page.setViewportSize({width,height:900});
    for(const owner of ['projects','documents']){
      await page.mouse.move(0,0);await page.locator(`#${owner}-navigation-toggle`).hover();const choices=page.locator(`#${owner}-navigation-menu`);await expect(choices).toBeVisible();
      const bounds=await choices.boundingBox();assert.ok(bounds.x>=-.1&&bounds.x+bounds.width<=width+.1,`${owner} menu stays in ${width}px viewport`);
      await page.screenshot({path:path.join(output,`${owner}-menu-${width}.png`)});evidence.widths.push({owner,width,bounds});await page.keyboard.press('Escape');
    }
    await openProjectSection(page,'quotes');await headerDestination('quotes');
    const tabGeometry=await tabs.evaluate(nav=>({width:nav.getBoundingClientRect().width,left:nav.getBoundingClientRect().left,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,buttons:[...nav.children].map(button=>({height:button.getBoundingClientRect().height,padding:getComputedStyle(button).padding,font:getComputedStyle(button).font,background:getComputedStyle(button).backgroundColor}))}));
    assert.ok(tabGeometry.left>=0&&tabGeometry.width<=width&&tabGeometry.scrollWidth<=width,JSON.stringify(tabGeometry));
    assert.ok(tabGeometry.buttons.every(button=>button.height===tabGeometry.buttons[0].height),JSON.stringify(tabGeometry));
    evidence.widths.push({owner:'project-tabs',width,...tabGeometry});
    await openProjectSection(page,'certification');await headerDestination('certification');
    await openProjectSection(page,'documentation');await idle();await headerDestination('documentation');await idle();
    const documentGeometry=await documentTabs.evaluate(nav=>({width:nav.getBoundingClientRect().width,left:nav.getBoundingClientRect().left,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,buttons:[...nav.children].map(button=>({height:button.getBoundingClientRect().height}))}));
    assert.ok(documentGeometry.left>=0&&documentGeometry.width<=width&&documentGeometry.scrollWidth<=width,JSON.stringify(documentGeometry));
    assert.ok(documentGeometry.buttons.every(button=>button.height===40),JSON.stringify(documentGeometry));
    evidence.widths.push({owner:'document-tabs',width,...documentGeometry});
    if([390,1864].includes(width)){
      await page.screenshot({path:path.join(output,`documentation-tabs-${width}.png`)});
      await documentTabs.locator('[data-document-section="swms"]').click();
      await expect(page.locator('#swms-root').getByRole('button',{name:'New SWMS',exact:true})).toBeVisible();
      assert.equal(await documentTabs.evaluate(nav=>nav.previousElementSibling?.classList.contains('page-heading')),true,'Document tabs consistently follow the page heading');
      await page.screenshot({path:path.join(output,`swms-tabs-${width}.png`)});
      await documentTabs.locator('[data-document-section="documentation"]').click();await idle();
    }
    assert.deepEqual(await snapshot(),draftBefore,'Responsive navigation retains certificate draft, estimate details and pricing');
  }
  await page.reload();await idle();await page.locator('#projects-navigation-toggle').click();await expectSavedProjects();
  await page.locator('#documents-navigation-toggle').click();await expectSavedProjects();await expect(page.locator('#app-message')).toContainText('Create or load a project before creating documents.');
  assert.deepEqual(await page.evaluate(() => ({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})), before);
  evidence.checks.push('Fresh reload opens saved Projects and direct Documentation navigation retains the created-project guard');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...evidence, errors, passed: true}, null, 2));
  console.log(`PASS: saved Projects, remembered destinations, hover/keyboard choices, draft preservation, reload and viewport fit. ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs);
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close(); server.kill(); });
