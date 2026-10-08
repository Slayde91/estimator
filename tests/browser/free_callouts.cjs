"use strict";
// Native Call-out creation, rich editing and drawing gestures on disposable PDFs.
const { chromium, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process"), { createHash } = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { chooseTakeoff } = require("./section_navigation.cjs"), { clickProjectControl } = require("./project_actions.cjs"), { renderDrawing } = require("./viewer_helpers.cjs");
const root = path.resolve(__dirname, "../.."), output = path.join(root, ".runtime/browser-qa", `free-callouts-${Date.now()}`), python = process.env.CEASEFIRE_PYTHON || "python";
fs.mkdirSync(output, { recursive: true });
const server = spawn(python, [path.join(__dirname, "fixtures.py"), "--directory", output], { cwd: root, windowsHide: true });
let logs = "", browser, page;
server.stderr.on("data", value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ""; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", value => { stdout += value; if (stdout.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); } } });
  server.once("error", error => { clearTimeout(timer); reject(error); }); server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const requests = [], errors = [], evidence = {}, copy = value => JSON.parse(JSON.stringify(value));
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const panel = () => page.locator("#takeoff-markup-settings"), editor = () => panel().getByRole("textbox", { name: "Item Details", exact: true });
const note = id => page.locator(`.takeoff-free-callout[data-annotation-id="${id}"]`);
async function idle() { await expect(page.locator("#takeoffs-workspace")).not.toHaveAttribute("aria-busy", "true"); }
async function snapshot() { await idle(); let value; await expect.poll(async () => { try { value = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); return true; } catch { return false; } }).toBe(true); return value; }
async function command(action, op) {
  const pending = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const reply = await pending, result = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(result)); await idle(); return result;
}
async function applied() { await editor().press("Tab"); await page.waitForFunction(() => !JSON.parse(window.CeasefireTakeoffs.projectFingerprint()).settingsDirty); await snapshot(); }
async function fit() { await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click(), 3); }
async function sourcePoint([x, y]) {
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => { const header = document.querySelector("header").getBoundingClientRect(); window.scrollBy(0, el.getBoundingClientRect().top - header.bottom - 12); });
  const box = await overlay.boundingBox(), point = [box.x + (y - 30) / 540 * box.width, box.y + (x - 20) / 780 * box.height];
  assert.equal(await page.evaluate(([a, b]) => !!document.elementFromPoint(a, b)?.closest(".takeoff-overlay"), point), true, "Native pointer reaches the rotated/cropped PDF"); return point;
}
function invariant(current, baseline) {
  for (const key of ["documents", "items", "calibrations", "transfers", "physical", "service_plans", "image_extractions"]) assert.deepEqual(current[key], baseline[key], `Free notes preserve ${key}`);
}
async function select(id) { await page.getByRole("button", { name: "Select", exact: true }).click(); await note(id).press("Enter"); await expect(editor()).toBeVisible(); }
async function drag(target, dx, dy) {
  await target.scrollIntoViewIfNeeded(); const bounds = await target.boundingBox(); assert.ok(bounds); const start = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".takeoff-free-callout"), start), true, "Native pointer reaches free note");
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0] + dx, start[1] + dy, { steps: 8 }); await page.mouse.up();
}
function normalizedSource(point, rotation) {
  const u = (point[0] - 20) / 780, v = (point[1] - 30) / 540;
  return [[u, 1 - v], [v, u], [1 - u, v], [1 - v, 1 - u]][rotation / 90];
}
async function assertAnnotationView(annotation, rotation) {
  const seen = await note(annotation.id).evaluate(el => {
    const overlay = el.ownerSVGElement, point = el.querySelector('[data-annotation-part="point"]'), label = el.querySelector('[data-annotation-part="label"]'), css = overlay.getBoundingClientRect();
    return { size: [+overlay.getAttribute("width"), +overlay.getAttribute("height")], cssSize: [css.width, css.height], point: [+point.getAttribute("cx"), +point.getAttribute("cy")], label: [+label.getAttribute("x"), +label.getAttribute("y"), +label.getAttribute("width"), +label.getAttribute("height")] };
  });
  const scale = seen.size[0] / ([90, 270].includes(rotation) ? 540 : 780);
  const point = normalizedSource(annotation.point, rotation).map((value, axis) => value * seen.size[axis]), label = normalizedSource(annotation.label_position, rotation).map((value, axis) => value * seen.size[axis]);
  assert.ok(Math.hypot(...seen.point.map((value, axis) => value - point[axis])) < 1e-8, "Quarter-turn keeps the independently transformed original source anchor");
  const expected = [Math.max(0, Math.min(seen.size[0] - annotation.width * scale, label[0])), Math.max(0, Math.min(seen.size[1] - annotation.height * scale, label[1])), annotation.width * scale, annotation.height * scale];
  seen.label.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-8, "Zoom and quarter-turn preserve source box dimensions with presentation-only clamping"));
  const marker = note(annotation.id).locator('[data-annotation-part="point"]'); await marker.scrollIntoViewIfNeeded();
  const bounds = await marker.boundingBox(), hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.dataset.annotationPart, [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]);
  assert.equal(hit, "point", "The original source marker remains accessible when the upright Call-out box overlaps it after rotation");
  return { ...seen, scale, markerHit: hit };
}
async function annotationMenuPosition(id, part, keyboard = false) {
  const target = note(id).locator(`[data-annotation-part="${part}"]`); await target.scrollIntoViewIfNeeded();
  let bounds = await target.boundingBox(); assert.ok(bounds);
  const chosen = [bounds.x + bounds.width * .7, bounds.y + bounds.height * .4];
  if (keyboard) { await note(id).focus(); bounds=await target.boundingBox(); await note(id).press('Shift+F10'); }
  else {
    assert.equal(await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.dataset.annotationPart, chosen),part,'Native right click reaches the intended Call-out part');
    await page.evaluate(() => document.querySelector('.takeoff-overlay').addEventListener('contextmenu',event=>{window.qaCalloutContext=[event.clientX,event.clientY];},{capture:true,once:true}));
    await page.mouse.click(...chosen,{button:'right'});
  }
  const menu = page.getByRole('menu',{name:'Call-out actions',exact:true}); await expect(menu).toBeVisible();
  const geometry = await menu.evaluate(el => {
    const holder=el.parentElement, overlay=holder.ownerSVGElement, viewport=document.querySelector('.takeoff-viewport'), viewer=viewport.parentElement;
    const svg=overlay.getBoundingClientRect(), frame=viewport.getBoundingClientRect(), upper=viewer.querySelector('.takeoff-viewer-top')?.getBoundingClientRect(), lower=viewer.querySelector('.takeoff-page-controls')?.getBoundingClientRect();
    return {menu:{x:+holder.getAttribute('x'),y:+holder.getAttribute('y'),width:+holder.getAttribute('width'),height:+holder.getAttribute('height')},svg:{x:svg.x,y:svg.y,width:svg.width,height:svg.height},size:[+overlay.getAttribute('width'),+overlay.getAttribute('height')],frame:{left:frame.left,right:frame.left+viewport.clientWidth,top:Math.max(frame.top,upper?.height?upper.bottom+6:frame.top),bottom:Math.min(frame.top+viewport.clientHeight,lower?.height?lower.top-6:frame.top+viewport.clientHeight)},native:window.qaCalloutContext};
  });
  const anchor=keyboard?[bounds.x+bounds.width/2,bounds.y+bounds.height/2]:geometry.native;
  const scale=geometry.size.map((size,axis)=>size/(axis?geometry.svg.height:geometry.svg.width));
  const expected=[Math.max(0,(geometry.frame.left-geometry.svg.x)*scale[0],Math.min((anchor[0]-geometry.svg.x)*scale[0]+9,Math.min(geometry.size[0],(geometry.frame.right-geometry.svg.x)*scale[0])-geometry.menu.width)),Math.max(0,(geometry.frame.top-geometry.svg.y)*scale[1],Math.min((anchor[1]-geometry.svg.y)*scale[1]+9,Math.min(geometry.size[1],(geometry.frame.bottom-geometry.svg.y)*scale[1])-geometry.menu.height))];
  // Native SVG rectangles have subpixel CSS quantization. Keep menu placement
  // within 0.01 CSS px; original PDF geometry remains checked at 1e-8 above.
  const cssError=[Math.abs(geometry.menu.x-expected[0])/scale[0],Math.abs(geometry.menu.y-expected[1])/scale[1]];
  assert.ok(cssError.every(value=>value<.01),`Rendered menu follows the native click or keyboard label anchor, with visible-view clamping: ${JSON.stringify({geometry,anchor,expected,cssError})}`);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  return {part,keyboard,anchor,menu:geometry.menu,expected,cssError};
}
async function download(filename) {
  const pending = page.waitForEvent("download"), request = page.waitForRequest(value => value.url().endsWith("/export/marked-pdf"));
  await page.evaluate(() => window.CeasefireTakeoffs.downloadDrawing()); const file = path.join(output, filename); await (await pending).saveAs(file); await idle(); return { file, request: (await request).postDataJSON() };
}
function inspectPdf(file) {
  const script = "import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1]);segments=[]\nfor p in r.pages:\n p.extract_text(visitor_text=lambda t,m,tm,f,s:segments.append({'text':t,'font':f.get('/BaseFont','') if f else ''}))\nprint(json.dumps({'text':'\\n'.join(p.extract_text() or '' for p in r.pages),'pages':len(r.pages),'segments':segments,'geometry':[[list(p.mediabox),list(p.cropbox),p.rotation,p.get('/UserUnit',1)] for p in r.pages]}))";
  const result = spawnSync(python, ["-c", script, file], { cwd: root, windowsHide: true, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function saveLoad(info) {
  const saving = page.waitForResponse(value => value.url().endsWith("/api/project/save-as")); saving.catch(() => {}); await clickProjectControl(page, "Save"); assert.equal((await saving).status(), 200);
  await expect(page.locator("#project-save-state")).toHaveText("Saved project"); const saved = JSON.parse(fs.readFileSync(info.project, "utf8"));
  const opening = page.waitForResponse(value => value.url().endsWith("/api/project/open")); opening.catch(() => {}); await clickProjectControl(page, "Load"); assert.equal((await opening).status(), 200);
  await page.getByRole("dialog").getByRole("button", { name: "Load Project", exact: true }).click(); await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  await page.getByRole("button", { name: "Takeoffs", exact: true }).click(); await chooseTakeoff(page, "steel");
  await renderDrawing(page, async () => { await page.getByLabel("Page number", { exact: true }).fill("3"); await page.getByLabel("Page number", { exact: true }).press("Tab"); }, 3);
  return { saved, reopened: await snapshot() };
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765); const sourceHash = hash(info.fixture), iconHash = hash(path.join(root, "static/icons/takeoff-callout.png"));
  assert.equal(iconHash, "068c58a46525a2618709cb4c77056214a9b1f4ff289d4785e1db8b7f50c9c8dd");
  const viewport=process.env.CEASEFIRE_CALLOUT_VIEWPORT==='1146x764'?{width:1146,height:764}:{width:1600,height:1100}; evidence.nativeViewport=viewport;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport, deviceScaleFactor: 2 }); page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message)); page.on("request", value => { if (value.url().endsWith("/commands") || /\/physical\/(preview|apply)$/.test(value.url())) requests.push({ endpoint: new URL(value.url()).pathname, body: value.postDataJSON() }); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener("securitypolicyviolation", event => window.qaCsp.push(event.effectiveDirective)); });
  const response = await page.goto(`http://127.0.0.1:${info.port}/`); assert.ok(!response.headers()["content-security-policy"].includes("unsafe-inline"));
  const iconResponse = await page.request.get(`http://127.0.0.1:${info.port}/icons/takeoff-callout.png`); assert.equal(iconResponse.status(), 200); assert.equal(createHash("sha256").update(await iconResponse.body()).digest("hex"), iconHash);
  await page.waitForFunction(() => window.CeasefireDesktop?.status().ready); await page.getByRole("button", { name: "Takeoffs", exact: true }).click();
  await renderDrawing(page, () => page.locator("#takeoff-upload").setInputFiles(info.fixture), 1);
  await renderDrawing(page, async () => { await page.getByLabel("Page number", { exact: true }).fill("3"); await page.getByLabel("Page number", { exact: true }).press("Tab"); }, 3); await fit();
  await page.locator(".takeoff-viewport").focus(); await page.keyboard.press("Control+Backslash"); await expect(page.getByRole("button", { name: "Viewport", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.locator(".takeoff-viewport").focus(); await page.keyboard.press("Control+Backslash"); await expect(page.getByRole("button", { name: "Viewport", exact: true })).toHaveAttribute("aria-expanded", "false");
  await renderDrawing(page, () => page.locator(".takeoff-viewport").press("Control+0"), 3); await expect(page.getByRole("button", { name: "Viewport", exact: true })).toHaveAttribute("aria-expanded", "false");
  const baseline = await snapshot(), calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); assert.equal(baseline.annotations, undefined);
  const created = {}, builtIn = { stroke_color: "#FF3300", fill_enabled: true, fill_color: "#FFDD33", font_color: "#000000", stroke_width: 4, opacity: .75 };
  let savedDefault;
  for (const [index, mode] of ["steel", "duct", "wall", "slab"].entries()) {
    await chooseTakeoff(page, mode); await fit(); await expect(page.getByRole("button", { name: "Call-out", exact: true })).toHaveAttribute("title", "Call-out (Ctrl+')");
    await expect(page.getByRole("button", { name: "Call-out", exact: true }).locator("img")).toHaveAttribute("src", "/icons/takeoff-callout.png");
    await page.locator(".takeoff-viewport").focus(); await page.keyboard.press("Control+'"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "callout");
    const reply = await command(async () => page.mouse.click(...await sourcePoint([220 + index * 70, 240])), "create_annotation"), annotation = reply.snapshot.annotations.callouts.find(value => value.id === reply.created_annotation_id);
    created[mode] = annotation.id; assert.equal(annotation.mode, mode); assert.equal(annotation.source_sha256, sourceHash); assert.equal(annotation.page, 3); assert.deepEqual(annotation.appearance, savedDefault || builtIn);
    invariant(reply.snapshot, baseline); await expect(panel()).toContainText("Item Details"); await expect(panel().locator("input,select,textarea")).toHaveCount(6); await expect(page.locator("tr[data-item-id]")).toHaveCount(0);
    for (const name of ['Apply Item Details','Discard pending edits','Hide Call-out','Delete Call-out','Undo last edit']) await expect(panel().getByRole('button',{name,exact:true})).toHaveCount(0);
    if (["steel", "duct"].includes(mode)) await expect(page.getByRole("button", { name: "Legend", exact: true })).toBeDisabled();
    await editor().fill(`NOTE-${mode}`); await editor().press("Control+a"); await panel().getByRole("button", { name: "Bold", exact: true }).click();
    await editor().press("Control+End"); await editor().press("Enter"); await panel().getByRole("button", { name: "Bullet list", exact: true }).click(); await editor().pressSequentially(`Entry-${mode}`);
    if (mode === "steel") {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await editor().focus(); await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([" SAFE_PASTE"], { type: "text/plain" }), "text/html": new Blob(['<img src="bad://callout" onerror="window.freeCalloutXss=1"><script>window.freeCalloutXss=2</script><b>SAFE_PASTE</b>'], { type: "text/html" }) })]));
      await editor().press("Control+v"); await expect(editor()).toContainText("SAFE_PASTE"); await expect(editor().locator("img,script,iframe,svg")).toHaveCount(0); assert.equal(await page.evaluate(() => window.freeCalloutXss), undefined);
    }
    await editor().press("Control+End"); await editor().press("Enter"); await editor().press("Enter"); await panel().getByRole("button", { name: "Numbered list", exact: true }).click(); await editor().pressSequentially(`Number-${mode}`); await editor().press("Shift+Enter"); await editor().pressSequentially(`continued-${mode}`);
    await applied(); let current = await snapshot(), changed = current.annotations.callouts.find(value => value.id === annotation.id); invariant(current, baseline);
    assert.ok(changed.content.blocks.some(block => block.kind === "bullet" && block.runs.some(run => run.text.includes(`Entry-${mode}`)))); assert.ok(changed.content.blocks.some(block => block.runs.some(run => run.bold && run.text.includes(`NOTE-${mode}`))));
    assert.ok(changed.content.blocks.some(block => block.kind === "number" && block.runs.map(run => run.text).join("").includes(`Number-${mode}\ncontinued-${mode}`)), "Shift+Enter preserves one numbered entry with an explicit line break");
    await expect(note(annotation.id)).toContainText(`NOTE-${mode}`); await expect(note(annotation.id).locator('tspan[font-weight="700"]')).not.toHaveCount(0);
    const textFit = await note(annotation.id).evaluate(el => { const label = el.querySelector('[data-annotation-part="label"]'), text = el.querySelector("text").getBBox(), x = +label.getAttribute("x"), y = +label.getAttribute("y"), width = +label.getAttribute("width"), height = +label.getAttribute("height"); return { fits: text.x >= x && text.y >= y && text.x + text.width <= x + width && text.y + text.height <= y + height, text: { x: text.x, y: text.y, width: text.width, height: text.height }, label: { x, y, width, height } }; });
    assert.equal(textFit.fits, true, "Actual formatted drawing text fits the Call-out box"); (evidence.textFits ||= {})[mode] = textFit;
    const currentVisibility = panel().getByRole("button", { name: "Visibility", exact: true }), beforeVisibility = await snapshot(), visibilityRequests = requests.length, detailsBeforeVisibility = await editor().innerText();
    await expect(currentVisibility.locator("img")).toHaveAttribute("src", "/icons/takeoff-visibility.png"); await expect(currentVisibility).toHaveAttribute("aria-pressed", "false");
    await currentVisibility.click(); await expect(note(annotation.id)).toHaveCount(0); await expect(currentVisibility).toHaveAttribute("aria-pressed", "true"); await expect(editor()).toBeVisible(); assert.equal(await editor().innerText(), detailsBeforeVisibility);
    await currentVisibility.click(); await expect(note(annotation.id)).toBeVisible(); await expect(currentVisibility).toHaveAttribute("aria-pressed", "false"); assert.deepEqual(await snapshot(), beforeVisibility); assert.equal(requests.length, visibilityRequests, "Current Call-out Visibility sends no canonical command");
    (evidence.currentVisibility ||= {})[mode] = { reversible: true, detailsRemainOpen: true, sameSnapshotAndQuantities: true, noCommand: true };
    await editor().focus(); await editor().press("Control+a"); assert.ok((await page.evaluate(() => getSelection().toString())).includes(`NOTE-${mode}`)); await editor().press("Control+'"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "select");
    if (mode === "steel") {
      await panel().getByLabel("Line Colour", { exact: true }).fill("#00aa11"); await panel().getByLabel("Line Width", { exact: true }).fill("7"); await panel().getByLabel("Opacity", { exact: true }).fill("65"); await applied();
      await panel().getByRole("button", { name: "Set as default", exact: true }).click(); savedDefault = { ...builtIn, stroke_color: "#00aa11", fill_color: "#ffdd33", stroke_width: 7, opacity: .65 };
      assert.deepEqual(await page.evaluate(() => window.CeasefireTakeoffAnnotations.defaults()), savedDefault);
    }
    await panel().getByRole("button", { name: "Close settings", exact: true }).click();
    if (mode === "duct") {
      await page.locator(".takeoff-viewport").focus(); await page.keyboard.press("Control+F3"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "count-only");
      await page.keyboard.press("Control+;"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "select");
    }
  }
  assert.equal(new Set(Object.values(created)).size, 4); evidence.allModes = copy(created); evidence.richText = { bold: true, bullet: true, numberedShiftEnter: true, safePaste: true, nativeEditing: true };
  await chooseTakeoff(page, "steel"); await fit(); await select(created.steel);
  const savedBeforeInvalid=await snapshot(), requestsBeforeInvalid=requests.length, invalidText='X'.repeat(8001);
  await editor().fill(invalidText); await panel().getByRole('button',{name:'Close settings',exact:true}).click();
  let invalidDialog=page.getByRole('dialog',{name:'Discard pending Call-out edits?',exact:true}); await expect(invalidDialog).toBeVisible();
  await invalidDialog.getByRole('button',{name:'Cancel',exact:true}).click(); await expect(editor()).toHaveText(invalidText);
  assert.equal(requests.length,requestsBeforeInvalid,'Invalid Item Details never sends an annotation command');
  await panel().getByRole('button',{name:'Close settings',exact:true}).click(); await expect(invalidDialog).toBeVisible();
  await invalidDialog.getByRole('button',{name:'Discard edits',exact:true}).click(); await expect(panel()).toBeHidden();
  assert.deepEqual(await snapshot(),savedBeforeInvalid,'Discarding pending invalid text preserves the previously saved rich details and source');
  await select(created.steel); await expect(editor()).toContainText('NOTE-steel');
  evidence.invalidDraft={cancelKeepsPendingText:true,explicitDiscardPreservesSavedDetails:true,noAnnotationCommand:true};
  const beforeMove = (await snapshot()).annotations.callouts.find(value => value.id === created.steel);
  let moved = await command(() => drag(note(created.steel).locator('[data-annotation-part="label"]'), 25, 18), "update_annotation"), movedNote = moved.snapshot.annotations.callouts.find(value => value.id === created.steel);
  assert.deepEqual(movedNote.point, beforeMove.point); assert.notDeepEqual(movedNote.label_position, beforeMove.label_position); assert.equal(movedNote.id, beforeMove.id); invariant(moved.snapshot, baseline);
  const undo = await command(() => page.getByRole("button", { name: "Undo last edit", exact: true }).click(), "undo"), restored = undo.snapshot.annotations.callouts.find(value => value.id === created.steel);
  for (const key of Object.keys(beforeMove).filter(value => value !== "version")) assert.deepEqual(restored[key], beforeMove[key], `Undo restores annotation ${key}`); assert.ok(restored.version > beforeMove.version);
  await select(created.steel); moved = await command(() => drag(note(created.steel).locator('[data-annotation-part="point"]'), 20, 15), "update_annotation"); movedNote = moved.snapshot.annotations.callouts.find(value => value.id === created.steel);
  assert.notDeepEqual(movedNote.point, restored.point); assert.notDeepEqual(movedNote.label_position, restored.label_position); assert.equal(movedNote.id, restored.id); invariant(moved.snapshot, baseline); evidence.dragAndUndo = { sourceCoordinates: movedNote.point, stableId: movedNote.id, quantityUnchanged: true };
  await select(created.steel); const beforeResize = copy(movedNote);
  const resized = await command(() => drag(page.locator('[data-annotation-part="resize"][data-corner="se"]'), 18, 16), "update_annotation"), resizedNote = resized.snapshot.annotations.callouts.find(value => value.id === created.steel);
  assert.ok(resizedNote.width > beforeResize.width); assert.ok(resizedNote.height > beforeResize.height); assert.deepEqual(resizedNote.point, beforeResize.point); assert.deepEqual(resizedNote.label_position, beforeResize.label_position); assert.equal(resizedNote.id, beforeResize.id); assert.deepEqual(resizedNote.content, beforeResize.content); invariant(resized.snapshot, baseline); evidence.resize = { width: resizedNote.width, height: resizedNote.height, textAndSourceUnchanged: true };
  let viewStable = copy(resizedNote); evidence.viewerRotations = [];
  for (const offset of [90, 180, 270, 0]) {
    await renderDrawing(page, () => page.getByRole("button", { name: "Rotate page", exact: true }).click(), 3); await fit();
    const rotation = (90 + offset) % 360, fitted = await assertAnnotationView(viewStable, rotation);
    await renderDrawing(page, () => page.getByRole("button", { name: "+", exact: true }).click(), 3); const zoomed = await assertAnnotationView(viewStable, rotation); assert.ok(zoomed.scale > fitted.scale);
    const menuSnapshot=await snapshot(), menuCommands=requests.length, menuPositions=[];
    for (const part of ['label','point']) menuPositions.push(await annotationMenuPosition(created.steel,part));
    menuPositions.push(await annotationMenuPosition(created.steel,'label',true));
    assert.deepEqual(await snapshot(),menuSnapshot); assert.equal(requests.length,menuCommands,'Opening and closing Call-out menus sends no annotation command');
    (evidence.menuPositions ||= []).push({rotation,croppedSource:true,userUnit:2,zoomed:true,menuPositions});
    await renderDrawing(page, () => page.getByRole("button", { name: "−", exact: true }).click(), 3); await assertAnnotationView(viewStable, rotation);
    assert.deepEqual((await snapshot()).annotations.callouts.find(value => value.id === created.steel), viewStable); invariant(await snapshot(), baseline);
    if (rotation === 0) {
      await select(created.steel); const display = await assertAnnotationView(viewStable, rotation), dx = 13, dy = 11;
      const pointMoved = await command(() => drag(note(created.steel).locator('[data-annotation-part="point"]'), dx, dy), "update_annotation"), changed = pointMoved.snapshot.annotations.callouts.find(value => value.id === created.steel);
      // Native pointer coordinates use the browser's CSS dimensions, which may
      // quantize the mathematically exact SVG dimensions by a small fraction.
      assert.ok(Math.abs(changed.point[0] - (viewStable.point[0] + dx / display.cssSize[0] * 780)) < 1e-8); assert.ok(Math.abs(changed.point[1] - (viewStable.point[1] - dy / display.cssSize[1] * 540)) < 1e-8);
      assert.deepEqual([changed.width, changed.height], [viewStable.width, viewStable.height]); assert.equal(changed.id, viewStable.id); invariant(pointMoved.snapshot, baseline);
      const undone = await command(() => page.getByRole("button", { name: "Undo last edit", exact: true }).click(), "undo"), restoredView = undone.snapshot.annotations.callouts.find(value => value.id === created.steel);
      for (const key of Object.keys(viewStable).filter(value => value !== "version")) assert.deepEqual(restoredView[key], viewStable[key], `Rotated source drag undo restores ${key}`);
      viewStable = copy(restoredView); await assertAnnotationView(viewStable, rotation); evidence.rotatedSourceDrag = { markerAccessibleThroughOverlappingBox: true, originalCoordinatesRestored: true, stableId: viewStable.id };
    }
    evidence.viewerRotations.push({ offset, rotation, fitted, zoomed, originalStoredCoordinatesAndBoxUnchanged: true });
  }
  // Native selection does not open Settings; the second stationary click does.
  await panel().getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const stationarySnapshot = await snapshot(), stationaryCommands = requests.length;
  const selectedLabel = note(created.steel).locator('[data-annotation-part="label"]');
  await selectedLabel.click(); await expect(panel()).toBeHidden();
  await expect(note(created.steel)).toHaveAttribute("aria-pressed", "true");
  await expect(note(created.steel).locator('[data-annotation-part="resize"]')).toHaveCount(4);
  await expect(note(created.steel).locator('.takeoff-annotation-selection')).toHaveCount(1);
  await selectedLabel.dblclick(); await expect(editor()).toBeVisible();
  assert.deepEqual(await snapshot(), stationarySnapshot, 'Native stationary single and double clicks change selection/settings only'); assert.equal(requests.length, stationaryCommands, 'Stationary selection sends no annotation command');
  const widths = await editor().evaluate(el => ({editor:el.getBoundingClientRect().width,fields:el.closest('.takeoff-settings-fields').getBoundingClientRect().width}));
  assert.ok(widths.editor > widths.fields * .9, 'Item Details spans both Settings columns');
  assert.equal(await panel().locator('small.helper').filter({hasText:/^%$/}).count(),0);
  for (const [corner,dx,dy] of [["nw",-12,-10],["ne",12,-10],["sw",-12,10],["se",12,10]]) {
    const previous = (await snapshot()).annotations.callouts.find(value=>value.id===created.steel);
    const resized = await command(()=>drag(note(created.steel).locator(`[data-annotation-part="resize"][data-corner="${corner}"]`),dx,dy),"update_annotation");
    const result = resized.snapshot.annotations.callouts.find(value=>value.id===created.steel);
    assert.ok(result.width>previous.width && result.height>previous.height,`${corner} grows both dimensions`);
    assert.deepEqual(result.point,previous.point); assert.deepEqual(result.content,previous.content); invariant(resized.snapshot,baseline);
    const undone=await command(()=>page.getByRole("button",{name:"Undo last edit",exact:true}).click(),"undo");
    const restored=undone.snapshot.annotations.callouts.find(value=>value.id===created.steel);
    for(const key of Object.keys(previous).filter(key=>key!=="version")) assert.deepEqual(restored[key],previous[key]);
  }
  await renderDrawing(page, () => page.getByRole('button', { name: 'Rotate page', exact: true }).click(), 3); await fit(); await select(created.steel);
  const rotatedCorners = [];
  for (const [corner, dx, dy] of [['nw', 8, 7], ['ne', -8, 7], ['sw', 8, -7], ['se', -8, -7]]) {
    const previous = (await snapshot()).annotations.callouts.find(value => value.id === created.steel), before = await assertAnnotationView(previous, 180);
    const resized = await command(() => drag(note(created.steel).locator(`[data-annotation-part="resize"][data-corner="${corner}"]`), dx, dy), 'update_annotation'), changed = resized.snapshot.annotations.callouts.find(value => value.id === created.steel), after = await assertAnnotationView(changed, 180);
    assert.ok(changed.width < previous.width && changed.height < previous.height, `${corner} shrinks both displayed dimensions after the quarter-turn`); assert.deepEqual(changed.point, previous.point); assert.deepEqual(changed.content, previous.content); invariant(resized.snapshot, baseline);
    const opposite = rectangle => [rectangle[0] + (corner.includes('w') ? rectangle[2] : 0), rectangle[1] + (corner.includes('n') ? rectangle[3] : 0)];
    opposite(after.label).forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - opposite(before.label)[axis]) < 1e-8, 'Rotated corner resize keeps the opposite displayed corner fixed'));
    const undone = await command(() => page.getByRole('button', { name: 'Undo last edit', exact: true }).click(), 'undo'), restored = undone.snapshot.annotations.callouts.find(value => value.id === created.steel);
    for (const key of Object.keys(previous).filter(value => value !== 'version')) assert.deepEqual(restored[key], previous[key], `Rotated resize undo restores ${key}`);
    rotatedCorners.push({ corner, originalAnchorUnchanged: true, oppositeDisplayedCornerFixed: true, originalGeometryRestored: true });
  }
  for (let index = 0; index < 3; index++) await renderDrawing(page, () => page.getByRole('button', { name: 'Rotate page', exact: true }).click(), 3); await fit(); await select(created.steel);
  await panel().getByRole("button", {name:"Close settings",exact:true}).click();
  await page.locator('.takeoff-viewport').focus(); await page.keyboard.press('Control+c');
  const destination=await sourcePoint([420,300]);
  await page.evaluate(() => {
    window.qaPastePointer = null;
    document.querySelector('.takeoff-viewport').addEventListener('pointermove', event => {
      const rect = document.querySelector('.takeoff-overlay').getBoundingClientRect();
      // Independently invert the intrinsic90 rotated, cropped source using the
      // native event/CSS coordinates, including Chromium input quantization.
      window.qaPastePointer = { client: [event.clientX, event.clientY], original: [20 + (event.clientY - rect.top) / rect.height * 780, 30 + (event.clientX - rect.left) / rect.width * 540] };
    }, { once: true });
  });
  await page.mouse.move(...destination); const nativePastePointer = await page.evaluate(() => window.qaPastePointer); assert.ok(nativePastePointer);
  const pasted=await command(()=>page.keyboard.press('Control+v'),'create_annotation');
  const pastedNote=pasted.snapshot.annotations.callouts.find(value=>value.id===pasted.created_annotation_id);
  const original=pasted.snapshot.annotations.callouts.find(value=>value.id===created.steel);
  assert.notEqual(pastedNote.id,original.id); assert.deepEqual(pastedNote.content,original.content); assert.deepEqual(pastedNote.appearance,original.appearance);
  pastedNote.point.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - nativePastePointer.original[axis]) < 1e-8, 'Paste stores the exact independently transformed native pointer PDF coordinate'));
  invariant(pasted.snapshot,baseline); await expect(panel()).toBeHidden();
  const fastSelectionSnapshot = await snapshot(), fastSelectionCommands = requests.length;
  await note(pastedNote.id).locator('[data-annotation-part="label"]').click(); await note(created.steel).locator('[data-annotation-part="point"]').click();
  await expect(note(created.steel)).toHaveAttribute('aria-pressed', 'true'); await expect(note(pastedNote.id)).toHaveAttribute('aria-pressed', 'false'); await expect(panel()).toBeHidden();
  assert.deepEqual(await snapshot(), fastSelectionSnapshot, 'Rapid native selection between distinct notes changes no saved records'); assert.equal(requests.length, fastSelectionCommands);
  await select(created.steel); const siblingSnapshot = await snapshot(), siblingRequests = requests.length, visibility = panel().getByRole('button', {name:'Visibility',exact:true});
  await visibility.click(); await expect(note(created.steel)).toHaveCount(0); await expect(note(pastedNote.id)).toBeVisible(); await expect(editor()).toBeVisible();
  await visibility.click(); await expect(note(created.steel)).toBeVisible(); await expect(note(pastedNote.id)).toBeVisible(); assert.deepEqual(await snapshot(),siblingSnapshot); assert.equal(requests.length,siblingRequests,'Hiding one Call-out never hides or edits another'); evidence.currentVisibility.otherCalloutUnchanged=true;
  await note(pastedNote.id).locator('[data-annotation-part="point"]').click({button:'right'});
  await command(()=>page.getByRole('menuitem',{name:'Delete',exact:true}).click(),'delete_annotation');
  await select(created.steel);
  const deleteUndo=await command(()=>page.getByRole('button',{name:'Undo last edit',exact:true}).click(),'undo');
  assert.ok(deleteUndo.snapshot.annotations.callouts.some(value=>value.id===pastedNote.id));
  await select(pastedNote.id);
  await note(pastedNote.id).locator('[data-annotation-part="label"]').click({button:'right'});
  await command(()=>page.getByRole('menuitem',{name:'Delete',exact:true}).click(),'delete_annotation');
  await select(created.steel);
  evidence.selectionCornersClipboard={singleSelect:true,doubleClickSettings:true,stationaryClicksSendNoCommand:true,rapidDifferentIdentitySelect:true,fourCorners:true,rotatedCorners,fullDetailsWidth:widths,pointerPaste:{native:nativePastePointer,stored:pastedNote.point},contextDeleteUndo:true};
  const beforeExport = await snapshot(), visible = await download("free-callouts-visible.pdf"), visiblePdf = inspectPdf(visible.file), sourcePdf = inspectPdf(info.fixture);
  const visibleText = visiblePdf.text.replace(/[\r\n]/g, ""), boldText = visiblePdf.segments.filter(value => /Bold/.test(value.font)).map(value => value.text).join("").replace(/[\r\n]/g, "");
  assert.deepEqual(visible.request.item_ids, []); assert.deepEqual(visible.request.annotation_ids, [created.steel]); assert.ok(visibleText.includes("NOTE-steel")); assert.ok(visibleText.includes("SAFE_PASTE")); assert.ok(visibleText.includes("• Entry-steel")); assert.ok(visibleText.includes("1. Number-steel")); assert.ok(boldText.includes("NOTE-steel"), "Every NOTE heading character keeps its bold font in PDF output");
  assert.ok(visibleText.includes("1 free Call-out (drawing notes only); no measurement markups."), "Annotation-only caption counts the drawing note without inventing measurements");
  assert.equal(visiblePdf.pages, sourcePdf.pages); invariant(await snapshot(), baseline);
  await select(created.steel); await note(created.steel).locator('[data-annotation-part="label"]').click({button:'right'}); await page.getByRole('menuitem',{name:'Hide',exact:true}).click(); await expect(note(created.steel)).toHaveCount(0);
  const hidden = await download("free-callouts-hidden.pdf"), hiddenPdf = inspectPdf(hidden.file); assert.deepEqual(hidden.request.annotation_ids, []); assert.ok(!hiddenPdf.text.replace(/[\r\n]/g, "").includes("NOTE-steel")); assert.deepEqual(hiddenPdf.geometry, visiblePdf.geometry, "Showing notes preserves the established drawing derivative geometry"); assert.deepEqual((await snapshot()).annotations, beforeExport.annotations);
  evidence.pdf = { visible: visible.file, hidden: hidden.file, noteVisibleOnlyWhenShown: true, sourceMetadata: sourcePdf.geometry, drawingDerivativeGeometry: visiblePdf.geometry, notesPreserveDerivativeGeometry: true };
  const beforeSave = await snapshot(), roundtrip = await saveLoad(info); assert.deepEqual(roundtrip.saved.takeoffs.annotations, beforeSave.annotations); assert.deepEqual(roundtrip.reopened.annotations, beforeSave.annotations); invariant(roundtrip.reopened, baseline); await expect(note(created.steel)).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators); assert.equal(hash(info.fixture), sourceHash); evidence.saveReopen = { sameIdsAndRichText: true, sourceHash, calculatorStateUnchanged: true };
  for (const section of ["Defect Reports", "Service Plans"]) {
    await chooseTakeoff(page, section); const control = page.getByRole("button", { name: "Call-out", exact: true }); await expect(control).toHaveAttribute("title", "Call-out (Ctrl+')"); await expect(control.locator("img")).toHaveAttribute("src", "/icons/takeoff-callout.png"); await expect(page.getByRole("button", { name: "Count", exact: true })).toHaveCount(0);
    await page.locator(".takeoff-viewport").focus(); await page.keyboard.press("Control+F3"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "select"); await page.keyboard.press("Control+'"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "count"); await page.keyboard.press("Control+;"); await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", "select");
  }
  assert.ok(requests.every(value => !/\/physical\/(preview|apply)$/.test(value.endpoint)), "Free notes and physical tool activation never issue physical approvals"); evidence.physical = { nameAndOriginalIcon: true, distinctShortcut: true, noPhysicalMutation: true, iconHash };
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []); await page.screenshot({ path: path.join(output, "completed.png"), fullPage: true });
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: true, evidence, errors, requests }, null, 2));
  console.log(`PASS: all four free Call-out workspaces, rich text/native paste, unique shortcuts, shared defaults, original coordinates/undo, Save/reopen, visible marked PDF and separate physical naming. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); console.error(logs.slice(-3000)); process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, "failure.txt"), await page.locator("body").innerText().catch(() => "")); fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ requests, fingerprint: await page.evaluate(() => window.CeasefireTakeoffs?.projectFingerprint()).catch(() => null) }, null, 2)); }
}).finally(async () => { fs.writeFileSync(path.join(output, "server.log"), logs); if (browser) await browser.close(); server.kill(); });
