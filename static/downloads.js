(() => {
  "use strict";
  // Bind application-owned copy only; node() remains safe for user and source text.
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index])); return element;
  };
  const uiAttr = (element, name, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.attr(element, name, source, args);
    const value = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
    element.setAttribute(name, value); if (["title", "placeholder"].includes(name)) element[name] = value; return element;
  };


  function progressView(button) {
    const host = button?.closest?.('.calculator-document-menu, .takeoff-document-menu') || button?.parentElement;
    if (!host) return { update() {}, remove() {} };
    const box = document.createElement('div'); box.className = 'document-download-progress';
    const label = document.createElement('span'), bar = document.createElement('progress');
    const track = document.createElement('div'), beam = document.createElement('span');
    track.className = 'document-download-track'; beam.className = 'document-download-beam';
    beam.setAttribute('aria-hidden', 'true'); label.setAttribute('role', 'status');
    bar.max = 100; uiAttr(bar, 'aria-label', "Document download progress");
    track.append(bar, beam); box.append(label, track); host.append(box);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let frame = null, disposed = false, shown = 10, target = 10;
    function stopAnimation() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }
    function measuredProgress(percent) {
      const next = Math.max(target, percent);
      if (box.dataset.indeterminate === 'false' && target === next) return;
      stopAnimation(); target = next;
      box.dataset.indeterminate = 'false';
      uiText(label, "Preparing file · {0}%", [Math.floor(target)]);
      uiAttr(bar, 'aria-valuetext', "{0}% preparation completed", [Math.floor(target)]);
      // Ease only to work the server has already reported. Elapsed time must
      // never advance the target or imply that an unmeasured job is nearly done.
      if (reducedMotion) { shown = target; bar.value = shown; return; }
      const from = shown;
      let start = null;
      bar.value = shown;
      const step = timestamp => {
        if (disposed) return;
        if (start === null) start = timestamp;
        const position = Math.min(1, (timestamp - start) / 280);
        shown = from + (target - from) * (1 - (1 - position) ** 3);
        bar.value = shown;
        frame = position < 1 ? requestAnimationFrame(step) : null;
      };
      frame = requestAnimationFrame(step);
    }
    return {
      update(percent, state) {
        if (disposed) return;
        box.dataset.state = state;
        if (state === 'saved') {
          stopAnimation(); box.dataset.indeterminate = 'false';
          shown = target = 100; bar.value = 100;
          uiText(label, "File saved · 100%"); uiAttr(bar, 'aria-valuetext', "File saved");
        } else if (state === 'preparing' && percent > 10 && percent <= 85) {
          // The backend's optional completed/total page count is the measured
          // preparation range. Claiming (10%) and saving (90%) have no work total.
          measuredProgress(percent);
        } else {
          stopAnimation(); box.dataset.indeterminate = 'true'; bar.removeAttribute('value');
          uiText(label, {saving:'Saving file',confirming:'Confirming file save'}[state] || 'Preparing file');
          uiAttr(bar, 'aria-valuetext', window.CeasefireI18n?.source(label) || label.textContent);
        }
      },
      remove() { disposed = true; stopAnimation(); box.remove(); },
    };
  }

  async function save(path, payload = {}, { button = document.activeElement } = {}) {
    const endActivity = window.CeasefireActivity?.begin();
    let endSound, view, poll = null, finished = false, token = null;
    try {
    view = progressView(button);
    endSound = window.CeasefireDownloadSound?.begin();
    view.update(0, 'waiting');
    // Capture the destination with the clicked draft. Later Save As, New or
    // Open actions must not redirect a file that is already being prepared.
    const download = window.CeasefireProject?.downloadTarget?.() || { project_token: null };
    const body = JSON.stringify({ ...payload, download: { project_token: download.project_token ?? null } });
    const begin = await fetch('/api/download-progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const receipt = await begin.json();
    if (!begin.ok || typeof receipt?.token !== 'string') throw new Error(receipt?.error || 'Document progress could not be started.');
    token = receipt.token;
    const readProgress = async () => {
      try {
        const response = await fetch(`/api/download-progress/${encodeURIComponent(token)}`);
        const progress = await response.json();
        // A save receipt in the original response is the completion authority.
        if (!finished && response.ok && Number.isFinite(progress?.percent) && progress.percent >= 0 && progress.percent <= 100 && progress.state !== 'failed') {
          view.update(Math.min(99, progress.percent), progress.state === 'saved' ? 'confirming' : progress.state);
        }
      } catch { /* The original operation retains its success/error authority. */ }
      if (!finished) poll = setTimeout(readProgress, 400);
    };
    void readProgress();
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", 'X-Estimator-Download-Progress': token }, body,
    });
    const json = String(response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() === "application/json";
    const result = json ? await response.json().catch(() => null) : null;
    if (!response.ok) throw new Error(result?.error || `The file could not be saved (${response.status}).`);
    if (!json) throw new Error("The server did not return a file-save confirmation.");
    if (result?.saved !== true || typeof result.path !== "string" || !result.path.trim() ||
        typeof result.filename !== "string" || !result.filename.trim() || !["project", "downloads"].includes(result.destination)) {
      throw new Error("The server did not confirm that the file was saved.");
    }
    finished = true; clearTimeout(poll);
    view.update(100, 'saved');
    // Show the confirmed completion briefly, then retire even in a hidden tab.
    setTimeout(() => view.remove(), 500);
    return result;
    } finally {
      clearTimeout(poll); endSound?.(); endActivity?.();
      if (!finished) view?.remove();
      finished = true;
    }
  }

  window.CeasefireDownloads = { save };
})();
