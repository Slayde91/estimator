"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { STORAGE_KEY, readScores, recordScore } = require("../static/games/play.js");
test("scores use a separate bounded namespace and malformed storage is harmless", () => {
  assert.equal(STORAGE_KEY, "classifire.play.v1");
  for (const raw of ["null", "[]", "broken", '{"overspray":{"best":-1,"runs":"10","wins":9e100}}']) {
    assert.deepEqual(readScores({ getItem: () => raw }), { overspray: { best: 0, runs: 0, wins: 0 }, fireline: { best: 0, runs: 0, wins: 0 } });
  }
  assert.equal(readScores({getItem() { throw Error("denied"); }}).fireline.best, 0);
});
test("only qualified finite scores can improve a personal best", () => {
  let scores = readScores({ getItem: () => null });
  scores = recordScore(scores, "overspray", { won: true, eligible: true, score: 1250.8 });
  assert.deepEqual(scores.overspray, { best: 1250, runs: 1, wins: 1 });
  const before = JSON.stringify(scores);
  const next = recordScore(scores, "overspray", { won: false, eligible: false, score: 999999 });
  assert.equal(next.overspray.best, 1250); assert.equal(JSON.stringify(scores), before);
  assert.equal(recordScore(next, "fireline", { eligible: true, score: Infinity }).fireline.best, 0);
  assert.deepEqual(recordScore(scores, "__proto__", { eligible: true, score: 12 }), scores);
});
