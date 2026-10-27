"use strict";

(function (root) {
  const STORAGE_KEY = "classifire.play.v1";
  const gameIds = ["overspray", "fireline"];
  function cleanScores(value) {
    const result = {};
    for (const id of gameIds) {
      const row = value && typeof value === "object" ? value[id] : null;
      const number = key => Number.isSafeInteger(row?.[key]) && row[key] >= 0 ? Math.min(row[key], 999999999) : 0;
      result[id] = { best: number("best"), runs: number("runs"), wins: number("wins") };
    }
    return result;
  }
  function readScores(storage) {
    try { return cleanScores(JSON.parse(storage.getItem(STORAGE_KEY))); } catch { return cleanScores(null); }
  }
  function recordScore(scores, id, result) {
    const next = cleanScores(scores);
    if (!gameIds.includes(id) || !result) return next;
    next[id].runs = Math.min(999999999, next[id].runs + 1);
    if (result.won) next[id].wins = Math.min(999999999, next[id].wins + 1);
    if (result.eligible && Number.isFinite(result.score)) next[id].best = Math.max(next[id].best, Math.min(999999999, Math.max(0, Math.floor(result.score))));
    return next;
  }
  if (typeof module === "object" && module.exports) module.exports = { STORAGE_KEY, cleanScores, readScores, recordScore };
  if (!root.document) return;
  const document = root.document;
  const $ = id => document.getElementById(id);
  const view = $("view-play"), canvas = $("play-canvas"), context = canvas?.getContext("2d", { alpha: false });
  if (!view || !canvas || !context) return;
  let storage;
  try { storage = root.localStorage; } catch { /* Private browser mode can deny storage. */ }
  if (!storage) $("play-storage-note").textContent = "Scores are available for this visit. This browser cannot save them.";
  let scores = readScores(storage), game = null, gameId = "", visible = false, paused = false;
  let frame = 0, previousTime = 0, hudTime = 0, lastActions = "", lastStats = "", lastMessages = "", lastPhase = "", resultRecorded = false;
  const input = { keys: new Set(), pressed: new Set(), pointer: { x: 480, y: 300, down: false, clicked: false, inside: false } };
  function clearInput() { input.keys.clear(); input.pressed.clear(); input.pointer.down = false; input.pointer.clicked = false; }
  function stopFrame() { root.cancelAnimationFrame(frame); frame = 0; previousTime = 0; clearInput(); }
  function focusArena() {
    canvas.focus({ preventScroll: true });
    canvas.scrollIntoView({ block: "center", behavior: "instant" });
  }
  function updateScores() {
    for (const id of gameIds) $("play-best-" + id).textContent = scores[id].best ? "Personal best · " + scores[id].best.toLocaleString("en-AU") : "Your next shift starts here";
  }
  function saveResult(result) {
    scores = recordScore(scores, gameId, result);
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(scores)); } catch { $("play-storage-note").textContent = "Scores are available for this visit. This browser cannot save them."; }
    updateScores();
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function syncHud() {
    if (!game) return;
    const state = game.snapshot();
    $("play-game-title").textContent = state.title;
    $("play-game-subtitle").textContent = state.subtitle;
    const stats = JSON.stringify(state.stats);
    if (stats !== lastStats) {
      lastStats = stats;
      $("play-stats").replaceChildren(...state.stats.map(stat => {
        const item = node("div", "play-stat"); item.append(node("dt", "", stat.label), node("dd", "", String(stat.value))); return item;
      }));
    }
    const actions = JSON.stringify(state.actions);
    if (actions !== lastActions) {
      lastActions = actions;
      $("play-actions").replaceChildren(...state.actions.map(action => {
        const button = node("button", "button secondary", action.label);
        button.type = "button"; button.dataset.gameAction = action.id; button.disabled = !!action.disabled;
        if (typeof action.pressed === "boolean") button.setAttribute("aria-pressed", String(action.pressed));
        return button;
      }));
    }
    const messages = JSON.stringify(state.messages);
    if (messages !== lastMessages) { lastMessages = messages; $("play-messages").replaceChildren(...state.messages.map(text => node("li", "", text))); }
    if (state.phase !== lastPhase) { lastPhase = state.phase; $("play-status").textContent = state.title + ". " + state.subtitle; }
    $("play-session").dataset.phase = state.phase;
    $("play-result").hidden = !state.result;
    if (state.result) {
      $("play-result").textContent = state.result.message + " · Score " + Math.round(state.result.score).toLocaleString("en-AU") + (state.result.eligible ? "" : " · Not eligible for a high score");
      if (!resultRecorded) { resultRecorded = true; saveResult(state.result); }
    } else resultRecorded = false;
    $("play-pause").disabled = !["playing", "masking", "brief", "upgrade"].includes(state.phase);
  }
  function tick(time) {
    frame = 0;
    if (!game || !visible || paused) return;
    const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
    previousTime = time;
    try {
      game.update(dt, input); input.pressed.clear(); input.pointer.clicked = false;
      game.draw(context);
      if (time - hudTime >= 100) { hudTime = time; syncHud(); }
      frame = root.requestAnimationFrame(tick);
    } catch (error) {
      stopFrame(); game = null;
      $("play-status").textContent = "This game could not continue. Choose Games to return to the arcade.";
      $("play-result").hidden = false; $("play-result").textContent = $("play-status").textContent;
      $("play-actions").replaceChildren(); $("play-pause").disabled = true;
      root.console?.error("Play stopped", error);
    }
  }
  function startFrame() { if (!frame && game && visible && !paused) { previousTime = 0; frame = root.requestAnimationFrame(tick); } }
  function setPaused(value, reason) {
    if (!game) return;
    paused = value; stopFrame();
    $("play-session").dataset.paused = String(paused);
    $("play-pause-overlay").hidden = !value;
    $("play-pause").textContent = value ? "Resume" : "Pause";
    $("play-pause").setAttribute("aria-pressed", String(value));
    if (value) { $("play-pause-reason").textContent = reason || "Take your time. The site can wait."; $("play-status").textContent = "Game paused."; }
    else { $("play-status").textContent = "Game resumed."; focusArena(); startFrame(); }
  }
  function chooseGame(id) {
    if (!gameIds.includes(id)) return;
    stopFrame();
    const factory = root.ClassifireGames?.[id];
    if (!factory) { $("play-status").textContent = "This game is unavailable. Reload the page and try again."; return; }
    gameId = id; game = factory.create({ seed: 1977 }); paused = false; resultRecorded = false;
    document.body.classList.add("play-game-active");
    $("play-session").dataset.game = id; $("play-session").dataset.paused = "false";
    lastActions = lastStats = lastMessages = lastPhase = "";
    $("play-hub").hidden = true; $("play-session").hidden = false; $("play-pause-overlay").hidden = true;
    $("play-pause").textContent = "Pause"; $("play-pause").setAttribute("aria-pressed", "false");
    $("play-keys").textContent = id === "overspray" ? "Aim with the mouse. Hold left click to spray or clean. Click a surface to place or remove covers before starting. N nozzle · I inspection · C cleanup · Esc pause" : "WASD move · Mouse aim · Hold left click to fire · Space dash · Q foam · E barricade · R Overdrive · Esc pause";
    $("play-feed-title").textContent = id === "overspray" ? "Site inbox" : "Site radio";
    syncHud(); game.draw(context); focusArena(); startFrame();
  }
  function showHub() {
    stopFrame(); game = null; gameId = ""; paused = false;
    document.body.classList.remove("play-game-active");
    $("play-session").hidden = true; $("play-hub").hidden = false; $("play-pause-overlay").hidden = true;
    $("play-status").textContent = "Choose a game.";
    $("play-heading").focus({ preventScroll: true });
    root.scrollTo({ top: 0, behavior: "instant" });
  }
  function setVisible(value) {
    visible = !!value; document.body.classList.toggle("play-active", visible);
    document.body.classList.toggle("play-game-active", visible && !!game);
    if (!visible) { if (game) setPaused(true, "Paused while you were away. Resume when you are ready."); else stopFrame(); }
    else { updateScores(); if (!game) showHub(); }
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    input.pointer.x = (event.clientX - rect.left) * 960 / rect.width;
    input.pointer.y = (event.clientY - rect.top) * 600 / rect.height;
    input.pointer.inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }
  canvas.addEventListener("pointermove", point);
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !visible || paused || !game) return;
    event.preventDefault(); point(event); canvas.focus({ preventScroll: true });
    input.pointer.down = true; input.pointer.clicked = true; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointerup", event => { point(event); input.pointer.down = false; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); });
  canvas.addEventListener("lostpointercapture", () => { input.pointer.down = false; });
  canvas.addEventListener("pointercancel", clearInput);
  canvas.addEventListener("pointerleave", () => { input.pointer.inside = false; input.pointer.down = false; });
  const gameKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyQ", "KeyE", "KeyR", "KeyN", "KeyI", "KeyC"]);
  root.addEventListener("keydown", event => {
    if (!visible || !game || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code === "Escape" && !event.repeat && $("play-session").contains(document.activeElement)) { event.preventDefault(); setPaused(!paused); return; }
    if (paused || document.activeElement !== canvas || !gameKeys.has(event.code)) return;
    event.preventDefault(); if (!input.keys.has(event.code)) input.pressed.add(event.code); input.keys.add(event.code);
  });
  root.addEventListener("keyup", event => { input.keys.delete(event.code); });
  root.addEventListener("blur", () => { if (visible && game) setPaused(true, "Paused when the window lost focus."); });
  canvas.addEventListener("blur", clearInput);
  document.addEventListener("visibilitychange", () => { if (document.hidden && game) setPaused(true, "Paused while this tab was hidden."); });
  root.addEventListener("pagehide", stopFrame);
  for (const button of view.querySelectorAll("[data-game]")) button.addEventListener("click", () => chooseGame(button.dataset.game));
  $("play-actions").addEventListener("click", event => {
    const button = event.target.closest("[data-game-action]");
    if (!button || button.disabled || !game || paused) return;
    clearInput(); game.action(button.dataset.gameAction); syncHud(); game.draw(context); focusArena(); startFrame();
  });
  $("play-pause").addEventListener("click", () => setPaused(!paused));
  $("play-resume").addEventListener("click", () => setPaused(false));
  $("play-back").addEventListener("click", showHub);
  $("play-pause-back").addEventListener("click", showHub);
  root.CeasefirePlay = Object.freeze({ setVisible });
  updateScores();
})(typeof window !== "undefined" ? window : globalThis);
