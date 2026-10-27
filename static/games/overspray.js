(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.ClassifireGames ||= {}).overspray = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // All paint and timing live in this simulation. No estimator data is used.
  const W = 960, H = 600, CELL = 10, COLS = W / CELL, ROWS = H / CELL;
  const STEP = 1 / 60, LOW = 0.85, HIGH = 1.35;
  const JOBS = Object.freeze([
    { name: "01 / THE WORKSHOP", brief: "An isolated beam. An optimistic allowance.", target: 25, time: 70, allowance: 55, covers: 2, required: 0.75, fee: 1200 },
    { name: "02 / FINISHED CAR PARK", brief: "The windows are in. So is the supervisor.", target: 30, time: 90, allowance: 80, covers: 2, required: 0.80, fee: 1900 },
    { name: "03 / EXPOSED SITE", brief: "Crosswind, a crane and no good place to park.", target: 35, time: 100, allowance: 90, covers: 3, required: 0.80, fee: 2600 }
  ]);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const money = n => "$" + Math.round(n).toLocaleString("en-AU");
  const percent = n => Math.round(n * 100) + "%";
  function seeded(seed) {
    let value = (Number(seed) >>> 0) || 1;
    return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
  }
  function steelFor(job) {
    if (!job) return [rect(285, 166, 390, 55), rect(438, 221, 84, 180), rect(285, 401, 390, 55)];
    if (job === 1) return [rect(280, 166, 395, 55), rect(280, 221, 55, 245), rect(620, 221, 55, 245), rect(335, 305, 285, 42)];
    return [rect(245, 170, 455, 50), rect(245, 220, 55, 245), rect(645, 220, 55, 245), rect(300, 300, 345, 45), rect(300, 420, 345, 45)];
  }
  function objectsFor(job) {
    const items = [{ ...rect(746, 142, 135, 300), type: "wall", label: "FINISHED WALL", cost: 1.3 }];
    if (job > 0) items.push({ ...rect(100, 146, 118, 255), type: "window", label: "NEW GLAZING", cost: 3.4 });
    else items.push({ ...rect(130, 319, 100, 126), type: "crate", label: "STORES", cost: 0.8 });
    items.push({ ...rect(374, 108, 48, 25), type: "light", label: "", cost: 7 }, { ...rect(555, 108, 48, 25), type: "light", label: "", cost: 7 });
    return items;
  }
  function create(options = {}) {
    const random = seeded(options.seed);
    let job = 0, phase = "masking", accumulator = 0, elapsed = 0, material = 0, waste = 0;
    let damage = 0, cleanupSeconds = 0, complaints = 0, campaign = 0, result = null;
    let narrow = false, inspection = false, cleanup = false, sprayOn = false;
    let pointer = { x: 480, y: 300, inside: false, down: false }, paint = new Float32Array(COLS * ROWS);
    let splatter = new Float32Array(COLS * ROWS), costs = new Float32Array(COLS * ROWS), steel = new Uint8Array(COLS * ROWS);
    let masks = [], particles = [], emails = [], pieces = [], objects = [], steelCount = 0;
    let inboxClock = 0, complaintExposure = 0, utePaint = 0, hookPaint = 0, lastCoverage = null;
    const config = () => JOBS[job];
    function loadJob(next) {
      job = next; phase = "masking"; accumulator = 0; elapsed = 0; material = 0; waste = 0;
      damage = 0; cleanupSeconds = 0; complaints = 0; result = null; narrow = false; inspection = false; cleanup = false;
      sprayOn = false; masks = []; particles = []; emails = []; inboxClock = 0; complaintExposure = 0; utePaint = 0; hookPaint = 0;
      paint = new Float32Array(COLS * ROWS); splatter = new Float32Array(COLS * ROWS); costs = new Float32Array(COLS * ROWS);
      steel = new Uint8Array(COLS * ROWS); steelCount = 0; pieces = steelFor(job); objects = objectsFor(job);
      for (let i = 0; i < steel.length; i++) {
        const x = (i % COLS + 0.5) * CELL, y = (Math.floor(i / COLS) + 0.5) * CELL;
        if (pieces.some(r => inRect(x, y, r))) { steel[i] = 1; steelCount++; }
        const object = objects.find(o => inRect(x, y, o));
        costs[i] = object ? object.cost : 0.14;
      }
      lastCoverage = null;
    }
    function measure() {
      let acceptable = 0, thin = 0, excessive = 0, overbuild = 0;
      for (let i = 0; i < paint.length; i++) if (steel[i]) {
        if (paint[i] < LOW) thin++;
        else if (paint[i] <= HIGH) acceptable++;
        else excessive++;
        overbuild += Math.max(0, paint[i] - 1);
      }
      return { coverage: acceptable / steelCount, thin: thin / steelCount, excessive: excessive / steelCount, overbuild };
    }
    function coverage() { return lastCoverage ||= measure(); }
    function ute() {
      if (job === 0 || elapsed < config().time * 0.48) return null;
      const progress = clamp((elapsed - config().time * 0.48) / 3, 0, 1);
      return { x: 980 - progress * 420, y: 433, w: 242, h: 97, type: "ute", cost: 10 };
    }
    function crane() {
      return job === 2 ? { x: 470 + Math.sin(elapsed * 0.58) * 155, y: 200 + Math.sin(elapsed * 0.31) * 58, w: 32, h: 68 } : null;
    }
    function wind() {
      if (job !== 2) return { offset: 0, warning: false };
      const stage = elapsed % 24;
      return { offset: stage >= 17 && stage < 23 ? (Math.floor(elapsed / 24) % 2 ? -42 : 42) : 0, warning: stage >= 14 && stage < 17 };
    }
    function addComplaint() {
      const text = [
        "Site office: A little spray has escaped the work area.",
        "Builder: Please include cleaning in your current scope.",
        "RE: Additional cleaning. The windows were installed yesterday.",
        "Supervisor: Can someone explain why the windscreen is fire rated?",
        "RE: RE: Additional cleaning. Photos attached. Again.",
        "RE: RE: RE: Additional cleaning. Please stop replying all.",
        "Accounts: Your variation is under review. Indefinitely.",
        "RE: RE: RE: RE: Please put the spray gun down."
      ];
      emails.unshift(text[Math.min(complaints, text.length - 1)]); emails = emails.slice(0, 5); complaints++;
    }
    function finish() {
      if (phase !== "playing") return;
      const m = coverage(), qualified = m.coverage >= config().required;
      const materialCost = waste * 14;
      const cleaningCost = cleanupSeconds * 7 + damage * 115;
      const speedBonus = Math.max(0, config().time - elapsed) * 5;
      const earnings = qualified ? Math.max(0, Math.round(config().fee + speedBonus - materialCost - cleaningCost)) : 0;
      phase = "result"; sprayOn = false;
      result = {
        won: qualified, eligible: qualified, score: earnings,
        message: qualified ? (job === 2 ? "Contract complete. The steel survived. The inbox didn't." : "Coat accepted. Your variation is still under review.") : "Coat not accepted. Reach " + percent(config().required) + " in the target range to qualify.",
        coverage: percent(m.coverage), materialWasted: waste.toFixed(1) + " L", complaints,
        uteCondition: utePaint < 0.03 ? "Pristine" : utePaint < 0.8 ? "Speckled" : "Now fire rated",
        earnings, campaignTotal: campaign + earnings, materialCost: Math.round(materialCost), cleaningCost: Math.round(cleaningCost)
      };
    }
    function placeMask(x, y) {
      if (phase !== "masking" || x < 20 || x > W - 20 || y < 80 || y > H - 35) return;
      const existing = masks.findIndex(m => inRect(x, y, m));
      if (existing >= 0) masks.splice(existing, 1);
      else if (masks.length < config().covers) masks.push(rect(clamp(x - 65, 20, W - 150), clamp(y - 58, 80, H - 151), 130, 116));
    }
    function spray(dt) {
      const fan = narrow ? 26 : 53, shift = wind().offset, aimX = pointer.x + shift, aimY = pointer.y;
      const liters = dt * (narrow ? 0.56 : 1.55);
      if (material + liters > config().allowance) { material = config().allowance; finish(); return; }
      material += liters;
      let totalWeight = 0, nonSteelWeight = 0, damageWeight = 0;
      const hits = [], currentUte = ute(), hook = crane();
      for (let y = Math.max(0, Math.floor((aimY - fan) / CELL)); y <= Math.min(ROWS - 1, Math.floor((aimY + fan) / CELL)); y++) {
        for (let x = Math.max(0, Math.floor((aimX - fan) / CELL)); x <= Math.min(COLS - 1, Math.floor((aimX + fan) / CELL)); x++) {
          const px = (x + 0.5) * CELL, py = (y + 0.5) * CELL, distance = Math.hypot(px - aimX, py - aimY);
          if (distance > fan) continue;
          const weight = 0.24 + 0.76 * (1 - distance / fan), index = y * COLS + x;
          totalWeight += weight;
          if (masks.some(m => inRect(px, py, m))) { nonSteelWeight += weight; continue; }
          const blockedUte = currentUte && inRect(px, py, currentUte), blockedHook = hook && inRect(px, py, hook);
          if (steel[index] && !blockedUte && !blockedHook) {
            const deposit = weight * dt * (narrow ? 3.1 : 1.65);
            // Material above the acceptable band is wasted even when it lands on steel.
            nonSteelWeight += weight * clamp((paint[index] + deposit - HIGH) / deposit, 0, 1);
            paint[index] = Math.min(4, paint[index] + deposit);
          }
          else {
            nonSteelWeight += weight;
            const cost = blockedUte ? 10 : blockedHook ? 1.5 : costs[index];
            hits.push({ index, weight, cost, ute: blockedUte, hook: blockedHook });
            damageWeight += weight * cost;
          }
        }
      }
      // Paint outside the visible site is still material wasted.
      if (!totalWeight) { waste += liters; return; }
      waste += liters * nonSteelWeight / totalWeight;
      const billable = liters * damageWeight / totalWeight;
      damage += billable; complaintExposure += billable;
      for (const hit of hits) {
        const amount = liters * hit.weight / totalWeight;
        splatter[hit.index] = Math.min(3, splatter[hit.index] + amount * 3);
        if (hit.ute) utePaint += amount;
        if (hit.hook) hookPaint += amount;
      }
      lastCoverage = null;
      for (let i = 0; i < 3; i++) {
        const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * fan;
        particles.push({ x: aimX + Math.cos(angle) * radius, y: aimY + Math.sin(angle) * radius, life: 0.14 + random() * 0.16, size: random() * 2 + 1 });
      }
      if (particles.length > 90) particles.splice(0, particles.length - 90);
    }
    function clean(dt) {
      cleanupSeconds += dt;
      const currentUte = ute();
      let removed = 0;
      for (let y = Math.max(0, Math.floor((pointer.y - 37) / CELL)); y <= Math.min(ROWS - 1, Math.floor((pointer.y + 37) / CELL)); y++) {
        for (let x = Math.max(0, Math.floor((pointer.x - 37) / CELL)); x <= Math.min(COLS - 1, Math.floor((pointer.x + 37) / CELL)); x++) {
          const index = y * COLS + x, px = (x + 0.5) * CELL, py = (y + 0.5) * CELL;
          if (Math.hypot(px - pointer.x, py - pointer.y) > 37) continue;
          const amount = Math.min(splatter[index], dt * 0.18);
          splatter[index] -= amount;
          const onUte = currentUte && inRect(px, py, currentUte);
          removed += amount / 3 * (onUte ? 10 : costs[index]);
          if (onUte) utePaint = Math.max(0, utePaint - amount / 3);
        }
      }
      damage = Math.max(0, damage - removed);
    }
    function action(id) {
      if (id === "start" && phase === "masking") { phase = "playing"; accumulator = 0; return; }
      if (id === "finish") { finish(); return; }
      if (id === "next" && phase === "result" && result.won && job < 2) { campaign += result.earnings; loadJob(job + 1); return; }
      if (id === "retry" && phase === "result") { loadJob(job); return; }
      if (id === "restart" && phase === "result") { campaign = 0; loadJob(0); return; }
      if (phase !== "playing" && phase !== "masking") return;
      if (id === "nozzle") narrow = !narrow;
      if (id === "inspect") inspection = !inspection;
      if (id === "cleanup") cleanup = !cleanup;
      if (id === "clear-masks" && phase === "masking") masks = [];
    }
    function update(dt, input = {}) {
      const incoming = input.pointer || {};
      pointer = { x: Number.isFinite(incoming.x) ? incoming.x : pointer.x, y: Number.isFinite(incoming.y) ? incoming.y : pointer.y, inside: !!incoming.inside, down: !!incoming.down };
      if (input.pressed?.has("KeyN")) action("nozzle");
      if (input.pressed?.has("KeyI")) action("inspect");
      if (input.pressed?.has("KeyC")) action("cleanup");
      if (phase === "masking" && incoming.clicked && pointer.inside) placeMask(pointer.x, pointer.y);
      if (phase !== "playing") { sprayOn = false; accumulator = 0; return; }
      accumulator += clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
      while (accumulator + 1e-9 >= STEP && phase === "playing") {
        accumulator -= STEP; elapsed = Math.min(config().time, elapsed + STEP); inboxClock += STEP;
        sprayOn = pointer.inside && pointer.down;
        if (sprayOn) { if (cleanup) clean(STEP); else spray(STEP); }
        for (const particle of particles) particle.life -= STEP;
        particles = particles.filter(p => p.life > 0);
        if (complaintExposure >= 0.3 && inboxClock >= 1.4 && complaints < 60) { addComplaint(); complaintExposure = Math.max(0, complaintExposure - (0.3 + complaints * 0.17)); inboxClock = 0; }
        if (elapsed >= config().time) finish();
      }
    }
    function snapshot() {
      const m = coverage(), cfg = config(), conditions = wind();
      const messages = phase === "masking" ? ["Click near an expensive surface to place a cover. Click a cover to remove it. Covers also block steel underneath.", "Hold the mouse to spray. N: nozzle · I: inspection · C: cleanup."] : [...emails];
      if (phase === "result") messages.unshift("Material waste " + result.materialWasted + " · Complaints " + complaints + " · Ute: " + result.uteCondition, "Waste deduction " + money(result.materialCost) + " · Cleaning / damage " + money(result.cleaningCost) + " · Contract total " + money(result.campaignTotal));
      const actions = phase === "result" ? [
        ...(result.won && job < 2 ? [{ id: "next", label: "Next job →" }] : []),
        { id: "retry", label: "Retry this job" }, { id: "restart", label: "New contract" }
      ] : [
        ...(phase === "masking" ? [{ id: "start", label: "Start job" }, { id: "clear-masks", label: "Remove covers", disabled: !masks.length }] : []),
        { id: "nozzle", label: narrow ? "Nozzle: narrow (N)" : "Nozzle: wide (N)", pressed: narrow },
        { id: "inspect", label: "Inspection (I)", pressed: inspection },
        ...(phase === "playing" ? [{ id: "cleanup", label: "Cleanup (C)", pressed: cleanup }, { id: "finish", label: "Finish & inspect" }] : [])
      ];
      return {
        phase, title: cfg.name,
        subtitle: phase === "masking" ? cfg.brief + " Place up to " + cfg.covers + " covers before starting." : phase === "result" ? result.message : conditions.warning ? "WIND WARNING — a sideways gust is approaching." : conditions.offset ? "CROSSWIND — aim into the gust. Watch the dashed fan." : cleanup ? "Cleanup: hold over splatter. The clock keeps running." : "Keep moving. Aim for " + Math.round(cfg.target * LOW) + "–" + Math.round(cfg.target * HIGH) + " mm on at least " + percent(cfg.required) + " of the steel.",
        stats: [
          { label: "Target", value: cfg.target + " mm" }, { label: "Acceptable coat", value: percent(m.coverage) + " / " + percent(cfg.required) },
          { label: "Time left", value: Math.ceil(cfg.time - elapsed) + " s" }, { label: "Material left", value: Math.max(0, cfg.allowance - material).toFixed(1) + " L" },
          { label: "Complaints", value: String(complaints) }, { label: phase === "masking" ? "Covers available" : "Contract earnings", value: phase === "masking" ? String(cfg.covers - masks.length) : money(campaign + (result?.earnings || 0)) }
        ],
        actions, messages, result,
        metrics: { job, elapsed, coverage: m.coverage, thin: m.thin, excessive: m.excessive, material, waste, damage, cleanupSeconds, complaints, masks: masks.length, inspection, narrow, cleanup, utePaint, hookPaint }
      };
    }
    function text(ctx, value, x, y, size = 14, color = "#d8e3ed", weight = "500") {
      ctx.fillStyle = color; ctx.font = weight + " " + size + "px system-ui, sans-serif"; ctx.fillText(value, x, y);
    }
    function roundRect(ctx, x, y, w, h, radius, fill, stroke) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    }
    function draw(ctx) {
      ctx.save();
      ctx.fillStyle = "#101820"; ctx.fillRect(0, 0, W, H);
      const backdrop = ctx.createLinearGradient(0, 0, 0, H);
      backdrop.addColorStop(0, "#172934"); backdrop.addColorStop(0.7, "#23313b"); backdrop.addColorStop(1, "#111921");
      ctx.fillStyle = backdrop; ctx.fillRect(0, 0, W, H);
      // Workshop structure and floor perspective stay deliberately low contrast.
      ctx.strokeStyle = "#32434c"; ctx.lineWidth = 2;
      for (let x = 40; x < W; x += 110) { ctx.beginPath(); ctx.moveTo(x, 70); ctx.lineTo(x, 470); ctx.stroke(); }
      for (let y = 120; y < 470; y += 80) { ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(930, y); ctx.stroke(); }
      ctx.fillStyle = "#1a2229"; ctx.fillRect(0, 470, W, 130);
      ctx.strokeStyle = "#2d363d";
      for (let x = -600; x <= 1600; x += 130) { ctx.beginPath(); ctx.moveTo(480 + (x - 480) * 0.5, 470); ctx.lineTo(x, 600); ctx.stroke(); }
      text(ctx, "CLASSIFIRE  /  CONTRACT RUN", 28, 33, 12, "#94a7b5", "700");
      text(ctx, config().name, 28, 59, 22, "#f5f6f7", "800");
      text(ctx, "COAT " + config().target + " mm  •  " + percent(config().required) + " IN RANGE", 575, 35, 13, "#c3d0d9", "700");
      const stageLabel = phase === "masking" ? "PREP / CLOCK STOPPED" : phase === "result" ? "INSPECTION COMPLETE" : cleanup ? "CLEANUP" : narrow ? "NARROW FAN" : "WIDE FAN";
      text(ctx, stageLabel, 575, 58, 13, phase === "masking" ? "#f3ce76" : "#93dfc6", "800");
      for (const object of objects) {
        if (object.type === "window") {
          roundRect(ctx, object.x - 5, object.y - 5, object.w + 10, object.h + 10, 2, "#0c151c", "#a6bac3");
          const glass = ctx.createLinearGradient(object.x, object.y, object.x + object.w, object.y + object.h);
          glass.addColorStop(0, "#458294"); glass.addColorStop(0.5, "#9ac9cf"); glass.addColorStop(0.51, "#3e6b7a"); glass.addColorStop(1, "#517d8b");
          ctx.fillStyle = glass; ctx.fillRect(object.x, object.y, object.w, object.h);
          ctx.fillStyle = "#b1c1c8"; ctx.fillRect(object.x + object.w / 2 - 3, object.y, 6, object.h); ctx.fillRect(object.x, object.y + object.h / 2 - 3, object.w, 6);
        } else if (object.type === "light") {
          ctx.fillStyle = "#77888e"; ctx.fillRect(object.x + object.w / 2 - 2, 78, 4, 32);
          roundRect(ctx, object.x, object.y, object.w, object.h, 3, "#e7e3ca", "#f8f3d9");
          ctx.fillStyle = "#fff3c329"; ctx.beginPath(); ctx.moveTo(object.x, object.y + object.h); ctx.lineTo(object.x - 20, 165); ctx.lineTo(object.x + object.w + 20, 165); ctx.lineTo(object.x + object.w, object.y + object.h); ctx.fill();
        } else if (object.type === "wall") {
          roundRect(ctx, object.x, object.y, object.w, object.h, 2, "#a0a49e", "#c9cec7");
          ctx.fillStyle = "#bfc3bb"; ctx.fillRect(object.x + 4, object.y + 3, object.w - 8, object.h - 9);
          ctx.strokeStyle = "#939a92"; ctx.beginPath(); ctx.moveTo(object.x + 65, object.y); ctx.lineTo(object.x + 65, object.y + object.h); ctx.stroke();
        } else {
          ctx.fillStyle = "#726244"; ctx.fillRect(object.x, object.y, object.w, object.h); ctx.strokeStyle = "#aa9263";
          ctx.strokeRect(object.x + 5, object.y + 5, object.w - 10, object.h - 10);
          ctx.beginPath(); ctx.moveTo(object.x, object.y); ctx.lineTo(object.x + object.w, object.y + object.h); ctx.stroke();
        }
        if (object.label) text(ctx, object.label, object.x, object.y + object.h + 21, 10, "#9cabb5", "700");
      }
      for (const part of pieces) {
        ctx.fillStyle = "#0006"; ctx.fillRect(part.x + 9, part.y + 9, part.w, part.h);
        const steelGradient = ctx.createLinearGradient(part.x, part.y, part.x + 30, part.y + part.h);
        steelGradient.addColorStop(0, "#8194a0"); steelGradient.addColorStop(0.22, "#344b58"); steelGradient.addColorStop(0.7, "#566b78"); steelGradient.addColorStop(1, "#a2b2ba");
        ctx.fillStyle = steelGradient; ctx.fillRect(part.x, part.y, part.w, part.h);
        ctx.strokeStyle = "#b6c5cc"; ctx.lineWidth = 2; ctx.strokeRect(part.x + 1, part.y + 1, part.w - 2, part.h - 2);
      }
      const scan = inspection || phase === "result";
      for (let i = 0; i < paint.length; i++) {
        const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
        if (steel[i]) {
          if (scan) ctx.fillStyle = paint[i] < LOW ? "#e6a74bbd" : paint[i] <= HIGH ? "#4bd5a9d9" : "#ed6684de";
          else ctx.fillStyle = "rgba(221,222,201," + Math.min(0.96, paint[i] * 0.75) + ")";
          if (scan || paint[i] > 0) ctx.fillRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
          if (!scan && paint[i] > 1.3) { ctx.fillStyle = "#ece9d4"; ctx.fillRect(x + 3, y + 3, 3, 3); }
        }
        if (splatter[i] > 0.003) {
          ctx.fillStyle = "rgba(239,232,205," + Math.min(1, splatter[i] * 3 + 0.25) + ")";
          const seedX = (i * 7) % 7, seedY = (i * 11) % 7;
          ctx.beginPath(); ctx.arc(x + 2 + seedX, y + 2 + seedY, Math.min(4.5, 1 + splatter[i] * 15), 0, Math.PI * 2); ctx.fill();
        }
      }
      // Connection plates and rivets make edges and joints easy to judge.
      for (const part of pieces) if (part.h < 70) {
        for (const x of [part.x + 12, part.x + part.w - 12]) for (const y of [part.y + 12, part.y + part.h - 12]) {
          ctx.fillStyle = "#132631"; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
        }
      }
      const currentUte = ute();
      if (currentUte) {
        ctx.save(); ctx.translate(currentUte.x, currentUte.y);
        ctx.fillStyle = "#0005"; ctx.beginPath(); ctx.ellipse(120, 89, 129, 17, 0, 0, Math.PI * 2); ctx.fill();
        roundRect(ctx, 0, 36, 238, 46, 8, utePaint > 0.8 ? "#9caa96" : "#ece9d8", "#c5ccbf");
        ctx.beginPath(); ctx.moveTo(29, 36); ctx.lineTo(53, 3); ctx.lineTo(123, 3); ctx.lineTo(150, 36); ctx.fillStyle = "#d9dccf"; ctx.fill();
        ctx.fillStyle = utePaint > 0.3 ? "#859f98" : "#285164"; ctx.fillRect(61, 10, 58, 24);
        ctx.fillStyle = "#d81331"; ctx.fillRect(7, 49, 222, 7); text(ctx, "SITE SUPERVISOR", 149, 72, 9, "#273039", "800");
        for (const x of [43, 192]) { ctx.fillStyle = "#111820"; ctx.beginPath(); ctx.arc(x, 80, 19, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#84939a"; ctx.beginPath(); ctx.arc(x, 80, 9, 0, Math.PI * 2); ctx.fill(); }
        if (utePaint > 0.03) { ctx.fillStyle = "#f5edce"; for (let i = 0; i < Math.min(40, Math.ceil(utePaint * 45)); i++) { ctx.beginPath(); ctx.arc(15 + i * 37 % 213, 20 + i * 19 % 50, 2, 0, Math.PI * 2); ctx.fill(); } }
        ctx.restore();
        if (elapsed < config().time * 0.48 + 6) text(ctx, "SUPERVISOR ARRIVING. OF COURSE.", 525, 562, 13, "#ffc879", "800");
      } else if (phase === "masking" && job > 0) {
        ctx.setLineDash([8, 5]); ctx.strokeStyle = "#e1b86473"; ctx.strokeRect(560, 433, 242, 97); ctx.setLineDash([]);
        text(ctx, "RESERVED FOR TERRIBLE PARKING", 565, 553, 10, "#bca576", "700");
      }
      const hook = crane();
      if (hook) {
        ctx.strokeStyle = "#070c10"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(hook.x + 16, 75); ctx.lineTo(hook.x + 16, hook.y); ctx.stroke();
        roundRect(ctx, hook.x, hook.y, 32, 32, 3, hookPaint > 0.3 ? "#b7b994" : "#e9b848", "#151d24");
        ctx.strokeStyle = "#1b252d"; ctx.lineWidth = 4;
        for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(hook.x + i * 9, hook.y); ctx.lineTo(hook.x + i * 9 - 12, hook.y + 29); ctx.stroke(); }
        ctx.strokeStyle = "#b6c2c7"; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(hook.x + 16, hook.y + 34); ctx.lineTo(hook.x + 16, hook.y + 48); ctx.arc(hook.x + 16, hook.y + 52, 10, -Math.PI / 2, Math.PI * 0.85); ctx.stroke();
      }
      for (const m of masks) {
        roundRect(ctx, m.x, m.y, m.w, m.h, 3, "#508b9be0", "#8dd6e1");
        ctx.strokeStyle = "#acdce48c"; ctx.lineWidth = 1;
        for (let i = 10; i < m.w; i += 21) { ctx.beginPath(); ctx.moveTo(m.x + i, m.y + 5); ctx.lineTo(m.x + i - 6, m.y + m.h - 5); ctx.stroke(); }
        text(ctx, "MASKED", m.x + 35, m.y + m.h / 2 + 4, 12, "#e8fbff", "800");
      }
      const conditions = wind();
      if (conditions.warning || conditions.offset) {
        roundRect(ctx, 303, 78, 355, 29, 6, conditions.warning ? "#bd842a" : "#9e4d2a");
        text(ctx, conditions.warning ? "⚠  WIND INCOMING — WATCH YOUR FAN" : conditions.offset > 0 ? "CROSSWIND  → → →" : "← ← ←  CROSSWIND", 321, 98, 13, "#fff4df", "800");
      }
      for (const p of particles) { ctx.fillStyle = "rgba(240,239,219," + clamp(p.life * 4, 0, 1) + ")"; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
      if (pointer.inside && phase !== "result") {
        if (phase === "masking") {
          ctx.setLineDash([6, 5]); ctx.strokeStyle = masks.length < config().covers ? "#a3e3ef" : "#e2bd72"; ctx.lineWidth = 2;
          ctx.strokeRect(clamp(pointer.x - 65, 20, W - 150), clamp(pointer.y - 58, 80, H - 151), 130, 116); ctx.setLineDash([]);
        } else {
          const aimX = pointer.x + (cleanup ? 0 : conditions.offset), radius = cleanup ? 37 : narrow ? 26 : 53;
          ctx.strokeStyle = cleanup ? "#77d6ff" : "#f6e9ab"; ctx.lineWidth = 1.6;
          ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.arc(aimX, pointer.y, radius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(pointer.x - 8, pointer.y); ctx.lineTo(pointer.x + 8, pointer.y); ctx.moveTo(pointer.x, pointer.y - 8); ctx.lineTo(pointer.x, pointer.y + 8); ctx.stroke();
          if (sprayOn && !cleanup) { ctx.fillStyle = "#e7ead514"; ctx.beginPath(); ctx.arc(aimX, pointer.y, radius, 0, Math.PI * 2); ctx.fill(); }
        }
      }
      roundRect(ctx, 22, 552, 420, 31, 5, "#0c151ee8", "#344651");
      if (scan) {
        const m = coverage();
        text(ctx, "● THIN " + percent(m.thin), 34, 573, 12, "#efb764", "700");
        text(ctx, "● GOOD " + percent(m.coverage), 166, 573, 12, "#6be0b7", "700");
        text(ctx, "● EXCESS " + percent(m.excessive), 302, 573, 12, "#ff8fa7", "700");
      } else text(ctx, "N  NOZZLE     I  INSPECTION     C  CLEANUP", 38, 573, 12, "#bccbd6", "700");
      if (phase === "result") {
        roundRect(ctx, 265, 237, 430, 121, 12, "#0b141cf2", result.won ? "#62d7ac" : "#f0a85e");
        text(ctx, result.won ? "COAT ACCEPTED" : "REWORK REQUIRED", 299, 279, 27, result.won ? "#76e7bb" : "#ffc47c", "900");
        text(ctx, percent(coverage().coverage) + " in range  /  " + money(result.earnings) + " earned", 299, 311, 19, "#f1f4f5", "700");
        text(ctx, "Choose your next action below the canvas.", 299, 337, 13, "#a8bac8");
      }
      ctx.restore();
    }
    loadJob(0);
    return { update, draw, action, snapshot };
  }
  return Object.freeze({ create });
});
