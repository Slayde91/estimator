"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const shortcuts = require("../static/takeoff-shortcuts.js"), geometry = require("../static/takeoff-geometry.js");
const copy = value => JSON.parse(JSON.stringify(value));
function control() { return { attributes: {}, dataset: {}, clicks: 0, disabled: false, hidden: false, classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = String(value); }, closest() { return this.ancestorHidden || null; }, matches() { return !!this.fieldsetDisabled; }, click() { this.clicks++; } }; }
function keyEvent(key, changes = {}) { return { key, ctrlKey: true, target: { closest() { return null; } }, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...changes }; }
function harness() {
  const window = { CeasefireTakeoffGeometry: geometry, CeasefireTakeoffShortcuts: shortcuts };
  const context = { window, document: { createElement() { return { getContext() { return { measureText(value) { return { width: value.length * 6 }; } }; } }; } }, crypto, console, setTimeout, clearTimeout };
  vm.createContext(context);
  let source = fs.readFileSync("static/takeoffs.js", "utf8").replace("  window.CeasefireTakeoffs = {", `  globalThis.audit = { state, eligibleLegendItems, canToggleLegend, updatePresentationTools, toggleLegend, syncToolShortcuts, setCommand(fn) { command = fn; }, setRenderer(fn) { renderOverlay = fn; } };\n  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const state = context.audit.state;
  state.active = true; state.document = "doc"; state.viewport = { transform: [1, 0, 0, 1, 0, 0], width: 600, height: 800 };
  state.ui = { tools: Object.fromEntries(Object.keys(shortcuts.actions).map(name => [name, control()])), target: { value: "steel_vermiculite" } };
  state.session = { session_id: "session", snapshot: { documents: [{ id: "doc", pages: [{ page: 1 }] }, { id: "other", pages: [{ page: 1 }] }], items: [], transfers: [] } };
  context.audit.setRenderer(() => {});
  return { ...context.audit, context, snapshot: state.session.snapshot };
}
const line = (id = "length") => ({ id, mode: "steel", quantity: 1, fields: { mark: "B1", section: "360UB45" }, geometry: { kind: "polyline", document_id: "doc", page: 1, points: [[10.123456789, 20], [40, 20]] }, measurement: { method: "cited", length_m: 6.123456789 }, appearance: { stroke_color: "#FF3300" } });
let passed = 0;
async function check(label, run) { await run(); passed++; console.log(`ok - ${label}`); }
(async () => {
  await check("Every shared action has one unique shortcut while editing and browser letters/digits keep their bindings", () => {
    const keys = Object.values(shortcuts.actions).map(value => value.key.toLowerCase());
    assert.equal(new Set(keys).size, keys.length); assert.notEqual(shortcuts.actions.count.key, shortcuts.actions.callout.key);
    assert.equal(shortcuts.actions.upload, undefined); assert.equal(shortcuts.actions.viewport.key, "\\");
    const controls = Object.fromEntries(Object.keys(shortcuts.actions).map(name => [name, control()]));
    for (const [name, action] of Object.entries(shortcuts.actions)) {
      shortcuts.decorate(controls[name], name); assert.equal(controls[name].title, `${action.label} (Ctrl+${action.key})`); assert.equal(controls[name].attributes["aria-keyshortcuts"], `Control+${action.key}`);
      const event = keyEvent(action.key); assert.equal(shortcuts.dispatch(event, controls), true); assert.equal(controls[name].clicks, 1); assert.ok(event.prevented && event.stopped);
    }
    for (const key of "abcdefghijklmnopqrstuvwxyz0123456789+-") { const event = keyEvent(key); assert.equal(shortcuts.dispatch(event, controls), false); assert.equal(event.prevented, undefined); }
  });
  await check("Native fields, rich text, composition, modal operations and unavailable controls cannot trigger tools", () => {
    const button = control(), controls = { callout: button }, key = shortcuts.actions.callout.key;
    for (const changes of [{ ctrlKey: false }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { target: { isContentEditable: true } }, { target: { closest() { return {}; } } }]) assert.equal(shortcuts.dispatch(keyEvent(key, changes), controls), false);
    assert.equal(shortcuts.dispatch(keyEvent(key), controls, true), false);
    for (const property of ["disabled", "hidden", "ancestorHidden", "fieldsetDisabled"]) { button[property] = true; assert.equal(shortcuts.dispatch(keyEvent(key), controls), false); button[property] = false; }
    assert.equal(button.clicks, 0); assert.equal(shortcuts.dispatch(keyEvent(key), controls), true); assert.equal(button.clicks, 1);
  });
  await check("Viewer rotation/page/zoom keys are distinct, scoped callbacks and preserve native editing/composition guards", () => {
    const tools = Object.values(shortcuts.actions).map(action => action.key.toLowerCase()), viewer = Object.values(shortcuts.viewerActions).map(action => action.key.toLowerCase());
    assert.equal(new Set([...tools, ...viewer]).size, tools.length + viewer.length);
    const calls = [], callbacks = Object.fromEntries(Object.keys(shortcuts.viewerActions).map(name => [name, () => calls.push(name)]));
    for (const [name, definition] of Object.entries(shortcuts.viewerActions)) {
      const event = keyEvent(definition.key); assert.equal(shortcuts.dispatchViewer(event, callbacks), true); assert.equal(calls.at(-1), name); assert.ok(event.prevented && event.stopped);
    }
    for (const event of [keyEvent('=', { shiftKey: true }), keyEvent('+', { shiftKey: true }), keyEvent('=')]) { assert.equal(shortcuts.dispatchViewer(event, callbacks), true); assert.equal(calls.at(-1), 'zoomIn'); }
    const count = calls.length;
    for (const changes of [{ ctrlKey: false }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { target: { isContentEditable: true } }, { target: { closest() { return {}; } } }]) assert.equal(shortcuts.dispatchViewer(keyEvent('ArrowUp', changes), callbacks), false);
    assert.equal(shortcuts.dispatchViewer(keyEvent('ArrowUp'), callbacks, true), false);
    assert.equal(shortcuts.dispatchViewer(keyEvent('ArrowLeft'), { previousPage: null }), false, 'Unavailable boundary navigation keeps its guard');
    assert.equal(shortcuts.dispatchViewer(keyEvent('ArrowUp'), {}), false, 'No callbacks outside the viewer');
    assert.equal(calls.length, count);
  });
  await check("Physical Call-out uses its distinct binding and switching back restores Count tooltip", () => {
    const h = harness(), count = h.state.ui.tools.count, free = h.state.ui.tools.callout;
    let controls = h.syncToolShortcuts(); assert.equal(controls.count, count); assert.equal(controls.callout, free); assert.equal(count.title, "Count (Ctrl+F3)");
    h.state.mode = "physical"; controls = h.syncToolShortcuts(); assert.equal(controls.count, null); assert.equal(controls.callout, count); assert.equal(count.title, "Call-out (Ctrl+')"); assert.equal(shortcuts.dispatch(keyEvent("F3"), controls), false); assert.equal(shortcuts.dispatch(keyEvent("'"), controls), true);
    h.state.mode = "duct"; h.syncToolShortcuts(); assert.equal(count.title, "Count (Ctrl+F3)");
  });
  await check("Legend creation requires a current visible supported Length or Count and refreshes on page/document/hide changes", () => {
    const h = harness(), item = line(); h.snapshot.items = [item]; const before = copy(h.snapshot);
    h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, false);
    for (const changed of [() => { h.state.document = "other"; }, () => { h.state.page = 2; }, () => { h.state.mode = "wall"; }, () => { h.state.hidden.add(item.id); }, () => { h.state.markupsHidden = true; }, () => { h.state.busy = true; }]) {
      changed(); h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, true);
      Object.assign(h.state, { document: "doc", page: 1, mode: "steel", markupsHidden: false, busy: false }); h.state.hidden.clear();
    }
    item.geometry.kind = "polygon"; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, true);
    item.geometry.kind = "count-only"; delete item.measurement; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, false);
    h.snapshot.items = []; h.snapshot.annotations = { version: 1, entries: [{ id: "free", document_id: "doc", page: 1 }] }; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, true);
    delete h.snapshot.annotations; h.snapshot.items = before.items; assert.deepEqual(copy(h.snapshot), before);
  });
  await check("Deleting the last item keeps visible Legend removable and undo/hidden restore enables creation", async () => {
    const h = harness(), item = line(); h.snapshot.items = [item]; const original = copy(h.snapshot.items), sent = [];
    h.setCommand(async (op, body, guard) => { if (guard) guard(); sent.push({ op, ...copy(body) }); h.snapshot.drawing_presentation = { version: 1, colour_modes: [], legends: [copy(body.legend)] }; });
    await h.toggleLegend(); assert.equal(sent[0].op, "set_legend"); const dimensions = [sent[0].legend.width, sent[0].legend.height], id = sent[0].legend.id;
    h.snapshot.items = []; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, false); await h.toggleLegend(); assert.equal(sent[1].legend.visible, false); assert.equal(sent[1].legend.id, id); assert.deepEqual([sent[1].legend.width, sent[1].legend.height], dimensions);
    h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, true); await assert.rejects(h.toggleLegend(), /Length or Count/);
    h.snapshot.items = original; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, false);
    h.state.hidden.add(item.id); h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, true); h.state.hidden.clear(); await h.toggleLegend(); assert.equal(sent.at(-1).legend.id, id); assert.deepEqual(h.snapshot.items, original);
    h.state.markupsHidden = true; h.updatePresentationTools(); assert.equal(h.state.ui.tools.legend.disabled, false); await h.toggleLegend(); assert.equal(sent.at(-1).legend.visible, false);
  });
  await check("Legend async guard rejects creation after eligible markups disappear without touching coordinates or quantities", async () => {
    const h = harness(); h.snapshot.items = [line()]; const original = copy(h.snapshot.items);
    h.setCommand(async (_op, _body, guard) => { h.state.hidden.add("length"); guard(); });
    await assert.rejects(h.toggleLegend(), /eligible Length or Count/); assert.deepEqual(copy(h.snapshot.items), original); assert.equal(h.snapshot.drawing_presentation, undefined);
  });
  await check("Call-out asset is the exact original additional attachment", () => {
    const bytes = fs.readFileSync("static/icons/takeoff-callout.png"); assert.equal(bytes.length, 3650); assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "068c58a46525a2618709cb4c77056214a9b1f4ff289d4785e1db8b7f50c9c8dd");
  });
  console.log(`${passed} shortcut and Legend checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
