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
  await expect(page.locator('.project-kanban-column')).toHaveCount(5);
  await expect(page.locator('.project-kanban-card')).toHaveCount(6);
  const first = page.locator('.project-kanban-card').filter({hasText:'Project 1'});
  await first.dragTo(page.locator('.project-kanban-column[data-status="Review"]'));
  await expect(page.locator('.project-kanban-column[data-status="Review"] .project-kanban-card')).toHaveCount(2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status,'Review');
  await page.locator('.project-columns-menu summary').click();
  await page.locator('#project-column-options label').filter({hasText:'Lost'}).locator('input').uncheck();
  await expect(page.locator('.project-kanban-column')).toHaveCount(4);
  await page.reload(); await idle(); await projects();
  await expect(page.locator('.project-kanban-column')).toHaveCount(4);
  await page.locator('#project-search').fill('Project 1');
  await expect(page.locator('.project-kanban-card')).toHaveCount(1);
  await page.locator('#project-sort').selectOption('name_asc');
  await expect(page.locator('.project-kanban-card')).toHaveCount(1);
  await page.locator('.project-card-menu summary').click();
  await page.locator('.project-card-menu').getByRole('button',{name:'Open',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Load Project',exact:true}).click();
  await expect(page.locator('#project-status')).toHaveValue('Review');
  await page.locator('#project-status').selectOption('Accepted');
  await idle();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(output,'Project-1.cf.json'))).project_status).toBe('Accepted');
  await projects(); await page.locator('#project-search').fill('');
  await expect(page.locator('.project-kanban-card')).toHaveCount(5);
  await page.screenshot({path:path.join(output,'kanban-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'kanban-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  await page.setViewportSize({width:1575,height:1000});
  const second = page.locator('.project-kanban-card').filter({hasText:'Project 2'});
  await second.locator('summary').click();
  await second.getByRole('button',{name:'Delete',exact:true}).click();
  await page.locator('#discard-dialog').getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.project-kanban-card')).toHaveCount(4);
  assert.equal(fs.existsSync(path.join(output,'Project-2.cf.json')),false);
  assert.ok(fs.readdirSync(output).some(name=>name.startsWith('.ceasefire-deleted-')));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,checks:['drag persists','column visibility persists','search and sort','open and header status','responsive layout','recoverable deletion','no browser errors']}));
})().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output,'failure.txt'),`${error.stack}\n${logs}`);
  if (page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.kill(); });
