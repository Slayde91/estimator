/* FIRELINE is a self-contained arcade simulation. It never reads project data. */
(function (root, factory) {
  "use strict";
  const api = factory(typeof module === "object" && module.exports ? require("./fireline-art.js") : root.ClassifireFirelineArt);
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.ClassifireGames ||= {}).fireline = api;
})(typeof window !== "undefined" ? window : globalThis, function (art) {
  "use strict";
  const W = 960, H = 600, CELL = 40, COLS = 24, ROWS = 15, WAVE_SECONDS = [45, 50, 55];
  const BUILDING = { x: 392, y: 222, w: 176, h: 156 };
  const GATES = [{ x: 480, y: 76 }, { x: 884, y: 300 }, { x: 480, y: 524 }, { x: 76, y: 300 }];
  const UPGRADES = [
    { id: "control", label: "Wide suppression", detail: "+25% cone width and stronger knockback" },
    { id: "pressure", label: "Pressure specialist", detail: "+30% recovery and +15% damage" },
    { id: "defender", label: "Defender", detail: "+45% barricade strength and 25% less injury" }
  ];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const length = (x, y) => Math.hypot(x, y);
  const dist = (a, b) => length(a.x - b.x, a.y - b.y);
  const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const insideBuilding = (x, y, r = 0) => x > BUILDING.x - r && x < BUILDING.x + BUILDING.w + r && y > BUILDING.y - r && y < BUILDING.y + BUILDING.h + r;
  const pointInCone = (from, to, angle, range, spread) => dist(from, to) <= range && Math.abs(angleDiff(Math.atan2(to.y - from.y, to.x - from.x), angle)) <= spread;
  function rng(seed) { let n = (Number(seed) >>> 0) || 1; return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; }; }
  function gateRect(i) { const g = GATES[i]; return i % 2 ? { x: g.x - 10, y: g.y - 39, w: 20, h: 78 } : { x: g.x - 39, y: g.y - 10, w: 78, h: 20 }; }
  function inRect(p, r, radius = 0) { return p.x > r.x - radius && p.x < r.x + r.w + radius && p.y > r.y - radius && p.y < r.y + r.h + radius; }
  function create({ seed = 1 } = {}) {
    let random, visualRandom, s;
    function reset() {
      random = rng(seed);
      visualRandom = rng((Number(seed) >>> 0) ^ 0x51f15e);
      s = { phase: "brief", time: 0, wave: 1, waveTime: 0, spawnClock: 1.5, nextId: 1,
        player: { x: 480, y: 448, health: 100, pressure: 100, angle: -Math.PI / 2, dash: 0, dashCooldown: 0, foam: 2, foamClock: 0, supplies: 2, supplyClock: 0, overdrive: 0, boost: 0, moving: false, hitFlash: 0, impactCooldown: 0 },
        integrity: 100, enemies: [], fires: Array.from({ length: COLS * ROWS }, (_, i) => ({ x: (i % COLS + .5) * CELL, y: (Math.floor(i / COLS) + .5) * CELL, heat: 0, spread: 4, warning: 0 })),
        barriers: GATES.map(() => ({ hp: 0, max: 110, foam: 0, maxFoam: 100 })), zones: [], shells: [], markers: [], particles: [], pinkFoam: [], foamShots: [],
        kills: 0, suppressed: 0, sealed: 0, damage: 0, score: 0, combo: 0, comboTime: 0, bestCombo: 0, streakBonus: 0, foamCleared: 0, upgrades: { control: 0, pressure: 0, defender: 0 },
        pointer: { x: 480, y: 200 }, shooting: false, sputter: false, radio: ["Small incident. Extensive correspondence."], result: null, bossSpawned: false };
    }
    reset();
    function radio(text) { if (s.radio[s.radio.length - 1] !== text) s.radio.push(text); if (s.radio.length > 4) s.radio.shift(); }
    function fireAt(x, y, heat) {
      const col = clamp(Math.floor(x / CELL), 1, COLS - 2), row = clamp(Math.floor(y / CELL), 1, ROWS - 2);
      const f = s.fires[row * COLS + col];
      if (insideBuilding(f.x, f.y, -15)) return;
      if (s.zones.some(z => dist(z, f) < z.radius)) return;
      f.heat = clamp(f.heat + heat, 0, 3.4);
    }
    function spark(x, y, colour, count = 5) {
      for (let i = 0; i < count && s.particles.length < 170; i++) {
        const a = visualRandom() * Math.PI * 2, speed = 25 + visualRandom() * 80;
        s.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .25 + visualRandom() * .4, colour });
      }
    }
    function spawn(type, gate) {
      const g = GATES[gate], stats = type === "runner" ? [23, 63, 10] : type === "drone" ? [42, 32, 13] : type === "boss" ? [820, 29, 44] : [31, 36, 12];
      s.enemies.push({ id: s.nextId++, type, gate, x: g.x + (gate % 2 ? (gate === 1 ? 43 : -43) : 0), y: type === "boss" ? Math.max(25 + stats[2], g.y - 43) : g.y + (!(gate % 2) ? (gate === 2 ? 43 : -43) : 0), hp: stats[0], max: stats[0], speed: stats[1], radius: stats[2], attack: type === "boss" ? 1.8 : 3 + random() * 2, hazard: type === "boss" ? 4.5 : 5 + random() * 3, age: 0, angle: 0, strike: 0, shield: false, recovery: 0, enraged: false, hitFlash: 0, attackCount: 0 });
    }
    function startWave() {
      s.phase = "playing"; s.waveTime = 0; s.spawnClock = .6;
      s.player.pressure = 100; s.player.health = Math.min(100, s.player.health + 20);
      s.player.foam = Math.min(3, s.player.foam + 1); s.player.supplies = Math.min(3, s.player.supplies + 1);
      if (s.wave === 4) { spawn("boss", 0); s.bossSpawned = true; radio("Pink Foam Monster! Dodge pink shots. Blast clogged penetrations clear before pressing E. Attack while he deflates."); }
      else radio(["", "Wave 1: Matchsticks at the gates. Keep the building clear.", "Wave 2: Runners and drones. Close a breach before they use it.", "Wave 3: Full-site incident. Use foam to hold a route open."][s.wave]);
    }
    function finish(won) {
      s.phase = "result"; s.shooting = false;
      s.score = Math.max(0, Math.round(s.kills * 125 + s.suppressed * 18 + s.sealed * 70 + s.streakBonus + s.foamCleared * 35 + (won ? 3000 + s.integrity * 30 + s.player.health * 10 : 0)));
      s.result = { won, score: s.score, eligible: won, message: won ? "The building survived. The programme didn’t." : s.integrity <= 0 ? "The building is lost. Your variation is under review." : "Shift ended early. The incident report will be lengthy." };
      radio(s.result.message);
    }
    function dash(keys) {
      const p = s.player; if (p.dashCooldown > 0) return;
      let dx = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      let dy = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
      if (!dx && !dy) { dx = Math.cos(p.angle); dy = Math.sin(p.angle); }
      const d = length(dx, dy); p.dashX = dx / d; p.dashY = dy / d; p.dash = .17; p.dashCooldown = 2.2;
      spark(p.x, p.y, "#bceeff", 12);
    }
    function foam() {
      const p = s.player; if (p.foam < 1) { radio("Foam recharges every 24 seconds. Keep your escape route clear."); return; }
      const d = dist(p, s.pointer), range = Math.min(d, 230), a = Math.atan2(s.pointer.y - p.y, s.pointer.x - p.x);
      p.foam--; s.shells.push({ x: p.x, y: p.y, tx: p.x + Math.cos(a) * range, ty: p.y + Math.sin(a) * range });
      radio("Foam out. That area is temporarily everyone else’s problem.");
    }
    function barricade() {
      const p = s.player; let gate = -1, nearest = 92;
      GATES.forEach((g, i) => { const d = dist(p, g); if (d < nearest) { gate = i; nearest = d; } });
      if (gate < 0) { radio("Move close to a striped breach, then press E to seal it."); return; }
      if (s.barriers[gate].foam > 0) { radio("Penetration clogged with pink foam. Spray it clear before barricading. No supplies spent."); return; }
      if (p.supplies < 1) { radio("Barricade supplies recharge every 28 seconds."); return; }
      const b = s.barriers[gate]; if (b.hp > b.max * .9) { radio("This breach is already sealed."); return; }
      if (inRect(p, gateRect(gate), 11)) { radio("Step clear of the striped breach, then press E to seal it from beside the opening."); return; }
      p.supplies--; b.max = 110 * (1 + s.upgrades.defender * .45); b.hp = b.max;
      p.overdrive = Math.min(100, p.overdrive + 18); s.sealed++; radio("Breach sealed. Professionally and with considerable urgency.");
      spark(GATES[gate].x, GATES[gate].y, "#8de6e7", 16);
    }
    function overdrive() {
      if (s.player.overdrive < 100 || s.player.boost > 0) return;
      s.player.overdrive = 0; s.player.boost = 7; radio("CLASSIFIRE OVERDRIVE. The paperwork can wait.");
    }
    function action(id) {
      if (id === "retry") { reset(); startWave(); return; }
      if (s.phase === "brief" && id === "start") { startWave(); return; }
      if (s.phase === "upgrade") {
        const up = UPGRADES.find(u => id === u.id); if (!up) return;
        s.upgrades[up.id]++; s.wave++; startWave(); return;
      }
      if (s.phase !== "playing") return;
      if (id === "foam") foam(); else if (id === "barricade") barricade(); else if (id === "overdrive") overdrive();
    }
    function move(entity, dx, dy, radius, barriers) {
      const nextX = clamp(entity.x + dx, 25 + radius, W - 25 - radius);
      const nextY = clamp(entity.y + dy, 25 + radius, H - 25 - radius);
      function blocked(x, y) { return insideBuilding(x, y, radius) || (barriers && s.barriers.some((b, i) => b.hp > 0 && inRect({ x, y }, gateRect(i), radius))); }
      if (!blocked(nextX, entity.y)) entity.x = nextX;
      if (!blocked(entity.x, nextY)) entity.y = nextY;
    }
    function hurtPlayer(amount, impact = false) {
      const p = s.player; if (p.dash > 0 || impact && p.impactCooldown > 0) return;
      const injury = amount / (1 + s.upgrades.defender * .34);
      p.health = Math.max(0, p.health - injury); p.hitFlash = .12; s.damage += injury;
      if (impact) p.impactCooldown = .4; // A fan of overlapping shots is one hit, not an instant defeat.
    }
    function pinkPatch(x, y) {
      if (insideBuilding(x, y, 6) || x < 28 || x > W - 28 || y < 28 || y > H - 28) return;
      const patch = s.pinkFoam.find(f => length(f.x - x, f.y - y) < 24);
      if (patch) { patch.life = 15; patch.hp = patch.max; return; }
      s.pinkFoam.push({ x, y, radius: 28, hp: 50, max: 50, life: 15 });
      if (s.pinkFoam.length > 40) s.pinkFoam.shift();
    }
    function bossVolley(e) {
      e.attackCount++;
      const count = e.enraged ? 9 : 5, spread = e.enraged ? .8 : .48;
      for (let i = 0; i < count; i++) {
        const a = e.angle - spread + i * spread * 2 / (count - 1), speed = e.enraged ? 210 : 180;
        const x = e.x + Math.cos(a) * (e.radius + 4), y = e.y + Math.sin(a) * (e.radius + 4);
        if (insideBuilding(x, y, 7) || lineBlockedByBuilding(e, { x, y })) continue;
        s.foamShots.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, radius: 7, life: 2.4 });
      }
      spark(e.x, e.y, "#ff8ec8", 16);
      e.recovery = e.enraged ? 3.2 : 4;
      radio("Pink Foam Monster is deflating — keep the pressure on!");
    }
    function tick(dt, input) {
      const keys = input.keys || new Set(), pressed = input.pressed || new Set(), pointer = input.pointer || {};
      const p = s.player; s.time += dt; s.waveTime += dt;
      p.hitFlash = Math.max(0, p.hitFlash - dt); p.impactCooldown = Math.max(0, p.impactCooldown - dt); s.comboTime = Math.max(0, s.comboTime - dt); if (!s.comboTime) s.combo = 0;
      if (Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) { s.pointer.x = clamp(pointer.x, 0, W); s.pointer.y = clamp(pointer.y, 0, H); }
      p.angle = Math.atan2(s.pointer.y - p.y, s.pointer.x - p.x);
      if (pressed.has("Space")) dash(keys); if (pressed.has("KeyQ")) foam(); if (pressed.has("KeyE")) barricade(); if (pressed.has("KeyR")) overdrive();
      p.dashCooldown = Math.max(0, p.dashCooldown - dt); p.boost = Math.max(0, p.boost - dt);
      p.foamClock += dt; p.supplyClock += dt;
      if (p.foamClock >= 24) { p.foamClock -= 24; p.foam = Math.min(3, p.foam + 1); }
      if (p.supplyClock >= 28) { p.supplyClock -= 28; p.supplies = Math.min(3, p.supplies + 1); }
      let dx = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      let dy = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
      let speed = p.boost > 0 ? 225 : 175;
      const stuck = s.pinkFoam.some(f => dist(p, f) < f.radius + 6);
      if (stuck) speed *= .62;
      if (p.dash > 0) { dx = p.dashX; dy = p.dashY; speed = 620; p.dash = Math.max(0, p.dash - dt); }
      p.moving = !!(dx || dy);
      const d = length(dx, dy); if (d) move(p, dx / d * speed * dt, dy / d * speed * dt, 11, true);
      const held = !!pointer.down && pointer.inside !== false;
      if (!held) s.sputter = false;
      if (p.pressure <= .2) s.sputter = true;
      if (s.sputter && p.pressure >= 24) s.sputter = false;
      s.shooting = held && !s.sputter && p.pressure > .2;
      p.pressure = clamp(p.pressure + (s.shooting ? -23 : 29 * (1 + s.upgrades.pressure * .3) * (p.boost > 0 ? 1.5 : 1)) * dt, 0, 100);
      const sprayRange = p.boost > 0 ? 235 : 205, spread = .29 * (1 + s.upgrades.control * .25);
      if (s.shooting && visualRandom() < dt * 45) {
        const a = p.angle + (visualRandom() * 2 - 1) * spread, r = 20 + visualRandom() * sprayRange;
        s.particles.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: Math.cos(a) * 75, vy: Math.sin(a) * 75, life: .16, colour: "#c8faff" });
      }
      s.spawnClock -= dt;
      if (s.wave < 4 && s.waveTime < WAVE_SECONDS[s.wave - 1] && s.spawnClock <= 0 && s.enemies.length < 24) {
        const gate = Math.floor(random() * 4), roll = random();
        spawn(s.wave === 1 ? (roll < .22 ? "runner" : "mob") : roll < .26 ? "drone" : roll < .54 ? "runner" : "mob", gate);
        s.spawnClock = s.wave === 1 ? 3.5 : s.wave === 2 ? 2.9 : 2.4;
      }
      if (s.wave === 4 && s.spawnClock <= 0 && s.enemies.length < 9) { spawn(random() < .65 ? "mob" : "runner", Math.floor(random() * 4)); s.spawnClock = 13; }
      for (const shell of s.shells) {
        const distance = length(shell.tx - shell.x, shell.ty - shell.y), travel = 420 * dt;
        if (distance <= travel) { shell.done = true; s.zones.push({ x: shell.tx, y: shell.ty, radius: 86, life: 7.5 }); spark(shell.tx, shell.ty, "#c3ffff", 20); }
        else { shell.x += (shell.tx - shell.x) / distance * travel; shell.y += (shell.ty - shell.y) / distance * travel; }
      }
      s.shells = s.shells.filter(f => !f.done);
      for (const z of s.zones) z.life -= dt;
      s.zones = s.zones.filter(z => z.life > 0);
      for (let i = 0; i < s.barriers.length; i++) {
        const b = s.barriers[i], gate = GATES[i];
        if (b.foam <= 0) continue;
        const friendly = s.zones.some(z => dist(z, gate) < z.radius);
        if (friendly || s.shooting && pointInCone(p, gate, p.angle, sprayRange + 18, spread + .06) && !lineBlockedByBuilding(p, gate)) {
          b.foam = Math.max(0, b.foam - dt * (friendly ? 65 : 48) * (p.boost > 0 ? 1.5 : 1));
          if (!b.foam) { s.foamCleared++; p.overdrive = Math.min(100, p.overdrive + 12); radio("Pink foam removed. This penetration can be barricaded again."); spark(gate.x, gate.y, "#ffb7de", 16); }
        }
      }
      for (const f of s.pinkFoam) {
        f.life -= dt;
        const friendly = s.zones.some(z => dist(z, f) < z.radius);
        if (friendly || s.shooting && pointInCone(p, f, p.angle, sprayRange + f.radius, spread + .05) && !lineBlockedByBuilding(p, f)) f.hp = Math.max(0, f.hp - dt * (friendly ? 70 : 60));
        if (f.hp > 0 && dist(p, f) < f.radius + 6) hurtPlayer(2.5 * dt);
      }
      s.pinkFoam = s.pinkFoam.filter(f => f.life > 0 && f.hp > 0);
      for (const shot of s.foamShots) {
        const old = { x: shot.x, y: shot.y }; shot.x += shot.vx * dt; shot.y += shot.vy * dt; shot.life -= dt;
        if (lineBlockedByBuilding(old, shot) || insideBuilding(shot.x, shot.y, shot.radius)) { shot.done = true; continue; }
        if (s.zones.some(z => dist(z, shot) < z.radius)) { shot.done = true; continue; }
        if (dist(shot, p) < shot.radius + 11 && p.dash <= 0) { hurtPlayer(8, true); pinkPatch(shot.x, shot.y); shot.done = true; }
        else if (shot.life <= 0 || shot.x < 34 || shot.x > W - 34 || shot.y < 34 || shot.y > H - 34) { pinkPatch(clamp(shot.x, 34, W - 34), clamp(shot.y, 34, H - 34)); shot.done = true; }
      }
      s.foamShots = s.foamShots.filter(shot => !shot.done).slice(-70);
      for (const e of s.enemies) {
        if (e.hp <= 0) continue;
        e.age += dt; e.attack -= dt; e.hazard -= dt; e.hitFlash = Math.max(0, e.hitFlash - dt); e.recovery = Math.max(0, e.recovery - dt);
        if (e.type === "boss" && !e.enraged && e.hp <= e.max * .5) { e.enraged = true; radio("Half size, twice the attitude. Wider pink volleys incoming!"); spark(e.x, e.y, "#ff6cb4", 24); }
        e.shield = e.type === "boss" && e.recovery <= 0;
        const suppressed = s.zones.some(z => dist(z, e) < z.radius);
        if (suppressed) e.hp -= 7 * dt * (e.shield ? .15 : 1);
        if (s.shooting && pointInCone(p, e, p.angle, sprayRange + e.radius, spread + .05) && !lineBlockedByBuilding(p, e)) {
          const damage = 32 * (1 + s.upgrades.pressure * .15) * (p.boost > 0 ? 1.8 : 1) * dt * (e.shield ? .32 : 1);
          e.hp -= damage; e.hitFlash = .09; p.overdrive = clamp(p.overdrive + damage * .22, 0, 100);
          const separation = dist(p, e) || 1, knock = e.type === "boss" ? 3 : 43 * (1 + s.upgrades.control * .3);
          move(e, (e.x - p.x) / separation * knock * dt, (e.y - p.y) / separation * knock * dt, e.radius, true);
        }
        if (e.hp <= 0) { s.kills++; s.combo++; s.comboTime = 6; s.bestCombo = Math.max(s.bestCombo, s.combo); s.streakBonus += Math.min(4, s.combo - 1) * 25; p.health = Math.min(100, p.health + (e.type === "boss" ? 0 : 2.5)); p.overdrive = Math.min(100, p.overdrive + 7); spark(e.x, e.y, e.type === "boss" ? "#ff8ec8" : "#ffbf70", 18); continue; }
        const nearbyGate = s.barriers.findIndex((b, i) => b.hp > 0 && inRect(e, gateRect(i), e.radius + 7));
        if (nearbyGate >= 0) { s.barriers[nearbyGate].hp = Math.max(0, s.barriers[nearbyGate].hp - (e.type === "boss" ? 33 : 11) * dt); if (s.barriers[nearbyGate].hp === 0) radio("Barricade breached. The temporary works are now very temporary."); }
        else {
          let target = dist(e, p) < 215 || e.type === "boss" || e.type === "runner" ? p : { x: 480, y: 300 };
          if (e.type === "drone") target = dist(e, p) < 145 ? { x: e.x + (e.x - p.x), y: e.y + (e.y - p.y) } : p;
          const distanceToTarget = dist(e, target), waypoint = routeAroundBuilding(e, target, e.radius), n = dist(e, waypoint) || 1;
          if (!(e.type === "boss" && distanceToTarget < 145) && !(e.type === "drone" && distanceToTarget < 190)) {
            const v = e.speed * (suppressed ? .35 : 1) * dt;
            move(e, (waypoint.x - e.x) / n * v, (waypoint.y - e.y) / n * v, e.radius, true);
          }
        }
        if (dist(e, p) < e.radius + 13) hurtPlayer((e.type === "boss" ? 28 : 11) * dt);
        if (insideBuilding(e.x, e.y, e.radius + 2)) s.integrity = Math.max(0, s.integrity - (e.type === "boss" ? 6 : 1.15) * dt);
        if (e.type === "mob" && e.hazard <= 0) { fireAt(e.x, e.y, .72); e.hazard = 8; }
        if (e.type === "drone" && e.attack <= 0) { s.markers.push({ x: p.x, y: p.y, left: 1.65, max: 1.65, radius: 34, kind: "ember" }); e.attack = 6.2; }
        if (e.type === "boss") {
          if (e.hazard <= 0) {
            GATES.forEach((g, gate) => s.markers.push({ x: g.x, y: g.y, sourceX: e.x, sourceY: e.y, left: 2.1, max: 2.1, radius: 44, kind: "clog", gate }));
            e.hazard = e.enraged ? 12 : 15; radio("Pink foam barrage! Penetrations targeted — blast the plugs clear before sealing.");
          }
          if (e.attack <= 0) { e.angle = Math.atan2(p.y - e.y, p.x - e.x); e.strike = 1.3; e.attack = e.enraged ? 5.5 : 6.4; }
          if (e.strike > 0) {
            e.strike -= dt; if (e.strike <= 0) { e.strike = 0; bossVolley(e); }
          }
        }
      }
      const bossDead = s.wave === 4 && s.bossSpawned && !s.enemies.some(e => e.type === "boss" && e.hp > 0);
      s.enemies = s.enemies.filter(e => e.hp > 0);
      for (const m of s.markers) { m.left -= dt; if (m.left <= 0) {
        if (m.kind === "clog") {
          const barrier = s.barriers[m.gate]; barrier.foam = barrier.maxFoam; barrier.hp = 0;
          pinkPatch(m.x, m.y); if (dist(p, m) < m.radius + 10) hurtPlayer(10, true); spark(m.x, m.y, "#ff8ec8", 20);
        } else { if (dist(p, m) < m.radius + 10) hurtPlayer(14, true); fireAt(m.x, m.y, 1.25); spark(m.x, m.y, "#ff7049", 12); }
      } }
      s.markers = s.markers.filter(m => m.left > 0);
      let structureHeat = 0;
      for (let i = 0; i < s.fires.length; i++) {
        const f = s.fires[i];
        if (f.warning > 0) { f.warning = Math.max(0, f.warning - dt); if (!f.warning) fireAt(f.x, f.y, .75); }
        if (f.heat <= 0) continue;
        const old = f.heat, inFoam = s.zones.some(z => dist(z, f) < z.radius);
        if (inFoam) f.heat = Math.max(0, f.heat - dt * 2.6);
        else if (s.shooting && pointInCone(p, f, p.angle, sprayRange + 10, spread + .09) && !lineBlockedByBuilding(p, f)) f.heat = Math.max(0, f.heat - dt * 2 * (p.boost > 0 ? 1.8 : 1));
        else f.heat = Math.min(3.4, f.heat + dt * .045);
        if (old > f.heat) { const removed = old - f.heat; s.suppressed += removed; p.overdrive = Math.min(100, p.overdrive + removed * 3.2); }
        if (f.heat >= 1.1 && dist(p, f) < 24) hurtPlayer((f.heat > 2.2 ? 15 : 7) * dt);
        if (f.heat >= 1.1 && insideBuilding(f.x, f.y, 26)) structureHeat += .32 * f.heat;
        f.spread -= dt;
        if (f.heat >= 2.1 && f.spread <= 0 && s.fires.filter(q => q.heat > 0).length < 80) {
          f.spread = 6; const neighbours = [i - 1, i + 1, i - COLS, i + COLS].filter(j => j >= 0 && j < s.fires.length && dist(f, s.fires[j]) < CELL + 1);
          const candidate = neighbours[Math.floor(random() * neighbours.length)], n = s.fires[candidate];
          if (n && n.heat === 0 && !n.warning && n.x > 40 && n.x < W - 40 && n.y > 40 && n.y < H - 40 && !insideBuilding(n.x, n.y, -10) && !s.barriers.some((b, g) => b.hp > 0 && inRect(n, gateRect(g), 24))) n.warning = 2.8;
        }
      }
      s.integrity = Math.max(0, s.integrity - Math.min(4, structureHeat) * dt);
      for (const q of s.particles) { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; }
      s.particles = s.particles.filter(q => q.life > 0).slice(-170);
      if (p.health <= 0 || s.integrity <= 0) finish(false);
      else if (bossDead) finish(true);
      else if (s.wave < 4 && s.waveTime >= WAVE_SECONDS[s.wave - 1] && s.enemies.length === 0) { s.phase = "upgrade"; s.shooting = false; radio("Wave cleared. Choose an upgrade; the site is paused while you prepare."); }
    }
    function update(dt, input = {}) {
      if (s.phase !== "playing" || !Number.isFinite(dt) || dt <= 0) return;
      // Cap long frame gaps; subdivide collisions without repeating pressed actions.
      let left = Math.min(dt, .1), first = true;
      while (left > .000001 && s.phase === "playing") { const step = Math.min(left, 1 / 60); tick(step, first ? input : { ...input, pressed: new Set() }); left -= step; first = false; }
    }
    function lineBlockedByBuilding(a, b, radius = 0) {
      const steps = Math.ceil(dist(a, b) / 12);
      for (let i = 1; i < steps; i++) if (insideBuilding(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, radius)) return true;
      return false;
    }
    function routeAroundBuilding(from, target, radius) {
      // Cover blocks shots, but it must not leave a chasing enemy stuck forever.
      // Four fixed clearance corners give deterministic short routes around it.
      if (insideBuilding(target.x, target.y) || !lineBlockedByBuilding(from, target, radius)) return target;
      const clearance = radius + 9, left = BUILDING.x - clearance, right = BUILDING.x + BUILDING.w + clearance;
      const top = BUILDING.y - clearance, bottom = BUILDING.y + BUILDING.h + clearance;
      const nodes = [from, { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, target];
      const costs = [0, Infinity, Infinity, Infinity, Infinity, Infinity], previous = [], visited = new Set();
      for (let k = 0; k < nodes.length; k++) {
        let current = -1;
        costs.forEach((cost, i) => { if (!visited.has(i) && (current < 0 || cost < costs[current])) current = i; });
        if (current < 0 || !Number.isFinite(costs[current])) break;
        visited.add(current);
        nodes.forEach((node, i) => {
          if (visited.has(i) || lineBlockedByBuilding(nodes[current], node, radius)) return;
          const next = costs[current] + dist(nodes[current], node);
          if (next < costs[i]) { costs[i] = next; previous[i] = current; }
        });
      }
      if (!Number.isFinite(costs[5])) return target;
      let next = 5; while (previous[next] > 0) next = previous[next];
      return nodes[next];
    }
    function snapshot() {
      const p = s.player;
      const stats = [
        { label: "Health", value: `${Math.ceil(p.health)}%` }, { label: "Building", value: `${Math.ceil(s.integrity)}%` },
        { label: "Pressure", value: `${Math.floor(p.pressure)}%` }, { label: "Wave", value: s.wave === 4 ? "BOSS" : `${s.wave} / 4` },
        { label: "Combo", value: s.combo > 1 ? `${s.combo} STREAK` : "BUILD A STREAK" }, { label: "Overdrive", value: p.boost > 0 ? "ACTIVE" : `${Math.floor(p.overdrive)}%` }
      ];
      let actions = [], subtitle;
      if (s.phase === "brief") { actions = [{ id: "start", label: "Start shift" }]; subtitle = "WASD move · mouse aim · hold left click to spray · Space dash · Q foam · E barricade · R Overdrive. Clear three quick waves, then stop the Pink Foam Monster. Blast pink plugs off penetrations before barricading."; }
      else if (s.phase === "upgrade") { actions = UPGRADES.map(u => ({ id: u.id, label: `${u.label} — ${u.detail}` })); subtitle = "Choose one upgrade. +20 health, pressure refilled, and extra supplies arrive for the next wave."; }
      else if (s.phase === "result") { actions = [{ id: "retry", label: "Another shift" }]; subtitle = `${s.kills} attackers stopped · Best streak ${s.bestCombo} · ${s.foamCleared} pink plugs cleared · ${s.sealed} barricades placed · Score ${s.score.toLocaleString("en-US")}`; }
      else { actions = [{ id: "foam", label: `Foam [Q] · ${p.foam}`, disabled: !p.foam }, { id: "barricade", label: `Barricade [E] · ${p.supplies}`, disabled: !p.supplies }, { id: "overdrive", label: "Overdrive [R]", disabled: p.overdrive < 100 || p.boost > 0 }]; subtitle = `${s.wave < 4 ? `Reinforcements end in ${Math.max(0, Math.ceil(WAVE_SECONDS[s.wave - 1] - s.waveTime))}s` : "Pink Foam Monster: dodge pink shots; attack while he deflates; spray plugs clear before E"} · ${s.enemies.length} threats · Release fire to recharge · Space dash${p.dashCooldown > 0 ? ` (${p.dashCooldown.toFixed(1)}s)` : " ready"}`; }
      return { phase: s.phase, title: "FIRELINE", subtitle, stats, actions, messages: s.radio.slice(), ...(s.result ? { result: { ...s.result } } : {}) };
    }
    function rect(ctx, x, y, w, h, fill, stroke) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h); } }
    function circle(ctx, x, y, r, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); } }
    function text(ctx, value, x, y, colour = "#edf6fc", size = 13, weight = "600", align = "left") { ctx.font = `${weight} ${size}px sans-serif`; ctx.fillStyle = colour; ctx.textAlign = align; ctx.fillText(value, x, y); }
    function cone(ctx, x, y, a, range, spread, colour) { ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, range, a - spread, a + spread); ctx.closePath(); ctx.fillStyle = colour; ctx.fill(); }
    function draw(ctx) {
      const p = s.player; ctx.save();
      rect(ctx, 0, 0, W, H, "#0a111a");
      const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#1c2c38"); bg.addColorStop(1, "#111b23"); rect(ctx, 24, 24, W - 48, H - 48, bg, "#54616a");
      ctx.strokeStyle = "#ffffff09"; ctx.lineWidth = 1;
      for (let x = 40; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, H - 24); ctx.stroke(); }
      for (let y = 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(W - 24, y); ctx.stroke(); }
      // Construction details establish a legible arena without hiding hazards.
      for (const [x, y, w, h] of [[128, 128, 95, 24], [725, 441, 100, 24], [145, 453, 24, 57], [774, 113, 24, 57]]) {
        rect(ctx, x, y, w, h, "#24333e", "#3c4e59"); ctx.strokeStyle = "#52626b"; for (let j = 5; j < Math.max(w, h); j += 12) { ctx.beginPath(); ctx.moveTo(x + (w > h ? j : 0), y + (w > h ? 0 : j)); ctx.lineTo(x + (w > h ? j : w), y + (w > h ? h : j)); ctx.stroke(); }
      }
      for (let i = 0; i < 4; i++) {
        const g = GATES[i], r = gateRect(i), b = s.barriers[i];
        rect(ctx, r.x - 5, r.y - 5, r.w + 10, r.h + 10, "#0c151e", "#d0a64e");
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); ctx.strokeStyle = "#d5aa42"; ctx.lineWidth = 5;
        for (let j = -80; j < 100; j += 14) { ctx.beginPath(); ctx.moveTo(r.x + j, r.y); ctx.lineTo(r.x + j + r.h, r.y + r.h); ctx.stroke(); } ctx.restore();
        if (b.hp > 0) {
          rect(ctx, r.x, r.y, r.w, r.h, "#287886", "#7be3ef");
          ctx.strokeStyle = "#a4f0ec"; ctx.beginPath(); ctx.moveTo(r.x + 3, r.y + 3); ctx.lineTo(r.x + r.w - 3, r.y + r.h - 3); ctx.moveTo(r.x + 3, r.y + r.h - 3); ctx.lineTo(r.x + r.w - 3, r.y + 3); ctx.stroke();
          rect(ctx, g.x - 29, g.y + 23, 58, 4, "#101820"); rect(ctx, g.x - 29, g.y + 23, 58 * b.hp / b.max, 4, "#7be3ef");
        }
        if (b.foam > 0) {
          for (let j = 0; j < 9; j++) {
            const offset = (j - 4) * 9;
            circle(ctx, g.x + (i % 2 ? Math.sin(j * 2) * 7 : offset), g.y + (i % 2 ? offset : Math.sin(j * 2) * 7), 11, j % 2 ? "#f288bf" : "#d95a9b", "#ffc1e2");
          }
          rect(ctx, g.x - 29, g.y + 26, 58, 5, "#401931"); rect(ctx, g.x - 29, g.y + 26, 58 * b.foam / b.maxFoam, 5, "#ffb2db");
          text(ctx, "CLOGGED", g.x, g.y - 27, "#ffb7df", 10, "800", "center");
        }
        if (dist(p, g) < 92 && s.phase === "playing") text(ctx, b.foam > 0 ? "SPRAY TO CLEAR" : b.hp > 0 ? "E · REPAIR" : "E · BARRICADE", g.x, g.y + 34, b.foam > 0 ? "#ffd0e9" : "#e4d49f", 10, "700", "center");
      }
      for (const f of s.fires) {
        if (f.warning > 0) { ctx.setLineDash([5, 4]); rect(ctx, f.x - 18, f.y - 18, 36, 36, "#ffae2712", "#ffb54c"); ctx.setLineDash([]); text(ctx, "!", f.x, f.y + 6, "#ffca73", 20, "800", "center"); }
        if (!f.heat) continue;
        const inferno = f.heat >= 2.2, burning = f.heat >= 1.1, pulse = Math.sin(s.time * 6 + f.x * .04) * .12 + .8;
        circle(ctx, f.x, f.y, 15 + Math.min(3, f.heat) * 2, inferno ? "#e7352a38" : burning ? "#ff6b2930" : "#e6981d22");
        if (burning) {
          for (let j = -1; j <= 1; j++) { ctx.beginPath(); ctx.moveTo(f.x + j * 9 - 5, f.y + 10); ctx.quadraticCurveTo(f.x + j * 9 - 12, f.y - 4, f.x + j * 9 + Math.sin(s.time * 9 + j) * 4, f.y - (inferno ? 21 : 13) * pulse); ctx.quadraticCurveTo(f.x + j * 9 + 12, f.y + 1, f.x + j * 9 + 5, f.y + 10); ctx.closePath(); ctx.fillStyle = j === 0 ? "#ffcf70" : inferno ? "#ff5939" : "#ed8d3f"; ctx.fill(); }
        } else { circle(ctx, f.x - 5, f.y + 4, 3, "#dd934e"); circle(ctx, f.x + 5, f.y - 2, 2, "#ffcd82"); }
      }
      for (const f of s.pinkFoam) {
        const opacity = Math.min(1, f.life / 2) * (.35 + .65 * f.hp / f.max);
        ctx.save(); ctx.globalAlpha = opacity;
        circle(ctx, f.x, f.y, f.radius, "#c1488860", "#f78ac3");
        for (let j = 0; j < 7; j++) {
          const a = j * 2.4, r = 7 + j * 2.5;
          circle(ctx, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r, 5 + j % 3, j % 2 ? "#ed7db2" : "#f9acd2", "#fdd2e750");
        }
        ctx.restore();
      }
      for (const z of s.zones) { circle(ctx, z.x, z.y, z.radius, "#8cebed29", "#8cebed70"); for (let j = 0; j < 14; j++) circle(ctx, z.x + Math.cos(j * 2.4) * (18 + j * 4), z.y + Math.sin(j * 2.4) * (18 + j * 4), 4, "#d6ffff60"); }
      rect(ctx, 388, 218, 184, 164, "#070e16"); rect(ctx, BUILDING.x, BUILDING.y, BUILDING.w, BUILDING.h, "#344450", "#a6bac5");
      for (let y = 234; y < 360; y += 25) rect(ctx, 406, y, 148, 1, "#70838c55");
      rect(ctx, 415, 242, 130, 108, "#1a2934", "#4e6674");
      text(ctx, "CLASSIFIRE", 480, 280, "#e8f0f4", 18, "800", "center"); text(ctx, "PROTECT THE BUILDING", 480, 300, "#b2c4cf", 10, "700", "center");
      rect(ctx, 424, 317, 112, 8, "#09131b"); rect(ctx, 424, 317, 112 * s.integrity / 100, 8, s.integrity < 30 ? "#ff6654" : "#64d5b3");
      text(ctx, `${Math.ceil(s.integrity)}% INTEGRITY`, 480, 341, "#c5d5dc", 10, "600", "center");
      for (const m of s.markers) {
        const pink = m.kind === "clog", colour = pink ? "#ff98d2" : "#ff7354";
        circle(ctx, m.x, m.y, m.radius, pink ? "#f96cbf20" : "#ed5a3d22", colour);
        circle(ctx, m.x, m.y, m.radius * (1 - m.left / m.max), null, colour);
        text(ctx, pink ? "FOAM INCOMING" : "!", m.x, m.y + (pink ? 4 : 7), pink ? "#ffd1eb" : "#ffbd86", pink ? 10 : 24, "800", "center");
        if (pink) {
          const t = 1 - m.left / m.max, arc = Math.sin(t * Math.PI) * 70;
          const x = m.sourceX + (m.x - m.sourceX) * t, y = m.sourceY + (m.y - m.sourceY) * t - arc;
          circle(ctx, x, y, 11, "#f77fbd", "#ffd5ec");
          circle(ctx, x - 4, y - 4, 4, "#ffe1f3");
          circle(ctx, x + 9, y + 5, 5, "#f4a2d0");
        }
      }
      for (const e of s.enemies) {
        if (e.type === "boss" && e.strike > 0) {
          cone(ctx, e.x, e.y, e.angle, 480, e.enraged ? .8 : .48, "#ff7eb820");
          text(ctx, "PINK VOLLEY · DASH", e.x, Math.max(82, e.y - 68), "#ffd2eb", 11, "800", "center");
        }
        art.drawEnemy(ctx, e, s);
        if (e.type !== "boss") {
          rect(ctx, e.x - 15, e.y + 30, 30, 3, "#17131a"); rect(ctx, e.x - 15, e.y + 30, 30 * Math.max(0,e.hp) / e.max, 3, "#ed8b7b");
        }
      }
      for (const shot of s.foamShots) {
        circle(ctx, shot.x - shot.vx * .04, shot.y - shot.vy * .04, 5, "#ef65b450");
        circle(ctx, shot.x, shot.y, shot.radius, "#f88ac6", "#ffdaed");
        circle(ctx, shot.x - 2, shot.y - 2, 2.5, "#ffe6f5");
      }
      if (s.shooting) cone(ctx, p.x, p.y, p.angle, p.boost > 0 ? 235 : 205, .29 * (1 + s.upgrades.control * .25), p.boost > 0 ? "#73e8fa49" : "#d4f7ff30");
      for (const shell of s.shells) circle(ctx, shell.x, shell.y, 6, "#b7ffff", "#53c4c6");
      for (const q of s.particles) { ctx.globalAlpha = Math.min(1, q.life * 5); circle(ctx, q.x, q.y, q.colour === "#c8faff" ? 3 : 2, q.colour); } ctx.globalAlpha = 1;
      art.drawPlayer(ctx, p, s);
      rect(ctx, p.x - 18, Math.min(H - 6,p.y + 33), 36, 4, "#09141c"); rect(ctx, p.x - 18, Math.min(H - 6,p.y + 33), 36 * p.health / 100, 4, "#83ddb8");
      if (s.phase === "playing") {
        circle(ctx, s.pointer.x, s.pointer.y, 10, null, "#dbf6fdba"); ctx.strokeStyle = "#dbf6fdba"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.pointer.x - 15, s.pointer.y); ctx.lineTo(s.pointer.x - 6, s.pointer.y); ctx.moveTo(s.pointer.x + 6, s.pointer.y); ctx.lineTo(s.pointer.x + 15, s.pointer.y); ctx.moveTo(s.pointer.x, s.pointer.y - 15); ctx.lineTo(s.pointer.x, s.pointer.y - 6); ctx.moveTo(s.pointer.x, s.pointer.y + 6); ctx.lineTo(s.pointer.x, s.pointer.y + 15); ctx.stroke();
      }
      rect(ctx, 24, 24, 222, 31, "#08121be6"); text(ctx, "NORTH WORKS / INCIDENT 01", 37, 44, "#9eb6c7", 11, "700");
      const boss = s.enemies.find(e => e.type === "boss");
      if (boss) {
        rect(ctx, 0, 0, W, 23, "#21101f", "#ed77b5");
        text(ctx, "PINK FOAM MONSTER", 20, 16, "#ffd1e9", 12, "800");
        rect(ctx, 205, 7, 260, 9, "#481d38"); rect(ctx, 205, 7, 260 * Math.max(0,boss.hp) / boss.max, 9, "#f087bc");
        text(ctx, boss.recovery > 0 ? "DEFLATING · ATTACK!" : boss.enraged ? "ENRAGED" : "INFLATED", 480, 16, boss.recovery > 0 ? "#99f3db" : "#f4a4d1", 10, "800");
        text(ctx, `${s.barriers.filter(b => b.foam > 0).length} / 4 PENETRATIONS CLOGGED`, 940, 16, "#f7afd4", 10, "700", "right");
      } else {
        text(ctx, "SCORCHING", 672, 45, "#e5a85b", 10); text(ctx, "BURNING", 760, 45, "#ff9655", 10); text(ctx, "INFERNO", 837, 45, "#ff6757", 10);
        if (s.phase === "playing") { rect(ctx, 37, 49, 180, 3, "#28444e"); rect(ctx, 37, 49, 180 * Math.min(1,s.waveTime / WAVE_SECONDS[s.wave - 1]), 3, "#83d6c1"); }
      }
      if (s.combo > 1) text(ctx, `${s.combo} STREAK +${Math.min(4,s.combo - 1) * 25}`, 480, 553, "#ffe2a0", 15, "800", "center");
      if (s.sputter) text(ctx, "PRESSURE LOW — RELEASE TO RECHARGE", 480, 576, "#ffd381", 13, "800", "center");
      else text(ctx, "WASD move   ·   SPACE dash   ·   Q foam   ·   E barricade   ·   R Overdrive", 480, 579, "#91a8b7", 11, "600", "center");
      if (s.phase !== "playing") {
        rect(ctx, 0, 0, W, H, "#06111ba8");
        const title = s.phase === "brief" ? "SURVIVE THE SHIFT" : s.phase === "upgrade" ? "BREATHING ROOM" : s.result?.won ? "SITE SECURED" : "SHIFT OVER";
        text(ctx, title, 480, 242, "#f3f8fb", 38, "800", "center");
        text(ctx, s.phase === "brief" ? "Seal the breach. Fight the fire." : s.phase === "upgrade" ? "Choose an upgrade below, then get back out there." : s.result?.message || "", 480, 279, "#bbd4e2", 17, "500", "center");
        text(ctx, s.phase === "brief" ? "Three quick waves. One Pink Foam Monster. Absolutely no pink foam approval." : s.phase === "upgrade" ? "The site is paused. Reinforcements arrive when you are ready." : `SCORE  ${s.score.toLocaleString("en-US")}`, 480, 318, "#f0ba6c", s.phase === "result" ? 24 : 14, "700", "center");
      }
      ctx.restore();
    }
    // Read-only copies make deterministic simulations testable without mutable hooks.
    function inspect() { return JSON.parse(JSON.stringify(s)); }
    return { update, draw, action, snapshot, inspect };
  }
  return { create };
});
