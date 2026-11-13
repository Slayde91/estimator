const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {createNewProject, openProjectSection} = require('./project_actions.cjs');

const root = path.resolve(__dirname, '../..');
const folder = path.join(root, '.runtime/browser-qa', 'documentation-commercial-drafts-' + Date.now());
fs.mkdirSync(folder, {recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [
  path.join(__dirname, 'project_documentation_fixture.py'), '--directory', folder
], {cwd:root, windowsHide:true});
let browser, serverLog = '';
server.stderr.on('data', value => { serverLog += value; });
const ready = new Promise((resolve, reject) => {
  let line = '';
  const timer = setTimeout(() => reject(Error('Fixture startup timed out. ' + serverLog)), 120000);
  server.on('error', reject);
  server.on('exit', () => { clearTimeout(timer); reject(Error(serverLog)); });
  server.stdout.on('data', value => {
    line += value;
    if (line.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(line.split('\n')[0])); }
  });
});

async function run() {
  const info = await ready;
  assert.notEqual(info.port, 8765);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const defaults = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/commercial/defaults') defaults.push(req.postDataJSON());
  });
  await page.goto('http://127.0.0.1:' + info.port);
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy);
  await createNewProject(page, {client:'Register draft owner', 'site-address':'45 Document Street'});
  const details = await page.evaluate(() => window.CeasefireProject.details());
  const workspace = await page.evaluate(() => window.CeasefireCertification.sessionId());
  assert.ok(details.project_no);

  const fetchState = async () => {
    const response = await page.request.get('http://127.0.0.1:' + info.port + '/api/commercial/state?workspace=' + workspace);
    assert.equal(response.status(), 200);
    return (await response.json()).documents;
  };
  const launchedIds = new Set();
  for (const [kind, hostId] of [['quote','quote'], ['work_order','work-order'], ['purchase_order','purchase-order']]) {
    const host = page.locator('#commercial-' + hostId + '-root');
    const openRow = async () => {
      await openProjectSection(page, 'documentation');
      const button = page.locator('button[data-document-kind="commercial.' + kind + '"]');
      await button.waitFor({state:'attached'});
      if (!await button.isVisible()) await page.locator('#documentation-pdf-rows').getByRole('button', {name:'Other documents', exact:true}).click();
      const title = {quote:'New Quote',work_order:'New Work Order',purchase_order:'New Purchase Order'}[kind];
      await expect(button).toHaveAccessibleName(title);
      await expect(button).toHaveAttribute('title',title);
      await expect(button).toContainText('New');
      const pdfButton = page.locator('#documentation-pdf-rows .documentation-download-button:visible').first();
      const [newSize, pdfSize] = await Promise.all([button.boundingBox(), pdfButton.boundingBox()]);
      assert.deepEqual([newSize.width, newSize.height], [pdfSize.width, pdfSize.height]);
      await expect(page.locator('button[data-revisions-kind="commercial.' + kind + '"]')).toBeVisible();
      await expect(button).toBeEnabled();
      await button.evaluate(el => { el.click(); el.click(); });
    };
    if (kind === 'quote') {
      let releaseRegister;
      const release = new Promise(resolve => { releaseRegister = resolve; });
      const loading = page.waitForRequest(req => new URL(req.url()).pathname === '/api/commercial/register');
      await page.route('**/api/commercial/register?**', async route => {
        await release; await route.continue();
      }, {times:1});
      try {
        await openRow();
        await loading;
        await page.locator('.nav-button[data-view="home"]').click();
        await expect(page.locator('#view-home')).toBeVisible();
      } finally { releaseRegister(); }
      await page.waitForFunction(() => !window.CeasefireDocumentation.hasPendingOperation());
      assert.equal(defaults.length, 0, 'Leaving the board while it opens must cancel draft creation.');
      await page.route('**/api/commercial/defaults', route => route.fulfill({
        status:503, contentType:'application/json', body:JSON.stringify({error:'Temporary test failure'})
      }), {times:1});
      await openRow();
      await expect(host.locator('.commercial-message')).toContainText('Temporary test failure');
      await expect(host.getByRole('button', {name:'New Quote', exact:true})).toBeEnabled();
      assert.equal((await fetchState()).length, 0);
    }
    for (const existing of [false, true]) {
      const count = defaults.length;
      await openRow();
      await expect(host.locator('.commercial-editor')).toBeVisible();
      await page.waitForFunction(() => !window.CeasefireDocumentation.hasPendingOperation());
      const view = await page.evaluate(() => JSON.parse(window.CeasefireCommercial.projectFingerprint()));
      assert.equal(view.workspace, workspace);
      assert.equal(view.editor.kind, kind);
      assert.equal(view.editor.version, 0);
      assert.equal(view.editor.status, 'Draft');
      assert.equal(view.editor.fields.details.project_no, details.project_no);
      assert.equal(view.editor.fields.details.client, details.client);
      assert.equal(view.editor.fields.details.site_address, details.site_address);
      assert.ok(!launchedIds.has(view.editor.id));
      launchedIds.add(view.editor.id);
      assert.equal(defaults.length, count + 1, 'A double-click must open exactly one draft.');
      assert.equal(defaults.at(-1).workspace_id, workspace);
      await expect(host.locator('.commercial-sidebar').first().locator('summary').first()).toHaveText('Linked Companies');
      if (!existing) {
        const saving = page.waitForResponse(r => new URL(r.url()).pathname === '/api/commercial/save');
        await host.locator('.commercial-editor-actions').getByRole('button', {name:'Save', exact:true}).click();
        assert.equal((await saving).status(), 200);
        await expect(host.locator('.commercial-message')).toContainText('Document saved.');
      } else {
        const saved = (await fetchState()).filter(row => row.kind === kind);
        assert.equal(saved.length, 1);
        assert.notEqual(saved[0].id, view.editor.id);
        await host.locator('.commercial-editor-actions button').first().click();
        await page.locator('#discard-dialog [value="cancel"]').click();
        await expect(host.locator('.commercial-editor')).toBeVisible();
        await host.locator('.commercial-editor-actions button').first().click();
        await page.locator('#discard-dialog [value="confirm"]').click();
      }
    }
  }
  assert.equal((await fetchState()).length, 3);
  assert.deepEqual(errors, []);
  console.log('PASS: All three Documentation actions opened fresh project-scoped drafts, preserved existing records and respected discard.');
}
run().catch(error => {console.error(error, serverLog); process.exitCode = 1;}).finally(async () => {
  await browser?.close(); server.kill();
});
