"use strict";

// Header feedback never delays navigation or replays a blocked interaction later.
(function (root) {
  const sources = Object.freeze({
    move: "/sounds/mgs1-menu-move.mp3",
    confirm: "/sounds/mgs-confirm2.mp3",
  });

  function create(navigation, host = root) {
    if (!navigation || typeof host?.Audio !== "function") return Object.freeze({ close() {} });
    let closed = false, generation = 0;
    const players = Object.fromEntries(Object.entries(sources).map(([kind, source]) => {
      try {
        const audio = new host.Audio();
        audio.preload = "auto";
        audio.src = source;
        audio.load();
        return [kind, audio];
      } catch { return [kind, null]; }
    }));
    function stop(audio) {
      try { audio?.pause(); if (audio && audio.currentTime !== 0) audio.currentTime = 0; } catch { /* Media failure must not affect a menu. */ }
    }
    function stopAll() { ++generation; for (const audio of Object.values(players)) stop(audio); }
    function play(kind) {
      if (closed) return;
      const audio = players[kind];
      // Seeking a decoded clip can temporarily lower readyState. Check before
      // rewinding, then start that loaded clip directly in this same event.
      const loaded = audio && !audio.error && audio.readyState >= 2;
      stopAll();
      const attempt = generation;
      // Skip unloaded audio instead of letting it begin after this interaction.
      if (!loaded) return;
      try {
        const pending = audio.play();
        pending?.catch?.(() => { if (generation === attempt) stop(audio); });
      } catch { stop(audio); }
    }
    const bindings = [...navigation.querySelectorAll("button")].map(button => {
      const enter = event => { if (event.pointerType !== "touch" && !button.disabled) play("move"); };
      const click = () => { if (!button.disabled) play("confirm"); };
      // Direct pointerenter listeners avoid sounds for nested icons or bubbling choices.
      button.addEventListener("pointerenter", enter);
      button.addEventListener("click", click);
      return { button, enter, click };
    });
    host.addEventListener?.("pagehide", stopAll);
    function close() {
      closed = true;
      stopAll();
      for (const { button, enter, click } of bindings) {
        button.removeEventListener("pointerenter", enter);
        button.removeEventListener("click", click);
      }
      host.removeEventListener?.("pagehide", stopAll);
    }
    return Object.freeze({ close });
  }

  if (typeof module === "object" && module.exports) module.exports = Object.freeze({ create, sources });
  if (root) root.CeasefireHeaderMenuSounds = create(root.document.querySelector(".app-header nav"), root);
})(typeof window === "object" ? window : null);
