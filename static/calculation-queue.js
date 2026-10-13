"use strict";

// Automatic calculations may replace a pending edit, but never an active
// request or an exact-snapshot save/export. Their callers retain revision guards.
(function (root) {
  function create() {
    let active = false, pending = null;
    async function execute(job) {
      active = true;
      try { job.resolve(job.current() ? await job.action() : undefined); }
      catch (error) { job.reject(error); }
      finally {
        active = false;
        const next = pending; pending = null;
        if (next) void execute(next);
      }
    }
    return Object.freeze({
      run(action, current = () => true) {
        return new Promise((resolve, reject) => {
          const job = { action, current, resolve, reject };
          if (!active) void execute(job);
          else { if (pending) pending.resolve(undefined); pending = job; }
        });
      }
    });
  }
  const api = Object.freeze({ create });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireCalculationQueue = api;
})(typeof window === "undefined" ? null : window);
