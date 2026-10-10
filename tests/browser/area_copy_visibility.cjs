"use strict";
// Real drawing, keyboard and settings acceptance. All PDFs, projects, browser
// storage and server state belong to a disposable non-production fixture.
const { chromium, expect } = require("@playwright/test");
const { chooseTakeoff } = require("./section_navigation.cjs");
const { clickProjectControl } = require("./project_actions.cjs");
const { renderDrawing, viewRegisterItem } = require("./viewer_helpers.cjs");
const { editSettings, openItemSettings, settingsSettled } = require("./settings_helpers.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."), output = path.join(root, ".runtime/browser-qa", `area-copy-visibility-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const assets = ["static/takeoffs.js", "static/takeoffs.css", "static/takeoff-physical.js", "static/theme.css", "static/icons/default-memory.svg", "estimator/takeoff_copy.py", "tests/browser/area_copy_visibility.cjs"];
const hashes = () => Object.fromEntries(assets.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]));
const sourceBefore = hashes(), checks = [], errors = [], requests = [];
const server = spawn(process.env.CEASEFIRE_PYTHON || "python", [path.join(__dirname, "fixtures.py"), "--directory", output], { cwd: root, windowsHide: true });
let browser, page, logs = "";
server.stderr.on("data", value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ""; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", value => { stdout += value; if (stdout.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); } } });
  server.once("error", error => { clearTimeout(timer); reject(error); });
  server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const row = id => page.locator(`tr[data-item-id="${id}"]`);
const label = id => page.locator(`[data-area-item-id="${id}"]`);
const hit = id => page.locator(`.takeoff-area-hit[data-item-id="${id}"]`);
const idle = () => settingsSettled(page);
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op) {
  const pending = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const response = await pending, value = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(value)); await idle(); return value;
}
async function dialog(title, values, submit) {
  const modal = page.getByRole("dialog"); await expect(modal.getByRole("heading", { name: title, exact: true })).toBeVisible();
  for (const [name, value] of Object.entries(values)) {
    const field = modal.getByLabel(name, { exact: true });
    if (await field.evaluate(el => el.tagName) === "SELECT") await field.selectOption(String(value)); else await field.fill(String(value));
  }
  await modal.getByRole("button", { name: submit, exact: true }).click();
  await expect(page.locator("dialog.takeoff-dialog")).toHaveCount(0);
}
async function fit() { await idle(); await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click()); }
async function screen([x, y]) {
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  // The fixture's page 1 is an unrotated 842 x 595 PDF-point surface.
  const bounds = await overlay.boundingBox(), point = [bounds.x + x / 842 * bounds.width, bounds.y + (595 - y) / 595 * bounds.height];
  assert.equal(await page.evaluate(([cx, cy]) => !!document.elementFromPoint(cx, cy)?.closest(".takeoff-overlay"), point), true, "Pointer reaches synthetic drawing");
  return point;
}
async function draw(points) {
  for (const [index, point] of points.entries()) {
    if (index === points.length - 1) await page.mouse.dblclick(...await screen(point)); else await page.mouse.click(...await screen(point));
  }
}
async function create(mode, mark, points, layers) {
  const closing = page.getByRole("button", { name: "Close settings", exact: true }); if (await closing.isVisible()) await closing.click();
  await fit(); await page.getByRole("button", { name: "Trace surface", exact: true }).click(); await draw(points);
  const reply = await command(() => dialog("Add surface", { "Surface Type": mode, "Surface ID": mark, "Number of layers": layers,
    Level: "L01", Substrate: "Concrete", "Protection system": "Synthetic system", "Protection product": "Synthetic product", "FRL / fire rating": "90/90/90" }, "Add surface"), "create_item");
  await page.getByRole("button", { name: "Select", exact: true }).click(); return { item: reply.snapshot.items.at(-1), reply };
}
async function select(id) {
  await viewRegisterItem(page, id); await fit(); await page.locator(".takeoff-viewport").focus();
  await expect(row(id).getByRole("checkbox", { name: /^Select / })).toBeChecked();
}
async function copy(id) {
  if (id) await select(id); else await page.locator(".takeoff-viewport").focus();
  await page.keyboard.press("Control+c"); await expect(page.locator("#takeoffs-workspace .message")).toContainText(/Copied \d+ surface markup/);
}
async function paste(point) {
  await page.locator(".takeoff-viewport").focus(); await page.mouse.move(...await screen(point));
  return command(() => page.keyboard.press("Control+v"), "duplicate_items");
}
function assertCopy(original, pasted, reply, pointer) {
  for (const key of ["mode", "fields", "quantity", "appearance", "evidence"]) assert.deepEqual(pasted[key], original[key], `${key} preserved`);
  assert.notEqual(pasted.id, original.id); assert.equal(pasted.state, "draft"); assert.equal(pasted.review, null); assert.equal(pasted.confirmation, null);
  assert.deepEqual(pasted.copied_from, { item_id: original.id, version: original.version }); assert.deepEqual(pasted.predecessor_ids, []);
  assert.ok(pasted.member_ids.every(id => !original.member_ids.includes(id)));
  const delta = pasted.geometry.points[0].map((n, axis) => n - original.geometry.points[0][axis]);
  for (const [index, point] of original.geometry.points.entries()) for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(pasted.geometry.points[index][axis] - point[axis] - delta[axis]) < 1e-7);
  for (const [index, hole] of original.geometry.exclusions.entries()) {
    const copiedHole = pasted.geometry.exclusions[index]; assert.notEqual(copiedHole.id, hole.id); assert.equal(copiedHole.note, hole.note);
    for (const [vertex, point] of hole.points.entries()) for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(copiedHole.points[vertex][axis] - point[axis] - delta[axis]) < 1e-7);
  }
  if (pointer) assert.ok(pasted.geometry.points[0].every((n, axis) => Math.abs(n - pointer[axis]) < 2), "First vertex follows actual mouse position");
  const result = id => reply.item_results.find(item => item.id === id), before = result(original.id), after = result(pasted.id);
  for (const key of ["gross_area_m2", "excluded_area_m2", "net_area_m2", "total_area_m2"]) assert.ok(Math.abs(before[key] - after[key]) < 1e-8, `${key} retains measurement precision`);
  assert.equal(after.total_area_m2, after.net_area_m2 * original.fields.layers);
  return after;
}
async function assertSqm(item, result) {
  await expect(label(item.id)).toHaveText(`${new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(result.net_area_m2)} Sqm`);
  assert.equal(Number(await label(item.id).getAttribute("data-area-value")), result.net_area_m2);
  await expect(row(item.id)).toBeVisible(); await expect(row(item.id).getByRole("checkbox", { name: /^Select / })).toBeChecked();
}
async function saveLoad(info) {
  const saving = page.waitForResponse(reply => reply.url().endsWith("/api/project/save-as")); saving.catch(() => {});
  await clickProjectControl(page, "Save"); assert.equal((await saving).status(), 200); await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  const saved = JSON.parse(fs.readFileSync(info.project, "utf8"));
  const opening = page.waitForResponse(reply => reply.url().endsWith("/api/project/open")); opening.catch(() => {});
  await clickProjectControl(page, "Load"); assert.equal((await opening).status(), 200);
  await page.getByRole("dialog").getByRole("button", { name: "Load Project", exact: true }).click();
  await expect(page.locator("#project-save-state")).toHaveText("Saved project"); await page.getByRole("button", { name: "Takeoffs", exact: true }).click();
  return { saved, reopened: await snapshot() };
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (request.url().endsWith("/commands")) requests.push(request.postDataJSON()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener("securitypolicyviolation", event => window.qaCsp.push(event.effectiveDirective)); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()["content-security-policy"].includes("unsafe-inline"));
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready);
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  await page.getByRole("button", { name: "Takeoffs", exact: true }).click(); await chooseTakeoff(page, "wall");
  await renderDrawing(page, () => page.locator("#takeoff-upload").setInputFiles(info.area_fixture), 1); await idle();
  const scale = page.getByLabel("Drawing calibration", { exact: true }); if (!await scale.isVisible()) await page.getByRole("button", { name: "Scale", exact: true }).click();
  await scale.selectOption("scale:100"); await command(() => dialog("Apply drawing scale 1:100?", {}, "Apply scale"), "add_calibration");
  // Retained pre-existing basis values enter through the real validated command;
  // all copying, selection, style editing and saving use actual UI controls.
  const retainFields = route => { const value = route.request().postDataJSON(); if (value.op === "create_item") {
    value.item.fields.surface_basis = value.item.mode === "wall" ? "wall-face" : "slab-top";
    value.item.appearance = { stroke_color: "#A020F0", stroke_width: 3.75, opacity: .8, fill_color: "#FFDDEE", fill_enabled: true, display_values: true };
    return route.continue({ postData: JSON.stringify(value) }); } return route.continue(); };
  await page.route("**/commands", retainFields);
  let { item: wall } = await create("wall", "COPY-WALL", [[100, 200], [260, 200], [260, 320], [100, 320]], 3);
  await select(wall.id); await page.getByRole("button", { name: "Add exclusion", exact: true }).click();
  await draw([[140, 240], [180, 240], [180, 280], [140, 280]]);
  let reply = await command(() => dialog("Add excluded opening", { "Exclusion source / reason": "Synthetic window retained by copy" }, "Add exclusion"), "update_item");
  wall = reply.snapshot.items.find(item => item.id === wall.id);
  const { item: floor } = await create("slab", "COPY-FLOOR", [[300, 200], [440, 200], [440, 310], [300, 310]], 2);
  await page.unroute("**/commands", retainFields);
  checks.push("real Wall/Floor creation with calibrated geometry, explicit layers and a traced excluded opening");

  await copy(wall.id); reply = await paste([180, 380]);
  const first = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]); await assertSqm(first, assertCopy(wall, first, reply, [180, 380]));
  assert.equal(reply.snapshot.items.length, 3);
  reply = await paste([370, 370]); const second = reply.snapshot.items.find(item => item.id === reply.created_item_ids[0]);
  await assertSqm(second, assertCopy(wall, second, reply, [370, 370])); assert.notEqual(first.id, second.id); assert.equal(reply.snapshot.items.length, 4);
  assert.deepEqual(reply.snapshot.items.find(item => item.id === wall.id), wall);
  checks.push("two Ctrl+V actions each create a selected separate row, preserve net Sqm, layers and exclusions, reset review and leave source unchanged");

  await select(wall.id); await row(floor.id).getByRole("checkbox", { name: /^Select / }).check(); await idle(); await copy();
  reply = await paste([80, 70]); assert.equal(reply.created_item_ids.length, 2); assert.equal(reply.snapshot.items.length, 6);
  const group = reply.created_item_ids.map(id => reply.snapshot.items.find(item => item.id === id));
  for (const [index, original] of [wall, floor].entries()) await assertSqm(group[index], assertCopy(original, group[index], reply));
  const delta = group[0].geometry.points[0].map((n, axis) => n - wall.geometry.points[0][axis]);
  assert.ok(group[1].geometry.points[0].every((n, axis) => Math.abs(n - floor.geometry.points[0][axis] - delta[axis]) < 1e-7));
  checks.push("mixed Wall/Floor group pastes as two rows with one shared translation and original surface types");

  const beforeNative = await snapshot(), commandCount = requests.length, filter = page.getByLabel("Filter register", { exact: true });
  await filter.fill("native-clipboard"); await filter.press("Control+a"); await filter.press("Control+c"); await filter.fill(""); await filter.press("Control+v");
  await expect(filter).toHaveValue("native-clipboard"); await filter.fill(""); await idle();
  assert.deepEqual((await snapshot()).items, beforeNative.items); assert.equal(requests.length, commandCount);
  checks.push("native text Ctrl+C/Ctrl+V remains native and creates no markup commands");

  await select(wall.id); let settings = await openItemSettings(page, wall.id);
  await expect(settings.getByLabel("Surface basis", { exact: true })).toHaveCount(0);
  const modified = await editSettings(page, { Level: "L02" });
  assert.equal(modified.snapshot.items.find(item => item.id === wall.id).fields.surface_basis, "wall-face");
  await expect(row(wall.id).getByLabel("Surface basis", { exact: true })).toHaveValue("wall-face");
  checks.push("Surface basis is removed from inspector while register value and saved metadata survive unrelated edits");

  settings = await openItemSettings(page, wall.id);
  const mainEye = page.locator(".takeoff-tool-rail").getByRole("button", { name: "Visibility", exact: true });
  let itemEye = settings.getByRole("button", { name: "Visibility", exact: true });
  const defaultControl = settings.getByRole("button", { name: "Set as default", exact: true });
  const sizes = await page.evaluate(() => [...document.querySelectorAll(".takeoff-tool-rail .takeoff-visibility-button,#takeoff-markup-settings .takeoff-appearance-actions button")].map(el => {
    const box = el.getBoundingClientRect(), icon = el.querySelector("img,.takeoff-action-icon"), iconBox = icon.getBoundingClientRect();
    return { label: el.getAttribute("aria-label"), width: box.width, height: box.height, iconWidth: iconBox.width, iconHeight: iconBox.height, mask: getComputedStyle(icon).maskImage, top: box.top, left: box.left };
  }));
  assert.equal(sizes.length, 3); for (const size of sizes) { assert.equal(size.width, 38); assert.equal(size.height, 38); assert.equal(size.iconWidth, 24); assert.equal(size.iconHeight, 24); }
  const memory = sizes.find(value => value.label === "Set as default"), itemSize = sizes.filter(value => value.label === "Visibility").at(-1);
  assert.match(memory.mask, /\/icons\/default-memory\.svg/); assert.equal(memory.top, itemSize.top); assert.equal(Math.abs(memory.left - itemSize.left), 46);
  await defaultControl.click(); await expect(page.locator("#takeoffs-workspace .message")).toContainText("Default appearance saved");
  const styled = (await snapshot()).items.find(item => item.id === wall.id);
  checks.push("real default/selected-item controls sit together with shared 38px buttons and 24px icons; memory icon saves appearance defaults");

  const beforeVisibility = await snapshot(), beforeVisibilityCommands = requests.length;
  await itemEye.click(); await expect(hit(wall.id)).toHaveCount(0); await expect(label(wall.id)).toHaveCount(0); await expect(hit(floor.id)).toHaveCount(1);
  await expect(row(wall.id).getByRole("checkbox", { name: /^Hide / })).toBeChecked();
  await mainEye.click(); await expect(page.locator(".takeoff-area-hit")).toHaveCount(0); await mainEye.click();
  await expect(hit(wall.id)).toHaveCount(0); await expect(hit(floor.id)).toHaveCount(1);
  await mainEye.click(); await expect(mainEye).toHaveAttribute("aria-pressed", "true");
  await mainEye.dblclick(); await expect(mainEye).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".takeoff-area-hit")).toHaveCount(6); await expect(row(wall.id).getByRole("checkbox", { name: /^Hide / })).not.toBeChecked();
  itemEye = page.locator("#takeoff-markup-settings").getByRole("button", { name: "Visibility", exact: true }); await expect(itemEye).toHaveAttribute("aria-pressed", "false");
  assert.deepEqual((await snapshot()).items, beforeVisibility.items); assert.equal(requests.length, beforeVisibilityCommands);
  checks.push("single eye toggles preserve individual hiding; main double-click restores all global and individual visibility without canonical edits");

  const { item: defaultItem } = await create("wall", "DEFAULT-WALL", [[560, 200], [680, 200], [680, 280], [560, 280]], 1);
  for (const key of ["stroke_color", "stroke_width", "fill_color", "fill_enabled", "opacity"]) assert.equal(defaultItem.appearance[key], styled.appearance[key], key);
  const beforeSave = await snapshot(), roundtrip = await saveLoad(info);
  assert.deepEqual(roundtrip.saved.takeoffs.items, beforeSave.items); assert.deepEqual(roundtrip.reopened.items, beforeSave.items);
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  checks.push("new surface uses saved visual defaults; all seven records and retained basis values round-trip exactly while calculators remain unchanged");
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  await page.locator(".takeoff-register").screenshot({ path: path.join(output, "register.png") });
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: true, check_count: checks.length, checks, fixture_port: info.port,
    source_before_sha256: sourceBefore, source_after_sha256: hashes(), item_count: beforeSave.items.length, errors, csp: await page.evaluate(() => window.qaCsp), requests }, null, 2));
  console.log(`PASS: ${checks.length} area copy/visibility/default acceptance checks; ${beforeSave.items.length} disposable records. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, "failure.txt"), await page.locator("body").innerText().catch(() => "")); }
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ completed: false, checks, errors, requests, error: String(error), source_before_sha256: sourceBefore, source_after_sha256: hashes() }, null, 2));
}).finally(async () => { fs.writeFileSync(path.join(output, "server.log"), logs); await browser?.close(); server.kill(); });
