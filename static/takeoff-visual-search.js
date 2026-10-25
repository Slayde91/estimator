"use strict";

// Search proposes source locations. Only an explicit physical preview/apply can
// create draft records; a graphical match does not identify a fire system.
((root) => {
  const limits = Object.freeze({ pixels: 2400000, template: 512, pages: 32, results: 500, batch: 100, milliseconds: 180000 });
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const abort = signal => { if (signal?.aborted) { const error = new Error("Visual search stopped."); error.name = "AbortError"; throw error; } };
  function image(value) {
    if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width * value.height > limits.pixels || !value.data || value.data.length !== value.width * value.height * 4) throw new Error("Visual search received an invalid or excessive page bitmap.");
    const gray = new Uint8Array(value.width * value.height);
    for (let i = 0; i < gray.length; i++) { const n = i * 4, alpha = value.data[n + 3] / 255; gray[i] = Math.round((value.data[n] * .299 + value.data[n + 1] * .587 + value.data[n + 2] * .114) * alpha + 255 * (1 - alpha)); }
    return { width: value.width, height: value.height, data: gray };
  }
  function rotate(value, degrees) {
    const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const width = Math.max(1, Math.ceil(Math.abs(value.width * c) + Math.abs(value.height * s) - 1e-8));
    const height = Math.max(1, Math.ceil(Math.abs(value.width * s) + Math.abs(value.height * c) - 1e-8));
    const data = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = x + .5 - width / 2, dy = y + .5 - height / 2;
      const xx = Math.floor(c * dx + s * dy + value.width / 2), yy = Math.floor(-s * dx + c * dy + value.height / 2);
      if (xx >= 0 && xx < value.width && yy >= 0 && yy < value.height) data[y * width + x] = value.data[yy * value.width + xx];
    }
    return { width, height, data };
  }
  function resize(value, ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("The page's search render scale is invalid.");
    if (Math.abs(ratio - 1) < 1e-8) return value;
    const width = Math.round(value.width * ratio), height = Math.round(value.height * ratio);
    if (width < 8 || height < 8 || width > limits.template || height > limits.template) throw new Error("The example is too small or too large at this page's render scale. Search this page with a new example.");
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = value.data[Math.min(value.height - 1, Math.floor((y + .5) / ratio)) * value.width + Math.min(value.width - 1, Math.floor((x + .5) / ratio))];
    return { width, height, data };
  }
  function probes(template) {
    const dark = [], light = [], all = [], values = template.data;
    let total = 0; for (const v of values) total += v; const mean = total / values.length;
    for (let y = 0; y < template.height; y++) for (let x = 0; x < template.width; x++) {
      const value = values[y * template.width + x], point = { x, y, value };
      (value < mean - 12 ? dark : light).push(point); all.push(point);
    }
    if (dark.length < 4 || light.length < 4) throw new Error("Select a symbol with both foreground detail and a small clear background margin.");
    const take = (items, count) => Array.from({ length: Math.min(count, items.length) }, (_, i) => items[Math.floor(i * items.length / Math.min(count, items.length))]);
    const selected = [...take(dark, 64), ...take(light, 64)];
    const average = selected.reduce((sum, p) => sum + p.value, 0) / selected.length;
    const variance = selected.reduce((sum, p) => sum + (p.value - average) ** 2, 0);
    if (variance / selected.length < 100) throw new Error("This selection has too little contrast. Choose a clearer symbol.");
    return { selected: selected.map(p => ({ ...p, centered: p.value - average })), norm: Math.sqrt(variance) };
  }
  function score(page, x, y, pattern) {
    let total = 0, squared = 0, cross = 0;
    for (const p of pattern.selected) { const value = page.data[(y + p.y) * page.width + x + p.x]; total += value; squared += value * value; cross += value * p.centered; }
    const variance = squared - total * total / pattern.selected.length;
    return variance > 1 ? Math.max(-1, Math.min(1, cross / (pattern.norm * Math.sqrt(variance)))) : -1;
  }
  function overlap(a, b) {
    const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return intersection / Math.min(a.width * a.height, b.width * b.height);
  }
  function suppress(matches, maximum = limits.results) {
    const kept = [], buckets = new Map(), cell = matches.reduce((size, value) => Math.max(size, value.width, value.height), 8);
    for (const match of [...matches].sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x || a.rotation - b.rotation)) {
      const bx = Math.floor((match.x + match.width / 2) / cell), by = Math.floor((match.y + match.height / 2) / cell);
      let duplicate = false;
      for (let dx = -1; dx <= 1 && !duplicate; dx++) for (let dy = -1; dy <= 1 && !duplicate; dy++) if ((buckets.get(`${bx+dx}:${by+dy}`) || []).some(prior => overlap(prior, match) > .3)) duplicate = true;
      if (duplicate) continue;
      kept.push(match); if (kept.length > maximum) throw new Error(`More than ${maximum} matches were found. Use a tighter sample or fewer pages; no partial result set is applied.`);
      const key = `${bx}:${by}`, bucket = buckets.get(key) || []; bucket.push(match); buckets.set(key, bucket);
    }
    return kept.sort((a, b) => a.y - b.y || a.x - b.x || a.rotation - b.rotation);
  }
  async function find(page, template, options = {}) {
    if (!page || !template || ![page.width,page.height,template.width,template.height].every(value => Number.isInteger(value) && value > 0) || !(page.data instanceof Uint8Array) || !(template.data instanceof Uint8Array) || page.data.length !== page.width * page.height || template.data.length !== template.width * template.height || page.width * page.height > limits.pixels || template.width < 8 || template.height < 8 || template.width > limits.template || template.height > limits.template) throw new Error("Choose a sample between 8 and 512 rendered pixels on each side.");
    const sensitivity = options.sensitivity ?? .88;
    if (!Number.isFinite(sensitivity) || sensitivity < .6 || sensitivity > .99) throw new Error("Choose a sensitivity from 60 to 99 percent.");
    const rotations = options.rotations ? [0, 45, 90, 135, 180, 225, 270, 315] : [0];
    const deadline = options.deadline ?? Date.now() + limits.milliseconds, candidates = [];
    for (const rotation of rotations) {
      abort(options.signal); const value = rotate(template, rotation), pattern = probes(value);
      if (value.width > page.width || value.height > page.height) continue;
      // A two-pixel coarse pass is refined at full-pixel precision. The coarse
      // threshold is deliberately lower, so a one-pixel offset is not accepted
      // as evidence that a symbol is absent.
      const stride = Math.min(value.width, value.height) < 18 ? 1 : 2;
      const coarse = Math.max(.35, sensitivity - .3), rough = [], scores = new Float32Array(page.width * page.height).fill(NaN);
      const cachedScore = (x, y) => { const key = y * page.width + x; if (Number.isNaN(scores[key])) scores[key] = score(page, x, y, pattern); return scores[key]; };
      for (let y = 0; y <= page.height - value.height; y += stride) {
        if ((y / stride) % 12 === 0) { abort(options.signal); if (Date.now() >= deadline) throw new Error("Visual search reached its three-minute limit. Search fewer pages or a smaller symbol."); await pause(); }
        for (let x = 0; x <= page.width - value.width; x += stride) {
          const valueScore = cachedScore(x, y);
          if (valueScore >= coarse) rough.push({ x, y, width: value.width, height: value.height, score: valueScore, rotation });
        }
        if (rough.length > 50000) throw new Error("The sample is too repetitive. Select a more distinctive symbol with a narrow background margin.");
      }
      for (let index = 0; index < rough.length; index++) {
        if (index % 64 === 0) { abort(options.signal); if (Date.now() >= deadline) throw new Error("Visual search reached its three-minute limit. Search fewer pages or a smaller symbol."); await pause(); }
        const approximate = rough[index];
        let best = approximate;
        for (let yy = Math.max(0, approximate.y - stride); yy <= Math.min(page.height - value.height, approximate.y + stride); yy++) for (let xx = Math.max(0, approximate.x - stride); xx <= Math.min(page.width - value.width, approximate.x + stride); xx++) {
          const valueScore = cachedScore(xx, yy); if (valueScore > best.score) best = { ...approximate, x: xx, y: yy, score: valueScore };
        }
        if (best.score >= sensitivity) candidates.push(best);
      }
      options.progress?.({ rotation, rotations: rotations.length });
    }
    abort(options.signal); return suppress(candidates, options.maximum ?? limits.results);
  }
  function transform(point, matrix) { return [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]]; }
  function inverse(point, matrix) {
    if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new Error("The original page transform is unavailable.");
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("The original page transform is invalid.");
    const x = point[0] - matrix[4], y = point[1] - matrix[5]; return [(x * matrix[3] - y * matrix[2]) / determinant, (y * matrix[0] - x * matrix[1]) / determinant];
  }
  function sourceRegion(box, matrix) { return [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].map(point => inverse(point, matrix)); }
  function canvasImage(canvas) { const context = canvas?.getContext?.("2d", { willReadFrequently: true }); if (!context) throw new Error("The original page bitmap is unavailable."); return context.getImageData(0, 0, canvas.width, canvas.height); }
  function crop(canvas, region, matrix) {
    if (!Array.isArray(region) || region.length !== 4 || region.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw new Error("Select one rectangular source example.");
    const points = region.map(point => transform(point, matrix));
    const x = Math.max(0, Math.floor(Math.min(...points.map(p => p[0])))), y = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
    const width = Math.min(canvas.width - x, Math.ceil(Math.max(...points.map(p => p[0]))) - x), height = Math.min(canvas.height - y, Math.ceil(Math.max(...points.map(p => p[1]))) - y);
    if (width < 8 || height < 8 || width > limits.template || height > limits.template) throw new Error("Choose a tighter sample between 8 and 512 rendered pixels on each side.");
    return { x, y, width, height };
  }
  function mount(host, bridge) {
    const doc = host.ownerDocument, state = { key: null, sample: null, results: [], selected: new Set(), controller: null, applying: false, destroyed: false };
    const node = (tag, className = "", text = "") => { const el = doc.createElement(tag); el.className = className; if (text && root.CeasefireI18n?.text) root.CeasefireI18n.text(el, text); else el.textContent = text; return el; };
    const attr = (el, name, text, args = []) => { if (root.CeasefireI18n?.attr) root.CeasefireI18n.attr(el, name, text, args); else el.setAttribute(name, text.replace(/\{(\d+)\}/g, (_, index) => String(args[index] ?? ""))); };
    const label = (text, control) => { const el = node("label", "takeoff-visual-option"); el.append(node("span", "", text), control); return el; };
    const button = (text, action) => { const el = node("button", "button secondary", text); el.type = "button"; el.addEventListener("click", () => void safe(action)); return el; };
    const toggle = button("Visual Search", () => { sync(); if (toggle.disabled) return; panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden)); });
    toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", "takeoff-visual-search-panel");
    const panel = node("section", "takeoff-visual-search-panel"); panel.id = "takeoff-visual-search-panel"; panel.hidden = true; attr(panel, "aria-label", "Visual Search");
    const heading = node("div", "takeoff-visual-heading"); heading.append(node("h3", "", "Visual Search"), button("Close Visual Search", close));
    const instructions = node("p", "helper", "Select an example in the original PDF, search, then check the matches you want to turn into draft callouts.");
    const sample = node("canvas", "takeoff-visual-sample"); sample.width = sample.height = 1; sample.hidden = true; attr(sample, "aria-label", "Selected visual example");
    const selectSample = button("Select example", async () => {
      if (bridge.context()?.busy || state.controller || state.applying) throw new Error("Finish the current drawing action before selecting an example.");
      cancel(); state.results = []; state.selected.clear(); renderResults(); const captured = sourceKey(bridge.context());
      panel.hidden = true; toggle.setAttribute("aria-expanded", "false");
      try { const chosen = await bridge.selectSample(); if (!chosen) return; if (captured !== sourceKey(bridge.context())) throw new Error("The project changed. Select the example again."); state.sample = chosen; sample.hidden = true; status.textContent = "Example selected. Choose Search to find matching symbols."; }
      finally { if (!state.destroyed && captured === sourceKey(bridge.context())) { panel.hidden = false; toggle.setAttribute("aria-expanded", "true"); } }
    });
    const scope = node("select"); for (const [value, text] of [["page", "Current page"], ["document", "Current document"], ["all", "All documents"]]) { const option = node("option", "", text); option.value = value; scope.append(option); } attr(scope, "aria-label", "Visual search scope");
    const sensitivity = node("input"); sensitivity.type = "range"; sensitivity.min = "60"; sensitivity.max = "99"; sensitivity.value = "88"; attr(sensitivity, "aria-label", "Visual search sensitivity"); const sensitivityValue = node("span", "", "88%"); sensitivity.addEventListener("input", () => { sensitivityValue.textContent = `${sensitivity.value}%`; });
    const rotations = node("input"); rotations.type = "checkbox"; attr(rotations, "aria-label", "Search multiple rotations");
    const search = button("Search", run), stop = button("Stop", () => { cancel(); status.textContent = "Visual search stopped. Start a new search to add callouts."; state.results = []; state.selected.clear(); renderResults(); });
    const options = node("div", "takeoff-visual-options"); const sensitivityLabel = label("Sensitivity", sensitivity); sensitivityLabel.append(sensitivityValue); options.append(selectSample, label("Search in", scope), sensitivityLabel, label("Multiple rotations", rotations), search, stop);
    const status = node("p", "helper"); status.setAttribute("role", "status"); status.textContent = "Select a clear symbol with a small margin around it.";
    const all = node("input"); all.type = "checkbox"; attr(all, "aria-label", "Select all visual matches"); all.addEventListener("change", () => { state.selected = new Set(all.checked ? state.results.map((_, i) => i) : []); renderResults(); });
    const selection = node("div", "takeoff-visual-actions"), count = node("span");
    const addBarrier = button("Add selected as barriers", () => create("barrier")), addService = button("Add selected as services", () => create("service")); selection.append(label("Select All", all), count, addBarrier, addService);
    const results = node("div", "takeoff-visual-results"); attr(results, "aria-label", "Visual search results");
    panel.append(heading, instructions, options, sample, status, selection, results); host.append(toggle, panel);
    function sourceKey(context) { return JSON.stringify([!!context?.enabled, context?.session_id, context?.project_id, (context?.documents || []).map(value => [value.id, value.sha256, value.pages.length])]); }
    function cancel() { state.controller?.abort(); state.controller = null; }
    function close() { cancel(); panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    function sync() {
      const context = bridge.context(), key = sourceKey(context);
      if (key !== state.key) { close(); state.key = key; state.sample = null; state.results = []; state.selected.clear(); sample.hidden = true; renderResults(); }
      toggle.hidden = !context?.enabled; toggle.disabled = !context?.enabled || !context?.document_id || !!context?.busy || state.applying;
      const locked = !!context?.busy || state.applying || !!state.controller;
      for (const control of [selectSample, scope, sensitivity, rotations, search]) control.disabled = locked || !context?.enabled || !context?.document_id;
      stop.disabled = !state.controller;
      if (state.locked !== locked) { state.locked = locked; renderResults(); }
      if (!context?.enabled) close();
    }
    function renderResults() {
      const selected = state.results.filter((_, i) => state.selected.has(i)); all.checked = state.results.length > 0 && selected.length === state.results.length; all.indeterminate = selected.length > 0 && selected.length < state.results.length;
      const context = bridge.context(), locked = !!context?.busy || !!state.controller || state.applying;
      for (const control of [selectSample, scope, sensitivity, rotations, search]) control.disabled = locked || !context?.enabled || !context?.document_id;
      stop.disabled = !state.controller;
      all.disabled = !state.results.length || locked; count.textContent = `${selected.length} selected · ${state.results.length} matches`;
      addBarrier.disabled = addService.disabled = !selected.length || selected.length > limits.batch || locked;
      results.replaceChildren();
      state.results.forEach((hit, index) => {
        const row = node("div", "takeoff-visual-result"), checkbox = node("input"); checkbox.type = "checkbox"; checkbox.checked = state.selected.has(index); checkbox.disabled = locked; attr(checkbox, "aria-label", "Select visual match {0}", [index + 1]);
        checkbox.addEventListener("change", () => { checkbox.checked ? state.selected.add(index) : state.selected.delete(index); renderResults(); });
        const jump = button(`${hit.name} · page ${hit.page} · similarity ${Math.round(hit.score * 100)}% · ${hit.rotation}°`, () => bridge.focus(hit)); jump.classList.add("takeoff-visual-jump");
        jump.disabled = locked;
        if (hit.thumbnail) { const img = node("img"); img.src = hit.thumbnail; img.alt = `Visual match ${index + 1}`; jump.prepend(img); }
        row.append(checkbox, jump); results.append(row);
      });
    }
    async function safe(action) { try { await action(); } catch (error) { if (!state.destroyed && error.name !== "AbortError") { status.textContent = error.message; bridge.notify?.(error.message, true); } } }
    async function run() {
      sync(); if (!bridge.context()?.enabled || bridge.context()?.busy) throw new Error("Open Service Plans and finish the current drawing action before searching."); if (!state.sample) throw new Error("Select an example in the PDF first."); if (state.controller || state.applying) return;
      const context = bridge.context(), key = state.key, original = { ...state.sample }, controller = new AbortController(); state.controller = controller; state.results = []; state.selected.clear(); renderResults();
      const deadline = Date.now() + limits.milliseconds; let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, limits.milliseconds);
      try {
        const source = context.documents.find(value => value.id === original.document_id && value.sha256 === original.document_sha256);
        if (!source) throw new Error("The sample's original source is unavailable. Select it again.");
        const pages = (scope.value === "all" ? context.documents : [source]).flatMap(value => value.pages.map((_, i) => ({ document: value, page: i + 1 }))).filter(value => scope.value !== "page" || value.page === original.page);
        if (!pages.length || pages.length > limits.pages) throw new Error(`Visual search covers at most ${limits.pages} pages per search. Choose Current page for a larger document.`);
        const example = await bridge.render(original.document_id, original.page, { signal: controller.signal, maxPixels: limits.pixels, rotation: 0 }); abort(controller.signal);
        let template; const templateScale = Math.hypot(example.viewport.transform[0], example.viewport.transform[1]);
        try { const box = crop(example.canvas, original.region, example.viewport.transform); const context2d = example.canvas.getContext("2d", { willReadFrequently: true }); const pixels = context2d.getImageData(box.x, box.y, box.width, box.height); template = image(pixels); sample.width = box.width; sample.height = box.height; sample.getContext("2d").putImageData(pixels, 0, 0); sample.hidden = false; }
        finally { example.release?.(); }
        for (let n = 0; n < pages.length; n++) {
          abort(controller.signal); if (key !== sourceKey(bridge.context())) throw new Error("The project or source inventory changed. Search again.");
          const current = pages[n]; status.textContent = `Searching ${current.document.name}, page ${current.page} (${n + 1}/${pages.length})…`;
          const rendered = await bridge.render(current.document.id, current.page, { signal: controller.signal, maxPixels: limits.pixels, rotation: 0 });
          try {
            const scaledTemplate = resize(template, Math.hypot(rendered.viewport.transform[0], rendered.viewport.transform[1]) / templateScale);
            const matches = await find(image(canvasImage(rendered.canvas)), scaledTemplate, { sensitivity: Number(sensitivity.value) / 100, rotations: rotations.checked, signal: controller.signal, deadline, maximum: limits.results - state.results.length });
            for (const match of matches) {
              const region = sourceRegion(match, rendered.viewport.transform), point = inverse([match.x + match.width / 2, match.y + match.height / 2], rendered.viewport.transform);
              const thumbnail = doc.createElement("canvas"); const scale = Math.min(1, 80 / Math.max(match.width, match.height)); thumbnail.width = Math.max(1, Math.round(match.width * scale)); thumbnail.height = Math.max(1, Math.round(match.height * scale)); thumbnail.getContext("2d").drawImage(rendered.canvas, match.x, match.y, match.width, match.height, 0, 0, thumbnail.width, thumbnail.height);
              state.results.push({ document_id: current.document.id, document_sha256: current.document.sha256, page: current.page, region, point, score: match.score, rotation: match.rotation, name: current.document.name, thumbnail: thumbnail.toDataURL("image/png") });
            }
          } finally { rendered.release?.(); }
        }
        abort(controller.signal); if (key !== sourceKey(bridge.context())) throw new Error("The project changed. Search again.");
        status.textContent = `${state.results.length} possible matches. Review each result before creating callouts. Select up to ${limits.batch} at a time.`;
      } catch (error) { state.results = []; if (expired) throw new Error("Visual search reached its three-minute limit. Search fewer pages or a smaller symbol."); if (controller.signal.aborted) { const cancelled = new Error("Visual search stopped."); cancelled.name = "AbortError"; throw cancelled; } throw error; }
      finally { clearTimeout(timer); if (state.controller === controller) state.controller = null; state.selected.clear(); renderResults(); }
    }
    async function create(kind) {
      sync(); if (!bridge.context()?.enabled || bridge.context()?.busy) throw new Error("Finish the current drawing action before adding visual callouts."); const selected = state.results.filter((_, i) => state.selected.has(i));
      if (!selected.length || selected.length > limits.batch || state.controller || state.applying) throw new Error(`Select one to ${limits.batch} reviewed matches first.`);
      const key = state.key; state.applying = true; renderResults();
      try { const ids = await bridge.create(kind, selected.map(({ thumbnail, name, ...hit }) => hit)); if (key !== sourceKey(bridge.context())) return; if (Array.isArray(ids) && ids.length) { state.results = state.results.filter((_, i) => !state.selected.has(i)); state.selected.clear(); status.textContent = `${ids.length} draft ${kind} callouts added. Review their fields and source positions before confirmation.`; } }
      finally { state.applying = false; renderResults(); }
    }
    sync(); return Object.freeze({ sync, close, destroy() { state.destroyed = true; close(); toggle.remove(); panel.remove(); state.results = []; } });
  }
  const api = Object.freeze({ limits, image, rotate, resize, probes, score, suppress, find, inverse, sourceRegion, mount });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CeasefireTakeoffVisualSearch = api;
})(typeof window === "object" ? window : globalThis);
