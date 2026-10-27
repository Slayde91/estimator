"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../static/games/overspray.js");

const point = (x, y, down = true, clicked = false) => ({ pointer: { x, y, down, clicked, inside: true } });
function hold(game, x, y, seconds, down = true, fps = 60) {
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) game.update(1 / fps, point(x, y, down));
}
function line(game, x1, y1, x2, y2, speed, compensateWind = false) {
  const frames = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / speed * 60);
  for (let i = 0; i < frames; i++) {
    const t = game.snapshot().metrics.elapsed;
    const wind = compensateWind && t % 24 >= 17 && t % 24 < 23 ? (Math.floor(t / 24) % 2 ? -42 : 42) : 0;
    game.update(1 / 60, point(x1 + (x2 - x1) * i / frames - wind, y1 + (y2 - y1) * i / frames));
  }
}
function workshop(game) {
  game.action("start");
  line(game, 240, 193, 720, 193, 100);
  line(game, 720, 428, 240, 428, 100);
  line(game, 480, 220, 480, 400, 85);
  game.action("finish");
}
function carPark(game) {
  game.action("start");
  line(game, 240, 193, 715, 193, 90);
  line(game, 307, 235, 307, 495, 90);
  line(game, 647, 235, 647, 495, 90);
  line(game, 354, 326, 601, 326, 95);
  game.action("finish");
}

test("prep is untimed, covers are limited, reversible and block damage", () => {
  const covered = create({ seed: 3 }), bare = create({ seed: 3 });
  hold(covered, 800, 220, 10);
  assert.equal(covered.snapshot().metrics.elapsed, 0);
  assert.equal(covered.snapshot().metrics.material, 0);
  covered.update(0, point(800, 220, false, true));
  covered.update(0, point(180, 380, false, true));
  covered.update(0, point(600, 130, false, true));
  assert.equal(covered.snapshot().metrics.masks, 2);
  covered.update(0, point(180, 380, false, true));
  assert.equal(covered.snapshot().metrics.masks, 1);
  covered.action("start"); bare.action("start");
  hold(covered, 800, 220, 1); hold(bare, 800, 220, 1);
  assert.equal(covered.snapshot().metrics.damage, 0);
  assert.ok(bare.snapshot().metrics.damage > 1);
  assert.equal(covered.snapshot().metrics.material, bare.snapshot().metrics.material);
  assert.ok(covered.snapshot().metrics.waste > 0, "spray caught by covers still consumes material");
  covered.update(0, point(800, 220, false, true));
  assert.equal(covered.snapshot().metrics.masks, 1, "covers cannot be moved mid-job");
});

test("coating accumulates spatially, lingering overbuilds and inspection is non-destructive", () => {
  const game = create(); game.action("start");
  hold(game, 480, 300, 0.9);
  const initial = game.snapshot().metrics;
  assert.ok(initial.coverage > 0);
  game.action("inspect");
  assert.equal(game.snapshot().metrics.inspection, true);
  assert.equal(game.snapshot().metrics.coverage, initial.coverage);
  assert.equal(game.snapshot().metrics.material, initial.material);
  hold(game, 480, 300, 3);
  assert.ok(game.snapshot().metrics.excessive > initial.excessive);
  game.action("finish");
  assert.equal(game.snapshot().result.eligible, false);
  assert.equal(game.snapshot().result.score, 0);
  game.action("next");
  assert.equal(game.snapshot().metrics.job, 0, "a failed coat cannot skip to the next contract");
});

test("narrow fan gives control around a steel edge and consumes less material", () => {
  const wide = create(), narrow = create(); wide.action("start"); narrow.action("nozzle"); narrow.action("start");
  hold(wide, 480, 300, 0.3); hold(narrow, 480, 300, 0.3);
  assert.ok(narrow.snapshot().metrics.material < wide.snapshot().metrics.material);
  assert.equal(narrow.snapshot().metrics.waste, 0);
  assert.ok(wide.snapshot().metrics.waste > 0);
  hold(narrow, 480, 300, 2);
  assert.ok(narrow.snapshot().metrics.waste > 0, "lingering wastes material through excessive build even without overspray");
  narrow.update(0, { pressed: new Set(["KeyN", "KeyI", "KeyC"]) });
  assert.equal(narrow.snapshot().metrics.narrow, false);
  assert.equal(narrow.snapshot().metrics.inspection, true);
  assert.equal(narrow.snapshot().metrics.cleanup, true);
});

test("overspray generates escalating emails; cleanup lowers damage but costs time", () => {
  const game = create(); game.action("start");
  hold(game, 800, 220, 3);
  const painted = game.snapshot().metrics;
  assert.ok(painted.complaints > 0);
  assert.ok(game.snapshot().messages.some(message => /Site office|Builder/.test(message)));
  game.action("cleanup"); hold(game, 800, 220, 3);
  const cleaned = game.snapshot().metrics;
  assert.ok(cleaned.damage < painted.damage);
  assert.ok(cleaned.cleanupSeconds >= 2.99);
  assert.ok(cleaned.elapsed > painted.elapsed);
  assert.equal(cleaned.material, painted.material);
  assert.equal(cleaned.waste, painted.waste, "cleanup cannot recover spent material");
});

test("timer and material exhaustion end the job, and finished results do not keep ticking", () => {
  const timed = create(); timed.action("start"); hold(timed, 50, 300, 71, false);
  assert.equal(timed.snapshot().phase, "result");
  assert.equal(timed.snapshot().metrics.elapsed, 70);
  assert.equal(timed.snapshot().result.won, false);
  const empty = create(); empty.action("start"); hold(empty, 50, 300, 40);
  assert.equal(empty.snapshot().phase, "result");
  assert.equal(empty.snapshot().metrics.material, 55);
  const end = empty.snapshot(); hold(empty, 480, 300, 30);
  assert.deepEqual(empty.snapshot(), end);
  empty.action("retry");
  assert.equal(empty.snapshot().phase, "masking");
  assert.equal(empty.snapshot().metrics.material, 0);
});

test("simulation outcomes are stable across frame rates and invalid time cannot advance it", () => {
  const a = create({ seed: 11 }), b = create({ seed: 11 }); a.action("start"); b.action("start");
  hold(a, 480, 300, 2, true, 60); hold(b, 480, 300, 2, true, 30);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const before = a.snapshot().metrics.elapsed;
  a.update(NaN); a.update(-10); a.update(Infinity);
  assert.equal(a.snapshot().metrics.elapsed, before);
});

test("three jobs can be qualified through ordinary controlled spray paths and earnings accumulate", () => {
  const game = create({ seed: 9 });
  workshop(game);
  const first = game.snapshot().result;
  assert.equal(first.won, true); assert.ok(first.score > 0);
  game.action("next"); assert.equal(game.snapshot().metrics.job, 1);
  carPark(game);
  const second = game.snapshot().result;
  assert.equal(second.won, true);
  assert.equal(second.campaignTotal, first.earnings + second.earnings);
  game.action("next"); game.action("start");
  line(game, 205, 195, 740, 195, 90, true);
  line(game, 272, 235, 272, 495, 90, true);
  line(game, 672, 235, 672, 495, 90, true);
  line(game, 320, 322, 625, 322, 95, true);
  line(game, 320, 442, 625, 442, 95, true);
  game.action("finish");
  const final = game.snapshot();
  assert.equal(final.result.won, true);
  assert.equal(final.result.campaignTotal, first.earnings + second.earnings + final.result.earnings);
  assert.ok(!final.actions.some(action => action.id === "next"));
  game.action("restart");
  assert.equal(game.snapshot().metrics.job, 0);
  assert.equal(game.snapshot().phase, "masking");
});

test("supervisor arrival and wind warning precede the corresponding hazards", () => {
  const game = create(); workshop(game); game.action("next"); game.action("start");
  hold(game, 660, 480, 42, false);
  hold(game, 660, 480, 5);
  assert.ok(game.snapshot().metrics.utePaint > 0);
  game.action("retry"); // Only a finished job can be retried.
  game.action("finish"); game.action("retry");
  carPark(game); game.action("next"); game.action("start");
  hold(game, 400, 550, 15, false);
  assert.match(game.snapshot().subtitle, /WIND WARNING/);
  hold(game, 400, 550, 3, false);
  assert.match(game.snapshot().subtitle, /CROSSWIND/);
});

test("canvas drawing is self-contained for preparation, spraying, inspection and results", () => {
  let rectangles = 0, labels = [];
  const ctx = new Proxy({
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect() { rectangles++; },
    fillText(value) { labels.push(value); }
  }, { get(target, key) { return key in target ? target[key] : () => {}; }, set(target, key, value) { target[key] = value; return true; } });
  const game = create(); game.draw(ctx);
  game.action("start"); hold(game, 480, 300, 1); game.draw(ctx);
  game.action("inspect"); game.draw(ctx); game.action("finish"); game.draw(ctx);
  assert.ok(rectangles > 100);
  assert.ok(labels.includes("REWORK REQUIRED"));
  assert.ok(labels.some(label => label.startsWith("● GOOD")));
});
