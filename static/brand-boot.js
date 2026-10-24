"use strict";

// A one-time startup screen, independent of later calculation/busy feedback.
(() => {
  let state = "pending", finishing = false;
  const host = () => document.getElementById("classifire-boot");
  function notifyNative(value) {
    try { window.chrome?.webview?.postMessage({ type: "classifire.boot", state: value }); }
    catch (_) { /* A disposed optional native host cannot block the web page. */ }
  }
  function finish(value) {
    if (state !== "pending") return;
    state = value;
    document.documentElement.removeAttribute("data-brand-boot");
    if (host()) host().hidden = true;
    notifyNative(value);
  }
  function failed() {
    if (state !== "pending") return;
    const loading = document.getElementById("loading-state");
    if (loading) {
      const text = "The estimator could not be loaded. Reload after the local server is available.";
      if (window.CeasefireI18n) window.CeasefireI18n.text(loading, text);
      else loading.textContent = text;
      loading.hidden = false;
    }
    finish("error");
  }
  async function ready() {
    if (state !== "pending" || finishing) return;
    finishing = true;
    try {
      if (document.readyState !== "complete") await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
      if (state !== "pending") return;
      const logo = host()?.querySelector("img");
      if (logo?.decode) await logo.decode();
      await document.fonts?.ready;
      // Let the initialized home layout paint before revealing its controls.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      finish("ready");
    } catch (_) { failed(); }
  }
  window.ClassifireBoot = Object.freeze({ ready, failed, get state() { return state; } });
  // Resource/script failures must leave the existing recovery message visible.
  window.addEventListener("error", failed);
  window.addEventListener("error", event => {
    if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) failed();
  }, true);
})();
