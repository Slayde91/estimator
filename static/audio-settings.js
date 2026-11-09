"use strict";

// Browser presentation preference only; it never enters Project data or exports.
(function (root) {
  const storageKey = "ceasefire.audio.enabled";
  function create(host) {
    let enabled = true, closed = false;
    const listeners = new Set();
    try { enabled = host.localStorage?.getItem(storageKey) !== "false"; } catch { /* Keep the existing enabled behavior when storage is unavailable. */ }
    function publish(value) {
      if (closed || enabled === value) return;
      enabled = value;
      for (const listener of listeners) { try { listener(enabled); } catch { /* Optional feedback cannot break Settings. */ } }
    }
    function setEnabled(value) {
      if (closed || typeof value !== "boolean") return;
      try { host.localStorage?.setItem(storageKey, String(value)); } catch { /* The current window still honors the choice. */ }
      publish(value);
    }
    function storage(event) {
      if (event.key !== storageKey && event.key !== null) return;
      // Storage events from a different storage area must not affect audio.
      try { if (event.storageArea && event.storageArea !== host.localStorage) return; } catch { return; }
      publish(event.newValue !== "false");
    }
    host.addEventListener?.("storage", storage);
    function subscribe(listener) {
      if (closed || typeof listener !== "function") return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    }
    function close() { closed = true; listeners.clear(); host.removeEventListener?.("storage", storage); }
    return Object.freeze({ isEnabled: () => enabled, setEnabled, subscribe, close });
  }
  function bind(control, status, preference, host) {
    if (!control) return () => {};
    function paint() {
      control.checked = preference.isEnabled();
      if (status) {
        const message = control.checked ? "Audio enabled" : "Audio disabled";
        if (host.CeasefireI18n) host.CeasefireI18n.text(status, message);
        else status.textContent = message;
      }
    }
    const change = () => preference.setEnabled(control.checked);
    control.addEventListener("change", change);
    const unsubscribe = preference.subscribe(paint); paint();
    return () => { unsubscribe(); control.removeEventListener("change", change); };
  }
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({ create, bind, storageKey });
  if (root) {
    const preference = root.CeasefireAudioSettings = create(root);
    // Keep the control bound for the window's lifetime, including bfcache restores.
    bind(root.document.getElementById("audio-enabled"), root.document.getElementById("audio-status"), preference, root);
  }
})(typeof window === "object" ? window : null);
