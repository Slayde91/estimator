"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const { create, sources } = require("../static/header-menu-sounds.js");

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
