"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { expect } = require("@playwright/test");
const source = fs.readFileSync(path.resolve(__dirname, "browser/signatures.cjs"), "utf8");
const read = source.slice(source.indexOf("async function snapshot() {"), source.indexOf("\nasync function command("));
const busy = "Finish the current takeoff operation before saving.";

function fixture(projectSnapshot, evaluate) {
  const context = { window: { CeasefireTakeoffs: { projectSnapshot } },
    page: { evaluate: evaluate || (async callback => callback()) },
    expect: { poll: callback => expect.poll(callback, { timeout: 80, intervals: [1] }) } };
  vm.createContext(context);
  vm.runInContext(read + "\nglobalThis.capture = snapshot;", context);
  return context.capture;
}

test("signature fixture returns its exact ready snapshot without a second read", async () => {
  let calls = 0;
  const expected = { signatures: { records: [{ id: "retained-signature" }] } };
  const capture = fixture(() => {
    calls++;
    if (calls === 1) throw new Error(busy);
    if (calls === 2) return expected;
    throw new Error("Readiness/read gap reopened the operation");
  });
  assert.equal(await capture(), expected);
  assert.equal(calls, 2);
});

test("signature fixture preserves unexpected application and transport errors", async () => {
  for (const transport of [false, true]) {
    let calls = 0;
    const failure = new Error(transport ? "Page closed unexpectedly" : "Unexpected source failure");
    const fail = () => { calls++; throw failure; };
    const capture = fixture(transport ? () => ({}) : fail, transport ? fail : null);
    await assert.rejects(capture(), error => error === failure);
    assert.equal(calls, 1, "Unexpected errors are not retried or hidden");
  }
});

test("signature fixture times out when the real operation guard never settles", async () => {
  let calls = 0;
  const capture = fixture(() => { calls++; throw new Error(busy); });
  await assert.rejects(capture(), /timeout|Timeout/i);
  assert.ok(calls > 1);
});
