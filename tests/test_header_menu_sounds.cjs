"use strict";
const { verifiedPreloadCancellation } = require("./helpers/media_preload_guard.cjs");
const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const { create, sources, createFeedback, feedbackSources, createPrinting, printingSource, createDownloadSound, loadingSource } = require("../static/header-menu-sounds.js");

test("startup media cancellation requires exact request identity, delivered bytes and trusted decoding proof", () => {
  const origin = "http://127.0.0.1:54321", source = feedbackSources.selectOther, url = origin + source, sha256 = "a".repeat(64);
  const request = { stage: "initial load", method: "GET", resourceType: "media", url, failure: { errorText: "net::ERR_ABORTED" } };
  const proof = { origin, paths: [source, loadingSource], hashes: { [`static${source}`]: sha256 },
    assets: [{ url, status: 200, contentType: "audio/mpeg", sha256, bytes: 123 }],
    preloads: [{ url, error: null, readyState: 4, duration: 6, events: [{ type: "loadeddata", trusted: true }, { type: "suspend", error: null }] }] };
  assert.equal(verifiedPreloadCancellation(request, proof), true);
  for (const [clip, mime] of [[feedbackSources.explosion, "audio/wav"], [feedbackSources.checkpoint, "audio/ogg"], [printingSource, "audio/mpeg"]]) {
    const address = origin + clip;
    const typed = { ...proof, paths: [clip], hashes: { [`static${clip}`]: sha256 }, assets: [{ ...proof.assets[0], url: address, contentType: mime }], preloads: [{ ...proof.preloads[0], url: address }] };
    assert.equal(verifiedPreloadCancellation({ ...request, url: address }, typed), true);
    assert.equal(verifiedPreloadCancellation({ ...request, url: address }, { ...typed, assets: [{ ...typed.assets[0], contentType: "text/plain" }] }), false);
  }
  for (const changed of [{ stage: "drawing upload" }, { method: "POST" }, { resourceType: "fetch" },
    { url: origin + feedbackSources.hover }, { url: "http://127.0.0.1:54322" + source }, { url: url + "?other=1" },
    { failure: { errorText: "net::ERR_FAILED" } }, { failure: null }]) {
    assert.equal(verifiedPreloadCancellation({ ...request, ...changed }, proof), false, JSON.stringify(changed));
  }
  for (const changed of [{ assets: [] }, { preloads: [] }, { hashes: {} },
    ...[{ status: 404 }, { status: 500 }, { contentType: "text/html" }, { sha256: "b".repeat(64) }, { bytes: 0 }].map(change => ({ assets: [{ ...proof.assets[0], ...change }] })),
    ...[{ readyState: 0 }, { duration: NaN }, { duration: 0 }, { error: 3 }, { events: [] },
      { events: [{ type: "loadeddata", trusted: false }] },
      { events: [{ type: "loadeddata", trusted: true }, { type: "error", error: 3 }] }].map(change => ({ preloads: [{ ...proof.preloads[0], ...change }] }))]) {
    assert.equal(verifiedPreloadCancellation(request, { ...proof, ...changed }), false, JSON.stringify(changed));
  }
});

function target() {
  const events = new Map();
  return {
    disabled: false,
    addEventListener(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); },
    removeEventListener(name, listener) { events.get(name)?.delete(listener); },
    emit(name, data = {}) { for (const listener of events.get(name) || []) listener(data); },
  };
}
function harness() {
  const buttons = [target(), target(), target()], outside = target(), host = target(), players = [], operations = [];
  host.Audio = class {
    constructor() { this.readyState = 4; this.currentTime = 0; this.paused = true; players.push(this); }
    load() { operations.push(["load", this.src]); }
    pause() { this.paused = true; operations.push(["pause", this.src]); }
    play() {
      operations.push(["play", this.src, this.currentTime]); this.paused = false;
      if (this.failure === "throw") throw new Error("Decoder unavailable");
      if (this.failure === "reject") return Promise.reject(new Error("NotAllowedError"));
      if (this.failure === "pending") return new Promise((resolve, reject) => { this.reject = reject; });
      return Promise.resolve();
    }
  };
  const controller = create({ querySelectorAll(selector) { assert.equal(selector, "button"); return buttons; } }, host);
  return { buttons, outside, host, players, operations, controller, plays: () => operations.filter(([name]) => name === "play") };
}

test("preloads only the two supplied same-origin sounds, with no startup playback", () => {
  const h = harness();
  assert.deepEqual(h.players.map(player => [player.src, player.preload]), Object.values(sources).map(source => [source, "auto"]));
  assert.deepEqual(h.operations, Object.values(sources).map(source => ["load", source]));
  assert.equal(h.plays().length, 0);
});
test("pointerenter and click play synchronously once, without intercepting navigation", () => {
  const h = harness(); let navigated = false;
  h.buttons[0].addEventListener("click", () => { navigated = true; assert.equal(h.plays().at(-1)[1], sources.confirm); });
  h.buttons[0].emit("pointerenter", { pointerType: "mouse", preventDefault() { throw Error("Do not intercept navigation"); } });
  assert.deepEqual(h.plays(), [["play", sources.move, 0]]);
  h.buttons[0].emit("click"); assert.equal(navigated, true);
  assert.deepEqual(h.plays(), [["play", sources.move, 0], ["play", sources.confirm, 0]]);
  assert.equal(h.players[0].paused, true); assert.equal(h.players[1].paused, false);
});
test("all bound menu choices work; touch hover and controls outside navigation are silent", () => {
  const h = harness();
  h.outside.emit("pointerenter", { pointerType: "mouse" }); h.outside.emit("click");
  h.buttons[0].emit("pointerenter", { pointerType: "touch" }); assert.equal(h.plays().length, 0);
  for (const button of h.buttons) button.emit("click", { detail: 0 }); // Keyboard activation also uses click.
  assert.equal(h.plays().length, 3);
  h.buttons[1].disabled = true; h.buttons[1].emit("click"); h.buttons[1].emit("pointerenter", { pointerType: "pen" });
  assert.equal(h.plays().length, 3);
});
test("rapid interactions restart bounded players rather than accumulate a playback queue", () => {
  const h = harness();
  for (let index = 0; index < 50; index++) {
    h.players[0].currentTime = 0.8;
    h.buttons[index % 3].emit("pointerenter", { pointerType: "mouse" });
  }
  assert.equal(h.players.length, 2); assert.equal(h.plays().length, 50);
  assert.ok(h.plays().every(([, source, time]) => source === sources.move && time === 0));
});
test("native seeking readiness changes do not suppress a loaded clip's immediate restart", () => {
  const h = harness(), audio = h.players[0]; let time = 0.2;
  Object.defineProperty(audio, "currentTime", { get() { return time; }, set(value) { time = value; audio.readyState = 1; } });
  h.buttons[0].emit("pointerenter", { pointerType: "mouse" });
  assert.equal(audio.readyState, 1, "Rewinding models the native temporary metadata-only state");
  assert.deepEqual(h.plays(), [["play", sources.move, 0]], "Readiness is established before seeking and play remains in the current event");
  assert.equal(h.players[1].readyState, 4, "An unused clip already at zero is not needlessly sought");
});
test("hover pauses the previous confirmation without seeking away its readiness for the next click", () => {
  const h = harness(), confirm = h.players[1]; let time = 0;
  Object.defineProperty(confirm, "currentTime", { get() { return time; }, set(value) { time = value; confirm.readyState = 1; } });
  h.buttons[0].emit("click"); time = 0.5;
  h.buttons[1].emit("pointerenter", { pointerType: "mouse" });
  assert.equal(confirm.paused, true); assert.equal(confirm.currentTime, 0.5); assert.equal(confirm.readyState, 4, "An unrelated hover does not start a seek on confirmation audio");
  h.buttons[1].emit("click");
  assert.deepEqual(h.plays().map(([, source]) => source), [sources.confirm, sources.move, sources.confirm]);
  assert.equal(h.plays().at(-1)[2], 0, "The next confirmation restarts synchronously in its own click");
});

test("unloaded and broken audio are discarded instead of queued for readiness or a later gesture", async () => {
  const h = harness(); h.players[0].readyState = 0;
  h.buttons[0].emit("pointerenter", { pointerType: "mouse" });
  h.players[0].readyState = 4; h.players[0].emit?.("canplay");
  await Promise.resolve(); assert.equal(h.plays().length, 0);
  h.buttons[0].emit("click"); assert.deepEqual(h.plays(), [["play", sources.confirm, 0]]);
  h.players[0].error = {}; h.buttons[0].emit("pointerenter", { pointerType: "mouse" });
  assert.equal(h.plays().length, 1);
});
test("blocked playback is handled, never replayed on a later click or focus", async () => {
  const h = harness(); h.players[0].failure = "reject";
  h.buttons[0].emit("pointerenter", { pointerType: "mouse" }); await Promise.resolve();
  assert.equal(h.players[0].paused, true);
  h.buttons[0].emit("focusin"); h.buttons[0].emit("click"); await Promise.resolve();
  assert.deepEqual(h.plays().map(([, source]) => source), [sources.move, sources.confirm]);
});
test("a stale rejected attempt cannot interrupt a newer sound; synchronous decoder errors stay local", async () => {
  const h = harness(); h.players[0].failure = "pending";
  h.buttons[0].emit("pointerenter", { pointerType: "mouse" });
  h.buttons[1].emit("click"); h.players[0].reject(new Error("Old blocked attempt")); await Promise.resolve();
  assert.equal(h.players[1].paused, false);
  h.players[1].failure = "throw"; assert.doesNotThrow(() => h.buttons[1].emit("click"));
  assert.equal(h.players[1].paused, true);
});
test("pagehide stops playback and explicit close removes the listeners", () => {
  const h = harness(); h.buttons[0].emit("click"); h.host.emit("pagehide");
  assert.ok(h.players.every(player => player.paused));
  h.buttons[0].emit("click"); assert.equal(h.plays().length, 2, "A restored page keeps fresh interactions available");
  h.controller.close(); h.buttons[0].emit("click"); h.buttons[0].emit("pointerenter", { pointerType: "mouse" });
  assert.equal(h.plays().length, 2); assert.ok(h.players.every(player => player.paused));
  assert.doesNotThrow(() => create(null, null).close());
  assert.doesNotThrow(() => create({ querySelectorAll() { throw Error("Unavailable audio needs no binding"); } }, {}).close());
});
test("the exact supplied MP3 bytes are retained and the module is loaded before app navigation", () => {
  const supplied = {
    "mgs1-menu-move.mp3": [8313, "ac2d686c78fa5dabc2415a0f3b39f4ced124f5fc1613ba3918e06daa7b47f8d0"],
    "mgs-confirm2.mp3": [32391, "e9e7e156e24a4fde706f922ee135e88df51dc5ba94eed6344e66bbd6298e3e86"],
  };
  for (const [name, [size, digest]] of Object.entries(supplied)) {
    const bytes = fs.readFileSync(path.join(__dirname, "../static/sounds", name));
    assert.equal(bytes.length, size); assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.equal((html.match(/<script src="\/header-menu-sounds\.js" defer><\/script>/g) || []).length, 1);
  assert.ok(html.indexOf('src="/header-menu-sounds.js"') < html.indexOf('src="/app.js"'));
});

function audioHarness() {
  const host = target(), document = target(), motion = target(), players = [], calls = [];
  document.hidden = false; document.takeoffsActive = false;
  document.body = { classList: { contains(name) { assert.equal(name, "takeoffs-active"); return document.takeoffsActive; } } };
  motion.matches = false;
  host.Audio = class {
    constructor() { Object.assign(this, target()); this.readyState = 4; this.currentTime = 0; this.paused = true; players.push(this); }
    load() { calls.push(["load", this.src]); }
    pause() { this.paused = true; }
    play() {
      calls.push(["play", this.src, this.currentTime]); this.paused = false;
      if (this.failure === "throw") throw Error("Decoder failure");
      if (this.failure === "reject") return Promise.reject(Error("NotAllowedError"));
      if (this.failure === "pending") return new Promise((resolve, reject) => { this.reject = reject; });
      return Promise.resolve();
    }
  };
  const menu = { calls: [], stops: 0, play(kind) { this.calls.push(kind); }, stop() { this.stops++; } };
  return { host, document, motion, players, calls, menu, plays: () => calls.filter(row => row[0] === "play") };
}
function element(parent, { control = false, zone = "", brand = false } = {}) {
  return {
    parentElement: parent, control, zone, brand, disabled: false, fieldsetDisabled: false, inert: false, attributes: {},
    matches(selector) { assert.equal(selector, ":disabled"); return this.fieldsetDisabled; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if ((selector.startsWith("button,") && node.control)
          || (selector === ".app-header .brand" && node.brand)
          || (selector === ".app-header" && node.zone === "header")
          || (selector === "#view-home" && node.zone === "home")
          || (selector === "#view-takeoffs" && node.zone === "takeoff")
          || (selector === "#takeoff-viewport" && node.zone === "drawing")
          || (selector === ".takeoff-control-menu" && node.zone === "drawing-menu")
          || (selector === 'dialog, [role="dialog"]' && node.zone === "dialog")
          || (selector === "[inert]" && node.inert)) return node;
      }
      return null;
    },
  };
}

test("delegated feedback covers dynamic buttons, icons and button-like links once in the current event", () => {
  const h = audioHarness(), controller = createFeedback(h.document, h.host, h.menu);
  assert.equal(h.players.length, 5); assert.equal(h.plays().length, 0);
  const button = element(null, { control: true }), icon = element(button), label = element(button);
  h.document.emit("pointerover", { target: icon, pointerType: "mouse", relatedTarget: null });
  h.document.emit("pointerover", { target: label, pointerType: "mouse", relatedTarget: icon });
  assert.deepEqual(h.plays(), [["play", feedbackSources.hover, 0]]);
  h.document.emit("click", { target: icon, detail: 0, preventDefault() { throw Error("Do not delay the action"); } });
  assert.equal(h.plays().at(-1)[1], feedbackSources.selectOther);
  const dynamic = element(null, { control: true });
  h.document.emit("click", { target: dynamic });
  assert.equal(h.plays().length, 3); assert.equal(h.players.length, 5);
  assert.ok(h.menu.stops >= 3, "Ordinary buttons stop the previous header/Home clip");
  controller.close(); h.document.emit("click", { target: dynamic });
  assert.equal(h.plays().length, 3); assert.ok(h.players.every(player => player.paused));
});

test("stationary replacement hover leaves the clicked tab's selection playing, including rounded click coordinates", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const old = element(null, { control: true }), replacement = element(null, { control: true });
  const pointer = { clientX: 438.35, clientY: 498.12, pointerId: 1, pointerType: "mouse", isTrusted: true };
  h.document.emit("pointerover", { ...pointer, target: old });
  h.document.emit("pointermove", { ...pointer, target: old });
  h.document.emit("click", { target: old, clientX: 438, clientY: 498, detail: 1 });
  const select = h.players.find(player => player.src === feedbackSources.selectOther);
  select.currentTime = 0.1;
  const count = h.plays().length, stops = h.menu.stops;
  // A replacement still interrupted selection when its hover clip was unready.
  h.players.find(player => player.src === feedbackSources.hover).readyState = 0;
  h.document.emit("pointerover", { ...pointer, target: element(null) });
  h.document.emit("pointerover", { ...pointer, target: replacement });
  assert.equal(h.plays().length, count); assert.equal(h.menu.stops, stops, "No replacement hover reaches routing");
  assert.equal(select.paused, false); assert.equal(select.currentTime, 0.1);
});

test("real neighbouring movement and leaving then returning to the same position retain immediate hover", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const first = element(null, { control: true }), next = element(null, { control: true });
  const pointer = { clientX: 10.5, clientY: 20.25, pointerId: 1, pointerType: "mouse" };
  h.document.emit("pointerover", { ...pointer, target: first });
  h.document.emit("click", { target: first });
  h.document.emit("pointerover", { ...pointer, clientX: 40.5, target: next, relatedTarget: first });
  assert.deepEqual(h.plays().map(row => row[1]), [feedbackSources.hover, feedbackSources.selectOther, feedbackSources.hover]);
  h.document.emit("pointermove", { ...pointer, clientX: 80.5, target: element(null) });
  h.document.emit("pointerover", { ...pointer, target: first, relatedTarget: next });
  assert.equal(h.plays().length, 4, "Returning to an earlier coordinate follows actual movement");
  h.document.emit("pointerover", { ...pointer, clientX: 11.5, target: element(first), relatedTarget: first });
  assert.equal(h.plays().length, 4, "Nested icon/label boundaries are still one entry");
});

test("keyboard clicks do not overwrite the resting pointer and missing coordinates keep legacy hover routing", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const first = element(null, { control: true }), replacement = element(null, { control: true });
  const pointer = { clientX: 10.75, clientY: 20.5, pointerId: 1, pointerType: "mouse" };
  h.document.emit("pointerover", { ...pointer, target: first });
  h.document.emit("click", { target: replacement, detail: 0, clientX: 0, clientY: 0 });
  h.document.emit("pointerover", { ...pointer, target: replacement });
  assert.deepEqual(h.plays().map(row => row[1]), [feedbackSources.hover, feedbackSources.selectOther]);
  assert.equal(h.players.find(player => player.src === feedbackSources.selectOther).paused, false);
  h.document.emit("pointerover", { target: first, pointerType: "mouse" });
  h.document.emit("pointerover", { target: replacement, pointerType: "mouse" });
  assert.equal(h.plays().length, 4, "Coordinate-free compatibility events are not suppressed");
  h.document.emit("pointerover", { ...pointer, pointerId: 2, target: first });
  h.document.emit("pointerover", { ...pointer, pointerId: 2, pointerType: "pen", target: replacement });
  assert.equal(h.plays().length, 6, "A different pointer is a new entry even at the same coordinate");
});

test("only leaving the document clears stationary pointer history; blur, visibility and pagehide also reset it", () => {
  for (const reset of ["leave", "blur", "hidden", "pagehide"]) {
    const h = audioHarness(), controller = createFeedback(h.document, h.host, h.menu);
    h.document.documentElement = element(null);
    const old = element(null, { control: true }), replacement = element(null, { control: true });
    const pointer = { clientX: 10.5, clientY: 20.5, pointerId: 1, pointerType: "mouse" };
    h.document.emit("pointerover", { ...pointer, target: old }); h.document.emit("click", { target: old });
    h.document.emit("pointerleave", { ...pointer, target: old });
    h.document.emit("pointerover", { ...pointer, target: replacement });
    assert.equal(h.plays().length, 2, "Leaving a removed child does not erase the physical position");
    if (reset === "leave") h.document.emit("pointerleave", { target: h.document.documentElement });
    if (reset === "blur") h.host.emit("blur");
    if (reset === "hidden") { h.document.hidden = true; h.document.emit("visibilitychange"); h.document.hidden = false; }
    if (reset === "pagehide") h.host.emit("pagehide");
    h.document.emit("pointerover", { ...pointer, target: old });
    assert.equal(h.plays().length, 3, `${reset} allows a fresh entry at the same position`);
    controller.close(); h.document.emit("pointermove", { ...pointer, clientX: 50 }); h.document.emit("pointerover", { ...pointer, target: replacement });
    assert.equal(h.plays().length, 3); assert.ok(h.players.every(player => player.paused));
  }
});

test("stationary drawing boundaries still stop feedback and keep explicit drawing-menu commands usable", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const pane = element(null, { control: true }), drawing = element(null, { zone: "drawing" });
  const pointer = { clientX: 10.5, clientY: 20.5, pointerId: 1, pointerType: "mouse" };
  h.document.emit("pointerover", { ...pointer, target: pane }); h.document.emit("click", { target: pane });
  h.document.emit("pointerover", { ...pointer, target: drawing });
  assert.ok(h.players.every(player => player.paused));
  const command = element(element(drawing, { zone: "drawing-menu" }), { control: true });
  h.document.emit("pointerover", { ...pointer, target: command });
  assert.equal(h.plays().at(-1)[1], feedbackSources.hover);
});

test("Home shares header clips, while the logo, Takeoff controls and other-page controls remain distinct", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const homeButton = element(element(null, { zone: "home" }), { control: true });
  h.document.emit("pointerover", { target: homeButton, pointerType: "mouse" }); h.document.emit("click", { target: homeButton });
  assert.deepEqual(h.menu.calls, ["move", "confirm"]); assert.equal(h.plays().length, 0);
  const header = element(null, { zone: "header" }), headerButton = element(header, { control: true });
  h.document.emit("pointerover", { target: headerButton, pointerType: "mouse" }); h.document.emit("click", { target: headerButton });
  assert.equal(h.plays().length, 0); assert.equal(h.menu.calls.length, 2, "Header direct listeners remain the only owner");
  const logo = element(element(header, { brand: true })); h.document.emit("click", { target: logo });
  assert.equal(h.plays().at(-1)[1], feedbackSources.explosion); assert.equal(h.menu.calls.length, 2);
  const takeoff = element(element(null, { zone: "takeoff" }), { control: true }); h.document.emit("click", { target: takeoff });
  assert.equal(h.plays().at(-1)[1], feedbackSources.select);
  const outsideDialogButton = element(element(null, { zone: "dialog" }), { control: true }); h.document.takeoffsActive = true;
  h.document.emit("click", { target: outsideDialogButton }); assert.equal(h.plays().at(-1)[1], feedbackSources.select);
  h.document.takeoffsActive = false; h.document.emit("click", { target: outsideDialogButton });
  assert.equal(h.plays().at(-1)[1], feedbackSources.selectOther);
  h.document.emit("click", { target: element(null, { control: true }) });
  assert.equal(h.plays().at(-1)[1], feedbackSources.selectOther, "A calculator hub card outside #view-home uses normal feedback");
});

test("PDF drawing hits and handles are silent while pane and explicit context-menu buttons keep Takeoff feedback", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const takeoff = element(null, { zone: "takeoff" }), drawing = element(takeoff, { zone: "drawing" });
  const pane = element(takeoff, { control: true });
  h.document.emit("click", { target: pane });
  assert.equal(h.plays().at(-1)[1], feedbackSources.select);
  // SVG hits and nested handles expose role=button for editing accessibility.
  // The event target, rather than a particular shape/handle class, owns silence.
  for (const hit of [drawing, element(drawing, { control: true }), element(element(drawing, { control: true }))]) {
    const before = h.plays().length;
    h.document.emit("pointerover", { target: hit, pointerType: "mouse" });
    assert.ok(h.players.every(player => player.paused), "Entering the drawing stops previous feedback");
    h.document.emit("click", { target: hit, detail: 0 });
    assert.equal(h.plays().length, before, "Mouse and keyboard drawing edits never request a clip");
  }
  const command = element(element(drawing, { zone: "drawing-menu" }), { control: true });
  h.document.emit("pointerover", { target: command, pointerType: "pen" });
  assert.equal(h.plays().at(-1)[1], feedbackSources.hover);
  h.document.emit("click", { target: element(command) });
  assert.equal(h.plays().at(-1)[1], feedbackSources.select, "An explicit drawing context command remains a button action");
  h.document.emit("pointerover", { target: drawing, pointerType: "touch" });
  assert.ok(h.players.every(player => player.paused), "A touch entering the drawing also stops prior tool feedback");
  h.document.emit("pointerover", { target: pane, pointerType: "mouse" });
  h.document.emit("click", { target: pane });
  assert.deepEqual(h.plays().slice(-2).map(row => row[1]), [feedbackSources.hover, feedbackSources.select], "Returning to a tool pane restores ordinary feedback");
});

test("disabled, inert and touch-hover controls stay silent; hidden pages stop their feedback", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const button = element(null, { control: true });
  h.document.emit("pointerover", { target: button, pointerType: "touch" });
  for (const kind of ["disabled", "fieldsetDisabled", "aria", "inert"]) {
    button.disabled = kind === "disabled"; button.fieldsetDisabled = kind === "fieldsetDisabled";
    button.attributes["aria-disabled"] = kind === "aria" ? "true" : "false"; button.inert = kind === "inert";
    h.document.emit("pointerover", { target: button, pointerType: "pen" }); h.document.emit("click", { target: button });
  }
  assert.equal(h.plays().length, 0);
  button.inert = false; h.document.emit("click", { target: button }); assert.equal(h.plays().length, 1);
  h.document.hidden = true; h.document.emit("visibilitychange"); assert.ok(h.players.every(player => player.paused));
  h.document.emit("click", { target: button }); assert.equal(h.plays().length, 1);
  h.document.hidden = false; h.document.emit("click", { target: button }); h.host.emit("pagehide");
  assert.equal(h.plays().length, 2); assert.ok(h.players.every(player => player.paused));
});

test("ordinary feedback never queues unloaded audio or replays rejected interactions", async () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  const button = element(null, { control: true }), hover = h.players.find(player => player.src === feedbackSources.hover);
  hover.readyState = 0; h.document.emit("pointerover", { target: button, pointerType: "mouse" });
  hover.readyState = 4; hover.emit("canplay"); assert.equal(h.plays().length, 0);
  const select = h.players.find(player => player.src === feedbackSources.selectOther); select.failure = "reject";
  h.document.emit("click", { target: button }); await Promise.resolve(); assert.equal(select.paused, true);
  hover.emit("canplay"); assert.equal(h.plays().length, 1);
  select.failure = "pending"; h.document.emit("click", { target: button });
  h.document.emit("pointerover", { target: button, pointerType: "mouse" }); select.reject(Error("Old attempt")); await Promise.resolve();
  assert.equal(hover.paused, false, "A stale select rejection cannot stop the latest hover");
});

test("the global Save button owns one immediate checkpoint click on every page", () => {
  const h = audioHarness(); createFeedback(h.document, h.host, h.menu);
  for (const zone of ["", "home", "header", "takeoff"]) {
    const button = element(element(null, { zone }), { control: true }); button.id = "save-current-project";
    const icon = element(button), before = h.plays().length, menuBefore = h.menu.calls.length;
    h.document.emit("click", { target: icon, detail: 0 });
    assert.equal(h.plays().length, before + 1);
    assert.equal(h.plays().at(-1)[1], feedbackSources.checkpoint);
    assert.equal(h.menu.calls.length, menuBefore, "No header/Home confirmation is emitted by delegated Save");
    button.disabled = true; h.document.emit("click", { target: icon });
    assert.equal(h.plays().length, before + 1, "Disabled Save stays silent");
  }
});

test("download loading has one preloaded loop with independent, idempotent operation tokens", () => {
  const h = audioHarness(), sound = createDownloadSound(h.host), audio = h.players[0];
  assert.equal(audio.src, loadingSource); assert.equal(audio.loop, true); assert.equal(audio.preload, "auto");
  assert.equal(h.plays().length, 0);
  const first = sound.begin(); assert.equal(h.plays().length, 1); assert.equal(audio.paused, false);
  const second = sound.begin(); assert.equal(h.players.length, 1); assert.equal(h.plays().length, 1);
  first(); first(); assert.equal(audio.paused, false, "Finishing the older file keeps the second file audible");
  second(); assert.equal(audio.paused, true); assert.equal(audio.currentTime, 0);
  audio.emit("canplay"); assert.equal(h.plays().length, 1, "A completed operation cannot restart later");
  const third = sound.begin(); assert.equal(h.plays().length, 2);
  h.host.emit("pagehide"); assert.equal(audio.paused, true); third(); sound.begin(); audio.emit("canplay");
  assert.equal(h.plays().length, 2, "Leaving the page invalidates every remaining token");
});

test("download readiness and blocked/stale attempts cannot outlive the file they belong to", async () => {
  const h = audioHarness(), sound = createDownloadSound(h.host), audio = h.players[0];
  audio.readyState = 0; const finished = sound.begin(); finished(); audio.readyState = 4; audio.emit("canplay");
  assert.equal(h.plays().length, 0);
  audio.readyState = 0; const waiting = sound.begin(); audio.readyState = 4; audio.emit("canplay"); audio.emit("canplay");
  assert.equal(h.plays().length, 1, "Decoding may start only a still-pending download"); waiting();
  audio.failure = "pending"; const old = sound.begin(), reject = audio.reject; old();
  audio.failure = undefined; const current = sound.begin(); reject(Error("Old blocked attempt")); await Promise.resolve();
  assert.equal(audio.paused, false, "A stale rejection cannot stop the new file's loop"); current();
  audio.failure = "reject"; const blocked = sound.begin(); await Promise.resolve();
  const count = h.plays().length; audio.emit("canplay"); assert.equal(h.plays().length, count);
  assert.equal(audio.paused, true, "Blocked playback is not queued for a later gesture"); blocked();
  audio.failure = "throw"; assert.doesNotThrow(() => sound.begin()()); assert.equal(audio.paused, true);
  assert.doesNotThrow(() => createDownloadSound(null).begin()());
});

test("printer audio loops only during the active phrase and never starts after it has finished", () => {
  const h = audioHarness(), printer = createPrinting(h.motion, h.host, h.document), audio = h.players[0];
  assert.equal(audio.src, printingSource); assert.equal(audio.loop, true); assert.equal(audio.preload, "auto"); assert.equal(h.plays().length, 0);
  printer.start(); assert.equal(h.plays().length, 1); assert.equal(audio.paused, false);
  printer.stop(); assert.equal(audio.paused, true); assert.equal(audio.currentTime, 0);
  audio.readyState = 0; printer.start(); assert.equal(h.plays().length, 1);
  printer.stop(); audio.readyState = 4; audio.emit("canplay"); assert.equal(h.plays().length, 1, "Readiness after finish cannot replay the phrase");
  audio.readyState = 0; printer.start(); audio.readyState = 4; audio.emit("canplay"); audio.emit("canplay");
  assert.equal(h.plays().length, 2, "A still-printing phrase can start once when decoded");
  printer.stop(); printer.start(); assert.equal(h.plays().length, 3, "A replacement phrase restarts its loop");
});

test("printer blocks stale promises, reduced motion, hidden documents and pagehide without changing typing", async () => {
  const h = audioHarness(), printer = createPrinting(h.motion, h.host, h.document), audio = h.players[0];
  audio.failure = "pending"; printer.start(); const reject = audio.reject;
  audio.failure = undefined; printer.start(); reject(Error("Old blocked phrase")); await Promise.resolve(); assert.equal(audio.paused, false);
  h.motion.matches = true; h.motion.emit("change", { matches: true }); assert.equal(audio.paused, true);
  printer.start(); assert.equal(h.plays().length, 2); h.motion.matches = false;
  printer.start(); h.document.hidden = true; h.document.emit("visibilitychange"); assert.equal(audio.paused, true);
  h.document.hidden = false; audio.emit("canplay"); assert.equal(h.plays().length, 3, "Unhiding does not revive a cancelled phrase");
  audio.failure = "reject"; printer.start(); await Promise.resolve(); audio.emit("canplay");
  assert.equal(h.plays().length, 4); assert.equal(audio.paused, true, "A blocked phrase has no gesture replay");
  audio.failure = undefined; printer.start(); h.host.emit("pagehide"); printer.start(); audio.emit("canplay");
  assert.equal(h.plays().length, 5); assert.equal(audio.paused, true);
  assert.doesNotThrow(() => createPrinting(null, null).start()); assert.doesNotThrow(() => createFeedback(null, null).close());
});

test("supplied feedback assets and the trimmed logo clip retain verified bytes", () => {
  const supplied = {
    // The existing served logo slot contains the exact supplied flame_whoosh.mp3.
    "new-explosion.mp3": [161332, "42de6e27397a942bda71b98b9b564c6a4543ebe88473fac35c10e1335099a1b4"],
    "flame-whoosh.wav": [736916, "988f40b00194f865d8ca84ef30d0d3b882c08a25a8597a9ebe2aa54524ab966b"],
    "type.mp3": [149760, "0a78627d0f914dd96d222afcc27e06c8d7777a2d219cef872e8f56a16dcb1c14"],
    "hover.mp3": [5015, "052d0d7f3fb41ddb67766dedd8f4c237b46c8b18745dfad0a73a14c8afb6fad5"],
    "select.mp3": [11520, "60e089eeac138ce5301fb59dc9d649c0404a556499c8f78c15c81a7cdfde1969"],
    "select-2.mp3": [192768, "37e5c8645aa76e11dc8039545940436ea9201e533b1c946fbc9dfc3845efeb7b"],
    "mixkit-vintage-dot-printing-1371.wav": [249332, "5c39082dfe0aa5c24cae5faa0ba616bfb1354d8b7686b0b0784fa32689a9decf"],
    "checkpoint.ogg": [39539, "60acfb941abf427378e87e7ae6660ae29491f8d5efaae2681d7eb9a52af3c935"],
    "loading.mp3": [649508, "2c245208c0a4e9668b36e17d16227be81f6409398de1ece8b37be648e0ac60a8"],
  };
  for (const [name, [size, digest]] of Object.entries(supplied)) {
    const bytes = fs.readFileSync(path.join(__dirname, "../static/sounds", name));
    assert.equal(bytes.length, size); assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
});

test("the preloaded logo PCM begins with audible signal instead of the supplied silent lead", () => {
  assert.equal(feedbackSources.explosion, "/sounds/flame-whoosh.wav");
  assert.equal(printingSource, "/sounds/type.mp3");
  const wav = fs.readFileSync(path.join(__dirname, "../static/sounds/flame-whoosh.wav"));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 44100); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  let firstPeak = 0;
  for (let i = 44; i < 44 + 441 * 4; i += 2) firstPeak = Math.max(firstPeak, Math.abs(wav.readInt16LE(i)) / 32768);
  assert.ok(firstPeak >= .01, "The first 10 ms contains a signal peak above -40 dBFS");
  assert.equal((wav.length - 44) / 4, 184218, "Only the measured leading 38,118 frames were removed");
});
