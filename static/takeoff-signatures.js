"use strict";

// Signatures are bounded vector drawing notes. No HTML, image URLs or executable
// SVG content can enter a project through this editor.
(function (root) {
  const storageKey = "ceasefire.takeoff-signature.v1";
  function validateStrokes(strokes) {
    if (!Array.isArray(strokes) || !strokes.length || strokes.length > 100) throw new Error("Draw between 1 and 100 signature strokes.");
    let total = 0;
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || !stroke.length) throw new Error("Every signature stroke needs a point.");
      total += stroke.length;
      if (total > 4000) throw new Error("A signature supports at most 4,000 points. Clear the pad and draw a simpler signature.");
      for (const point of stroke) if (!Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Signature points must be finite positions inside the drawing pad.");
    }
    return strokes;
  }
  function template(value) {
    if (!value || value.version !== 1 || Object.keys(value).some(key => !["version", "strokes", "ratio"].includes(key)) || typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio < .1 || value.ratio > 20) throw new Error("The saved signature is invalid. Draw it again.");
    validateStrokes(value.strokes); return value;
  }
  function project(strokes, quad) {
    validateStrokes(strokes);
    if (!Array.isArray(quad) || quad.length !== 4 || quad.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("Choose a valid signature rectangle.");
    return strokes.map(stroke => stroke.map(([x, y]) => quad[0].map((value, axis) => value + x * (quad[1][axis] - value) + y * (quad[3][axis] - value))));
  }
  function crop(strokes, width, height) {
    validateStrokes(strokes);
    if (![width, height].every(value => typeof value === "number" && Number.isFinite(value) && value > 0)) throw new Error("The signature pad needs positive finite dimensions.");
    const points = strokes.flat(), xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const left = Math.min(...xs), top = Math.min(...ys);
    let dx = Math.max(2 / width, Math.max(...xs) - left), dy = Math.max(2 / height, Math.max(...ys) - top);
    // Pad extreme bounds instead of stretching the user's ink.
    if (dx * width / (dy * height) > 20) dy = dx * width / (20 * height);
    if (dx * width / (dy * height) < .1) dx = .1 * dy * height / width;
    return template({ version: 1, ratio: Math.max(.1, Math.min(20, dx * width / (dy * height))), strokes: strokes.map(stroke => stroke.map(([x, y]) => [(x - left) / dx, (y - top) / dy])) });
  }
  function saved() { try { return template(JSON.parse(root.localStorage.getItem(storageKey))); } catch { return null; } }
  async function choose(initial = null) {
    const doc = root.document, dialog = doc.createElement("dialog"), title = doc.createElement("h2"), intro = doc.createElement("p"), pad = doc.createElement("canvas"), status = doc.createElement("p"), actions = doc.createElement("div");
    dialog.className = "modal takeoff-signature-dialog"; title.id = "takeoff-signature-title"; title.textContent = "Signatures"; dialog.setAttribute("aria-labelledby", title.id);
    intro.textContent = "Draw your signature, then click the drawing to place it."; pad.width = 620; pad.height = 210; pad.className = "takeoff-signature-pad"; pad.setAttribute("aria-label", "Signature drawing pad");
    status.className = "helper"; status.setAttribute("role", "status"); actions.className = "actions";
    const remember = doc.createElement("input"), rememberLabel = doc.createElement("label"); remember.type = "checkbox"; remember.checked = true; rememberLabel.append(remember, doc.createTextNode(" Remember this signature on this computer"));
    const make = (label, fn, primary = false) => { const control = doc.createElement("button"); control.type = "button"; control.className = "button " + (primary ? "primary" : "secondary"); control.textContent = label; control.addEventListener("click", fn); return control; };
    const strokes = []; let active = null, pointer = null, invalid = false, result = null;
    const ctx = pad.getContext("2d"), prior = initial ? template(initial) : saved();
    function paint() {
      ctx.clearRect(0, 0, pad.width, pad.height); ctx.strokeStyle = "#000000"; ctx.fillStyle = "#000000"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const stroke of strokes) {
        ctx.beginPath(); stroke.forEach(([x, y], index) => index ? ctx.lineTo(x * pad.width, y * pad.height) : ctx.moveTo(x * pad.width, y * pad.height)); ctx.stroke();
        if (stroke.length === 1) { ctx.beginPath(); ctx.arc(stroke[0][0] * pad.width, stroke[0][1] * pad.height, 1, 0, 2 * Math.PI); ctx.fill(); }
      }
      insert.disabled = invalid || !strokes.length;
    }
    const finish = value => { result = JSON.parse(JSON.stringify(value)); if (remember.checked) { try { root.localStorage.setItem(storageKey, JSON.stringify(result)); } catch { /* Placement still works if browser storage is unavailable. */ } } dialog.close("insert"); };
    const insert = make("Insert signature", () => { try { const rect = pad.getBoundingClientRect(); finish(crop(strokes, rect.width, rect.height)); } catch (error) { status.textContent = error.message; } }, true);
    const clear = make("Clear pad", () => { if (pointer !== null && pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer); pointer = null; active = null; invalid = false; strokes.length = 0; status.textContent = ""; paint(); });
    const cancel = make("Cancel", () => dialog.close("cancel")); actions.append(clear, insert, cancel); insert.disabled = true;
    if (prior) {
      const preview = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); preview.setAttribute("viewBox", `0 0 ${200 * prior.ratio} 200`); preview.setAttribute("width", "200"); preview.setAttribute("height", "70"); preview.setAttribute("role", "img"); preview.setAttribute("aria-label", "Saved signature preview"); preview.classList.add("takeoff-signature-preview");
      for (const stroke of prior.strokes) {
        const path = doc.createElementNS(preview.namespaceURI, "path"); path.setAttribute("d", stroke.map(([x, y], index) => `${index ? "L" : "M"}${x * 200 * prior.ratio},${y * 200}`).join(" ") + (stroke.length === 1 ? " l.01 .01" : "")); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "3"); path.setAttribute("stroke-linecap", "round"); preview.append(path);
      }
      dialog.append(preview); actions.prepend(make("Use saved signature", () => finish(prior), true));
    }
    function add(event) {
      const rect = pad.getBoundingClientRect(), point = [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
      if (!active || invalid || active.length && Math.hypot(point[0] - active.at(-1)[0], point[1] - active.at(-1)[1]) < .0001) return;
      if (strokes.reduce((sum, stroke) => sum + stroke.length, 0) >= 4000) { invalid = true; status.textContent = "Signature point limit reached. Clear the pad and draw a simpler signature."; paint(); return; }
      active.push(point); paint();
    }
    pad.addEventListener("pointerdown", event => { if (event.button !== 0 || pointer !== null || invalid) return; if (strokes.length >= 100) { invalid = true; status.textContent = "Signature stroke limit reached. Clear the pad and draw a simpler signature."; paint(); return; } event.preventDefault(); pointer = event.pointerId; active = []; strokes.push(active); pad.setPointerCapture(pointer); add(event); });
    pad.addEventListener("pointermove", event => { if (pointer === event.pointerId && active) { event.preventDefault(); add(event); } });
    const release = event => { if (pointer !== event.pointerId) return; if (event.type === "pointerup") add(event); if (pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer); pointer = null; active = null; };
    pad.addEventListener("pointerup", release); pad.addEventListener("pointercancel", release); pad.addEventListener("lostpointercapture", release);
    dialog.addEventListener("cancel", event => { event.preventDefault(); dialog.close("cancel"); });
    dialog.prepend(title, intro); dialog.append(pad, status, rememberLabel, actions); doc.body.append(dialog);
    try { dialog.showModal(); await new Promise(resolve => dialog.addEventListener("close", resolve, { once: true })); return result; } finally { dialog.remove(); }
  }
  const api = Object.freeze({ validateStrokes, template, project, crop, choose });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffSignatures = api;
})(typeof window === "object" ? window : null);
