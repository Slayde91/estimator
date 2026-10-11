"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/takeoff-pane-resize.js"), "utf8"), context);
const { bounded, limits } = context.window.CeasefireTakeoffPaneResize;
test("wide pane leaves both rails and drawing space available", () => {
  for (const size of [701, 957, 1384, 2000]) {
    const range = limits(size);
    assert.ok(range.maximum <= 640); assert.ok(range.maximum <= size - 132 - 240);
    assert.equal(bounded(Infinity, size), Math.max(range.minimum, Math.min(300, range.maximum)));
    assert.equal(bounded(1e6, size), range.maximum); assert.equal(bounded(-1e6, size), range.minimum);
  }
});
test("narrow pane keeps both rails reachable without a negative width", () => {
  for (const size of [0, 100, 320, 390, 700]) {
    const range = limits(size), width = bounded(300, size);
    assert.ok(width >= 0); assert.ok(width <= Math.max(0, size - 132));
    assert.ok(range.minimum <= range.maximum); assert.ok(width >= range.minimum && width <= range.maximum);
  }
});
test("width preference survives useful bounds and clamps after resize", () => {
  assert.equal(bounded(475, 1384), 475); assert.equal(bounded(475, 390), 258);
  assert.equal(bounded(230, 390), 230); assert.equal(bounded(NaN, 1384), 300);
});
