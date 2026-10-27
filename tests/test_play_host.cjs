"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { STORAGE_KEY, readScores, recordScore } = require("../static/games/play.js");
test("scores use a separate bounded namespace and malformed storage is harmless", () => {
  assert.equal(STORAGE_KEY, "classifire.play.v2");
  for (const raw of ["null", "[]", "broken", '{"fireline":{"best":-1,"runs":"10","wins":9e100}}']) {
    assert.deepEqual(readScores({ getItem: () => raw }), { fireline: { best: 0, runs: 0, wins: 0 } });
  }
  assert.equal(readScores({getItem() { throw Error("denied"); }}).fireline.best, 0);
});
test("only qualified finite scores can improve a personal best", () => {
  let scores = readScores({ getItem: () => null });
  scores = recordScore(scores, "fireline", { won: true, eligible: true, score: 1250.8 });
  assert.deepEqual(scores.fireline, { best: 1250, runs: 1, wins: 1 });
  const before = JSON.stringify(scores);
  const next = recordScore(scores, "fireline", { won: false, eligible: false, score: 999999 });
  assert.equal(next.fireline.best, 1250); assert.equal(JSON.stringify(scores), before);
  assert.equal(recordScore(next, "fireline", { eligible: true, score: Infinity }).fireline.best, 1250);
  assert.deepEqual(recordScore(scores, "__proto__", { eligible: true, score: 12 }), scores);
});
test("removed game scores and unknown game ids cannot enter the new leaderboard", () => {
  const scores = readScores({ getItem: () => '{"overspray":{"best":4000,"runs":2,"wins":2},"fireline":{"best":900,"runs":1,"wins":1}}' });
  assert.deepEqual(Object.keys(scores), ["fireline"]);
  assert.deepEqual(recordScore(scores, "overspray", { won: true, eligible: true, score: 9999 }), scores);
});
