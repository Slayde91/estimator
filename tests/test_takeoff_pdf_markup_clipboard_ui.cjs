"use strict";
// Run the real workspace closures with disposable state and controlled async
// boundaries. This contains no network, browser, storage or calculator runtime.
const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const G = require("../static/takeoff-geometry.js"), X = require("../static/takeoff-graphics.js");
const sourcePath = path.resolve(__dirname, "../static/takeoffs.js");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function element(tag = "div") {
  const el = { tagName: tag.toUpperCase(), children: [], events: {}, attributes: {}, className: "", textContent: "", dataset: {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener(name, fn) { this.events[name] = fn; } };
  el.classList = { add(...names) { el.className += ` ${names.join(" ")}`; }, toggle() {} }; return el;
}
function fixture({ mode = "steel", kind = "textbox", signature = false, transform = [1, 0, 0, -1, -10, 820] } = {}) {
  const calls = { commands: [], renders: 0, flushes: 0, physicalClear: 0 };
  const context = { window: { CeasefireTakeoffGeometry: G, CeasefireTakeoffGraphics: X },
    document: { createElement: element, createElementNS: (_, tag) => element(tag) }, crypto, console, setTimeout, clearTimeout, Intl };
  context.window.CeasefireTakeoffGraphicsUI = host => ({
    records: () => host.snapshot()?.graphics?.records || [],
    selected: () => host.snapshot()?.graphics?.records.find(value => value.id === host.state.graphicSelected && host.signatureInWorkspace(value) && value.document_id === host.state.document && value.page === host.state.page),
    isTool: () => false
  });
  vm.createContext(context);
  const source = fs.readFileSync(sourcePath, "utf8").replace("  window.CeasefireTakeoffs = {", `  globalThis.audit = {
    state, copyPdfMarkup, pastePdfMarkup, clearDrawingSelection, planKeydown, pdfPasteContext, pageDisplayKey, drawingPoint, applySignatureSettings, signatureSelectionKey,
    setCommand(fn) { command = fn; }, setFlush(fn) { flushSettings = fn; }, setDiscard(fn) { discardEditor = fn; },
    setRenderers(fn) { renderSelection = fn; renderOverlay = fn; renderRegister = fn; }
  };\n  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context, { filename: sourcePath });
  const h = context.audit, effectiveMode = mode === "physical" ? "defect_reports" : mode;
  const points = [[40.125, 70.375], [80.875, 70.375], [80.875, 110.625], [40.125, 110.625]];
  const common = { id: signature ? "signature-A" : "graphic-A", version: 4, mode: effectiveMode, document_id: "doc-A", source_sha256: "a".repeat(64), page: 1,
    appearance: signature ? { stroke_color: "#ff0000", stroke_width: 1.125, opacity: .375 } : X.defaults(),
    initial_pages: { version: 1, group_id: "server-group", role: signature ? "signature" : "text" }, extra_identity: "do not copy" };
  const record = signature ? { ...common, quad_pdf: points, strokes: [[[.1, .2], [.4, .6]]] }
    : { ...common, kind, geometry: X.boxes.has(kind) ? { quad_pdf: points } : { points: points.slice(0, kind === "line" || kind === "arrow" ? 2 : 4) },
      text: ["textbox", "stamp"].includes(kind) ? "Literal drawing text" : "",
      ...(kind === "textbox" ? { text_content: { version: 1, blocks: [{ kind: "paragraph", runs: [{ text: "Literal drawing text", bold: true }] }] } } : {}) };
  const snapshot = { documents: ["A", "B"].map((suffix, index) => ({ id: `doc-${suffix}`, sha256: (index ? "b" : "a").repeat(64), pages: [1, 2].map(page => ({ page, rotation: 0, view: [10, 20, 610, 820] })) })),
    graphics: { version: 1, records: signature ? [] : [record] }, signatures: { version: 1, records: signature ? [record] : [] }, annotations: { callouts: [] },
    items: [{ id: "measured-retained", quantity: 2.125, fields: { exact: 17.000000004 } }], calibrations: [{ id: "retained-scale" }], transfers: [{ id: "retained-transfer", quantity: 9.333333333333 }], physical: { barriers: [{ id: "retained-barrier" }] } };
  Object.assign(h.state, { active: true, mode, physicalScope: "defect_reports", document: "doc-A", page: 1, tool: "select",
    viewport: { width: 600, height: 800, transform }, session: { session_id: "session-A", revision: 8, snapshot },
    graphicSelected: signature ? null : record.id, signatureSelected: signature ? record.id : null,
    ui: { message: element(), overlay: { getBoundingClientRect: () => ({ left: 32, top: 44, width: 300, height: 400 }) } } });
  h.setRenderers(() => calls.renders++);
  h.setFlush(async () => { calls.flushes++; }); h.setDiscard(async () => true);
  h.setCommand(async (op, body, guard) => {
    if (guard && !guard()) return null;
    calls.commands.push({ op, ...clone(body) }); h.state.session.revision++;
    return op === "create_signature" ? { created_signature_id: "independent-signature" } : { created_graphic_id: "independent-graphic" };
  });
  function pointer(pdf = [200.125, 300.375]) {
    const screen = G.transform(pdf, h.state.viewport.transform);
    h.state.pastePointer = { key: h.pageDisplayKey(), client: [32 + screen[0] / 2, 44 + screen[1] / 2] };
    return h.state.pastePointer;
  }
  pointer(); return { ...h, calls, record, snapshot, context, pointer };
}

for (const kind of X.kinds) test(`Copy/paste ${kind} preserves full-precision content and omits identity/link metadata`, async () => {
  const f = fixture({ kind, transform: [0, 2, 2, 0, -40, -20] }), before = clone(f.snapshot), pointer = [200.125, 300.375];
  f.pointer(pointer); await f.copyPdfMarkup(); await f.pastePdfMarkup();
  assert.equal(f.calls.commands.length, 1); const { op, graphic } = f.calls.commands[0]; assert.equal(op, "create_graphic");
  assert.deepEqual(Object.keys(graphic).sort(), ["appearance", "document_id", "geometry", "kind", "mode", "page", "source_sha256", "text", ...(kind === "textbox" ? ["text_content"] : [])].sort());
  assert.deepEqual(graphic.appearance, before.graphics.records[0].appearance); assert.equal(graphic.text, f.record.text);
  if (kind === "textbox") assert.deepEqual(graphic.text_content, f.record.text_content);
  const oldPoints = X.coordinates(f.record), bounds = G.bounds(oldPoints), center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  assert.deepEqual(graphic.geometry.quad_pdf || graphic.geometry.points, oldPoints.map(p => p.map((n, axis) => n + pointer[axis] - center[axis])));
  assert.equal(f.state.graphicSelected, "independent-graphic"); assert.equal(f.state.settingsOpen, false);
  assert.deepEqual(clone(f.snapshot), before, "Clipboard does not change quantities, transfers, originals or source records");
});

for (const mode of ["steel", "duct", "wall", "slab", "physical"]) test(`Signature copy in ${mode} uses independent PDF-only create without measured/physical graph commands`, async () => {
  const f = fixture({ signature: true, mode }), before = clone(f.snapshot); await f.copyPdfMarkup(); await f.pastePdfMarkup();
  const { op, signature } = f.calls.commands[0]; assert.equal(op, "create_signature");
  assert.deepEqual(Object.keys(signature).sort(), ["appearance", "document_id", "mode", "page", "quad_pdf", "source_sha256", "strokes"].sort());
  assert.deepEqual(signature.strokes, f.record.strokes); assert.equal(signature.mode, mode === "physical" ? "defect_reports" : mode);
  assert.equal(f.state.signatureSelected, "independent-signature"); assert.deepEqual(clone(f.snapshot), before);
});

test("Canonical image content is retained literally without identity metadata", async () => {
  const f = fixture({ kind: "stamp" }); f.record.text = ""; f.record.stamp_image = { version: 1, mime_type: "image/png", content_base64: "AQID", width: 1, height: 1, sha256: "c".repeat(64) };
  await f.copyPdfMarkup(); await f.pastePdfMarkup(); assert.deepEqual(f.calls.commands[0].graphic.stamp_image, f.record.stamp_image);
  assert.equal(f.calls.commands[0].graphic.initial_pages, undefined);
});

test("Copy flushes edited content and exclusively replaces prior clipboard families", async () => {
  const f = fixture(); f.state.annotationClipboard = {}; f.state.lengthClipboard = {}; f.state.physicalClipboard = {};
  f.setFlush(async () => { f.record.text = "Latest committed settings"; f.record.version++; f.state.session.revision++; });
  await f.copyPdfMarkup(); assert.equal(f.state.pdfMarkupClipboard.record.text, "Latest committed settings"); assert.equal(f.state.pdfMarkupClipboard.record.version, 5);
  for (const field of ["annotationClipboard", "lengthClipboard", "physicalClipboard"]) assert.equal(f.state[field], null);
});

test("Delayed copy cannot replace a newer clipboard from another family", async () => {
  for (const field of ["annotationClipboard", "physicalClipboard", "lengthClipboard", "pdfMarkupClipboard"]) {
    const f = fixture(), held = deferred(); f.setFlush(() => held.promise); const pending = f.copyPdfMarkup();
    const newer = f.state[field] = { newer: true }; held.resolve(); await assert.rejects(pending);
    assert.equal(f.state[field], newer); if (field !== "pdfMarkupClipboard") assert.equal(f.state.pdfMarkupClipboard, undefined);
  }
});

test("Paste changes only destination source identity and preserves copied literal geometry shape", async () => {
  const f = fixture({ kind: "arrow" }); await f.copyPdfMarkup(); f.state.document = "doc-B"; f.state.page = 2; f.pointer();
  await f.pastePdfMarkup(); const copied = f.calls.commands[0].graphic;
  assert.equal(copied.document_id, "doc-B"); assert.equal(copied.source_sha256, "b".repeat(64)); assert.equal(copied.page, 2);
  assert.equal(copied.geometry.points[1][0] - copied.geometry.points[0][0], f.record.geometry.points[1][0] - f.record.geometry.points[0][0]);
  assert.equal(copied.geometry.points[1][1] - copied.geometry.points[0][1], f.record.geometry.points[1][1] - f.record.geometry.points[0][1]);
});

const contextChanges = [
  ["session", f => f.state.session.session_id = "new-session"], ["page", f => f.state.page = 2],
  ["source", f => f.state.document = "doc-B"], ["source digest", f => f.snapshot.documents[0].sha256 = "c".repeat(64)],
  ["workspace", f => f.state.mode = "duct"], ["tool", f => f.state.tool = "pan"],
  ["render", f => f.state.renderId++], ["transform", f => f.state.viewport.transform = [2, 0, 0, -2, -20, 1640]]
];
for (const [name, change] of contextChanges) test(`Delayed copy retains newer ${name} and creates no clipboard`, async () => {
  const f = fixture(), held = deferred(); f.setFlush(() => held.promise);
  const pending = f.copyPdfMarkup(); change(f); held.resolve(); await assert.rejects(pending);
  assert.equal(f.state.pdfMarkupClipboard, undefined); assert.equal(f.calls.commands.length, 0);
});

test("Copy refuses changed selection, hidden markup, global hide and unfinished settings", async () => {
  for (const mutate of [f => f.state.graphicSelected = "newer-selection", f => f.state.graphicHidden = new Set([f.record.id]), f => f.state.markupsHidden = true, f => f.state.settingsDirty = true]) {
    const f = fixture(), held = deferred(); f.setFlush(() => held.promise); const pending = f.copyPdfMarkup(); mutate(f); held.resolve();
    await assert.rejects(pending); assert.equal(f.state.pdfMarkupClipboard, undefined);
  }
});

for (const [name, change] of contextChanges) test(`Paste after a delayed settings flush rejects changed ${name} before a request`, async () => {
  const f = fixture(); await f.copyPdfMarkup(); const held = deferred(); f.setFlush(() => held.promise);
  const pending = f.pastePdfMarkup(); change(f); held.resolve(); await assert.rejects(pending); assert.equal(f.calls.commands.length, 0);
});

test("Paste rejects stale pointer, original source absence, out-of-bounds and nonfinite locations", async () => {
  for (const mutate of [f => f.state.pastePointer = null, f => f.state.pastePointer.key = "stale", f => f.snapshot.documents = f.snapshot.documents.slice(1), f => f.pointer([12, 22]), f => f.state.pastePointer.client = [NaN, Infinity]]) {
    const f = fixture(); await f.copyPdfMarkup(); mutate(f); await assert.rejects(f.pastePdfMarkup()); assert.equal(f.calls.commands.length, 0);
  }
});

test("Paste guard refuses a newer pointer or revision while queued", async () => {
  for (const mutate of [f => f.pointer([300, 400]), f => f.state.session.revision++]) {
    const f = fixture(); await f.copyPdfMarkup();
    f.setCommand(async (_op, _body, guard) => { mutate(f); assert.equal(guard(), false); return null; });
    await f.pastePdfMarkup(); assert.equal(f.state.graphicSelected, "graphic-A"); assert.equal(f.calls.renders, 0);
  }
});

test("Queued paste still rejects an unfinished newer draft before requesting a mutation", async () => {
  const f = fixture(); await f.copyPdfMarkup(); f.setCommand(async (_op, _body, guard) => { f.state.settingsDirty = true; return guard(); });
  await assert.rejects(f.pastePdfMarkup(), /unfinished/); assert.equal(f.state.graphicSelected, "graphic-A"); assert.equal(f.calls.renders, 0);
});

test("Physical PDF clipboard cannot cross Defect Reports and Service Plans during a flush", async () => {
  const f = fixture({ mode: "physical" }); await f.copyPdfMarkup(); const held = deferred(); f.setFlush(() => held.promise);
  const pending = f.pastePdfMarkup(); f.state.physicalScope = "service_plans"; held.resolve();
  await assert.rejects(pending); assert.equal(f.calls.commands.length, 0); assert.equal(f.state.physicalScope, "service_plans");
});

test("A delayed paste reply retains newer page, tool and clipboard state", async () => {
  for (const change of [f => f.state.page = 2, f => f.state.tool = "pan", f => f.state.pdfMarkupClipboard = { newer: true }]) {
    const f = fixture(); await f.copyPdfMarkup(); const held = deferred(); let dispatched = false;
    f.setCommand(async (_op, _body, guard) => { assert.equal(guard(), true); dispatched = true; return held.promise; });
    const pending = f.pastePdfMarkup(); await settle(); assert.equal(dispatched, true); change(f);
    const retained = { page: f.state.page, tool: f.state.tool, clipboard: f.state.pdfMarkupClipboard, graphic: f.state.graphicSelected };
    held.resolve({ created_graphic_id: "late-copy" }); await pending;
    assert.equal(f.state.page, retained.page); assert.equal(f.state.tool, retained.tool); assert.equal(f.state.pdfMarkupClipboard, retained.clipboard); assert.equal(f.state.graphicSelected, retained.graphic); assert.equal(f.calls.renders, 0);
  }
});

test("A delayed paste reply must retain a newer same-page selection and Settings editor", async () => {
  const f = fixture(); await f.copyPdfMarkup(); const held = deferred();
  f.setCommand(async (_op, _body, guard) => { assert.equal(guard(), true); return held.promise; });
  const pending = f.pastePdfMarkup(); await settle();
  f.state.graphicSelected = "newer-same-page"; f.state.settingsOpen = true; const editor = f.state.settingsEditor = { newer: true };
  held.resolve({ created_graphic_id: "late-copy" }); await pending;
  assert.equal(f.state.graphicSelected, "newer-same-page"); assert.equal(f.state.settingsEditor, editor); assert.equal(f.state.settingsOpen, true);
});

test("Delayed physical selection clearing must not overwrite a newer PDF selection", async () => {
  const f = fixture({ mode: "physical" }); await f.copyPdfMarkup(); const held = deferred();
  f.state.physicalUI = { hasUnfinishedChanges: () => false, clearSelection() { f.calls.physicalClear++; return held.promise; } };
  const pending = f.pastePdfMarkup(); await settle(); assert.equal(f.calls.physicalClear, 1);
  f.state.graphicSelected = "newer-physical-page"; f.state.settingsOpen = true; const editor = f.state.settingsEditor = { newer: true };
  held.resolve(); await pending; assert.equal(f.state.graphicSelected, "newer-physical-page"); assert.equal(f.state.settingsEditor, editor); assert.equal(f.state.settingsOpen, true);
});

test("Native text/rich editor shortcuts and nonselect drawing tools are never intercepted", async () => {
  for (const key of ["c", "v"]) for (const target of [{ isContentEditable: true }, { closest() { return {}; } }]) {
    const f = fixture(); await f.copyPdfMarkup(); const copied = f.state.pdfMarkupClipboard;
    f.planKeydown({ key, ctrlKey: true, target, preventDefault() { assert.fail("Native clipboard intercepted"); } });
    await settle(); assert.equal(f.state.pdfMarkupClipboard, copied); assert.equal(f.calls.commands.length, 0);
  }
  for (const mutate of [event => event.repeat = true, event => event.isComposing = true, event => event.shiftKey = true, event => event.altKey = true]) {
    const f = fixture(), event = { key: "c", ctrlKey: true, target: {}, preventDefault() { assert.fail("Guarded shortcut intercepted"); } }; mutate(event); f.planKeydown(event); await settle(); assert.equal(f.state.pdfMarkupClipboard, undefined);
  }
  for (const tool of ["text", "pan", "graphic-stamp", "signature"]) {
    const f = fixture(); f.state.tool = tool; f.planKeydown({ key: "c", ctrlKey: true, target: {}, preventDefault() { assert.fail("Drawing/text tool intercepted"); } }); await settle(); assert.equal(f.state.pdfMarkupClipboard, undefined);
  }
});

for (const mode of ["steel", "physical"]) test(`Blank PDF clears all PDF selections and closes Settings in ${mode}`, async () => {
  const f = fixture({ mode }); Object.assign(f.state, { annotationSelected: "callout", signatureSelected: "signature", legendSelected: "legend", settingsOpen: true, settingsEditor: { old: true }, hovered: "old", markupMenu: {} });
  f.state.selected.add("measured-retained"); f.state.countSelection.set("measured-retained", new Set(["member"]));
  if (mode === "physical") { f.state.physicalSelected.add("barrier"); f.state.physicalUI = { clearSelection: async () => { f.calls.physicalClear++; f.state.physicalSelected.clear(); } }; }
  const before = clone(f.snapshot); await f.clearDrawingSelection();
  for (const key of ["graphicSelected", "annotationSelected", "signatureSelected", "legendSelected", "settingsEditor", "markupMenu", "hovered"]) assert.equal(f.state[key], null);
  assert.equal(f.state.selected.size, 0); assert.equal(f.state.countSelection.size, 0); assert.equal(f.state.physicalSelected.size, 0); assert.equal(f.state.settingsOpen, false); assert.deepEqual(clone(f.snapshot), before);
});

test("Declined discard and stale selection during flush preserve the newer Settings state", async () => {
  const f = fixture(); f.state.settingsOpen = true; f.setDiscard(async () => false); await f.clearDrawingSelection(); assert.equal(f.state.graphicSelected, "graphic-A"); assert.equal(f.state.settingsOpen, true);
  const held = deferred(); f.setDiscard(() => held.promise); const pending = f.clearDrawingSelection(); f.state.graphicSelected = "newer"; const editor = f.state.settingsEditor = { newer: true };
  held.resolve(true); await pending; assert.equal(f.state.graphicSelected, "newer"); assert.equal(f.state.settingsEditor, editor); assert.equal(f.state.settingsOpen, true);
});

test("Delayed blank deselection must preserve a new physical scope on the same PDF page", async () => {
  const f = fixture({ mode: "physical" }), held = deferred(); f.state.graphicSelected = null; f.state.settingsOpen = true;
  f.setDiscard(() => held.promise); const pending = f.clearDrawingSelection(); f.state.physicalScope = "service_plans"; const editor = f.state.settingsEditor = { newer: true };
  held.resolve(true); await pending; assert.equal(f.state.settingsOpen, true); assert.equal(f.state.settingsEditor, editor); assert.equal(f.calls.renders, 0);
});

test("Continue Stamp cannot arm over a newer selection while its first settings flush is held", async () => {
  const code = fs.readFileSync(path.resolve(__dirname, "../static/takeoff-graphics-ui.js"), "utf8");
  const start = code.indexOf("  async function continueStamp(id) {"), end = code.indexOf("  return Object.freeze", start);
  assert.ok(start >= 0 && end > start);
  const state = { tool: "select", document: "doc", page: 1, graphicSelected: "stamp-A", signatureSelected: null, annotationSelected: null, legendSelected: null, selected: new Set(), physicalSelected: new Set(), countSelection: new Map(), settingsOpen: true, settingsEditor: { key: "stamp-A" } };
  const record = { id: "stamp-A", kind: "stamp", version: 2, document_id: "doc", page: 1, geometry: { quad_pdf: [[10, 20], [30, 20], [30, 40], [10, 40]] }, text: "Latest", appearance: X.defaults() };
  const held = deferred(), calls = { activate: 0, render: 0 };
  const context = { state, records: () => [record], signatureInWorkspace: () => true, stampKey: () => "session/doc/page/mode", flushSettings: () => held.promise,
    requireFinishedEdits() {}, clone, async activate() { calls.activate++; state.tool = "graphic-stamp"; }, renderSelection() { calls.render++; }, message() {} };
  vm.createContext(context); vm.runInContext(`${code.slice(start, end)}; globalThis.continue = continueStamp;`, context);
  const pending = context.continue("stamp-A"); state.graphicSelected = "newer-graphic"; const editor = state.settingsEditor = { key: "newer-graphic" };
  held.resolve(); await assert.rejects(pending); assert.equal(calls.activate, 0); assert.equal(state.graphicSelected, "newer-graphic"); assert.equal(state.settingsEditor, editor); assert.equal(state.tool, "select");
});

test("A linked Textbox colour edit submits only the touched style, preserving per-page auto-fit font sizes", async () => {
  const f = fixture(), code = fs.readFileSync(path.resolve(__dirname, "../static/takeoff-graphics-ui.js"), "utf8");
  const start = code.indexOf("  async function apply(editor) {"), end = code.indexOf("  const measure=", start); assert.ok(start >= 0 && end > start);
  const context = { state: f.state, selected: () => f.record, key: () => "selected", window: {}, clearTimeout,
    command: async (op, body, guard) => { assert.equal(guard(), true); f.calls.commands.push({ op, ...clone(body) }); return { revision: 9 }; } };
  vm.createContext(context); vm.runInContext(`${code.slice(start, end)}; globalThis.applyGraphic = apply;`, context);
  const editor = f.state.settingsEditor = { key: "selected", sessionId: "session-A", id: f.record.id, touched: new Map([["appearance:font_color", 1]]),
    appearance: Object.entries(X.defaults()).map(([name, value]) => ({ control: { name }, read: () => name === "font_color" ? "#123456" : value })) };
  f.state.settingsDirty = true; await context.applyGraphic(editor);
  assert.deepEqual(f.calls.commands[0], { op: "update_graphic", graphic_id: f.record.id, changes: { appearance: { font_color: "#123456" } } });
  assert.equal(editor.touched.size, 0); assert.equal(f.state.settingsDirty, false); assert.equal(f.record.appearance.font_size, 12);
});

test("A linked signature colour edit submits only the touched style, preserving untouched legacy differences", async () => {
  const f = fixture({ signature: true }); const editor = f.state.settingsEditor = { key: f.signatureSelectionKey(), sessionId: "session-A", id: f.record.id,
    touched: new Map([["appearance:stroke_color", 1]]), appearance: Object.entries(f.record.appearance).map(([name, value]) => ({ control: { name }, read: () => name === "stroke_color" ? "#123456" : value })) };
  f.setCommand(async (op, body, guard) => { assert.equal(guard(), true); f.calls.commands.push({ op, ...clone(body) }); return { revision: 9 }; });
  f.state.settingsDirty = true; await f.applySignatureSettings(editor);
  assert.deepEqual(f.calls.commands[0], { op: "update_signature", signature_id: f.record.id, changes: { appearance: { stroke_color: "#123456" } } });
  assert.equal(editor.touched.size, 0); assert.equal(f.state.settingsDirty, false);
});
