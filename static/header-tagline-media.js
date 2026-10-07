"use strict";

// Native GIF playback is presentation only. Switching to the composited first
// frame stops it without a decoder or a wider CSP policy. After typing ends,
// one bounded timer lets the supplied character play for two more seconds.
(function (root) {
  function create(element, motion, host = root) {
    const animated = "/header-tagline-character.gif", still = "/header-tagline-character-still.png";
    let sequence = 0, closed = false, failed = false, finishTimer = null;
    const schedule = host?.setTimeout?.bind(host) || setTimeout;
    const cancel = host?.clearTimeout?.bind(host) || clearTimeout;
    function cancelFinish() { cancel(finishTimer); finishTimer = null; }
    function showStopped(reason = "stopped") {
      if (!element) return;
      element.dataset.taglineMotion = reason;
      if (element.getAttribute("src") !== still) element.setAttribute("src", still);
    }
    function start() {
      cancelFinish();
      if (closed || failed || !element) return;
      if (motion?.matches) { showStopped("reduced"); return; }
      element.dataset.taglineMotion = "playing";
      // A unique same-origin URL restarts native GIF decoding for each phrase.
      element.setAttribute("src", `${animated}?play=${++sequence}`);
    }
    function stop() { cancelFinish(); showStopped(closed ? "closed" : motion?.matches ? "reduced" : "stopped"); }
    function finish() {
      cancelFinish();
      if (closed || failed || !element || motion?.matches) { stop(); return; }
      finishTimer = schedule(stop, 2000);
    }
    function close() { closed = true; stop(); }
    motion?.addEventListener?.("change", event => { if (event.matches) stop(); });
    element?.addEventListener?.("error", () => { if (element.dataset.taglineMotion === "playing") { failed = true; stop(); } });
    host?.addEventListener?.("pagehide", close, { once: true });
    stop();
    return Object.freeze({ start, finish, stop, close });
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = Object.freeze(api);
  if (root) root.CeasefireHeaderTaglineMedia = create(root.document.getElementById("header-tagline-character"), root.matchMedia?.("(prefers-reduced-motion: reduce)"));
})(typeof window === "object" ? window : null);
