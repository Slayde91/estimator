"use strict";

// Feedback never delays navigation or replays a blocked interaction later.
(function (root) {
  const sources = Object.freeze({
    move: "/sounds/mgs1-menu-move.mp3",
    confirm: "/sounds/mgs-confirm2.mp3",
  });
  const feedbackSources = Object.freeze({
    hover: "/sounds/hover.mp3",
    select: "/sounds/select.mp3",
    selectOther: "/sounds/select-2.mp3",
    checkpoint: "/sounds/checkpoint.ogg",
    // Keep the existing served asset slot; its bytes are the supplied flame_whoosh.mp3.
    explosion: "/sounds/new-explosion.mp3",
  });
  const printingSource = "/sounds/mixkit-vintage-dot-printing-1371.wav";
  const loadingSource = "/sounds/loading.mp3";

  function stopAudio(audio) {
    try { audio?.pause(); if (audio && audio.currentTime !== 0) audio.currentTime = 0; } catch { /* Media failure must not affect a control. */ }
  }
  function createPlayers(clips, host) {
    let closed = false, generation = 0;
    const players = Object.fromEntries(Object.entries(clips).map(([kind, source]) => {
      try {
        const audio = new host.Audio();
        audio.preload = "auto";
        audio.src = source;
        audio.load();
        return [kind, audio];
      } catch { return [kind, null]; }
    }));
    function stop() { ++generation; for (const audio of Object.values(players)) stopAudio(audio); }
    function play(kind) {
      if (closed) return;
      const audio = players[kind];
      // Seeking a decoded clip can temporarily lower readyState. Check before
      // rewinding, then start that loaded clip directly in this same event.
      const loaded = audio && !audio.error && audio.readyState >= 2;
      ++generation;
      // Pause other clips without seeking them. A hover just before a click
      // must not leave that click's already-decoded clip temporarily unready.
      for (const player of Object.values(players)) {
        if (player === audio) stopAudio(player);
        else { try { player?.pause(); } catch { /* Feedback must not affect the control. */ } }
      }
      const attempt = generation;
      // Skip unloaded audio instead of letting it begin after this interaction.
      if (!loaded) return;
      try {
        const pending = audio.play();
        pending?.catch?.(() => { if (generation === attempt) stopAudio(audio); });
      } catch { stopAudio(audio); }
    }
    function close() { closed = true; stop(); }
    return Object.freeze({ play, stop, close });
  }
  const silent = Object.freeze({ play() {}, start() {}, stop() {}, close() {} });

  function create(navigation, host = root) {
    if (!navigation || typeof host?.Audio !== "function") return silent;
    const players = createPlayers(sources, host);
    const bindings = [...navigation.querySelectorAll("button")].map(button => {
      const enter = event => { if (event.pointerType !== "touch" && !button.disabled) players.play("move"); };
      const click = () => { if (!button.disabled) players.play("confirm"); };
      // Direct pointerenter listeners avoid sounds for nested icons or bubbling choices.
      button.addEventListener("pointerenter", enter);
      button.addEventListener("click", click);
      return { button, enter, click };
    });
    host.addEventListener?.("pagehide", players.stop);
    function close() {
      players.close();
      for (const { button, enter, click } of bindings) {
        button.removeEventListener("pointerenter", enter);
        button.removeEventListener("click", click);
      }
      host.removeEventListener?.("pagehide", players.stop);
    }
    return Object.freeze({ close, play: players.play, stop: players.stop });
  }

  function createFeedback(document, host = root, menu = silent) {
    if (!document?.addEventListener || typeof host?.Audio !== "function") return silent;
    const players = createPlayers(feedbackSources, host);
    const selector = 'button, a.button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], summary';
    let closed = false;
    const element = target => target?.nodeType === 3 ? target.parentElement : target;
    function enabled(button) {
      return button && !button.disabled && !button.matches?.(":disabled") && button.getAttribute?.("aria-disabled") !== "true" && !button.closest?.("[inert]");
    }
    function contains(button, target) { try { return !!button && !!target && button.contains(target); } catch { return false; } }
    function drawingTarget(target) {
      // SVG markups and handles use role=button for editing. Only explicit
      // context-menu commands participate in button feedback inside the PDF.
      return target?.closest?.("#takeoff-viewport") && !target.closest(".takeoff-control-menu");
    }
    function route(button, click) {
      if (closed || document.hidden || !enabled(button)) return;
      // The global Save control owns one distinct click, regardless of the
      // page behind it. Do not also emit that page's ordinary selection clip.
      if (click && button.id === "save-current-project") { menu.stop?.(); players.play("checkpoint"); return; }
      // The header's direct listeners own its sounds. Home shares the same
      // two players; a calculator hub card outside Home uses ordinary feedback.
      if (button.closest(".app-header")) { players.stop(); return; }
      if (button.closest("#view-home")) { players.stop(); menu.play?.(click ? "confirm" : "move"); }
      else {
        // Takeoff dialogs are appended to body, so their active workspace
        // supplies the context even when they are outside #view-takeoffs.
        const takeoff = button.closest("#view-takeoffs") || (button.closest('dialog, [role="dialog"]') && document.body?.classList?.contains("takeoffs-active"));
        menu.stop?.(); players.play(click ? (takeoff ? "select" : "selectOther") : "hover");
      }
    }
    function over(event) {
      const target = element(event.target);
      if (drawingTarget(target)) { stop(); return; }
      if (event.pointerType === "touch") return;
      const button = target?.closest?.(selector);
      // Moving between a button's icon and label is not another entry.
      if (!contains(button, event.relatedTarget)) route(button, false);
    }
    function click(event) {
      const target = element(event.target);
      if (drawingTarget(target)) { stop(); return; }
      if (!closed && !document.hidden && target?.closest?.(".app-header .brand")) {
        menu.stop?.(); players.play("explosion"); return;
      }
      route(target?.closest?.(selector), true);
    }
    function stop() { players.stop(); menu.stop?.(); }
    function visibility() { if (document.hidden) stop(); }
    // Delegation covers buttons created after load, including dialogs and
    // library results. Capture plays before their navigation/render handlers.
    document.addEventListener("pointerover", over, { capture: true, passive: true });
    document.addEventListener("click", click, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visibility);
    host.addEventListener?.("pagehide", stop);
    function close() {
      closed = true; players.close(); menu.stop?.();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("visibilitychange", visibility);
      host.removeEventListener?.("pagehide", stop);
    }
    return Object.freeze({ stop, close });
  }

  function createPrinting(motion, host = root, document = host?.document) {
    if (typeof host?.Audio !== "function") return silent;
    let audio;
    try {
      audio = new host.Audio(); audio.preload = "auto"; audio.loop = true;
      audio.src = printingSource; audio.load();
    } catch { return silent; }
    let active = false, closed = false, generation = 0, attempted = -1;
    function stop() { active = false; ++generation; stopAudio(audio); }
    function playCurrent() {
      if (closed || !active || motion?.matches || document?.hidden || audio.error || audio.readyState < 2 || attempted === generation) return;
      const attempt = attempted = generation;
      try { audio.play()?.catch?.(() => { if (attempt === generation) stop(); }); }
      catch { stop(); }
    }
    function start() {
      stop();
      if (closed || motion?.matches || document?.hidden) return;
      active = true; playCurrent();
    }
    function visibility() { if (document?.hidden) stop(); }
    function preference(event) { if (event.matches) stop(); }
    // Readiness can start only the phrase that is still printing. Finishing,
    // cancelling or blocking that phrase invalidates the attempt permanently.
    audio.addEventListener?.("canplay", playCurrent);
    audio.addEventListener?.("error", stop);
    document?.addEventListener?.("visibilitychange", visibility);
    motion?.addEventListener?.("change", preference);
    host.addEventListener?.("pagehide", close);
    function close() {
      closed = true; stop();
      audio.removeEventListener?.("canplay", playCurrent);
      audio.removeEventListener?.("error", stop);
      document?.removeEventListener?.("visibilitychange", visibility);
      motion?.removeEventListener?.("change", preference);
      host.removeEventListener?.("pagehide", close);
    }
    return Object.freeze({ start, stop, close });
  }

  function createDownloadSound(host = root) {
    if (typeof host?.Audio !== "function") return Object.freeze({ begin: () => () => {}, close() {} });
    let audio;
    try { audio = new host.Audio(); audio.preload = "auto"; audio.loop = true; audio.src = loadingSource; audio.load(); }
    catch { return Object.freeze({ begin: () => () => {}, close() {} }); }
    const pending = new Set();
    let generation = 0, attempted = -1, closed = false;
    function stop() { ++generation; stopAudio(audio); }
    function failed() { stop(); attempted = generation; }
    function playCurrent() {
      if (closed || !pending.size || audio.error || audio.readyState < 2 || attempted === generation) return;
      const attempt = attempted = generation;
      try { audio.play()?.catch?.(() => { if (attempt === generation) failed(); }); }
      catch { failed(); }
    }
    function begin() {
      if (closed) return () => {};
      const token = {}; pending.add(token);
      // Concurrent exports share one bounded loop. An earlier completion must
      // not stop audio while another file is still being prepared or saved.
      if (pending.size === 1) { stop(); playCurrent(); }
      return () => { if (pending.delete(token) && !pending.size) stop(); };
    }
    function close() { closed = true; pending.clear(); stop(); audio.removeEventListener?.("canplay", playCurrent); audio.removeEventListener?.("error", failed); host.removeEventListener?.("pagehide", close); }
    audio.addEventListener?.("canplay", playCurrent);
    audio.addEventListener?.("error", failed);
    host.addEventListener?.("pagehide", close);
    return Object.freeze({ begin, close });
  }

  if (typeof module === "object" && module.exports) module.exports = Object.freeze({ create, sources, createFeedback, feedbackSources, createPrinting, printingSource, createDownloadSound, loadingSource });
  if (root) {
    root.CeasefireHeaderMenuSounds = create(root.document.querySelector(".app-header nav"), root);
    root.CeasefireButtonSounds = createFeedback(root.document, root, root.CeasefireHeaderMenuSounds);
    root.CeasefireHeaderTaglineSound = createPrinting(root.matchMedia?.("(prefers-reduced-motion: reduce)"), root, root.document);
    root.CeasefireDownloadSound = createDownloadSound(root);
  }
})(typeof window === "object" ? window : null);
