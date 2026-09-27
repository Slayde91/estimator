"use strict";

(() => {
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const G = window.CeasefireTakeoffGeometry;
  const state = { session: null, saved: null, opening: null, active: false, mode: "steel", document: null, page: 1,
    zoom: 1, tool: "select", points: [], selected: new Set(), hovered: null, hidden: new Set(), collapsed: new Set(),
    search: "", filter: "", sort: "mark", group: "", offset: 0, calibration: "", busy: false, queue: Promise.resolve(),
    renderId: 0, searchId: 0, viewport: null, pdfs: new Map(), pdfLoads: new Map(), thumbnailTasks: new Map(), thumbnailPages: new Map(), pdfWarnings: new Map(), pdfLibrary: null, resultMap: new Map(),
    formDirty: false, modal: false, issues: [], searchHits: [], pending: null, bindings: [], ui: null };
  const units = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 3 });
  const labels = { steel: "Steel", duct: "Duct" };
  const fields = {
    steel: [["mark", "Member mark"], ["level", "Level"], ["member_type", "Member type", ["Beam", "Column"]], ["section", "Steel section"], ["product", "Protection product"], ["fire_period_min", "Fire period (min)", "number"], ["sides", "Exposed sides", "number"], ["critical_temperature", "Critical temperature (°C)", "number"], ["exposure", "Exposure description"], ["zone", "Zone"], ["group", "Group"], ["notes", "Notes"]],
    duct: [["mark", "Run ID"], ["level", "Level"], ["shape", "Shape", ["rectangular", "circular"]], ["width_mm", "Width (mm)", "number"], ["height_mm", "Height (mm)", "number"], ["diameter_mm", "Diameter (mm)", "number"], ["product", "Protection product"], ["exposure", "Duct application / exposure"], ["system", "Mechanical system"], ["frl", "FRL"], ["orientation", "Orientation", ["Horizontal", "Vertical", "Both"]], ["wall_penetrations", "Wall penetrations", "number"], ["floor_penetrations", "Floor penetrations", "number"], ["zone", "Zone"], ["group", "Group"], ["notes", "Notes"]],
  };
  const snapshot = () => state.session?.snapshot;
  const documents = () => snapshot()?.documents || [];
  const items = () => snapshot()?.items || [];
  const documentById = id => documents().find(doc => doc.id === id);
  const currentDocument = () => documentById(state.document);
  const pageMetadata = () => currentDocument()?.pages?.find(page => page.page === state.page);
  const selectedItems = () => items().filter(item => state.selected.has(item.id) && item.mode === state.mode);
  const uuid = () => crypto.randomUUID();
  const snapshotKey = value => { if (!value) return null; const copy = clone(value); delete copy.companion_folder; return JSON.stringify(copy); };
  function node(tag, className = "", text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
  function option(value, label = value) { const el = node("option", "", label); el.value = value; return el; }
  function button(label, fn, cls = "button secondary") { const el = node("button", cls, label); el.type = "button"; el.addEventListener("click", () => void safely(fn)); return el; }
  function select(options, change, value) { const el = node("select"); options.forEach(([v, text]) => el.append(option(v, text))); if (value !== undefined) el.value = value; if (change) el.addEventListener("change", () => void safely(() => change(el.value))); return el; }
  function message(text = "", error = false) { if (!state.ui) return; state.ui.message.textContent = text; state.ui.message.hidden = !text; state.ui.message.className = `message${error ? " error" : ""}`; state.ui.message.setAttribute("role", error ? "alert" : "status"); }
  async function safely(fn) { try { return await fn(); } catch (error) { message(error.message || String(error), true); } }
  async function api(path, data, method = data === undefined ? "GET" : "POST") {
    const response = await fetch(`/api/takeoffs${path}`, { method, ...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }) });
    let result; try { result = await response.json(); } catch { throw new Error(`The takeoff server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(result.error || `Takeoff request failed (${response.status}).`);
    return result;
  }
  function accept(reply) {
    if (!reply?.session_id || !reply.snapshot || !Number.isInteger(reply.revision)) throw new Error("The takeoff response is incomplete.");
    state.session = reply; state.resultMap = new Map((reply.item_results || []).map(item => [item.id, item])); state.issues = reply.issues || [];
    state.selected = new Set([...state.selected].filter(id => items().some(item => item.id === id)));
    if (!currentDocument()) { state.document = documents()[0]?.id || null; state.page = 1; }
    state.bindings = snapshot().transfers || [];
    window.CeasefireProject?.changed?.();
  }
  function markFormEdited() { state.formDirty = true; state.formRevision = (state.formRevision || 0) + 1; window.CeasefireProject?.changed?.(); }
  function working(value) { state.busy = value; if (state.ui) { state.ui.root.setAttribute("aria-busy", String(value)); for (const control of state.ui.tableWrap?.querySelectorAll("input,select") || []) control.disabled = value; state.ui.status.textContent = value ? "Working…" : `${items().length} items · ${documents().length} documents · Revision ${state.session?.revision || 0}`; } window.CeasefireProject?.changed?.(); }
  function command(op, values = {}, guard) {
    const sessionId = state.session?.session_id;
    const task = state.queue.then(async () => {
      if (sessionId !== state.session?.session_id) throw new Error("The project changed. Repeat this action in the current project.");
      if (guard && !guard()) return null;
      working(true);
      try {
        const reply = await api(`/sessions/${sessionId}/commands`, { expected_revision: state.session.revision, request_id: uuid(), op, ...values });
        if (sessionId !== state.session?.session_id) throw new Error("The project changed while this operation was running.");
        accept(reply); renderData(); return reply;
      } finally { working(false); }
    });
    state.queue = task.catch(() => {}); return task;
  }
  async function ensureSession() {
    if (state.session) return state.session;
    const generation = state.generation || 0;
    const pending = state.opening ||= api("/sessions", {});
    let reply;
    try { reply = await pending; } finally { if (state.opening === pending) state.opening = null; }
    if (generation !== (state.generation || 0)) { void discardPreparedSession(reply.session_id); throw new Error("The project changed before the takeoff workspace opened."); }
    if (!state.session) { accept(reply); state.saved = snapshotKey(reply.snapshot); }
    return state.session;
  }
  function formField(definition, initial = "") {
    const [key, title, kind] = definition, wrapper = node("label", "field"); wrapper.append(node("span", "", title));
    const control = Array.isArray(kind) ? select([["", "Choose…"], ...kind.map(value => Array.isArray(value) ? value : [value, value])]) : node(kind === "textarea" ? "textarea" : "input");
    if (!Array.isArray(kind) && kind !== "textarea") control.type = kind === "number" ? "number" : "text";
    if (kind === "number") control.step = "any";
    if (Array.isArray(kind) && initial !== "" && initial != null && !kind.some(value => (Array.isArray(value) ? value[0] : value) === initial)) control.append(option(initial, `${initial} (retained)`));
    control.name = key; control.value = initial ?? ""; control.dataset.field = key; control.setAttribute("aria-label", title); wrapper.append(control);
    return { wrapper, control, read: () => { if (kind !== "number") return control.value.trim(); if (control.validity?.badInput) throw new Error(`${title}: enter a valid number.`); if (control.value.trim() === "") return null; const value = Number(control.value); if (!Number.isFinite(value)) throw new Error(`${title}: enter a finite number.`); return value; } };
  }
  async function ask(title, definitions, detail = "", action = "Apply") {
    if (state.modal) throw new Error("Finish the current review first.");
    state.modal = true; const sessionId = state.session?.session_id;
    const dialog = node("dialog", "takeoff-dialog"), form = node("form"); form.method = "dialog";
    const heading = node("h2", "", title); heading.id = `takeoff-dialog-${uuid()}`; dialog.setAttribute("aria-labelledby", heading.id); form.append(heading, node("p", "helper", detail));
    const controls = definitions.map(def => { const field = formField(def, def[3]); if (def[4]) field.control.required = true; form.append(field.wrapper); return field; });
    const actions = node("div", "actions"), cancel = node("button", "button secondary", "Cancel"), apply = node("button", "button primary", action); cancel.type = "button"; cancel.addEventListener("click", () => dialog.close("cancel")); apply.type = "submit"; apply.value = "confirm"; actions.append(cancel, apply); form.append(actions); dialog.append(form); document.body.append(dialog);
    try {
      const accepted = await new Promise(resolve => { dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); dialog.showModal(); });
      const result = accepted ? Object.fromEntries(controls.map(field => [field.control.name, field.read()])) : null;
      if (result && sessionId !== state.session?.session_id) throw new Error("The project changed during review. Repeat the action.");
      return result;
    } finally { state.modal = false; dialog.remove(); }
  }
  async function confirm(title, detail, action) { return (await ask(title, [], detail, action)) !== null; }
  function build() {
    if (state.ui) return;
    const root = $("takeoffs-workspace"); if (!root) return;
    const ui = state.ui = { root };
    const modes = node("div", "takeoff-modes"); modes.setAttribute("role", "tablist"); modes.setAttribute("aria-label", "Takeoff modes");
    for (const [mode, label] of [["steel", "STEEL"], ["duct", "DUCT"]]) {
      const el = button(label, () => changeMode(mode), "takeoff-mode"); el.dataset.mode = mode; el.setAttribute("role", "tab"); el.setAttribute("aria-selected", String(state.mode === mode));
      if (!labels[mode]) { el.disabled = true; el.title = "Planned after the Steel and Duct release"; }
      modes.append(el);
    }
    ui.message = node("div", "message"); ui.message.hidden = true;
    const toolbar = node("div", "takeoff-toolbar"); toolbar.setAttribute("aria-label", "Drawing tools");
    ui.upload = node("input"); ui.upload.type = "file"; ui.upload.accept = ".pdf,application/pdf"; ui.upload.multiple = true; ui.upload.hidden = true; ui.upload.id = "takeoff-upload";
    ui.upload.addEventListener("change", () => { const files = [...ui.upload.files]; ui.upload.value = ""; void safely(() => upload(files)); });
    toolbar.append(button("Upload PDFs", () => { if (!state.busy) ui.upload.click(); }, "button primary"), ui.upload);
    for (const [tool, title] of [["select", "Select"], ["pan", "Pan"], ["calibrate", "Calibrate"], ["trace", "Trace length"], ["cite", "Cite length"]]) { const el = button(title, () => setTool(tool)); el.dataset.tool = tool; toolbar.append(el); }
    toolbar.append(button("Finish trace", finishTrace), button("Cancel trace", cancelTrace));
    ui.calibration = select([["", "Select calibration"]], value => { state.calibration = value; }); ui.calibration.id = "takeoff-calibration"; ui.calibration.setAttribute("aria-label", "Drawing calibration"); toolbar.append(ui.calibration, button("Edit calibration", editCalibration));
    const navigation = node("div", "takeoff-toolbar"); navigation.setAttribute("aria-label", "Drawing navigation");
    navigation.append(button("‹ Page", () => navigatePage(state.page - 1)));
    ui.page = node("input", "takeoff-page-input"); ui.page.type = "number"; ui.page.min = "1"; ui.page.step = "1"; ui.page.value = "1"; ui.page.setAttribute("aria-label", "Page number"); ui.page.addEventListener("change", () => void safely(() => navigatePage(Number(ui.page.value))));
    ui.pageCount = node("span", "helper", "/ 0"); navigation.append(ui.page, ui.pageCount, button("Page ›", () => navigatePage(state.page + 1)), button("−", () => zoomBy(1 / 1.25)), button("+", () => zoomBy(1.25)), button("Fit page", fitPage));
    ui.zoom = node("span", "helper", "100%"); navigation.append(ui.zoom);
    ui.search = node("input"); ui.search.type = "search"; ui.search.placeholder = "Search PDF text…"; ui.search.setAttribute("aria-label", "Search original document text"); ui.search.addEventListener("keydown", event => { if (event.key === "Enter") void safely(runSearch); });
    ui.searchScope = select([["document", "This document"], ["all", "All documents"]]); ui.searchScope.setAttribute("aria-label", "Text search scope"); navigation.append(ui.search, ui.searchScope, button("Search", runSearch), button("Stop search", () => { ++state.searchId; state.ui.progress.textContent += " · Search cancelled; coverage is incomplete."; }));
    ui.progress = node("p", "takeoff-progress"); ui.progress.setAttribute("role", "status"); ui.searchResults = node("div", "takeoff-search-results"); ui.searchResults.hidden = true;
    const workspace = node("div", "takeoff-workspace-split"); ui.workspace = workspace;
    const layout = node("div", "takeoff-drawing-layout"); ui.rail = node("aside", "takeoff-rail"); ui.rail.setAttribute("aria-label", "Documents and page thumbnails");
    ui.viewport = node("div", "takeoff-viewport"); ui.viewport.id = "takeoff-viewport"; ui.viewport.tabIndex = 0; ui.viewport.setAttribute("aria-label", "Drawing. Choose a drawing tool, then click to mark source positions.");
    ui.pageWrap = node("div", "takeoff-page"); ui.pageWrap.hidden = true; ui.canvas = node("canvas"); ui.canvas.setAttribute("aria-label", "Original PDF page"); ui.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg"); ui.overlay.classList.add("takeoff-overlay"); ui.overlay.setAttribute("aria-label", "Takeoff markups");
    ui.pageWrap.append(ui.canvas, ui.overlay); ui.empty = node("div", "takeoff-empty"); ui.empty.append(node("strong", "", "Your drawing workspace"), node("p", "", "Upload the original PDFs, calibrate a known distance, then trace or cite each physical object. Review and confirm before transferring quantities.")); ui.viewport.append(ui.pageWrap, ui.empty);
    ui.inspector = node("aside", "takeoff-inspector"); ui.inspector.setAttribute("aria-label", "Selected takeoff item"); layout.append(ui.rail, ui.viewport, ui.inspector);
    const register = node("section", "takeoff-register"); ui.register = register; const heading = node("div", "section-heading"); ui.registerTitle = node("h2", "", "Steel register"); ui.status = node("span", "status-label", "Ready"); ui.registerLayout = select([["below", "Register below drawing"], ["beside", "Register beside drawing"]], value => { workspace.classList.toggle("beside", value === "beside"); }); ui.registerLayout.setAttribute("aria-label", "Register position"); heading.append(ui.registerTitle, ui.status, ui.registerLayout); register.append(heading);
    const controls = node("div", "takeoff-register-controls"); ui.filter = node("input"); ui.filter.type = "search"; ui.filter.placeholder = "Filter register…"; ui.filter.setAttribute("aria-label", "Filter register"); ui.filter.addEventListener("input", () => { state.filter = ui.filter.value.toLowerCase(); state.offset = 0; renderRegister(); renderOverlay(); });
    ui.statusFilter = select([["", "All review states"], ["draft", "Draft"], ["reviewed", "Reviewed"], ["confirmed", "Confirmed"], ["review_required", "Needs review"], ["blocked", "Blocked"], ["insufficient", "Insufficient evidence"]], () => { renderRegister(); renderOverlay(); }); ui.statusFilter.setAttribute("aria-label", "Filter review state");
    ui.sort = select([["mark", "Sort: Mark"], ["level", "Sort: Level"], ["length", "Sort: Length"], ["state", "Sort: Review state"]], value => { state.sort = value; renderRegister(); }); ui.sort.setAttribute("aria-label", "Sort register");
    ui.group = select([["", "No grouping"], ["level", "Group by level"], ["group", "Group by label"], ["state", "Group by review state"]], value => { state.group = value; renderRegister(); }); ui.group.setAttribute("aria-label", "Group register");
    controls.append(ui.filter, ui.statusFilter, ui.sort, ui.group, button("Select filtered items", async () => { if (!await discardEditor()) return; visibleItems().forEach(item => state.selected.add(item.id)); renderSelection(); }), button("Clear selection", async () => { if (!await discardEditor()) return; state.selected.clear(); renderSelection(); }), button("Undo last edit", () => { requireFinishedEdits(); return command("undo"); }));
    ui.bulk = node("div", "takeoff-bulk"); ui.bulk.hidden = true; ui.selectionCount = node("strong"); ui.bulkField = select([]); ui.bulkField.setAttribute("aria-label", "Bulk edit field"); ui.bulkValue = node("input"); ui.bulkValue.setAttribute("aria-label", "Bulk edit value"); ui.bulkValue.placeholder = "New value (blank clears)";
    ui.bulk.append(ui.selectionCount, ui.bulkField, ui.bulkValue, button("Apply to selected", bulkEdit), button("Review", () => reviewSelected(false)), button("Confirm", () => reviewSelected(true)), button("Unconfirm", () => selectedCommand("unconfirm_items")), button("Delete", deleteSelected), ui.split = button("Split", splitSelected), ui.merge = button("Merge", mergeSelected));
    const exports = node("div", "takeoff-register-controls"); ui.target = select([["steel_vermiculite", "Steel Spray Schedule"], ["steel_board", "Steel Board Schedule"]], () => { if (!state.formDirty) renderInspector(); }); ui.target.setAttribute("aria-label", "Destination schedule");
    exports.append(ui.target, button("Preview transfer", () => transfer(false)), button("Update linked rows", () => transfer(true)), button("Detach links", detachSelected), button("Export CSV", () => exportRegister("csv")), button("Export XLSX", () => exportRegister("xlsx")), button("Audit history", showAudit));
    ui.tableWrap = node("div", "takeoff-register-table"); ui.pagination = node("div", "takeoff-register-controls"); register.append(controls, ui.bulk, exports, ui.tableWrap, ui.pagination);
    workspace.append(layout, register); root.append(modes, ui.message, toolbar, navigation, ui.progress, ui.searchResults, workspace);
    ui.overlay.addEventListener("pointerdown", drawingPointer); ui.viewport.addEventListener("pointerdown", beginPan);
    ui.viewport.addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); void safely(() => zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15)); } }, { passive: false });
    ui.viewport.addEventListener("keydown", event => { if (event.key === "Escape") cancelTrace(); if (event.key === "Enter" && state.tool === "trace") { event.preventDefault(); void safely(finishTrace); } if (event.key === "Backspace" && state.points.length) { event.preventDefault(); state.points.pop(); renderOverlay(); } });
  }
  async function open() { build(); state.active = true; await ensureSession(); renderData(); if (state.document) await renderPage(); }
  async function changeMode(mode) { if (!labels[mode] || state.busy) return; if (!await discardEditor()) return; state.mode = mode; state.offset = 0; state.selected.clear(); cancelTrace(); renderData(); }
  function requireFinishedEdits() { if (state.formDirty || state.points.length) throw new Error("Apply or discard the unfinished item edits and finish or cancel the current trace first."); }
  async function discardEditor() { if (!state.formDirty && !state.points.length) return true; if (!await confirm("Discard unfinished edits?", "The item form or current trace has unapplied changes. Saved takeoff items are retained.", "Discard edits")) return false; state.formDirty = false; state.points = []; return true; }
  function renderData() {
    if (!state.ui) return;
    for (const el of state.ui.root.querySelectorAll("[data-mode]")) el.setAttribute("aria-selected", String(el.dataset.mode === state.mode));
    state.ui.registerTitle.textContent = `${labels[state.mode]} register`;
    const targets = state.mode === "steel" ? [["steel_vermiculite", "Steel Spray Schedule"], ["steel_board", "Steel Board Schedule"]] : [["ductwork", "Ductwork Schedule"]];
    const target = state.ui.target.value; state.ui.target.replaceChildren(...targets.map(([id, label]) => option(id, label))); if (targets.some(([id]) => id === target)) state.ui.target.value = target;
    const oldBulk = state.ui.bulkField.value; state.ui.bulkField.replaceChildren(option("quantity", "Quantity"), ...fields[state.mode].map(([key, label]) => option(key, label))); if (oldBulk) state.ui.bulkField.value = oldBulk;
    renderRail(); renderCalibrations(); renderRegister(); if (!state.formDirty) renderInspector(); renderOverlay(); working(state.busy);
  }
  function renderCalibrations() {
    const calibrations = (snapshot()?.calibrations || []).filter(calibration => calibration.document_id === state.document && calibration.page === state.page);
    state.ui.calibration.replaceChildren(option("", "Select calibration"), ...calibrations.map(calibration => option(calibration.id, calibration.name)));
    if (!calibrations.some(calibration => calibration.id === state.calibration)) state.calibration = "";
    state.ui.calibration.value = state.calibration;
  }
  function renderRail() {
    const key = JSON.stringify([state.session?.session_id, documents().map(doc => [doc.id, doc.name, doc.pages.length]), state.document, state.page]);
    if (state.railKey === key) return;
    state.railKey = key;
    const rail = state.ui.rail; rail.replaceChildren(node("h3", "", "SOURCE DOCUMENTS"));
    for (const doc of documents()) {
      const el = button(doc.name, () => navigateDocument(doc.id), "takeoff-document"); el.setAttribute("aria-selected", String(doc.id === state.document)); el.append(node("small", "", `${doc.pages.length} pages · ${units.format(doc.size / 1048576)} MiB`)); rail.append(el);
    }
    const current = currentDocument(); if (!current) return;
    rail.append(button("Remove document", removeDocument, "text-button"), node("h3", "", "PAGES"));
    const thumbnails = node("div", "takeoff-thumbnails"); state.ui.thumbnails = thumbnails; rail.append(thumbnails);
    const first = Math.max(1, state.page - 3), last = Math.min(current.pages.length, first + 7);
    if (first > 1) thumbnails.append(button("Earlier pages", () => navigatePage(Math.max(1, first - 8)), "text-button"));
    for (let page = first; page <= last; page++) {
      const el = button(`Page ${page}`, () => navigatePage(page), "takeoff-thumbnail"); el.dataset.page = page; if (page === state.page) el.setAttribute("aria-current", "page"); const canvas = node("canvas"); canvas.width = 110; canvas.height = 145; el.prepend(canvas); thumbnails.append(el);
    }
    if (last < current.pages.length) thumbnails.append(button("Later pages", () => navigatePage(last + 1), "text-button"));
  }
  async function navigateDocument(id, page = 1) { if (state.busy || !await discardEditor()) return; state.document = id; state.page = page; state.calibration = ""; renderRail(); renderCalibrations(); await renderPage(); }
  async function navigatePage(page) { const doc = currentDocument(); if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages.length) throw new Error("Choose a page within this document."); if (!await discardEditor()) return; state.page = page; state.calibration = ""; renderRail(); renderCalibrations(); await renderPage(); }
  function boundedPdf(promise, label, abort, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeout / 1000} seconds. Retry the page or supply a simpler source PDF.`);
        error.name = "PdfTimeoutError";
        try { abort?.(); } catch { /* The timeout must remain actionable even if cleanup fails. */ }
        reject(error);
      }, timeout);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  function destroyPdfResources(task, pdfWorker, worker) {
    // A stalled worker cannot acknowledge PDF.js's asynchronous destroy.
    // Terminate the OS worker immediately; never await that acknowledgement.
    try { Promise.resolve(task.destroy()).catch(() => {}); } catch { /* Already destroyed. */ }
    try { pdfWorker.destroy(); } finally { worker.terminate(); }
  }
  function discardPdf(id, sessionId = state.session?.session_id, expectedPdf) {
    const key = `${sessionId}/${id}`, entry = state.pdfs.get(key);
    if (entry && (!expectedPdf || entry.document === expectedPdf)) { state.pdfs.delete(key); entry.destroy(); }
  }
  function pdfPage(pdf, id, page, sessionId) {
    if (sessionId !== state.session?.session_id) { const error = new Error("The project changed before loading the drawing page."); error.name = "RenderingCancelledException"; return Promise.reject(error); }
    return boundedPdf(pdf.getPage(page), `Loading PDF page ${page}`, () => discardPdf(id, sessionId, pdf));
  }
  async function recordPdfFailure(docId, page, error, sessionId = state.session?.session_id, visible = true, guard = () => true) {
    if (sessionId !== state.session?.session_id || !guard()) return;
    if (visible && docId === state.document && page === state.page && state.ui) {
      const notice = `This page could not be rendered completely. Review and confirmation are blocked. ${error.message}`;
      state.pageError = { document_id: docId, page, notice };
      state.viewport = null; state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false;
      state.ui.empty.replaceChildren(node("strong", "", "Drawing unavailable"), node("p", "", error.message));
      state.ui.progress.textContent = `Page ${page} blocked: ${error.message}`;
      message(notice, true);
    }
    await command("record_render", { document_id: docId, page, success: false, warnings: [...documentWarnings(docId), error.message] }, guard).catch(() => {});
  }
  function documentWarnings(id) {
    const retained = (snapshot()?.render_checks || []).filter(check => check.document_id === id).flatMap(check => check.warnings || []).filter(text => text.startsWith("PDF warning:"));
    return [...new Set([...(state.pdfWarnings.get(id) || []), ...retained])].slice(0, 20);
  }
  function notePdfWarning(id, text, sessionId = state.session?.session_id) {
    if (!id || sessionId !== state.session?.session_id) return;
    const warning = `PDF warning: ${String(text).slice(0, 500)}`, warnings = documentWarnings(id);
    if (warnings.includes(warning) || warnings.length >= 20) return;
    warnings.push(warning); state.pdfWarnings.set(id, warnings);
    // A worker may report omitted content during thumbnail decoding, after the
    // main page finished. Invalidate every prior proof for this document.
    const pages = new Set((snapshot()?.render_checks || []).filter(check => check.document_id === id).map(check => check.page));
    if (id === state.document) pages.add(state.page);
    for (const page of pages) void command("record_render", { document_id: id, page, success: false, warnings }).catch(() => {});
    if (id === state.document) message(`PDF content could not be verified. Review and confirmation are blocked. ${warnings.join(" ")}`, true);
  }
  function installPdfDiagnostics() {
    if (state.consoleRestore) return;
    const originals = { warn: console.warn, error: console.error }, wrappers = {};
    for (const method of ["warn", "error"]) {
      wrappers[method] = (...args) => {
        // Main-thread PDF.js paths (font outlines, canvas images) also warn.
        // Do not attribute unrelated application warnings to a drawing.
        if (String(new Error().stack || "").includes("/vendor/pdfjs/")) {
          // Display warnings concern the active canvas. Worker diagnostics
          // carry their owning document explicitly; never contaminate other
          // retained documents merely because their PDF cache is still open.
          notePdfWarning(state.document, args.map(String).join(" "));
        }
        originals[method].apply(console, args);
      };
      console[method] = wrappers[method];
    }
    state.consoleRestore = () => { for (const method of ["warn", "error"]) if (console[method] === wrappers[method]) console[method] = originals[method]; state.consoleRestore = null; };
  }
  async function pdfLibrary() {
    installPdfDiagnostics();
    state.pdfLibrary ||= import("/vendor/pdfjs/build/pdf.mjs").then(lib => { lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs"; return lib; }).catch(error => { state.pdfLibrary = null; throw error; });
    return state.pdfLibrary;
  }
  async function pdfDocument(id) {
    const sessionId = state.session.session_id, key = `${sessionId}/${id}`;
    if (state.pdfs.has(key)) return state.pdfs.get(key).promise;
    if (state.pdfLoads.has(key)) return state.pdfLoads.get(key);
    const loading = loadPdfDocument(id, sessionId, key); state.pdfLoads.set(key, loading);
    try { return await loading; } finally { if (state.pdfLoads.get(key) === loading) state.pdfLoads.delete(key); }
  }
  async function loadPdfDocument(id, sessionId, key) {
    const lib = await pdfLibrary();
    const worker = new Worker("/takeoff-pdf-worker.mjs", { type: "module" });
    const onWarning = event => {
      if (typeof event.data?.ceasefire_pdf_warning !== "string") return;
      event.stopImmediatePropagation(); notePdfWarning(id, event.data.ceasefire_pdf_warning, sessionId);
    };
    worker.addEventListener("message", onWarning);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(new Error("The PDF worker did not start within 20 seconds.")), 20000);
        const ready = event => { if (event.data?.ceasefire_pdf_ready === true) { event.stopImmediatePropagation(); done(); } };
        const failed = () => done(new Error("The PDF worker could not start."));
        function done(error) { clearTimeout(timer); worker.removeEventListener("message", ready); worker.removeEventListener("error", failed); error ? reject(error) : resolve(); }
        worker.addEventListener("message", ready); worker.addEventListener("error", failed);
      });
      if (sessionId !== state.session?.session_id) throw new Error("The project changed while opening the drawing.");
    } catch (error) { worker.removeEventListener("message", onWarning); worker.terminate(); throw error; }
    const pdfWorker = new lib.PDFWorker({ port: worker });
    const task = lib.getDocument({ worker: pdfWorker, url: `/api/takeoffs/sessions/${sessionId}/documents/${encodeURIComponent(id)}/file`,
      cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/", iccUrl: "/vendor/pdfjs/iccs/",
      disableFontFace: true, useWasm: false, useWorkerFetch: true, stopAtErrors: true, enableXfa: false,
      maxImageSize: 64000000, canvasMaxAreaInBytes: 64000000, disableAutoFetch: true, disableStream: true });
    let destroyed = false;
    const entry = { promise: null, destroy: () => { if (destroyed) return; destroyed = true; worker.removeEventListener("message", onWarning); destroyPdfResources(task, pdfWorker, worker); } };
    entry.promise = boundedPdf(task.promise, "Opening PDF", () => entry.destroy());
    task.onPassword = () => { void entry.destroy(); message("Password-protected PDFs are not supported. Supply an authorised unlocked copy.", true); };
    state.pdfs.set(key, entry);
    while (state.pdfs.size > 2) { const oldest = [...state.pdfs.keys()].find(candidate => candidate !== key && candidate !== `${sessionId}/${state.document}`); if (!oldest) break; const evicted = state.pdfs.get(oldest); state.pdfs.delete(oldest); void evicted.destroy(); }
    try { const pdf = await entry.promise; entry.document = pdf; return pdf; } catch (error) { if (state.pdfs.get(key) === entry) state.pdfs.delete(key); entry.destroy(); throw error; }
  }
  async function releaseDocuments() { const tasks = [...state.pdfs.values()]; state.pdfs.clear(); state.pdfLoads.clear(); for (const task of state.thumbnailTasks.values()) task.cancel(); state.thumbnailTasks.clear(); state.thumbnailPages.clear(); state.pdfWarnings.clear(); state.consoleRestore?.(); await Promise.allSettled(tasks.map(task => task.destroy())); }
  async function renderPage() {
    if (!state.ui || !state.document) { if (state.ui) { state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false; } return; }
    const renderId = ++state.renderId, docId = state.document, pageNumber = state.page, sessionId = state.session.session_id;
    state.ui.page.value = String(pageNumber); state.ui.pageCount.textContent = `/ ${currentDocument().pages.length}`; state.ui.progress.textContent = `Rendering ${currentDocument().name}, page ${pageNumber}…`;
    state.viewport = null; state.ui.pageWrap.hidden = true; state.ui.empty.hidden = true; state.ui.overlay.replaceChildren();
    state.pending?.cancel?.(); state.pending = null;
    for (const task of state.thumbnailTasks.values()) task.cancel(); state.thumbnailTasks.clear();
    try {
      const pdf = await pdfDocument(docId), page = await pdfPage(pdf, docId, pageNumber, sessionId);
      if (renderId !== state.renderId) return;
      const viewport = page.getViewport({ scale: state.zoom }); state.viewport = viewport;
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      if (!(ratio > 0) || viewport.width > 40000 || viewport.height > 40000) throw new Error("This zoom is too large to display safely. Use Fit page.");
      const canvas = node("canvas"); canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio)); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute("aria-label", "Original PDF page");
      const render = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }); state.pending = render;
      await boundedPdf(render.promise, `Rendering PDF page ${pageNumber}`, () => { render.cancel(); discardPdf(docId, sessionId, pdf); }); if (renderId !== state.renderId || sessionId !== state.session?.session_id) return;
      state.ui.canvas.replaceWith(canvas); state.ui.canvas = canvas; state.ui.overlay.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`); state.ui.overlay.setAttribute("width", String(viewport.width)); state.ui.overlay.setAttribute("height", String(viewport.height));
      state.ui.pageWrap.hidden = false; state.ui.zoom.textContent = `${Math.round(state.zoom * 100)}%`; state.ui.progress.textContent = `${currentDocument().name} · Page ${pageNumber} · Original source`; renderOverlay();
      const warnings = documentWarnings(docId);
      await command("record_render", { document_id: docId, page: pageNumber, success: warnings.length === 0, warnings }, () => renderId === state.renderId);
      if (warnings.length) message(`PDF content could not be verified. Review and confirmation are blocked. ${warnings.join(" ")}`, true);
      else if (state.pageError?.document_id === docId && state.pageError.page === pageNumber) { if (state.ui.message.textContent === state.pageError.notice) message(); state.pageError = null; }
      void renderThumbnails(pdf, renderId, docId);
    } catch (error) {
      if (renderId !== state.renderId || error.name === "RenderingCancelledException") return;
      await recordPdfFailure(docId, pageNumber, error, sessionId, true, () => renderId === state.renderId);
    } finally { if (renderId === state.renderId) state.pending = null; }
  }
  async function renderThumbnails(pdf, renderId, docId) {
    const sessionId = state.session?.session_id, buttons = [...state.ui.thumbnails?.querySelectorAll("[data-page]") || []];
    for (const el of buttons) {
      if (renderId !== state.renderId) return;
      if (el.dataset.previewReady === "true") continue;
      let render, canvas;
      try {
        const page = await pdfPage(pdf, docId, Number(el.dataset.page), sessionId); if (renderId !== state.renderId) return;
        const natural = page.getViewport({ scale: 1 });
        if (![natural.width, natural.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("The source page has invalid dimensions.");
        const viewport = page.getViewport({ scale: Math.min(110 / natural.width, 145 / natural.height) });
        // Cancellation is asynchronous inside PDF.js. Never let two render
        // tasks share a canvas, even when the previous task was cancelled.
        canvas = node("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        render = page.render({ canvasContext: canvas.getContext("2d"), viewport }); state.thumbnailTasks.set(canvas, render); state.thumbnailPages.set(canvas, { document_id: docId, page: Number(el.dataset.page) });
        await boundedPdf(render.promise, `Rendering PDF preview ${el.dataset.page}`, () => { render.cancel(); discardPdf(docId, sessionId, pdf); });
        if (renderId === state.renderId && el.isConnected) { el.querySelector("canvas").replaceWith(canvas); el.dataset.previewReady = "true"; }
      } catch (error) {
        if (renderId === state.renderId && error.name !== "RenderingCancelledException") { el.append(node("small", "", "Preview unavailable")); if (error.name === "PdfTimeoutError") { await recordPdfFailure(docId, Number(el.dataset.page), error, sessionId, false, () => renderId === state.renderId); return; } notePdfWarning(docId, `Page ${el.dataset.page} preview failed: ${error.message}`); }
      } finally { if (canvas && state.thumbnailTasks.get(canvas) === render) state.thumbnailTasks.delete(canvas); if (canvas) state.thumbnailPages.delete(canvas); }
    }
  }
  async function fitPage() {
    if (!state.document) return; const docId = state.document, pageNumber = state.page, sessionId = state.session?.session_id, renderId = state.renderId, fitId = state.fitId = (state.fitId || 0) + 1;
    const current = () => fitId === state.fitId && renderId === state.renderId;
    try {
      const pdf = await pdfDocument(docId), page = await pdfPage(pdf, docId, pageNumber, sessionId), viewport = page.getViewport({ scale: 1 });
      if (!current() || docId !== state.document || pageNumber !== state.page || sessionId !== state.session?.session_id) return;
      state.zoom = Math.max(0.05, Math.min((state.ui.viewport.clientWidth - 50) / viewport.width, (state.ui.viewport.clientHeight - 50) / viewport.height)); await renderPage();
    } catch (error) { await recordPdfFailure(docId, pageNumber, error, sessionId, true, current); }
  }
  async function zoomBy(factor) { if (!state.document || state.points.length) return; state.zoom = Math.max(0.05, Math.min(8, state.zoom * factor)); await renderPage(); }
  function setTool(tool) { if (state.busy) return; if (!state.viewport && tool !== "select" && tool !== "pan") throw new Error("Open a successfully rendered page first."); if (state.points.length) throw new Error("Finish or cancel the current trace first."); if (tool === "trace" && !state.calibration) throw new Error("Choose or create the applicable calibration before tracing."); state.tool = tool; state.ui.viewport.dataset.tool = tool; for (const el of state.ui.root.querySelectorAll("[data-tool]")) if (el.tagName === "BUTTON") el.classList.toggle("takeoff-tool-active", el.dataset.tool === tool); state.ui.viewport.focus(); state.ui.progress.textContent = ({ calibrate: "Click the two endpoints of a known distance on this drawing.", trace: "Click each vertex along one object. Finish trace or press Enter. Backspace removes the last point.", cite: "Click opposite corners around the source dimension or schedule entry. Enter its stated length next.", pan: "Drag the drawing to pan.", select: "Select a markup or register row to inspect its source and fields." })[tool]; }
  function cancelTrace() { state.retraceId = null; state.points = []; state.tool = "select"; if (state.ui) { state.ui.viewport.dataset.tool = "select"; renderOverlay(); } window.CeasefireProject?.changed?.(); }
  function drawingPointer(event) {
    if (state.busy || !state.viewport || !["calibrate", "trace", "cite"].includes(state.tool) || event.button !== 0) return;
    event.preventDefault(); const rect = state.ui.overlay.getBoundingClientRect(); const p = G.inverse([(event.clientX - rect.left) * state.viewport.width / rect.width, (event.clientY - rect.top) * state.viewport.height / rect.height], state.viewport.transform);
    const view = pageMetadata()?.view; if (view && (p[0] < view[0] || p[1] < view[1] || p[0] > view[2] || p[1] > view[3])) return;
    state.points.push(p); renderOverlay(); window.CeasefireProject?.changed?.();
    if (state.points.length === 2 && state.tool === "calibrate") void safely(addCalibration);
    else if (state.points.length === 2 && state.tool === "cite") void safely(finishCitation);
  }
  function beginPan(event) {
    if (state.tool !== "pan" || event.button !== 0) return;
    event.preventDefault(); const element = state.ui.viewport, initial = [event.clientX, event.clientY, element.scrollLeft, element.scrollTop]; element.setPointerCapture(event.pointerId);
    const move = next => { element.scrollLeft = initial[2] + initial[0] - next.clientX; element.scrollTop = initial[3] + initial[1] - next.clientY; };
    const done = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", done); element.removeEventListener("pointercancel", done); };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", done); element.addEventListener("pointercancel", done);
  }
  async function addCalibration() {
    const points = clone(state.points), docId = state.document, page = state.page;
    if (!G.length(points)) throw new Error("Choose two distinct calibration points.");
    const result = await ask("Calibrate this drawing", [["name", "Calibration name", "text", `Page ${page} scale`, true], ["distance_m", "Known real distance (metres)", "number", "", true], ["uniform", "Uniform scale confirmed", ["Yes — the drawing has the same horizontal and vertical scale"], "", true]], "Use a stated dimension. This calibration belongs only to this page and this drawing scale. Distorted photographs and stretched scans cannot be calibrated with two points.", "Create calibration");
    if (!result) return cancelTrace(); if (!(result.distance_m > 0)) throw new Error("Enter a known positive distance in metres.");
    const id = uuid(); await command("add_calibration", { calibration: { id, document_id: docId, page, name: result.name, points, distance_m: result.distance_m, uniform_scale: true } }); state.calibration = id; cancelTrace(); renderCalibrations();
  }
  async function createDrawnItem(measurement, geometry, evidence = []) {
    const details = await ask(`Add ${labels[state.mode].toLowerCase()} object`, [["mark", state.mode === "steel" ? "Member mark" : "Run ID", "text", "", true], ["quantity", "Explicit physical quantity", "number", "", true]], "One trace represents one physical object. A repeated quantity must be explicitly supported by the source. This starts as a draft.", "Add draft item");
    if (!details) return cancelTrace(); if (!Number.isInteger(details.quantity) || details.quantity < 1) throw new Error("Enter an explicit positive whole quantity.");
    const id = uuid(); await command("create_item", { item: { id, mode: state.mode, geometry, measurement, quantity: details.quantity, fields: { mark: details.mark }, evidence } }); state.selected = new Set([id]); cancelTrace(); renderSelection();
  }
  async function finishTrace() {
    if (state.tool !== "trace" || state.points.length < 2 || !G.length(state.points)) throw new Error("Trace at least two distinct points along one object.");
    if (!state.calibration) throw new Error("Choose the correct calibration.");
    const measurement = { method: "calibrated", calibration_id: state.calibration }, geometry = { document_id: state.document, page: state.page, points: clone(state.points) };
    if (state.retraceId) { const id = state.retraceId; await command("update_item", { item_id: id, changes: { geometry, measurement } }); cancelTrace(); state.selected = new Set([id]); renderSelection(); }
    else await createDrawnItem(measurement, geometry);
  }
  async function finishCitation() {
    const points = clone(state.points), region = G.region(points[0], points[1]); if (!(region[2] > 0 && region[3] > 0)) throw new Error("Mark a source region with width and height.");
    const data = await ask("Record a cited length", [["length_m", "Source-stated length (metres)", "number", "", true], ["citation", "Exact source reference / dimension", "textarea", "", true]], "Record what the marked source says. A plan-only column or riser needs an explicit height reference; no height is inferred.", "Use cited length");
    if (!data) return cancelTrace(); if (!(data.length_m > 0)) throw new Error("Enter a positive source-stated length.");
    const measurement = { method: "cited", length_m: data.length_m, citation: data.citation }, geometry = { document_id: state.document, page: state.page, points }, evidence = { document_id: state.document, page: state.page, region, note: data.citation };
    if (state.retraceId) { const id = state.retraceId, item = items().find(value => value.id === id); await command("update_item", { item_id: id, changes: { measurement, geometry, evidence: [...item.evidence, evidence] } }); cancelTrace(); state.selected = new Set([id]); renderSelection(); }
    else await createDrawnItem(measurement, geometry, [evidence]);
  }
  function svg(tag, attributes) { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value)); return el; }
  function renderOverlay() {
    if (!state.ui || !state.viewport) return;
    const overlay = state.ui.overlay; overlay.replaceChildren(); const convert = p => G.transform(p, state.viewport.transform);
    for (const item of visibleItems().filter(item => item.geometry && item.measurement && !state.hidden.has(item.id) && item.geometry.document_id === state.document && item.geometry.page === state.page)) {
      const points = item.geometry.points.map(convert), className = `takeoff-shape ${reviewStatus(item).key}${state.selected.has(item.id) ? " selected" : ""}${state.hovered === item.id ? " hovered" : ""}`;
      let shape, hit; if (item.measurement?.method === "cited") { const box = G.region(points[0], points[points.length - 1]); const attrs = { x: box[0], y: box[1], width: box[2], height: box[3] }; shape = svg("rect", { ...attrs, class: className }); hit = svg("rect", { ...attrs, class: "takeoff-hit" }); }
      else { const coords = points.map(p => p.join(",")).join(" "); shape = svg("polyline", { points: coords, class: className }); hit = svg("polyline", { points: coords, class: "takeoff-hit" }); }
      hit.dataset.itemId = item.id; hit.setAttribute("aria-label", `${item.fields.mark || item.id} · ${reviewStatus(item).label}`); hit.setAttribute("tabindex", "0"); hit.setAttribute("role", "button");
      hit.addEventListener("click", event => { if (state.tool !== "select") return; event.stopPropagation(); void safely(() => selectItem(item.id, event.ctrlKey || event.metaKey || event.shiftKey, false)); });
      hit.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void safely(() => selectItem(item.id, event.ctrlKey || event.metaKey, false)); } });
      hit.addEventListener("pointerenter", () => hover(item.id)); hit.addEventListener("pointerleave", () => hover(null));
      const label = svg("text", { x: points[0][0] + 6, y: points[0][1] - 7, class: "takeoff-label" }); label.textContent = item.fields.mark || item.id.slice(0, 8); overlay.append(shape, hit, label);
    }
    for (const hit of state.searchHits.filter(hit => hit.document_id === state.document && hit.page === state.page)) if (hit.points?.length) { const box = G.bounds(hit.points.map(convert)); overlay.append(svg("rect", { x: box[0], y: box[1], width: Math.max(4, box[2] - box[0]), height: Math.max(4, box[3] - box[1]), class: "takeoff-search-hit" })); }
    if (state.points.length) { const points = state.points.map(convert); if (state.tool === "cite" && points.length === 2) { const box = G.region(...points); overlay.append(svg("rect", { x: box[0], y: box[1], width: box[2], height: box[3], class: "takeoff-pending" })); } else overlay.append(svg("polyline", { points: points.map(p => p.join(",")).join(" "), class: "takeoff-pending" })); for (const p of points) overlay.append(svg("circle", { cx: p[0], cy: p[1], r: 4, class: "takeoff-pending" })); }
  }
  function itemResult(item) { return state.resultMap.get(item.id) || {}; }
  function reviewStatus(item) {
    const issues = itemResult(item).issues || [];
    if (issues.some(issue => issue.code === "PAGE_REVIEW_BLOCKED")) return { key: "blocked", label: "Blocked" };
    if (issues.length) return { key: "insufficient", label: "Insufficient evidence" };
    if (item.state === "confirmed") return { key: "confirmed", label: "Confirmed" };
    if (item.state === "reviewed") return { key: "reviewed", label: "Reviewed" };
    return item.version > 1 ? { key: "review_required", label: "Needs review" } : { key: "draft", label: "Draft" };
  }
  function issueText(value) { return typeof value === "string" ? value : value?.message || value?.detail || value?.code || JSON.stringify(value); }
  function visibleItems() {
    const result = items().filter(item => item.mode === state.mode && (!state.filter || [item.id, ...Object.values(item.fields || {})].join(" ").toLowerCase().includes(state.filter)));
    const filter = state.ui?.statusFilter.value;
    return result.filter(item => !filter || reviewStatus(item).key === filter).sort((a, b) => state.sort === "length" ? (itemResult(a).length_m || 0) - (itemResult(b).length_m || 0) : String(state.sort === "state" ? a.state : a.fields[state.sort] || "").localeCompare(String(state.sort === "state" ? b.state : b.fields[state.sort] || ""), "en-AU", { numeric: true }));
  }
  async function selectItem(id, multiple = false, focus = true) {
    if (!await discardEditor()) return;
    const item = items().find(value => value.id === id); if (!item) return;
    state.mode = item.mode; state.offset = Math.floor(Math.max(0, visibleItems().findIndex(candidate => candidate.id === id)) / 100) * 100; if (!multiple) state.selected.clear(); if (multiple && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    if (focus) { if (!item.geometry) throw new Error("This draft has no source markup yet."); const changed = state.document !== item.geometry.document_id || state.page !== item.geometry.page; state.document = item.geometry.document_id; state.page = item.geometry.page; state.hidden.delete(id); if (changed) { renderRail(); renderCalibrations(); await renderPage(); } await focusGeometry(item); }
    renderSelection();
  }
  async function focusGeometry(item) {
    if (!state.viewport) return;
    const viewport = state.ui.viewport, firstBox = G.bounds(item.geometry.points.map(p => G.transform(p, state.viewport.transform)));
    const desired = Math.max(0.05, Math.min(4, state.zoom * Math.min((viewport.clientWidth - 90) / Math.max(40, firstBox[2] - firstBox[0]), (viewport.clientHeight - 90) / Math.max(40, firstBox[3] - firstBox[1]))));
    if (Math.abs(desired - state.zoom) > 0.05) { state.zoom = desired; await renderPage(); }
    if (!state.viewport) return;
    const box = G.bounds(item.geometry.points.map(p => G.transform(p, state.viewport.transform)));
    viewport.scrollTo({ left: (box[0] + box[2]) / 2 - viewport.clientWidth / 2 + 24, top: (box[1] + box[3]) / 2 - viewport.clientHeight / 2 + 24, behavior: "smooth" });
  }
  function hover(id) { state.hovered = id; for (const row of state.ui?.tableWrap.querySelectorAll("[data-item-id]") || []) row.classList.toggle("hovered", row.dataset.itemId === id); for (const hit of state.ui?.overlay.querySelectorAll("[data-item-id]") || []) hit.previousElementSibling?.classList.toggle("hovered", hit.dataset.itemId === id); }
  function renderSelection() { renderRegister(); renderInspector(); renderOverlay(); }
  function renderRegister() {
    if (!state.ui) return;
    const list = visibleItems(), selected = selectedItems(); const individualMeasuredDuct = selected.length && selected.every(item => item.mode === "duct" && item.quantity === 1 && item.measurement?.method === "calibrated"); state.ui.split.disabled = !(individualMeasuredDuct && selected.length === 1); state.ui.merge.disabled = !(individualMeasuredDuct && selected.length === 2); state.ui.split.title = state.ui.merge.title = "Split or merge measured segments of one individual duct run. Separate physical objects use Group."; state.ui.bulk.hidden = !selected.length; state.ui.selectionCount.textContent = `${selected.length} selected`;
    const table = node("table"), head = node("thead"), header = node("tr"), body = node("tbody"); table.setAttribute("aria-label", `${labels[state.mode]} editable takeoff register`);
    const columns = state.mode === "steel" ? ["mark", "level", "member_type", "section", "fire_period_min", "sides"] : ["mark", "level", "shape", "width_mm", "height_mm", "frl", "system", "orientation"];
    for (const title of ["Select", "Show", "Source / ID", "State", ...columns.map(key => fields[state.mode].find(field => field[0] === key)?.[1] || key), "Qty", "Length (m)", "Total (m)", "Evidence / issues"]) header.append(node("th", "", title)); head.append(header); table.append(head, body);
    let lastGroup = null;
    const grouped = state.group ? [...list].sort((a, b) => String(state.group === "state" ? a.state : a.fields[state.group] || "Ungrouped").localeCompare(String(state.group === "state" ? b.state : b.fields[state.group] || "Ungrouped"))) : list;
    state.offset = Math.max(0, Math.min(state.offset, Math.max(0, Math.floor((grouped.length - 1) / 100) * 100)));
    for (const item of grouped.slice(state.offset, state.offset + 100)) {
      const group = state.group ? (state.group === "state" ? item.state : item.fields[state.group] || "Ungrouped") : null;
      if (state.group && group !== lastGroup) { const row = node("tr", "takeoff-group-row"), cell = node("td"); cell.colSpan = columns.length + 8; cell.append(button(`${state.collapsed.has(group) ? "▸" : "▾"} ${group}`, () => { state.collapsed.has(group) ? state.collapsed.delete(group) : state.collapsed.add(group); renderRegister(); }, "takeoff-group-toggle")); row.append(cell); body.append(row); lastGroup = group; }
      if (group && state.collapsed.has(group)) continue;
      const row = node("tr", state.selected.has(item.id) ? "selected" : ""); row.dataset.itemId = item.id; row.addEventListener("pointerenter", () => hover(item.id)); row.addEventListener("pointerleave", () => hover(null));
      const checkCell = node("td"), check = node("input"); check.type = "checkbox"; check.checked = state.selected.has(item.id); check.setAttribute("aria-label", `Select ${item.fields.mark || item.id}`); check.addEventListener("change", () => void safely(async () => { await selectItem(item.id, true, false); check.checked = state.selected.has(item.id); })); checkCell.append(check);
      const showCell = node("td"), show = node("input"); show.type = "checkbox"; show.checked = !state.hidden.has(item.id); show.setAttribute("aria-label", `Show ${item.fields.mark || item.id} on drawing`); show.addEventListener("change", () => { show.checked ? state.hidden.delete(item.id) : state.hidden.add(item.id); renderOverlay(); }); showCell.append(show);
      const linkCell = node("td"); linkCell.append(button(item.id.slice(0, 8), () => selectItem(item.id), "takeoff-row-link")); const reviewCell = node("td"); reviewCell.append(node("span", `takeoff-state ${reviewStatus(item).key}`, reviewStatus(item).label)); row.append(checkCell, showCell, linkCell, reviewCell);
      for (const key of [...columns, "quantity"]) { const def = key === "quantity" ? [key, "Quantity", "number"] : fields[state.mode].find(field => field[0] === key); const field = formField(def, key === "quantity" ? item.quantity : item.fields[key]); field.control.addEventListener("change", () => void safely(async () => { if (state.formDirty || state.points.length) { field.control.value = key === "quantity" ? item.quantity ?? "" : item.fields[key] ?? ""; requireFinishedEdits(); } const value = field.read(); if (def[2] === "number" && value !== null && !Number.isFinite(value)) throw new Error("Enter a finite number."); await command("update_item", { item_id: item.id, changes: key === "quantity" ? { quantity: value } : { fields: { [key]: value } } }); })); const cell = node("td"); cell.append(field.control); row.append(cell); }
      const result = itemResult(item); row.append(node("td", "", Number.isFinite(result.length_m) ? units.format(result.length_m) : "—"), node("td", "", Number.isFinite(result.total_length_m) ? units.format(result.total_length_m) : "—"));
      const evidence = node("td"); evidence.append(node("span", "", `${documentById(item.geometry.document_id)?.name || "Missing document"} · p${item.geometry.page}`)); for (const issue of result.issues || []) evidence.append(node("span", "takeoff-row-issue", issueText(issue))); row.append(evidence); body.append(row);
    }
    state.ui.pagination.replaceChildren(button("Previous 100", () => { state.offset = Math.max(0, state.offset - 100); renderRegister(); }), node("span", "helper", `${list.length ? state.offset + 1 : 0}–${Math.min(state.offset + 100, list.length)} of ${list.length} matching items`), button("Next 100", () => { if (state.offset + 100 < list.length) state.offset += 100; renderRegister(); }));
    state.ui.tableWrap.replaceChildren(table); if (!list.length) state.ui.tableWrap.append(node("p", "takeoff-register-empty", "No matching items. Calibrate and trace a member/run, or cite a source-stated length."));
  }
  function renderInspector() {
    if (!state.ui || state.formDirty) return; const panel = state.ui.inspector, selected = selectedItems(); panel.replaceChildren(node("h3", "", "ITEM INSPECTOR"));
    if (selected.length !== 1) { panel.append(node("p", "helper", selected.length ? `${selected.length} items selected. Use bulk editing below to make one explicit, reversible change.` : "Select a drawing markup or register row to edit its fields and inspect its source.")); return; }
    const item = selected[0], result = itemResult(item); panel.append(node("p", "takeoff-identity", item.id), node("p", "helper", `${reviewStatus(item).label.toUpperCase()} · Version ${item.version} · ${item.measurement?.method === "cited" ? "Source-stated" : "Calibrated"} length`));
    const controls = fields[item.mode].map(def => { const control = formField(def, item.fields[def[0]]); control.control.addEventListener("input", markFormEdited); panel.append(control.wrapper); return control; });
    const quantity = formField(["quantity", "Physical quantity", "number"], item.quantity); quantity.control.addEventListener("input", markFormEdited); panel.append(quantity.wrapper);
    void enrichInspectorOptions(item, controls);
    if (item.mode === "steel") panel.append(button("Find steel section", () => findProfile(item), "text-button"));
    if (item.mode === "duct") panel.append(node("p", "helper", "Calculator transfer requires one actual run per item (quantity 1). Circular ducts stay in this register and cannot transfer to the rectangular duct calculator."));
    if (item.member_ids?.length) { const members = node("details"); members.append(node("summary", "helper", `${item.member_ids.length} persistent physical member identities`)); for (const id of item.member_ids) members.append(node("p", "takeoff-identity", id)); panel.append(members); }
    panel.append(node("p", "takeoff-calibration-summary", `Length: ${Number.isFinite(result.length_m) ? units.format(result.length_m) + " m" : "Unresolved"}${item.measurement?.method === "cited" ? ` · ${item.measurement?.citation}` : ` · ${snapshot().calibrations.find(value => value.id === item.measurement?.calibration_id)?.name || "Missing calibration"}`}`));
    const actions = node("div", "actions"); actions.append(button("Apply item edits", async () => { const formRevision = state.formRevision || 0; const changes = { fields: Object.fromEntries(controls.map(field => [field.control.name, field.read()])), quantity: quantity.read() }; await command("update_item", { item_id: item.id, changes }); if ((state.formRevision || 0) === formRevision) { state.formDirty = false; renderInspector(); } else message("The captured item edits were applied. Later form edits remain unfinished; apply or discard them separately."); }, "button primary"), button("Discard edits", () => { state.formDirty = false; renderInspector(); window.CeasefireProject?.changed?.(); }), button("Change length basis", () => changeLength(item)), button("Re-trace geometry", () => retrace(item)), button("Replace source on current page", () => replaceSource(item)), button("Add evidence reference", () => addEvidence(item)));
    panel.append(actions); for (const issue of result.issues || []) panel.append(node("p", "takeoff-warning", issueText(issue)));
    for (const evidence of item.evidence || []) panel.append(button(`${documentById(evidence.document_id)?.name || "Missing source"} · p${evidence.page}${evidence.fields?.length ? " · " + evidence.fields.join(", ") : ""}: ${evidence.note}`, () => navigateDocument(evidence.document_id, evidence.page), "text-button"));
  }
  async function enrichInspectorOptions(item, controls, product) {
    const calculator = state.ui.target.value, request = (state.optionRequest || 0) + 1; state.optionRequest = request;
    const maps = { steel_vermiculite: { product: "B", exposure: "C", critical_temperature: "D", section: "F", fire_period_min: "H" }, steel_board: { product: "C", section: "D", sides: "G", fire_period_min: "H", member_type: "I", critical_temperature: "J" }, ductwork: { product: "C", frl: "E", exposure: "H", orientation: "I" } };
    try {
      const choices = await api(`/options?calculator=${encodeURIComponent(calculator)}&product=${encodeURIComponent(product ?? item.fields.product ?? "")}`);
      if (request !== state.optionRequest || state.ui.target.value !== calculator || selectedItems()[0]?.id !== item.id) return;
      for (const field of controls) {
        const values = choices.columns.find(column => column.column === maps[calculator]?.[field.control.name])?.options || [];
        if (!values.length || !field.control.isConnected) continue;
        if (field.control.tagName === "SELECT") { const current = field.control.value; field.control.replaceChildren(option("", "Choose…"), ...values.map(value => option(value))); if (current && !values.map(String).includes(current)) field.control.append(option(current, `${current} (retained)`)); field.control.value = current; }
        else { let list = field.wrapper.querySelector("datalist"); if (!list) { list = node("datalist"); list.id = `takeoff-choices-${uuid()}`; field.wrapper.append(list); field.control.setAttribute("list", list.id); } list.replaceChildren(...values.map(value => option(value))); }
      }
      const productField = controls.find(field => field.control.name === "product");
      if (productField && !productField.control.dataset.optionsListener) { productField.control.dataset.optionsListener = "true"; productField.control.addEventListener("change", () => void enrichInspectorOptions(item, controls, productField.control.value)); }
    } catch (error) { message(`Calculator choices could not be loaded. ${error.message}`, true); }
  }
  async function findProfile(item) { const data = await ask("Find steel section", [["search", "Section designation", "text", item.fields.section || "", true]], "Select an exact section from the existing calculator database.", "Search"); if (!data) return; const result = await api(`/profiles?calculator=${encodeURIComponent(state.ui.target.value)}&search=${encodeURIComponent(data.search)}`); if (!result.items?.length) throw new Error("No exact database candidates. Refine the section search."); const choice = await ask("Choose a database section", [["section", "Steel section", result.items.map(row => row.id), "", true]], `${result.total} matches. ${result.items.length} shown.`, "Use section"); if (choice) { const control = state.ui.inspector.querySelector('[name="section"]'); if (!control) throw new Error("Select the item again before changing its section."); control.value = choice.section; markFormEdited(); message("Database section selected. Apply item edits to keep this and your other changes."); } }
  async function changeLength(item) { requireFinishedEdits(); const calibrations = snapshot().calibrations.filter(value => value.document_id === item.geometry.document_id && value.page === item.geometry.page); const data = await ask("Change length basis", [["method", "Length basis", ["calibrated", "cited"], item.measurement?.method, true], ["calibration_id", "Page calibration (for measured geometry)", calibrations.map(value => [value.id, value.name]), item.measurement?.calibration_id || ""], ["length_m", "Cited length (metres)", "number", item.measurement?.length_m || ""], ["citation", "Source citation", "textarea", item.measurement?.citation || ""]], "This invalidates review and confirmation. A cited region cannot become a measured run: re-trace its geometry first."); if (!data) return; if (data.method === "calibrated" && item.measurement?.method === "cited") throw new Error("Re-trace this object's actual geometry before using a calibration."); const measurement = data.method === "calibrated" ? { method: "calibrated", calibration_id: data.calibration_id } : { method: "cited", length_m: data.length_m, citation: data.citation }; await command("update_item", { item_id: item.id, changes: { measurement } }); }
  async function retrace(item) { if (!await discardEditor()) return; await selectItem(item.id); if (!state.calibration) { state.calibration = item.measurement?.calibration_id || ""; renderCalibrations(); } if (!state.calibration) throw new Error("Choose a calibration before re-tracing this item."); state.retraceId = item.id; setTool("trace"); message("Trace the replacement geometry, then Finish trace. The same item ID is retained and its confirmation is invalidated."); }
  async function replaceSource(item) {
    requireFinishedEdits(); if (!state.viewport) throw new Error("Open the revised source document page first.");
    const choice = await ask("Replace this object's primary source", [["method", "Replacement length basis", ["calibrated", "cited"], "", true]], `The current page is ${currentDocument().name}, page ${state.page}. The same physical item ID is retained; its old references remain in evidence and history. The new geometry and measurement will invalidate review, confirmation and linked transfers. Upload revised drawings as new documents first.`, "Mark replacement source");
    if (!choice) return; if (choice.method === "calibrated" && !state.calibration) throw new Error("Select a calibration on the replacement page first.");
    state.retraceId = item.id; setTool(choice.method === "calibrated" ? "trace" : "cite");
  }
  async function addEvidence(item) { requireFinishedEdits(); const data = await ask("Link supporting source evidence", [["document_id", "Source document", documents().map(value => [value.id, value.name]), state.document, true], ["page", "Page", "number", state.page, true], ["field", "Source field (blank applies to the whole object)", [["quantity", "Physical quantity"], ["length_m", "Length basis"], ...fields[item.mode].map(value => [value[0], value[1]])], ""], ["note", "Evidence note / exact reference", "textarea", "", true]], "Supporting evidence does not create another physical object or add quantities. Use the cited page to corroborate this object's fields."); if (data) await command("update_item", { item_id: item.id, changes: { evidence: [...item.evidence, { document_id: data.document_id, page: data.page, note: data.note, ...(data.field ? { fields: [data.field] } : {}) }] } }); }
  async function bulkEdit() { requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) return; const key = state.ui.bulkField.value, definition = key === "quantity" ? [key, "Quantity", "number"] : fields[state.mode].find(value => value[0] === key), raw = state.ui.bulkValue.value.trim(), value = definition[2] === "number" ? raw === "" ? null : Number(raw) : raw; if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Enter a finite number."); if (!await confirm(`Change ${selected.length} items?`, `${definition[1]} will become ${raw || "blank"} for all selected items, including filtered-out selections. Review and confirmation are invalidated. Undo can restore this edit.`, "Apply bulk change")) return; await command("bulk_update", { item_ids: selected.map(item => item.id), changes: key === "quantity" ? { quantity: value } : { fields: { [key]: value } } }); }
  async function selectedCommand(op) { requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select at least one item."); await command(op, { item_ids: selected.map(item => item.id) }); }
  async function reviewSelected(confirming) { const selected = selectedItems(); if (!selected.length) throw new Error("Select items to review."); if (state.formDirty || state.points.length) throw new Error("Apply or discard the unfinished edits first."); if (!await confirm(`${confirming ? "Confirm" : "Review"} ${selected.length} items?`, confirming ? "Confirm only after inspecting the original drawings, physical quantities, length basis, dimensions, fire requirements and source references. Deterministic checks must pass. Confirmation does not certify technical suitability." : "Mark these objects as human-reviewed after checking their drawing geometry, source dimensions and recorded fields. This does not yet permit schedule transfer.", confirming ? "Confirm reviewed items" : "Mark reviewed")) return; await selectedCommand(confirming ? "confirm_items" : "review_items"); }
  async function deleteSelected() { requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) return; if (await confirm(`Delete ${selected.length} objects?`, "Their source documents are retained. Linked schedule rows require explicit handling. Undo restores the previous draft.", "Delete objects")) await selectedCommand("delete_items"); }
  async function splitSelected() { requireFinishedEdits(); const selected = selectedItems(); if (selected.length !== 1) throw new Error("Select one calibrated run to split."); const item = selected[0]; if (item.mode !== "duct" || item.quantity !== 1) throw new Error("Only individual duct runs can be split. Model distinct steel members separately."); if (item.measurement?.method !== "calibrated") throw new Error("Split requires traced geometry. Cited source lengths need individually evidenced replacements."); const data = await ask("Split this physical run", [["percentage", "Split position (% of traced length)", "number", 50, true]], "Use a real branch or change of dimensions, orientation or system. Two new IDs replace this item and require review.", "Split run"); if (!data) return; const parts = G.split(item.geometry.points, data.percentage / 100).map(points => ({ mode: item.mode, geometry: { ...item.geometry, points }, measurement: clone(item.measurement), quantity: item.quantity, fields: clone(item.fields), evidence: clone(item.evidence) })); await command("split_item", { item_id: item.id, parts }); }
  async function mergeSelected() { requireFinishedEdits(); const selected = selectedItems(); if (selected.length !== 2) throw new Error("Select exactly two adjoining traced segments of one physical object."); const [a, b] = selected; if (a.mode !== "duct" || a.quantity !== 1 || b.quantity !== 1) throw new Error("Merge applies only to segments of one individual duct run. Use Group for separate objects."); if (a.measurement.method !== "calibrated" || b.measurement.method !== "calibrated" || a.measurement.calibration_id !== b.measurement.calibration_id || a.geometry.document_id !== b.geometry.document_id || a.geometry.page !== b.geometry.page) throw new Error("Merge requires two calibrated segments on the same page and calibration."); const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.001; let left = clone(a.geometry.points), right = clone(b.geometry.points); if (same(left[0], right[0])) left.reverse(); else if (same(left[0], right[right.length - 1])) { left.reverse(); right.reverse(); } else if (same(left[left.length - 1], right[right.length - 1])) right.reverse(); if (!same(left[left.length - 1], right[0])) throw new Error("Segments must share an endpoint; merging must not invent connecting geometry."); if (!await confirm("Merge one physical object?", "Only use this when both segments are genuinely the same object with matching size, system and physical quantity. Grouping is the correct choice for separate objects. The replacement gets a new ID and requires review.", "Merge segments")) return; await command("merge_items", { item_ids: selected.map(item => item.id), item: { mode: a.mode, geometry: { ...a.geometry, points: [...left, ...right.slice(1)] }, measurement: clone(a.measurement), quantity: a.quantity, fields: clone(a.fields), evidence: [...a.evidence, ...b.evidence] } }); }
  async function removeDocument() { requireFinishedEdits(); const doc = currentDocument(); if (!doc) return; if (await confirm(`Remove ${doc.name}?`, "A source document cannot be removed while takeoff objects depend on it. Original evidence remains recoverable through project history.", "Remove document")) { await command("delete_document", { document_id: doc.id }); await renderPage(); } }
  async function upload(files) {
    if (!files.length || state.busy) return; await ensureSession(); if (files.length + documents().length > 100) throw new Error("A project supports up to 100 PDFs.");
    const sessionId = state.session.session_id; working(true); let done = 0;
    try {
      for (const file of files) {
        if (!/\.pdf$/i.test(file.name) || !file.size || file.size > 250 * 1024 * 1024) throw new Error(`${file.name}: choose a PDF of at most 250 MiB.`);
        if (sessionId !== state.session?.session_id) throw new Error("The project changed during upload.");
        const initialized = await api(`/sessions/${sessionId}/uploads`, { filename: file.name, size: file.size }); const uploadId = initialized.upload_id;
        if (!uploadId) throw new Error("The server did not create an upload session.");
        for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
          state.ui.progress.textContent = `Uploading ${file.name}: ${Math.round(offset / file.size * 100)}% (${done + 1}/${files.length})`;
          const response = await fetch(`/api/takeoffs/sessions/${sessionId}/uploads/${uploadId}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + 8 * 1024 * 1024) });
          if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Upload chunk failed."); }
        }
        state.ui.progress.textContent = `Checking original PDF and page metadata: ${file.name}…`;
        const reply = await api(`/sessions/${sessionId}/uploads/${uploadId}/complete`, { expected_revision: state.session.revision }); accept(reply); done++; renderData();
      }
      message(`${done} original PDF${done === 1 ? "" : "s"} retained. Save the project to preserve its document bundle.`);
    } catch (error) { throw new Error(`${done ? `${done} PDF(s) imported before this failure. ` : ""}${error.message}`); }
    finally { working(false); renderData(); if (state.document) await fitPage(); }
  }
  async function runSearch() {
    const query = state.ui.search.value.trim().toLocaleLowerCase(); if (!query) return;
    const docs = state.ui.searchScope.value === "all" ? documents() : [currentDocument()].filter(Boolean); const total = docs.reduce((sum, doc) => sum + doc.pages.length, 0), run = ++state.searchId, sessionId = state.session.session_id; let checked = 0, empty = 0, failed = 0; state.searchHits = []; state.ui.searchResults.replaceChildren(); state.ui.searchResults.hidden = false;
    for (const doc of docs) {
      let pdf; try { pdf = await pdfDocument(doc.id); } catch (error) { failed += doc.pages.length; if (error.name === "PdfTimeoutError") await recordPdfFailure(doc.id, doc.id === state.document ? state.page : 1, error, sessionId, false, () => run === state.searchId); continue; }
      if (run !== state.searchId || sessionId !== state.session?.session_id) return;
      for (const metadata of doc.pages) {
        if (run !== state.searchId || sessionId !== state.session?.session_id) return;
        let page, timedOut = false;
        try { page = await pdfPage(pdf, doc.id, metadata.page, sessionId); const content = await boundedPdf(page.getTextContent(), `Searching PDF page ${metadata.page}`, () => discardPdf(doc.id, sessionId, pdf)); if (run !== state.searchId || sessionId !== state.session?.session_id) return; checked++; if (!content.items.some(item => item.str?.trim())) empty++; for (const text of content.items) if (text.str?.toLocaleLowerCase().includes(query)) { const x = text.transform[4], y = text.transform[5], height = Math.max(1, text.height || Math.hypot(text.transform[2], text.transform[3])); const hit = { document_id: doc.id, page: metadata.page, points: [[x, y], [x + text.width, y + height]], text: text.str }; state.searchHits.push(hit); const el = button(`${doc.name} · p${metadata.page}: ${text.str}`, async () => { await navigateDocument(doc.id, metadata.page); renderOverlay(); focusGeometry({ geometry: { points: hit.points } }); }, "takeoff-search-result"); state.ui.searchResults.append(el); if (state.searchHits.length >= 500) break; } } catch (error) { if (run !== state.searchId || sessionId !== state.session?.session_id) return; failed++; if (error.name === "PdfTimeoutError") { timedOut = true; failed += doc.pages.length - metadata.page; await recordPdfFailure(doc.id, metadata.page, error, sessionId, false, () => run === state.searchId); } }
        finally { if (page && !(doc.id === state.document && metadata.page === state.page) && ![...state.thumbnailPages.values()].some(active => active.document_id === doc.id && active.page === metadata.page)) page.cleanup(); }
        state.ui.progress.textContent = `Text search: ${checked}/${total} pages inspected · ${state.searchHits.length} matches · ${empty} without searchable text · ${failed} failed`;
        if (timedOut) break;
        if (state.searchHits.length >= 500) { state.ui.progress.textContent += " · Stopped at 500 matches; coverage is incomplete."; renderOverlay(); return; }
      }
    }
    state.ui.progress.textContent = `Text search complete: ${checked}/${total} pages inspected · ${state.searchHits.length} matches · ${empty} without searchable text · ${failed} failed. Scanned pages require visual inspection.`; renderOverlay();
  }
  async function transfer(updateLinked) {
    const selected = selectedItems(); if (!selected.length) throw new Error("Select confirmed items to transfer."); if (state.formDirty || state.points.length) throw new Error("Apply or discard unfinished edits before transfer.");
    const calculatorId = state.ui.target.value, target = await window.CeasefireCalculators.captureTakeoffTarget(calculatorId), sessionId = state.session.session_id;
    const preview = await api(`/sessions/${sessionId}/transfer-preview`, { expected_revision: state.session.revision, calculator_id: calculatorId, inputs: target.inputs, schedule_rows: target.schedule_rows, item_ids: selected.map(item => item.id), update_linked: updateLinked });
    const accepted = await confirm(`${updateLinked ? "Update" : "Transfer"} ${selected.length} confirmed items?`, JSON.stringify({ changes: preview.changes, normalizations: preview.normalizations, warnings: preview.warnings }, null, 2), updateLinked ? "Update linked rows" : "Add to schedule"); if (!accepted) return;
    if (sessionId !== state.session?.session_id || preview.revision !== state.session.revision) throw new Error("Takeoffs changed during transfer review. Preview again.");
    const reservation = window.CeasefireCalculators.reserveTakeoffTarget(calculatorId, target.fingerprint); working(true);
    try { const result = await api(`/sessions/${sessionId}/transfer-apply`, { expected_revision: state.session.revision, request_id: uuid(), preview_id: preview.preview_id, inputs: target.inputs, schedule_rows: target.schedule_rows }); window.CeasefireCalculators.applyTakeoffTarget(calculatorId, result.transfer, reservation); accept(result); renderData(); message("Confirmed quantities applied to the calculator draft. Save the project to retain both the schedule and its source links."); }
    finally { window.CeasefireCalculators.releaseTakeoffTarget(reservation); working(false); }
  }
  async function detachSelected() { requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select linked items to detach."); if (await confirm(`Detach links for ${selected.length} items?`, "The existing calculator values remain as manual schedule entries. Future takeoff edits will no longer update those rows.", "Detach links")) await command("detach_transfers", { item_ids: selected.map(item => item.id), calculator_id: state.ui.target.value }); }
  async function exportRegister(format) { requireFinishedEdits();
    const ids = selectedItems().map(item => item.id); if (!ids.length) throw new Error("Select confirmed register items to export. All selected items must be eligible.");
    const response = await fetch(`/api/takeoffs/sessions/${state.session.session_id}/export/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selected_ids: ids }) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Register export failed."); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = `CEASEFIRE-${labels[state.mode]}-Takeoff.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); message(`Exported ${ids.length} selected confirmed items with their source identities.`);
  }
  async function showAudit() {
    const sessionId = state.session.session_id; let offset = 0;
    while (sessionId === state.session?.session_id) {
      const result = await api(`/sessions/${sessionId}/history`, { offset, limit: 100 });
      const choices = ["Close", ...(offset ? ["Previous 100 events"] : []), ...(result.has_more ? ["Next 100 events"] : [])];
      const action = await ask(`Takeoff audit history · Events ${offset + 1}–${offset + result.items.length}`, [["navigation", "History navigation", choices, "Close", true]], JSON.stringify(result.items, null, 2), "Continue");
      if (!action || action.navigation === "Close") return;
      offset = Math.max(0, offset + (action.navigation === "Next 100 events" ? 100 : -100));
    }
  }
  async function editCalibration() {
    requireFinishedEdits(); const calibration = snapshot().calibrations.find(value => value.id === state.calibration);
    if (!calibration) throw new Error("Select a page calibration to edit.");
    const affected = items().filter(item => item.measurement?.calibration_id === calibration.id).length;
    const data = await ask("Revise page calibration", [["name", "Calibration name", "text", calibration.name, true], ["distance_m", "Known real distance (metres)", "number", calibration.distance_m, true]], `This creates a new calibration revision and invalidates review, confirmation and transfer links for ${affected} dependent items. The original calibration is retained. To change the endpoints, create a new calibration and explicitly change each item's length basis.`, "Revise calibration");
    if (!data) return; if (!(data.distance_m > 0)) throw new Error("Enter a positive known distance.");
    const result = await command("update_calibration", { calibration_id: calibration.id, changes: { ...data, uniform_scale: true } });
    state.calibration = result.revised_calibration_id || ""; renderCalibrations();
  }
  function projectSnapshot() { if (state.busy || state.modal) throw new Error("Finish the current takeoff operation before saving."); if (state.formDirty || state.points.length) throw new Error("Apply or discard the unfinished takeoff edits before saving."); if (!state.session || !snapshot().documents.length && !snapshot().items.length && !snapshot().calibrations.length && !snapshot().transfers.length) return undefined; return clone(snapshot()); }
  function projectFingerprint() { return JSON.stringify({ session_id: state.session?.session_id, snapshot: snapshot(), busy: state.busy, formDirty: state.formDirty, points: state.points, modal: state.modal }); }
  function hasUnsavedChanges() { return state.busy || state.formDirty || state.points.length > 0 || !!state.session && snapshotKey(snapshot()) !== state.saved; }
  async function prepareDefaults() { if (state.busy) throw new Error("Wait for the takeoff operation to finish."); return { session: null, saved: null }; }
  async function prepareProject(value, sessionId) { if (state.busy) throw new Error("Wait for the takeoff operation to finish."); if (!value) return prepareDefaults(); if (!sessionId) throw new Error("This project has takeoffs but no authorised evidence session. Reopen the project from its companion folder."); const session = await api(`/sessions/${sessionId}`); return { session, saved: snapshotKey(session.snapshot) }; }
  function applyProject(prepared) {
    const prior = state.session?.session_id;
    state.generation = (state.generation || 0) + 1; state.opening = null; ++state.renderId; ++state.searchId; state.pending?.cancel?.(); void releaseDocuments();
    state.session = null; state.railKey = null; state.pageError = null; state.saved = prepared.saved; state.document = null; state.page = 1; state.selected.clear(); state.hidden.clear(); state.points = []; state.formDirty = false; state.tool = "select"; state.viewport = null; state.searchHits = []; state.resultMap.clear();
    if (prepared.session) accept(prepared.session);
    if (prior && prior !== state.session?.session_id) void discardPreparedSession(prior);
    if (state.ui) { renderData(); state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false; state.ui.searchResults.replaceChildren(); }
  }
  async function discardPreparedSession(sessionId) { if (sessionId && sessionId !== state.session?.session_id) await api(`/sessions/${sessionId}/close`, {}).catch(() => {}); }
  function markProjectSaved(value, captured) { if (!value) return; if (snapshotKey(snapshot()) === snapshotKey(captured || value)) { state.saved = snapshotKey(value); if (state.session) state.session.snapshot = clone(value); } else state.saved = snapshotKey(captured || value); window.CeasefireProject?.changed?.(); }

  async function completeProjectSnapshot() { await state.queue; return projectSnapshot(); }
  function scheduleBindings(calculatorId, row) { return (snapshot()?.transfers || []).filter(binding => binding.calculator_id === calculatorId && binding.row === row && binding.status !== "detached"); }
  async function showSource(itemId) { build(); await window.CeasefireTakeoffNavigation?.show?.(); await selectItem(itemId); }
  window.CeasefireTakeoffs = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject, prepareDefaults, markProjectSaved, hasUnsavedChanges, completeProjectSnapshot,
    sessionId: () => state.session?.session_id, scheduleBindings, showSource, discardPreparedSession };
})();
