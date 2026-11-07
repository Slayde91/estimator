// Projects hub, pointer and keyboard navigation use an isolated disposable app.
const {chromium, expect} = require('@playwright/test');
const {openProjectSection,openProjectTools} = require('./project_actions.cjs');
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
async function expectHub() {
  await expect(page.locator('#view-projects')).toBeVisible();
  const expectedSections = ['quotes', 'quote', 'work-orders', 'purchase-orders'];
  const cards = page.locator('#view-projects .projects-section-card');
  await expect(cards).toHaveCount(expectedSections.length);
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.projectSection)), expectedSections);
}
async function expectDocumentHub() {
  await expect(page.locator('#view-documents')).toBeVisible();
  const cards=page.locator('#view-documents .projects-section-card');await expect(cards).toHaveCount(3);
  assert.deepEqual(await cards.evaluateAll(nodes=>nodes.map(node=>node.dataset.documentSection)),['documentation','swms','certification']);
}
async function home() { await idle();await page.locator('nav .nav-button[data-view="home"]').click();await expect(page.locator('#view-home')).toBeVisible(); }
async function headerDestination(section) {
  await home();await page.locator(['documentation','swms','certification'].includes(section)?'#documents-navigation-toggle':'#projects-navigation-toggle').click();
  if (['documentation','swms','certification'].includes(section)) { await expectDocumentHub(); await page.locator('#documents-navigation-toggle').click(); }
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
  await page.locator('#projects-navigation-toggle').click();await expectHub();
  await page.locator('#documents-navigation-toggle').click();await expectDocumentHub();
  await page.locator('#view-documents [data-document-section="certification"]').click();
  await expect(page.locator('#view-certification')).toBeVisible();
  await expect(page.locator('#certification-client')).toBeEnabled();
  await page.locator('#certification-client').fill('Navigation draft retained');
  const draftBefore=await snapshot();
  await headerDestination('certification');
  const menu = page.locator('#projects-navigation-menu'), documentsMenu = page.locator('#documents-navigation-menu');
  await page.locator('#projects-navigation-toggle').hover();await expect(menu).toBeVisible();
  assert.deepEqual(await menu.locator('button').allTextContents(), ['Projects', 'Quotes', 'Work Orders', 'Purchase Orders']);
  await menu.locator('[data-project-section="quotes"]').click();
  await expect(page.locator('#view-quotes')).toBeVisible();
  await page.mouse.move(0,0);await expect(menu).toBeHidden();
  await headerDestination('quotes');assert.deepEqual(await snapshot(),draftBefore);
  await home();await page.locator('[data-home-view="projects"]').click();await expectHub();
  await headerDestination('quotes');await headerDestination('certification');
  await page.locator('#documents-navigation-toggle').hover();await expect(documentsMenu).toBeVisible();
  assert.deepEqual(await documentsMenu.locator('button').allTextContents(),['Documentation','SWMS','Certification']);
  await page.locator('#documents-navigation-toggle').click();await expectDocumentHub();
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
  evidence.checks.push('independent first-visit hubs and remembered destinations','Contacts beside Home and Documents beside Projects','explicit Home and Documents hub choices retain remembered destination','Certification draft survives all navigation','Cover sheets live only in Documentation','standalone Scheduler clock navigation','keyboard navigation and Escape');
  for (const width of [390,671,825,1084,1864]) {
    await page.setViewportSize({width,height:900});
    for(const owner of ['projects','documents']){
      await page.mouse.move(0,0);await page.locator(`#${owner}-navigation-toggle`).hover();const choices=page.locator(`#${owner}-navigation-menu`);await expect(choices).toBeVisible();
      const bounds=await choices.boundingBox();assert.ok(bounds.x>=-.1&&bounds.x+bounds.width<=width+.1,`${owner} menu stays in ${width}px viewport`);
      await page.screenshot({path:path.join(output,`${owner}-menu-${width}.png`)});evidence.widths.push({owner,width,bounds});await page.keyboard.press('Escape');
    }
    await openProjectSection(page,'quotes');await headerDestination('quotes');
    await openProjectSection(page,'certification');await headerDestination('certification');
    await openProjectSection(page,'documentation');await idle();await headerDestination('documentation');await idle();
    assert.deepEqual(await snapshot(),draftBefore,'Responsive navigation retains certificate draft, estimate details and pricing');
  }
  await page.reload();await idle();await page.locator('#projects-navigation-toggle').click();await expectHub();
  await page.locator('#documents-navigation-toggle').click();await expectDocumentHub();
  assert.deepEqual(await page.evaluate(() => ({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})), before);
  evidence.checks.push('fresh reload starts each hub despite old storage and in-session destinations');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...evidence, errors, passed: true}, null, 2));
  console.log(`PASS: first Projects hub, remembered destinations, hover/keyboard choices, draft preservation, reload and viewport fit. ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs);
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close(); server.kill(); });
