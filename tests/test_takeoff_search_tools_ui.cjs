"use strict";

// Exercise the actual viewer adapters without a browser, PDF worker, project,
// or application server. Delayed render completions are controlled explicitly.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../static/takeoffs.js"), "utf8");

function productionFunction(name) {
  const declaration = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(declaration, `Missing production function ${name}`);
  const start = declaration.index + 2, opening = source.indexOf("{", start);
  let depth = 0, quote = null, lineComment = false, blockComment = false;
  for (let i = opening; i < source.length; ++i) {
    const c = source[i], next = source[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; ++i; } continue; }
    if (quote) { if (c === "\\") ++i; else if (c === quote) quote = null; continue; }
    if (c === "/" && next === "/") { lineComment = true; ++i; continue; }
    if (c === "/" && next === "*") { blockComment = true; ++i; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") ++depth;
    if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`Unterminated production function ${name}`);
}

function loadFunctions(names, environment) {
  return vm.runInNewContext(`${names.map(productionFunction).join("\n")}\n({${names.join(",")}})`, environment);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const keyFunctions = ["sourcePageKey", "pageRotation", "pageDisplayKey"];
const originalViewport = () => ({ width: 400, height: 400, transform: [2, 0, 0, 2, 10, 20] });
const transform = (point, matrix) => [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];

function viewerState() {
  return {
    active: true, mode: "physical", physicalScope: "service_plans", busy: false, modal: null,
    session: { session_id: "session-a", revision: 3 }, document: "drawing-a", page: 1,
    pageRotations: new Map(), renderId: 10, fitId: 0, zoom: 1, viewport: originalViewport(),
    ui: { root: { closest: () => null }, viewport: { clientWidth: 800, clientHeight: 600, focus() {} } },
  };
}

function focusHarness({ delayedZoom = false } = {}) {
  const state = viewerState(), fits = [], pans = [], zooms = [], models = {
    project: "project-a", hidden: false,
    docs: [{ id: "drawing-a", sha256: "source-a", name: "A", pages: [{ page: 1 }, { page: 2 }, { page: 3 }] }, { id: "drawing-b", sha256: "source-b", name: "B", pages: [{ page: 1 }] }],
  };
  state.ui.root.closest = () => models.hidden ? {} : null;
  let api;
  const env = {
    state, requireFinishedEdits() {}, snapshot: () => ({ project_id: models.project }),
    documents: () => models.docs, currentDocument: () => models.docs.find(doc => doc.id === state.document),
    documentById: id => models.docs.find(doc => doc.id === id),
    fitPage() {
      const gate = deferred();
      const proof = { fitId: ++state.fitId, renderId: ++state.renderId, displayKey: api.pageDisplayKey() };
      fits.push({ gate, proof }); return gate.promise;
    },
    G: { transform, bounds: points => [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])), Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))] }, positionPage: (...args) => pans.push(args), cancelQueuedZoom() {},
    async renderPage() { ++state.renderId; state.viewport = originalViewport(); state.viewport.transform = [2*state.zoom,0,0,2*state.zoom,10,20]; if (delayedZoom) { const gate=deferred();zooms.push(gate);await gate.promise; } },
  };
  api = loadFunctions([...keyFunctions, "drawingSearchVisible", "drawingSearchContext", "focusSearchRegion", "focusVisualSearchHit"], env);
  state.displayKey = api.pageDisplayKey();
  const hit = { document_id: "drawing-a", document_sha256: "source-a", page: 2, point: [15, 25], region: [[10,20],[20,20],[20,30],[10,30]] };
  function finish(index = 0, mutate = () => {}, proof = fits[index].proof) {
    state.viewport = originalViewport(); state.displayKey = fits[index].proof.displayKey;
    mutate(state, models, fits[index]); fits[index].gate.resolve(proof);
  }
  return { state, models, fits, pans, zooms, hit, api, finish, env };
}

test("Visual Search mounts the named guarded viewer adapter", () => {
  assert.match(source, /focus:\s*focusVisualSearchHit\s*,/);
});

test("Visual Search pans a completed matching render to its PDF-space hit", async () => {
  const h = focusHarness(), pending = h.api.focusVisualSearchHit(h.hit);
  assert.equal(h.state.page, 2); assert.equal(h.fits.length, 1); assert.deepEqual(h.pans, []);
  h.finish(); await pending;
  assert.equal(h.state.zoom,8); assert.deepEqual(h.pans, [[150, -120]]);
});

for (const [name, mutate] of [
  ["another document", state => { state.document = "drawing-b"; }],
  ["another page", state => { state.page = 3; }],
  ["another session", state => { state.session = { session_id: "session-b", revision: 1 }; }],
  ["no session", state => { state.session = null; }],
  ["another project", (_state, models) => { models.project = "project-b"; }],
  ["another physical scope", state => { state.physicalScope = "barrier_plans"; }],
  ["another workspace mode", state => { state.mode = "estimate"; }],
  ["hidden Service Plans", (_state, models) => { models.hidden = true; }],
  ["inactive Takeoffs", state => { state.active = false; }],
  ["removed viewer context", state => { state.ui = null; }],
  ["replaced original source", (_state, models) => { models.docs[0].sha256 = "replacement-source"; }],
  ["deleted original document", (_state, models) => { models.docs.shift(); }],
  ["new operation", state => { state.busy = true; }],
  ["open modal", state => { state.modal = {}; }],
  ["cleared displayed viewport", state => { state.viewport = null; }],
  ["another displayed bitmap", state => { state.displayKey = "old-bitmap"; }],
  ["changed page rotation", state => { state.pageRotations.set(JSON.stringify(["session-a", "drawing-a", 2]), 90); }],
  ["superseding focus generation", state => { ++state.visualFocusGeneration; }],
  ["superseding fit", state => { ++state.fitId; }],
  ["superseding render", state => { ++state.renderId; }],
]) {
  test(`Visual Search does not pan after a pending fit sees ${name}`, async () => {
    const h = focusHarness(), pending = h.api.focusVisualSearchHit(h.hit);
    h.finish(0, mutate); await pending; assert.deepEqual(h.pans, []);
  });
}

for (const [name, proof] of [
  ["no native fit completion", undefined], ["null native fit completion", null],
  ["foreign displayed bitmap", { displayKey: "foreign", fitId: 1, renderId: 11 }],
  ["foreign native render", { displayKey: JSON.stringify(["session-a", "drawing-a", 2, 0]), fitId: 1, renderId: 99 }],
  ["foreign native fit", { displayKey: JSON.stringify(["session-a", "drawing-a", 2, 0]), fitId: 99, renderId: 11 }],
]) {
  test(`Visual Search requires proof of its own fit: ${name}`, async () => {
    const h = focusHarness(), pending = h.api.focusVisualSearchHit(h.hit);
    // Do not use a default argument here: undefined is the actual missing-proof case.
    h.state.displayKey = h.fits[0].proof.displayKey; h.fits[0].gate.resolve(proof);
    await pending; assert.deepEqual(h.pans, []);
  });
}

for (const [name, change] of [
  ["wrong scope", h => { h.state.physicalScope = "barrier_plans"; }],
  ["hidden viewer", h => { h.models.hidden = true; }],
  ["missing viewer", h => { h.state.ui = null; }],
  ["busy operation", h => { h.state.busy = true; }],
  ["open modal", h => { h.state.modal = {}; }],
]) {
  test(`Visual Search rejects ${name} before changing the selected page`, async () => {
    const h = focusHarness(); change(h);
    await assert.rejects(h.api.focusVisualSearchHit(h.hit), /Open Service Plans/);
    assert.equal(h.state.page, 1); assert.equal(h.fits.length, 0); assert.deepEqual(h.pans, []);
  });
}

test("Visual Search rejects a stale source before fitting", async () => {
  const h = focusHarness(); h.models.docs[0].sha256 = "changed";
  await assert.rejects(h.api.focusVisualSearchHit(h.hit), /source.*changed/);
  assert.equal(h.state.page, 1); assert.equal(h.fits.length, 0);
});

test("only the latest of overlapping Visual Search requests can pan", async () => {
  const h = focusHarness(), first = h.api.focusVisualSearchHit(h.hit);
  const second = h.api.focusVisualSearchHit({ ...h.hit, page: 3, point: [25, 35], region:[[20,30],[30,30],[30,40],[20,40]] });
  h.finish(0); await first; assert.deepEqual(h.pans, []);
  h.finish(1); await second; assert.deepEqual(h.pans, [[-10, -280]]);
});

for (const [name, mutate] of [
  ["changed document", h=>{h.state.document="drawing-b";}],
  ["changed page", h=>{h.state.page=3;}],
  ["changed source", h=>{h.models.docs[0].sha256="new-source";}],
  ["changed session", h=>{h.state.session.session_id="session-b";}],
  ["changed project", h=>{h.models.project="project-b";}],
  ["hidden workspace", h=>{h.models.hidden=true;}],
  ["changed physical scope", h=>{h.state.physicalScope="barrier_plans";}],
  ["opened modal", h=>{h.state.modal={};}],
  ["new operation", h=>{h.state.busy=true;}],
  ["new fit", h=>{h.state.fitId++;}],
  ["new render", h=>{h.state.renderId++;}],
  ["changed rotation", h=>{h.state.pageRotations.set(JSON.stringify(["session-a","drawing-a",2]),90);}],
]) test(`Visual Search cannot pan after its zoom render sees ${name}`,async()=>{
  const h=focusHarness({delayedZoom:true}),pending=h.api.focusVisualSearchHit(h.hit);h.finish();
  for(let i=0;i<5;i++)await Promise.resolve();assert.equal(h.zooms.length,1);mutate(h);h.zooms[0].resolve();await pending;assert.deepEqual(h.pans,[]);
});

function fitHarness({ refine = false, delayedDocument = false, nativeRender = true } = {}) {
  const state = viewerState(), renders = [], previews = [], failures = [], reveals = [], documentGate = deferred();
  const entered = deferred(), enteredSecond = deferred(), page = { width: 400, height: 500 }; let api, cancelledZoom = 0;
  const env = {
    state,
    pdfDocument: () => delayedDocument ? documentGate.promise : Promise.resolve({ id: "pdf-a" }),
    pdfPage: async () => page, pageViewport: (_page, scale) => ({ width: page.width * scale, height: page.height * scale }),
    revealDrawingPanel: (...args) => reveals.push(args), cancelQueuedZoom: () => { ++cancelledZoom; },
    displayViewport: viewport => { state.viewport = viewport; previews.push(viewport); },
    renderPage: (...args) => {
      const gate = deferred(); if (nativeRender) ++state.renderId;
      state.displayKey = api.pageDisplayKey(); state.viewport = originalViewport();
      renders.push({ gate, args }); entered.resolve(); if (renders.length === 2) enteredSecond.resolve(); return gate.promise;
    },
    recordPdfFailure: async (...args) => { failures.push(args); },
  };
  api = loadFunctions([...keyFunctions, "fitPage"], env);
  state.displayKey = refine ? api.pageDisplayKey() : null;
  if (!refine) state.viewport = null;
  return { state, api, renders, previews, failures, reveals, entered, enteredSecond, documentGate, cancelledZoom: () => cancelledZoom };
}

for (const refine of [false, true]) {
  test(`Fit page returns native completion proof after ${refine ? "preview refinement" : "a full render"}`, async () => {
    const h = fitHarness({ refine }), pending = h.api.fitPage();
    await h.entered.promise; assert.equal(h.renders.length, 1);
    h.renders[0].gate.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { fitId: 1, renderId: 11, displayKey: h.api.pageDisplayKey() });
    assert.equal(h.cancelledZoom(), refine ? 1 : 0); assert.equal(h.previews.length, refine ? 1 : 0);
    if (refine) assert.deepEqual(JSON.parse(JSON.stringify(h.renders[0].args)), [null, { refine: true }]);
    else assert.deepEqual(h.renders[0].args, []);
  });
}

for (const [name, mutate] of [
  ["document", state => { state.document = "drawing-b"; }],
  ["page", state => { state.page = 2; }],
  ["session", state => { state.session = { session_id: "session-b" }; }],
  ["fit generation", state => { ++state.fitId; }],
  ["render generation", state => { ++state.renderId; }],
  ["displayed bitmap", state => { state.displayKey = "foreign-bitmap"; }],
  ["rotation", state => { state.pageRotations.set(JSON.stringify(["session-a", "drawing-a", 1]), 90); }],
]) {
  test(`Fit page withholds completion proof when ${name} changes during its render`, async () => {
    const h = fitHarness(), pending = h.api.fitPage(); await h.entered.promise;
    mutate(h.state); h.renders[0].gate.resolve();
    assert.equal(await pending, undefined); assert.deepEqual(h.failures, []);
  });
}

for (const [name, mutate] of [
  ["document", state => { state.document = "drawing-b"; }],
  ["page", state => { state.page = 2; }],
  ["session", state => { state.session = null; }],
  ["render generation", state => { ++state.renderId; }],
]) {
  test(`Fit page avoids starting a render when ${name} changes during PDF loading`, async () => {
    const h = fitHarness({ delayedDocument: true }), pending = h.api.fitPage();
    mutate(h.state); h.documentGate.resolve({ id: "pdf-a" });
    assert.equal(await pending, undefined); assert.deepEqual(h.renders, []);
  });
}

test("Fit page withholds proof if native rendering did not actually begin", async () => {
  const h = fitHarness({ nativeRender: false }), pending = h.api.fitPage(); await h.entered.promise;
  h.renders[0].gate.resolve(); assert.equal(await pending, undefined);
});

test("an older overlapping Fit page cannot claim a newer render", async () => {
  const h = fitHarness(), first = h.api.fitPage(); await h.entered.promise;
  const second = h.api.fitPage();
  await h.enteredSecond.promise;
  assert.equal(h.renders.length, 2);
  h.renders[0].gate.resolve(); assert.equal(await first, undefined);
  h.renders[1].gate.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), { fitId: 2, renderId: 12, displayKey: h.api.pageDisplayKey() });
});

test("a failed native Fit page reports the error and yields no focus proof", async () => {
  const h = fitHarness(), pending = h.api.fitPage(); await h.entered.promise;
  const error = new Error("Owned render failure"); h.renders[0].gate.reject(error);
  assert.equal(await pending, undefined); assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0][2], error);
});

test("Fit page with no document or an unfinished gesture cannot manufacture proof", async () => {
  const h = fitHarness(); h.state.document = null;
  assert.equal(await h.api.fitPage(), undefined); assert.deepEqual(h.renders, []);
  h.state.document = "drawing-a"; h.state.gesture = {};
  await assert.rejects(h.api.fitPage(), /Finish or cancel/); assert.deepEqual(h.renders, []);
});

for (const anchor of [null, { point: [15, 25], offset: [200, 300] }]) {
  test(`preview zoom repositions retained OCR synchronously ${anchor ? "at the cursor anchor" : "when fitting"}`, () => {
    const state = viewerState(), operations = [], attributes = {}, viewport = originalViewport();
    state.zoom = 2; state.ui.canvas = { style: {} }; state.ui.zoom = {};
    state.ui.overlay = { setAttribute: (name, value) => { attributes[name] = value; } };
    state.ocrLayer = { reposition: () => { assert.equal(state.viewport, viewport); operations.push("ocr"); } };
    const api = loadFunctions(["displayViewport"], {
      state, G: { transform }, positionPdfTextLayer: shown => { assert.equal(shown, viewport); operations.push("native"); },
      positionPage: (...args) => operations.push(args), renderOverlay: () => operations.push("overlay"),
    });
    api.displayViewport(viewport, anchor);
    assert.deepEqual(operations, ["native", "ocr", anchor ? [160, 230] : [200, 100], "overlay"]);
    assert.deepEqual(state.ui.canvas.style, { width: "400px", height: "400px" });
    assert.deepEqual(attributes, { viewBox: "0 0 400 400", width: "400", height: "400" });
    assert.equal(state.ui.zoom.textContent, "200%");
  });
}
