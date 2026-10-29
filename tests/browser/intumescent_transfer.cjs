// Synthetic native DFT exercises the actual transfer/receipt/projection UI.
// Private table accuracy is tested separately; every saved file is disposable.
const { chromium, expect } = require('@playwright/test');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn, spawnSync } = require('node:child_process');
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
      const threeSidedColumn = index === 3, length = 7.123456789012345;
      await command('create_item', { item: { mode: 'steel', geometry: { document_id: doc.id, page: 1, points: [[100, 400-index*65], [500, 400-index*65]] },
        measurement: { method: 'cited', length_m: length, citation: 'Synthetic explicit per-member dimension' }, quantity: 3,
        fields: { mark: threeSidedColumn ? 'COLUMN-ESTIMATE' : `INTUM-${index+1}`, product, section: '360UB45', member_type: threeSidedColumn ? 'Column' : 'Beam', exposure: threeSidedColumn ? 'I/H column - 3 sides' : 'I/H beam - 3 sides', critical_temperature: 550, fire_period_min: 60 },
        evidence: [{ document_id: doc.id, page: 1, note: 'Synthetic transfer fixture only' }] } });
      members.push({ id: current.items.at(-1).id, product, length, threeSidedColumn });
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
    const mm = cell('O') / 1000; assert.equal(cell('O'), (member.threeSidedColumn ? info.column_dft_um : info.dft_um)[member.product]);
    assert.notEqual(mm, cell('P') / 1000);
    await expect(thickness(member.id)).toHaveText(String(mm));
    await expect(thickness(member.id)).toHaveAttribute('title', /Dry film thickness:.*SYNTHETIC TRANSFER FIXTURE.*Calculator source SHA-256/);
    assert.equal(await thickness(member.id).locator('input').count(), 0);
    if (member.threeSidedColumn) {
      assert.equal(cell('V'), 'ESTIMATE - FOUR-SIDED COLUMN TABLE');
      assert.match(cell('X'), /case R4;/);
      await expect(thickness(member.id)).toHaveAttribute('title', /ESTIMATE - FOUR-SIDED COLUMN TABLE/);
      const beam = evidence.members.find(value => value.product === member.product && !value.threeSidedColumn);
      assert.equal(cell('M'), beam.input_factor_m_inv);
      assert.equal(cell('Q'), beam.girth_m); assert.equal(cell('R'), beam.area_m2);
      assert.ok(Math.abs(cell('S') - cell('R') * mm / .92) < 1e-10, 'Quantity uses three-sided area and selected DFT');
      const fourInputs = structuredClone(drafts.steel_intumescent.inputs); fourInputs.SCHEDULE[`C${binding.row}`] = 'I/H column - 4 sides';
      const fourResponse = await page.request.post(`http://127.0.0.1:${info.port}/api/calculators/steel_intumescent/calculate`, { data: { inputs: fourInputs, sheet: 'SCHEDULE', start_row: binding.row, row_count: 1 } });
      assert.equal(fourResponse.status(), 200); const fourCells = (await fourResponse.json()).rows.flatMap(row => row.cells), fourCell = column => fourCells.find(value => value.address === column+binding.row).value;
      for (const column of ['N', 'O']) assert.equal(cell(column), fourCell(column), `DFT column ${column} matches complete four-sided-column calculation`);
      assert.ok(cell('M') < fourCell('M'), 'Input factor keeps three exposed sides');
      assert.match(cell('Y'), new RegExp(`A/V ${String(fourCell('M')).replaceAll('.', '\\.')}[;]`));
      assert.ok(cell('Q') < fourCell('Q'), 'Material perimeter keeps three exposed sides');
    }
    evidence.members.push({ ...member, row: binding.row, dft_um: cell('O'), thickness_mm: mm, input_factor_m_inv: cell('M'), girth_m: cell('Q'), area_m2: cell('R'), mixed_litres: cell('S'), thickness_status: cell('V'), thickness_source: cell('X') });
  }
  await page.screenshot({ path: path.join(output, 'intumescent-linked-dft.png') });
  const first = evidence.members[0];
  await thickness(first.id).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'intumescent-linked-dft-values.png') });
  await editInput(`J${first.row}`, first.length + .125); await expect(thickness(first.id)).toHaveText('Unavailable');
  await expect(thickness(first.id)).toHaveAttribute('title', /linked row was edited/);
  await editInput(`J${first.row}`, first.length); await expect(thickness(first.id)).toHaveText(String(first.thickness_mm));
  const originalDrawing = await snapshot(), originalColours = {};
  const markupColour = id => page.locator(`.takeoff-hit[data-item-id="${id}"]`).evaluate(el => {
    const shape = el.previousElementSibling;
    return el.isConnected && shape?.isConnected && shape.classList.contains('takeoff-markup') ? shape.getAttribute('stroke') : null;
  });
  for (const member of evidence.members) await expect.poll(async () => { originalColours[member.id] = await markupColour(member.id); return originalColours[member.id]; }).toMatch(/^#[0-9a-f]{6}$/i);
  await response(() => page.getByRole('button', { name: 'Markups', exact: true }).click(), '/commands');
  const colourState = await snapshot(), colourMode = colourState.drawing_presentation.colour_modes[0];
  assert.equal(colourMode.palette_version, 2); assert.deepEqual(colourState.items, originalDrawing.items);
  const expectedColours = { 3: '#C06060', 4: '#A0A0A0', 8: '#23B6FE' };
  for (const member of evidence.members) {
    const retained = colourMode.originals.find(value => value.item_id === member.id);
    const expected = expectedColours[Math.ceil(member.dft_um / 250) - 1]; assert.ok(expected);
    assert.equal(retained.calculator_id, 'steel_intumescent'); assert.equal(retained.thickness_mm, member.thickness_mm); assert.equal(retained.colour, expected);
    await expect.poll(() => markupColour(member.id)).toBe(expected);
  }
  await response(() => page.getByRole('button', { name: 'Legend', exact: true }).click(), '/commands');
  const legend = page.getByRole('button', { name: 'Steel Legend', exact: true });
  for (const member of evidence.members) await expect(legend).toContainText(`${member.dft_um} µm`);
  await expect(legend).not.toContainText(' mm');
  const exportSnapshot = await snapshot(), exportDrafts = await calculators(), session = await page.evaluate(() => window.CeasefireTakeoffs.sessionId());
  const pdf = await page.request.post(`http://127.0.0.1:${info.port}/api/takeoffs/sessions/${session}/export/marked-pdf`, { data: {
    expected_revision: exportSnapshot.revision, mode: 'steel', document_id: exportSnapshot.documents[0].id,
    item_ids: evidence.members.map(value => value.id), calculator_drafts: Object.fromEntries(Object.entries(exportDrafts).map(([key,value]) => [key, { inputs: value.inputs, schedule_rows: value.schedule_rows }])) } });
  assert.equal(pdf.status(), 200, await pdf.text());
  const pdfPath = path.join(output, 'intumescent-micron-legend.pdf'); fs.writeFileSync(pdfPath, await pdf.body());
  const extracted = spawnSync(process.env.CEASEFIRE_PYTHON || 'python', ['-c', 'import json,sys;from pypdf import PdfReader;print(json.dumps("\\n".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages)))', pdfPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr); const pdfText = JSON.parse(extracted.stdout).replaceAll('μ', 'µ').replace(/\s+/g, ' ');
  for (const member of evidence.members) assert.ok(pdfText.includes(`${member.dft_um} µm`), 'Actual PDF retains native DFT and micron legend units');
  assert.deepEqual(await calculators(), exportDrafts); assert.deepEqual((await snapshot()).items, exportSnapshot.items);
  const before = await snapshot(), draftsBefore = await calculators();
  await response(() => clickProjectControl(page, 'Save'), '/api/project/save-as');
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await idle();
  await destination.selectOption('steel_intumescent');
  await expect(thickness(first.id)).toHaveText(String(first.thickness_mm));
  assert.deepEqual((await snapshot()).transfers, before.transfers); assert.deepEqual(await calculators(), draftsBefore);
  assert.deepEqual((await snapshot()).drawing_presentation, before.drawing_presentation);
  await response(() => page.getByRole('button', { name: 'Markups', exact: true }).click(), '/commands');
  fs.writeFileSync(info.legacy_palette_flag, 'Emulate the historical writer in this disposable fixture only.');
  try { await response(() => page.getByRole('button', { name: 'Markups', exact: true }).click(), '/commands'); }
  finally { fs.unlinkSync(info.legacy_palette_flag); }
  const legacyPresentation = (await snapshot()).drawing_presentation;
  assert.equal(legacyPresentation.colour_modes[0].palette_version, undefined);
  for (const retained of legacyPresentation.colour_modes[0].originals) assert.equal(retained.colour, '#6C4848');
  await calculators(); await page.waitForFunction(() => !window.CeasefireCalculators.hasPendingOperation() && !window.CeasefireDesktop.status().busy);
  await response(() => clickProjectControl(page, 'Save'), '/api/project/save');
  await response(() => clickProjectControl(page, 'Load'), '/api/project/open');
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click(); await destination.selectOption('steel_intumescent');
  await expect(thickness(first.id)).toHaveText(String(first.thickness_mm));
  assert.deepEqual((await snapshot()).drawing_presentation, legacyPresentation);
  assert.equal((await snapshot()).drawing_presentation.colour_modes[0].palette_version, undefined);
  for (const member of evidence.members) await expect.poll(() => markupColour(member.id)).toBe('#6C4848');
  await response(() => page.getByRole('button', { name: 'Markups', exact: true }).click(), '/commands');
  for (const member of evidence.members) await expect.poll(() => markupColour(member.id)).toBe(originalColours[member.id]);
  await response(() => page.getByRole('button', { name: 'Markups', exact: true }).click(), '/commands');
  assert.equal((await snapshot()).drawing_presentation.colour_modes[0].palette_version, 2);
  for (const member of evidence.members) await expect.poll(() => markupColour(member.id)).toBe(expectedColours[Math.ceil(member.dft_um / 250) - 1]);
  assert.deepEqual((await snapshot()).transfers, before.transfers); assert.deepEqual(await calculators(), draftsBefore);
  evidence.micronPaletteAndPdf = true; evidence.nativeMillimetresUnchanged = true; evidence.legacyPaletteRetainedUntilNewToggle = true;
  evidence.dirtyRowWithheld = true; evidence.exactRestoreRechecked = true; evidence.savedDraftAndLinksPreserved = true; evidence.fourSidedColumnDftWithThreeSidedArea = true;
  const csp = await page.evaluate(() => window.qaCsp); assert.deepEqual(errors, []); assert.deepEqual(csp, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, synthetic: true, evidence, errors, csp, savedProject: info.project }, null, 2));
  console.log(`PASS: intumescent transfers return native DFT/1000 mm, keep four-sided-column DFT/three-sided quantities, withhold edited rows and preserve manual row/Save/Load. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-4000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(output, 'failure-calculators.json'), JSON.stringify(await calculators().catch(() => ({})), null, 2)); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
