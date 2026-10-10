"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const S = require("../static/takeoff-signatures.js");
const copy = value => JSON.parse(JSON.stringify(value));
const sample = () => ({ version: 1, ratio: 3, strokes: [[[.1, .2], [.25, .75], [.9, .4]], [[.3, .4], [.8, .1]]] });

test("Vector signatures retain normalized full precision and never mutate their template", () => {
  const value = sample(), before = copy(value); value.strokes[0][0][0] = .123456789123;
  assert.equal(S.template(value), value); assert.equal(S.validateStrokes(value.strokes), value.strokes);
  const projected = S.project(value.strokes, [[10, 20], [110, 20], [110, 70], [10, 70]]);
  assert.equal(projected[0][0][0], 10 + .123456789123 * 100);
  assert.equal(projected[0][0][1], 30); assert.deepEqual(value.strokes[1], before.strokes[1]);
});

test("Malformed, unbounded, nonfinite and nonnumeric signature points are rejected", () => {
  for (const invalid of [null, [], Array.from({ length: 101 }, () => [[0, 0]]), [[]], [[[0]]], [[[0, 0, 0]]],
    [[["0", 0]]], [[[false, 0]]], [[[NaN, 0]]], [[[Infinity, 0]]], [[[-.0001, 0]]], [[[1.0001, 0]]],
    [Array.from({ length: 4001 }, () => [.2, .3])]]) assert.throws(() => S.validateStrokes(invalid));
  assert.doesNotThrow(() => S.validateStrokes([Array.from({ length: 4000 }, () => [1, 0])]));
  assert.doesNotThrow(() => S.validateStrokes(Array.from({ length: 100 }, () => [[0, 1]])));
});

test("Templates reject extra executable/image data and invalid version or aspect ratio", () => {
  for (const patch of [{ version: 2 }, { ratio: 0 }, { ratio: Infinity }, { ratio: "3" }, { ratio: .099 }, { ratio: 20.001 },
    { svg: "<script>bad()</script>" }, { image: "https://invalid.example/signature.png" }, { data: "data:image/svg+xml,bad" }]) {
    assert.throws(() => S.template({ ...sample(), ...patch }));
  }
  for (const value of [null, "signature", [], { ...sample(), strokes: [] }]) assert.throws(() => S.template(value));
  for (const ratio of [.1, 20]) assert.doesNotThrow(() => S.template({ ...sample(), ratio }));
});

test("Projection respects affine rotation while malformed destination quads are rejected", () => {
  const strokes = [[[0, 0], [1, 0], [1, 1], [0, 1], [.25, .75]]], before = copy(strokes);
  assert.deepEqual(S.project(strokes, [[100, 20], [100, 70], [70, 70], [70, 20]]),
    [[[100, 20], [100, 70], [70, 70], [70, 20], [77.5, 32.5]]]);
  assert.deepEqual(strokes, before);
  for (const quad of [null, [], [[0, 0]], [[0, 0], [1, 0], [1, 1], [0, NaN]], [[0, 0], [1, 0], [1, 1], [0, "1"]]]) assert.throws(() => S.project(strokes, quad));
});

test("Crop keeps all strokes, removes whitespace and handles a dot without division by zero", () => {
  const strokes = [[[.2, .3], [.7, .5]], [[.4, .4], [.6, .3]]], before = copy(strokes);
  const cropped = S.crop(strokes, 600, 200); assert.equal(cropped.version, 1); assert.ok(Math.abs(cropped.ratio - 7.5) < 1e-10);
  assert.deepEqual(cropped.strokes[0], [[0, 0], [1, 1]]); assert.deepEqual(strokes, before);
  const dot = S.crop([[[.25, .5]]], 620, 210); assert.deepEqual(dot.strokes, [[[0, 0]]]); assert.equal(dot.ratio, 1);
  for (const [width, height] of [[0, 200], [-1, 200], [200, -1], [Infinity, 200], [200, NaN], ["620", 210]]) assert.throws(() => S.crop(strokes, width, height));
});

test("Crop pads extreme aspect ratios while preserving the ink's physical proportions", () => {
  for (const points of [[[.1, .5], [.9, .5001]], [[.5, .1], [.5001, .9]]]) {
    const cropped = S.crop([points], 620, 210), [a, b] = cropped.strokes[0];
    const originalRatio = (points[1][0] - points[0][0]) * 620 / ((points[1][1] - points[0][1]) * 210);
    const inkRatio = (b[0] - a[0]) * cropped.ratio / (b[1] - a[1]);
    assert.ok(Math.abs(inkRatio / originalRatio - 1) < 1e-10);
    assert.ok(cropped.ratio >= .1 && cropped.ratio <= 20);
    assert.ok(b[0] < 1 || b[1] < 1, "Padding preserves the thin dimension rather than stretching ink");
  }
});

function dialogHarness(saved = null, unavailableStorage = false) {
  const store = new Map(saved ? [["ceasefire.takeoff-signature.v1", JSON.stringify(saved)]] : []);
  const root = { localStorage: { getItem(key) { if (unavailableStorage) throw new Error("Unavailable storage"); return store.get(key) ?? null; },
    setItem(key, value) { if (unavailableStorage) throw new Error("Unavailable storage"); store.set(key, value); } } };
  function element(tag) {
    const el = { tagName: tag.toUpperCase(), children: [], events: {}, attributes: {}, captures: new Set(), classList: { add() {} },
      append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); },
      setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener(name, listener) { this.events[name] = listener; },
      getBoundingClientRect() { return { left: 20, top: 40, width: 620, height: 210 }; }, setPointerCapture(id) { this.captures.add(id); },
      hasPointerCapture(id) { return this.captures.has(id); }, releasePointerCapture(id) { this.captures.delete(id); },
      showModal() { root.dialog = this; }, close(reason) { this.returnValue = reason; this.events.close?.(); }, remove() { this.removed = true; },
      getContext() { return Object.fromEntries(["clearRect", "beginPath", "lineTo", "moveTo", "stroke", "arc", "fill"].map(name => [name, () => {}])); } };
    return el;
  }
  root.document = { createElement: element, createElementNS: (_, tag) => element(tag), createTextNode: text => ({ textContent: text }), body: element("body") };
  const context = { window: root, console }; vm.createContext(context); vm.runInContext(fs.readFileSync("static/takeoff-signatures.js", "utf8"), context);
  function descendants(el = root.dialog) { return [el, ...el.children.flatMap(child => child.children ? descendants(child) : [child])]; }
  const button = name => descendants().find(el => el.tagName === "BUTTON" && el.textContent === name);
  const pad = () => descendants().find(el => el.tagName === "CANVAS");
  const event = (type, x = .2, y = .3, pointerId = 1, changes = {}) => ({ type, pointerId, button: 0, clientX: 20 + x * 620, clientY: 40 + y * 210, preventDefault() {}, ...changes });
  const draw = (points = [[.2, .3], [.6, .7], [.8, .4]]) => { const p = pad(); p.events.pointerdown(event("pointerdown", ...points[0]));
    points.slice(1).forEach(point => p.events.pointermove(event("pointermove", ...point))); p.events.pointerup(event("pointerup", ...points.at(-1))); };
  return { root, store, api: root.CeasefireTakeoffSignatures, descendants, button, pad, event, draw };
}

test("Dialog starts empty, records only owned primary pointer strokes, clears and cancels without insertion", async () => {
  const h = dialogHarness(), promise = h.api.choose(); assert.equal(h.button("Insert signature").disabled, true);
  h.pad().events.pointerdown(h.event("pointerdown", .1, .1, 9, { button: 1 })); assert.equal(h.button("Insert signature").disabled, true);
  h.pad().events.pointerdown(h.event("pointerdown", .2, .3)); h.pad().events.pointermove(h.event("pointermove", .9, .9, 2));
  assert.equal(h.pad().captures.has(1), true); h.button("Clear pad").events.click();
  assert.equal(h.pad().captures.size, 0); assert.equal(h.button("Insert signature").disabled, true);
  h.draw(); assert.equal(h.button("Insert signature").disabled, false); h.button("Cancel").events.click();
  assert.equal(await promise, null); assert.equal(h.root.dialog.removed, true); assert.equal(h.store.size, 0);
});

test("Dialog inserts a cropped bounded signature and remembers it without requiring browser storage", async () => {
  for (const unavailable of [false, true]) {
    const h = dialogHarness(null, unavailable), promise = h.api.choose(); h.draw(); h.button("Insert signature").events.click();
    const value = copy(await promise); S.template(value); assert.equal(value.strokes.length, 1); assert.equal(value.strokes[0].length, 3);
    assert.equal(h.root.dialog.removed, true); assert.equal(h.store.size, unavailable ? 0 : 1);
    if (!unavailable) assert.deepEqual(JSON.parse(h.store.get("ceasefire.takeoff-signature.v1")), value);
  }
});

test("Remember checkbox opt-out leaves an existing private template untouched", async () => {
  const original = sample(), h = dialogHarness(original), promise = h.api.choose();
  h.descendants().find(el => el.tagName === "INPUT").checked = false;
  h.draw(); h.button("Insert signature").events.click(); const inserted = copy(await promise);
  assert.notDeepEqual(inserted, original); assert.deepEqual(JSON.parse(h.store.get("ceasefire.takeoff-signature.v1")), original);
});

test("Saved preview and reuse preserve the exact template; malformed saved data has no reuse action", async () => {
  const original = sample(), h = dialogHarness(original), promise = h.api.choose();
  assert.ok(h.descendants().some(el => el.attributes["aria-label"] === "Saved signature preview"));
  h.button("Use saved signature").events.click(); assert.deepEqual(copy(await promise), original); assert.deepEqual(original, sample());
  const invalid = dialogHarness({ ...original, svg: "bad" }), other = invalid.api.choose();
  assert.equal(invalid.button("Use saved signature"), undefined); invalid.button("Cancel").events.click(); assert.equal(await other, null);
  await assert.rejects(dialogHarness().api.choose({ ...sample(), ratio: 0 }));
});

test("Pad limits disable insertion until Clear and Escape returns no signature", async () => {
  const h = dialogHarness(), promise = h.api.choose();
  for (let i = 0; i < 100; i++) h.draw([[.3, .4]]);
  h.pad().events.pointerdown(h.event("pointerdown")); assert.equal(h.button("Insert signature").disabled, true);
  assert.ok(h.descendants().some(el => /stroke limit reached/.test(el.textContent || "")));
  h.button("Clear pad").events.click(); h.pad().events.pointerdown(h.event("pointerdown", 0, 0));
  for (let i = 1; i <= 4000; i++) h.pad().events.pointermove(h.event("pointermove", i % 2, (i % 3) / 2));
  assert.equal(h.button("Insert signature").disabled, true); assert.ok(h.descendants().some(el => /point limit reached/.test(el.textContent || "")));
  h.button("Clear pad").events.click(); h.draw(); assert.equal(h.button("Insert signature").disabled, false);
  let prevented = false; h.root.dialog.events.cancel({ preventDefault() { prevented = true; } });
  assert.equal(await promise, null); assert.equal(prevented, true);
});
