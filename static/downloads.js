(() => {
  "use strict";

  function progressView(button) {
    const host = button?.closest?.('.calculator-document-menu, .takeoff-document-menu') || button?.parentElement;
    if (!host) return { update() {}, remove() {} };
    const box = document.createElement('div'); box.className = 'document-download-progress';
    const label = document.createElement('span'), bar = document.createElement('progress');
    bar.max = 100; bar.value = 0; bar.setAttribute('aria-label', 'Document download progress');
    box.append(label, bar); host.append(box);
    return {
      update(percent, state) {
        bar.value = percent;
        label.textContent = `${{waiting:'Preparing file',preparing:'Preparing file',saving:'Saving file',saved:'File saved'}[state] || 'Preparing file'} · ${percent}%`;
      },
      remove() { box.remove(); },
    };
  }

  async function save(path, payload = {}, { button = document.activeElement } = {}) {
    const endActivity = window.CeasefireActivity?.begin();
    const view = progressView(button);
    let poll = null, finished = false, token = null;
    view.update(0, 'waiting');
    try {
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
        if (!finished && response.ok && Number.isFinite(progress?.percent) && progress.percent >= 0 && progress.percent <= 100 && progress.state !== 'failed') view.update(Math.min(99, progress.percent), progress.state);
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
      if (!finished) view.remove();
      finished = true; clearTimeout(poll); endActivity?.();
    }
  }

  window.CeasefireDownloads = { save };
})();
