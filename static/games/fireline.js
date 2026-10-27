/* FIRELINE is a self-contained arcade simulation. It never reads project data. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.ClassifireGames ||= {}).fireline = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const W = 960, H = 600, CELL = 40, COLS = 24, ROWS = 15, WAVE_SECONDS = 95;
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
        player: { x: 480, y: 448, health: 100, pressure: 100, angle: -Math.PI / 2, dash: 0, dashCooldown: 0, foam: 2, foamClock: 0, supplies: 2, supplyClock: 0, overdrive: 0, boost: 0 },
        integrity: 100, enemies: [], fires: Array.from({ length: COLS * ROWS }, (_, i) => ({ x: (i % COLS + .5) * CELL, y: (Math.floor(i / COLS) + .5) * CELL, heat: 0, spread: 4, warning: 0 })),
        barriers: GATES.map(() => ({ hp: 0, max: 110 })), zones: [], shells: [], markers: [], particles: [],
        kills: 0, suppressed: 0, sealed: 0, damage: 0, score: 0, upgrades: { control: 0, pressure: 0, defender: 0 },
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
      const g = GATES[gate], stats = type === "runner" ? [23, 63, 10] : type === "drone" ? [42, 32, 13] : type === "boss" ? [740, 29, 25] : [31, 36, 12];
      s.enemies.push({ id: s.nextId++, type, gate, x: g.x + (gate % 2 ? (gate === 1 ? 43 : -43) : 0), y: g.y + (!(gate % 2) ? (gate === 2 ? 43 : -43) : 0), hp: stats[0], max: stats[0], speed: stats[1], radius: stats[2], attack: 3 + random() * 2, hazard: 5 + random() * 3, age: 0, angle: 0, strike: 0, shield: false });
    }
    function startWave() {
      s.phase = "playing"; s.waveTime = 0; s.spawnClock = 2;
      s.player.pressure = 100; s.player.health = Math.min(100, s.player.health + 20);
      s.player.foam = Math.min(3, s.player.foam + 1); s.player.supplies = Math.min(3, s.player.supplies + 1);
      if (s.wave === 4) { spawn("boss", 0); s.bossSpawned = true; radio("The Firestarter is on site. Blue shield: suppress fires. Orange core: attack."); }
      else radio(["", "Wave 1: Matchsticks at the gates. Keep the building clear.", "Wave 2: Runners and drones. Close a breach before they use it.", "Wave 3: Full-site incident. Use foam to hold a route open."][s.wave]);
    }
    function finish(won) {
      s.phase = "result"; s.shooting = false;
      s.score = Math.max(0, Math.round(s.kills * 125 + s.suppressed * 18 + s.sealed * 70 + (won ? 3000 + s.integrity * 30 + s.player.health * 10 : 0)));
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
    function hurtPlayer(amount) { const p = s.player; if (p.dash > 0) return; const injury = amount / (1 + s.upgrades.defender * .34); p.health = Math.max(0, p.health - injury); s.damage += injury; }
    function tick(dt, input) {
      const keys = input.keys || new Set(), pressed = input.pressed || new Set(), pointer = input.pointer || {};
      const p = s.player; s.time += dt; s.waveTime += dt;
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
      if (p.dash > 0) { dx = p.dashX; dy = p.dashY; speed = 620; p.dash = Math.max(0, p.dash - dt); }
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
      if (s.wave < 4 && s.waveTime < WAVE_SECONDS && s.spawnClock <= 0 && s.enemies.length < 24) {
        const gate = Math.floor(random() * 4), roll = random();
        spawn(s.wave === 1 ? (roll < .22 ? "runner" : "mob") : roll < .26 ? "drone" : roll < .54 ? "runner" : "mob", gate);
        s.spawnClock = s.wave === 1 ? 5.2 : s.wave === 2 ? 4.4 : 3.5;
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
      for (const e of s.enemies) {
        if (e.hp <= 0) continue;
        e.age += dt; e.attack -= dt; e.hazard -= dt;
        e.shield = e.type === "boss" && e.age % 12 < 7;
        const suppressed = s.zones.some(z => dist(z, e) < z.radius);
        if (suppressed) e.hp -= 7 * dt * (e.shield ? .15 : 1);
        if (s.shooting && pointInCone(p, e, p.angle, sprayRange + e.radius, spread + .05) && !lineBlockedByBuilding(p, e)) {
          const damage = 26 * (1 + s.upgrades.pressure * .15) * (p.boost > 0 ? 1.8 : 1) * dt * (e.shield ? .08 : 1);
          e.hp -= damage; p.overdrive = clamp(p.overdrive + damage * .22, 0, 100);
          const separation = dist(p, e) || 1, knock = e.type === "boss" ? 3 : 43 * (1 + s.upgrades.control * .3);
          move(e, (e.x - p.x) / separation * knock * dt, (e.y - p.y) / separation * knock * dt, e.radius, true);
        }
        if (e.hp <= 0) { s.kills++; p.health = Math.min(100, p.health + (e.type === "boss" ? 0 : 1.8)); p.overdrive = Math.min(100, p.overdrive + 7); spark(e.x, e.y, "#ffbf70", 12); continue; }
        const nearbyGate = s.barriers.findIndex((b, i) => b.hp > 0 && inRect(e, gateRect(i), e.radius + 7));
        if (nearbyGate >= 0) { s.barriers[nearbyGate].hp = Math.max(0, s.barriers[nearbyGate].hp - (e.type === "boss" ? 33 : 11) * dt); if (s.barriers[nearbyGate].hp === 0) radio("Barricade breached. The temporary works are now very temporary."); }
        else {
          let target = dist(e, p) < 215 || e.type === "boss" || e.type === "runner" ? p : { x: 480, y: 300 };
          if (e.type === "drone") target = dist(e, p) < 145 ? { x: e.x + (e.x - p.x), y: e.y + (e.y - p.y) } : p;
          const n = dist(e, target) || 1;
          if (!(e.type === "boss" && n < 145) && !(e.type === "drone" && n < 190)) {
            const v = e.speed * (suppressed ? .35 : 1) * dt;
            move(e, (target.x - e.x) / n * v, (target.y - e.y) / n * v, e.radius, true);
          }
        }
        if (dist(e, p) < e.radius + 13) hurtPlayer((e.type === "boss" ? 28 : 11) * dt);
        if (insideBuilding(e.x, e.y, e.radius + 2)) s.integrity = Math.max(0, s.integrity - (e.type === "boss" ? 6 : 1.15) * dt);
        if (e.type === "mob" && e.hazard <= 0) { fireAt(e.x, e.y, .72); e.hazard = 8; }
        if (e.type === "drone" && e.attack <= 0) { s.markers.push({ x: p.x, y: p.y, left: 1.65, max: 1.65, radius: 34, kind: "ember" }); e.attack = 6.2; }
        if (e.type === "boss") {
          if (e.attack <= 0) { e.angle = Math.atan2(p.y - e.y, p.x - e.x); e.strike = 2.4; e.attack = 5.2; }
          if (e.strike > 0) {
            e.strike -= dt;
            if (e.strike < .8 && pointInCone(e, p, e.angle, 235, .31) && !lineBlockedByBuilding(e, p)) hurtPlayer(26 * dt);
            if (e.strike <= 0) { for (let i = 1; i <= 5; i++) fireAt(e.x + Math.cos(e.angle) * i * 42, e.y + Math.sin(e.angle) * i * 42, 1); }
          }
        }
      }
      const bossDead = s.wave === 4 && s.bossSpawned && !s.enemies.some(e => e.type === "boss" && e.hp > 0);
      s.enemies = s.enemies.filter(e => e.hp > 0);
      for (const m of s.markers) { m.left -= dt; if (m.left <= 0) { if (dist(p, m) < m.radius + 10) hurtPlayer(14); fireAt(m.x, m.y, 1.25); spark(m.x, m.y, "#ff7049", 12); } }
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
      else if (s.wave < 4 && s.waveTime >= WAVE_SECONDS && s.enemies.length === 0) { s.phase = "upgrade"; s.shooting = false; radio("Wave cleared. Choose an upgrade; the site is paused while you prepare."); }
    }
    function update(dt, input = {}) {
      if (s.phase !== "playing" || !Number.isFinite(dt) || dt <= 0) return;
      // Cap long frame gaps; subdivide collisions without repeating pressed actions.
      let left = Math.min(dt, .1), first = true;
      while (left > .000001 && s.phase === "playing") { const step = Math.min(left, 1 / 60); tick(step, first ? input : { ...input, pressed: new Set() }); left -= step; first = false; }
    }
    function lineBlockedByBuilding(a, b) {
      const steps = Math.ceil(dist(a, b) / 12);
      for (let i = 1; i < steps; i++) if (insideBuilding(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps)) return true;
      return false;
    }
    function snapshot() {
      const p = s.player;
      const stats = [
        { label: "Health", value: `${Math.ceil(p.health)}%` }, { label: "Building", value: `${Math.ceil(s.integrity)}%` },
        { label: "Pressure", value: `${Math.floor(p.pressure)}%` }, { label: "Wave", value: s.wave === 4 ? "BOSS" : `${s.wave} / 4` },
        { label: "Shift", value: `${Math.floor(s.time / 60)}:${String(Math.floor(s.time % 60)).padStart(2, "0")}` }, { label: "Overdrive", value: p.boost > 0 ? "ACTIVE" : `${Math.floor(p.overdrive)}%` }
      ];
      let actions = [], subtitle;
      if (s.phase === "brief") { actions = [{ id: "start", label: "Start shift" }]; subtitle = "WASD move · mouse aim · hold left click to spray · Space dash · Q foam · E seal a nearby striped breach · R Overdrive. Defend three waves, then defeat The Firestarter."; }
      else if (s.phase === "upgrade") { actions = UPGRADES.map(u => ({ id: u.id, label: `${u.label} — ${u.detail}` })); subtitle = "Choose one upgrade. +20 health, pressure refilled, and extra supplies arrive for the next wave."; }
      else if (s.phase === "result") { actions = [{ id: "retry", label: "Another shift" }]; subtitle = `${s.kills} attackers stopped · ${Math.round(s.suppressed)} fire suppressed · ${s.sealed} breaches sealed · Score ${s.score.toLocaleString("en-US")}`; }
      else { actions = [{ id: "foam", label: `Foam [Q] · ${p.foam}`, disabled: !p.foam }, { id: "barricade", label: `Barricade [E] · ${p.supplies}`, disabled: !p.supplies }, { id: "overdrive", label: "Overdrive [R]", disabled: p.overdrive < 100 || p.boost > 0 }]; subtitle = `${s.wave < 4 ? `Reinforcements end in ${Math.max(0, Math.ceil(WAVE_SECONDS - s.waveTime))}s` : "Attack the orange core while the blue heat shield cools"} · ${s.enemies.length} threats · Release fire to recharge · Space dash${p.dashCooldown > 0 ? ` (${p.dashCooldown.toFixed(1)}s)` : " ready"}`; }
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
        if (dist(p, g) < 92 && s.phase === "playing") text(ctx, b.hp > 0 ? "E · REPAIR" : "E · SEAL", g.x, g.y - 24, "#e4d49f", 11, "700", "center");
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
      for (const z of s.zones) { circle(ctx, z.x, z.y, z.radius, "#8cebed29", "#8cebed70"); for (let j = 0; j < 14; j++) circle(ctx, z.x + Math.cos(j * 2.4) * (18 + j * 4), z.y + Math.sin(j * 2.4) * (18 + j * 4), 4, "#d6ffff60"); }
      rect(ctx, 388, 218, 184, 164, "#070e16"); rect(ctx, BUILDING.x, BUILDING.y, BUILDING.w, BUILDING.h, "#344450", "#a6bac5");
      for (let y = 234; y < 360; y += 25) rect(ctx, 406, y, 148, 1, "#70838c55");
      rect(ctx, 415, 242, 130, 108, "#1a2934", "#4e6674");
      text(ctx, "CLASSIFIRE", 480, 280, "#e8f0f4", 18, "800", "center"); text(ctx, "PROTECT THE BUILDING", 480, 300, "#b2c4cf", 10, "700", "center");
      rect(ctx, 424, 317, 112, 8, "#09131b"); rect(ctx, 424, 317, 112 * s.integrity / 100, 8, s.integrity < 30 ? "#ff6654" : "#64d5b3");
      text(ctx, `${Math.ceil(s.integrity)}% INTEGRITY`, 480, 341, "#c5d5dc", 10, "600", "center");
      for (const m of s.markers) { circle(ctx, m.x, m.y, m.radius, "#ed5a3d22", "#ff7354"); circle(ctx, m.x, m.y, m.radius * (1 - m.left / m.max), null, "#ffb170"); text(ctx, "!", m.x, m.y + 7, "#ffbd86", 24, "800", "center"); }
      for (const e of s.enemies) {
        if (e.type === "boss" && e.strike > 0) { cone(ctx, e.x, e.y, e.angle, 235, .31, e.strike > .8 ? "#ffad3433" : "#ff582c99"); if (e.strike > .8) text(ctx, "MOVE", e.x, e.y - 42, "#ffd38e", 11, "800", "center"); }
        circle(ctx, e.x + 3, e.y + 5, e.radius + 2, "#00000055");
        if (e.type === "drone") {
          ctx.strokeStyle = "#d4b4fa"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(e.x - 17, e.y - 8); ctx.lineTo(e.x + 17, e.y + 8); ctx.moveTo(e.x - 17, e.y + 8); ctx.lineTo(e.x + 17, e.y - 8); ctx.stroke();
          for (const dx of [-17, 17]) for (const dy of [-8, 8]) circle(ctx, e.x + dx, e.y + dy, 6, "#51366c", "#ce9cfa");
          circle(ctx, e.x, e.y, 9, "#b393d9"); circle(ctx, e.x, e.y, 3, "#ffb679");
        } else if (e.type === "runner") {
          ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(Math.atan2(p.y - e.y, p.x - e.x)); ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-10, -10); ctx.lineTo(-5, 0); ctx.lineTo(-10, 10); ctx.closePath(); ctx.fillStyle = "#f5b44d"; ctx.fill(); ctx.restore();
        } else {
          circle(ctx, e.x, e.y, e.radius, e.type === "boss" ? "#843332" : "#b35d47", e.type === "boss" ? "#ffd69f" : "#e3a074");
          rect(ctx, e.x - e.radius * .6, e.y - 4, e.radius * 1.2, 7, "#241a20"); circle(ctx, e.x + 4, e.y - 1, 2, "#ffb54f");
          if (e.type === "boss") { circle(ctx, e.x, e.y, e.radius + 7, e.shield ? "#4bbfea28" : "#ff8e3333", e.shield ? "#7bd8ff" : "#ffb668"); text(ctx, e.shield ? "HEAT SHIELD" : "COOLING · ATTACK", e.x, e.y - 44, e.shield ? "#8cdbff" : "#ffd38c", 10, "800", "center"); }
        }
        rect(ctx, e.x - e.radius, e.y + e.radius + 8, e.radius * 2, 3, "#17131a"); rect(ctx, e.x - e.radius, e.y + e.radius + 8, e.radius * 2 * e.hp / e.max, 3, "#ed8b7b");
      }
      if (s.shooting) cone(ctx, p.x, p.y, p.angle, p.boost > 0 ? 235 : 205, .29 * (1 + s.upgrades.control * .25), p.boost > 0 ? "#73e8fa49" : "#d4f7ff30");
      for (const shell of s.shells) circle(ctx, shell.x, shell.y, 6, "#b7ffff", "#53c4c6");
      for (const q of s.particles) { ctx.globalAlpha = Math.min(1, q.life * 5); circle(ctx, q.x, q.y, q.colour === "#c8faff" ? 3 : 2, q.colour); } ctx.globalAlpha = 1;
      circle(ctx, p.x + 3, p.y + 5, 14, "#00000066");
      if (p.boost > 0 || p.dash > 0) circle(ctx, p.x, p.y, 22, "#49d3fa20", "#a0f3ff");
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); rect(ctx, -9, -11, 17, 22, "#d8dfe2", "#0a1b28"); rect(ctx, -6, -11, 5, 22, "#e74446"); rect(ctx, 1, -4, 23, 8, "#9eb6c1", "#e7f6fa"); circle(ctx, 0, 0, 8, "#f4d582", "#604d2c"); rect(ctx, 3, -5, 3, 10, "#263745"); ctx.restore();
      rect(ctx, p.x - 18, p.y + 22, 36, 4, "#09141c"); rect(ctx, p.x - 18, p.y + 22, 36 * p.health / 100, 4, "#83ddb8");
      if (s.phase === "playing") {
        circle(ctx, s.pointer.x, s.pointer.y, 10, null, "#dbf6fdba"); ctx.strokeStyle = "#dbf6fdba"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.pointer.x - 15, s.pointer.y); ctx.lineTo(s.pointer.x - 6, s.pointer.y); ctx.moveTo(s.pointer.x + 6, s.pointer.y); ctx.lineTo(s.pointer.x + 15, s.pointer.y); ctx.moveTo(s.pointer.x, s.pointer.y - 15); ctx.lineTo(s.pointer.x, s.pointer.y - 6); ctx.moveTo(s.pointer.x, s.pointer.y + 6); ctx.lineTo(s.pointer.x, s.pointer.y + 15); ctx.stroke();
      }
      rect(ctx, 24, 24, 222, 31, "#08121be6"); text(ctx, "NORTH WORKS / INCIDENT 01", 37, 44, "#9eb6c7", 11, "700");
      text(ctx, "SCORCHING", 672, 45, "#e5a85b", 10); text(ctx, "BURNING", 760, 45, "#ff9655", 10); text(ctx, "INFERNO", 837, 45, "#ff6757", 10);
      if (s.sputter) text(ctx, "PRESSURE LOW — RELEASE TO RECHARGE", 480, 576, "#ffd381", 13, "800", "center");
      else text(ctx, "WASD move   ·   SPACE dash   ·   Q foam   ·   E barricade   ·   R Overdrive", 480, 579, "#91a8b7", 11, "600", "center");
      if (s.phase !== "playing") {
        rect(ctx, 0, 0, W, H, "#06111ba8");
        const title = s.phase === "brief" ? "SURVIVE THE SHIFT" : s.phase === "upgrade" ? "BREATHING ROOM" : s.result?.won ? "SITE SECURED" : "SHIFT OVER";
        text(ctx, title, 480, 242, "#f3f8fb", 38, "800", "center");
        text(ctx, s.phase === "brief" ? "Seal the breach. Fight the fire." : s.phase === "upgrade" ? "Choose an upgrade below, then get back out there." : s.result?.message || "", 480, 279, "#bbd4e2", 17, "500", "center");
        text(ctx, s.phase === "brief" ? "Three defence waves. One Firestarter. One very long incident report." : s.phase === "upgrade" ? "The site is paused. Reinforcements arrive when you are ready." : `SCORE  ${s.score.toLocaleString("en-US")}`, 480, 318, "#f0ba6c", s.phase === "result" ? 24 : 14, "700", "center");
      }
      ctx.restore();
    }
    // Read-only copies make deterministic simulations testable without mutable hooks.
    function inspect() { return JSON.parse(JSON.stringify(s)); }
    return { update, draw, action, snapshot, inspect };
  }
  return { create };
});
