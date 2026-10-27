/* FIRELINE's characters are drawn from game state. Drawing never changes the simulation. */
(function (root, factory) {
  "use strict";
  const art = factory();
  if (typeof module === "object" && module.exports) module.exports = art;
  else root.ClassifireFirelineArt = art;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const INK = "#18212d";
  function shape(ctx, fill, stroke = INK, width = 1.8) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
  }
  function oval(ctx, x, y, rx, ry, fill, stroke, width) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); shape(ctx, fill, stroke, width);
  }
  function disc(ctx, x, y, r, fill, stroke, width) { oval(ctx, x, y, r, r, fill, stroke, width); }
  function box(ctx, x, y, w, h, r, fill, stroke = INK, width = 1.8) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); shape(ctx, fill, stroke, width);
  }
  function line(ctx, points, colour, width) {
    ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  }
  function limb(ctx, points, fill, width = 5) { line(ctx, points, INK, width + 3); line(ctx, points, fill, width); }
  function flame(ctx, x, y, size, time, outer, inner) {
    const sway = Math.sin(time * 8 + x) * size * .12;
    ctx.beginPath(); ctx.moveTo(x - size * .45, y + size * .3);
    ctx.bezierCurveTo(x - size, y - size * .15, x - size * .2, y - size * .45, x - size * .12, y - size);
    ctx.bezierCurveTo(x + size * .45 + sway, y - size * .5, x + size * .6, y - size * .1, x + size * .42, y + size * .3);
    ctx.closePath(); shape(ctx, outer, "#5a2925", 1.1);
    oval(ctx, x, y + size * .02, size * .2, size * .4, inner, null);
  }
  function eyes(ctx, y, colour, angry, wide = 1) {
    for (const sign of [-1, 1]) {
      oval(ctx, sign * 4 * wide, y, 2.8, 3.1, "#fff7dc", INK, 1);
      disc(ctx, sign * 4 * wide + .7, y + .5, 1.1, colour, null);
      if (angry) line(ctx, [[sign * 7 * wide, y - 4], [sign * 2 * wide, y - 2]], INK, 2.4);
    }
  }
  function shadow(ctx, x, y, width, time = 0) {
    oval(ctx, x + 2, y + 17, width, 6 + Math.sin(time) * .3, "#03091470", null);
  }
  function drawPlayer(ctx, p, state = {}) {
    const time = state.time || 0, step = p.moving ? Math.sin(time * (p.dash > 0 ? 32 : 17)) : Math.sin(time * 2) * .07;
    const bob = p.moving ? Math.abs(step) * 1.8 : Math.sin(time * 2) * .45;
    const flash = p.hitFlash > 0;
    shadow(ctx, p.x, p.y, 17, time);
    ctx.save(); ctx.translate(p.x, p.y - bob); ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (p.boost > 0 || p.dash > 0) {
      oval(ctx, 0, 3, 23, 27, "#5fe8ff15", "#9bf2ff", 1.5);
      for (let j = 0; j < 3; j++) line(ctx, [[-17 - j * 3, 4 + j * 6], [-27 - j * 5, 5 + j * 6]], "#6edaf577", 2);
    }
    // Pressure cylinder, separate legs and reflective work boots make a person,
    // rather than a rotating marker, readable even at the normal arena scale.
    box(ctx, -14, -11, 10, 23, 4, "#9bb9c7", INK);
    box(ctx, -12, -8, 6, 13, 2, "#e8f6f4", null);
    limb(ctx, [[-5, 6], [-6 - step * 2, 12], [-8 - step * 3, 17 - step * 3]], "#36495b", 6);
    limb(ctx, [[5, 6], [5 + step * 2, 12], [7 + step * 3, 17 + step * 3]], "#506075", 6);
    box(ctx, -13 - step * 3, 15 - step * 3, 11, 6, 2, "#172432", "#899aa5", 1);
    box(ctx, 3 + step * 3, 15 + step * 3, 11, 6, 2, "#172432", "#899aa5", 1);
    box(ctx, -10, -10, 20, 21, 5, flash ? "#fff3db" : "#e8edf0", INK, 2);
    box(ctx, -7, -9, 5, 18, 1, "#dd344b", null);
    box(ctx, 4, -9, 4, 18, 1, "#dd344b", null);
    line(ctx, [[-9, 3], [9, 3]], "#fff6bc", 3);
    box(ctx, -11, 8, 23, 5, 1, "#25394b", INK, 1);
    box(ctx, -2, 8, 5, 4, 1, "#b9ccd0", null);
    limb(ctx, [[-10, -5], [-15, 1], [-11, 6]], "#c9d6de", 5);
    disc(ctx, -10, 6, 3.5, "#273d4c", INK, 1.2);
    // Aim the weapon independently: the head, hands and feet remain upright.
    const angle = Number.isFinite(p.angle) ? p.angle : 0, recoil = state.shooting ? Math.sin(time * 75) * 1.2 : 0;
    ctx.save(); ctx.rotate(angle); ctx.translate(-recoil, 0);
    ctx.beginPath(); ctx.moveTo(-10, 8); ctx.quadraticCurveTo(-18, 22, 8, 10); ctx.strokeStyle = "#111b28"; ctx.lineWidth = 4; ctx.stroke();
    box(ctx, 5, -4, 23, 8, 2, "#304958", "#c1e9f3", 1.2);
    box(ctx, 23, -6, 8, 12, 2, state.shooting ? "#d0ffff" : "#7babc1", INK, 1.5);
    box(ctx, 9, 1, 5, 9, 1, "#b72f45", INK, 1);
    limb(ctx, [[4, 8], [12, 8], [16, 2]], flash ? "#ffffff" : "#e7edf1", 4.5);
    disc(ctx, 16, 1, 3.2, "#273d4c", INK, 1);
    ctx.restore();
    // Helmet sits above the shoulders with an unmistakable visor and chin.
    oval(ctx, 0, -14, 9, 8, flash ? "#fff8df" : "#d8a77e", INK, 1.6);
    box(ctx, -9, -17, 18, 8, 3, "#173744", "#718b9e", 1);
    line(ctx, [[-6, -15], [3, -15]], "#b9eff8", 1.8);
    ctx.beginPath(); ctx.moveTo(-11, -18); ctx.quadraticCurveTo(-10, -30, 0, -29); ctx.quadraticCurveTo(11, -28, 11, -18); ctx.closePath(); shape(ctx, flash ? "#fff" : "#f0f2e7", INK, 2);
    box(ctx, -2, -29, 4, 11, 1, "#dd344b", null);
    box(ctx, -12, -19, 25, 4, 1.5, "#c9d4d9", INK, 1.2);
    box(ctx, -4, -24, 8, 5, 1, "#dd344b", null);
    line(ctx, [[-2, -22], [2, -22]], "#fff", 1.3);
    ctx.restore();
  }
  function drawMob(ctx, e, time) {
    const step = Math.sin(e.age * 9 + e.id), bob = Math.abs(step) * 1.2, flash = e.hitFlash > 0;
    ctx.translate(0, -bob);
    limb(ctx, [[-4, 5], [-6, 11], [-7 + step * 3, 17]], "#754832", 4);
    limb(ctx, [[4, 5], [6, 11], [7 - step * 3, 17]], "#9d5b35", 4);
    box(ctx, -11 + step * 3, 15, 9, 5, 1.5, "#30252b", INK, 1);
    box(ctx, 3 - step * 3, 15, 9, 5, 1.5, "#30252b", INK, 1);
    box(ctx, -8, -8, 16, 18, 4, flash ? "#fff5d7" : "#a65a35", INK, 1.8);
    box(ctx, -3, -8, 6, 17, 1, "#eab55f", null);
    line(ctx, [[-6, 4], [6, 4]], "#543643", 2);
    limb(ctx, [[-8, -5], [-13, 0], [-15, 7 + step * 2]], "#d58c52", 4);
    limb(ctx, [[8, -5], [13, -3], [15, -12 - step * 2]], "#d58c52", 4);
    disc(ctx, -15, 8 + step * 2, 3, "#e4b071", INK, 1);
    line(ctx, [[15, -10 - step * 2], [17, -21 - step * 2]], "#e3bc77", 2.2);
    flame(ctx, 17, -22 - step * 2, 6, time, "#ff653d", "#fff2ad");
    // A wooden match head with a face and flame hair.
    oval(ctx, 0, -15, 9.5, 10, flash ? "#fff0cf" : "#da6645", INK, 1.8);
    flame(ctx, -3, -23, 9, time, "#f77139", "#ffe290");
    flame(ctx, 3, -22, 7, time + 1, "#f69c40", "#fff0b0");
    eyes(ctx, -16, "#3b1723", true);
    ctx.beginPath(); ctx.moveTo(-4, -9); ctx.quadraticCurveTo(0, -5, 5, -10); shape(ctx, "#40202a", null);
    line(ctx, [[-2, -9], [2, -9]], "#ffe4ad", 1.3);
  }
  function drawRunner(ctx, e, time) {
    const step = Math.sin(e.age * 16 + e.id), flash = e.hitFlash > 0;
    ctx.translate(step * .6, -Math.abs(step)); ctx.rotate(.12);
    limb(ctx, [[-4, 4], [-7 - step * 4, 10], [-9 - step * 6, 18 - step * 2]], "#a14439", 4.2);
    limb(ctx, [[4, 4], [7 + step * 4, 10], [9 + step * 6, 18 + step * 2]], "#b6603c", 4.2);
    box(ctx, -14 - step * 6, 16 - step * 2, 10, 5, 1.5, "#eece78", INK, 1.3);
    box(ctx, 5 + step * 6, 16 + step * 2, 10, 5, 1.5, "#eece78", INK, 1.3);
    // Long elbows and a flying scarf give the flanker a different silhouette.
    limb(ctx, [[-7, -6], [-14, -2 - step * 4], [-14 + step * 4, -10]], "#ec9b4e", 4);
    limb(ctx, [[7, -6], [14, 2 + step * 3], [17 - step * 4, -4]], "#ec9b4e", 4);
    box(ctx, -7, -11, 15, 20, 4, flash ? "#fff4cf" : "#e39542", INK, 1.8);
    line(ctx, [[-4, -8], [3, 3], [-3, 6]], "#ffe3a1", 2);
    ctx.beginPath(); ctx.moveTo(-3, -9); ctx.lineTo(-19, -8 - step * 3); ctx.lineTo(-26, -14 - step * 3); ctx.lineTo(-19, -17 - step * 3); ctx.lineTo(-7, -13); ctx.closePath(); shape(ctx, "#b63147", INK, 1.2);
    oval(ctx, 1, -19, 9, 10, flash ? "#fff1d1" : "#eac085", INK, 1.8);
    // Hood, slit goggles and deliberately humanoid jaw.
    ctx.beginPath(); ctx.moveTo(-8, -19); ctx.quadraticCurveTo(-10, -33, 2, -31); ctx.quadraticCurveTo(12, -29, 11, -17); ctx.lineTo(8, -22); ctx.lineTo(-5, -24); ctx.closePath(); shape(ctx, "#933746", INK, 1.8);
    box(ctx, -6, -22, 15, 6, 2, "#273039", INK, 1);
    line(ctx, [[-4, -20], [0, -19]], "#ffdc72", 1.5); line(ctx, [[3, -19], [7, -21]], "#ffdc72", 1.5);
    line(ctx, [[1, -12], [6, -13]], "#793d39", 1.8);
    flame(ctx, 10, -31, 5, time + .3, "#fa9745", "#ffdb8f");
  }
  function drawDrone(ctx, e, time) {
    const bob = Math.sin(e.age * 4) * 2.5, flash = e.hitFlash > 0;
    ctx.translate(0, -bob - 2);
    // Hovering humanoid: articulated arms, dangling legs and a face display.
    for (const sign of [-1, 1]) {
      box(ctx, sign * 12 - 4, -7, 8, 18, 3, "#4d3c6d", INK, 1.8);
      flame(ctx, sign * 12, 18, 6 + Math.sin(time * 20) * 2, time, "#a9b9ff", "#e1ffff");
      limb(ctx, [[sign * 5, 8], [sign * 6, 16]], "#7475a8", 4);
      box(ctx, sign * 6 - 3, 13, 7, 6, 2, "#bdafe7", INK, 1.2);
      limb(ctx, [[sign * 8, -6], [sign * 17, 1], [sign * 16, 7]], "#a99bd5", 4);
      disc(ctx, sign * 16, 8, 4, "#8a70b8", INK, 1.2);
    }
    box(ctx, -9, -11, 18, 23, 5, flash ? "#fff4ff" : "#a393cf", INK, 2);
    box(ctx, -5, 1, 10, 7, 2, "#493956", INK, 1);
    disc(ctx, 0, 4, 3, "#ffae60", null);
    line(ctx, [[-2, -25], [-5, -31]], "#c0a9dd", 2);
    disc(ctx, -6, -32, 2.5, "#ffa45f", INK, 1);
    box(ctx, -12, -25, 24, 18, 6, flash ? "#fff" : "#6a567d", INK, 1.8);
    box(ctx, -9, -22, 18, 11, 3, "#191c32", "#d4b8f1", 1);
    line(ctx, [[-6, -19], [-2, -17]], "#ffbd75", 2);
    line(ctx, [[2, -17], [6, -19]], "#ffbd75", 2);
    line(ctx, [[-2, -13], [3, -13]], "#d4a9df", 1);
  }
  function drawMonster(ctx, e, time) {
    const radius = e.radius || 44, scale = radius / 44, flash = e.hitFlash > 0;
    const recovery = e.recovery > 0, mad = !!e.enraged, bounce = Math.sin(e.age * (mad ? 6 : 3.5));
    ctx.scale(scale, scale); ctx.translate(0, -Math.abs(bounce) * 3);
    ctx.scale(1 + bounce * .025, 1 - bounce * .025);
    const dark = mad ? "#ac2865" : "#c94483", medium = flash ? "#fff0fa" : mad ? "#ed65a6" : "#f28abb", light = "#ffd7e9";
    // Frothy arms and mitten hands frame the body without hiding the attack lane.
    for (const sign of [-1, 1]) {
      const lift = recovery ? 8 : e.strike > 0 ? -8 : Math.sin(time * 3 + sign) * 4;
      limb(ctx, [[sign * 31, 3], [sign * 44, -2 + lift], [sign * 52, -12 + lift]], dark, 11);
      disc(ctx, sign * 50, -11 + lift, 11, medium, dark, 2.2);
      disc(ctx, sign * 56, -15 + lift, 5, light, dark, 1.2);
      disc(ctx, sign * 46, -18 + lift, 6, medium, dark, 1.2);
    }
    // Overlapping lobes create one giant expanding-foam ball, not a furry disk.
    disc(ctx, 0, 0, 42, dark, "#6e234d", 2.5);
    for (let i = 0; i < 13; i++) {
      const a = i * Math.PI * 2 / 13, r = 34 + Math.sin(i * 2.7) * 2, size = 10 + (i % 3) * 1.8;
      disc(ctx, Math.cos(a) * r, Math.sin(a) * r, size, i > 6 ? medium : dark, "#a4346c", 1.5);
    }
    const coat = ctx.createRadialGradient(-15, -23, 5, 0, 1, 48);
    coat.addColorStop(0, flash ? "#fff" : "#ffd0e6"); coat.addColorStop(.5, medium); coat.addColorStop(1, dark);
    oval(ctx, 0, -2, 39, 39, coat, null);
    // Big and small translucent bubbles are placed deterministically.
    for (let i = 0; i < 19; i++) {
      const a = i * 2.399, r = 18 + i % 4 * 5, x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (Math.abs(x) < 27 && y > -22 && y < 23) continue;
      const size = 4 + i % 4;
      disc(ctx, x, y, size, "#ffbadb6b", "#ffe3f29c", 1);
      oval(ctx, x - size * .3, y - size * .3, size * .34, size * .2, "#fff2f6b0", null);
    }
    // Face has eyebrows, cheeks, teeth and a foam-spitting mouth.
    oval(ctx, -24, 3, 8, 6, "#e65399", null); oval(ctx, 24, 3, 8, 6, "#e65399", null);
    for (const sign of [-1, 1]) {
      oval(ctx, sign * 13, -12, 9, recovery ? 4 : 10, "#fff6ee", "#80284f", 2);
      oval(ctx, sign * 11, recovery ? -11 : -10, 3, recovery ? 2 : 5, mad ? "#9c164f" : "#302036", null);
      disc(ctx, sign * 11 - 1, -12, 1.2, "#fff", null);
      line(ctx, [[sign * 22, -26], [sign * 7, recovery ? -20 : -17]], "#84244f", 5);
    }
    ctx.beginPath(); ctx.moveTo(-19, 8); ctx.quadraticCurveTo(0, recovery ? 13 : -2, 19, 8);
    ctx.quadraticCurveTo(18, recovery ? 27 : 32, 0, recovery ? 27 : 31); ctx.quadraticCurveTo(-18, 28, -19, 8); ctx.closePath(); shape(ctx, "#61213f", "#93264e", 2);
    for (let i = -1; i <= 1; i++) box(ctx, i * 9 - 3, 7, 6, 7, 1, "#fff6e9", null);
    oval(ctx, 0, 24, 10, 4, "#ed5fa2", null);
    for (const [x, y, size] of [[-17, 15, 5], [16, 16, 6], [20, 22, 5], [-13, 27, 4], [14, 31, 4]]) {
      disc(ctx, x, y + Math.sin(time * 5 + x) * 1.2, size, light, "#e478ad", 1);
    }
    oval(ctx, -12, -33, 10, 4, "#fff0f57a", null);
    if (e.shield) {
      // A thin pink crust, with deliberate gaps, differs from cyan player foam.
      ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.arc(0, 0, 49, time * .4, time * .4 + Math.PI * 2);
      ctx.strokeStyle = "#ffd0e9a0"; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function drawEnemy(ctx, e, state = {}) {
    const time = state.time || e.age || 0;
    shadow(ctx, e.x, e.y, e.type === "boss" ? (e.radius || 44) * 1.05 : e.type === "drone" ? 19 : 15, time);
    ctx.save(); ctx.translate(e.x, e.y); ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (e.type === "boss") drawMonster(ctx, e, time);
    else if (e.type === "runner") drawRunner(ctx, e, time);
    else if (e.type === "drone") drawDrone(ctx, e, time);
    else drawMob(ctx, e, time);
    ctx.restore();
  }
  function drawPortrait(ctx, x, y, scale, type = "player", time = 0) {
    ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
    if (type === "player") drawPlayer(ctx, { x: 0, y: 0, angle: -.18, moving: false, health: 100 }, { time });
    else drawEnemy(ctx, { x: 0, y: 0, id: 1, age: time, type, radius: type === "boss" ? 44 : 12, hp: 100, max: 100 }, { time });
    ctx.restore();
  }
  return Object.freeze({ drawPlayer, drawEnemy, drawPortrait });
});
