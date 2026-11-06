const {chromium, expect} = require('@playwright/test');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `project-status-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'project_status_fixture.py'), output], {cwd:root, windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(() => reject(new Error(`Fixture timeout ${logs}`)), 120000);
  server.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(stdout.split('\n')[0])); }
  });
  server.once('error', reject);
  server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code} ${logs}`)); });
});
const errors = [];
async function projects() {
  await page.locator('nav[aria-label="Main navigation"] button[data-view="projects"]').click();
  if (await page.locator('#view-projects').isVisible()) await page.locator('#view-projects [data-project-section="quotes"]').click();
  await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'false');
}
async function idle() {
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready && !window.CeasefireDesktop.status().busy);
}

(async () => {
  const info = await ready;
  assert.notEqual(info.port, 8765);
  browser = await chromium.launch({headless:true, ...(process.env.CEASEFIRE_BROWSER_PATH ? {executablePath:process.env.CEASEFIRE_BROWSER_PATH} : {})});
  page = await browser.newPage({viewport:{width:1575, height:1000}});
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle(); await projects();
  await expect(page.locator('.project-kanban-column')).toHaveCount(0);
  await expect(page.locator('.project-columns-menu')).toHaveCount(0);
  await expect(page.locator('.project-list-row')).toHaveCount(6);
  assert.equal(await page.locator('#project-list [draggable="true"]').count(),0);
  const first = page.locator('.project-list-row').filter({hasText:'Project 1'});
  await first.locator('summary').click();
  await first.getByRole('combobox',{name:'Status for Project 1',exact:true}).selectOption('Review');
  await expect(first.locator('.project-row-status')).toHaveText('Review');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status,'Review');
  await page.evaluate(()=>localStorage.setItem('classifire.projectColumns','[]'));
  await page.reload(); await idle(); await projects();
  await expect(page.locator('.project-list-row')).toHaveCount(6);
  await page.locator('#project-search').fill('Project 1');
  await expect(page.locator('.project-list-row')).toHaveCount(1);
  await page.locator('#project-sort').selectOption('name_asc');
  await expect(page.locator('.project-list-row')).toHaveCount(1);
  await page.locator('.project-list-row').getByRole('button',{name:'Open project',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-status-review')).toHaveAttribute('aria-checked','true');
  await expect(page.locator('#project-status')).toHaveText('Status');
  const status=page.locator('#project-status');
  const documentToggle=page.locator('[aria-controls="firestopping-document-actions"]');
  const statusBox=await status.boundingBox(), documentBox=await documentToggle.boundingBox();
  assert.equal(statusBox.height,documentBox.height);
  assert.ok(Math.abs(statusBox.y-documentBox.y)<1);
  await status.focus();await status.press('ArrowDown');
  await expect(page.locator('#project-status-draft')).toBeFocused();
  await expect(page.locator('#project-status-review')).toHaveAttribute('aria-checked','true');
  assert.deepEqual(await page.locator('#project-status-options button').allTextContents(),['Draft','Review','Presented','Accepted','Lost']);
  await page.locator('#project-status-options').press('Escape');
  await expect(status).toBeFocused();await expect(status).toHaveAttribute('aria-expanded','false');
  await status.click();await page.locator('#estimate-heading').click();
  await expect(status).toHaveAttribute('aria-expanded','false');
  await status.click();await page.locator('#project-status-accepted').click();
  await idle();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status).toBe('Accepted');
  await expect(status).toHaveText('Status');
  await expect(page.locator('#project-status-accepted')).toHaveAttribute('aria-checked','true');
  await expect(page.locator('#project-estimate-new')).toHaveAttribute('aria-label','New estimate');
  assert.equal(await page.locator('#project-estimate-new .button-symbol').textContent(),await page.locator('#penetration-estimator-add .button-symbol').textContent());
  for(const width of [320,390,1254,1915]) {
    await page.setViewportSize({width,height:1000});
    await status.click();
    const menuBounds=await page.locator('#project-status-options').boundingBox();
    assert.ok(menuBounds.x>=0&&menuBounds.x+menuBounds.width<=width,'Status menu fits '+width);
    await status.press('Escape');
  }
  await page.setViewportSize({width:1575,height:1000});
  await projects(); await page.locator('#project-search').fill('');
  await expect(page.locator('.project-list-row')).toHaveCount(6);
  await page.screenshot({path:path.join(output,'projects-list-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'projects-list-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  await page.setViewportSize({width:1575,height:1000});
  const second = page.locator('.project-list-row').filter({hasText:'Project 2'});
  await second.locator('summary').click();
  await second.getByRole('button',{name:'Delete',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.project-list-row')).toHaveCount(5);
  assert.equal(fs.existsSync(path.join(output,'Project-2.cf.json')),false);
  assert.ok(fs.readdirSync(output).some(name=>name.startsWith('.ceasefire-deleted-')));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,checks:['flat list retains all statuses','obsolete column preferences do not hide projects','search and sort','open and accessible header status menu','responsive layout','recoverable deletion','no browser errors']}));
})().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);
  if (page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); });
