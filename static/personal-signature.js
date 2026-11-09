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
  async function profileKey() {
    if (!root.fetch) return storageKey;
    const response = await root.fetch("/api/scheduler/bootstrap", {cache:"no-store", credentials:"same-origin"});
    if (!response.ok) throw new Error("Could not load your signature profile. Try again.");
    const profile = await response.json();
    const access = root.ClassifireAccess;
    if (access?.ready) await access.ready;
    if (access?.enabled && (!access.user?.id || profile.user?.id !== access.user.id))
      throw new Error("Your signature profile changed. Reopen the signature pad.");
    return profile.user ? storageKey + "." + profile.user.id : storageKey;
  }
  async function previousLocalSignature(key) {
    const access = root.ClassifireAccess;
    if (!access?.can('admin') || access.user?.role !== 'admin' || key !== storageKey+'.'+access.user.id) return null;
    // Scheduler has a separate cookie in older installations. Confirm the app's
    // current named administrator as well before exposing the shared local ink.
    const response = await root.fetch('/api/access/session',{cache:'no-store',credentials:'same-origin'});
    if (!response.ok) return null;
    const {user} = await response.json();
    if (user?.role !== 'admin' || key !== storageKey+'.'+user.id) return null;
    if (await profileKey() !== key) return null;
    try {
      if (root.localStorage.getItem(key) !== null || root.sessionStorage?.getItem(key) != null) return null;
      return template(JSON.parse(root.localStorage.getItem(storageKey)));
    } catch { return null; }
  }
  function signaturePreview(doc, value) {
    const preview = doc.createElementNS('http://www.w3.org/2000/svg','svg');
    preview.setAttribute('viewBox',`0 0 ${200 * value.ratio} 200`);
    preview.setAttribute('width','200'); preview.setAttribute('height','70');
    preview.setAttribute('role','img'); preview.setAttribute('aria-label','Saved signature preview');
    preview.classList.add('takeoff-signature-preview');
    for (const stroke of value.strokes) {
      const path = doc.createElementNS(preview.namespaceURI,'path');
      const points = stroke.map(([x,y],i)=>`${i?'L':'M'}${x*200*value.ratio},${y*200}`).join(' ');
      path.setAttribute('d',points+(stroke.length===1?' l.01 .01':''));
      path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor');
      path.setAttribute('stroke-width','3'); path.setAttribute('stroke-linecap','round'); preview.append(path);
    }
    return preview;
  }
  function readSaved(key) {
    try {
      const stored = root.sessionStorage?.getItem(key) ?? root.localStorage.getItem(key);
      return template(JSON.parse(stored));
    } catch { return null; }
  }
  async function saved() { return readSaved(await profileKey()); }
  async function choose(initial = null, initialPages = false, mode = "takeoff", key = null) {
    key ??= await profileKey();
    const doc = root.document, dialog = doc.createElement("dialog"), title = doc.createElement("h2"), intro = doc.createElement("p"), pad = doc.createElement("canvas"), status = doc.createElement("p"), actions = doc.createElement("div");
    dialog.className = "modal takeoff-signature-dialog"; title.id = "takeoff-signature-title"; title.textContent = mode === "settings" ? "Personal signature" : initialPages ? "Initial Pages" : "Signatures"; dialog.setAttribute("aria-labelledby", title.id);
    intro.textContent = initialPages ? "Enter your name or initials, draw a signature, or use both. They will fit inside the selected area on every page of this document." : mode === "settings" ? "Draw the signature to save in Personal Details." : (mode === "document" || mode === "swms") ? "Draw a signature for this document." : "Draw your signature, then click the drawing to place it."; pad.width = 620; pad.height = 210; pad.className = "takeoff-signature-pad"; pad.setAttribute("aria-label", "Signature drawing pad");
    const name = doc.createElement("input"), nameLabel = doc.createElement("label"); name.type = "text"; name.maxLength = 80; name.setAttribute("aria-label", "Name or initials"); nameLabel.className = "field"; nameLabel.append(doc.createTextNode("Name or initials"), name);
    status.className = "helper"; status.setAttribute("role", "status"); actions.className = "actions";
    const remember = doc.createElement("input"), rememberLabel = doc.createElement("label"), rememberText = doc.createElement("span"); remember.type = "checkbox"; remember.checked = true; rememberLabel.className = "takeoff-signature-remember"; rememberText.textContent = "Remember this signature on this computer"; rememberLabel.append(remember, rememberText);
    const make = (label, fn, primary = false) => { const control = doc.createElement("button"); control.type = "button"; control.className = "button " + (primary ? "primary" : "secondary"); control.textContent = label; control.addEventListener("click", fn); return control; };
    const strokes = []; let active = null, pointer = null, invalid = false, result = null;
    const ctx = pad.getContext("2d"), prior = initial ? template(initial) : readSaved(key);
    let adoption = null, legacyReview = null;
    function paint() {
      ctx.clearRect(0, 0, pad.width, pad.height); ctx.strokeStyle = "#000000"; ctx.fillStyle = "#000000"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const stroke of strokes) {
        ctx.beginPath(); stroke.forEach(([x, y], index) => index ? ctx.lineTo(x * pad.width, y * pad.height) : ctx.moveTo(x * pad.width, y * pad.height)); ctx.stroke();
        if (stroke.length === 1) { ctx.beginPath(); ctx.arc(stroke[0][0] * pad.width, stroke[0][1] * pad.height, 1, 0, 2 * Math.PI); ctx.fill(); }
      }
      insert.disabled = invalid || pointer !== null || (!adoption && !strokes.length && (!initialPages || !name.value.trim()));
      if (legacyReview) legacyReview.disabled = Boolean(adoption) || Boolean(strokes.length) || pointer !== null;
    }
    let finishing = false;
    const finish = async value => {
      if (finishing || !dialog.open) return;
      finishing = true;
      try {
        if (await profileKey() !== key) throw new Error("Your signature profile changed. Reopen the signature pad.");
        if (adoption && JSON.stringify(await previousLocalSignature(key)) !== JSON.stringify(adoption))
          throw new Error("Your signature profile changed. Reopen the signature pad.");
        if (!dialog.open) return;
        if (value && (mode === "settings" || mode === "takeoff" && remember.checked)) {
          const encoded = JSON.stringify(value);
          try {
            if (remember.checked) {root.localStorage.setItem(key, encoded); root.sessionStorage?.removeItem(key);}
            else {root.sessionStorage.setItem(key, encoded); root.localStorage.removeItem(key);}
          } catch {if (mode === "settings") throw new Error("This browser could not save your signature.");}
        }
        result = JSON.parse(JSON.stringify(initialPages ? {name:name.value.trim(),signature:value} : value));
        dialog.close("insert");
      } catch (error) {status.textContent = error.message;}
      finally {finishing = false;}
    };
    const insert = make(initialPages ? "OK" : "Insert signature", () => { try { if (adoption) {void finish(adoption);return;} if (invalid || pointer !== null) throw new Error("Finish drawing or clear the signature pad."); if (!strokes.length && (!initialPages || !name.value.trim())) throw new Error("Enter a name or initials, or draw a signature."); const rect = pad.getBoundingClientRect(); void finish(strokes.length ? crop(strokes, rect.width, rect.height) : null); } catch (error) { status.textContent = error.message; } }, true);
    const clear = make("Clear pad", () => { if (pointer !== null && pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer); pointer = null; active = null; invalid = false; strokes.length = 0; status.textContent = ""; paint(); });
    if (mode === "swms") {
      clear.classList.add("swms-icon-action", "icon-only");
      clear.setAttribute("aria-label", "Clear pad"); clear.title = "Clear pad";
      const icon = doc.querySelector("#penetration-clear svg").cloneNode(true);
      icon.setAttribute("aria-hidden","true"); clear.replaceChildren(icon);
    }
    const cancel = make("Cancel", () => dialog.close("cancel")), footer = doc.createElement("div");
    footer.className = "actions takeoff-signature-footer"; footer.append(clear, cancel);
    actions.append(insert); insert.disabled = true;
    if (prior) {
      dialog.append(signaturePreview(doc, prior)); actions.prepend(make("Use saved signature", () => {
        if (!initialPages) { finish(prior); return; }
        if (pointer !== null) return;
        const width = Math.min(.9, .8 * pad.height * prior.ratio / pad.width), height = width * pad.width / (prior.ratio * pad.height);
        strokes.splice(0, strokes.length, ...prior.strokes.map(stroke => stroke.map(([x,y]) => [(1-width)/2+x*width, (1-height)/2+y*height]))); invalid = false; status.textContent = "Saved signature selected. Click OK to initial all pages."; paint();
      }, true));
    } else if (mode === "settings" && await previousLocalSignature(key)) {
      let reviewed = null, checking = false;
      const caption = (control, text) => {
        control.textContent = text;
        root.CeasefireI18n?.text(control,text);
      };
      legacyReview = make('Review previous local signature', async () => {
        if (checking || finishing || pointer !== null || strokes.length) return;
        checking = true;
        try {
          const previous = await previousLocalSignature(key);
          if (!dialog.open || pointer !== null || strokes.length) return;
          if (!previous || (reviewed && JSON.stringify(previous) !== JSON.stringify(reviewed)))
            throw new Error('Your signature profile changed. Reopen the signature pad.');
          if (!reviewed) {
            reviewed = previous;
            pad.before(signaturePreview(doc,reviewed));
            caption(legacyReview,'Use saved signature');
          } else {
            adoption = reviewed;
            caption(insert,'Save');
            pad.hidden = true; clear.disabled = true;
            paint(); insert.focus();
          }
        } catch(error) {status.textContent=error.message;}
        finally {checking=false;}
      });
      caption(legacyReview,'Review previous local signature'); actions.prepend(legacyReview);
    } else if (mode === "settings") {
      const usePrior = make("Use saved signature", () => {});
      usePrior.disabled = true; actions.prepend(usePrior);
    }
    function add(event) {
      const rect = pad.getBoundingClientRect(), point = [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
      if (!active || invalid || active.length && Math.hypot(point[0] - active.at(-1)[0], point[1] - active.at(-1)[1]) < .0001) return;
      if (strokes.reduce((sum, stroke) => sum + stroke.length, 0) >= 4000) { invalid = true; status.textContent = "Signature point limit reached. Clear the pad and draw a simpler signature."; paint(); return; }
      active.push(point); paint();
    }
    pad.addEventListener("pointerdown", event => { if (event.button !== 0 || pointer !== null || invalid) return; if (strokes.length >= 100) { invalid = true; status.textContent = "Signature stroke limit reached. Clear the pad and draw a simpler signature."; paint(); return; } event.preventDefault(); pointer = event.pointerId; active = []; strokes.push(active); pad.setPointerCapture(pointer); add(event); });
    pad.addEventListener("pointermove", event => { if (pointer === event.pointerId && active) { event.preventDefault(); add(event); } });
    const release = event => { if (pointer !== event.pointerId) return; if (event.type === "pointerup") add(event); const released = pointer; pointer = null; active = null; if (pad.hasPointerCapture(released)) pad.releasePointerCapture(released); paint(); };
    pad.addEventListener("pointerup", release); pad.addEventListener("pointercancel", release); pad.addEventListener("lostpointercapture", release);
    dialog.addEventListener("cancel", event => { event.preventDefault(); dialog.close("cancel"); });
    name.addEventListener("input", paint);
    dialog.prepend(title, intro); if (initialPages) { const signatureLabel = doc.createElement("p"); signatureLabel.textContent = "Signature"; dialog.append(nameLabel, signatureLabel); } dialog.append(pad, status); if (mode === "takeoff" || mode === "settings") dialog.append(rememberLabel); dialog.append(actions, footer); doc.body.append(dialog);
    try { dialog.showModal(); await new Promise(resolve => dialog.addEventListener("close", resolve, { once: true })); return result; } finally { dialog.remove(); }
  }
  const api = Object.freeze({ validateStrokes, template, project, crop, choose, chooseInitial: () => choose(null, true) });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.ClassifireSignaturePad = api;
    root.ClassifirePersonalSignature = Object.freeze({
      saved,
      async choose(existing = null, kind = "document") {
        const key = await profileKey(), personal = readSaved(key);
        if (!existing && personal) return personal;
        return choose(null, false, kind === "swms" ? "swms" : "document", key);
      },
      png(value) {
        template(value);
        const canvas = root.document.createElement("canvas");
        canvas.width = 800; canvas.height = Math.min(800, Math.max(40, Math.round(800/value.ratio)));
        const width = Math.min(canvas.width-12, (canvas.height-12)*value.ratio), height = width/value.ratio;
        const ctx = canvas.getContext("2d"), x0 = (canvas.width-width)/2, y0 = (canvas.height-height)/2;
        ctx.strokeStyle = ctx.fillStyle = "#151515"; ctx.lineWidth = 2.5; ctx.lineCap = ctx.lineJoin = "round";
        for (const stroke of value.strokes) {
          ctx.beginPath();
          for (const [i, point] of stroke.entries()) ctx[i ? "lineTo" : "moveTo"](x0+point[0]*width, y0+point[1]*height);
          ctx.stroke();
          if (stroke.length === 1) {ctx.beginPath();ctx.arc(x0+stroke[0][0]*width,y0+stroke[0][1]*height,1.25,0,2*Math.PI);ctx.fill();}
        }
        return canvas.toDataURL("image/png");
      }
    });
    const settings = root.document?.getElementById?.("personal-signature-set");
    settings?.addEventListener("click", async () => {
      const status = root.document.getElementById("personal-signature-status");
      try {
        const value = await choose(null, false, "settings");
        if (value) status.textContent = "Personal signature saved.";
      } catch (error) { status.textContent = error.message; }
    });
  }
})(typeof window === "object" ? window : null);
