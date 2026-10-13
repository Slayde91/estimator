"use strict";
// All ink, source PDFs, saved projects and browser storage belong to this
// disposable fixture. This journey never opens the live application on 8765.
const { chromium, expect } = require("@playwright/test");
const { chooseTakeoff } = require("./section_navigation.cjs"), { clickProjectControl } = require("./project_actions.cjs");
const { renderDrawing } = require("./viewer_helpers.cjs"), { settingsSettled } = require("./settings_helpers.cjs");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."), output = path.join(root, ".runtime/browser-qa", `graphics-${Date.now()}`), python = process.env.CEASEFIRE_PYTHON || "python";
fs.mkdirSync(output, { recursive: true });
const assets = ["static/takeoffs.js", "static/takeoff-annotations.js", "static/takeoff-graphics.js", "static/takeoff-graphics-ui.js", "static/takeoffs.css", "static/icons/takeoff-measure.png", "estimator/takeoff_graphics.py", "estimator/takeoff_stamp_layout.py", "estimator/takeoff_textbox_layout.py", "estimator/takeoff_initial_links.py", "estimator/takeoff_workspace.py", "estimator/takeoff_markup_pdf_worker.py", "tests/browser/graphics.cjs", "tests/browser/graphics_export_content.py"];
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hashes = () => Object.fromEntries(assets.map(name => [name, hash(path.join(root, name))]));
const sourceBefore = hashes(), checks = [], errors = [], requests = [], projectWrites = [], pdfExports = [];
const check = name => { checks.push(name); console.log(`ok - ${name}`); };
const server = spawn(python, [path.join(__dirname, "fixtures.py"), "--directory", output], { cwd: root, windowsHide: true });
let browser, page, logs = ""; server.stderr.on("data", value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let stdout = ""; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", value => { stdout += value; if (stdout.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); } } });
  server.once("error", error => { clearTimeout(timer); reject(error); }); server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const panel = () => page.locator("#takeoff-markup-settings"), graphic = id => page.locator(`.takeoff-graphic[data-graphic-id="${id}"]`);
const idle = () => settingsSettled(page);
async function snapshot() { await idle(); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); }
async function command(action, op) {
  const pending = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === op); pending.catch(() => {});
  await action(); const reply = await pending, value = await reply.json(); assert.equal(reply.status(), 200, JSON.stringify(value)); await idle(); return value;
}
async function fit() { await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click()); await idle(); }
function normalized(point, view, rotation) {
  const u = (point[0]-view[0])/(view[2]-view[0]), v = (point[1]-view[1])/(view[3]-view[1]);
  return [[u,1-v],[v,u],[1-u,v],[1-v,1-u]][rotation/90];
}
async function screen(point, view = [0,0,842,595], rotation = 0) {
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 190));
  const box = await overlay.boundingBox(), p = normalized(point, view, rotation), result = [box.x+box.width*p[0], box.y+box.height*p[1]];
  assert.equal(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest(".takeoff-overlay"), result), true, "Pointer reaches the synthetic source page"); return result;
}
function invariant(current, baseline) {
  for (const key of ["documents", "items", "calibrations", "transfers", "physical", "service_plans", "image_extractions", "annotations", "signatures"])
    assert.deepEqual(current[key], baseline[key], `PDF markup operations preserve ${key}`);
}
async function dialog(title, values, submit) {
  const modal = page.getByRole("dialog"); await expect(modal.getByRole("heading", { name: title, exact: true })).toBeVisible();
  for (const [name,value] of Object.entries(values)) { const field = modal.getByLabel(name, { exact: true });
    if (await field.evaluate(el=>el.tagName) === "SELECT") await field.selectOption(String(value)); else await field.fill(String(value)); }
  await modal.getByRole("button", { name: submit, exact: true }).click(); await expect(page.locator("dialog.takeoff-dialog")).toHaveCount(0);
}
const labels = {cloud:"Cloud",textbox:"Textbox",stamp:"Stamp",line:"Line/Polyline",polyline:"Line/Polyline",arrow:"Arrow",rectangle:"Rectangle",circle:"Circle",polygon:"Polygon"};
async function insert(kind, points, options = {}) {
  const button = page.locator(".takeoff-markup-rail").getByRole("button", { name: labels[kind], exact: true }); await button.click();
  const tool = kind === "line" ? "polyline" : kind; await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool", `graphic-${tool}`);
  const draw = async () => {
    for (const p of (["textbox","stamp"].includes(kind) ? points.slice(0,1) : points)) await page.mouse.click(...await screen(p, options.view, options.rotation));
    if (["line","polyline","polygon"].includes(kind)) await page.locator(".takeoff-viewport").press("Enter");
    if (["textbox","stamp"].includes(kind)) await dialog(labels[kind], {[`${labels[kind]} text`]: options.text || (kind === "stamp" ? "REVIEWED" : "Literal <b>note</b> é")}, kind === "stamp" ? "Create stamp" : "Place markup");
  };
  const result = await command(draw, kind === "textbox" ? "create_textbox" : kind === "stamp" ? "create_stamp" : "create_graphic"), record = result.snapshot.graphics.records.find(v=>v.id===result.created_graphic_id);
  assert.equal(record.kind, kind); assert.equal(record.source_sha256, result.snapshot.documents.find(v=>v.id===record.document_id).sha256);
  assert.equal(record.version, 1); await expect(graphic(record.id)).toBeVisible();
  if(kind === "stamp") { await expect(page.locator(".takeoff-viewport")).toHaveAttribute("data-tool","graphic-stamp");await select(record.id); }
  await expect(panel().getByRole("heading", {name:`${kind === "line" ? "Line" : labels[kind]} Settings`,exact:true})).toBeVisible();
  if (kind === "textbox") {
    const payload=requests.at(-1).textbox; for(const key of ["mode","document_id","source_sha256","page","text","appearance"])assert.deepEqual(payload[key],record[key]);
    assert.deepEqual(payload.anchor_pdf,record.geometry.quad_pdf[0],"Single native click remains the retained PDF anchor");assert.equal(payload.geometry,undefined,"Creation sends no fabricated box");
    assert.equal(payload.display_rotation,options.rotation||0);assert.equal(record.appearance.font_size,12,"Automatic sizing preserves requested font size");assert.ok(result.textbox_layout.width_pt>0&&result.textbox_layout.height_pt>0&&result.textbox_layout.line_count>=1);
  } else if(kind === "stamp") {const payload=requests.at(-1).stamp;for(const key of ["mode","document_id","source_sha256","page","text","appearance"])assert.deepEqual(payload[key],record[key]);assert.equal(payload.geometry,undefined);for(const axis of [0,1])assert.ok(Math.abs(record.geometry.quad_pdf.reduce((n,p)=>n+p[axis],0)/4-payload.anchor_pdf[axis])<1e-8);assert.ok(result.stamp_layout.width_pt>0&&result.stamp_layout.height_pt>0);}
  else { const payload=requests.at(-1).graphic;for(const key of ["kind","mode","document_id","source_sha256","page","geometry","text","appearance"])assert.deepEqual(payload[key],record[key]); }
  return {record,result};
}
async function select(id) {
  await page.getByRole("button", {name:"Select",exact:true}).click(); await graphic(id).press("Enter"); await expect(panel()).toBeVisible(); await idle();
}
async function drag(target, dx, dy, id) {
  await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(), start = [box.x+box.width/2,box.y+box.height/2];
  assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.closest(".takeoff-graphic")?.dataset.graphicId,start), id, "Native pointer reaches the chosen graphic");
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(start[0]+dx,start[1]+dy,{steps:8}); await page.mouse.up();
}
async function download(name, expectedIds, mode, scope = null) {
  const before = await snapshot(), pending = page.waitForEvent("download"), request = page.waitForRequest(v=>v.url().endsWith("/export/marked-pdf"));
  await page.evaluate(()=>window.CeasefireTakeoffs.downloadDrawing()); const file = await pending, target = path.join(output,name);
  assert.equal(await file.failure(),null); await file.saveAs(target); const body=(await request).postDataJSON(); await idle();
  assert.deepEqual(body.graphic_ids,expectedIds); assert.equal(body.mode,mode); if(scope) assert.equal(body.physical_scope,scope);
  assert.deepEqual(await snapshot(),before,"PDF export is read-only");
  const spec=path.join(output,`${name}.json`);fs.writeFileSync(spec,JSON.stringify({records:before.graphics.records.filter(v=>expectedIds.includes(v.id)),document:before.documents.find(v=>v.id===body.document_id),physical:!!scope,rotations:body.rendering?.rotations||{}}));
  const inspected=spawnSync(python,["-X","utf8","-B",path.join(__dirname,"graphics_export_content.py"),target,spec],{cwd:root,windowsHide:true,encoding:"utf8"});
  assert.equal(inspected.status,0,inspected.stderr);const proof=JSON.parse(inspected.stdout);pdfExports.push({file:target,body,proof});return proof;
}
async function saveLoad(info) {
  const before=await snapshot(),saving=page.waitForResponse(v=>v.url().endsWith("/api/project/save-as"));saving.catch(()=>{});
  await clickProjectControl(page,"Save");assert.equal((await saving).status(),200);await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  assert.deepEqual(JSON.parse(fs.readFileSync(info.project,"utf8")).takeoffs.graphics,before.graphics);
  const opening=page.waitForResponse(v=>v.url().endsWith("/api/project/open"));opening.catch(()=>{});await clickProjectControl(page,"Load");assert.equal((await opening).status(),200);
  await page.getByRole("dialog").getByRole("button",{name:"Load Project",exact:true}).click();await expect(page.locator("#project-save-state")).toHaveText("Saved project");
  await renderDrawing(page,async()=>{await page.getByRole("button",{name:"Takeoffs",exact:true}).click();await chooseTakeoff(page,"wall");},1);
  const after=await snapshot();assert.deepEqual(after.graphics,before.graphics);invariant(after,before);
  const visible=after.graphics.records.filter(value=>["wall","slab"].includes(value.mode)&&value.page===1);
  await expect(page.locator(".takeoff-graphic")).toHaveCount(visible.length);for(const value of visible)await expect(graphic(value.id)).toBeVisible();return after;
}
async function unfinishedGuards() {
  const before=await snapshot(), count=requests.length, writes=projectWrites.length;
  await page.locator(".takeoff-markup-rail").getByRole("button",{name:"Polygon",exact:true}).click();await page.mouse.click(...await screen([60,170]));
  const retained=await page.evaluate(()=>JSON.parse(window.CeasefireTakeoffs.projectFingerprint()));
  const guard=await page.evaluate(()=>{try{window.CeasefireTakeoffs.projectSnapshot();return false;}catch(e){return e.message;}});assert.match(guard,/unfinished.*drawing.*before saving/);
  await clickProjectControl(page,"Save");await expect(page.getByRole("button",{name:"Save",exact:true})).toBeEnabled({timeout:30000});await expect(page.locator("#app-message")).toContainText("Project was not saved.");assert.equal(projectWrites.length,writes);
  const modal=page.getByRole("dialog",{name:"Discard unfinished edits?",exact:true});
  await page.getByRole("button",{name:"Page ›",exact:true}).click();await expect(modal).toBeVisible();await modal.getByRole("button",{name:"Cancel",exact:true}).click();await expect(modal).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(window.CeasefireTakeoffs.projectFingerprint())),retained);assert.equal(requests.length,count);
  await renderDrawing(page,async()=>{await page.getByRole("button",{name:"Page ›",exact:true}).click();await expect(modal).toBeVisible();await modal.getByRole("button",{name:"Discard edits",exact:true}).click();},2);
  assert.deepEqual((await snapshot()).graphics,before.graphics);await renderDrawing(page,()=>page.getByRole("button",{name:"‹ Page",exact:true}).click(),1);await fit();invariant(await snapshot(),before);
  check("unfinished graphic trace blocks Save; Cancel navigation retains it and explicit discard creates no visual record");
}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);const originalHash=hash(info.area_fixture);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:2});page.setDefaultTimeout(30000);
  page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(r.url().endsWith("/commands"))requests.push(r.postDataJSON());if(r.method()==="POST"&&/\/api\/project\/save(?:-as)?$/.test(new URL(r.url()).pathname))projectWrites.push(r.url());});
  await page.addInitScript(()=>{window.qaCsp=[];document.addEventListener("securitypolicyviolation",e=>window.qaCsp.push(e.effectiveDirective));});
  await page.goto(`http://127.0.0.1:${info.port}/`);await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready);await page.getByRole("button",{name:"Takeoffs",exact:true}).click();await chooseTakeoff(page,"wall");
  await renderDrawing(page,()=>page.locator("#takeoff-upload").setInputFiles(info.area_fixture),1);await idle();assert.equal((await snapshot()).graphics,undefined);
  const scale=page.getByLabel("Drawing calibration",{exact:true});if(!await scale.isVisible())await page.getByRole("button",{name:"Scale",exact:true}).click();await scale.selectOption("scale:100");
  await command(()=>dialog("Apply drawing scale 1:100?",{},"Apply scale"),"add_calibration");await fit();await page.getByRole("button",{name:"Trace surface",exact:true}).click();
  for(const[index,p]of[[100,200],[500,200],[500,440],[100,440]].entries())if(index===3)await page.mouse.dblclick(...await screen(p));else await page.mouse.click(...await screen(p));
  await command(()=>dialog("Add surface",{"Surface Type":"wall","Surface ID":"GRAPHICS-BACKGROUND","Number of layers":2,Level:"L01",Substrate:"Concrete","Protection system":"Synthetic system","Protection product":"Synthetic product","FRL / fire rating":"90/90/90"},"Add surface"),"create_item");await page.getByRole("button",{name:"Select",exact:true}).click();
  const baseline=await snapshot(),calculators=await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot());
  for(const label of [...new Set(Object.values(labels))]){const button=page.getByRole("button",{name:label,exact:true});await expect(button).toBeVisible();await expect(button.locator("svg path")).toHaveAttribute("d",/\S/);assert.equal(await button.locator("svg").getAttribute("stroke"),"currentColor");}
  const records={};
  const definitions=[
    ["cloud",[[50,530],[220,460]]],["textbox",[[260,530],[480,450]]],["stamp",[[520,530],[780,475]]],
    ["rectangle",[[50,400],[210,330]]],["circle",[[260,400],[400,330]]],["line",[[460,400],[610,350]]],
    ["polyline",[[50,280],[170,250],[230,285]]],["arrow",[[280,280],[420,245]]],["polygon",[[530,285],[710,275],[640,215]]]
  ];
  for(const[kind,points]of definitions){const{record,result}=await insert(kind,points);records[kind]=record;invariant(result.snapshot,baseline);}
  assert.equal((await snapshot()).items.length,1);assert.equal((await snapshot()).graphics.records.length,9);await expect(page.locator(".takeoff-area-hit")).toHaveCount(1);
  check("eight native rail tools create all nine bounded graphic kinds with exact source-pinned command payloads and no quantity, review or calculator changes");
  await panel().getByRole("button",{name:"Close settings",exact:true}).click();const stationary=await snapshot(),stationaryCount=requests.length;
  await graphic(records.polygon.id).locator('[data-graphic-part="move"]').click();await expect(panel()).toBeHidden();await expect(graphic(records.polygon.id)).toHaveAttribute("aria-pressed","true");
  await graphic(records.polygon.id).locator('[data-graphic-part="move"]').dblclick();await expect(panel().getByRole("heading",{name:"Polygon Settings",exact:true})).toBeVisible();assert.deepEqual(await snapshot(),stationary);assert.equal(requests.length,stationaryCount);
  check("stationary single-click selects and native double-click opens settings without issuing a geometry edit");
  await select(records.rectangle.id);let reply=await command(()=>drag(graphic(records.rectangle.id).locator('[data-graphic-part="move"]'),18,14,records.rectangle.id),"update_graphic");
  let moved=reply.snapshot.graphics.records.find(v=>v.id===records.rectangle.id),delta=moved.geometry.quad_pdf[0].map((n,i)=>n-records.rectangle.geometry.quad_pdf[0][i]);assert.ok(delta.some(n=>Math.abs(n)>1));
  for(const[index,p]of records.rectangle.geometry.quad_pdf.entries())for(let axis=0;axis<2;axis++)assert.ok(Math.abs(moved.geometry.quad_pdf[index][axis]-p[axis]-delta[axis])<1e-8);
  await select(records.rectangle.id);reply=await command(()=>drag(graphic(records.rectangle.id).locator('[data-graphic-part="2"]'),18,12,records.rectangle.id),"update_graphic");
  let resized=reply.snapshot.graphics.records.find(v=>v.id===records.rectangle.id);assert.deepEqual(resized.geometry.quad_pdf[0],moved.geometry.quad_pdf[0]);assert.notDeepEqual(resized.geometry.quad_pdf[2],moved.geometry.quad_pdf[2]);invariant(reply.snapshot,baseline);
  await select(records.line.id);reply=await command(()=>drag(graphic(records.line.id).locator('[data-graphic-part="1"]'),10,8,records.line.id),"update_graphic");assert.deepEqual(reply.snapshot.graphics.records.find(v=>v.id===records.line.id).geometry.points[0],records.line.geometry.points[0]);invariant(reply.snapshot,baseline);
  check("native move, affine corner resize and path endpoint edit retain graphic identity and leave the measured surface unchanged");
  await select(records.textbox.id);
  const originalTextbox=(await snapshot()).graphics.records.find(v=>v.id===records.textbox.id),resizeTarget=await screen([480,450]),resizeBox=await graphic(records.textbox.id).locator('[data-graphic-part="2"]').boundingBox();
  reply=await command(()=>drag(graphic(records.textbox.id).locator('[data-graphic-part="2"]'),resizeTarget[0]-resizeBox.x-resizeBox.width/2,resizeTarget[1]-resizeBox.y-resizeBox.height/2,records.textbox.id),"update_graphic");
  const expandedTextbox=reply.snapshot.graphics.records.find(v=>v.id===records.textbox.id);assert.deepEqual(expandedTextbox.geometry.quad_pdf[0],originalTextbox.geometry.quad_pdf[0]);assert.notDeepEqual(expandedTextbox.geometry.quad_pdf[2],originalTextbox.geometry.quad_pdf[2]);assert.deepEqual(expandedTextbox.appearance,originalTextbox.appearance);assert.ok(expandedTextbox.geometry.text_scale>1);invariant(reply.snapshot,baseline);
  reply=await command(async()=>{await panel().getByLabel("Textbox text",{exact:true}).fill("Edited literal <b>note</b> é");await panel().getByLabel("Textbox text",{exact:true}).press("Tab");},"update_graphic");assert.equal(reply.snapshot.graphics.records.find(v=>v.id===records.textbox.id).text,"Edited literal <b>note</b> é");
  // This box now scales its font with resizing. Use a base nine-point edit so
  // all later bold/italic/list content fits the effective scaled font intact.
  await command(async()=>{await panel().getByLabel("Font Size",{exact:true}).fill("9");await panel().getByLabel("Font Size",{exact:true}).press("Tab");},"update_graphic");
  const rich=()=>panel().getByRole("textbox",{name:"Textbox text",exact:true});
  for(const mark of ["Bold","Italic","Underline"]) {
    reply=await command(async()=>{await rich().press("Control+a");await panel().getByRole("button",{name:mark,exact:true}).click();},"update_graphic");
    const edited=reply.snapshot.graphics.records.find(v=>v.id===records.textbox.id);assert.equal(edited.id,records.textbox.id);assert.equal(edited.text_content.blocks[0].runs[0][mark.toLowerCase()],true);invariant(reply.snapshot,baseline);
  }
  await command(async()=>{await rich().press("Control+End");await rich().press("Enter");await panel().getByRole("button",{name:"Bullet list",exact:true}).click();await rich().pressSequentially("Bullet textbox");},"update_graphic");
  await command(async()=>{await rich().press("Control+End");await rich().press("Enter");await rich().press("Enter");await panel().getByRole("button",{name:"Numbered list",exact:true}).click();await rich().pressSequentially("Number textbox");},"update_graphic");
  const richRecord=(await snapshot()).graphics.records.find(v=>v.id===records.textbox.id);
  assert.ok(richRecord.text_content.blocks.some(v=>v.kind==="bullet"&&v.runs.some(r=>r.text.includes("Bullet textbox"))));
  assert.ok(richRecord.text_content.blocks.some(v=>v.kind==="number"&&v.runs.some(r=>r.text.includes("Number textbox"))));
  await expect(graphic(records.textbox.id).locator('tspan[font-weight="bold"]').first()).toBeVisible();await expect(graphic(records.textbox.id).locator('tspan[font-style="italic"]').first()).toBeVisible();await expect(graphic(records.textbox.id).locator('tspan[text-decoration="underline"]').first()).toBeVisible();
  check("native Bold, Italic, Underline, Bullet list and Numbered list controls retain bounded literal textbox runs and render saved marks without quantity authority");
  const beforeHidden=await snapshot();await panel().getByRole("button",{name:"Visibility",exact:true}).click();await expect(graphic(records.textbox.id)).toHaveCount(0);assert.deepEqual(await snapshot(),beforeHidden);
  const remaining=(await snapshot()).graphics.records.filter(v=>v.id!==records.textbox.id).map(v=>v.id);await download("visible-graphics.pdf",remaining,"walls_floors");
  await page.locator(".takeoff-tool-rail").getByRole("button",{name:"Visibility",exact:true}).dblclick();await expect(graphic(records.textbox.id)).toBeVisible();assert.deepEqual(await snapshot(),beforeHidden);
  check("literal text and font edits autosave; individual visibility is visual only and actual PDF requests omit hidden IDs until main-eye restore");
  await select(records.rectangle.id);const beforeDelete=(await snapshot()).graphics.records.find(v=>v.id===records.rectangle.id);reply=await command(()=>graphic(records.rectangle.id).press("Delete"),"delete_graphic");assert.ok(!reply.snapshot.graphics.records.some(v=>v.id===records.rectangle.id));
  reply=await command(()=>page.getByRole("button",{name:"Undo last edit",exact:true}).click(),"undo");const restored=reply.snapshot.graphics.records.find(v=>v.id===records.rectangle.id);for(const key of Object.keys(beforeDelete).filter(k=>k!=="version"))assert.deepEqual(restored[key],beforeDelete[key]);assert.ok(restored.version>beforeDelete.version);invariant(reply.snapshot,baseline);
  check("keyboard Delete and Undo restore the exact graphic identity, geometry, text and style with a fresh version");
  await unfinishedGuards();
  await renderDrawing(page,()=>page.getByRole("button",{name:"Page ›",exact:true}).click(),2);await fit();
  const rotated=await insert("textbox",[[180,160],[390,390]],{view:[20,30,800,570],rotation:90,text:"Rotated CropBox UserUnit 2"});records.rotated=rotated.record;
  const beforeRotate=await snapshot();await renderDrawing(page,()=>page.getByRole("button",{name:"Rotate page",exact:true}).click());await fit();assert.deepEqual(await snapshot(),beforeRotate);
  const ink=await graphic(rotated.record.id).locator("text").first().evaluate(el=>({font:Number(el.getAttribute("font-size")),matrix:el.parentElement.getAttribute("transform"),lines:[...el.parentElement.querySelectorAll("text")].map(t=>t.textContent)}));
  const dimensions=await page.locator(".takeoff-overlay").evaluate(el=>[Number(el.getAttribute("width")),Number(el.getAttribute("height"))]);const physicalScale=dimensions[0]/(780*2);assert.ok(Math.abs(ink.font-12*physicalScale)<.001,"Font size is physical points despite UserUnit 2");assert.equal(ink.lines.join(""),rotated.record.text);
  const [q0,q1,,q3]=rotated.record.geometry.quad_pdf.map(p=>normalized(p,[20,30,800,570],180).map((n,i)=>n*dimensions[i])),w=Math.hypot(q1[0]-q0[0],q1[1]-q0[1]),h=Math.hypot(q3[0]-q0[0],q3[1]-q0[1]),expectedMatrix=[(q1[0]-q0[0])/w,(q1[1]-q0[1])/w,(q3[0]-q0[0])/h,(q3[1]-q0[1])/h,...q0],actualMatrix=ink.matrix.slice(7,-1).trim().split(/\s+/).map(Number);
  assert.ok(actualMatrix.every((n,i)=>Math.abs(n-expectedMatrix[i])<.0001),"SVG text quad follows independently calculated rotation and source CropBox");
  await select(rotated.record.id);await command(()=>drag(graphic(rotated.record.id).locator('[data-graphic-part="move"]'),8,8,rotated.record.id),"update_graphic");invariant(await snapshot(),baseline);
  await download("wall-floor-graphics.pdf",(await snapshot()).graphics.records.map(v=>v.id),"walls_floors");
  check("rotated offset CropBox/UserUnit page creates source-coordinate text geometry, keeps physical font size, moves correctly and exports actual vector placement");
  const scoped={};
  for(const[mode,name]of[["steel","steel"],["duct","duct"],["defect_reports","Defect Reports"],["service_plans","Service Plans"]]){
    await chooseTakeoff(page,name);if(await page.getByLabel("Page number",{exact:true}).inputValue()!=="1")await renderDrawing(page,()=>page.getByRole("button",{name:"‹ Page",exact:true}).click(),1);await fit();const beforeScope=await snapshot();const created=await insert("arrow",[[600,390],[760,340]]);scoped[mode]=created.record;assert.equal(created.record.mode,mode);invariant(created.result.snapshot,beforeScope);await expect(page.locator(".takeoff-graphic")).toHaveCount(1);
    if(["defect_reports","service_plans"].includes(mode))await download(`${mode}-graphics.pdf`,[created.record.id],"penetrations",mode);
  }
  await chooseTakeoff(page,"Defect Reports");await expect(graphic(scoped.defect_reports.id)).toBeVisible();await expect(graphic(scoped.service_plans.id)).toHaveCount(0);
  await chooseTakeoff(page,"Service Plans");await expect(graphic(scoped.service_plans.id)).toBeVisible();await expect(graphic(scoped.defect_reports.id)).toHaveCount(0);
  check("Steel, Duct, Defect Reports and Service Plans retain separate visual scopes; both physical exports contain exactly their own requested graphic vectors");
  assert.equal(await page.evaluate(()=>window.CeasefireTakeoffs.selectWorkspace("slab")),true);await fit();const floor=await insert("circle",[[580,170],[710,100]]);assert.equal(floor.record.mode,"slab");
  await chooseTakeoff(page,"wall");await fit();await expect(graphic(floor.record.id)).toBeVisible();
  const reopened=await saveLoad(info);assert.equal(reopened.graphics.records.length,15);assert.equal(reopened.items.length,1);assert.deepEqual(await page.evaluate(()=>window.CeasefireCalculators.completeProjectSnapshot()),calculators);assert.equal(hash(info.area_fixture),originalHash);
  assert.deepEqual(reopened.graphics.records.find(v=>v.id===records.textbox.id).text_content,richRecord.text_content);await select(records.textbox.id);await expect(rich().locator("strong").first()).toBeVisible();await expect(rich().locator("em").first()).toBeVisible();await expect(rich().locator("u").first()).toBeVisible();await expect(rich().locator("ul").first()).toBeVisible();await expect(rich().locator("ol").first()).toBeVisible();
  await download("reopened-rich-textbox.pdf",reopened.graphics.records.filter(v=>["wall","slab"].includes(v.mode)).map(v=>v.id),"walls_floors");
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.qaCsp),[]);await page.screenshot({path:path.join(output,"graphics.png"),fullPage:true});
  check("Save/Load restores all fifteen markups across six scopes, source bytes and calculator inputs exactly with zero page or CSP errors");
  assert.deepEqual(hashes(),sourceBefore,"Graphics acceptance must use unchanged candidate source bytes throughout the run");
  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({completed:true,check_count:checks.length,checks,graphic_count:15,item_count:1,fixture_port:info.port,browser_version:browser.version(),original_source_sha256:originalHash,source_before_sha256:sourceBefore,source_after_sha256:hashes(),errors,csp:await page.evaluate(()=>window.qaCsp),requests,projectWrites,pdfExports},null,2));console.log(`PASS: ${checks.length} graphics acceptance checks. Evidence: ${output}`);
})().catch(async error=>{console.error(error);process.exitCode=1;if(page){await page.screenshot({path:path.join(output,"failure.png"),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,"failure.txt"),await page.locator("body").innerText().catch(()=>""));}fs.writeFileSync(path.join(output,"failure.json"),JSON.stringify({completed:false,checks,errors,requests,projectWrites,pdfExports,error:String(error),source_before_sha256:sourceBefore,source_after_sha256:hashes()},null,2));}).finally(async()=>{fs.writeFileSync(path.join(output,"server.log"),logs);await browser?.close();server.kill();});
