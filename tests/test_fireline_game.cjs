"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../static/games/fireline.js");

const quiet = () => ({ keys: new Set(), pressed: new Set(), pointer: { x: 480, y: 100, down: false, inside: true } });
function advance(game, seconds, input = quiet()) { for (let t = 0; t < seconds - 1e-8; t += 1 / 60) game.update(Math.min(1 / 60, seconds - t), { ...input, pressed: t === 0 ? input.pressed : new Set() }); }
function active(seed = 42) { const g = create({ seed }); g.action("start"); return g; }
function walk(game, key, seconds) { advance(game, seconds, { ...quiet(), keys: new Set([key]) }); }
function firing(game, x = 480, y = 550) { return { ...quiet(), pointer: { x, y, down: true, inside: true } }; }

test("briefing and upgrade/result screens do not advance the game; inspection is a copy", () => {
  const g = create(); const initial = g.inspect(); advance(g, 10, firing(g));
  assert.deepEqual(g.inspect(), initial);
  const copy = g.inspect(); copy.player.health = 0; copy.fires[0].heat = 3;
  assert.equal(g.inspect().player.health, 100); assert.equal(g.inspect().fires[0].heat, 0);
  g.action("missing"); assert.equal(g.snapshot().phase, "brief");
});

test("movement is normalized and the central building and arena walls are solid", () => {
  const a = active(), b = active(); walk(a, "KeyD", .5);
  advance(b, .5, { ...quiet(), keys: new Set(["KeyD", "KeyS"]) });
  const pa = a.inspect().player, pb = b.inspect().player;
  assert.ok(Math.abs((pa.x - 480) - Math.hypot(pb.x - 480, pb.y - 448)) < .1);
  const blocked = active(); walk(blocked, "KeyW", 1);
  assert.ok(blocked.inspect().player.y >= 389, "player must not walk through building");
  walk(a, "KeyD", 4); assert.ok(a.inspect().player.x <= 924);
});

test("pressure drains while spraying, recovers released, and a held shot cannot freeze it below zero", () => {
  const g = active(); advance(g, 2, firing(g)); assert.ok(g.inspect().player.pressure < 55);
  const low = g.inspect().player.pressure; advance(g, 1); assert.ok(g.inspect().player.pressure > low + 28);
  advance(g, 8, firing(g)); assert.ok(g.inspect().player.pressure >= 0 && g.inspect().player.pressure <= 100);
  const offCanvas = active(); advance(offCanvas, 1, { ...quiet(), pointer: { x: 480, y: 550, down: true, inside: false } });
  assert.equal(offCanvas.inspect().player.pressure, 100);
});

test("dash gives a bounded movement burst and cooldown; a long frame cannot teleport", () => {
  const g = active(); const input = { ...quiet(), keys: new Set(["KeyD"]), pressed: new Set(["Space"]) };
  advance(g, .2, input); const p = g.inspect().player;
  assert.ok(p.x > 580 && p.x < 610); assert.ok(p.dashCooldown > 1.8);
  const x = p.x; g.update(999, input); assert.ok(g.inspect().player.x - x < 20);
  g.update(NaN, input); assert.ok(Number.isFinite(g.inspect().player.x));
});

test("foam is aimed, lands and consumes one charge per key press", () => {
  const g = active(); const input = { ...quiet(), pressed: new Set(["KeyQ"]), pointer: { x: 650, y: 448, down: false, inside: true } };
  g.update(.1, input); assert.equal(g.inspect().player.foam, 2); // Shift starts with three.
  advance(g, .6); const state = g.inspect();
  assert.equal(state.zones.length, 1); assert.ok(Math.abs(state.zones[0].x - 650) < 1); assert.equal(state.shells.length, 0);
  assert.ok(state.zones[0].life > 7);
});

test("foam extinguishes a real enemy ignition and grants suppression charge", () => {
  const g = active(3); advance(g, 10);
  const original = g.inspect().fires.find(f => f.heat > 0); assert.ok(original);
  g.update(1 / 60, { ...quiet(), pointer: { x: original.x, y: original.y, down: false, inside: true }, pressed: new Set(["KeyQ"]) });
  advance(g, 1.5); const s = g.inspect(), extinguished = s.fires.find(f => f.x === original.x && f.y === original.y);
  assert.equal(extinguished.heat, 0); assert.ok(s.suppressed > .5); assert.ok(s.player.overdrive > 1);
});

test("uncontrolled fires visibly warn before spreading into a neighbouring cell", () => {
  const g = active(3); let warning;
  for (let t = 0; t < 55 && !warning; t += .1) { g.update(.1, quiet()); warning = g.inspect().fires.find(f => f.warning > 0); }
  assert.ok(warning, "mature fires must telegraph spread"); assert.equal(warning.heat, 0);
  advance(g, 3.2); const ignited = g.inspect().fires.find(f => f.x === warning.x && f.y === warning.y);
  assert.ok(ignited.heat > 0); assert.equal(ignited.warning, 0);
});

test("barricades require a nearby breach, and repair/deploy spends bounded supplies", () => {
  const g = active(); g.action("barricade"); assert.equal(g.inspect().barriers[2].hp, 110);
  const supplies = g.inspect().player.supplies; g.action("barricade"); assert.equal(g.inspect().player.supplies, supplies);
  walk(g, "KeyD", 1.1); g.action("barricade"); assert.equal(g.inspect().player.supplies, supplies);
  assert.equal(g.inspect().sealed, 1);
});

test("deploying while standing in a breach cannot trap the player or spend supplies", () => {
  const g = active(); walk(g, "KeyS", 26 / 60);
  const before = g.inspect(); assert.ok(before.player.y > 520 && before.player.y < 527);
  g.action("barricade"); const blocked = g.inspect();
  assert.equal(blocked.barriers[2].hp, 0); assert.equal(blocked.player.supplies, before.player.supplies);
  assert.match(blocked.radio.at(-1), /Step clear/);
  walk(g, "KeyW", .25); assert.ok(g.inspect().player.y < before.player.y - 40, "the player can leave the opening");
  g.action("barricade"); assert.ok(g.inspect().barriers[2].hp > 0, "sealing works once safely beside it");
});

test("a sealed breach physically delays an attacker while its barricade takes damage", () => {
  const g = active(1000); g.action("barricade"); advance(g, 6.5); const s = g.inspect();
  const attacker = s.enemies.find(e => e.gate === 2); assert.ok(attacker); assert.ok(attacker.y > 540);
  assert.ok(s.barriers[2].hp > 0 && s.barriers[2].hp < s.barriers[2].max); assert.equal(s.player.health, 100);
});

test("enemies and fires progress while idle, and defeat stops the simulation until a fresh retry", () => {
  const g = active(3); advance(g, 10); const early = g.inspect();
  assert.ok(early.enemies.length > 0); assert.ok(early.fires.some(f => f.heat > 0));
  advance(g, 180); assert.equal(g.snapshot().phase, "result"); assert.equal(g.snapshot().result.won, false);
  const terminal = g.inspect(); advance(g, 10, firing(g)); assert.deepEqual(g.inspect(), terminal);
  g.action("retry"); assert.equal(g.inspect().wave, 1); assert.equal(g.inspect().player.health, 100); assert.equal(g.inspect().time, 0);
});

test("the seed and inputs reproduce the same enemy positions, hazards and scores", () => {
  const a = active(123), b = active(123), c = active(124);
  for (const g of [a, b, c]) advance(g, 14, firing(g, 660, 500));
  assert.deepEqual(a.inspect(), b.inspect()); assert.notDeepEqual(a.inspect().enemies, c.inspect().enemies);
});

// This input-only pilot uses the same public controls as a player. It is not a
// state injection: it must survive fire, choose upgrades and defeat the boss.
function clearLine(a, b) {
  for (let t = 0; t <= 1; t += .04) { const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t; if (x > 380 && x < 580 && y > 210 && y < 390) return false; }
  return true;
}
function route(from, to) {
  const nodes = [from, { x: 345, y: 175 }, { x: 615, y: 175 }, { x: 615, y: 425 }, { x: 345, y: 425 }, to];
  const costs = [0, Infinity, Infinity, Infinity, Infinity, Infinity], previous = [], done = new Set();
  for (let k = 0; k < nodes.length; k++) {
    let i = -1; costs.forEach((c, j) => { if (!done.has(j) && (i < 0 || c < costs[i])) i = j; }); if (i < 0) break; done.add(i);
    nodes.forEach((n, j) => { if (j === i || !clearLine(nodes[i], n)) return; const c = costs[i] + Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y); if (c < costs[j]) { costs[j] = c; previous[j] = i; } });
  }
  let next = 5; if (!Number.isFinite(costs[next])) return to;
  while (previous[next] > 0) next = previous[next]; return nodes[next];
}
function pilot(g, limit = 420, stop = () => false) {
  let phases = [], coolingDamage = false, shieldSeen = false, firstBossHealth = null, enragedSeen = false, pinkShotsSeen = false, clogWarningSeen = false;
  for (let t = 0; t < limit; t += .1) {
    const s = g.inspect(); if (!phases.includes(s.phase + s.wave)) phases.push(s.phase + s.wave);
    if (s.phase === "result" || stop(s)) return { state: s, phases, shieldSeen, coolingDamage, enragedSeen, pinkShotsSeen, clogWarningSeen };
    if (s.phase === "upgrade") { g.action(s.wave === 2 ? "control" : "pressure"); continue; }
    const p = s.player;
    const visible = s.enemies.filter(e => clearLine(p, e)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    let target = visible[0] || s.enemies.slice().sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const fires = s.fires.filter(f => f.heat > .05 && clearLine(p, f));
    if (!target || Math.hypot(target.x - p.x, target.y - p.y) > 230 || target.shield) target = fires.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0] || target;
    target ||= { x: 480, y: 448 };
    const distance = Math.hypot(target.x - p.x, target.y - p.y);
    let goal = target;
    if (!clearLine(p, goal)) goal = route(p, goal);
    let dx = goal.x - p.x, dy = goal.y - p.y;
    if (goal === target && distance < 140 && !target.heat) { dx = p.x - target.x; dy = p.y - target.y; }
    else if (goal === target && distance < 185) { dx = 0; dy = 0; }
    // Move out of impact circles, active flames and the boss's locked attack lane.
    const boss = s.enemies.find(e => e.type === "boss");
    const danger = s.markers.find(m => Math.hypot(m.x - p.x, m.y - p.y) < m.radius + 20) || s.foamShots.find(f => Math.hypot(f.x - p.x, f.y - p.y) < 45) || s.pinkFoam.find(f => Math.hypot(f.x - p.x, f.y - p.y) < f.radius + 14) || s.fires.find(f => f.heat > 1 && Math.hypot(f.x - p.x, f.y - p.y) < 28);
    if (danger) { dx = p.x - danger.x || 1; dy = p.y - danger.y || 1; }
    if (boss && clearLine(p, boss)) {
      const choices = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [.7, -.7], [-.7, .7], [-.7, -.7]];
      function cost(v) {
        const x = p.x + v[0] * 60, y = p.y + v[1] * 60, d = Math.hypot(x - boss.x, y - boss.y);
        if (x < 45 || x > 915 || y < 45 || y > 555 || x > 375 && x < 585 && y > 205 && y < 395) return 1e7;
        const angle = Math.atan2(y - boss.y, x - boss.x), diff = Math.abs(Math.atan2(Math.sin(angle - boss.angle), Math.cos(angle - boss.angle)));
        return Math.abs(d - 175) + (d < 110 ? 1200 : 0) + (boss.strike > 0 && d < 255 && diff < .5 ? 800 : 0) + s.foamShots.reduce((sum, f) => sum + (Math.hypot(x - f.x - f.vx * .25, y - f.y - f.vy * .25) < 40 ? 400 : 0), 0) + s.pinkFoam.reduce((sum, f) => sum + (Math.hypot(x - f.x, y - f.y) < f.radius + 15 ? 150 : 0), 0) + s.fires.reduce((sum, f) => sum + (f.heat > 1 && Math.hypot(x - f.x, y - f.y) < 32 ? 90 : 0), 0);
      }
      choices.sort((a, b) => cost(a) - cost(b)); dx = choices[0][0] * 100; dy = choices[0][1] * 100;
    }
    pinkShotsSeen ||= s.foamShots.length > 0; clogWarningSeen ||= s.markers.some(m => m.kind === "clog");
    if (boss) { enragedSeen ||= boss.enraged; shieldSeen ||= boss.shield; firstBossHealth ??= boss.hp; if (!boss.shield && boss.hp < firstBossHealth - 20) coolingDamage = true; }
    const keys = new Set(); if (dx > 10) keys.add("KeyD"); if (dx < -10) keys.add("KeyA"); if (dy > 10) keys.add("KeyS"); if (dy < -10) keys.add("KeyW");
    const pressed = new Set(); if (p.overdrive >= 100) pressed.add("KeyR"); if (p.foam > 0 && (distance < 210 && target.type || fires.length > 3)) pressed.add("KeyQ");
    if (danger && p.dashCooldown <= 0) pressed.add("Space");
    if (boss && boss.strike > 1.2 && p.dashCooldown <= 0) pressed.add("Space");
    g.update(.1, { keys, pressed, pointer: { x: target.x, y: target.y, down: distance < 235 && clearLine(p, target) && !target.shield, inside: true } });
  }
  return { state: g.inspect(), phases, shieldSeen, coolingDamage, enragedSeen, pinkShotsSeen, clogWarningSeen };
}
test("a complete input-only run clears escalating waves and both Pink Foam Monster phases", () => {
  const g = active(42); const result = pilot(g);
  assert.ok(result.phases.includes("upgrade1"), JSON.stringify({ phase: result.state.phase, wave: result.state.wave, health: result.state.player.health, integrity: result.state.integrity, time: result.state.time }));
  assert.ok(result.phases.includes("upgrade3")); assert.ok(result.shieldSeen); assert.ok(result.coolingDamage);
  assert.equal(result.state.result?.won, true, JSON.stringify({ phase: result.state.phase, wave: result.state.wave, health: result.state.player.health, integrity: result.state.integrity, time: result.state.time }));
  assert.ok(result.enragedSeen, "boss reaches his second phase"); assert.ok(result.pinkShotsSeen, "boss shoots real pink projectiles"); assert.ok(result.clogWarningSeen, "boss warns before clogging penetrations");
  assert.ok(result.state.time > 150 && result.state.time < 420); assert.ok(result.state.kills > 30); assert.ok(result.state.suppressed > 1, "the faster run still suppresses real fire");
  assert.ok(result.state.bestCombo > 1, "successive attackers build a combo");
});

function reachBoss() {
  const g = active(42);
  const reached = pilot(g, 260, state => state.wave === 4);
  assert.equal(reached.state.wave, 4, "input-only pilot must reach the boss before testing its mechanics");
  assert.equal(reached.state.phase, "playing");
  return g;
}
function walkTo(g, destination, maxSeconds = 8) {
  for (let t = 0; t < maxSeconds; t += .05) {
    const state = g.inspect(), p = state.player;
    if (Math.hypot(destination.x - p.x, destination.y - p.y) < 7) return;
    const waypoint = clearLine(p, destination) ? destination : route(p, destination);
    const keys = new Set();
    if (waypoint.x > p.x + 4) keys.add("KeyD"); if (waypoint.x < p.x - 4) keys.add("KeyA");
    if (waypoint.y > p.y + 4) keys.add("KeyS"); if (waypoint.y < p.y - 4) keys.add("KeyW");
    g.update(.05, { ...quiet(), keys });
  }
  assert.fail(`Could not walk to ${JSON.stringify(destination)}; at ${JSON.stringify(g.inspect().player)}`);
}

test("boss identity and foam barrage are visible before all penetrations are clogged", () => {
  assert.match(create().snapshot().subtitle, /Pink Foam Monster/);
  const g = reachBoss();
  const initial = g.inspect();
  assert.match(initial.radio.join(" "), /Pink Foam Monster/);
  assert.equal(initial.enemies.find(e => e.type === "boss").enraged, false);
  advance(g, 4.6);
  const warning = g.inspect();
  assert.equal(warning.markers.filter(m => m.kind === "clog").length, 4);
  assert.ok(warning.markers.filter(m => m.kind === "clog").every(m => m.left > 1.9));
  assert.ok(warning.barriers.every(b => b.foam === 0), "warning must precede any blockage");
  advance(g, 2.2);
  assert.ok(g.inspect().barriers.every(b => b.foam > 0), "barrage plugs all four penetrations");
  assert.ok(g.inspect().pinkFoam.length > 0, "barrage leaves visibly pink ground foam");
});

test("a pink plug blocks barricades without spending supplies and spraying restores deployment", () => {
  const g = reachBoss();
  walkTo(g, { x: 480, y: 448 });
  for (let t = 0; t < 8 && g.inspect().barriers[2].foam === 0; t += .05) g.update(.05, quiet());
  const before = g.inspect();
  assert.ok(before.barriers[2].foam > 0, "south penetration is plugged");
  assert.ok(before.player.supplies > 0);
  g.action("barricade");
  const rejected = g.inspect();
  assert.equal(rejected.player.supplies, before.player.supplies);
  assert.equal(rejected.barriers[2].hp, 0);
  assert.match(rejected.radio.at(-1), /clogged.*pink foam/i);
  advance(g, 2.4, firing(g, 480, 524));
  const clear = g.inspect();
  assert.equal(clear.barriers[2].foam, 0, "ordinary spray clears the pink plug");
  assert.ok(clear.foamCleared > 0);
  g.action("barricade");
  const sealed = g.inspect();
  assert.ok(sealed.barriers[2].hp > 0);
  assert.equal(sealed.player.supplies, clear.player.supplies - 1);
  assert.equal(sealed.phase, "playing");
});


test("pink projectiles respect solid building walls and grant a short impact grace period", () => {
  const g = reachBoss();
  let firstHit = null, previous = g.inspect();
  for (let t = 0; t < 15 && !firstHit; t += 1 / 60) {
    g.update(1 / 60, quiet());
    const current = g.inspect();
    assert.ok(current.foamShots.every(shot => !(shot.x > 392 && shot.x < 568 && shot.y > 222 && shot.y < 378)), "shots cannot travel inside the protected building");
    if (current.player.impactCooldown > previous.player.impactCooldown) firstHit = { before: previous, after: current };
    previous = current;
  }
  assert.ok(firstHit, "a real aimed pink projectile must reach an idle player");
  const injury = firstHit.before.player.health - firstHit.after.player.health;
  assert.ok(injury > 0 && injury <= 8.1, "one fan contact cannot inflict stacked projectile damage");
  assert.equal(firstHit.after.player.impactCooldown, .4);
  advance(g, .1);
  assert.ok(g.inspect().player.impactCooldown > .25 && g.inspect().player.impactCooldown < .4);
  assert.ok(firstHit.after.player.health - g.inspect().player.health < 1, "only gentle ground damage applies during the impact grace period");
});


test("the Pink Foam Monster routes around the central building instead of stalling behind it", () => {
  const g = reachBoss(), before = g.inspect(), first = before.enemies.find(e => e.type === "boss");
  assert.equal(clearLine(first, before.player), false, "the player begins on the far side of the building");
  const originalDistance = Math.hypot(first.x - before.player.x, first.y - before.player.y);
  advance(g, 10);
  const after = g.inspect(), boss = after.enemies.find(e => e.type === "boss");
  assert.ok(boss.x > 568 + boss.radius, "the boss takes the right-hand route around the wall");
  assert.ok(boss.y > 222);
  assert.ok(Math.hypot(boss.x - after.player.x, boss.y - after.player.y) < originalDistance - 180, "the boss closes the gap without walking through walls");
  assert.equal(after.phase, "playing");
});
