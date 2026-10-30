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
  await expect(page.locator('#view-projects .projects-section-card')).toHaveCount(2);
}
async function home() { await page.locator('nav .nav-button[data-view="home"]').click();await expect(page.locator('#view-home')).toBeVisible(); }
async function headerDestination(section) {
  await home();await page.locator('#projects-navigation-toggle').click();
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
  const before = await page.evaluate(() => ({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()}));
  await page.locator('#projects-navigation-toggle').click();await expectHub();
  await expect(page.locator('[data-projects-hub]')).toHaveCount(0);
  await page.locator('#view-projects [data-project-section="certification"]').click();
  await expect(page.locator('#view-certification')).toBeVisible();
  await expect(page.locator('#certification-client')).toBeEnabled();
  await page.locator('#certification-client').fill('Navigation draft retained');
  const draftBefore=await snapshot();
  await headerDestination('certification');
  await page.locator('#projects-navigation-toggle').hover();
  const menu = page.locator('#projects-navigation-menu');
  await expect(menu).toBeVisible();
  assert.deepEqual(await menu.locator('button').allTextContents(), ['Projects', 'Certification']);
  await menu.locator('[data-project-section="quotes"]').click();
  await expect(page.locator('#view-quotes')).toBeVisible();
  await page.mouse.move(0, 0); await expect(menu).toBeHidden();
  await headerDestination('quotes');assert.deepEqual(await snapshot(),draftBefore);
  // The explicit Home card still opens the two-card hub without replacing the
  // remembered subsection used by the header button.
  await home();await page.locator('[data-home-view="projects"]').click();await expectHub();
  await headerDestination('quotes');
  await home();await page.locator('[data-home-view="projects"]').click();await expectHub();
  await page.locator('#view-projects [data-project-section="certification"]').click();
  await expect(page.locator('#view-certification')).toBeVisible();
  await expect(page.locator('#certification-client')).toHaveValue('Navigation draft retained');
  await home();
  assert.equal(await openProjectTools(page),'home','Shared project helper explicitly opens saved projects after Certification was remembered');
  await expect(page.locator('#view-quotes')).toBeVisible();
  await openProjectSection(page,'certification');await expect(page.locator('#certification-client')).toHaveValue('Navigation draft retained');
  await home();
  await page.locator('#projects-navigation-toggle').focus();
  await page.locator('#projects-navigation-toggle').press('ArrowDown');
  await expect(menu.locator('[data-project-section="quotes"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.locator('[data-project-section="certification"]')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-quotes')).toBeVisible();
  await headerDestination('quotes');
  await page.locator('#projects-navigation-toggle').press('ArrowUp');
  await expect(menu.locator('[data-project-section="certification"]')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
  await expect(page.locator('#projects-navigation-toggle')).toBeFocused();
  await page.locator('#projects-navigation-toggle').press('ArrowUp');await page.keyboard.press('Enter');await expect(page.locator('#view-certification')).toBeVisible();
  await headerDestination('certification');assert.deepEqual(await snapshot(),draftBefore);
  evidence.checks.push('stale section preference ignored','first header visit opens hub','header returns to most recent Certification or saved Projects page','Home Projects card still opens hub','both cards work','hover choices update remembered page','shared helpers select explicit destinations','certification draft retained','return buttons removed','keyboard navigation and Escape');
  for (const width of [390, 671, 1084]) {
    await page.setViewportSize({width, height: 900});
    await page.mouse.move(0, 0);
    await page.locator('#projects-navigation-toggle').hover();
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `Projects menu stays in ${width}px viewport`);
    await page.screenshot({path: path.join(output, `projects-menu-${width}.png`)});
    evidence.widths.push({width, bounds});
    await page.keyboard.press('Escape');
    await openProjectSection(page,'quotes');await headerDestination('quotes');
    await openProjectSection(page,'certification');await headerDestination('certification');
    assert.deepEqual(await snapshot(),draftBefore,'Responsive navigation retains exact certificate draft, estimate details and pricing');
  }
  await page.reload(); await idle(); await page.locator('#projects-navigation-toggle').click();await expectHub();
  assert.deepEqual(await page.evaluate(() => ({configuration:window.CeasefireProject.configuration(),details:window.CeasefireProject.details()})), before);
  evidence.checks.push('fresh reload starts at hub despite old storage and previous in-session destination');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...evidence, errors, passed: true}, null, 2));
  console.log(`PASS: first Projects hub, remembered destinations, hover/keyboard choices, draft preservation, reload and viewport fit. ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs);
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output,'server.log'),logs);await browser?.close(); server.kill(); });
