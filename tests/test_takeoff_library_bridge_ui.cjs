"use strict";
// Exercise the production Takeoffs transaction/recovery functions with DOM
// display faults. No fixture server, supplier source or live draft is involved.
const fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const copy = value => JSON.parse(JSON.stringify(value));
function element() {
  return { dataset: {}, children: [], attributes: {}, disabled: false, isConnected: true,
    textContent: "", className: "", hidden: false,
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key]; },
    querySelectorAll() { return []; }, getClientRects() { return []; },
    append(...children) { this.children.push(...children); },
    addEventListener() {}, classList: { add() {}, toggle() {} } };
}
function harness() {
  const context = { console, crypto, Intl, setTimeout, clearTimeout,
    window: { CeasefireProject: { changed() {} } },
    document: { getElementById() { return null; }, createElement: element } };
  vm.createContext(context);
  const source = fs.readFileSync("static/takeoffs.js", "utf8").replace("  window.CeasefireTakeoffs = {", `
  globalThis.audit = { state, applyLibraryLink, transferConfirmedLibraryRegister, recoverLinkedOperation,
    setApi(fn) { api = fn; }, setDataRenderer(fn) { renderData = fn; } };
  window.CeasefireTakeoffs = {`);
  vm.runInContext(source, context);
  const { state } = context.audit, controls = [element(), element(), element()];
  controls[2].disabled = true;
  const root = element();
  root.querySelectorAll = selector => selector === "input,select,textarea,button" ? controls : [];
  state.ui = { root, status: element(), message: element() };
  const snapshot = { version: 2, project_id: "project", revision: 7, documents: [], items: [],
    calibrations: [], transfers: [], render_checks: [], audit_head: "a".repeat(64) };
  state.session = { session_id: "session", revision: 7, snapshot: copy(snapshot), item_results: [], issues: [] };
  state.mode = "physical";
  const capture = { draft: { globals: { allowance: 0.123456789012 }, rows: [
    { id: "retained", library_item_id: "selected", inputs: { O: 0.123456789012, T: "Manual detail" } } ] },
    configuration: { rates: { frozen: { price: 123.456789012 } } }, fingerprint: "captured", source_sha256: "source" };
  state.libraryPreviews = new Map([["preview", { capture, sessionId: "session", revision: 7, scope: "defect_reports" }]]);
  const reply = { session_id: "session", revision: 8, snapshot: { ...copy(snapshot), revision: 8 },
    item_results: [], issues: [], penetration: { source_sha256: "source", draft: copy(capture.draft) } };
  reply.penetration.draft.rows[0].inputs.O = 2.123456789012;
  const calls = [], reservations = [], releases = [], applied = [];
  let lease = null, installed = copy(capture.draft), renders = 0;
  const bridge = {
    async captureTakeoffSchedule() { return copy(capture); },
    reserveTakeoffSchedule(value) {
      assert.equal(lease, null); assert.deepEqual(copy(value), capture);
      lease = { capture: copy(value), released: false }; reservations.push(lease); return lease;
    },
    applyTakeoffSchedule(value, reservation) {
      assert.equal(reservation, lease); applied.push(copy(value)); installed = copy(value.draft);
    },
    releaseTakeoffSchedule(reservation) {
      assert.ok(reservation === lease || reservation.released && lease === null);
      releases.push(reservation); reservation.released = true; lease = null;
    }
  };
  context.window.CeasefirePenetrations = bridge;
  context.audit.setApi(async (endpoint, payload) => { calls.push({ endpoint, payload: copy(payload) }); return copy(reply); });
  context.audit.setDataRenderer(() => { ++renders; });
  return { ...context.audit, api: context.window.CeasefireTakeoffs, context, controls, root, capture, reply,
    bridge, calls, reservations, releases, applied, lease: () => lease, installed: () => copy(installed), renders: () => renders };
}
let passed = 0;
async function test(name, action) { await action(); ++passed; console.log(`ok - ${name}`); }
(async () => {
  await test("Confirmed register transfer captures and reserves the whole schedule without a quantity dialog or a selected-item preview", async () => {
    const h = harness();
    await h.transferConfirmedLibraryRegister("defect_reports");
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].endpoint, "/sessions/session/library/transfer-confirmed");
    assert.equal(h.calls[0].payload.scope, "defect_reports"); assert.equal(h.calls[0].payload.expected_revision, 7);
    assert.ok(!Object.hasOwn(h.calls[0].payload, "quantity")); assert.ok(!Object.hasOwn(h.calls[0].payload, "preview_id"));
    assert.deepEqual(h.calls[0].payload.draft, h.capture.draft); assert.deepEqual(h.calls[0].payload.configuration, h.capture.configuration);
    assert.equal(h.reservations.length, 1); assert.equal(h.releases.length, 1); assert.equal(h.applied.length, 1);
  });
  await test("Changed scope or revision during schedule capture sends no confirmed-register request", async () => {
    const h = harness();
    await assert.rejects(h.transferConfirmedLibraryRegister("service_plans"), /current physical register/);
    h.bridge.captureTakeoffSchedule = async () => { h.state.session.revision++; return copy(h.capture); };
    await assert.rejects(h.transferConfirmedLibraryRegister("defect_reports"), /project or library link changed/);
    assert.equal(h.calls.length, 0); assert.equal(h.reservations.length, 0);
  });
  await test("Uncertain confirmed-register response retries the same reserved request without creating a second contribution", async () => {
    const h = harness(); let attempts = 0;
    h.setApi(async (endpoint, payload) => { h.calls.push({ endpoint, payload: copy(payload) }); if (++attempts < 3) throw Object.assign(Error("Failed to fetch"), { uncertainOutcome: true }); return copy(h.reply); });
    await assert.rejects(h.transferConfirmedLibraryRegister("defect_reports"), /needs a response/);
    assert.ok(h.state.linkedRecovery); assert.deepEqual(h.calls[0], h.calls[1]); assert.equal(h.reservations.length, 1);
    await h.recoverLinkedOperation();
    assert.equal(h.state.linkedRecovery, null); assert.equal(h.applied.length, 1); assert.equal(h.releases.length, 1);
    assert.deepEqual(h.calls[0], h.calls[2]);
  });
  await test("Acquired destination reservation is released after synchronous Working display failure", async () => {
    const h = harness(), setAttribute = h.root.setAttribute;
    h.root.setAttribute = function (key, value) {
      if (key === "aria-busy" && value === "true") throw Error("Injected Working display failure");
      return setAttribute.call(this, key, value);
    };
    await assert.rejects(h.applyLibraryLink("preview"), /Working display failure/);
    assert.equal(h.reservations.length, 1); assert.equal(h.releases.length, 1);
    assert.equal(h.lease(), null); assert.equal(h.state.busy, false); assert.equal(h.state.linkedRecovery, undefined);
    assert.equal(h.calls.length, 0); assert.equal(h.applied.length, 0);
    assert.deepEqual(h.controls.map(control => control.disabled), [false, false, true]);
    assert.equal(h.state.session.revision, 7); assert.deepEqual(h.installed(), h.capture.draft);
  });
  await test("A control-lock failure restores every original disabled state and sends no request", async () => {
    const h = harness(); let disabled = false, fail = true;
    Object.defineProperty(h.controls[1], "disabled", { get() { return disabled; }, set(value) {
      if (value && fail) { fail = false; throw Error("Injected control lock failure"); } disabled = value;
    } });
    await assert.rejects(h.applyLibraryLink("preview"), /control lock failure/);
    assert.equal(h.reservations.length, 1); assert.equal(h.releases.length, 1);
    assert.equal(h.lease(), null); assert.equal(h.state.busy, false); assert.equal(h.state.linkedRecovery, undefined);
    assert.equal(h.calls.length, 0); assert.equal(h.applied.length, 0);
    assert.deepEqual(h.controls.map(control => control.disabled), [false, false, true]);
    assert.equal(h.state.session.revision, 7); assert.deepEqual(h.installed(), h.capture.draft);
  });
  await test("Committed reply plus release display failure retains one request and recovers without duplicate schedule writes", async () => {
    const h = harness(), release = h.bridge.releaseTakeoffSchedule; let fail = true;
    h.bridge.releaseTakeoffSchedule = reservation => {
      release(reservation);
      if (fail) { fail = false; throw Error("Injected destination release display failure"); }
    };
    await assert.rejects(h.applyLibraryLink("preview"), /release display failure/);
    const pending = h.state.linkedRecovery;
    assert.ok(pending); assert.equal(pending.responseReceived, true); assert.equal(pending.calculatorsApplied, true);
    assert.equal(h.state.busy, true); assert.equal(h.state.session.revision, 8);
    assert.throws(() => h.api.projectSnapshot(), /Recover the pending linked change/);
    await assert.rejects(h.api.prepareDefaults(), /Recover the pending linked change/);
    assert.equal(h.applied.length, 1); assert.equal(h.lease(), null);
    assert.deepEqual(h.controls.map(control => control.disabled), [true, true, true]);
    assert.deepEqual(h.installed(), h.reply.penetration.draft);
    await h.recoverLinkedOperation();
    assert.equal(h.state.linkedRecovery, null); assert.equal(h.state.busy, false);
    assert.equal(h.reservations.length, 1); assert.equal(h.applied.length, 1); assert.equal(h.releases.length, 2);
    assert.equal(h.releases[0], h.releases[1]); assert.equal(h.renders(), 2);
    assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[0], h.calls[1]);
    assert.equal(h.calls[0].endpoint, "/sessions/session/library/apply");
    assert.equal(h.calls[0].payload.expected_revision, 7); assert.equal(h.calls[0].payload.preview_id, "preview");
    assert.match(h.calls[0].payload.request_id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(h.calls[0].payload.draft, h.capture.draft);
    assert.deepEqual(h.calls[0].payload.configuration, h.capture.configuration);
    assert.deepEqual(h.installed(), h.reply.penetration.draft);
    assert.deepEqual(h.controls.map(control => control.disabled), [false, false, true]);
  });
  await test("A final Working cleanup fault keeps committed recovery blocked until exact-request retry succeeds", async () => {
    const h = harness(), setAttribute = h.root.setAttribute; let fail = true;
    h.root.setAttribute = function (key, value) {
      if (key === "aria-busy" && value === "false" && fail) { fail = false; throw Error("Injected final Working cleanup failure"); }
      return setAttribute.call(this, key, value);
    };
    await assert.rejects(h.applyLibraryLink("preview"), /final Working cleanup failure/);
    assert.ok(h.state.linkedRecovery); assert.equal(h.api.hasUnsavedChanges(), true);
    assert.throws(() => h.api.projectSnapshot(), /Recover the pending linked change/);
    await assert.rejects(h.api.prepareDefaults(), /Recover the pending linked change/);
    await assert.rejects(h.api.prepareProject(null), /Recover the pending linked change/);
    assert.throws(() => h.api.applyProject({}), /Recover the pending linked change/);
    assert.equal(h.applied.length, 1); assert.equal(h.state.session.revision, 8);
    await h.recoverLinkedOperation();
    assert.equal(h.state.linkedRecovery, null); assert.equal(h.state.busy, false);
    assert.equal(h.applied.length, 1); assert.equal(h.reservations.length, 1);
    assert.deepEqual(h.calls[0], h.calls[1]); assert.deepEqual(h.installed(), h.reply.penetration.draft);
    assert.deepEqual(h.controls.map(control => control.disabled), [false, false, true]);
  });
  console.log(`${passed} Takeoff library bridge fault/recovery contracts passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
