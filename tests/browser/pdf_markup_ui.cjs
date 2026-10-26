const { cycleTheme } = require('./theme_navigation.cjs');
"use strict";
// Layout/keyboard checks use a synthetic library, PDF, browser and random-port
// server. No request, draft or writable path belongs to the live application.
const { chromium, expect } = require("@playwright/test");
const { chooseTakeoff, chooseLibrary } = require("./section_navigation.cjs");
const { renderDrawing } = require("./viewer_helpers.cjs");
const { settingsSettled } = require("./settings_helpers.cjs");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { sources, feedbackSources, printingSource, loadingSource } = require("../../static/header-menu-sounds.js");
const { verifiedPreloadCancellation } = require("../helpers/media_preload_guard.cjs");
const preloadPaths = [...Object.values(sources), ...Object.values(feedbackSources), printingSource, loadingSource];
// Only these two startup media cancellations have been observed in Chromium CI.
const cancellablePreloadPaths = [feedbackSources.selectOther, loadingSource];

const root = path.resolve(__dirname, "../.."), output = path.join(root, ".runtime/browser-qa", `pdf-markup-ui-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || "python";
const assets = ["static/app.js", "static/takeoffs.js", "static/takeoffs.css", "static/takeoff-pane-resize.js", "static/takeoff-graphics.js", "static/takeoff-graphics-ui.js", "static/takeoff-physical.js", "static/takeoff-annotations.js", "static/penetration.js", "static/penetration.css", "static/libraries.css", "static/index.html", "static/styles.css", "static/theme.css", "static/laser.css", "static/icons/takeoff-bullet-list.png", "static/icons/takeoff-numbered-list.png", "static/icons/takeoff-transfer.png", "static/icons/schedule-add.png", "estimator/takeoff_pdf_measure.py", "estimator/takeoff_textbox_layout.py", "estimator/takeoff_deleted_items.py", "estimator/takeoff_graphics.py", "estimator/takeoff_workspace.py", "estimator/takeoff_http.py", "estimator/takeoff_markup_pdf.py", "estimator/takeoff_markup_pdf_worker.py", "tests/browser/pdf_markup_ui.cjs"];
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assets.push("static/header-menu-sounds.js", "tests/helpers/media_preload_guard.cjs", ...cancellablePreloadPaths.map(url => `static${url}`));
const hashes = () => Object.fromEntries(assets.map(file => [file, hash(path.join(root, file))]));
const sourceBefore = hashes(), evidence = { layouts: [], menus: [], heights: [], textSettings: [], library: [], pointerTargets: [] }, errors = [], csp = [], requests = [], networkFailures = [];
function contrast(foreground, background) {
  const luminance = value => {
    const rgb = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    assert.ok(rgb, `Rendered contrast requires an opaque colour: ${value}`);
    const linear = rgb.slice(1).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
const server = spawn(python, [path.join(__dirname, "library_link_picker_fixture.py"), "--directory", output], { cwd: root, windowsHide: true });
let browser, page, info, logs = "", stage = "fixture startup";
server.stderr.on("data", value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let data = ""; const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs}`)), 120000);
  server.stdout.on("data", value => { data += value; if (data.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(data.split("\n")[0])); } catch (error) { reject(error); } } });
  server.once("error", error => { clearTimeout(timer); reject(error); });
  server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
});
const panel = () => page.locator("#takeoff-markup-settings");
const rail = () => page.getByRole("toolbar", { name: "PDF markup tools", exact: true });
const snapshot = async () => { await settingsSettled(page); return page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot()); };
const box = locator => locator.boundingBox();
async function navigationState() {
  return page.evaluate(() => ({
    desktop: window.CeasefireDesktop?.status(), takeoffsModule: typeof window.CeasefireTakeoffs,
    takeoffsSession: window.CeasefireTakeoffs?.sessionId(), workspaceExists: !!document.querySelector("#takeoffs-workspace"),
    workspaceChildren: document.querySelector("#takeoffs-workspace")?.childElementCount,
    uploadExists: !!document.querySelector("#takeoff-upload"), bodyClass: document.body.className,
    views: [...document.querySelectorAll(".view")].map(el => ({ id: el.id, hidden: el.hidden, display: getComputedStyle(el).display })),
    choices: [...document.querySelectorAll("#takeoff-navigation button")].map(el => ({ id: el.id, mode: el.dataset.mode, current: el.getAttribute("aria-current"), pressed: el.getAttribute("aria-pressed"), disabled: el.disabled })),
    scripts: [...document.scripts].map(el => el.src), message: document.querySelector("#app-message")?.textContent,
  }));
}
async function theme(id) {
  for (let i = 0; i < 5 && await page.locator("html").getAttribute("data-theme") !== id; i++) await cycleTheme(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", id);
}
async function noOverflow(label) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal page overflow: ${label}`); }
async function heights(name, locators, size = 38) {
  const values = [];
  for (const locator of locators) { await expect(locator).toBeVisible(); const bounds = await box(locator); assert.ok(Math.abs(bounds.height - size) < .1, `${name}: ${bounds.height} equals ${size}`); values.push(bounds); }
  evidence.heights.push({ name, size, values });
}
async function menuKeys(toggle, list, label) {
  await toggle.focus(); await toggle.press("ArrowDown"); await expect(list).toBeVisible();
  const choices = list.getByRole("button"); await expect(choices.first()).toBeFocused();
  await page.keyboard.press("End"); await expect(choices.last()).toBeFocused();
  await page.keyboard.press("Home"); await expect(choices.first()).toBeFocused();
  await page.keyboard.press("ArrowUp"); await expect(choices.last()).toBeFocused();
  const bounds = await box(list), width = page.viewportSize().width;
  assert.ok(bounds.x >= -.1 && bounds.x + bounds.width <= width + .1, `${label} popup fits ${width}`);
  await page.keyboard.press("Escape"); await expect(list).toBeHidden(); await expect(toggle).toBeFocused();
  evidence.menus.push({ label, width, bounds });
}
async function headingMenus(width, physical = false) {
  const heading = page.locator(".takeoff-workspace-heading"), documentMenu = heading.locator(".takeoff-document-menu:not(.takeoff-physical-document-menu)"), toolsMenu = heading.locator(".takeoff-pdf-tools-menu");
  await expect(documentMenu).toHaveCount(1); await expect(toolsMenu).toHaveCount(1);
  if (physical) {
    await expect(documentMenu).toBeHidden(); await expect(documentMenu.locator(".calculator-document-actions")).toBeHidden();
    await menuKeys(toolsMenu.locator("button").first(), page.locator("#takeoff-pdf-tools-actions"), "Physical PDF Tools");
    const physicalMenu = heading.locator(".takeoff-physical-document-menu");
    await expect(physicalMenu).toBeVisible();
    await expect(page.locator(".takeoff-physical-register .takeoff-document-menu")).toHaveCount(0);
    const doc = await box(physicalMenu), tools = await box(toolsMenu);
    assert.ok(doc.x + doc.width <= tools.x + .1 && Math.abs(doc.y - tools.y) < .1, "Physical Document immediately precedes Tools on the same row");
    await menuKeys(physicalMenu.locator("button").first(), physicalMenu.locator(".calculator-document-actions"), "Physical Document");
    const physicalControls = page.locator(".takeoff-physical-filter-row"), undo = physicalControls.getByRole("button", { name: "Undo last edit", exact: true }), deleted = physicalControls.getByRole("checkbox", { name: "Show deleted records", exact: true });
    assert.equal(await undo.locator("..").evaluate((el) => el.querySelector(".takeoff-undo-button").nextElementSibling?.querySelector("input")?.type), "checkbox", "Show deleted immediately follows Undo in DOM reading order");
    const undoBox = await box(undo), deletedBox = await box(deleted);
    assert.ok(deletedBox.x > undoBox.x + undoBox.width, "Show deleted is to the right of Undo");
    evidence.layouts.push({ width, physical: true, heading: await box(heading), tools: await box(toolsMenu), measurementDocumentHidden: true, physicalDocument: await box(physicalMenu) });
    return;
  }
  const head = await box(heading), doc = await box(documentMenu), tools = await box(toolsMenu);
  assert.ok(doc.x + doc.width <= tools.x + .1 && Math.abs(doc.y - tools.y) < .1, "Document immediately precedes Tools on the same row");
  assert.ok(Math.abs(head.x + head.width - tools.x - tools.width) < .1, "Tools ends at the workspace heading right edge");
  const arrows = await heading.locator(".calculator-document-chevron svg").evaluateAll(elements => elements.map(svg => ({ path: svg.querySelector("path").getAttribute("d"), fill: getComputedStyle(svg).fill, stroke: getComputedStyle(svg).stroke, width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height })));
  assert.equal(arrows.length, 2); assert.deepEqual(arrows[0], arrows[1]); assert.equal(arrows[0].fill, "none"); assert.equal(arrows[0].width, 16);
  await menuKeys(documentMenu.locator("button").first(), page.locator("#takeoff-register-document-actions"), "Takeoff Document");
  await menuKeys(toolsMenu.locator("button").first(), page.locator("#takeoff-pdf-tools-actions"), "PDF Tools");
  evidence.layouts.push({ width, heading: head, document: doc, tools, arrows });
}
async function rightRail(width, mode) {
  const left = page.getByRole("toolbar", { name: "Drawing tools", exact: true }), drawing = page.locator(".takeoff-drawing-pane");
  await expect(rail()).toBeVisible(); const l = await box(left), r = await box(rail()), d = await box(drawing);
  assert.ok(l.x + l.width <= d.x + .1 && d.x + d.width <= r.x + .1, `${mode}/${width}: PDF tools stay to the right of the drawing`);
  assert.ok(r.x + r.width <= width + .1 && r.width === 56, "Right tools remain within the viewport");
  for (const name of ["Signatures", "Cloud", "Textbox", "Stamp", "Line/Polyline", "Arrow", "Rectangle", "Circle", "Polygon"]) {
    const control = rail().getByRole("button", { name, exact: true }); await expect(control).toBeVisible();
    await expect(left.getByRole("button", { name, exact: true })).toHaveCount(0);
    const b = await box(control); assert.ok(Math.abs(b.width - 38) < .1 && Math.abs(b.height - 38) < .1, `${name}: square usable target`);
    assert.ok(b.x >= r.x && b.x + b.width <= r.x + r.width, `${name}: horizontal target is not clipped by the rail scrollbar`);
  }
  const polygon = rail().getByRole("button", { name: "Polygon", exact: true }); await polygon.scrollIntoViewIfNeeded(); await expect(polygon).toBeInViewport();
  const scroll = await rail().evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, contentHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  if (scroll.contentHeight > scroll.height) { assert.ok(scroll.top > 0); assert.equal(scroll.overflow, "auto"); }
  await rail().getByRole("button", { name: "Cloud", exact: true }).scrollIntoViewIfNeeded();
  evidence.layouts.push({ width, mode, left: l, right: r, drawing: d, railScroll: scroll });
}
async function rowHeights(width) {
  await heights(`register ${width}`, [page.getByLabel("Filter register", { exact: true }), page.getByRole("button", { name: "Select filtered items", exact: true }), page.getByRole("button", { name: "Undo last edit", exact: true })]);
  await heights(`destination ${width}`, [page.getByLabel("Destination schedule", { exact: true }), page.getByRole("button", { name: "Preview transfer", exact: true }), page.getByRole("button", { name: "Update linked rows", exact: true }), page.getByRole("button", { name: "Detach links", exact: true })]);
  await heights(`drawing source/search ${width}`, [page.getByLabel("Drawing document", { exact: true }), page.getByLabel("Search original document text", { exact: true }), page.getByLabel("Text search scope", { exact: true }), page.getByRole("button", { name: "Search", exact: true }), page.getByRole("button", { name: "Remove document", exact: true })]);
}
async function makeTextbox() {
  const documentId = (await snapshot()).documents[0].id;
  await expect(page.getByLabel("Drawing document", { exact: true })).toHaveValue(documentId);
  await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click(), 1);
  const textboxTool = rail().getByRole("button", { name: "Textbox", exact: true });
  const idleBackground = await textboxTool.evaluate(el => getComputedStyle(el).backgroundColor);
  await textboxTool.click(); await expect(textboxTool).toHaveClass(/\btakeoff-tool-active\b/); await page.mouse.move(1, 1);
  await expect(textboxTool).toHaveCSS("background-color", /^rgb\(\d+, \d+, \d+\)$/);
  const selectedTool = await textboxTool.evaluate(el => { const css = getComputedStyle(el); return { background: css.backgroundColor, color: getComputedStyle(el.querySelector("svg")).stroke, border: css.borderColor, shadow: css.boxShadow }; });
  assert.notEqual(selectedTool.background, idleBackground, "Selected right-rail tool has a distinct filled surface");
  assert.ok(contrast(selectedTool.color, selectedTool.background) >= 4.5, "Selected right-rail glyph remains readable");
  assert.ok(contrast(selectedTool.border, selectedTool.background) >= 3, "Selected right-rail boundary remains visible");
  assert.notEqual(selectedTool.shadow, "none", "Selected right-rail tool retains its inset indicator");
  evidence.selectedRightRailTool = selectedTool; await textboxTool.screenshot({ path: path.join(output, "selected-textbox-tool.png") });
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 195));
  const bounds = await box(overlay);
  // One native click anchors the automatically fitted text box.
  const point = [bounds.x + bounds.width*.2, bounds.y + bounds.height*.55];
  assert.equal(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest(".takeoff-overlay"), point), true);
  const response = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === "create_textbox"); response.catch(() => {});
  await page.mouse.click(...point);
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Textbox", exact: true })).toBeVisible();
  await dialog.getByLabel("Textbox text", { exact: true }).fill("Synthetic rich textbox layout note");
  await dialog.getByRole("button", { name: "Place markup", exact: true }).click();
  const created = await response; assert.equal(created.status(), 200); const request = created.request().postDataJSON(), reply = await created.json(), graphic = reply.snapshot.graphics.records.find(value => value.id === reply.created_graphic_id);
  assert.equal(request.textbox.appearance.font_size, 12); assert.equal(graphic.appearance.font_size, 12); assert.deepEqual(graphic.geometry.quad_pdf[0], request.textbox.anchor_pdf, "Automatic layout retains the exact clicked anchor");
  assert.ok(Math.abs(request.textbox.anchor_pdf[0] - 842*.2) < 2 && Math.abs(request.textbox.anchor_pdf[1] - 595*.45) < 2, "Native clicked location maps to the original unrotated PDF coordinates");
  await settingsSettled(page);
  await expect(panel().getByRole("heading", { name: "Textbox Settings", exact: true })).toBeVisible();
  evidence.textboxCreation = { id: graphic.id, command: request.op, anchor_pdf: request.textbox.anchor_pdf, font_size: graphic.appearance.font_size, geometry: graphic.geometry };
}
async function textSettings(width, currentTheme) {
  const labels = await panel().locator(".takeoff-settings-fields .field > span:first-child").allTextContents();
  assert.deepEqual(labels.slice(0, 8), ["Line Colour", "Line Width", "Fill Colour", "Opacity", "Font Colour", "Font Size", "Line Enabled", "Fill Enabled"]);
  const appearanceLayout = await require('./appearance_layout_helpers.cjs').assertAppearanceLayout(panel());
  for (const name of labels.slice(0, 8)) await expect(panel().getByLabel(name, { exact: true })).toBeVisible();
  const colours = await panel().locator(".field > span:first-child").evaluateAll(elements => elements.map(el => getComputedStyle(el).color));
  assert.ok(colours.every(colour => colour === "rgb(255, 255, 255)"), `Dark settings labels remain white in ${currentTheme}: ${JSON.stringify(colours)}`);
  const toolbar = panel().getByRole("toolbar", { name: "Textbox text formatting", exact: true }), editor = panel().getByRole("textbox", { name: "Textbox text", exact: true });
  await expect(editor).toHaveAttribute("contenteditable", "true"); await expect(editor).toHaveAttribute("aria-multiline", "true");
  for (const name of ["Bold", "Italic", "Underline", "Bullet list", "Numbered list"]) await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
  const listIcons = [];
  for (const name of ["Bullet list", "Numbered list"]) {
    const image = toolbar.getByRole("button", { name, exact: true }).locator("img"); await expect(image).toHaveJSProperty("complete", true);
    assert.equal(await image.evaluate(el => getComputedStyle(el).filter), "brightness(0) invert(1)", `${currentTheme} ${name} raster stays readable on its dark control`);
    const screenshot = path.join(output, `list-icon-${name.replace(/ /g, "-")}-${currentTheme}-${width}.png`); await image.screenshot({ path: screenshot });
    const pixels = spawnSync(python, ["-B", "-c", "from PIL import Image; import sys; p=list(Image.open(sys.argv[1]).convert('RGB').getdata()); delta=max(sum(v)/3 for v in p)-min(sum(v)/3 for v in p); assert delta>100, delta; print(delta)", screenshot], { encoding: "utf8", windowsHide: true });
    assert.equal(pixels.status, 0, pixels.stderr); listIcons.push({ name, screenshot, renderedRange: Number(pixels.stdout) });
  }
  const trash = panel().getByRole("button", { name: "Delete markup", exact: true }); await expect(trash.locator("svg")).toHaveCount(1);
  await expect(trash).toHaveAttribute("title", "Delete markup"); const t = await box(trash); assert.ok(Math.abs(t.width - 38) < .1 && Math.abs(t.height - 38) < .1);
  const r = await box(rail()), p = await box(panel()); assert.ok(p.x + p.width <= r.x + .1, "Settings do not cover the right PDF tools");
  const contents = await editor.evaluate(el => ({ colour: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, width: el.clientWidth, scroll: el.scrollWidth }));
  assert.equal(contents.colour, "rgb(23, 23, 23)"); assert.equal(contents.background, "rgb(255, 255, 255)"); assert.ok(contents.scroll <= contents.width + 1);
  if (width === 390) {
    for (const control of [...await panel().locator("input,select").all(), ...await toolbar.getByRole("button").all(), editor, trash]) {
      await control.scrollIntoViewIfNeeded();
      const target = await control.evaluate(el => {
        const bounds = el.getBoundingClientRect(), header = document.querySelector(".app-header").getBoundingClientRect();
        if (bounds.top < header.bottom + 8) window.scrollBy(0, bounds.top - header.bottom - 8);
        const visible = el.getBoundingClientRect(), point = [visible.x + visible.width/2, visible.y + visible.height/2], hit = document.elementFromPoint(...point);
        return { name: el.getAttribute("aria-label") || el.name, point, reachable: hit === el || el.contains(hit), hit: hit?.outerHTML.slice(0, 160) };
      });
      assert.equal(target.reachable, true, `Narrow drawer control reaches its native target: ${JSON.stringify(target)}`);
      evidence.pointerTargets.push({ width, theme: currentTheme, ...target });
    }
    await panel().getByLabel("Line Colour", { exact: true }).scrollIntoViewIfNeeded();
  }
  await noOverflow(`${width}/${currentTheme}/Textbox Settings`);
  await page.screenshot({ path: path.join(output, `textbox-${currentTheme}-${width}.png`), fullPage: true });
  evidence.textSettings.push({ width, theme: currentTheme, labels, appearanceLayout, colours, settings: p, rightRail: r, trash: t, contents, listIcons });
}
async function resizePane(target, family, width) {
  await page.setViewportSize({ width, height: 764 }); await expect(target).toBeVisible();
  const before = await snapshot(), handle = page.getByRole("separator", { name: "Resize settings pane", exact: true }); await expect(handle).toBeVisible();
  const values = async () => handle.evaluate(el => Object.fromEntries(["min", "max", "now"].map(key => [key, Number(el.getAttribute(`aria-value${key}`))])));
  const boundedWidth = async () => { const v = await values(), b = await box(target); assert.ok(v.min <= v.now && v.now <= v.max); assert.ok(Math.abs(b.width - v.now) < 1, `${family} actual width matches accessible resize value`); return { ...v, box: b }; };
  await handle.focus(); await handle.press("Home"); const minimum = await boundedWidth(); assert.equal(minimum.now, minimum.min);
  await handle.press("Shift+ArrowRight"); const keyboard = await boundedWidth(); assert.equal(keyboard.now, Math.min(minimum.max, minimum.min + 40));
  await handle.scrollIntoViewIfNeeded();
  // Returning from Settings can retain a different scroll offset. Drag the
  // visible part of this tall handle below the sticky application header.
  const pointer = await handle.evaluate(el => {
    const h = el.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
    const top = Math.max(h.top, header.bottom + 8), bottom = Math.min(h.bottom, window.innerHeight - 8);
    const point = [h.x + h.width / 2, (top + bottom) / 2], hit = document.elementFromPoint(...point);
    return { point, reachable: bottom > top && hit === el, hit: hit?.outerHTML.slice(0, 160) };
  });
  const { point } = pointer;
  assert.equal(pointer.reachable, true, `${family} native resize target is reachable: ${JSON.stringify(pointer)}`);
  await page.mouse.move(...point); await page.mouse.down(); await page.mouse.move(point[0] - 20, point[1]); await page.mouse.up(); const dragged = await boundedWidth(); assert.equal(dragged.now, Math.max(keyboard.min, keyboard.now - 20));
  await handle.focus(); await handle.press("End"); const maximum = await boundedWidth(); assert.equal(maximum.now, maximum.max);
  await handle.press("Home"); await noOverflow(`${width}/${family} resized pane`); assert.deepEqual(await snapshot(), before, "Pane keyboard and native pointer resizing preserve all draft source coordinates and authority");
  await page.screenshot({ path: path.join(output, `resize-${family}-${width}.png`), fullPage: true }); (evidence.paneResize ||= []).push({ family, width, minimum, keyboard, dragged, maximum });
}
async function legacyCountFrlAndDeletedHistory() {
  await page.setViewportSize({ width: 1384, height: 764 }); await chooseTakeoff(page, "duct");
  await renderDrawing(page, () => page.getByRole("button", { name: "Fit page", exact: true }).click(), 1);
  // Current Count creates Length-field items; retain the historical count-only
  // format through its guarded disposable API without inventing manual length.
  const seed = await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, sessionId = takeoffs.sessionId(), current = takeoffs.projectSnapshot(), doc = current.documents[0], view = doc.pages.find(value => value.page === 1).view;
    const point = [(view[0] + view[2])/2, (view[1] + view[3])/2];
    const response = await fetch(`/api/takeoffs/sessions/${sessionId}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), op: "add_standalone_count", mode: "duct", document_id: doc.id, page: 1, markers: [{ point }], fields: { mark: "FRL-HISTORY-PROOF", frl: "-/120/120" }, appearance: {} }) });
    if (!response.ok) throw Error(`Disposable legacy Count fixture rejected: ${await response.text()}`);
    const reply = await response.json(); takeoffs.applyProject(await takeoffs.prepareProject(reply.snapshot, sessionId));
    return { status: response.status, point, document_id: doc.id, source_sha256: doc.sha256, item: reply.snapshot.items.find(value => value.fields.mark === "FRL-HISTORY-PROOF") };
  });
  const item = seed.item, legacy = "Legacy bespoke FRL";
  assert.equal(seed.status, 200); assert.equal(item.purpose, "count-only"); assert.equal(item.geometry.kind, "count-only"); assert.equal(item.mode, "duct"); assert.equal(item.measurement, null); assert.equal(item.quantity, 1);
  assert.equal(item.geometry.document_id, seed.document_id); assert.equal(item.geometry.page, 1); assert.deepEqual(item.geometry.points, [seed.point]); assert.equal(Object.hasOwn(item.fields, "length_m"), false); assert.equal(Object.hasOwn(item.fields, "length_mm"), false);
  assert.equal((await snapshot()).documents.find(value => value.id === seed.document_id).sha256, seed.source_sha256);
  const choices = await page.evaluate(async () => { const response = await fetch("/api/penetration/definition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configuration: window.CeasefireProject.configuration() }) }); if (!response.ok) throw Error("Fixture Firestopping definition failed"); return (await response.json()).row_fields.find(field => field.column === "N").options; });
  const selectValues = locator => locator.locator("option").evaluateAll(elements => elements.map(el => el.value).filter(Boolean));
  await chooseTakeoff(page, "duct"); await page.locator(`.takeoff-register-table tr[data-item-id="${item.id}"]`).getByRole("button", { name: "Edit item", exact: true }).click();
  const originalFrl = panel().getByLabel("FRL", { exact: true }); await expect(originalFrl).toHaveValue("-/120/120"); await expect.poll(() => selectValues(originalFrl)).toEqual(choices); await settingsSettled(page);
  await page.evaluate(async ({ id, legacy }) => { const takeoffs = window.CeasefireTakeoffs, sessionId = takeoffs.sessionId(), value = takeoffs.projectSnapshot(); const response = await fetch(`/api/takeoffs/sessions/${sessionId}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: value.revision, request_id: crypto.randomUUID(), op: "update_item", item_id: id, changes: { fields: { frl: legacy } } }) }); if (!response.ok) throw Error(`Disposable historical FRL fixture update failed: ${await response.text()}`); const reply = await response.json(); takeoffs.applyProject(await takeoffs.prepareProject(reply.snapshot, sessionId)); }, { id: item.id, legacy });
  await chooseTakeoff(page, "duct"); const row = page.locator(`.takeoff-register-table tr[data-item-id="${item.id}"]`); await row.getByRole("button", { name: "Edit item", exact: true }).click();
  const frl = panel().getByLabel("FRL", { exact: true }); await expect(frl).toHaveValue(legacy); await expect.poll(() => selectValues(frl)).toEqual([...choices, legacy]); await expect(frl.locator("option:checked")).toContainText("retained");
  await panel().getByLabel("Line Colour", { exact: true }).fill("#123456"); await frl.focus(); await settingsSettled(page); const retained = await snapshot(); const kept = retained.items.find(value => value.id === item.id); assert.equal(kept.fields.frl, legacy); assert.deepEqual(kept.geometry, item.geometry); assert.equal(kept.quantity, item.quantity);
  await panel().getByRole("button", { name: "Delete item", exact: true }).click(); const confirm = page.getByRole("dialog"); await expect(confirm.getByRole("heading", { name: "Delete item?", exact: true })).toBeVisible(); const deleted = page.waitForResponse(response => response.url().endsWith("/commands") && response.request().postDataJSON()?.op === "delete_items"); deleted.catch(() => {}); await confirm.getByRole("button", { name: "Delete item", exact: true }).click(); assert.equal((await deleted).status(), 200);
  const afterDelete = await snapshot(); assert.ok(!afterDelete.items.some(value => value.id === item.id)); const toggle = page.locator(".takeoff-register:not(.takeoff-physical-register)").getByRole("checkbox", { name: "Show deleted records", exact: true });
  const history = page.waitForResponse(response => response.url().endsWith("/deleted-items")); history.catch(() => {}); await toggle.check(); const historyResponse = await history; assert.equal(historyResponse.status(), 200); const historyBody = await historyResponse.json(); await expect(page.locator(`tr[data-deleted-item-id="${item.id}"]`)).toContainText(legacy); assert.equal(historyBody.records.find(record => record.item.id === item.id).item.quantity, 1); assert.deepEqual(await snapshot(), afterDelete, "Inspecting deleted history cannot restore register quantities or mutate the draft");
  await toggle.uncheck(); await expect(page.locator(".takeoff-deleted-records")).toBeHidden(); assert.deepEqual(await snapshot(), afterDelete); evidence.legacyCountFrl = { choices, retained: legacy, item_id: item.id, document_id: seed.document_id, source_sha256: seed.source_sha256, source_point: seed.point, quantity: item.quantity, measurement: item.measurement, no_inferred_manual_length: true, deleted_history_read_only: true }; await chooseTakeoff(page, "steel");
}
async function historicalLengthPrecision() {
  const seed = await page.evaluate(async () => {
    const takeoffs = window.CeasefireTakeoffs, sessionId = takeoffs.sessionId(), doc = takeoffs.projectSnapshot().documents[0], calibrationId = crypto.randomUUID(), distance = 1.234567891234;
    const command = async payload => { const current = await (await fetch(`/api/takeoffs/sessions/${sessionId}`)).json(); const response = await fetch(`/api/takeoffs/sessions/${sessionId}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: current.revision, request_id: crypto.randomUUID(), ...payload }) }); if (!response.ok) throw Error(`Historical Length fixture rejected: ${await response.text()}`); return response.json(); };
    await command({ op: "add_calibration", calibration: { id: calibrationId, document_id: doc.id, page: 1, name: "Full precision display proof", points: [[20, 40], [120, 40]], distance_m: distance, uniform_scale: true } });
    const reply = await command({ op: "create_item", item: { mode: "wall", purpose: "length-only", geometry: { document_id: doc.id, page: 1, points: [[20, 60], [120, 60]] }, measurement: { method: "calibrated", calibration_id: calibrationId }, quantity: 1, fields: { mark: "LEGACY-LENGTH-PRECISION" } } });
    const item = reply.snapshot.items.find(value => value.fields.mark === "LEGACY-LENGTH-PRECISION"), result = reply.item_results.find(value => value.id === item.id);
    takeoffs.applyProject(await takeoffs.prepareProject(reply.snapshot, sessionId)); return { item, result, calibrationId, distance };
  });
  await chooseTakeoff(page, "wall"); await page.locator(`.takeoff-standalone-register tr[data-item-id="${seed.item.id}"]`).getByRole("button", { name: "Edit item", exact: true }).click();
  const length = panel().getByLabel("Length (m)", { exact: true }); await expect(length).toHaveAttribute("readonly", ""); await expect(length).toHaveValue(seed.result.length_m.toFixed(2)); assert.notEqual(seed.result.length_m, Number(await length.inputValue()), "Stored derived Length retains precision beyond displayed two decimals");
  await expect(panel().getByRole("button", { name: /(?:Change|Attach) length calibration/ })).toHaveCount(0); assert.ok(!(await panel().innerText()).includes("Length follows the calibrated source points.")); assert.ok(!(await panel().innerText()).includes("Surface type:"));
  await panel().getByLabel("Line Colour", { exact: true }).fill("#654321"); await length.focus(); await settingsSettled(page);
  const after = await snapshot(), retained = after.items.find(value => value.id === seed.item.id), current = await page.evaluate(async () => (await fetch(`/api/takeoffs/sessions/${window.CeasefireTakeoffs.sessionId()}`)).json());
  assert.deepEqual(retained.geometry, seed.item.geometry); assert.deepEqual(retained.measurement, seed.item.measurement); assert.deepEqual(retained.fields, seed.item.fields); assert.equal(retained.quantity, 1); assert.equal(after.calibrations.find(value => value.id === seed.calibrationId).distance_m, seed.distance); assert.equal(current.item_results.find(value => value.id === seed.item.id).length_m, seed.result.length_m);
  evidence.historicalLength = { id: seed.item.id, calibration_id: seed.calibrationId, stored_distance: seed.distance, derived_length: seed.result.length_m, displayed_length: await length.inputValue(), unrelated_edit_preserves_precision: true }; await chooseTakeoff(page, "steel");
}
async function standardCalculatorButton() {
  const source = "import json,sys;from pathlib import Path;from estimator.server import create_server;s=create_server(0,Path(sys.argv[1]),library_directory=Path(sys.argv[2]),edition='standard');print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()";
  const standard = spawn(python, ["-c", source, path.join(output, "standard-qa.sqlite3"), info.library], { cwd: root, windowsHide: true }); let standardPage, stderr = "";
  standard.stderr.on("data", value => { stderr += value; });
  try {
    const selected = await new Promise((resolve, reject) => {
      let data = ""; const timer = setTimeout(() => reject(Error(`Standard fixture startup timeout: ${stderr}`)), 120000);
      standard.stdout.on("data", value => { data += value; if (data.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(data.split("\n")[0])); } catch (error) { reject(error); } } });
      standard.once("error", error => { clearTimeout(timer); reject(error); }); standard.once("exit", code => { clearTimeout(timer); reject(Error(`Standard fixture exited${code}: ${stderr}`)); });
    });
    assert.notEqual(selected.port, 8765); assert.notEqual(selected.port, info.port);
    standardPage = await browser.newPage({ viewport: { width: 1384, height: 764 } }); standardPage.setDefaultTimeout(30000);
    standardPage.on("pageerror", error => errors.push(`standard: ${error.message}`)); standardPage.on("console", value => { if (value.type() === "error") errors.push(`standard: ${value.text()}`); });
    await standardPage.addInitScript(() => { window.uiCsp = []; document.addEventListener("securitypolicyviolation", event => window.uiCsp.push(event.effectiveDirective)); });
    await standardPage.goto(`http://127.0.0.1:${selected.port}/`); await standardPage.waitForFunction(() => window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy);
    assert.equal(await standardPage.evaluate(() => typeof window.CeasefireTakeoffs), "undefined"); await expect(standardPage.locator('link[href="/takeoffs.css"]')).toHaveCount(0);
    await standardPage.locator("#calculator-navigation-toggle").hover(); await standardPage.locator('#calculator-navigation-menu [data-calculator-id="penetration"]').click();
    const add = standardPage.locator("#penetration-add-to-schedule"), image = add.locator("img"); await expect(add).toBeVisible(); await expect(add).toHaveAccessibleName("Add to Schedule");
    const response = await standardPage.request.get(`http://127.0.0.1:${selected.port}/icons/schedule-add.png`); assert.equal(response.status(), 200); assert.equal(crypto.createHash("sha256").update(await response.body()).digest("hex"), hash(path.join(root, "static/icons/takeoff-transfer.png")));
    for (const width of [1384, 390]) { await standardPage.setViewportSize({ width, height: 764 }); const b = await add.boundingBox(), i = await image.boundingBox(); assert.equal(b.width, 48); assert.equal(b.height, 48); assert.equal(i.width, 24); assert.equal(i.height, 24); assert.ok(await standardPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await standardPage.screenshot({ path: path.join(output, `standard-calculator-${width}.png`), fullPage: true }); (evidence.standardCalculator ||= []).push({ port: selected.port, width, button: b, icon: i, takeoffs_assets_absent: true }); }
    assert.deepEqual(await standardPage.evaluate(() => window.uiCsp), []);
  } catch (error) { await standardPage?.screenshot({ path: path.join(output, "standard-failure.png"), fullPage: true }).catch(() => {}); throw error; }
  finally { fs.writeFileSync(path.join(output, "standard-server.log"), stderr); await standardPage?.close(); standard.kill(); }
}

(async () => {
  info = await ready; assert.notEqual(info.port, 8765); assert.equal(path.resolve(info.directory), output);
  const pdf = path.join(output, "synthetic-drawing.pdf");
  const generated = spawnSync(python, ["-c", "import runpy,sys; runpy.run_path(sys.argv[1])['make_pdf'](sys.argv[2])", path.join(__dirname, "fixtures.py"), pdf], { cwd: root, windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr); const pdfBefore = hash(pdf);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1384, height: 764 } }); page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", request => networkFailures.push({ stage, url: request.url(), method: request.method(), resourceType: request.resourceType(), observedAt: new Date().toISOString(), failure: request.failure() }));
  page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
  await page.addInitScript(paths => {
    window.uiCsp = []; document.addEventListener("securitypolicyviolation", event => window.uiCsp.push(event.effectiveDirective));
    window.uiMediaPreloads = [];
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function (...args) {
      const url = new URL(this.src, location.href);
      if (url.origin === location.origin && paths.includes(url.pathname) && !window.uiMediaPreloads.some(entry => entry.media === this)) {
        const entry = { media: this, events: [] }; window.uiMediaPreloads.push(entry);
        for (const type of ["loadeddata", "canplay", "suspend", "abort", "error"]) this.addEventListener(type, event => entry.events.push({ type, trusted: event.isTrusted, readyState: this.readyState, networkState: this.networkState, error: this.error?.code || null }));
      }
      return Reflect.apply(load, this, args);
    };
  }, preloadPaths);
  stage = "initial load"; await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy);
  // A media preload may be cancelled by Chromium after buffering or replaced
  // by its native media loader. A cancellation alone does not prove delivery
  // failed: require actual decoded data in every original player, not a mock.
  await page.waitForFunction(count => window.uiMediaPreloads.length === count && window.uiMediaPreloads.every(({ media, events }) => !media.error && media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0 && events.some(event => event.type === "loadeddata" && event.trusted)), preloadPaths.length);
  evidence.mediaPreloads = await page.evaluate(() => window.uiMediaPreloads.map(({ media, events }) => ({ url: media.src, readyState: media.readyState, duration: media.duration, error: media.error?.code || null, events })));
  evidence.mediaAssets = [];
  for (const source of cancellablePreloadPaths) {
    const response = await page.request.get(`http://127.0.0.1:${info.port}${source}`), bytes = await response.body();
    assert.equal(response.status(), 200); assert.equal(response.headers()["content-type"], "audio/mpeg");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"); assert.equal(sha256, sourceBefore[`static${source}`]);
    evidence.mediaAssets.push({ url: response.url(), status: response.status(), contentType: response.headers()["content-type"], sha256, bytes: bytes.length });
  }
  const calculators = await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot());
  stage = "header Takeoffs click"; await page.getByRole("button", { name: "Takeoffs", exact: true }).click();
  stage = "Steel choice"; await chooseTakeoff(page, "steel");
  stage = "drawing upload";
  await renderDrawing(page, () => page.locator("#takeoff-upload").setInputFiles(pdf), 1); await settingsSettled(page);
  const uploaded = await snapshot();
  const navigation = await navigationState();
  evidence.navigation = { ...navigation, originalPDFURL: `http://127.0.0.1:${info.port}/api/takeoffs/sessions/${navigation.takeoffsSession}/documents/${uploaded.documents[0].id}/file` };
  stage = "responsive layout";
  for (const width of [1384, 1146, 390]) {
    await page.setViewportSize({ width, height: 764 }); await headingMenus(width); await rowHeights(width); await rightRail(width, "steel"); await noOverflow(`${width}/Steel`);
  }
  assert.deepEqual(await snapshot(), uploaded, "Layout, keyboard menus and rail scrolling preserve the Takeoffs draft");
  stage = "Legacy Count FRL and deleted history"; await legacyCountFrlAndDeletedHistory();
  stage = "Historical Length display precision"; await historicalLengthPrecision();
  stage = "create Textbox"; await page.setViewportSize({ width: 1384, height: 764 }); await makeTextbox(); const textbox = await snapshot();
  for (const currentTheme of ["ceasefire", "midnight"]) {
    stage = `Textbox settings ${currentTheme}`; await theme(currentTheme);
    for (const width of [1384, 1146, 390]) { await page.setViewportSize({ width, height: 764 }); await textSettings(width, currentTheme); await rightRail(width, "steel"); }
  }
  assert.deepEqual(await snapshot(), textbox, "Inspecting rich settings and changing theme/width sends no markup edit");
  for (const width of [1384, 390]) { stage = `Markup settings resize ${width}`; await resizePane(panel(), "markup-settings", width); }
  await page.getByRole("button", { name: "Viewport", exact: true }).click();
  for (const width of [1384, 390]) { stage = `Viewport resize ${width}`; await resizePane(page.locator("#takeoff-viewports"), "viewport", width); }
  await page.getByRole("button", { name: "Viewport", exact: true }).click();
  for (const mode of ["duct", "wall", "Defect Reports", "Service Plans"]) {
    stage = `workspace ${mode}`; await page.setViewportSize({ width: 1146, height: 764 }); await chooseTakeoff(page, mode); await settingsSettled(page); await headingMenus(1146, ["Defect Reports", "Service Plans"].includes(mode)); await rightRail(1146, mode); await noOverflow(`1146/${mode}`);
    if (mode === "Defect Reports") { await page.locator("#view-takeoffs").getByRole("button", { name: "Settings", exact: true }).click(); for (const width of [1384, 390]) { stage = `Item Details resize ${width}`; await resizePane(page.locator("#takeoff-physical-details"), "item-details", width); } await page.getByRole("button", { name: "Close Item Details", exact: true }).click(); }
  }
  stage = "Pricing Library"; await chooseLibrary(page, "pricing");
  const pricing = page.locator(".pricing-document-menu .calculator-document-toggle"), pricingArrow = pricing.locator(".calculator-document-chevron svg");
  await expect(pricingArrow).toHaveCount(1); assert.equal(await pricingArrow.locator("path").getAttribute("d"), "m6 9 6 6 6-6"); assert.equal(await pricingArrow.evaluate(el => getComputedStyle(el).fill), "none");
  await menuKeys(pricing, page.locator("#pricing-document-actions"), "Pricing Document");
  stage = "Firestopping Library"; await chooseLibrary(page, "penetration");
  const actions = page.locator(`#library-penetration [data-library-add="${info.item_id}"]`).first().locator("..");
  for (const width of [1384, 1146, 390]) {
    await page.setViewportSize({ width, height: 764 }); const add = actions.getByRole("button", { name: "Add to Schedule", exact: true }); await expect(add).toBeVisible();
    const b = await box(add); assert.equal(b.width, 48); assert.equal(b.height, 48);
    for (const control of await actions.getByRole("button").all()) assert.equal((await box(control)).height, 48, "Library action row has uniform heights");
    evidence.library.push({ width, add: b }); await noOverflow(`${width}/Firestopping Library`);
  }
  stage = "Firestopping calculator Add to Schedule";
  const libraryIcon = await actions.getByRole("button", { name: "Add to Schedule", exact: true }).locator("img").getAttribute("src");
  await page.locator("#calculator-navigation-toggle").hover();
  await page.locator('#calculator-navigation-menu [data-calculator-id="penetration"]').click();
  const calculatorAdd = page.locator("#penetration-add-to-schedule"), icon = calculatorAdd.locator("img");
  await expect(calculatorAdd).toBeVisible(); await expect(calculatorAdd).toHaveAccessibleName("Add to Schedule");
  assert.equal(await icon.getAttribute("src"), "/icons/schedule-add.png"); assert.equal(await icon.getAttribute("aria-hidden"), "true"); const libraryImage = await page.request.get(new URL(libraryIcon, page.url()).href), calculatorImage = await page.request.get(new URL("/icons/schedule-add.png", page.url()).href); assert.equal(libraryImage.status(), 200); assert.equal(calculatorImage.status(), 200); assert.deepEqual(await calculatorImage.body(), await libraryImage.body(), "Calculator and Library use exactly the same original transfer icon bytes");
  for (const width of [1384, 1146, 390]) { await page.setViewportSize({ width, height: 764 }); const b = await box(calculatorAdd), i = await box(icon); assert.equal(b.width, 48); assert.equal(b.height, 48); assert.equal(i.width, 24); assert.equal(i.height, 24); evidence.heights.push({ name: "Calculator Add to Schedule", width, button: b, icon: i }); await noOverflow(`${width}/Firestopping calculator`); }
  stage = "Standard-edition calculator button"; await standardCalculatorButton();
  assert.equal(hash(pdf), pdfBefore); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  assert.deepEqual(errors, []);
  // Both requests own explicit AbortControllers: the debounced estimate replaces
  // old calculation requests; switching PDF workspaces releases its source load.
  const cancellable = new Set([`http://127.0.0.1:${info.port}/api/calculate`, evidence.navigation.originalPDFURL]);
  const mediaErrors = await page.evaluate(() => window.uiMediaPreloads.flatMap(({ media, events }) => events.filter(event => event.type === "error" || event.error).map(event => ({ url: media.src, ...event }))));
  assert.deepEqual(mediaErrors, [], "Native sound decoding/delivery failures are never ignored");
  const benignPreload = request => verifiedPreloadCancellation(request, { origin: `http://127.0.0.1:${info.port}`, paths: cancellablePreloadPaths, preloads: evidence.mediaPreloads, assets: evidence.mediaAssets, hashes: sourceBefore });
  assert.ok(networkFailures.every(request => request.failure?.errorText === "net::ERR_ABORTED" && (cancellable.has(request.url) || benignPreload(request))), `Only explicit calculation/source-PDF cancellation or the two verified decoded startup media preloads is permitted. Recorded failures: ${JSON.stringify(networkFailures)}`);
  csp.push(...await page.evaluate(() => window.uiCsp)); assert.deepEqual(csp, []);
  assert.deepEqual(hashes(), sourceBefore, "The UI fixture never edits source files");
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: true, fixture_port: info.port, evidence, requests, errors, csp, networkFailures, pdf_sha256: pdfBefore, source_before_sha256: sourceBefore, source_after_sha256: hashes() }, null, 2));
  console.log(`PASS: PDF markup controls, menus, labels, heights and responsive right rail. Evidence: ${output}`);
})().catch(async error => {
  console.error(error); process.exitCode = 1; fs.mkdirSync(output, { recursive: true });
  if (page) csp.push(...await page.evaluate(() => window.uiCsp || []).catch(() => []));
  if (page) { await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, "failure.txt"), await page.locator("body").innerText().catch(() => "")); }
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ completed: false, stage, error: String(error), navigation: page ? await navigationState().catch(() => null) : null, evidence, requests, errors, csp, networkFailures, source_before_sha256: sourceBefore, source_after_sha256: hashes() }, null, 2));
}).finally(async () => { fs.writeFileSync(path.join(output, "server.log"), logs); await browser?.close(); server.kill(); });
