(() => {
  "use strict";

  async function save(path, payload = {}) {
    // Capture the destination with the clicked draft. Later Save As, New or
    // Open actions must not redirect a file that is already being prepared.
    const download = window.CeasefireProject?.downloadTarget?.() || { project_token: null };
    const body = JSON.stringify({ ...payload, download: { project_token: download.project_token ?? null } });
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body,
    });
    const json = String(response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() === "application/json";
    const result = json ? await response.json().catch(() => null) : null;
    if (!response.ok) throw new Error(result?.error || `The file could not be saved (${response.status}).`);
    if (!json) throw new Error("The server did not return a file-save confirmation.");
    if (result?.saved !== true || typeof result.path !== "string" || !result.path.trim() ||
        typeof result.filename !== "string" || !result.filename.trim() || !["project", "downloads"].includes(result.destination)) {
      throw new Error("The server did not confirm that the file was saved.");
    }
    return result;
  }

  window.CeasefireDownloads = { save };
})();
