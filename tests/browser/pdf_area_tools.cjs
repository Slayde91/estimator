const { waitForTakeoffDownload } = require('./native_download_helpers.cjs');
"use strict";
// PDF-only Area and exclusions against synthetic source files and a disposable server.
const { chromium, expect } = require("@playwright/test");
const { chooseTakeoff } = require("./section_navigation.cjs"), { clickProjectControl } = require("./project_actions.cjs");
const { renderDrawing } = require("./viewer_helpers.cjs"), { settingsSettled } = require("./settings_helpers.cjs");
const { spawn, spawnSync } = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."), python = process.env.CEASEFIRE_PYTHON || "python";
const output = path.join(root, ".runtime/browser-qa", `pdf-area-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const assets = ["static/takeoffs.js", "static/takeoffs.css", "static/takeoff-graphics.js", "static/takeoff-graphics-ui.js", "estimator/takeoff_graphics.py", "estimator/takeoff_pdf_measure.py", "estimator/takeoff_workspace.py", "estimator/takeoff_model.py", "estimator/takeoff_exports.py", "estimator/takeoff_register_xlsx.py", "estimator/takeoff_markup_pdf.py", "estimator/takeoff_markup_pdf_worker.py", "tests/browser/pdf_area_tools.cjs"];
const hashes = () => Object.fromEntries(assets.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
const sourceBefore = hashes(), errors = [], checks = []; let browser, page, logs = "";
const server = spawn(python, [path.join(__dirname, "fixtures.py"), "--directory", output], { cwd: root, windowsHide: true });
server.stderr.on("data", chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  let text = ""; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(text.split("\n")[0])); } catch (error) { reject(error); } } });
  server.once("error", error => { clearTimeout(timer); reject(error); }); server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${logs}`)); });
});
const check = name => { checks.push(name); console.log(`ok - ${name}`); }, rail = () => page.locator(".takeoff-tool-rail"), panel = () => page.locator("#takeoff-markup-settings");
const areaOf = points => Math.abs(points.reduce((sum, [x,y], index) => { const next = points[(index+1)%points.length]; return sum+x*next[1]-next[0]*y; }, 0))/2*.01;
async function snapshot() { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
function invariant(current, baseline) { for (const key of ["items", "documents", "calibrations", "transfers", "physical", "service_plans", "annotations", "signatures", "image_extractions"]) assert.deepEqual(current[key], baseline[key], `${key} is outside PDF Area authority`); }
async function command(action, op) {
  const pending = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(value)); await settingsSettled(page); return value;
}
async function sourcePoint([x, y]) {
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  const box = await overlay.boundingBox(), result = [box.x + x / 842 * box.width, box.y + (1 - y / 595) * box.height];
  assert.equal(await page.evaluate(([sx, sy]) => !!document.elementFromPoint(sx, sy)?.closest(".takeoff-overlay"), result), true); return result;
}
async function trace(points) { const placed = []; for (const point of points) { await page.mouse.click(...await sourcePoint(point)); placed.push(await page.evaluate(() => window.qaClickSourcePoint)); } await page.locator(".takeoff-viewport").press("Enter"); return placed; }
async function tools() {
  const viewport = rail().getByRole("button", { name: "Viewport", exact: true }), measure = rail().getByRole("button", { name: "Measure", exact: true });
  await expect(viewport).toBeVisible(); await expect(measure).toBeVisible();
  assert.equal(await viewport.evaluate(el => el.nextElementSibling?.getAttribute("aria-label")), "Measure");
  for (const name of ["Area", "Area exclusion"]) await expect(rail().getByRole("button", { name, exact: true })).toBeVisible();
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1384, height: 1000 }, reducedMotion: "reduce" }); page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message)); await page.addInitScript(() => {
    window.qaCsp = []; document.addEventListener("securitypolicyviolation", event => window.qaCsp.push(event.effectiveDirective));
    document.addEventListener("click", event => { const overlay = event.target.closest?.(".takeoff-overlay"); if (overlay) { const box = overlay.getBoundingClientRect(); window.qaClickSourcePoint = [(event.clientX-box.left)/box.width*842, (1-(event.clientY-box.top)/box.height)*595]; } }, true);
  });
  await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  await page.getByRole("button", { name: "Takeoffs", exact: true }).click(); await renderDrawing(page, () => page.locator("#takeoff-upload").setInputFiles(info.fixture), 1);
  await page.evaluate(async () => {
    const app = window.CeasefireTakeoffs, current = app.projectSnapshot(), sid = app.sessionId(), doc = current.documents[0];
    const reply = await fetch(`/api/takeoffs/sessions/${sid}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "add_calibration", request_id: crypto.randomUUID(), expected_revision: current.revision, calibration: { id: crypto.randomUUID(), document_id: doc.id, page: 1, name: "Synthetic uniform Area scale", points: [[100,100],[200,100]], distance_m: 10, uniform_scale: true } }) });
    if (!reply.ok) throw new Error(await reply.text()); const data = await reply.json(); app.applyProject(await app.prepareProject(data.snapshot, sid));
  });
  await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click(), 1); await settingsSettled(page);
  const baseline = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), ids = [], netAreas = [];
  for (const workspace of ["steel", "duct", "Walls/Floors", "Defect Reports", "Service Plans"]) {
    await chooseTakeoff(page, workspace); await settingsSettled(page);
    if (workspace === "Walls/Floors") {
      for (const name of ["Area", "Area exclusion", "Length"]) await expect(rail().getByRole("button", { name, exact: true })).toBeHidden();
      for (const name of ["Trace surface", "Add exclusion"]) await expect(rail().getByRole("button", { name, exact: true })).toBeVisible();
      check("Walls/Floors retains surface tools without duplicate PDF Area buttons"); continue;
    }
    await tools();
    await rail().getByRole("button", { name: "Area", exact: true }).click();
    let placed; const created = await command(async () => { placed = await trace([[100,100],[300,100],[300,300],[100,300]]); }, "create_graphic"), id = created.created_graphic_id; ids.push(id);
    let record = created.snapshot.graphics.records.find(value => value.id === id), result = created.pdf_measure_results.find(value => value.id === id);
    record.geometry.points.forEach((point, index) => point.forEach((value, axis) => assert.ok(Math.abs(value-placed[index][axis]) < 1e-8, "Retained source coordinates match the native click event")));
    const gross = areaOf(placed); assert.equal(record.kind, "area"); assert.equal(record.geometry.exclusions.length, 0); assert.equal(result.status, "current"); assert.ok(Math.abs(result.net_area_m2-gross) < 1e-8);
    await expect(panel().getByLabel("Area (m²)", { exact: true })).toHaveValue(gross.toFixed(2));
    await rail().getByRole("button", { name: "Area exclusion", exact: true }).click();
    const excluded = await command(async () => { placed = await trace([[140,140],[170,140],[170,170],[140,170]]); }, "update_graphic");
    record = excluded.snapshot.graphics.records.find(value => value.id === id); result = excluded.pdf_measure_results.find(value => value.id === id);
    record.geometry.exclusions[0].points.forEach((point, index) => point.forEach((value, axis) => assert.ok(Math.abs(value-placed[index][axis]) < 1e-8)));
    const hole = areaOf(placed), net = gross-hole; netAreas.push(net); assert.equal(record.geometry.exclusions.length, 1); assert.ok(Math.abs(result.gross_area_m2-gross) < 1e-8); assert.ok(Math.abs(result.excluded_area_m2-hole) < 1e-8); assert.ok(Math.abs(result.net_area_m2-net) < 1e-8);
    await expect(panel().getByLabel("Area (m²)", { exact: true })).toHaveValue(net.toFixed(2)); await expect(page.locator(`.takeoff-graphic[data-graphic-id="${id}"]`)).toContainText(`${net.toFixed(2)} m²`);
    invariant(await snapshot(), baseline); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
    check(`${workspace}: tools ordered, calibrated Area minus exclusion, no register or calculator change`);
    if (workspace === "steel") { await page.screenshot({ path: path.join(output, "steel-pdf-area-exclusion.png") }); }
    await page.getByRole("button", { name: "Select", exact: true }).click();
  }
  await chooseTakeoff(page, "steel"); await settingsSettled(page); const current = await snapshot(), area = current.graphics.records.find(value => value.id === ids[0]);
  await page.locator(`.takeoff-graphic[data-graphic-id="${area.id}"]`).press("Enter");
  const point = page.getByRole("button", { name: "Area control point 4", exact: true }); await point.click({ button: "right" });
  const midpoint = await command(() => page.getByRole("menuitem", { name: "Insert midpoint", exact: true }).click(), "update_graphic");
  assert.equal(midpoint.snapshot.graphics.records.find(value => value.id === area.id).geometry.points.length, 5);
  await command(() => page.getByRole("button", { name: "Undo last edit", exact: true }).click(), "undo");
  assert.deepEqual((await snapshot()).graphics.records.find(value => value.id === area.id).geometry, area.geometry); check("Area closing-edge midpoint and Undo retain hole IDs and exact geometry");
  const pending = waitForTakeoffDownload(page); await page.evaluate(() => window.CeasefireTakeoffs.downloadDrawing()); const pdf = path.join(output, "area-marked.pdf"); await (await pending).saveAs(pdf);
  const extracted = spawnSync(python, ["-X", "utf8", "-B", "-c", "from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))", pdf], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr); assert.ok(extracted.stdout.includes(`${netAreas[0].toFixed(2)} m²`)); check("Marked PDF includes measured net area");
  const saved = await snapshot(); await clickProjectControl(page, "Save"); await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  await clickProjectControl(page, "Load"); await page.getByRole("dialog").getByRole("button", { name: "Load Project", exact: true }).click(); await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  await page.getByRole("button", { name: "Takeoffs", exact: true }).click(); await settingsSettled(page);
  assert.deepEqual((await snapshot()).graphics.records, saved.graphics.records); invariant(await snapshot(), baseline); check("All workspace Area records and holes survive real save and reopen");
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []); assert.deepEqual(hashes(), sourceBefore);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: true, disposablePort: info.port, checks, errors, sourceBefore, sourceAfter: hashes(), areas: ids }, null, 2)); console.log(`PDF Area browser acceptance passed: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {}); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: false, checks, errors, error: String(error), sourceBefore, sourceAfter: hashes() }, null, 2)); process.exitCode = 1; }).finally(async () => { fs.writeFileSync(path.join(output, "server.log"), logs); await browser?.close(); server.kill(); });
