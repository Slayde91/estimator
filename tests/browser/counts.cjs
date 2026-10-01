// Rendered manual Steel counts on original PDF points and a disposable database.
const { chromium, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `counts-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || 'python';
fs.mkdirSync(output, { recursive: true });
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let browser, page, logs = '';
server.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 120000);
  server.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
const errors = [], requests = [], evidence = {};
const idle = () => expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
const countItems = value => value.items.filter(item => item.geometry?.kind === 'count');
const markerTotal = value => countItems(value).reduce((sum, item) => sum + item.quantity, 0);
const members = value => countItems(value).flatMap(item => item.member_ids).sort();
const stable = value => countItems(value).map(({ id, count_id, member_ids, quantity, geometry, measurement }) => ({ id, count_id, member_ids, quantity, geometry, measurement })).sort((a, b) => a.id.localeCompare(b.id));
async function command(action, op, status = 200) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, body = await response.json();
  assert.equal(response.status(), status, JSON.stringify(body)); await idle(); return body;
}
async function snapshot() {
  let value; await idle(); await expect.poll(async () => { try { value = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return value;
}
async function fill(scope, label, value) {
  const field = scope.getByLabel(label, { exact: true });
  if (await field.evaluate(el => el.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
}
async function dialog(title, values, action) {
  const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const [label, value] of Object.entries(values)) await fill(modal, label, value);
  await modal.getByRole('button', { name: action, exact: true }).click();
}
// Fixture page 3 uses CropBox [20,30,800,570], rotation 90 and UserUnit 2.
async function screen([x, y]) {
  const overlay = page.locator('.takeoff-overlay'); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 180));
  const box = await overlay.boundingBox(); assert.ok(box?.width && box?.height);
  return [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
}
async function place(point, length, reuse, pendingCount) {
  await page.mouse.click(...await screen(point));
  if (length != null) {
    const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: 'Counted member length', exact: true })).toBeVisible();
    await fill(modal, 'Length per member (m)', length);
    await modal.getByLabel('Use this length for additional counts', { exact: true }).setChecked(reuse);
    await modal.getByRole('button', { name: 'Place marker', exact: true }).click();
  }
  await expect(page.locator('.takeoff-count-pending')).toHaveCount(pendingCount);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function finishCount(point) {
  const position = await screen(point);
  const result = await command(() => page.mouse.dblclick(...position), 'add_count_items');
  await expect(page.locator('.takeoff-count-pending')).toHaveCount(0);
  await expect(page.locator('.takeoff-markup-settings').getByRole('heading', { name: 'Count details', exact: true })).toBeVisible();
  return result;
}
async function selectedCount(ids) {
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  for (const id of ids) await page.locator(`tr[data-item-id="${id}"]`).getByRole('checkbox', { name: /^Select / }).check();
  const panel = page.locator('.takeoff-markup-settings');
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Count details', exact: true })).toBeVisible(); return panel;
}
async function applySettings(panel, rows) {
  return command(async () => {
    await panel.getByRole('button', { name: 'Apply settings', exact: true }).click();
    if (rows > 1) await dialog(`Apply settings to ${rows} items?`, {}, 'Apply settings');
  }, 'bulk_update');
}
async function technicalDetails(mark, rows) {
  const panel = page.locator('.takeoff-markup-settings');
  const fields = { 'Member mark': mark, 'Level': 'L-COUNT', 'Member type': 'Beam', 'Protection product': 'CAFCO 300', 'Steel section': '100UC15', 'Fire period (min)': 120, 'Critical temperature (°C)': 550, 'Exposure description': 'Re-entrant - 3 sides' };
  for (const [label, value] of Object.entries(fields)) await fill(panel, label, value);
  return applySettings(panel, rows);
}
async function saveAndLoad(info) {
  const save = page.waitForResponse(response => response.url().endsWith('/api/project/save-as'));
  await page.getByRole('button', { name: 'Save As', exact: true }).click(); assert.equal((await save).status(), 200);
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  const saved = JSON.parse(fs.readFileSync(info.project));
  const open = page.waitForResponse(response => response.url().endsWith('/api/project/open'));
  await page.getByRole('button', { name: 'Load', exact: true }).click(); assert.equal((await open).status(), 200);
  await page.getByRole('dialog').getByRole('button', { name: 'Load Project', exact: true }).click();
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await expect(page.locator('.takeoff-viewport canvas')).toBeVisible(); await idle();
  // Opening a project starts on its first page; return to the counted source page.
  await command(async () => { await fill(page, 'Page number', 3); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
  return { saved, reopened: await snapshot() };
}
async function deleteMarker(item, memberId) {
  const marker = page.locator(`[data-count-member-id="${memberId}"]`); await marker.scrollIntoViewIfNeeded();
  await marker.click({ button: 'right' });
  return command(() => page.getByRole('menuitem', { name: 'Delete count marker', exact: true }).click(), 'delete_count_marker');
}
async function markerMetrics(memberId) {
  return page.locator(`[data-count-member-id="${memberId}"]`).evaluate(el => {
    const shape = el.previousElementSibling, box = shape.getBBox(), visible = shape.getBoundingClientRect(), hit = el.getBoundingClientRect();
    return { source: { width: box.width, height: box.height }, visible: { width: visible.width, height: visible.height }, hit: { width: hit.width, height: hit.height }, overlay: el.ownerSVGElement.getBoundingClientRect().width };
  });
}
async function download(label, name) {
  const pending = page.waitForEvent('download'); pending.catch(() => {});
  const response = page.waitForResponse(value => value.url().endsWith(label === 'Download PDF' ? '/export/marked-pdf' : '/export/schedule-xlsx')); response.catch(() => {});
  await page.getByRole('button', { name: label, exact: true }).click();
  const accepted = await response; assert.equal(accepted.status(), 200, await accepted.text());
  const result = await pending, target = path.join(output, name); await result.saveAs(target); assert.ok(fs.statSync(target).size > 100); return target;
}
function pythonJson(script, ...args) {
  const result = spawnSync(python, ['-c', script, ...args], { cwd: root, windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().endsWith('/commands')) requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()['content-security-policy'].includes('unsafe-inline'));
  await page.getByRole('button', { name: 'Takeoffs', exact: true }).click();
  await page.locator('#takeoff-upload').setInputFiles(info.fixture); await expect(page.locator('.takeoff-document')).toHaveCount(1, { timeout: 60000 }); await idle();
  await command(async () => { await fill(page, 'Page number', 3); await page.getByLabel('Page number', { exact: true }).press('Tab'); }, 'record_render');
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');
  const original = await snapshot(), source = original.documents[0], calculatorBefore = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  assert.equal(original.calibrations.length, 0); assert.equal(source.pages[2].rotation, 90); assert.equal(source.pages[2].user_unit, 2); assert.deepEqual(source.pages[2].view, [20, 30, 800, 570]);
  const countBox = await page.getByRole('button', { name: 'Count', exact: true }).boundingBox(), traceBox = await page.getByRole('button', { name: 'Trace length', exact: true }).boundingBox(); assert.ok(countBox.y > traceBox.y);

  await page.getByRole('button', { name: 'Count', exact: true }).click(); await place([100, 300], 1, true, 1);
  await page.mouse.click(...await screen([180, 300]), { button: 'right' }); await expect(page.locator('.takeoff-count-pending')).toHaveCount(0);
  assert.equal(countItems(await snapshot()).length, 0, 'Right-click cancels pending Count markers without creating physical identities');
  await page.getByRole('button', { name: 'Count', exact: true }).click();
  await place([150, 140], 3.125, false, 1);
  await place([250, 140], 4.5, true, 2);
  await place([350, 140], null, true, 3);
  await page.screenshot({ path: path.join(output, 'pending-count-without-scale.png') });
  let reply = await finishCount([450, 140]), state = reply.snapshot;
  assert.equal(markerTotal(state), 3, 'Double-click finishes the three accepted markers without adding one at its own location');
  assert.equal(state.calibrations.length, 0, 'Manual member lengths never invent a calibration');
  const firstCount = countItems(state); assert.equal(firstCount.length, 2); const countId = firstCount[0].count_id;
  assert.ok(firstCount.every(item => item.count_id === countId)); assert.deepEqual(firstCount.map(item => [item.measurement.length_m, item.quantity]), [[3.125, 1], [4.5, 2]]);
  assert.equal(new Set(members(state)).size, 3);
  for (const item of firstCount) { assert.equal(item.measurement.method, 'manual'); assert.equal(item.geometry.page, 3); assert.equal(item.geometry.document_id, source.id); }
  const pointPairs = firstCount.flatMap(item => item.geometry.points); [[150, 140], [250, 140], [350, 140]].forEach((expected, index) => expected.forEach((value, axis) => assert.ok(Math.abs(pointPairs[index][axis] - value) < 1.5, JSON.stringify(pointPairs[index]))));
  let panel = page.locator('.takeoff-markup-settings'); await expect(panel.getByLabel('Count quantity', { exact: true })).toHaveValue('3');
  assert.equal(await panel.getByLabel('Count quantity', { exact: true }).evaluate(el => el.readOnly || el.disabled), true);
  await expect(panel.getByRole('button', { name: 'Change length for group 1', exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: 'Change length for group 2', exact: true })).toBeVisible();
  reply = await technicalDetails('COUNT-A', 2); state = reply.snapshot;
  for (const item of countItems(state)) { assert.equal(item.fields.mark, 'COUNT-A'); assert.equal(item.fields.section, '100UC15'); assert.equal(item.fields.product, 'CAFCO 300'); }
  for (const item of countItems(state)) await expect(page.locator(`tr[data-item-id="${item.id}"] input[name="quantity"]`)).toBeDisabled();
  await expect(page.getByLabel('Bulk edit field', { exact: true }).locator('option[value="quantity"]')).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorBefore);
  const beforeLength = stable(state);
  await panel.getByRole('button', { name: 'Change length for group 1', exact: true }).click();
  reply = await command(() => dialog('Change counted member length', { 'Length per member (m)': 3.375 }, 'Apply length'), 'update_item'); state = reply.snapshot;
  const changedLength = state.items.find(item => item.id === firstCount[0].id);
  assert.equal(changedLength.measurement.length_m, 3.375); assert.deepEqual(changedLength.member_ids, firstCount[0].member_ids); assert.equal(changedLength.quantity, 1);
  assert.deepEqual(stable(state).find(item => item.id === firstCount[1].id), beforeLength.find(item => item.id === firstCount[1].id));

  // A new Count is a distinct physical group even with the same entered length.
  await page.getByRole('button', { name: 'Count', exact: true }).click(); await place([550, 320], 4.5, false, 1);
  // Finish over an existing saved marker; its hit target must not add a member.
  reply = await finishCount([150, 140]); state = reply.snapshot;
  const secondCount = countItems(state).filter(item => item.count_id !== countId); assert.equal(secondCount.length, 1); const secondId = secondCount[0].id;
  reply = await technicalDetails('COUNT-B', 1); state = reply.snapshot; assert.equal(state.items.find(item => item.id === secondId).fields.mark, 'COUNT-B');
  assert.ok(state.items.filter(item => item.count_id === countId).every(item => item.fields.mark === 'COUNT-A'));
  assert.equal(markerTotal(state), 4);
  console.log('Count placement, explicit lengths, shared details and separate Count passed.');

  // Every supported symbol persists independently of source geometry and manual lengths.
  const originalStable = stable(state), firstIds = firstCount.map(item => item.id);
  for (const shape of ['circle', 'square', 'triangle', 'diamond']) {
    panel = await selectedCount([firstIds[0]]);
    await fill(panel, 'Marker shape', shape); await fill(panel, 'Marker size (PDF points)', 18);
    await fill(panel, 'Stroke colour', '#1a2b3c'); await panel.getByLabel('Fill enabled', { exact: true }).check(); await fill(panel, 'Fill colour', '#4f6e8d'); await fill(panel, 'Opacity', .65);
    reply = await applySettings(panel, 2); state = reply.snapshot;
    for (const item of state.items.filter(item => item.count_id === countId)) {
      assert.equal(item.appearance.marker_shape ?? 'circle', shape); assert.equal(item.appearance.marker_size, 18); assert.equal(item.appearance.opacity, .65); assert.equal(item.appearance.fill_enabled ?? true, true);
      assert.equal(item.appearance.stroke_color.toLowerCase(), '#1a2b3c'); assert.equal(item.appearance.fill_color.toLowerCase(), '#4f6e8d');
      for (const memberId of item.member_ids) {
        const marker = page.locator(`[data-count-member-id="${memberId}"]`); await expect(marker).toBeVisible();
        const rendered = await marker.evaluate(el => ({ tag: el.tagName.toLowerCase(), points: el.getAttribute('points'), fill: el.previousElementSibling.getAttribute('fill') }));
        assert.equal(rendered.tag, shape === 'circle' ? 'circle' : shape === 'square' ? 'rect' : 'polygon');
        if (rendered.points) assert.equal(rendered.points.trim().split(/\s+/).length, shape === 'triangle' ? 3 : 4);
        assert.equal(rendered.fill.toLowerCase(), '#4f6e8d');
      }
    }
    const { saved, reopened } = await saveAndLoad(info); state = reopened; assert.deepEqual(stable(state), originalStable);
    for (const item of state.items.filter(item => item.count_id === countId)) assert.equal(item.appearance.marker_shape ?? 'circle', shape);
    assert.deepEqual(state.items.map(item => item.appearance), saved.takeoffs.items.map(item => item.appearance));
    await page.screenshot({ path: path.join(output, `count-shape-${shape}.png`) });
    console.log(`Count ${shape} marker rendered and saved/reopened.`);
  }
  const zoomMember = state.items.find(item => item.count_id === countId).member_ids[0];
  const markerBeforeZoom = await markerMetrics(zoomMember);
  await command(() => page.getByRole('button', { name: '+', exact: true }).click(), 'record_render');
  await expect.poll(async () => Math.abs((await markerMetrics(zoomMember)).visible.width / markerBeforeZoom.visible.width - 1.25), { message: 'Wait for the zoomed marker to finish rendering' }).toBeLessThan(.03);
  const markerAfterZoom = await markerMetrics(zoomMember);
  evidence.markerZoom = { before: markerBeforeZoom, after: markerAfterZoom };
  fs.writeFileSync(path.join(output, 'zoom.json'), JSON.stringify(evidence.markerZoom, null, 2));
  assert.ok(Math.abs(markerAfterZoom.visible.width / markerBeforeZoom.visible.width - 1.25) < .03, `Visible symbols scale with the rendered PDF: ${JSON.stringify(evidence.markerZoom)}`);
  assert.deepEqual(stable(await snapshot()), originalStable, 'Zoom cannot change count positions, identities, quantities or entered lengths');
  await command(() => page.getByRole('button', { name: 'Fit page', exact: true }).click(), 'record_render');

  // Delete one exact member, a single-member length group, then a whole final Count.
  const deletionBaseline = stable(state), twoMember = state.items.find(item => item.count_id === countId && item.quantity === 2);
  reply = await deleteMarker(twoMember, twoMember.member_ids[0]); state = reply.snapshot;
  assert.equal(state.items.find(item => item.id === twoMember.id).quantity, 1); assert.ok(!members(state).includes(twoMember.member_ids[0])); assert.ok(members(state).includes(twoMember.member_ids[1]));
  reply = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo'); state = reply.snapshot; assert.deepEqual(stable(state), deletionBaseline);
  for (const itemId of [firstIds[0], secondId]) {
    const selected = state.items.find(item => item.id === itemId); assert.equal(selected.quantity, 1);
    reply = await deleteMarker(selected, selected.member_ids[0]); assert.ok(!reply.snapshot.items.some(item => item.id === itemId));
    reply = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo'); state = reply.snapshot; assert.deepEqual(stable(state), deletionBaseline);
  }
  evidence.memberIds = members(state); evidence.countIds = [...new Set(countItems(state).map(item => item.count_id))];
  console.log('Count zoom and exact-member delete/undo passed.');

  // Normal confirmation and transfer use exactly quantity and entered metres per member.
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  for (const item of countItems(state)) await page.locator(`tr[data-item-id="${item.id}"]`).getByRole('checkbox', { name: /^Select / }).check();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  reply = await command(() => dialog('Confirm 3 items?', {}, 'Confirm items'), 'confirm_items');
  assert.ok(countItems(reply.snapshot).every(item => item.confirmation));
  const previewResponse = page.waitForResponse(value => value.url().endsWith('/transfer-preview')); await page.getByRole('button', { name: 'Preview transfer', exact: true }).click();
  const previewHttp = await previewResponse; assert.equal(previewHttp.status(), 200); const preview = await previewHttp.json();
  const applied = page.waitForResponse(value => value.url().endsWith('/transfer-apply')); await dialog('Transfer 3 confirmed items?', {}, 'Add to schedule'); const appliedHttp = await applied; assert.equal(appliedHttp.status(), 200); const transfer = await appliedHttp.json(); await idle();
  for (const item of countItems(transfer.snapshot)) {
    const binding = transfer.snapshot.transfers.find(value => value.item_id === item.id); assert.ok(binding);
    assert.equal(preview.inputs.SCHEDULE[`I${binding.row}`], item.quantity); assert.equal(preview.inputs.SCHEDULE[`J${binding.row}`], item.measurement.length_m);
    assert.equal(transfer.item_results.find(value => value.id === item.id).total_length_m, item.quantity * item.measurement.length_m);
  }
  const calculatorAfter = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  const roundtrip = await saveAndLoad(info); state = roundtrip.reopened; assert.deepEqual(stable(state), deletionBaseline);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculatorAfter);
  assert.equal(state.documents[0].sha256, createHash('sha256').update(fs.readFileSync(info.fixture)).digest('hex'));
  assert.equal(state.calibrations.length, 0);
  panel = await selectedCount([firstIds[0]]);
  await panel.getByLabel('Count quantity', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'count-details-fields-and-quantity.png'), fullPage: true });

  const xlsx = await download('Download XLSX', 'counts.xlsx'), pdf = await download('Download PDF', 'counts.pdf');
  const workbook = pythonJson("import json,sys\nfrom openpyxl import load_workbook\nw=load_workbook(sys.argv[1],data_only=False)\ns=w['Current Takeoffs'];r=list(s.values)\nprint(json.dumps({'rows':[dict(zip(r[0],v)) for v in r[1:]],'formulas':[c.coordinate for sh in w for row in sh for c in row if c.data_type=='f']}))", xlsx);
  assert.equal(workbook.rows.length, 3); assert.deepEqual(workbook.formulas, []);
  for (const item of countItems(state)) { const row = workbook.rows.find(value => value['Item ID'] === item.id); assert.ok(row); assert.equal(row['Count ID'], item.count_id); assert.equal(row.Quantity, item.quantity); assert.equal(row['Length per item m'], item.measurement.length_m); assert.equal(row['Total length m'], item.quantity * item.measurement.length_m); assert.deepEqual(JSON.parse(row['Physical member IDs']), item.member_ids); assert.equal(JSON.parse(row.Geometry).kind, 'count'); }
  const pdfInfo = pythonJson("import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1]);markers=[]\nfor p in r.pages:\n stroke=None;stack=[];path=[]\n for args,op in p.get_contents().operations:\n  if op==b'q':stack.append(stroke)\n  elif op==b'Q':stroke=stack.pop() if stack else None\n  elif op==b'RG':stroke=[float(v) for v in args]\n  elif op in (b'm',b'l',b'c',b're',b'h'):path.append(op.decode())\n  elif op in (b'B',b'B*',b'S',b's',b'f',b'f*',b'n'):\n   if stroke and all(abs(a-b)<1e-5 for a,b in zip(stroke,[26/255,43/255,60/255])) and op in (b'B',b'B*'):markers.append(path)\n   path=[]\nprint(json.dumps({'text':'\\n'.join(p.extract_text() or '' for p in r.pages),'pages':len(r.pages),'markers':markers}))", pdf);
  assert.ok(pdfInfo.text.includes('COUNT-A')); assert.ok(pdfInfo.text.includes('COUNT-B')); assert.ok(pdfInfo.text.includes('manual length each')); assert.ok(pdfInfo.text.includes('Rotated crop with UserUnit 2')); assert.ok(pdfInfo.pages >= 4);
  assert.equal(pdfInfo.markers.length, 3, 'Each of the three custom-colour members produces its own exported marker');
  for (const marker of pdfInfo.markers) assert.deepEqual(marker, ['m', 'l', 'l', 'l', 'h'], 'Diamond symbols close independently without joining members');
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  evidence.xlsx = workbook; evidence.pdf = pdfInfo; evidence.noCalibration = true; evidence.fullPrecision = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, evidence, requests, errors, savedProject: info.project }, null, 2));
  console.log(`PASS: manual no-scale Count placement/reuse, double-click finish, shared length groups/details, four marker styles, exact-member delete/undo, confirmed full-precision transfer, save/reopen and PDF/XLSX exports. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-6000));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
