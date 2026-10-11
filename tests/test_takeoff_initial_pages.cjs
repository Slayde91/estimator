"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const G = require("../static/takeoff-geometry.js");
const source = path.resolve(__dirname, "../static/takeoff-initial-pages.js");
const code = fs.readFileSync(source, "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

// Only the integration module runs. Controlled chooser/command promises have no
// DOM, storage, network, calculator or persisted Takeoff side effects.
function fixture() {
  const chooser = deferred(), reply = deferred(), tasks = [], listeners = new Map();
  const calls = { cancel: 0, choose: 0, writes: [], errors: [], messages: [], selection: 0 };
  let captured = null, ui;
  const element = {
    addEventListener(type, fn) { assert.equal(listeners.has(type), false); listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    setPointerCapture(pointer) { captured = pointer; },
    hasPointerCapture(pointer) { return captured === pointer; },
    releasePointerCapture(pointer) { assert.equal(captured, pointer); captured = null; listeners.get("lostpointercapture")?.(event([0, 0], { pointerId: pointer })); }
  };
  const state = { tool: "select", modal: false, busy: false, gesture: null,
    viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
    document: "source-A", page: 1, mode: "wall", physicalScope: "defect_reports", rotation: 0,
    session: { session_id: "session-A", revision: 7 }, points: [],
    annotationSelected: "retained-callout", signatureSelected: "retained-ink", graphicSelected: "retained-box" };
  Object.defineProperty(state, "ui", { value: { overlay: element }, enumerable: false });
  const documents = [{ id: "source-A", sha256: "a".repeat(64) }, { id: "source-B", sha256: "b".repeat(64) }];
  const authorities = { items: [{ id: "retained-item", quantity: 3 }], transfers: [{ id: "retained-transfer" }], physical: { version: 2 }, calibrations: [{ id: "retained-scale" }] };
  const context = { window: {} }; vm.createContext(context); vm.runInContext(code, context, { filename: source });
  ui = context.window.CeasefireTakeoffInitialPages({ state, G,
    S: { chooseInitial() { calls.choose++; return chooser.promise; } },
    currentDocument: () => documents.find(value => value.id === state.document),
    pageMetadata: () => ({ view: [0, 0, 600, 800], rotation: 0 }), pageRotation: () => state.rotation,
    pageDisplayKey: () => JSON.stringify([state.session?.session_id, state.document, state.page, state.rotation]),
    signatureMode: () => state.mode === "physical" ? state.physicalScope : state.mode,
    drawingPoint: value => value.pdf, flushSettings: async () => {},
    requireFinishedEdits() { if (state.gesture || state.points.length) throw new Error("Finish the newer drawing first."); },
    cancelTrace() { calls.cancel++; ui.cancel(); state.points = []; state.tool = "select"; },
    setTool(value) { state.tool = value; },
    async command(op, body, guard) {
      assert.equal(op, "initial_pages"); assert.equal(guard(), true, "Dispatch is bound to the selected source and revision");
      calls.writes.push(plain(body)); calls.guard = guard;
      const result = await reply.promise;
      if (result) state.session.revision++;
      return result;
    },
    safely(fn) { const task = Promise.resolve().then(fn).catch(error => { calls.errors.push(error.message); }); tasks.push(task); return task; },
    message(value) { calls.messages.push(value); }, renderOverlay() {}, renderSelection() { calls.selection++; },
    svg: (tag, attributes) => ({ tag, attributes })
  });
  async function releaseArea(from = [120, 600], to = [360, 400]) {
    assert.equal(ui.begin(event(from)), true); assert.equal(captured, 11);
    listeners.get("pointermove")(event(to)); listeners.get("pointerup")(event(to));
    assert.equal(state.gesture, null); assert.equal(captured, null); assert.equal(listeners.size, 0);
    await Promise.resolve(); await Promise.resolve();
  }
  const settle = async () => { await Promise.all(tasks); assert.deepEqual(calls.errors, []); };
  return { state, calls, chooser, reply, ui, authorities, listeners, releaseArea, settle, captured: () => captured };
}
function event(pdf, extra = {}) { return { pdf, pointerId: 11, button: 0, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra }; }
const chosen = { name: "TN", signature: { version: 1, ratio: 2, strokes: [[[0, 0], [1, 1]]] } };
async function openChooser(f) { await f.ui.activate(); await f.releaseArea(); assert.equal(f.calls.choose, 1); assert.equal(f.state.modal, true); }
async function dispatch(f) { f.chooser.resolve(chosen); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.calls.writes.length, 1); }
function newerDrawing(f) { f.ui.cancel(); f.state.tool = "polygon"; f.state.points = [[17, 23]]; f.state.annotationSelected = "new-callout"; f.state.signatureSelected = "new-ink"; f.state.graphicSelected = "new-box"; }
function drawingState(f) { return plain({ tool: f.state.tool, points: f.state.points, annotation: f.state.annotationSelected, signature: f.state.signatureSelected, graphic: f.state.graphicSelected }); }

test("Current Initial Pages cancellation closes only its own chooser without a command", async () => {
  const f = fixture(), authority = plain(f.authorities); await openChooser(f);
  f.chooser.resolve(null); await f.settle();
  assert.equal(f.state.tool, "select"); assert.equal(f.state.modal, false);
  assert.equal(f.calls.cancel, 2); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.selection, 0);
  assert.deepEqual(f.authorities, authority);
});

test("Current Initial Pages reply advances the revision and finishes one PDF-only placement", async () => {
  const f = fixture(), authority = plain(f.authorities); await openChooser(f); await dispatch(f);
  assert.deepEqual(f.calls.writes[0].initials, { mode: "wall", document_id: "source-A", source_sha256: "a".repeat(64), page: 1,
    normalized_box: [.2, .25, .4, .25], display_rotation: 0, text: "TN", strokes: chosen.signature.strokes, signature_ratio: 2, text_appearance: {}, signature_appearance: {} });
  f.reply.resolve({ initial_pages_count: 4 }); await f.settle();
  assert.equal(f.state.session.revision, 8, "A successful command legitimately advances its captured revision");
  assert.equal(f.state.tool, "select"); assert.equal(f.calls.cancel, 2); assert.equal(f.calls.selection, 1);
  assert.equal(f.state.annotationSelected, null); assert.equal(f.state.signatureSelected, null); assert.equal(f.state.graphicSelected, null);
  assert.match(f.calls.messages.at(-1), /4 pages.*Undo/); assert.deepEqual(f.authorities, authority);
});

test("Cancelling a captured Initial Pages drag releases its handlers without showing a chooser", async () => {
  const f = fixture(); await f.ui.activate(); f.ui.begin(event([120, 600]));
  assert.equal(f.listeners.size, 4); f.ui.cancel(); f.state.tool = "select";
  assert.equal(f.state.gesture, null); assert.equal(f.captured(), null); assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.choose, 0); assert.equal(f.calls.writes.length, 0);
});

test("A late cancelled Initial Pages chooser cannot clear a newer tool or drawing", async () => {
  const f = fixture(); await openChooser(f); newerDrawing(f); const retained = drawingState(f), cancels = f.calls.cancel;
  f.chooser.resolve(null); await f.settle();
  assert.deepEqual(drawingState(f), retained); assert.equal(f.calls.cancel, cancels); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.selection, 0);
});

for (const [name, change] of [["page", s => s.page = 2], ["source", s => s.document = "source-B"], ["workspace", s => s.mode = "duct"], ["revision", s => s.session.revision++]]) {
  test(`A late accepted Initial Pages chooser cannot write after its ${name} changes`, async () => {
    const f = fixture(); await openChooser(f); change(f.state); const retained = drawingState(f), cancels = f.calls.cancel;
    f.chooser.resolve(chosen); await f.settle();
    assert.deepEqual(drawingState(f), retained); assert.equal(f.calls.cancel, cancels); assert.equal(f.calls.writes.length, 0);
  });
}

test("A late Initial Pages command reply cannot clear a newer tool, points or selections", async () => {
  const f = fixture(); await openChooser(f); await dispatch(f); newerDrawing(f);
  const retained = drawingState(f), cancels = f.calls.cancel;
  f.reply.resolve({ initial_pages_count: 4 }); await f.settle();
  assert.deepEqual(drawingState(f), retained); assert.equal(f.calls.cancel, cancels); assert.equal(f.calls.selection, 0);
  assert.equal(f.calls.writes.length, 1, "The already-dispatched edit is not submitted twice");
});

test("A late Initial Pages reply cannot reset selection on a different page with the same tool", async () => {
  const f = fixture(); await openChooser(f); await dispatch(f); f.state.page = 2; f.state.graphicSelected = "page-two-box";
  const retained = drawingState(f), cancels = f.calls.cancel;
  f.reply.resolve({ initial_pages_count: 4 }); await f.settle();
  assert.deepEqual(drawingState(f), retained); assert.equal(f.calls.cancel, cancels); assert.equal(f.calls.selection, 0);
});

test("An exact page-edge selection stays inside the server normalized rectangle contract", async () => {
  const f = fixture(); await f.ui.activate(); await f.releaseArea([.06, 700], [600, 0]); await dispatch(f);
  const [x, y, width, height] = f.calls.writes[0].initials.normalized_box;
  assert.ok(.06 / 600 + (600 - .06) / 600 > 1, "This fixture exposes floating point edge overshoot in uncapped ratios");
  assert.ok([x, y, width, height].every(Number.isFinite)); assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
  assert.ok(x + width <= 1 && y + height <= 1, "A complete visible-page area must pass strict backend edge validation");
  assert.equal(x + width, 1); assert.equal(y + height, 1);
  f.reply.resolve({ initial_pages_count: 4 }); await f.settle();
});

test("A changed viewport transform invalidates a captured area before any chooser or command", async () => {
  const f = fixture(); await f.ui.activate(); f.ui.begin(event([120, 600]));
  f.state.viewport.transform = [2, 0, 0, -2, 0, 1600]; f.listeners.get("pointerup")(event([360, 400]));
  await f.settle(); assert.equal(f.state.gesture, null); assert.equal(f.captured(), null); assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.choose, 0); assert.equal(f.calls.writes.length, 0);
});

test("A too-small selection leaves no gesture and allows a later valid area", async () => {
  const f = fixture(); await f.ui.activate(); await f.releaseArea([120, 600], [122, 598]);
  assert.equal(f.calls.choose, 0); assert.equal(f.calls.writes.length, 0); assert.match(f.calls.messages.at(-1), /larger area/);
  await f.releaseArea(); f.chooser.resolve(null); await f.settle(); assert.equal(f.calls.choose, 1); assert.equal(f.state.tool, "select");
});
