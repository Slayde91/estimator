// Synthetic native DFT exercises the actual transfer/receipt/projection UI.
// Private table accuracy is tested separately; every saved file is disposable.
const { chromium, expect } = require('@playwright/test');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `intumescent-transfer-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'intumescent_transfer_fixture.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error(`Fixture startup timed out: ${logs}`)), 120000);
  server.stdout.on('data', value => { text += value; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${logs}`)); });
});
const errors = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
const calculators = () => page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
const row = id => page.locator(`tr[data-item-id="${id}"]`);
const thickness = id => page.locator(`td[data-thickness-item-id="${id}"]`);
async function snapshot() {
  const captured = await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot(); } catch { return false; } });
  try { return await captured.jsonValue(); } finally { await captured.dispose(); }
}
async function response(action, suffix) {
  const pending = page.waitForResponse(value => value.url().endsWith(suffix)); pending.catch(() => {});
  await action(); const reply = await pending, body = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(body)); await idle(); return body;
}
async function calculator() {
  await page.getByRole('button', { name: 'Calculators', exact: true }).hover();
  await page.locator('#steel-calculator-navigation-toggle').click();
  await page.locator('#steel-calculator-navigation-menu').getByRole('button', { name: 'Steel (intumescent)', exact: true }).click();
  await page.locator('#calculator-pages').getByRole('button', { name: 'SCHEDULE', exact: true }).click();
  await expect(page.locator('#calculator-grid')).not.toHaveAttribute('aria-busy', 'true');
}
async function editInput(address, value) {
  await calculator();
  const input = page.locator(`[data-calculator-sheet="SCHEDULE"][data-calculator-cell="${address}"]`);
  await input.fill(String(value)); await input.press('Tab');
  await expect.poll(async () => (await calculators()).steel_intumescent.inputs.SCHEDULE[address], { timeout: 15000, message: `Native input ${address} retains the supplied literal` }).toBe(value);
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
}
async function transfer(id) {
  const selectAll = page.getByRole('checkbox', { name: 'Select all matching items', exact: true }); await selectAll.check(); await selectAll.uncheck();
  await row(id).getByRole('checkbox', { name: /^Select / }).check();
  await response(() => page.getByRole('button', { name: 'Preview transfer', exact: true }).click(), '/transfer-preview');
  return response(() => page.getByRole('dialog').getByRole('button', { name: 'Add to schedule', exact: true }).click(), '/transfer-apply');
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); assert.equal(info.synthetic, true);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push(event.effectiveDirective)); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  // A manual row must survive all subsequent Takeoff appends and Save/Load.
  await calculator();
  const manual = page.locator('[data-calculator-sheet="SCHEDULE"][data-calculator-cell="A10"]');
  await manual.fill('MANUAL-PRESERVED'); await manual.press('Tab');
  await editInput('J10', .123456789012345);
  await page.locator('#takeoff-upload').setInputFiles(info.fixture);
  await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  await page.waitForFunction(() => { try { return window.CeasefireTakeoffs.projectSnapshot().render_checks.some(check => check.page === 1 && check.success); } catch { return false; } });
  const members = await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, session = takeoffs.sessionId(); let current = takeoffs.projectSnapshot();
    const doc = current.documents[0], members = [];
    const command = async (op, values) => {
      const reply = await fetch(`/api/takeoffs/sessions/${session}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op, ...values }) });
      const result = await reply.json(); if (!reply.ok) throw Error(JSON.stringify(result)); current = result.snapshot;
    };
    for (const [index, product] of ['Nullifire SC902', 'FIRETEX FX5090', 'FIRETEX FX6010', 'FIRETEX FX6010'].entries()) {
      const held = index === 3, length = 7.123456789012345;
      await command('create_item', { item: { mode: 'steel', geometry: { document_id: doc.id, page: 1, points: [[100, 400-index*65], [500, 400-index*65]] },
        measurement: { method: 'cited', length_m: length, citation: 'Synthetic explicit per-member dimension' }, quantity: 3,
        fields: { mark: held ? 'UNASSESSED-COLUMN' : `INTUM-${index+1}`, product, section: '360UB45', member_type: held ? 'Column' : 'Beam', exposure: held ? 'I/H column - 3 sides' : 'I/H beam - 3 sides', critical_temperature: 550, fire_period_min: 60 },
        evidence: [{ document_id: doc.id, page: 1, note: 'Synthetic transfer fixture only' }] } });
      members.push({ id: current.items.at(-1).id, product, length, held });
    }
    await command('confirm_items', { item_ids: members.map(member => member.id) });
    takeoffs.applyProject(await takeoffs.prepareProject(current, session)); await takeoffs.open(); return members;
  });
  const destination = page.getByLabel('Destination schedule', { exact: true });
  await expect(destination.locator('option')).toHaveText(['Steel Spray Schedule', 'Steel Intumescent Schedule', 'Steel Board Schedule']);
  await destination.selectOption('steel_intumescent');
  evidence.members = [];
  for (const member of members) {
    const transferred = await transfer(member.id), binding = transferred.snapshot.transfers.find(value => value.item_id === member.id);
    const drafts = await calculators(), inputs = drafts.steel_intumescent.inputs.SCHEDULE;
    assert.ok(binding.row > 10); assert.equal(binding.sheet, 'SCHEDULE');
    assert.equal(inputs[`I${binding.row}`], 3); assert.equal(inputs[`J${binding.row}`], member.length);
    assert.equal(inputs[`B${binding.row}`], member.product);
    assert.equal(inputs.A10, 'MANUAL-PRESERVED'); assert.equal(inputs.J10, .123456789012345);
    const native = await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/steel_intumescent/calculate`, { data: { inputs: drafts.steel_intumescent.inputs, sheet: 'SCHEDULE', start_row: binding.row, row_count: 1 } });
    assert.equal(native.status(), 200); const cells = (await native.json()).rows.flatMap(row => row.cells), cell = column => cells.find(value => value.address === column+binding.row).value;
    if (member.held) {
      assert.equal(cell('O'), ''); assert.equal(cell('V'), 'CONFIRM ASSESSMENT');
      await expect(thickness(member.id)).toHaveText('Unavailable');
      await expect(thickness(member.id)).toHaveAttribute('title', /CONFIRM ASSESSMENT/);
    } else {
      const mm = cell('O') / 1000; assert.equal(cell('O'), info.dft_um[member.product]);
      assert.notEqual(mm, cell('P') / 1000);
      await expect(thickness(member.id)).toHaveText(String(mm));
      await expect(thickness(member.id)).toHaveAttribute('title', /Dry film thickness:.*SYNTHETIC TRANSFER FIXTURE.*Calculator source SHA-256/);
      assert.equal(await thickness(member.id).locator('input').count(), 0);
      evidence.members.push({ ...member, row: binding.row, dft_um: cell('O'), thickness_mm: mm });
    }
  }
  await page.screenshot({ path: path.join(output, 'intumescent-linked-dft.png') });
  const first = evidence.members[0];
  await thickness(first.id).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'intumescent-linked-dft-values.png') });
  await editInput(`J${first.row}`, first.length + .125); await expect(thickness(first.id)).toHaveText('Unavailable');
  await expect(thickness(first.id)).toHaveAttribute('title', /linked row was edited/);
  await editInput(`J${first.row}`, first.length); await expect(thickness(first.id)).toHaveText(String(first.thickness_mm));
  const before = await snapshot(), draftsBefore = await calculators();
  await response(() => clickProjectControl(page, 'Save'), '/api/project/save-as');
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  await destination.selectOption('steel_intumescent');
  await expect(thickness(first.id)).toHaveText(String(first.thickness_mm));
  assert.deepEqual((await snapshot()).transfers, before.transfers); assert.deepEqual(await calculators(), draftsBefore);
  evidence.dirtyRowWithheld = true; evidence.exactRestoreRechecked = true; evidence.savedDraftAndLinksPreserved = true; evidence.unassessedColumnHeld = true;
  const csp = await page.evaluate(() => window.qaCsp); assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, synthetic: true, evidence, errors, csp, savedProject: info.project }, null, 2));
  console.log(`PASS: all intumescent destinations transfer exact members, return native DFT/1000 mm, withhold edited/unassessed rows, preserve manual row and Save/Load. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-4000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(output, 'failure-calculators.json'), JSON.stringify(await calculators().catch(() => ({})), null, 2)); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
