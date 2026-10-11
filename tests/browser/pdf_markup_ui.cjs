"use strict";
// Layout/keyboard checks use a synthetic library, PDF, browser and random-port
// server. No request, draft or writable path belongs to the live application.
const { chromium, expect } = require("@playwright/test");
const { chooseTakeoff, chooseLibrary } = require("./section_navigation.cjs");
const { renderDrawing } = require("./viewer_helpers.cjs");
const { settingsSettled } = require("./settings_helpers.cjs");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../.."), output = path.join(root, ".runtime/browser-qa", `pdf-markup-ui-${Date.now()}`);
const python = process.env.CEASEFIRE_PYTHON || "python";
const assets = ["static/app.js", "static/takeoffs.js", "static/takeoffs.css", "static/takeoff-graphics.js", "static/takeoff-graphics-ui.js", "static/takeoff-annotations.js", "static/libraries.css", "static/index.html", "static/styles.css", "static/theme.css", "tests/browser/pdf_markup_ui.cjs"];
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hashes = () => Object.fromEntries(assets.map(file => [file, hash(path.join(root, file))]));
const sourceBefore = hashes(), evidence = { layouts: [], menus: [], heights: [], textSettings: [], library: [], pointerTargets: [] }, errors = [], csp = [], requests = [], networkFailures = [];
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
  for (let i = 0; i < 5 && await page.locator("html").getAttribute("data-theme") !== id; i++) await page.locator("#theme-toggle").click();
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
  const heading = page.locator(".takeoff-workspace-heading"), documentMenu = heading.locator(".takeoff-document-menu"), toolsMenu = heading.locator(".takeoff-pdf-tools-menu");
  await expect(documentMenu).toHaveCount(1); await expect(toolsMenu).toHaveCount(1);
  if (physical) {
    await expect(documentMenu).toBeHidden(); await expect(documentMenu.locator(".calculator-document-actions")).toBeHidden();
    await menuKeys(toolsMenu.locator("button").first(), page.locator("#takeoff-pdf-tools-actions"), "Physical PDF Tools");
    const physicalMenu = page.locator(".takeoff-physical-register .takeoff-document-menu");
    await expect(physicalMenu).toBeVisible();
    await menuKeys(physicalMenu.locator("button").first(), physicalMenu.locator(".calculator-document-actions"), "Physical Document");
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
  await rail().getByRole("button", { name: "Textbox", exact: true }).click();
  const overlay = page.locator(".takeoff-overlay"); await overlay.scrollIntoViewIfNeeded();
  await overlay.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 195));
  const bounds = await box(overlay);
  // A box in the lower half leaves the native pointer clear of top controls.
  const points = [[.2, .55], [.65, .78]].map(([x,y]) => [bounds.x + bounds.width*x, bounds.y + bounds.height*y]);
  for (const point of points) assert.equal(await page.evaluate(([x,y]) => !!document.elementFromPoint(x,y)?.closest(".takeoff-overlay"), point), true);
  const response = page.waitForResponse(reply => reply.url().endsWith("/commands") && reply.request().postDataJSON()?.op === "create_graphic"); response.catch(() => {});
  for (const point of points) await page.mouse.click(...point);
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Textbox", exact: true })).toBeVisible();
  await dialog.getByLabel("Textbox text", { exact: true }).fill("Synthetic rich textbox layout note");
  await dialog.getByRole("button", { name: "Place markup", exact: true }).click();
  assert.equal((await response).status(), 200); await settingsSettled(page);
  await expect(panel().getByRole("heading", { name: "Textbox Settings", exact: true })).toBeVisible();
}
async function textSettings(width, currentTheme) {
  const labels = await panel().locator(".takeoff-settings-fields > .field > span:first-child").allTextContents();
  assert.deepEqual(labels.slice(0, 7), ["Line Colour", "Line Width", "Fill Colour", "Fill Enabled", "Font Colour", "Opacity", "Font Size"]);
  for (const name of labels.slice(0, 7)) await expect(panel().getByLabel(name, { exact: true })).toBeVisible();
  const colours = await panel().locator(".field > span:first-child").evaluateAll(elements => elements.map(el => getComputedStyle(el).color));
  assert.ok(colours.every(colour => colour === "rgb(255, 255, 255)"), `Dark settings labels remain white in ${currentTheme}: ${JSON.stringify(colours)}`);
  const toolbar = panel().getByRole("toolbar", { name: "Textbox text formatting", exact: true }), editor = panel().getByRole("textbox", { name: "Textbox text", exact: true });
  await expect(editor).toHaveAttribute("contenteditable", "true"); await expect(editor).toHaveAttribute("aria-multiline", "true");
  for (const name of ["Bold", "Italic", "Underline", "Bullet list", "Numbered list"]) await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
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
  evidence.textSettings.push({ width, theme: currentTheme, labels, colours, settings: p, rightRail: r, trash: t, contents });
}

(async () => {
  info = await ready; assert.notEqual(info.port, 8765); assert.equal(path.resolve(info.directory), output);
  const pdf = path.join(output, "synthetic-drawing.pdf");
  const generated = spawnSync(python, ["-c", "import runpy,sys; runpy.run_path(sys.argv[1])['make_pdf'](sys.argv[2])", path.join(__dirname, "fixtures.py"), pdf], { cwd: root, windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr); const pdfBefore = hash(pdf);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1384, height: 764 } }); page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", request => networkFailures.push({ stage, url: request.url(), failure: request.failure() }));
  page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
  await page.addInitScript(() => { window.uiCsp = []; document.addEventListener("securitypolicyviolation", event => window.uiCsp.push(event.effectiveDirective)); });
  stage = "initial load"; await page.goto(`http://127.0.0.1:${info.port}/`); await page.waitForFunction(() => window.CeasefireDesktop?.status().ready && !window.CeasefireDesktop.status().busy);
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
  stage = "create Textbox"; await page.setViewportSize({ width: 1384, height: 764 }); await makeTextbox(); const textbox = await snapshot();
  for (const currentTheme of ["ceasefire", "midnight"]) {
    stage = `Textbox settings ${currentTheme}`; await theme(currentTheme);
    for (const width of [1384, 1146, 390]) { await page.setViewportSize({ width, height: 764 }); await textSettings(width, currentTheme); await rightRail(width, "steel"); }
  }
  assert.deepEqual(await snapshot(), textbox, "Inspecting rich settings and changing theme/width sends no markup edit");
  for (const mode of ["duct", "wall", "Defect Reports", "Service Plans"]) {
    stage = `workspace ${mode}`; await page.setViewportSize({ width: 1146, height: 764 }); await chooseTakeoff(page, mode); await settingsSettled(page); await headingMenus(1146, ["Defect Reports", "Service Plans"].includes(mode)); await rightRail(1146, mode); await noOverflow(`1146/${mode}`);
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
  assert.equal(hash(pdf), pdfBefore); assert.deepEqual(await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()), calculators);
  assert.deepEqual(errors, []);
  // Both requests own explicit AbortControllers: the debounced estimate replaces
  // old calculation requests; switching PDF workspaces releases its source load.
  const cancellable = new Set([`http://127.0.0.1:${info.port}/api/calculate`, evidence.navigation.originalPDFURL]);
  assert.ok(networkFailures.every(request => request.failure?.errorText === "net::ERR_ABORTED" && cancellable.has(request.url)), "Only explicit cancellation of this fixture's calculation or exact source PDF is permitted");
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
