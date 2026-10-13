"use strict";

// Each asynchronous operation owns its release token. An older completion or
// cancellation cannot clear feedback for a newer/concurrent operation.
(function (root) {
  const pending = new Set(), keyed = new Map();
  function render() {
    const active = pending.size > 0, element = root.document?.documentElement;
    element?.classList.toggle("app-busy", active);
    element?.setAttribute("aria-busy", String(active));
  }
  function begin() {
    const token = {}; pending.add(token); render();
    return () => { if (pending.delete(token)) render(); };
  }
  function set(key, active) {
    if (active && !keyed.has(key)) keyed.set(key, begin());
    else if (!active && keyed.has(key)) { const end = keyed.get(key); keyed.delete(key); end(); }
  }
  const api = Object.freeze({ begin, set, get active() { return pending.size > 0; } });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.CeasefireActivity = api;
    if (root.document && root.document.readyState !== "complete") {
      const end = begin(); root.addEventListener("load", end, {once:true});
    }
  }
})(typeof window === "object" ? window : globalThis);
