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
  const api = { normalize, indexText, find, choose, runQuad, MAX_PAGE_TEXT, MAX_QUERY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.CeasefireTakeoffSearch = api;
})();
