"use strict";

// Search indexes are presentation data. Every span names retained PDF text-run
// offsets; exact displayed bounds are measured from PDF.js's rendered text.
(() => {
  const MAX_PAGE_TEXT = 400000, MAX_QUERY = 200, MAX_CONTEXT = 800;
  function normalize(value) { return String(value || "").replace(/\s+/gu, " ").trim().toLowerCase(); }
  function separator(previous, next) {
    if (!previous || !previous.str || !next.str || /\s$/u.test(previous.str) || /^\s/u.test(next.str)) return "";
    if (previous.hasEOL) return " ";
    const p = previous.transform, n = next.transform;
    if (!Array.isArray(p) || !Array.isArray(n)) return " ";
    const length = Math.hypot(p[0], p[1]), height = Math.max(1, previous.height || Math.hypot(p[2], p[3]));
    if (!length) return " ";
    const dx = n[4] - p[4], dy = n[5] - p[5], along = (dx * p[0] + dy * p[1]) / length;
    const across = Math.abs((dx * -p[1] + dy * p[0]) / length);
    return across > height * .5 || along - Math.abs(previous.width || 0) > height * .12 ? " " : "";
  }
  function indexText(items) {
    const runs = [], map = []; let text = "", previous = null;
    const append = (character, reference) => {
      const lower = /\s/u.test(character) ? " " : character.toLowerCase();
      if (lower === " " && (!text || text.endsWith(" "))) return;
      text += lower; for (let i = 0; i < lower.length; i++) map.push(reference);
      if (text.length > MAX_PAGE_TEXT) throw new Error("PDF page text exceeds the bounded search limit; coverage is incomplete.");
    };
    for (const item of items || []) {
      if (typeof item.str !== "string" || !item.str) continue;
      const itemIndex = runs.length; runs.push(item);
      if (separator(previous, item)) append(" ", null);
      let offset = 0;
      for (const character of item.str) { append(character, { item: itemIndex, start: offset, end: offset + character.length }); offset += character.length; }
      previous = item;
    }
    return { text, map, runs };
  }
  function spans(index, start, end) {
    const result = [];
    for (let i = start; i < end; i++) {
      const reference = index.map[i]; if (!reference) continue;
      const last = result[result.length - 1];
      if (last && last.item === reference.item) last.end = Math.max(last.end, reference.end);
      else result.push({ ...reference });
    }
    return result;
  }
  function runQuad(item) {
    const t = item?.transform, width = item?.width;
    if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) || !Number.isFinite(width) || width < 0) return null;
    const length = Math.hypot(t[0], t[1]), vertical = Math.hypot(t[2], t[3]); if (!length || !vertical) return null;
    const u = [t[0] / length * width, t[1] / length * width], height = Math.max(1, item.height || vertical);
    const v = [t[2] / vertical * height, t[3] / vertical * height], p = [t[4], t[5]];
    return [p, [p[0] + u[0], p[1] + u[1]], [p[0] + u[0] + v[0], p[1] + u[1] + v[1]], [p[0] + v[0], p[1] + v[1]]];
  }
  function find(index, value, limit = 500) {
    const query = normalize(value); if (!query) return [];
    if (query.length > MAX_QUERY) throw new Error(`Search is limited to ${MAX_QUERY} characters.`);
    const hits = []; let cursor = 0;
    while (hits.length < limit) {
      const start = index.text.indexOf(query, cursor); if (start < 0) break;
      const end = start + query.length; cursor = end;
      let contextStart = start, contextEnd = end;
      while (contextStart > 0 && start - contextStart < MAX_CONTEXT && !/[.!?\n]/u.test(index.text[contextStart - 1])) contextStart--;
      while (contextEnd < index.text.length && contextEnd - end < MAX_CONTEXT && !/[.!?\n]/u.test(index.text[contextEnd])) contextEnd++;
      if (contextEnd < index.text.length) contextEnd++;
      const truncated = contextEnd - contextStart > MAX_CONTEXT;
      if (truncated) { contextStart = Math.max(contextStart, start - 200); contextEnd = Math.min(contextEnd, Math.max(end, contextStart + MAX_CONTEXT)); }
      const matching = spans(index, start, end), context = spans(index, contextStart, contextEnd);
      const textParts = []; let text = "", previous = null;
      const part = (value, matched = false) => { if (value) { text += value; textParts.push({ text: value, matched }); } };
      for (const span of context) {
        const run = index.runs[span.item], match = matching.find(value => value.item === span.item);
        part(separator(previous, run));
        if (match) {
          const start = Math.max(span.start, match.start), end = Math.min(span.end, match.end);
          part(run.str.slice(span.start, start)); part(run.str.slice(start, end), true); part(run.str.slice(end, span.end));
        } else part(run.str.slice(span.start, span.end));
        previous = run;
      }
      const contextQuads = context.map(span => runQuad(index.runs[span.item])).filter(Boolean);
      hits.push({ start, end, matching, context, text, textParts, contextQuads, points: contextQuads.flat(), contextTruncated: truncated });
    }
    return hits;
  }
  function choose(hits, activeId, centre) {
    if (!hits.length) return null;
    const previous = hits.findIndex(hit => hit.id === activeId);
    if (previous >= 0) return hits[(previous + 1) % hits.length];
    let nearest = hits[0], distance = Infinity;
    for (const hit of hits) {
      const points = hit.matchQuads?.flat() || hit.points || [];
      if (!points.length) continue;
      const x = points.reduce((sum, p) => sum + p[0], 0) / points.length, y = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const candidate = (x - centre[0]) ** 2 + (y - centre[1]) ** 2;
      if (candidate < distance) { nearest = hit; distance = candidate; }
    }
    return nearest;
  }
  // OCR is an in-memory, approximate search aid. It never creates a PDF text
  // layer, annotation, register item, quantity, approval or calculator input.
  const OCR_LIMITS = Object.freeze({ pixels: 18000000, edge: 6000, tile: 2048, overlap: 128,
    pageMs: 60000, runMs: 150000, pages: 8, words: 20000, cachePages: 8, cacheBytes: 2000000, confidence: 35 });
  const OCR_VERSION = "tesseract-7.0.0-eng-best-int-v1";
  function ocrError(name, message) { const error = new Error(message); error.name = name; return error; }
  function createOcrBudget() { return { pages: 0, started: Date.now() }; }
  function pointTransform(point, t) { return [point[0] * t[0] + point[1] * t[2] + t[4], point[0] * t[1] + point[1] * t[3] + t[5]]; }
  function inverseTransform(point, t) {
    const determinant = t[0] * t[3] - t[1] * t[2];
    if (!Number.isFinite(determinant) || !determinant) throw ocrError("OcrGeometryError", "Local OCR requires a valid original PDF page transform.");
    const x = point[0] - t[4], y = point[1] - t[5];
    return [(x * t[3] - y * t[2]) / determinant, (y * t[0] - x * t[1]) / determinant];
  }
  function rectangleQuad(box, transform) { return [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(point => inverseTransform(point, transform)); }
  function rotationTransform(angle, width, height) {
    return angle === 90 ? [0, 1, -1, 0, height, 0] : angle === 180 ? [-1, 0, 0, -1, width, height] : angle === 270 ? [0, -1, 1, 0, 0, width] : [1, 0, 0, 1, 0, 0];
  }
  function mergeOcrWords(words) {
    // Retain the best overlapping recognition of a word from adjacent tiles.
    // Spatial buckets keep the bounded 20,000-word merge linear in practice.
    const kept = [], buckets = new Map();
    for (const word of [...words].sort((a, b) => b.confidence - a.confidence || a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
      const [x0, y0, x1, y1] = word.box, x = (x0 + x1) / 2, y = (y0 + y1) / 2;
      const bx = Math.floor(x / 64), by = Math.floor(y / 64); let duplicate = false;
      for (let dx = -1; dx <= 1 && !duplicate; dx++) for (let dy = -1; dy <= 1 && !duplicate; dy++) for (const prior of buckets.get(`${bx + dx}:${by + dy}`) || []) {
        const overlap = Math.max(0, Math.min(x1, prior.box[2]) - Math.max(x0, prior.box[0])) * Math.max(0, Math.min(y1, prior.box[3]) - Math.max(y0, prior.box[1]));
        const smaller = Math.min((x1 - x0) * (y1 - y0), (prior.box[2] - prior.box[0]) * (prior.box[3] - prior.box[1]));
        const larger = Math.max((x1 - x0) * (y1 - y0), (prior.box[2] - prior.box[0]) * (prior.box[3] - prior.box[1]));
        // Competing tile readings can differ in text (AIR versus AR). Keeping
        // both at the same pixels would insert a false word inside a phrase.
        if (overlap / smaller > .8 && overlap / larger > .65) { duplicate = true; break; }
      }
      if (duplicate) continue;
      const key = `${bx}:${by}`, bucket = buckets.get(key) || []; bucket.push(word); buckets.set(key, bucket); kept.push(word);
    }
    const ordered = []; let line = 0;
    for (const rotation of [0, 90, 180, 270]) {
      const rows = [], box = word => word.readingBox || word.box;
      for (const word of kept.filter(word => (word.rotation || 0) === rotation).sort((a, b) => box(a)[1] - box(b)[1] || box(a)[0] - box(b)[0])) {
        const bounds = box(word), height = bounds[3] - bounds[1], centre = (bounds[1] + bounds[3]) / 2;
        let row = rows[rows.length - 1];
        if (!row || Math.abs(centre - row.centre) > Math.min(height, row.height) * .6) { row = { centre, height, words: [] }; rows.push(row); }
        row.words.push(word);
      }
      for (const row of rows) {
        let previous = null;
        for (const word of row.words.sort((a, b) => box(a)[0] - box(b)[0])) {
          if (!previous || box(word)[0] - box(previous)[2] > Math.max(120, row.height * 10)) line++;
          ordered.push({ ...word, line }); previous = word;
        }
      }
    }
    return ordered;
  }
  function indexOcr(result) {
    const words = result.words || [], lines = new Map(), runs = words.map(word => ({ str: word.text }));
    words.forEach(word => { const bounds = word.readingBox || word.box, box = lines.get(word.line) || [...bounds]; box[0] = Math.min(box[0], bounds[0]); box[1] = Math.min(box[1], bounds[1]); box[2] = Math.max(box[2], bounds[2]); box[3] = Math.max(box[3], bounds[3]); lines.set(word.line, box); });
    let text = "", previous = null; const map = [];
    words.forEach((word, item) => {
      if (previous) {
        let delimiter = " ";
        if (word.line !== previous.line) {
          const a = lines.get(previous.line), b = lines.get(word.line), height = Math.max(a[3] - a[1], b[3] - b[1]);
          // Wrap a label only where adjacent lines overlap horizontally. Never
          // manufacture a phrase by joining unrelated columns or remote rows.
          if ((word.rotation || 0) !== (previous.rotation || 0) || b[1] - a[3] > height * 1.5 || Math.min(a[2], b[2]) <= Math.max(a[0], b[0])) delimiter = "\n";
        }
        text += delimiter; map.push(null);
      }
      let offset = 0;
      for (const character of word.text) { const lower = character.toLowerCase(); text += lower; for (let i = 0; i < lower.length; i++) map.push({ item, start: offset, end: offset + character.length }); offset += character.length; }
      if (text.length > MAX_PAGE_TEXT) throw ocrError("OcrLimitError", "Recognized page text exceeds the bounded local OCR limit; coverage is incomplete.");
      previous = word;
    });
    return { text, map, runs };
  }
  function findOcr(result, value, nativeHits = [], limit = 500) {
    const index = indexOcr(result);
    return find(index, value, Math.min(1000, limit + nativeHits.length)).map(hit => {
      const selected = hit.matching.map(span => result.words[span.item]), context = hit.context.map(span => result.words[span.item]);
      const matchQuads = selected.map(word => word.quad), contextQuads = context.map(word => word.quad);
      return { ...hit, source: "local-ocr", authority: "search-only", geometry: "ocr-word-bounds", approximate: true,
        confidence: Math.min(...selected.map(word => word.confidence)), matchQuads, contextQuads, points: contextQuads.flat() };
    }).filter(hit => !nativeHits.some(native => {
      const quads = native.matchQuads?.length ? native.matchQuads : native.contextQuads || [];
      return hit.matchQuads.some(quad => quads.some(other => {
        const bounds = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
        const a = bounds(quad), b = bounds(other), x = (a[0] + a[2]) / 2, y = (a[1] + a[3]) / 2;
        return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
      }));
    })).slice(0, limit);
  }
  function createOcrSearch(dependencies = {}) {
    const clock = dependencies.clock || Date.now, workerFactory = dependencies.workerFactory || (url => new Worker(url));
    const canvasFactory = dependencies.canvasFactory || (() => document.createElement("canvas"));
    const cache = new Map(); let cacheBytes = 0, worker = null, pending = null, ready = false, busy = false, job = 0, idle = null, disposed = false, activeAbort = null;
    const absolute = path => dependencies.baseUrl ? new URL(path, dependencies.baseUrl).href : new URL(path, window.location.href).href;
    function destroy(error = ocrError("SearchCancelled", "Local OCR search cancelled.")) {
      clearTimeout(idle); idle = null; worker?.terminate(); worker = null; ready = false;
      if (pending) { const current = pending; pending = null; clearTimeout(current.timer); current.reject(error); }
    }
    function rpc(action, payload, deadline, progress) {
      if (!worker || pending) return Promise.reject(ocrError("OcrBusyError", "Local OCR supports one operation at a time."));
      const remaining = deadline - clock();
      if (remaining <= 0) { const error = ocrError("OcrTimeoutError", "Local OCR page time limit reached; coverage is incomplete."); destroy(error); return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const id = String(++job), timer = setTimeout(() => destroy(ocrError("OcrTimeoutError", "Local OCR page time limit reached; coverage is incomplete.")), remaining);
        pending = { id, resolve, reject, timer, progress }; worker.postMessage({ workerId: "ceasefire-search", jobId: id, action, payload });
      });
    }
    async function initialize(deadline, progress) {
      if (ready) return;
      worker = workerFactory(absolute("/vendor/ocr/worker.min.js"));
      // Own the pinned v7 native worker from creation, so cancellation also
      // terminates model/core initialization. No blob worker or CDN fallback.
      worker.onmessage = ({ data }) => {
        if (!pending || data.jobId !== pending.id || data.workerId !== "ceasefire-search") return;
        if (data.status === "progress") { pending.progress?.(data.data); return; }
        const current = pending; pending = null; clearTimeout(current.timer);
        if (data.status === "resolve") current.resolve(data.data);
        else current.reject(ocrError("OcrRecognitionError", "Local OCR could not recognize this page; coverage is incomplete."));
      };
      worker.onerror = event => { event.preventDefault?.(); destroy(ocrError("OcrRecognitionError", "Local OCR engine could not start; coverage is incomplete.")); };
      await rpc("load", { options: { lstmOnly: true, corePath: absolute("/vendor/ocr/core"), logging: false } }, deadline, progress);
      await rpc("loadLanguage", { langs: "eng", options: { langPath: absolute("/vendor/ocr/lang"), cacheMethod: "none", gzip: true, lstmOnly: true } }, deadline, progress);
      await rpc("initialize", { langs: "eng", oem: 1, config: {} }, deadline, progress);
      await rpc("setParameters", { params: { tessedit_pageseg_mode: "11", preserve_interword_spaces: "1", user_defined_dpi: "144" } }, deadline, progress);
      ready = true;
    }
    async function recognizePage(page, { sha256, items = [], signal, budget = createOcrBudget(), onProgress } = {}) {
      if (disposed) throw ocrError("SearchCancelled", "Local OCR search is closed.");
      if (signal?.aborted) throw ocrError("SearchCancelled", "Local OCR search cancelled.");
      if (!/^[a-f0-9]{64}$/u.test(sha256 || "")) throw ocrError("OcrGeometryError", "Local OCR requires the retained PDF fingerprint.");
      const base = page.getViewport({ scale: 1 }), scale = Math.min(2, Math.sqrt(OCR_LIMITS.pixels / (base.width * base.height)), OCR_LIMITS.edge / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      if (!(scale > 0) || !Number.isFinite(scale) || !Array.isArray(viewport.transform) || !viewport.transform.every(Number.isFinite)) throw ocrError("OcrGeometryError", "Local OCR requires a valid original PDF page viewport.");
      const width = Math.floor(viewport.width), height = Math.floor(viewport.height);
      if (!width || !height || width * height > OCR_LIMITS.pixels || Math.max(width, height) > OCR_LIMITS.edge) throw ocrError("OcrLimitError", "PDF page exceeds bounded local OCR rendering; coverage is incomplete.");
      const key = JSON.stringify([OCR_VERSION, sha256, page.pageNumber, viewport.transform, width, height]);
      if (cache.has(key)) { const saved = cache.get(key); cache.delete(key); cache.set(key, saved); return saved.result; }
      if (busy) throw ocrError("OcrBusyError", "Local OCR is finishing the previous operation. Search again.");
      if (budget.pages >= OCR_LIMITS.pages || clock() - budget.started >= OCR_LIMITS.runMs) throw ocrError("OcrLimitError", "Local OCR search page/time limit reached; coverage is incomplete.");
      budget.pages++; busy = true; clearTimeout(idle); idle = null;
      const parentSignal = signal, controller = new AbortController(), relayAbort = () => controller.abort(); signal = controller.signal;
      parentSignal?.addEventListener("abort", relayAbort, { once: true }); activeAbort = relayAbort;
      const started = clock(), deadline = Math.min(started + OCR_LIMITS.pageMs, budget.started + OCR_LIMITS.runMs), canvas = canvasFactory(), tile = canvasFactory(); let renderTask;
      const abort = () => { renderTask?.cancel(); destroy(); };
      signal?.addEventListener("abort", abort, { once: true });
      const check = () => { if (signal?.aborted || disposed) throw ocrError("SearchCancelled", "Local OCR search cancelled."); if (clock() >= deadline) throw ocrError("OcrTimeoutError", "Local OCR page time limit reached; coverage is incomplete."); };
      const bounded = promise => new Promise((resolve, reject) => {
        const fail = () => reject(ocrError("SearchCancelled", "Local OCR search cancelled."));
        const timer = setTimeout(() => { abort(); reject(ocrError("OcrTimeoutError", "Local OCR page time limit reached; coverage is incomplete.")); }, Math.max(1, deadline - clock()));
        signal?.addEventListener("abort", fail, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", fail); });
      });
      try {
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d"); renderTask = page.render({ canvasContext: context, viewport, background: "#ffffff" });
        await bounded(renderTask.promise); check();
        // Native text always wins. Mask its retained run quads only on this
        // disposable recognition image, never on the viewer or original PDF.
        context.fillStyle = "#ffffff";
        for (const item of items) {
          const quad = runQuad(item); if (!quad) continue;
          const points = quad.map(point => pointTransform(point, viewport.transform)), x = Math.min(...points.map(p => p[0])) - 2, y = Math.min(...points.map(p => p[1])) - 2;
          context.fillRect(x, y, Math.max(...points.map(p => p[0])) - x + 2, Math.max(...points.map(p => p[1])) - y + 2);
        }
        await initialize(deadline, onProgress); check();
        const words = [], stride = OCR_LIMITS.tile - OCR_LIMITS.overlap, completedRotations = []; let partialReason = "", textSize = 0;
        try { for (const rotation of [0, 90, 180, 270]) {
        for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
          check(); tile.width = Math.min(OCR_LIMITS.tile, width - x); tile.height = Math.min(OCR_LIMITS.tile, height - y);
          const tileWidth = tile.width, tileHeight = tile.height, rotationMatrix = rotationTransform(rotation, tileWidth, tileHeight);
          if (rotation === 90 || rotation === 270) { tile.width = tileHeight; tile.height = tileWidth; }
          const tileContext = tile.getContext("2d"); tileContext.setTransform(...rotationMatrix); tileContext.drawImage(canvas, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight); tileContext.setTransform(1, 0, 0, 1, 0, 0);
          const blob = await bounded(new Promise((resolve, reject) => tile.toBlob(value => value ? resolve(value) : reject(ocrError("OcrRecognitionError", "Local OCR could not prepare this page.")), "image/png")));
          const image = new Uint8Array(await bounded(blob.arrayBuffer())); check();
          const data = await rpc("recognize", { image, options: { rotateAuto: false }, output: { text: false, blocks: true } }, deadline, onProgress); check();
          for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) for (const recognized of line.words || []) {
            const text = String(recognized.text || "").trim(), box = recognized.bbox, confidence = recognized.confidence;
            if (!text || !/[\p{L}\p{N}]/u.test(text) || text.length > MAX_QUERY || !Number.isFinite(confidence) || confidence < OCR_LIMITS.confidence || confidence > 100 || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) || box.x0 < 0 || box.y0 < 0 || box.x1 <= box.x0 || box.y1 <= box.y0 || box.x1 > tile.width || box.y1 > tile.height) continue;
            const renderQuad = rectangleQuad([box.x0, box.y0, box.x1, box.y1], rotationMatrix).map(point => [point[0] + x, point[1] + y]);
            const bounds = [Math.min(...renderQuad.map(p => p[0])), Math.min(...renderQuad.map(p => p[1])), Math.max(...renderQuad.map(p => p[0])), Math.max(...renderQuad.map(p => p[1]))];
            // Discard clipped edge words; the overlapping neighbor supplies a
            // complete recognition. True outer page edges stay searchable.
            if (x && bounds[0] < x + 8 || y && bounds[1] < y + 8 || x + tileWidth < width && bounds[2] > x + tileWidth - 8 || y + tileHeight < height && bounds[3] > y + tileHeight - 8) continue;
            if (words.length >= OCR_LIMITS.words || textSize + text.length + 1 > MAX_PAGE_TEXT) throw ocrError("OcrLimitError", "Recognized page exceeds the bounded local OCR text/word limit; coverage is incomplete.");
            const readingQuad = renderQuad.map(point => pointTransform(point, rotationTransform(rotation, width, height)));
            const readingBox = [Math.min(...readingQuad.map(p => p[0])), Math.min(...readingQuad.map(p => p[1])), Math.max(...readingQuad.map(p => p[0])), Math.max(...readingQuad.map(p => p[1]))];
            words.push({ text, confidence, box: bounds, readingBox, rotation, quad: renderQuad.map(point => inverseTransform(point, viewport.transform)) }); textSize += text.length + 1;
          }
        }
        completedRotations.push(rotation);
        } } catch (error) {
          if (!words.length || !["OcrLimitError", "OcrTimeoutError"].includes(error.name)) throw error;
          partialReason = error.message; destroy(error);
        }
        const result = { version: 1, source: "local-ocr", engine: OCR_VERSION, sha256, page: page.pageNumber, width, height,
          transform: [...viewport.transform], scale, limitedResolution: scale < 2, partial: !!partialReason, partialReasons: partialReason ? [partialReason] : [], completedRotations,
          words: mergeOcrWords(words), elapsedMs: clock() - started };
        const bytes = JSON.stringify(result).length * 2;
        if (bytes <= OCR_LIMITS.cacheBytes) { cache.set(key, { result, bytes }); cacheBytes += bytes; }
        while (cache.size > OCR_LIMITS.cachePages || cacheBytes > OCR_LIMITS.cacheBytes) { const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest); }
        return result;
      } catch (error) { destroy(error); throw error; }
      finally {
        signal?.removeEventListener("abort", abort); canvas.width = canvas.height = tile.width = tile.height = 1; busy = false;
        parentSignal?.removeEventListener("abort", relayAbort); if (activeAbort === relayAbort) activeAbort = null;
        if (worker) idle = setTimeout(() => destroy(), 20000);
      }
    }
    return { recognizePage, cancel: () => { activeAbort?.(); destroy(); }, dispose: () => { disposed = true; activeAbort?.(); destroy(); cache.clear(); cacheBytes = 0; } };
  }
  const api = { normalize, indexText, find, choose, runQuad, MAX_PAGE_TEXT, MAX_QUERY,
    createOcrSearch, createOcrBudget, findOcr, mergeOcrWords, rectangleQuad, OCR_LIMITS, OCR_VERSION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.CeasefireTakeoffSearch = api;
})();
