"use strict";
// Execute the real workspace functions with disposable state. The browser
// journey covers actual keyboard focus, clipboard, drawing and rendered sizing.
const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const geometry = require("../static/takeoff-geometry.js");
const copy = value => JSON.parse(JSON.stringify(value));
function element(tag = "div") {
  const el = { tagName: tag.toUpperCase(), children: [], events: {}, attributes: {}, className: "", textContent: "", dataset: {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener(name, fn) { this.events[name] = fn; } };
  el.classList = { add(...names) { el.className += ` ${names.join(" ")}`; }, toggle() {} };
  return el;
}
function surface(id = "wall", mode = "wall") {
  return { id, version: 3, mode, quantity: 1, fields: { mark: id, layers: 3, surface_basis: mode === "wall" ? "wall-face" : "slab-top" },
    geometry: { kind: "polygon", document_id: "doc", page: 1, points: [[10, 20], [60, 20], [60, 50], [10, 50]], exclusions: [] },
    measurement: { method: "calibrated", calibration_id: "scale" }, appearance: { display_values: true }, evidence: [] };
}
function harness() {
  const context = { window: { CeasefireTakeoffGeometry: geometry }, document: { createElement: element, createElementNS: (_, tag) => element(tag) },
    crypto, console, setTimeout, clearTimeout, Intl };
  vm.createContext(context);
  const source = fs.readFileSync("static/takeoffs.js", "utf8").replace("  window.CeasefireTakeoffs = {", `  globalThis.audit = {
    state, copyLengthMarkups, pasteLengthMarkups, planKeydown, pageDisplayKey, currentVisibilityControl, button, itemFields,
    setCommand(fn) { command = fn; }, setRenderers(fn) { renderSelection = fn; renderOverlay = fn; renderRegister = fn; }
  };\n  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const h = context.audit, snapshot = { items: [surface(), surface("floor", "slab")], calibrations: [{ id: "scale", document_id: "doc", page: 1 }],
    documents: [{ id: "doc", pages: [{ page: 1, rotation: 0, view: [0, 0, 600, 800] }] }], transfers: [] };
  Object.assign(h.state, { active: true, mode: "wall", document: "doc", page: 1, calibration: "scale", selected: new Set(["wall"]),
    viewport: { width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] }, session: { session_id: "session", revision: 2, snapshot },
    ui: { message: element(), overlay: { getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 800 }; } } } });
  h.setRenderers(() => {});
  h.state.pastePointer = { key: h.pageDisplayKey(), client: [100.125, 200.375] };
  return { ...h, context, snapshot };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("Wall and Floor surfaces share one copy group without changing saved fields or identities", () => {
  const h = harness(), before = copy(h.snapshot);
  h.state.selected.add("floor"); h.copyLengthMarkups();
  assert.deepEqual(copy(h.state.lengthClipboard), { sessionId: "session", mode: "walls_floors", area: true,
    sources: [{ item_id: "wall", version: 3 }, { item_id: "floor", version: 3 }] });
  assert.deepEqual(copy(h.snapshot), before);
  assert.match(h.state.ui.message.textContent, /Copied 2 surface markups/);
});

test("Area copying refuses manual, standalone, mixed length, off-page, hidden and unfinished selections", () => {
  for (const mutate of [
    h => { h.snapshot.items[0].measurement.method = "cited"; },
    h => { h.snapshot.items[0].purpose = "length-only"; },
    h => { h.snapshot.items[1].mode = "steel"; h.state.selected.add("floor"); },
    h => { h.snapshot.items[0].geometry.page = 2; },
    h => { h.state.hidden.add("wall"); }, h => { h.state.markupsHidden = true; },
    h => { h.state.settingsDirty = true; }, h => { h.state.points.push([1, 2]); }
  ]) { const h = harness(); mutate(h); assert.throws(h.copyLengthMarkups); assert.equal(h.state.lengthClipboard, undefined); }
});

test("Paste sends full precision pointer, current calibration and source versions, then selects new rows", async () => {
  const h = harness(), before = copy(h.snapshot), calls = [];
  h.copyLengthMarkups();
  h.setCommand(async (op, body, guard) => { assert.equal(guard(), true); calls.push({ op, ...copy(body) }); return { created_item_ids: ["new-1"] }; });
  await h.pasteLengthMarkups();
  assert.deepEqual(calls, [{ op: "duplicate_items", sources: [{ item_id: "wall", version: 3 }], document_id: "doc", page: 1,
    point: [100.125, 200.375], calibration_id: "scale" }]);
  assert.deepEqual([...h.state.selected], ["new-1"]); assert.deepEqual(copy(h.snapshot), before);
  assert.match(h.state.ui.message.textContent, /new unconfirmed surface markup.*separate register items/);
});

test("Paste rejects stale session/workspace/pointer and ambiguous or absent destination scales", async () => {
  for (const mutate of [h => { h.state.session.session_id = "other"; }, h => { h.state.mode = "steel"; },
    h => { h.state.page = 2; }, h => { h.state.pastePointer = null; }, h => { h.snapshot.calibrations = []; },
    h => { h.snapshot.calibrations.push(...["a", "b"].map(id => ({ id, document_id: "doc", page: 1, region: [0, 0, 600, 800] }))); }
  ]) { const h = harness(); h.copyLengthMarkups(); let called = false; h.setCommand(async () => { called = true; }); mutate(h);
    await assert.rejects(h.pasteLengthMarkups()); assert.equal(called, false); }
  const h = harness(); h.copyLengthMarkups(); h.setCommand(async (_op, _body, guard) => { h.state.mode = "duct"; return guard(); });
  await assert.rejects(h.pasteLengthMarkups(), /drawing or copied selection changed/);
});

test("Native text inputs and rich text retain Ctrl+C/Ctrl+V; composition and repeat do not copy areas", async () => {
  for (const key of ["c", "v"]) for (const target of [{ isContentEditable: true }, { closest() { return {}; } }]) {
    const h = harness(); h.copyLengthMarkups(); const copied = h.state.lengthClipboard;
    h.planKeydown({ key, ctrlKey: true, target, preventDefault() { assert.fail("Native editing was intercepted"); } });
    await flush(); assert.equal(h.state.lengthClipboard, copied);
  }
  for (const changes of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { altKey: true }]) {
    const h = harness(), event = { key: "c", ctrlKey: true, target: {}, preventDefault() { assert.fail("Guarded shortcut was intercepted"); }, ...changes };
    h.planKeydown(event); await flush(); assert.equal(h.state.lengthClipboard, undefined);
  }
});

test("Current-item visibility only changes presentation and refuses a stale selected item", async () => {
  const h = harness(), before = copy(h.snapshot), eye = h.currentVisibilityControl("item", "wall");
  assert.equal(eye.attributes["aria-label"], "Visibility"); assert.match(eye.className, /takeoff-visibility-button/);
  assert.equal(eye.children[0].width, 24); assert.equal(eye.children[0].height, 24);
  eye.events.click(); await flush(); assert.equal(h.state.hidden.has("wall"), true); assert.equal(h.state.hidden.has("floor"), false);
  assert.equal(eye.attributes["aria-pressed"], "true"); assert.deepEqual(copy(h.snapshot), before);
  eye.events.click(); await flush(); assert.equal(h.state.hidden.has("wall"), false);
  h.state.selected = new Set(["floor"]); eye.events.click(); await flush();
  assert.equal(h.state.hidden.has("wall"), false); assert.match(h.state.ui.message.textContent, /current item changed/);
});

test("Default control is an accessible icon while Surface basis stays in saved field definitions", () => {
  const h = harness(), control = h.button("Set as default", () => {});
  assert.equal(control.attributes["aria-label"], "Set as default"); assert.match(control.className, /takeoff-default-button/);
  assert.match(control.children[0].className, /takeoff-default-icon/);
  for (const item of h.snapshot.items) assert.ok(h.itemFields(item).some(([key]) => key === "surface_basis"));
});
