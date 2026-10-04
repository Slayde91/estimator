"use strict";

(() => {
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const G = window.CeasefireTakeoffGeometry;
  const state = { session: null, saved: null, opening: null, active: false, mode: "steel", document: null, page: 1,
    zoom: 1, tool: "select", points: [], countEntries: [], countGeneration: 0, countDefaultLength: null, countQueue: Promise.resolve(), countFinishing: false, countContinuation: null, countSelection: new Map(), traceCursor: null, markupMenu: null, selected: new Set(), hovered: null, hidden: new Set(), collapsed: new Set(),
    search: "", filter: "", sort: "mark", group: "", offset: 0, calibration: "", busy: false, queue: Promise.resolve(),
    registerColumnFilters: new Map(), registerFilterSession: null,
    renderId: 0, searchId: 0, viewport: null, pdfs: new Map(), pdfLoads: new Map(), thumbnailTasks: new Map(), thumbnailPages: new Map(), pdfWarnings: new Map(), pdfLibrary: null, resultMap: new Map(),
    formDirty: false, settingsDirty: false, settingsOpen: false, settingsEditor: null, gesture: null, controlPoint: null, controlMenu: false, planActive: false, planController: null, modal: false, issues: [], searchHits: [], pending: null, bindings: [], ui: null,
    physicalUI: null, physicalScope: "defect_reports", physicalDetailsOpen: false, physicalPlacing: false, physicalSelected: new Set(), physicalVisible: new Set(), physicalHovered: null, physicalPreviews: new Map() };
  const units = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 3 });
  const lengthUnits = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Presentation only: snapshots, evidence digests and calculator inputs retain full precision.
  const formatLength = value => Number.isFinite(value) ? lengthUnits.format(value) : "—";
  const labels = { steel: "Steel", duct: "Duct", wall: "Walls", slab: "Slabs", physical: "Penetrations" };
  const physicalUnfinished = () => !!state.physicalUI?.hasUnfinishedChanges();
  const isArea = (mode = state.mode) => mode === "wall" || mode === "slab";
  const areaFields = [["level", "Level"], ["substrate", "Substrate"], ["treatment", "Treatment"], ["system", "Protection system"], ["product", "Protection product"], ["frl", "FRL / fire rating"], ["surface_citation", "True-surface source citation", "textarea"]];
  const surfaceHelp = "Trace one actual treatment surface in true projection. A wall plan footprint is not its wall-face surface. No height, second face or multiplier is inferred. Use elevations for wall faces and a stated soffit/top view for slabs. Distorted or perspective views cannot establish calibrated surface areas.";
  const fields = {
    steel: [["mark", "Member mark"], ["level", "Level"], ["member_type", "Member type", ["Beam", "Column"]], ["section", "Steel section"], ["product", "Product", []], ["fire_period_min", "Fire period (min)", []], ["sides", "Exposed sides", "number"], ["critical_temperature", "Crit. Temp (°C)", []], ["exposure", "Exposure", []], ["zone", "Zone"], ["group", "Group"], ["notes", "Notes"]],
    duct: [["mark", "Item"], ["level", "Level"], ["duct_size", "WxH (mm)"], ["product", "Product", []], ["exposure", "Exposure", []], ["frl", "FRL", []], ["orientation", "Orientation", ["Horizontal", "Vertical", "Both"]], ["wall_penetrations", "Wall penetrations", "number"], ["floor_penetrations", "Floor penetrations", "number"], ["zone", "Zone"], ["group", "Group"], ["notes", "Notes"]],
    wall: [["mark", "Wall ID"], ["surface_basis", "Surface basis", [["wall-face", "Wall face (true elevation)"]]], ...areaFields],
    slab: [["mark", "Slab / zone ID"], ["surface_basis", "Surface basis", [["slab-soffit", "Slab soffit"], ["slab-top", "Slab top"]]], ...areaFields],
  };
  const numericOptionFields = new Set(["fire_period_min", "critical_temperature"]);
  const ductSizePattern = "\\s*(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*[xX×]\\s*(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*";
  function formatDuctSize(values) { return values.width_mm == null && values.height_mm == null ? "" : `${values.width_mm ?? ""} x ${values.height_mm ?? ""}`; }
  function parseDuctSize(value) {
    const text = String(value ?? "").trim();
    if (!text) return { width_mm: null, height_mm: null };
    if (!new RegExp(`^${ductSizePattern}$`).test(text)) throw new Error("WxH (mm): enter two positive dimensions, for example 100x100.");
    const [width_mm, height_mm] = text.split(/[xX×]/).map(part => Number(part.trim()));
    if (![width_mm, height_mm].every(number => Number.isFinite(number) && number > 0 && number <= 1e12)) throw new Error("WxH (mm): enter positive finite dimensions no greater than 1,000,000,000,000 mm.");
    return { width_mm, height_mm };
  }
  const snapshot = () => state.session?.snapshot;
  const physicalGraph = (value = snapshot()) => state.physicalScope === "service_plans" ? value?.service_plans : value?.physical;
  const physicalSnapshot = (value = snapshot()) => value ? { ...value, physical: physicalGraph(value) || null } : value;
  const documents = () => snapshot()?.documents || [];
  const items = () => snapshot()?.items || [];
  const documentById = id => documents().find(doc => doc.id === id);
  const currentDocument = () => documentById(state.document);
  const pageMetadata = () => currentDocument()?.pages?.find(page => page.page === state.page);
  const selectedItems = () => items().filter(item => state.selected.has(item.id) && item.mode === state.mode);
  const editableFields = (mode, calculator = state.ui?.target?.value) => (fields[mode] || []).filter(([key]) => !["zone", "group", "notes"].includes(key) && (key !== "sides" || calculator === "steel_board"));
  const isStandalone = item => ["count-only", "length-only"].includes(item?.purpose);
  const isSurface = item => isArea(item?.mode) && !isStandalone(item);
  const isCount = item => ["count", "count-only"].includes(item?.geometry?.kind);
  const standaloneFields = [["mark", "Item"], ["level", "Level"], ["duct_size", "WxH (mm)"], ["frl", "FRL", []], ["orientation", "Orientation", ["Horizontal", "Vertical", "Both"]]];
  const itemFields = item => isStandalone(item) ? standaloneFields : editableFields(item.mode, "steel_board");
  // Register selection covers the complete row; drawing selection may cover
  // only named physical members of that row. Length groups are not move groups.
  const selectedCountMemberIds = item => !isCount(item) || !state.selected.has(item.id) ? [] : item.member_ids.filter(id => !state.countSelection.has(item.id) || state.countSelection.get(item.id).has(id));
  const countBatchItems = item => isStandalone(item) ? [item] : items().filter(value => isCount(value) && !isStandalone(value) && value.count_id === item.count_id);
  const settingsSelectedItems = () => { const selected = [...state.selected].map(id => items().find(item => item.id === id && item.mode === state.mode)).filter(Boolean); const batches = new Set(selected.filter(item => isCount(item) && !isStandalone(item)).map(item => item.count_id)); return selected.concat(items().filter(item => !selected.includes(item) && isCount(item) && batches.has(item.count_id))); };
  function bulkSelectionFields(selected = settingsSelectedItems()) {
    const definitions = item => isStandalone(item) ? standaloneFields : editableFields(item.mode);
    const choices = selected.length ? definitions(selected[0]).filter(([key]) => selected.every(item => definitions(item).some(([name]) => name === key))) : editableFields(state.mode);
    return [...(!isArea() && !selected.some(isStandalone) ? [["quantity", "Quantity", "number"]] : []), ...choices];
  }
  function syncBulkFields() {
    const control = state.ui?.bulkField; if (!control?.replaceChildren) return;
    const previous = control.value, choices = bulkSelectionFields();
    control.replaceChildren(...choices.map(([key, label]) => option(key, label)));
    control.value = choices.some(([key]) => key === previous) ? previous : choices[0]?.[0] || "";
  }
  const appearanceOf = item => ({ stroke_color: "#FF0000", fill_enabled: item.geometry?.kind === "polygon" || isCount(item), fill_color: "#FF0000", stroke_width: 2, opacity: 1, marker_shape: "circle", marker_size: 12, ...item.appearance });
  const uuid = () => crypto.randomUUID();
  const snapshotKey = value => { if (!value) return null; const copy = clone(value); delete copy.companion_folder; return JSON.stringify(copy); };
  function node(tag, className = "", text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
  function option(value, label = value) { const el = node("option", "", label); el.value = value; return el; }
  const buttonIcons = {
    "First page": "M4 5v14M17 5l-7 7 7 7", "‹ Page": "M15 5l-7 7 7 7", "Page ›": "M9 5l7 7-7 7", "Last page": "M20 5v14M7 5l7 7-7 7",
    "Discard item edits": "M20 7a8 8 0 0 0-13-2L3 9m0-6v6h6M4 17a8 8 0 0 0 13 2l4-4m0 6v-6h-6",
    "Select": "M5 3l14 10-7 1-3 7z",
    "Select PDF text": "M6 3c4 0 6 2 6 5v8c0 3-2 5-6 5M18 3c-4 0-6 2-6 5M12 16c0 3 2 5 6 5",
    "Pan": "M8 12V5a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v7c0 4-3 6-7 6-3 0-4-2-6-4l-3-4a1.5 1.5 0 0 1 2-2l2 1z",
    "Settings": "M10 2h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1zM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0",
    "Close settings": "M6 9l6 6 6-6",
    "Apply item edits": "M5 3h12l3 3v15H4V3zM8 3v6h8V3M8 21v-7h8v7M10 17h4",
    "Trace length": "M1 6v12M23 6v12M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
    "Re-trace geometry": "M1 6v12M23 6v12M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
    "Delete item": "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    "Count": "M5 3v18M10 3v18M15 3v18M20 3v18M2 7l21 10",
    "Count steel lengths": "M5 3v18M10 3v18M15 3v18M20 3v18M2 7l21 10",
    "Length": "M1 6v12M23 6v12M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
    "Trace surface": "M7 3h14v14H7zM3 3v14M1 5l2-2 2 2M1 15l2 2 2-2M7 21h14M9 19l-2 2 2 2M19 19l2 2-2 2",
    "Add exclusion": "M7 3h14v14H7zM3 3v14M1 5l2-2 2 2M1 15l2 2 2-2M7 21h14M9 19l-2 2 2 2M19 19l2 2-2 2",
    "Scale": "M2 7h20v10H2zM6 7v5M10 7v3M14 7v5M18 7v3",
    "Viewport": "M7 3H3v4M17 3h4v4M3 17v4h4M21 17v4h-4M7 7h10v10H7z",
    "Add viewport": "M12 4v16M4 12h16",
    "Delete viewport": "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
    "Remove document": "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
    "Close viewports": "M6 9l6 6 6-6",
    "Update linked rows": "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 12M4 12l2.3 6A7 7 0 0 0 17.9 17",
    "Detach links": "M15 7h2a5 5 0 0 1 0 10h-2M9 17H7A5 5 0 0 1 7 7h2",
    "Select filtered items": "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M7 12l3 3 7-7",
    "Clear selection": "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
    "Export CSV": "M14 2H4v20h16V8l-6-6zm0 0v6h6M8 11v4m-2-2 2 2 2-2",
    "Export XLSX": "M14 2H4v20h16V8l-6-6zm0 0v6h6M8 11v4m-2-2 2 2 2-2",
    "Fit page": "M9 9L3 3m0 5V3h5M15 9l6-6m-5 0h5v5M9 15l-6 6m0-5v5h5M15 15l6 6m-5 0h5v-5",
    "Upload PDFs": "M14 3H5v18h14V8l-5-5zm0 0v5h5M12 18v-7m-3 3 3-3 3 3",
    "Search": "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    "Stop search": "M15.5 15.5L21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 7l6 6M13 7l-6 6",
  };
  function button(label, fn, cls = "button secondary", iconName = label) {
    const icon = buttonIcons[iconName], schedule = label === "Preview transfer", download = /^(?:Export (?:CSV|XLSX)|Download (?:XLSX|PDF))$/.test(label), el = node("button", cls);
    el.type = "button";
    if (download) {
      const format = label.split(" ").at(-1), symbol = node("span", "download-format-icon"); symbol.setAttribute("aria-hidden", "true"); symbol.append(node("span", "download-arrow", "⇩"), node("span", "download-format", format));
      el.className = `button icon-only schedule-download-button takeoff-download-button ${format === "PDF" ? "calculator-export-pdf" : "calculator-export-excel"}`; el.title = label; el.setAttribute("aria-label", label); el.append(symbol, node("span", "sr-only", label));
    } else if (icon || schedule) {
      el.classList.add("icon-only", "takeoff-icon-button"); el.title = label; el.setAttribute("aria-label", label);
      if (label === "Apply item edits") el.classList.add("save-button");
      const symbol = node("span", "button-symbol takeoff-button-symbol"); symbol.setAttribute("aria-hidden", "true");
      if (schedule) {
        // Match the existing Add to Schedule control's exact plus glyph.
        symbol.textContent = "+"; el.classList.add("takeoff-add-schedule");
      } else {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" })) svg.setAttribute(key, value);
        path.setAttribute("d", icon); svg.append(path);
        if (label === "Trace surface" || label === "Add exclusion") {
          const area = document.createElementNS("http://www.w3.org/2000/svg", "text");
          for (const [key, value] of Object.entries({ x: "14", y: "11", "text-anchor": "middle", "font-family": "Arial, sans-serif", "font-size": "7", "font-weight": "600", fill: "currentColor", stroke: "none" })) area.setAttribute(key, value);
          area.textContent = "m²"; svg.append(area);
          if (label === "Add exclusion") for (const [stroke, width] of [["white", "4"], ["currentColor", "1.8"]]) {
            const cross = document.createElementNS("http://www.w3.org/2000/svg", "path");
            cross.setAttribute("d", "M15 12l8 8M23 12l-8 8"); cross.setAttribute("stroke", stroke); cross.setAttribute("stroke-width", width); svg.append(cross);
          }
        }
        symbol.append(svg);
      }
      el.append(symbol, node("span", "sr-only", label));
    } else el.textContent = label;
    el.addEventListener("click", () => void safely(fn)); return el;
  }
  function select(options, change, value) { const el = node("select"); options.forEach(([v, text]) => el.append(option(v, text))); if (value !== undefined) el.value = value; if (change) el.addEventListener("change", () => void safely(() => change(el.value))); return el; }
  function message(text = "", error = false) {
    if (!state.ui) return;
    const notice = state.ui.message; notice.textContent = text; notice.hidden = !text; notice.className = `message${error ? " error" : ""}`; notice.setAttribute("role", error ? "alert" : "status");
    if (state.linkedRecovery) notice.append(button("Retry linked change", recoverLinkedOperation));
    if (error && text && notice.getClientRects?.().length) {
      const reveal = () => {
        if (notice.hidden || notice.getAttribute("role") !== "alert" || notice.textContent !== text) return;
        const header = document.querySelector(".app-header"), top = Math.max(0, header?.getBoundingClientRect().bottom || 0) + 12, bounds = notice.getBoundingClientRect();
        if (bounds.top < top || bounds.bottom > window.innerHeight) window.scrollBy({ top: bounds.top - top, behavior: "auto" });
      };
      reveal();
      // A change raised by Tab precedes the browser's next-control focus scroll.
      // Reveal the error after that default action as well.
      window.requestAnimationFrame?.(reveal);
    }
  }
  function setProgress(text = "") {
    if (!state.ui?.progress) return;
    state.ui.progress.textContent = text;
    // The source identity already appears in the document selector. Keep the
    // render status available to assistive technology without repeating it.
    state.ui.progress.classList.toggle("sr-only", !text || text.endsWith(" · Original source"));
  }
  async function safely(fn) { try { return await fn(); } catch (error) { message(error.message || String(error), true); } }
  async function api(path, data, method = data === undefined ? "GET" : "POST") {
    const response = await fetch(`/api/takeoffs${path}`, { method, ...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }) });
    let result; try { result = await response.json(); } catch { const error = new Error(`The takeoff server returned an unreadable response (${response.status}).`); error.uncertainOutcome = true; throw error; }
    if (!response.ok) throw new Error(result.error || `Takeoff request failed (${response.status}).`);
    return result;
  }
  function accept(reply) {
    if (!reply?.session_id || !reply.snapshot || !Number.isInteger(reply.revision)) throw new Error("The takeoff response is incomplete.");
    const selectedMembers = new Set(selectedItems().filter(isCount).flatMap(selectedCountMemberIds));
    state.session = reply; state.resultMap = new Map((reply.item_results || []).map(item => [item.id, item])); state.issues = reply.issues || [];
    state.selected = new Set([...state.selected].filter(id => items().some(item => item.id === id && !isCount(item))));
    state.countSelection.clear();
    // A shared details edit can regroup rows. Carry only the previously
    // selected physical members into their new rows, never all batch members.
    for (const item of items().filter(isCount)) {
      const retained = new Set(item.member_ids.filter(member => selectedMembers.has(member)));
      if (retained.size) { state.selected.add(item.id); state.countSelection.set(item.id, retained); }
    }
    if (!currentDocument()) { state.document = documents()[0]?.id || null; state.page = 1; }
    state.bindings = snapshot().transfers || [];
    state.physicalUI?.render(physicalSnapshot());
    window.CeasefireProject?.changed?.();
  }
  function working(value) {
    state.busy = value;
    if (state.ui) {
      state.ui.root.setAttribute("aria-busy", String(value));
      // Navigation and drawing actions must visibly wait for scale inspection
      // or a mutation, rather than accepting a click that the handler ignores.
      for (const control of state.ui.root.querySelectorAll("[data-mode],[data-tool]")) if (control.dataset.mode || control.dataset.tool) control.disabled = value || !!control.dataset.mode && !labels[control.dataset.mode];
      for (const control of state.ui.physicalTabs?.querySelectorAll("button") || []) control.disabled = value || state.physicalPlacing;
      for (const control of state.ui.pageControls?.querySelectorAll("button,input") || []) control.disabled = value;
      if (state.ui.documentSelect) state.ui.documentSelect.disabled = value || !documents().length;
      for (const control of state.ui.tableWrap?.querySelectorAll("input,select") || []) if (!control.closest(".takeoff-register-editor")) control.disabled = value || control.dataset.countReadOnly === "true";
      state.ui.status.textContent = value ? "Working…" : `${items().length} items · ${documents().length} documents · Revision ${state.session?.revision || 0}`;
      renderViewportPanel();
    }
    window.CeasefireProject?.changed?.();
  }
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
    const numeric = kind === "number" || Array.isArray(kind) && numericOptionFields.has(key);
    if (kind === "checkbox") wrapper.classList.add("takeoff-checkbox-field");
    const control = Array.isArray(kind) ? select([["", "Choose…"], ...kind.map(value => Array.isArray(value) ? value : [value, value])]) : node(kind === "textarea" ? "textarea" : "input");
    if (!Array.isArray(kind) && kind !== "textarea") control.type = ["number", "color", "checkbox"].includes(kind) ? kind : "text";
    if (kind === "number") control.step = "any";
    if (Array.isArray(kind) && initial !== "" && initial != null && !kind.some(value => (Array.isArray(value) ? value[0] : value) === initial)) control.append(option(initial, `${initial} (retained)`));
    control.name = key; control.value = initial ?? ""; if (kind === "checkbox") control.checked = !!initial; control.dataset.field = key; control.setAttribute("aria-label", title); wrapper.append(control);
    if (key === "duct_size") { control.placeholder = "100x100"; control.pattern = ductSizePattern; }
    return { wrapper, control, read: () => { if (kind === "checkbox") return control.checked; if (!numeric) return Array.isArray(kind) ? control.value : control.value.trim(); if (control.validity?.badInput) throw new Error(`${title}: enter a valid number.`); if (control.value.trim() === "") return null; const value = Number(control.value); if (!Number.isFinite(value)) throw new Error(`${title}: enter a finite number.`); return value; } };
  }
  async function ask(title, definitions, detail = "", action = "Apply", setup) {
    if (state.modal) throw new Error("Finish the current review first.");
    state.modal = true; const sessionId = state.session?.session_id;
    const dialog = node("dialog", "takeoff-dialog"), form = node("form"); form.method = "dialog";
    const heading = node("h2", "", title); heading.id = `takeoff-dialog-${uuid()}`; dialog.setAttribute("aria-labelledby", heading.id); form.append(heading, node("p", "helper", detail));
    const controls = definitions.map(def => { const field = formField(def, def[3]); if (def[4]) field.control.required = true; form.append(field.wrapper); return field; });
    const actions = node("div", "actions"), cancel = node("button", "button secondary", "Cancel"), apply = node("button", "button primary", action); cancel.type = "button"; cancel.addEventListener("click", () => dialog.close("cancel")); apply.type = "submit"; apply.value = "confirm"; actions.append(cancel, apply); form.append(actions); dialog.append(form); document.body.append(dialog);
    try {
      // Show the form immediately. Exact calculator choices load separately;
      // submission stays disabled until their current request has completed.
      let setupError = null, readinessManaged = false;
      apply.disabled = !!setup;
      const accepted = await new Promise(resolve => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
        dialog.showModal();
        if (setup) Promise.resolve().then(() => setup(controls, ready => { readinessManaged = true; if (dialog.open) apply.disabled = !ready; })).then(() => { if (dialog.open && !readinessManaged) apply.disabled = false; }).catch(error => { if (dialog.open) { setupError = error; dialog.close("setup-error"); } });
      });
      if (setupError) throw setupError;
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
    for (const [mode, label] of [["steel", "STEEL"], ["duct", "DUCT"], ["physical", "PENETRATIONS"], ["wall", "WALLS"], ["slab", "SLABS"]]) {
      const el = button(label, () => changeMode(mode), "takeoff-mode"); el.dataset.mode = mode; el.setAttribute("role", "tab"); el.setAttribute("aria-selected", String(state.mode === mode));
      if (!labels[mode]) { el.disabled = true; el.title = "Planned after the Steel and Duct release"; }
      modes.append(el);
    }
    ui.physicalTabs = node("div", "takeoff-modes takeoff-physical-tabs"); ui.physicalTabs.setAttribute("role", "tablist"); ui.physicalTabs.setAttribute("aria-label", "Penetration workspaces"); ui.physicalTabs.hidden = true;
    for (const [scope, label] of [["defect_reports", "Defect Reports"], ["service_plans", "Service Plans"]]) {
      const tab = button(label, () => changePhysicalScope(scope), "takeoff-mode"); tab.dataset.physicalScope = scope; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(scope === state.physicalScope)); ui.physicalTabs.append(tab);
    }
    ui.message = node("div", "message"); ui.message.hidden = true;
    const toolbar = node("div", "takeoff-toolbar takeoff-tool-rail"); ui.toolRail = toolbar; toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "Drawing tools"); toolbar.setAttribute("aria-orientation", "vertical");
    ui.upload = node("input"); ui.upload.type = "file"; ui.upload.accept = ".pdf,application/pdf"; ui.upload.multiple = true; ui.upload.hidden = true; ui.upload.id = "takeoff-upload";
    ui.upload.addEventListener("change", () => { const files = [...ui.upload.files]; ui.upload.value = ""; void safely(() => upload(files)); });
    toolbar.append(button("Upload PDFs", () => { if (!state.busy) ui.upload.click(); }, "button primary"), ui.upload);
    ui.tools = {};
    for (const [tool, title] of [["select", "Select"], ["pan", "Pan"], ["settings", "Settings"], ["viewport", "Viewport"], ["calibrate", "Calibrate"], ["trace", "Trace length"], ["count", "Count"], ["countLength", "Count steel lengths"], ["polygon", "Trace surface"], ["exclusion", "Add exclusion"], ["measure", "Length"]]) { const el = button(title, () => tool === "count" ? activateCountTool() : tool === "countLength" ? setTool("count") : tool === "exclusion" ? startExclusion() : tool === "settings" ? toggleSettings() : tool === "viewport" ? toggleViewportPanel() : setTool(tool)); if (!["viewport", "settings"].includes(tool)) el.dataset.tool = tool === "countLength" ? "count" : tool; else { el.setAttribute("aria-expanded", "false"); el.setAttribute("aria-controls", tool === "settings" ? "takeoff-markup-settings" : "takeoff-viewports"); } ui.tools[tool] = el; toolbar.append(el); }
    ui.countAnchor = node("div", "takeoff-count-anchor"); ui.tools.count.after(ui.countAnchor); ui.countAnchor.append(ui.tools.count);
    const scaleAnchor = node("div", "takeoff-scale-anchor"); ui.scaleToggle = button("Scale", () => toggleScaleControls()); ui.scaleToggle.setAttribute("aria-expanded", "false"); ui.scaleToggle.setAttribute("aria-controls", "takeoff-scale-controls"); ui.scaleToggle.setAttribute("aria-describedby", "takeoff-active-scale");
    ui.scaleStatus = node("span", "sr-only", "No Scale Selected"); ui.scaleStatus.id = "takeoff-active-scale"; scaleAnchor.append(ui.scaleToggle, ui.scaleStatus); ui.tools.viewport.after(scaleAnchor); ui.scaleAnchor = scaleAnchor;
    ui.drawingDownloads = [button("Download XLSX", () => downloadTakeoff("schedule-xlsx")), button("Download PDF", () => downloadTakeoff("marked-pdf"))];
    const headingControls = node("div", "takeoff-heading-controls"), drawingDownloads = node("div", "takeoff-toolbar takeoff-drawing-downloads"); drawingDownloads.setAttribute("role", "group"); drawingDownloads.setAttribute("aria-label", "Drawing downloads"); drawingDownloads.append(...ui.drawingDownloads); headingControls.append(modes, drawingDownloads);
    ui.calibration = select([["", "No Scale Selected"]], async value => { await chooseCalibration(value); toggleScaleControls(false); }); ui.calibration.id = "takeoff-calibration"; ui.calibration.setAttribute("aria-label", "Drawing calibration"); ui.editCalibration = button("Edit calibration", editCalibration);
    const navigation = node("div", "takeoff-navigation"); ui.navigation = navigation; navigation.setAttribute("role", "group"); navigation.setAttribute("aria-label", "Drawing navigation");
    const documentControls = node("div", "takeoff-navigation-group takeoff-document-controls");
    ui.documentSelect = select([], async value => { try { if (value && value !== state.document) await navigateDocument(value); } finally { ui.documentSelect.value = state.document || ""; } }); ui.documentSelect.setAttribute("aria-label", "Drawing document");
    ui.removeDocument = button("Remove document", removeDocument); documentControls.append(ui.documentSelect, ui.removeDocument); navigation.append(documentControls);
    const pageControls = ui.pageControls = node("div", "takeoff-toolbar takeoff-viewer-controls takeoff-page-controls"); pageControls.setAttribute("role", "group"); pageControls.setAttribute("aria-label", "Page and zoom controls");
    const pageNavigation = node("div", "takeoff-page-navigation"); pageNavigation.setAttribute("role", "group"); pageNavigation.setAttribute("aria-label", "Page navigation");
    pageNavigation.append(button("First page", () => navigatePage(1)), button("‹ Page", () => navigatePage(state.page - 1)));
    ui.page = node("input", "takeoff-page-input"); ui.page.type = "number"; ui.page.min = "1"; ui.page.step = "1"; ui.page.value = "1"; ui.page.setAttribute("aria-label", "Page number"); ui.page.addEventListener("change", () => void safely(() => navigatePage(Number(ui.page.value))));
    ui.pageCount = node("span", "helper", "/ 0"); pageNavigation.append(ui.page, ui.pageCount, button("Page ›", () => navigatePage(state.page + 1)), button("Last page", () => navigatePage(currentDocument()?.pages.length || 1)));
    ui.tools.text = button("Select PDF text", () => setTool("text")); ui.tools.text.dataset.tool = "text";
    pageControls.append(pageNavigation, ui.tools.select, ui.tools.pan, ui.tools.text, button("−", () => zoomBy(1 / 1.25)), button("+", () => zoomBy(1.25)), button("Fit page", () => fitPage(true)));
    ui.zoom = node("span", "helper", "100%"); pageControls.append(ui.zoom);
    ui.search = node("input"); ui.search.type = "search"; ui.search.placeholder = "Search PDF text…"; ui.search.setAttribute("aria-label", "Search original document text"); ui.search.addEventListener("keydown", event => { if (event.key === "Enter") void safely(runSearch); });
    const searchControls = node("div", "takeoff-toolbar takeoff-search-controls"); searchControls.setAttribute("role", "search"); searchControls.setAttribute("aria-label", "Drawing search"); ui.searchScope = select([["document", "This document"], ["all", "All documents"]]); ui.searchScope.setAttribute("aria-label", "Text search scope"); searchControls.append(ui.search, ui.searchScope, button("Search", runSearch), button("Stop search", () => { ++state.searchId; setProgress(state.ui.progress.textContent + " · Search cancelled; coverage is incomplete."); }));
    const viewerTop = ui.viewerTop = node("div", "takeoff-toolbar takeoff-viewer-controls takeoff-viewer-top"); viewerTop.append(searchControls, navigation);
    ui.sourceDocuments = node("section", "takeoff-source-documents"); ui.sourceDocuments.setAttribute("aria-labelledby", "takeoff-source-documents-heading"); const sourceHeading = node("h3", "", "Source documents"); sourceHeading.id = "takeoff-source-documents-heading"; ui.sourceDocumentList = node("div", "takeoff-source-document-list"); ui.sourceDocuments.append(sourceHeading, ui.sourceDocumentList);
    const scaleControls = ui.scaleControls = node("div", "takeoff-toolbar takeoff-scale-controls"); scaleControls.id = "takeoff-scale-controls"; scaleControls.hidden = true; scaleControls.setAttribute("role", "group"); scaleControls.setAttribute("aria-label", "Drawing scale"); scaleControls.append(ui.calibration, ui.tools.calibrate, ui.editCalibration); scaleAnchor.append(scaleControls);
    scaleControls.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); toggleScaleControls(false); ui.scaleToggle.focus(); } });
    ui.progress = node("p", "takeoff-progress"); ui.progress.setAttribute("role", "status"); ui.searchResults = node("div", "takeoff-search-results"); ui.searchResults.hidden = true; ui.physicalOverlayStatus = node("p", "helper"); ui.physicalOverlayStatus.hidden = true;
    const workspace = node("div", "takeoff-workspace-split"); ui.workspace = workspace;
    const layout = node("div", "takeoff-drawing-layout"); ui.layout = layout; const drawingPane = node("div", "takeoff-drawing-pane"); ui.drawingPane = drawingPane;
    ui.viewport = node("div", "takeoff-viewport"); ui.viewport.id = "takeoff-viewport"; ui.viewport.tabIndex = 0; ui.viewport.dataset.scrollActive = "false"; ui.viewport.setAttribute("aria-label", "Drawing. Click or focus to scroll inside; Escape releases page scrolling. Drag a selected control point to recalculate, or remove it with Control+Z. Right-click a markup to delete it.");
    ui.pageWrap = node("div", "takeoff-page"); ui.pageWrap.hidden = true; ui.canvas = node("canvas"); ui.canvas.setAttribute("aria-label", "Original PDF page"); ui.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg"); ui.overlay.classList.add("takeoff-overlay"); ui.overlay.setAttribute("aria-label", "Takeoff markups");
    ui.pageWrap.append(ui.canvas, ui.overlay); ui.panSpace = node("div", "takeoff-pan-space"); ui.panSpace.append(ui.pageWrap); ui.empty = node("div", "takeoff-empty"); ui.empty.append(node("strong", "", "Your drawing workspace"), node("p", "", "Upload the original PDFs, choose a scale or calibrate a known distance, then trace each physical object. Edit and confirm items in the register before adding them to a schedule.")); ui.viewport.append(ui.panSpace, ui.empty);
    ui.viewportPanel = node("aside", "takeoff-viewports"); ui.viewportPanel.id = "takeoff-viewports"; ui.viewportPanel.hidden = true; ui.viewportPanel.setAttribute("aria-label", "Viewports");
    ui.settingsPanel = node("aside", "takeoff-markup-settings"); ui.settingsPanel.id = "takeoff-markup-settings"; ui.settingsPanel.hidden = true; ui.settingsPanel.setAttribute("aria-label", "Markup settings");
    ui.physicalDetails = node("div", "takeoff-physical-details"); ui.physicalDetails.id = "takeoff-physical-details"; ui.physicalDetails.hidden = true;
    ui.physicalDetails.append(button("Close Item Details", () => setPhysicalDetailsOpen(false), "button secondary", "Close settings"));
    layout.append(ui.sourceDocuments, toolbar, ui.viewportPanel, ui.settingsPanel, ui.physicalDetails, drawingPane);
    const register = node("section", "takeoff-register"); ui.register = register; const heading = node("div", "section-heading"); ui.registerTitle = node("h2", "", "Steel register"); ui.status = node("span", "status-label", "Ready"); ui.registerLayout = select([["below", "Register below drawing"], ["beside", "Register beside drawing"]], value => { workspace.classList.toggle("beside", value === "beside"); }); ui.registerLayout.setAttribute("aria-label", "Register position"); heading.append(ui.registerTitle, ui.status, ui.registerLayout); register.append(heading);
    const controls = node("div", "takeoff-register-controls"); ui.filter = node("input"); ui.filter.type = "search"; ui.filter.placeholder = "Filter register…"; ui.filter.setAttribute("aria-label", "Filter register"); ui.filter.addEventListener("input", () => { state.filter = ui.filter.value.toLowerCase(); state.offset = 0; renderRegister(); renderOverlay(); });
    ui.statusFilter = select([["", "All confirmation states"], ["unconfirmed", "Unconfirmed"], ["confirmed", "Confirmed"]], () => { renderRegister(); renderOverlay(); }); ui.statusFilter.setAttribute("aria-label", "Filter confirmation state");
    ui.sort = select([["mark", "Sort: Mark"], ["level", "Sort: Level"], ["length", "Sort: Length"], ["state", "Sort: Confirmation"]], value => { state.sort = value; renderRegister(); }); ui.sort.setAttribute("aria-label", "Sort register");
    ui.group = select([["", "No grouping"], ["level", "Group by level"], ["group", "Group by label"], ["state", "Group by confirmation"]], value => { state.group = value; renderRegister(); }); ui.group.setAttribute("aria-label", "Group register");
    ui.registerExtraControls = [ui.statusFilter, ui.sort, ui.group, button("Select filtered items", async () => { if (!await discardEditor()) return; visibleItems().forEach(item => { state.selected.add(item.id); state.countSelection.delete(item.id); }); renderSelection(); }), button("Clear selection", async () => { if (!await discardEditor()) return; state.selected.clear(); state.countSelection.clear(); renderSelection(); }), button("Undo last edit", () => undoLastEdit())];
    controls.append(ui.filter, ...ui.registerExtraControls);
    ui.bulk = node("div", "takeoff-bulk"); ui.bulk.hidden = true; ui.selectionCount = node("strong"); ui.bulkField = select([]); ui.bulkField.setAttribute("aria-label", "Bulk edit field"); ui.bulkValue = node("input"); ui.bulkValue.setAttribute("aria-label", "Bulk edit value"); ui.bulkValue.placeholder = "New value (blank clears)";
    ui.bulk.append(ui.selectionCount, ui.bulkField, ui.bulkValue, button("Apply to selected", bulkEdit), button("Confirm", confirmSelected), button("Unconfirm", () => selectedCommand("unconfirm_items")), button("Delete", deleteSelected), ui.split = button("Split", splitSelected), ui.merge = button("Merge", mergeSelected));
    const exports = node("div", "takeoff-register-controls"); ui.target = select([["steel_vermiculite", "Steel Spray Schedule"], ["steel_board", "Steel Board Schedule"]], refreshRegisterOptions); ui.target.setAttribute("aria-label", "Destination schedule");
    ui.transferControls = [ui.target, button("Preview transfer", () => transfer(false)), button("Update linked rows", () => transfer(true)), button("Detach links", detachSelected)];
    ui.areaNotice = node("p", "helper takeoff-area-notice", "Area records export as m². Existing steel and duct calculators do not accept surface areas. Split/merge is unavailable for surfaces; group separate physical surfaces without changing their identities.");
    exports.append(...ui.transferControls, button("Export CSV", () => exportRegister("csv")), button("Export XLSX", () => exportRegister("xlsx")), ui.areaNotice);
    ui.tableWrap = node("div", "takeoff-register-table"); ui.pagination = node("div", "takeoff-register-controls"); register.append(controls, ui.bulk, exports, ui.tableWrap, ui.pagination);
    ui.physicalContainer = node("div", "takeoff-physical-container"); ui.physicalContainer.hidden = true;
    ui.controlStatus = node("p", "helper takeoff-control-status"); ui.controlStatus.hidden = true; ui.controlStatus.setAttribute("role", "status");
    const viewer = node("div", "takeoff-viewer"); viewer.append(ui.viewport, viewerTop, pageControls);
    drawingPane.append(viewer, ui.progress, ui.controlStatus, ui.searchResults, ui.physicalOverlayStatus);
    const tabPanel = node("div", "takeoff-tab-panel"); tabPanel.append(modes, ui.physicalTabs); headingControls.replaceChildren(tabPanel, drawingDownloads);
    workspace.append(layout, register); root.append(headingControls, ui.message, workspace, ui.physicalContainer);
    ui.viewport.addEventListener("pointerdown", activatePlan, { capture: true }); ui.viewport.addEventListener("focusin", activatePlan);
    ui.overlay.addEventListener("click", drawingPointer); ui.viewport.addEventListener("pointerdown", beginPan); ui.overlay.addEventListener("pointerdown", event => void safely(() => beginSelectionGesture(event)));
    ui.overlay.addEventListener("dblclick", event => void safely(() => finishTraceFromDoubleClick(event)));
    ui.viewport.addEventListener("contextmenu", planContextMenu);
    ui.overlay.addEventListener("pointermove", tracePointerMove);
    ui.viewport.addEventListener("pointermove", event => { state.pastePointer = { key: pageDisplayKey(), client: [event.clientX, event.clientY] }; });
    ui.viewport.addEventListener("pointerleave", () => { state.pastePointer = null; });
    ui.overlay.addEventListener("pointerleave", () => { if (state.traceCursor && !state.gesture) { state.traceCursor = null; renderOverlay(); } });
    ui.viewport.addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ui.viewport.clientHeight : 1); if (Number.isFinite(delta) && delta) void safely(() => zoomBy(Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), [event.clientX, event.clientY])); } else handoffPlanWheel(event); }, { passive: false });
    ui.viewport.addEventListener("keydown", planKeydown);
    ui.viewport.addEventListener("click", event => {
      if ([ui.viewport, ui.panSpace, ui.pageWrap, ui.canvas, ui.overlay].includes(event.target) && !event.ctrlKey && !event.metaKey && !event.shiftKey && Date.now() >= (state.suppressSelectionClickUntil || 0)) void safely(clearDrawingSelection);
    });
  }
  async function open() { build(); state.active = true; await ensureSession(); renderData(); if (state.document) await renderPage(); }
  async function changeMode(mode) { if (!labels[mode] || state.busy || state.physicalPlacing) return; if (!await discardEditor()) return; state.mode = mode; resetPlanInteraction(); state.offset = 0; state.selected.clear(); cancelTrace(); syncSurfaceDetailsSelection(); renderData(); }
  async function changePhysicalScope(scope) {
    if (!["defect_reports", "service_plans"].includes(scope) || scope === state.physicalScope || state.busy || state.physicalPlacing) return;
    if (!await discardEditor()) return;
    resetPlanInteraction(); cancelTrace(); state.physicalUI?.destroy(); state.physicalUI = null;
    state.physicalScope = scope; state.physicalSelected.clear(); state.physicalVisible.clear(); state.physicalHovered = null; state.physicalPreviews.clear(); state.physicalDetailsOpen = false;
    renderData();
  }
  function setPhysicalDetailsOpen(open) {
    state.physicalDetailsOpen = !!open;
    if (open) { state.viewportsOpen = false; state.settingsOpen = false; state.settingsEditor = null; renderViewportPanel(); }
    renderPhysicalDetails();
  }
  function renderPhysicalDetails() {
    if (!state.ui?.physicalDetails) return;
    const open = state.mode === "physical" && state.physicalDetailsOpen;
    state.ui.physicalDetails.hidden = !open; state.ui.layout.classList.toggle("with-physical-details", open);
    if (state.mode === "physical") { state.ui.tools.settings.setAttribute("aria-controls", "takeoff-physical-details"); state.ui.tools.settings.setAttribute("aria-expanded", String(open)); state.ui.tools.settings.classList.toggle("takeoff-tool-active", open); }
    else state.ui.tools.settings.setAttribute("aria-controls", "takeoff-markup-settings");
  }
  function requireFinishedEdits() { if (physicalUnfinished() || state.physicalPlacing) throw new Error("Apply or discard unfinished physical edits and finish their review first."); if (state.formDirty || state.settingsDirty || state.gesture || state.points.length || state.pendingViewport) throw new Error("Apply or discard the unfinished item/settings edits and finish or cancel the current drawing operation first."); if (state.calibrationTarget) cancelTrace(); }
  async function discardEditor() { await state.physicalUI?.completePendingEdits?.(); await flushSettings(); if (physicalUnfinished()) throw new Error("Apply or discard unfinished physical edits and finish their review first."); if (!state.formDirty && !state.settingsDirty && !state.gesture && !state.points.length && !state.pendingViewport) { if (state.retraceId || state.exclusionItemId || state.calibrationTarget) cancelTrace(); return true; } if (!await confirm("Discard unfinished edits?", "The item form, settings or current drawing has unapplied changes. Saved takeoff items are retained.", "Discard edits")) return false; state.formDirty = false; state.settingsDirty = false; state.settingsEditor = null; cancelTrace(); return true; }
  function renderData() {
    if (!state.ui) return;
    for (const el of state.ui.root.querySelectorAll("[data-mode]")) el.setAttribute("aria-selected", String(el.dataset.mode === state.mode));
    const physical = state.mode === "physical";
    state.ui.tools.count.dataset.tool = physical ? "count" : "count-only";
    if (state.ui.tools.settings) state.ui.tools.settings.hidden = false; for (const [index, control] of (state.ui.drawingDownloads || []).entries()) control.hidden = physical && index === 0;
    state.ui.physicalTabs.hidden = !physical; for (const tab of state.ui.physicalTabs.querySelectorAll("button")) tab.setAttribute("aria-selected", String(tab.dataset.physicalScope === state.physicalScope));
    if (physical) { state.settingsOpen = false; state.settingsEditor = null; } renderSettingsPanel();
    renderPhysicalDetails();
    state.ui.physicalContainer.hidden = !physical; state.ui.physicalOverlayStatus.hidden = true; state.ui.register.hidden = physical;
    state.ui.workspace.classList.toggle("beside", !physical && state.ui.registerLayout.value === "beside");
    state.ui.registerLayout.disabled = physical;
    // Page/view scales are shared source metadata, even in the physical draft.
    for (const control of [state.ui.calibration, state.ui.editCalibration, state.ui.cancelTrace, state.ui.tools.calibrate, state.ui.tools.viewport]) if (control) control.hidden = false;
    if (physical) {
      for (const tool of ["trace", "countLength", "measure", "polygon", "exclusion"]) state.ui.tools[tool].hidden = true;
      state.ui.tools.count.hidden = false; state.ui.countAnchor.hidden = false; state.ui.scaleAnchor.after(state.ui.countAnchor);
      ensurePhysicalUI(); state.physicalUI.render(physicalSnapshot()); renderRail(); renderCalibrations(); renderOverlay(); working(state.busy); return;
    }
    state.ui.tools.trace.after(state.ui.countAnchor);
    state.ui.registerTitle.textContent = `${labels[state.mode]} register`;
    for (const control of state.ui.registerExtraControls || []) control.hidden = state.mode === "duct";
    for (const control of [state.ui.statusFilter, state.ui.sort, state.ui.group]) control.hidden = usesColumnFilters();
    const area = isArea();
    for (const control of state.ui.transferControls) { control.hidden = area; control.disabled = area; }
    state.ui.areaNotice.hidden = !area;
    state.ui.tools.trace.hidden = area;
    state.ui.tools.count.hidden = state.mode !== "duct"; state.ui.countAnchor.hidden = state.mode !== "duct"; state.ui.tools.countLength.hidden = state.mode !== "steel"; state.ui.tools.measure.hidden = !area;
    for (const tool of ["polygon", "exclusion"]) state.ui.tools[tool].hidden = !area;
    const sortChoices = [["mark", "Sort: Mark"], ["level", "Sort: Level"], [area ? "area" : "length", area ? "Sort: Net area" : "Sort: Length"], ["state", "Sort: Confirmation"]];
    if (!sortChoices.some(([key]) => key === state.sort)) state.sort = "mark";
    state.ui.sort.replaceChildren(...sortChoices.map(([key, label]) => option(key, label))); state.ui.sort.value = state.sort;
    const targets = area ? [] : state.mode === "steel" ? [["steel_vermiculite", "Steel Spray Schedule"], ["steel_board", "Steel Board Schedule"]] : [["ductwork", "Ductwork Schedule"]];
    const target = state.ui.target.value; state.ui.target.replaceChildren(...targets.map(([id, label]) => option(id, label))); if (targets.some(([id]) => id === target)) state.ui.target.value = target;
    syncBulkFields();
    renderRail(); renderCalibrations(); renderRegister(); renderSettingsPanel(); renderOverlay(); working(state.busy);
  }
  async function refreshRegisterOptions() {
    renderSettingsPanel();
    renderRegister();
  }
  function physicalRequest(path, values, { mutate = false, expected, sessionId = state.session?.session_id } = {}) {
    const task = state.queue.then(async () => {
      if (!sessionId || sessionId !== state.session?.session_id) throw new Error("The project changed. Repeat the physical action in the current project.");
      working(true);
      try {
        const reply = await api(`/sessions/${sessionId}/${path}`, { expected_revision: expected ?? state.session.revision, ...(mutate ? { request_id: uuid() } : {}), ...values });
        if (sessionId !== state.session?.session_id) throw new Error("The project changed while the physical request was running.");
        if (mutate) { accept(reply); renderData(); }
        return reply;
      } finally { working(false); }
    });
    state.queue = task.catch(() => {}); return task;
  }
  function normalizePhysicalImages(inventory) {
    const records = (inventory.items || []).map(item => ({
      ...item, id: item.image_id || item.asset_id, sha256: item.image_sha256,
      name: `${item.source_name || documentById(item.document_id)?.name || "Source PDF"} · page ${item.page}`,
      issues: [...(item.issues || []), ...(!item.has_rendition ? ["This occurrence has no retained display bitmap. Inspect the original source and resolve the extraction issue."] : [])],
    }));
    for (const extraction of inventory.extractions || []) {
      const doc = documentById(extraction.document_id), pages = extraction.page_results || (extraction.coverage?.pages || []).filter(page => typeof page === "object");
      const documentId = extraction.document_id, documentHash = extraction.document_sha256 || extraction.source_sha256 || doc?.sha256;
      if (pages.length) for (const page of pages) records.push({ coverage_only: true, document_id: documentId, document_sha256: documentHash, page: page.page, name: `${doc?.name || extraction.source_name || "Source PDF"} · page ${page.page} extraction coverage`, coverage: `Status: ${page.status || "unknown"}. ${page.occurrence_ids?.length ?? page.occurrence_count ?? "Unknown"} image occurrences recorded. No physical quantity is derived.`, issues: [...(page.issues || [])] });
      else records.push({ coverage_only: true, document_id: documentId, document_sha256: documentHash, page: extraction.first_page, name: `${doc?.name || "Source PDF"} extraction coverage`, coverage: JSON.stringify(extraction.coverage || { status: extraction.status || "Coverage unavailable", first_page: extraction.first_page, page_count: extraction.page_count }), issues: extraction.issues || [] });
      if (extraction.issues?.length && pages.length) records.push({ coverage_only: true, document_id: documentId, document_sha256: documentHash, page: extraction.first_page || pages[0].page, name: `${doc?.name || "Source PDF"} extraction issues`, coverage: "These extraction issues require source review.", issues: extraction.issues });
    }
    return records;
  }
  async function physicalSource(reference) {
    if (state.busy) throw new Error("Wait for the drawing to finish loading, then select the record again.");
    const sessionId = state.session?.session_id, scope = state.physicalScope;
    const doc = documentById(reference.document_id);
    if (!doc || doc.sha256 !== reference.document_sha256) throw new Error("This physical evidence source is missing or its exact source hash no longer matches.");
    if (!Number.isInteger(reference.page) || reference.page < 1 || reference.page > doc.pages.length) throw new Error("This physical evidence page is unavailable.");
    if (!await navigateDocument(reference.document_id, reference.page)) return;
    if (sessionId !== state.session?.session_id || scope !== state.physicalScope || state.document !== doc.id || state.page !== reference.page || documentById(doc.id)?.sha256 !== reference.document_sha256 || !state.viewport) return;
    if (reference.region?.length >= 3 && reference.region.every(point => Array.isArray(point))) await focusGeometry({ geometry: { points: reference.region } });
    else if (Array.isArray(reference.point) && reference.point.length === 2 && reference.point.every(Number.isFinite) && state.viewport) {
      const point = G.transform(reference.point, state.viewport.transform); positionPage(state.ui.viewport.clientWidth / 2 - point[0], state.ui.viewport.clientHeight / 2 - point[1]);
    }
    renderOverlay();
  }
  function hoverPhysical(id) {
    state.physicalHovered = id;
    for (const hit of state.ui?.overlay.querySelectorAll("[data-physical-id]") || []) hit.previousElementSibling?.classList.toggle("hovered", hit.dataset.physicalId === id);
  }
  async function exportPhysical(format) {
    const sessionId = state.session?.session_id, scope = state.physicalScope;
    const response = await fetch(`/api/takeoffs/sessions/${sessionId}/physical/export/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Physical draft export failed."); }
    if (sessionId !== state.session?.session_id || scope !== state.physicalScope) throw new Error("The project or penetration workspace changed during draft export. Export the current draft again.");
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = `CEASEFIRE-${scope === "service_plans" ? "Service-Plans" : "Defect-Reports"}-UNAPPROVED-DRAFT.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    message("Exported the unapproved physical draft with its retained parent and evidence identities. This is not an approved quantity export.");
  }
  function ensurePhysicalUI() {
    if (state.physicalUI) return;
    if (!window.CeasefireTakeoffPhysical?.mount) throw new Error("The physical draft workspace could not be loaded.");
    const scope = state.physicalScope;
    state.physicalUI = window.CeasefireTakeoffPhysical.mount(state.ui.physicalContainer, {
      ask, confirm, notify: message, changed: () => window.CeasefireProject?.changed?.(), source: physicalSource,
      scope: () => scope, inspectorContainer: state.ui.physicalDetails,
      selectionChanged: ({ selected, openDetails = true }) => { if (openDetails && state.mode === "physical") setPhysicalDetailsOpen(selected.length > 0); },
      fieldOptions: async () => {
        const configuration = clone(window.CeasefireProject?.configuration?.() || { inventory: {}, rates: {} });
        const response = await fetch("/api/penetration/definition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configuration }) });
        const definition = await response.json();
        if (!response.ok) throw new Error(definition.error || "The Firestopping field choices could not be loaded.");
        const columns = { substrate: "P", orientation: "M", service: "J", service_type: "K", frl: "N" };
        return Object.fromEntries(Object.entries(columns).map(([key, column]) => {
          const field = definition.row_fields?.find(value => value.column === column);
          if (field?.type !== "select" || !Array.isArray(field.options) || !field.options.length || field.options.some(value => typeof value !== "string")) throw new Error(`The Firestopping ${key.replaceAll("_", " ")} choices are unavailable.`);
          return [key, [...field.options]];
        }));
      },
      preview: async commands => {
        const sessionId = state.session?.session_id, reply = await physicalRequest("physical/preview", { commands, scope }, { sessionId });
        if (scope !== state.physicalScope) throw new Error("The penetration workspace changed during preview.");
        state.physicalPreviews.set(reply.preview_id, { sessionId, revision: reply.revision, scope });
        while (state.physicalPreviews.size > 20) state.physicalPreviews.delete(state.physicalPreviews.keys().next().value);
        return reply;
      },
      apply: async previewId => {
        const preview = state.physicalPreviews.get(previewId);
        if (!preview || preview.sessionId !== state.session?.session_id || preview.scope !== state.physicalScope) throw new Error("The physical preview belongs to a previous project or workspace. Review the current draft again.");
        const reply = await physicalRequest("physical/apply", { preview_id: previewId, scope }, { mutate: true, expected: preview.revision, sessionId: preview.sessionId });
        return { ...reply, snapshot: physicalSnapshot(reply.snapshot) };
      },
      imageContext: () => ({ document_id: state.document, page: state.page }),
      images: async extractionId => {
        const sessionId = state.session?.session_id; if (!sessionId || !extractionId) return [];
        let offset = 0, inventory = null;
        do {
          const reply = await api(`/sessions/${sessionId}/images?extraction_id=${encodeURIComponent(extractionId)}&offset=${offset}&limit=100`);
          if (sessionId !== state.session?.session_id) throw new Error("The project changed while loading retained images.");
          if (reply.extraction_id !== extractionId || !Number.isInteger(reply.total) || reply.total < 0 || reply.total > 512 || reply.offset !== offset || !Array.isArray(reply.items) || reply.items.length > 100 || offset + reply.items.length > reply.total) throw new Error("The selected image extraction returned invalid or excessive inventory coverage.");
          if (!inventory) inventory = { ...reply, items: [] };
          if (reply.total !== inventory.total || reply.revision !== inventory.revision) throw new Error("The retained image inventory changed during loading. Refresh it again.");
          inventory.items.push(...reply.items); offset += reply.items.length;
          if (Boolean(reply.has_more) !== (offset < reply.total) || reply.has_more && !reply.items.length) throw new Error("The selected image extraction returned incomplete pagination.");
          if (!reply.has_more) break;
        } while (offset < 512);
        if (offset !== inventory.total) throw new Error("The retained image inventory is incomplete. No partial inventory has been shown.");
        return normalizePhysicalImages(inventory);
      },
      imageUrl: image => `/api/takeoffs/sessions/${state.session.session_id}/images/${encodeURIComponent(image.extraction_id)}/${encodeURIComponent(image.asset_id || image.id)}/file`,
      extract: async () => {
        if (!state.document || !state.viewport) throw new Error("Open a successfully rendered original PDF page before extracting its embedded images.");
        const reply = await physicalRequest("images/extract", { document_id: state.document, first_page: state.page, page_count: 1 }, { mutate: true });
        return { ...reply, snapshot: physicalSnapshot(reply.snapshot) };
      },
      export: exportPhysical, undo: async () => { const reply = await command("undo"); return { ...reply, snapshot: physicalSnapshot(reply.snapshot) }; }, history: showAudit,
      selection: async (ids, reference, focus, openDetails = true) => { state.physicalSelected = new Set(ids); if (openDetails && ids.length && state.mode === "physical") { setPhysicalDetailsOpen(true); state.ui.physicalDetails.scrollTop = 0; } if (reference && focus) await physicalSource(reference); else renderOverlay(); },
      hover: hoverPhysical,
      placeMarker: id => armPhysicalMarker(id),
      viewChanged: (ids, selected) => { state.physicalVisible = new Set(ids); state.physicalSelected = new Set(selected); if (state.mode === "physical" && state.physicalUI) renderOverlay(); },
    });
  }
  const scaleDenominators = [2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300];
  function activePageCalibrations() {
    const all = snapshot()?.calibrations || [], superseded = new Set(all.map(value => value.supersedes_id).filter(Boolean));
    return all.filter(value => value.document_id === state.document && value.page === state.page && !value.deleted && !superseded.has(value.id));
  }
  function inViewport(point, region) { return point[0] >= region[0] && point[1] >= region[1] && point[0] <= region[0] + region[2] && point[1] <= region[1] + region[3]; }
  function toggleScaleControls(open = state.ui.scaleControls.hidden) {
    state.ui.scaleControls.hidden = !open; state.ui.scaleToggle.setAttribute("aria-expanded", String(open)); state.ui.scaleToggle.classList.toggle("takeoff-tool-active", open);
    if (open) state.ui.calibration.focus();
  }
  function activateCountTool() {
    if (state.busy || state.physicalPlacing) return;
    if (state.mode === "physical" && state.physicalScope === "defect_reports") {
      ensurePhysicalUI(); toggleScaleControls(false); setTool("count");
      state.physicalPlacementTarget = { kind: "defect", sessionId: state.session?.session_id, documentId: state.document, page: state.page, controller: state.physicalUI };
      setProgress("Click the drawing to locate a defect and open Add Defect. The location is a source annotation; it does not create a barrier or service quantity.");
    } else { setTool(state.mode === "physical" ? "count" : "count-only"); state.ui.tools.count.classList.add("takeoff-tool-active"); }
  }
  async function armPhysicalMarker(id) {
    if (state.mode !== "physical") throw new Error("Open the Penetrations workspace before placing a barrier marker.");
    requireFinishedEdits(); ensurePhysicalUI();
    if (!state.viewport) throw new Error("Open a successfully rendered PDF page before placing the marker.");
    const controller = state.physicalUI, sessionId = state.session?.session_id, scope = state.physicalScope;
    const barrier = physicalGraph()?.barriers?.find(value => value.id === id && !value.deleted);
    if (!barrier || barrier.marker) throw new Error("Choose an active barrier without a count marker.");
    await controller.select(id, false, false);
    if (state.mode !== "physical" || scope !== state.physicalScope || controller !== state.physicalUI || sessionId !== state.session?.session_id) return;
    setTool("count");
    state.physicalPlacementTarget = { id, sessionId, documentId: state.document, page: state.page, controller };
    message("Click the PDF to place this barrier's count marker, or choose Select to leave it unplaced.");
  }
  function renderCalibrations() {
    const calibrations = activePageCalibrations();
    state.ui.calibration.replaceChildren(option("", "No Scale Selected"), ...calibrations.map(calibration => option(calibration.id, `${calibration.region ? "Viewport: " : ""}${calibration.name}${calibration.scale_denominator ? ` · 1:${calibration.scale_denominator}` : ""}`)), ...scaleDenominators.map(value => option(`scale:${value}`, `1:${value}`)));
    if (!calibrations.some(calibration => calibration.id === state.calibration)) state.calibration = "";
    const printed = calibrations.filter(calibration => !calibration.region && calibration.printed_scale_evidence);
    if (!state.calibration && printed.length === 1) state.calibration = printed[0].id;
    state.ui.calibration.value = state.calibration;
    if (state.ui.scaleToggle) { const active = state.ui.calibration.selectedOptions[0]?.textContent || "No Scale Selected"; state.ui.scaleToggle.title = `Scale · ${active}`; state.ui.scaleStatus.textContent = active; }
    if (calibrations.some(value => value.id === state.calibration && value.region)) state.viewportSelection = state.calibration;
    renderViewportPanel();
  }
  async function toggleViewportPanel() {
    if (state.mode === "physical") { state.physicalDetailsOpen = false; renderPhysicalDetails(); }
    if (state.settingsOpen) { if (!await discardEditor()) return; state.settingsOpen = false; state.settingsEditor = null; renderSettingsPanel(); renderRegister(); }
    state.viewportsOpen = !state.viewportsOpen; renderViewportPanel();
  }
  async function toggleSettings() {
    if (state.mode === "physical") { ensurePhysicalUI(); setPhysicalDetailsOpen(!state.physicalDetailsOpen); return; }
    if (!await discardEditor()) return;
    state.settingsOpen = !state.settingsOpen; state.settingsEditor = null; state.viewportsOpen = false;
    renderViewportPanel(); renderRegister(); renderSettingsPanel();
  }
  function markSettingsEdited(editor, key) {
    if (state.settingsEditor !== editor) return;
    state.settingsRevision = (state.settingsRevision || 0) + 1; editor.touched.set(key, state.settingsRevision); state.settingsDirty = true;
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => {
      editor.timer = null;
      // An unfinished numeric token is not a committed value. Let the user
      // finish typing; blur/change or an explicit save still validates it.
      const active = document.activeElement;
      const validity = active?.validity;
      if (state.ui?.settingsPanel?.contains?.(active) && validity && (validity.badInput || validity.patternMismatch || validity.rangeUnderflow || validity.rangeOverflow || validity.valueMissing)) return;
      void safely(() => applySettings(editor));
    }, 450);
    window.CeasefireProject?.changed?.();
  }
  function settingsSelectionKey() {
    return JSON.stringify([state.session?.session_id, selectedItems().flatMap(item => isCount(item) ? selectedCountMemberIds(item).map(id => `member:${id}`) : [`item:${item.id}`]).sort()]);
  }
  function bindSetting(editor, field, key) {
    field.control.addEventListener("input", () => markSettingsEdited(editor, key));
    field.control.addEventListener("change", () => { if (!editor.touched.has(key)) markSettingsEdited(editor, key); void safely(() => applySettings(editor)); });
  }
  async function flushSettings() {
    const editor = state.settingsEditor;
    if (editor && (editor.touched.size || editor.applying)) await applySettings(editor);
  }
  async function loadSettingsOptions(editor) {
    const item = settingsSelectedItems()[0]; if (!item || isSurface(item) || item.purpose === "length-only") return;
    const calculator = isStandalone(item) ? "ductwork" : state.ui.target.value, request = editor.optionRequest = (editor.optionRequest || 0) + 1;
    const product = editor.fields.find(field => field.control.name === "product")?.control.value || "", member = editor.fields.find(field => field.control.name === "member_type")?.control.value || "";
    const choices = await loadCalculatorOptions(calculator, product, member);
    if (state.settingsEditor !== editor || request !== editor.optionRequest || (!isStandalone(item) && calculator !== state.ui.target.value)) return;
    populateCalculatorOptions(editor.fields, choices, calculator);
  }
  function renderSettingsPanel() {
    const panel = state.ui?.settingsPanel; if (!panel) return;
    panel.hidden = !state.settingsOpen; state.ui.layout.classList.toggle("with-settings", !!state.settingsOpen);
    state.ui.tools.settings.setAttribute("aria-expanded", String(!!state.settingsOpen)); state.ui.tools.settings.classList.toggle("takeoff-tool-active", !!state.settingsOpen);
    if (!state.settingsOpen) return;
    const selected = settingsSelectedItems(), key = settingsSelectionKey();
    const existing = state.settingsEditor;
    if (existing?.key === key && (state.settingsDirty || existing.applying || existing.revision === state.session.revision)) { const sides = existing.fields.find(field => field.control.name === "sides"); if (sides) sides.wrapper.hidden = state.ui.target.value !== "steel_board"; refreshItemSettingsTools(existing); void safely(() => loadSettingsOptions(existing)); return; }
    const countsOnly = selected.length > 0 && selected.every(isCount);
    const heading = node("div", "takeoff-viewports-heading"); heading.append(button("Close settings", toggleSettings), node("h3", "", countsOnly ? "Count Settings" : "Settings")); panel.replaceChildren(heading);
    if (!selected.length) { state.settingsEditor = null; panel.append(node("p", "helper", "Select one or more drawing markups or register items. Settings show the first selected item; only fields you edit are applied to the selection.")); return; }
    if (existing) clearTimeout(existing.timer);
    const first = selected[0];
    if (selected.some(item => (item.purpose || "standard") !== (first.purpose || "standard"))) { state.settingsEditor = null; panel.append(node("p", "helper", "Select counts, measurements or calculator items separately to edit their details.")); return; }
    const editor = { key, sessionId: state.session.session_id, revision: state.session.revision, ids: selected.map(item => item.id), touched: new Map(), fields: [], appearance: [], quantity: null, lengths: [] }; state.settingsEditor = editor;
    const content = node("div", "takeoff-settings-fields"); panel.append(content);
    content.append(node("h4", "", "Markup appearance"));
    const appearance = appearanceOf(first);
    for (const def of [...(countsOnly ? [["marker_shape", "Marker shape", ["circle", "square", "triangle", "diamond"]], ["marker_size", "Marker Size", "number"]] : []), ["stroke_color", "Stroke colour", "color"], ["stroke_width", "Stroke Width", "number"], ["fill_color", "Fill colour", "color"], ["fill_enabled", "Fill enabled", "checkbox"], ["opacity", "Opacity", "number"]]) {
      const field = formField(def, appearance[def[0]]); field.control.required = def[2] !== "checkbox"; if (def[0] === "stroke_width") { field.control.min = "0.25"; field.control.max = "20"; } if (def[0] === "opacity") { field.control.min = "0"; field.control.max = "1"; field.control.step = "0.05"; }
      bindSetting(editor, field, `appearance:${def[0]}`); editor.appearance.push(field); content.append(field.wrapper);
      if (def[0] === "marker_size") { field.control.min = "2"; field.control.max = "72"; }
    }
    content.append(node("p", "helper", countsOnly ? "Marker size uses physical PDF points. Colour, shape, fill and opacity change appearance only." : "Appearance is visual only and does not approve quantities. Fill applies to closed surface or cited-region markups."), node("h4", "", "Item details"));
    editor.fields = itemFields(first).map(def => { const field = formField(def, def[0] === "duct_size" ? formatDuctSize(first.fields) : first.fields[def[0]]); bindSetting(editor, field, `fields:${def[0]}`); if (def[0] === "sides") field.wrapper.hidden = state.ui.target.value !== "steel_board"; if (["product", "member_type"].includes(def[0])) field.control.addEventListener("change", () => void safely(() => loadSettingsOptions(editor))); content.append(field.wrapper); return field; });
    if (selected.some(isCount)) {
      const counted = selected.filter(item => isCount(item) && !isStandalone(item));
      counted.forEach((item, index) => {
        if (counted.length > 1) content.append(node("h4", "", `Length group ${index + 1}`));
        const quantity = formField(["count_quantity", "Count/QTY", "number"], item.quantity), length = formField(["length_m", "Length (m)", "number"], item.measurement.length_m);
        quantity.control.readOnly = true; length.control.required = true; length.control.min = "0.000000001"; length.control.max = "1000000000000";
        const entry = { key: `length:${item.id}`, memberIds: [...item.member_ids], field: length, quantity, itemId: item.id }; editor.lengths.push(entry); bindSetting(editor, length, entry.key);
        content.append(quantity.wrapper, length.wrapper);
        const row = node("div", "takeoff-count-length"), result = itemResult(item); row.dataset.itemId = item.id;
        row.append(node("p", "helper", `${item.quantity} markers · Manual base: ${formatLength(item.measurement.length_m)} m each${result.additions_length_m ? ` + additions: ${formatLength(result.additions_length_m)} m each` : ""} · Total: ${formatLength(result.total_length_m)} m`), button("Delete item", async () => { await flushSettings(); const current = items().filter(value => isCount(value) && value.member_ids.some(id => entry.memberIds.includes(id))); if (current.some(value => value.member_ids.some(id => !entry.memberIds.includes(id)))) throw new Error("The length groups combined. Select the current group before deleting it."); await deleteItems(current.map(value => value.id)); })); content.append(row);
      });
    }
    if (isStandalone(first)) {
      const total = selected.reduce((sum, item) => sum + item.quantity, 0), row = node("div", "takeoff-standalone-settings");
      const quantity = formField(["total_count", first.purpose === "count-only" ? "Total Count/QTY" : "Length (m)", "number"], first.purpose === "count-only" ? total : itemResult(first).length_m); quantity.control.readOnly = true;
      row.append(quantity.wrapper, node("p", "helper", first.purpose === "count-only" ? "The total counts markers on the PDF. Add or remove a marker to change it." : "Length follows the calibrated source points."), button("Delete item", async () => { await flushSettings(); await deleteItems(selected.map(item => item.id)); })); content.append(row);
    } else if (!isCount(first) && !isSurface(first)) { editor.quantity = formField(["quantity", "Count/QTY", "number"], first.quantity); bindSetting(editor, editor.quantity, "quantity"); content.append(editor.quantity.wrapper); }
    if (selected.length === 1 && !isCount(first)) renderItemSettingsTools(content, first, editor);
    void safely(() => loadSettingsOptions(editor));
  }
  async function applySettings(editor) {
    if (!editor || state.settingsEditor !== editor) return;
    clearTimeout(editor.timer); editor.timer = null;
    if (editor.applying) return editor.applying;
    const run = Promise.resolve().then(async () => {
      while (state.settingsEditor === editor && editor.touched.size) {
        await state.queue;
        if (state.settingsEditor !== editor || editor.sessionId !== state.session?.session_id || editor.key !== settingsSelectionKey()) throw new Error("The selection changed before settings finished updating. Select the item again.");
        if (state.modal || state.gesture || state.points.length || state.pendingViewport || state.formDirty) throw new Error("Finish the current drawing operation or item edit before settings can update. Your settings are retained.");
        const captured = new Map(editor.touched), changes = {}, selected = settingsSelectedItems(), lengthChanges = [];
        for (const [group, controls] of [["fields", editor.fields], ["appearance", editor.appearance]]) for (const field of controls) if (captured.has(`${group}:${field.control.name}`)) {
          if (group === "fields" && field.control.name === "duct_size") {
            if (selected.every(item => formatDuctSize(item.fields) === field.control.value)) continue;
            const dimensions = parseDuctSize(field.read());
            if (selected.some(item => Object.entries(dimensions).some(([key, value]) => (item.fields[key] ?? null) !== value))) Object.assign(changes.fields ||= {}, dimensions);
            continue;
          }
          let value = field.read(); if (group === "appearance" && field.control.name.endsWith("color")) value = value.toUpperCase();
          if (selected.some(item => (group === "appearance" ? appearanceOf(item)[field.control.name] : item.fields[field.control.name] ?? "") !== (value ?? ""))) (changes[group] ||= {})[field.control.name] = value;
        }
        if (captured.has("quantity")) { const value = editor.quantity.read(); if (selected.some(item => item.quantity !== value)) changes.quantity = value; }
        for (const entry of editor.lengths || []) if (captured.has(entry.key)) {
          const length = entry.field.read();
          if (!(length > 0) || length > 1e12) throw new Error("Length per member (m): enter a positive finite length.");
          const current = items().filter(item => isCount(item) && item.member_ids.some(id => entry.memberIds.includes(id)));
          if (entry.memberIds.some(id => !current.some(item => item.member_ids.includes(id)))) throw new Error("A count member changed. Select its current row again.");
          if (current.some(item => item.measurement.length_m !== length)) lengthChanges.push({ member_ids: [...entry.memberIds], length_m: length });
        }
        const guard = () => {
          if (state.settingsEditor !== editor || editor.sessionId !== state.session?.session_id || editor.key !== settingsSelectionKey()) throw new Error("The project or selection changed before settings could update.");
          return true;
        };
        // Capture values before either request; edits arriving while it runs
        // retain their revisions and are sent by the following loop iteration.
        if (Object.keys(changes).length) await command("bulk_update", { item_ids: selected.map(item => item.id), changes }, guard);
        if (lengthChanges.length) await command("update_count_lengths", { groups: lengthChanges }, guard);
        if (state.settingsEditor !== editor) return;
        for (const [key, revision] of captured) if (editor.touched.get(key) === revision) editor.touched.delete(key);
        state.settingsDirty = editor.touched.size > 0;
      }
    });
    editor.applying = run;
    try {
      await run;
      if (state.settingsEditor === editor) {
        state.settingsDirty = editor.touched.size > 0;
        // Preserve controls/focus during ordinary typing. Length regrouping
        // is refreshed after this edit settles so quantities remain truthful.
        const countRows = settingsSelectedItems().filter(item => isCount(item) && !isStandalone(item));
        if (countRows.length !== editor.lengths.length || editor.lengths.some(entry => !countRows.some(item => item.id === entry.itemId && JSON.stringify(item.member_ids) === JSON.stringify(entry.memberIds)))) editor.revision = -1;
        else {
          editor.revision = state.session.revision;
          for (const entry of editor.lengths) {
            const item = countRows.find(value => value.id === entry.itemId), summary = state.ui.settingsPanel?.querySelector?.(`[data-item-id="${entry.itemId}"] p`), result = itemResult(item);
            if (summary) summary.textContent = `${item.quantity} markers · Manual base: ${formatLength(item.measurement.length_m)} m each${result.additions_length_m ? ` + additions: ${formatLength(result.additions_length_m)} m each` : ""} · Total: ${formatLength(result.total_length_m)} m`;
          }
        }
        window.CeasefireProject?.changed?.(); message("Settings updated.");
      }
    } finally {
      editor.applying = null;
      if (!editor.touched.size) { clearTimeout(editor.timer); editor.timer = null; }
      if (state.settingsEditor === editor) renderSettingsPanel();
    }
  }
  async function changeCountLength(item) {
    requireFinishedEdits(); const current = items().find(value => value.id === item.id);
    if (!isCount(current)) throw new Error("This count group changed. Select its current row.");
    const revision = state.session.revision;
    const data = await ask("Change counted member length", [["length_m", "Length per member (m)", "number", current.measurement.length_m, true]], "This changes every marker in this length group. Equal lengths in this Count combine into one row. Review and existing calculator links become stale; calculator inputs are preserved until an explicit update.", "Apply length", controls => { controls[0].control.min = "0.000000001"; controls[0].control.max = "1000000000000"; });
    if (!data) return;
    if (state.session.revision !== revision || !items().some(value => value.id === item.id)) throw new Error("The count changed during length review. Repeat the change.");
    if (!(data.length_m > 0) || data.length_m > 1e12) throw new Error("Enter a positive finite manual length.");
    await command("update_item", { item_id: item.id, changes: { measurement: { method: "manual", length_m: data.length_m } } });
    state.settingsEditor = null; renderSelection();
  }
  function renderViewportPanel() {
    const panel = state.ui?.viewportPanel; if (!panel) return;
    panel.hidden = !state.viewportsOpen; state.ui.layout.classList.toggle("with-viewports", !!state.viewportsOpen);
    state.ui.tools.viewport.setAttribute("aria-expanded", String(!!state.viewportsOpen));
    state.ui.tools.viewport.classList.toggle("takeoff-tool-active", !!state.viewportsOpen);
    if (!state.viewportsOpen) return;
    const viewports = activePageCalibrations().filter(value => value.region);
    if (!viewports.some(value => value.id === state.viewportSelection)) state.viewportSelection = "";
    const heading = node("div", "takeoff-viewports-heading"); heading.append(button("Close viewports", toggleViewportPanel), node("h3", "", "Viewports"));
    const list = node("div", "takeoff-viewport-list"); list.setAttribute("aria-label", "Viewports on this page");
    for (const viewport of viewports) {
      const row = node("div", `takeoff-viewport-row${viewport.id === state.viewportSelection ? " selected" : ""}`); row.dataset.calibrationId = viewport.id;
      const name = button(viewport.name, () => selectViewport(viewport.id), "takeoff-viewport-name"); name.title = viewport.name; name.setAttribute("aria-label", `Select viewport ${viewport.name}`); name.setAttribute("aria-pressed", String(viewport.id === state.viewportSelection));
      const scale = select([["manual", viewport.scale_denominator ? "Calibrate a known dimension" : "Custom scale"], ...scaleDenominators.map(value => [String(value), `1:${value}`])], value => changeViewportScale(viewport.id, value), viewport.scale_denominator ? String(viewport.scale_denominator) : "manual"); scale.setAttribute("aria-label", `Scale for viewport ${viewport.name}`);
      const more = button("⋯", () => editViewport(viewport.id), "takeoff-viewport-more"); more.setAttribute("aria-label", `Edit viewport ${viewport.name}`); more.title = `Edit viewport ${viewport.name}`;
      for (const control of [name, scale, more]) control.disabled = state.busy;
      row.append(name, scale, more); list.append(row);
    }
    if (!viewports.length) list.append(node("p", "helper", "No viewports on this page. Add a viewport around a detail with its own scale."));
    const actions = node("div", "takeoff-viewport-actions"), add = button("Add viewport", () => { requireFinishedEdits(); setTool("viewport"); }), remove = button("Delete viewport", deleteViewport);
    add.disabled = state.busy || !state.viewport; remove.disabled = state.busy || !state.viewportSelection;
    actions.append(add, remove); panel.replaceChildren(heading, list, actions);
  }
  function currentViewport(id) {
    const value = activePageCalibrations().find(value => value.id === id && value.region);
    if (!value) throw new Error("This viewport changed or belongs to another page. Select its current row.");
    return value;
  }
  function selectViewport(id) {
    requireFinishedEdits(); const value = currentViewport(id);
    state.viewportSelection = value.id; state.calibration = value.id; renderCalibrations(); renderOverlay();
  }
  async function changeViewportScale(id, value) {
    try {
      requireFinishedEdits(); const viewport = currentViewport(id);
      if (value === "manual") {
        state.calibration = viewport.id; state.viewportSelection = viewport.id;
        setTool("calibrate", { viewportId: viewport.id });
        message(`Click both ends of a known dimension inside ${viewport.name}.`); return;
      }
      if (Number(value) === viewport.scale_denominator) return;
      await chooseCalibration(`scale:${value}`, viewport.id);
    } finally { renderCalibrations(); }
  }
  async function editViewport(id) {
    requireFinishedEdits(); const viewport = currentViewport(id);
    const value = await ask("Edit viewport", [["name", "Viewport name", "text", viewport.name, true]], "Rename this page detail. Its original revision is retained, and dependent items become unconfirmed. To change its scale, use the dropdown in its row.", "Apply viewport edits");
    if (!value || value.name === viewport.name) return;
    currentViewport(id);
    const reply = await command("update_calibration", { calibration_id: id, changes: { name: value.name } });
    state.calibration = reply.revised_calibration_id; state.viewportSelection = state.calibration; renderCalibrations(); renderOverlay();
  }
  async function deleteViewport() {
    requireFinishedEdits(); const viewport = currentViewport(state.viewportSelection);
    const count = items().filter(item => item.measurement?.calibration_id === viewport.id).length;
    if (!await confirm(`Delete viewport ${viewport.name}?`, `${count} directly linked items will lose their usable scale. Affected items must be assigned an applicable calibration and confirmed again. Existing calculator row values are preserved, but their source links become stale. The original viewport and audit history are retained; Undo can restore the operation.`, "Delete viewport")) return;
    currentViewport(viewport.id);
    await command("delete_viewport", { calibration_id: viewport.id });
    if (state.calibration === viewport.id) state.calibration = "";
    state.viewportSelection = ""; renderCalibrations(); renderOverlay();
  }
  async function chooseCalibration(value, targetId = state.calibration) {
    try {
      requireFinishedEdits();
      if (!value.startsWith("scale:")) { if (value && !activePageCalibrations().some(entry => entry.id === value)) throw new Error("Choose a current calibration for this page."); state.calibration = value; renderOverlay(); return; }
      if (!state.viewport) throw new Error("Open a successfully rendered page before applying a scale.");
      const denominator = Number(value.slice(6)), existing = activePageCalibrations().find(entry => entry.id === targetId);
      if (targetId && !existing) throw new Error("The selected calibration changed. Select its current revision.");
      const scope = existing?.region ? `viewport ${existing.name}` : "this page";
      if (!await confirm(`Apply drawing scale 1:${denominator}?`, `Apply 1:${denominator} to ${scope}. This uses the PDF's original physical sheet dimensions, including its UserUnit. Use only an original-size, uniformly scaled drawing. If the PDF was resized or scanned, calibrate a known dimension instead. Existing dependent confirmations will be invalidated.`, "Apply scale")) return;
      if (existing) {
        const reply = await command("update_calibration", { calibration_id: existing.id, changes: { scale_denominator: denominator, uniform_scale: true } });
        state.calibration = reply.revised_calibration_id;
      } else {
        const [x0, y0, x1] = pageMetadata().view, id = uuid();
        await command("add_calibration", { calibration: { id, document_id: state.document, page: state.page, name: `Page ${state.page} scale`, points: [[x0, y0], [x1, y0]], scale_denominator: denominator, uniform_scale: true } });
        state.calibration = id;
      }
      renderOverlay();
    } finally { renderCalibrations(); }
  }
  async function createViewport() {
    if (state.points.length !== 2) throw new Error("Choose two opposite corners of the rectangular viewport before finishing.");
    const region = G.region(...state.points);
    if (!(region[2] > 0 && region[3] > 0)) throw new Error("Select two opposite corners of a nonzero viewport.");
    const details = await ask("Create viewport", [["name", "Viewport name", "text", "", true], ["scale", "Scale", [["manual", "Calibrate a known dimension"], ...scaleDenominators.map(value => [String(value), `1:${value}`])], "", true]], "This rectangular detail has its own scale. Viewports cannot overlap. Preset scales assume an original-size, uniformly scaled PDF; use a known dimension for resized sheets or scans.", "Create viewport");
    if (!details) return cancelTrace();
    const docId = state.document, page = state.page;
    if (details.scale === "manual") {
      state.points = []; state.pendingViewport = { region, name: details.name, document_id: docId, page };
      setTool("calibrate"); renderOverlay(); return;
    }
    const id = uuid(), [x, y, width] = region;
    await command("add_calibration", { calibration: { id, document_id: docId, page, name: details.name, points: [[x, y], [x + width, y]], region, scale_denominator: Number(details.scale), uniform_scale: true } });
    state.calibration = id; state.viewportSelection = id; cancelTrace(); renderCalibrations();
  }
  function renderRail() {
    const key = JSON.stringify([state.session?.session_id, documents().map(doc => [doc.id, doc.name, doc.pages.length, doc.size]), state.document, state.page]);
    if (state.railKey !== key) {
      state.railKey = key;
      const choices = documents().map(doc => { const el = option(doc.id, `${doc.name} · ${doc.pages.length} pages`); el.className = "takeoff-document"; el.setAttribute("aria-selected", String(doc.id === state.document)); return el; });
      state.ui.documentSelect.replaceChildren(...(choices.length ? choices : [option("", "No PDFs uploaded")]));
      const sources = documents().map(doc => { const el = button(doc.name, () => navigateDocument(doc.id), "takeoff-source-document"); el.dataset.documentId = doc.id; if (doc.id === state.document) el.setAttribute("aria-current", "true"); el.append(node("small", "", `${doc.pages.length} pages · ${units.format(doc.size / 1048576)} MiB`)); return el; });
      state.ui.sourceDocumentList.replaceChildren(...(sources.length ? sources : [node("p", "helper", "No PDFs uploaded")]));
    }
    state.ui.documentSelect.value = state.document || ""; state.ui.documentSelect.disabled = !documents().length;
    state.ui.documentSelect.title = currentDocument() ? `${currentDocument().name} · ${currentDocument().pages.length} pages · ${units.format(currentDocument().size / 1048576)} MiB` : "Upload a PDF to choose a drawing document";
    state.ui.removeDocument.disabled = !currentDocument();
  }
  async function navigateDocument(id, page = 1) { if (state.busy || !await discardEditor()) return false; resetPlanInteraction(); state.document = id; state.page = page; state.calibration = ""; renderRail(); renderCalibrations(); await renderPage(); return true; }
  async function navigatePage(page) { const doc = currentDocument(); if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages.length) throw new Error("Choose a page within this document."); if (!await discardEditor()) return; resetPlanInteraction(); state.page = page; state.calibration = ""; renderRail(); renderCalibrations(); await renderPage(); }
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
      clearPdfTextLayer(); cancelQueuedZoom(); state.displayPage = null; state.displayKey = null; state.viewport = null; state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false;
      state.ui.empty.replaceChildren(node("strong", "", "Drawing unavailable"), node("p", "", error.message));
      setProgress(`Page ${page} blocked: ${error.message}`);
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
  async function releaseDocuments() { clearPdfTextLayer(); cancelQueuedZoom(); state.displayPage = null; state.displayKey = null; const tasks = [...state.pdfs.values()]; state.pdfs.clear(); state.pdfLoads.clear(); for (const task of state.thumbnailTasks.values()) task.cancel(); state.thumbnailTasks.clear(); state.thumbnailPages.clear(); state.pdfWarnings.clear(); state.consoleRestore?.(); await Promise.allSettled(tasks.map(task => task.destroy())); }
  async function autoCalibratePage(docId, page, sessionId, renderId) {
    const key = JSON.stringify([sessionId, docId, page]);
    state.autoScalePages ||= new Set();
    if (state.autoScalePages.has(key)) return;
    const task = state.queue.then(async () => {
      if (sessionId !== state.session?.session_id || renderId !== state.renderId || docId !== state.document || page !== state.page) return;
      if (activePageCalibrations().length) { state.autoScalePages.add(key); return; }
      working(true);
      try {
        const reply = await api(`/sessions/${sessionId}/auto-calibrate`, { expected_revision: state.session.revision, request_id: uuid(), document_id: docId, page });
        if (sessionId !== state.session?.session_id) return;
        accept(reply); state.autoScalePages.add(key);
        if (renderId === state.renderId && reply.auto_calibration?.status === "applied") {
          state.calibration = reply.auto_calibration.calibration_id;
          message("Page scale set from the PDF title block. Use Scale to review or change it.");
        }
        renderData();
      } finally { working(false); }
    });
    state.queue = task.catch(() => {});
    try { await task; } catch (error) {
      // Scale detection must not turn a successfully rendered page into a PDF failure.
      if (sessionId === state.session?.session_id && renderId === state.renderId) message(`Automatic scale could not be set. Use Scale to calibrate this page. ${error.message}`, true);
    }
  }
  function pageDisplayKey() { return JSON.stringify([state.session?.session_id, state.document, state.page]); }
  function cancelQueuedZoom() {
    if (state.zoomFrame != null) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(state.zoomFrame); else clearTimeout(state.zoomFrame); }
    clearTimeout(state.zoomTimer); state.zoomFrame = null; state.zoomTimer = null;
  }
  function displayViewport(viewport, anchor) {
    state.viewport = viewport;
    // Keep the last verified bitmap visible while PDF.js refines its resolution.
    // The paper and overlay always use the same displayed PDF transform.
    state.ui.canvas.style.width = `${viewport.width}px`; state.ui.canvas.style.height = `${viewport.height}px`;
    state.ui.overlay.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    state.ui.overlay.setAttribute("width", String(viewport.width)); state.ui.overlay.setAttribute("height", String(viewport.height));
    positionPdfTextLayer(viewport);
    if (anchor) { const point = G.transform(anchor.point, viewport.transform); positionPage(anchor.offset[0] - point[0], anchor.offset[1] - point[1]); }
    else positionPage(Math.max(24, (state.ui.viewport.clientWidth - viewport.width) / 2), Math.max(24, (state.ui.viewport.clientHeight - viewport.height) / 2));
    state.ui.zoom.textContent = `${Math.round(state.zoom * 100)}%`; renderOverlay();
  }
  function clearPdfTextSelection() {
    const selection = window.getSelection?.(), container = state.pdfText?.container;
    if (container && (container.contains(selection?.anchorNode) || container.contains(selection?.focusNode))) selection.removeAllRanges();
  }
  function clearPdfTextLayer() {
    clearPdfTextSelection(); state.pdfTextGeneration = (state.pdfTextGeneration || 0) + 1;
    state.pdfText?.task?.cancel(); state.pdfText?.container?.remove(); state.pdfText = null;
  }
  function positionPdfTextLayer(viewport = state.viewport) {
    const text = state.pdfText;
    if (!text?.container || !viewport || text.key !== state.displayKey) return;
    // PDF.js text spans use unrotated, top-left page coordinates. Compose that
    // basis with the exact bitmap transform, including CropBox and UserUnit.
    // Scaling this one container keeps native selections intact during zoom.
    const { pageX, pageY, pageWidth, pageHeight } = text.dims, [a, b, c, d, e, f] = viewport.transform;
    text.container.style.width = `${pageWidth}px`; text.container.style.height = `${pageHeight}px`;
    text.container.style.transform = `matrix(${a},${b},${-c},${-d},${a * pageX + c * (pageY + pageHeight) + e},${b * pageX + d * (pageY + pageHeight) + f})`;
  }
  function pdfTextProgress() {
    if (state.tool !== "text") return;
    const text = state.pdfText;
    setProgress(text?.status === "empty" ? "This page has no selectable PDF text. Image-only pages cannot be copied as text."
      : text?.status === "error" ? "PDF text selection is unavailable on this page. The original drawing remains visible."
      : text?.status === "ready" ? "Drag over PDF text to select it, then press Ctrl+C to copy (⌘C on Mac)."
      : "Loading selectable PDF text…");
  }
  async function ensurePdfTextLayer() {
    if (!state.ui || !state.displayPage || !state.viewport || state.displayKey !== pageDisplayKey()) return;
    const key = state.displayKey;
    if (state.pdfText?.key === key) { positionPdfTextLayer(); pdfTextProgress(); return state.pdfText.promise; }
    clearPdfTextLayer();
    const generation = state.pdfTextGeneration, page = state.displayPage;
    const text = state.pdfText = { key, status: "loading", dims: page.getViewport({ scale: 1, rotation: 0 }).rawDims };
    const current = () => generation === state.pdfTextGeneration && state.pdfText === text && key === state.displayKey && key === pageDisplayKey();
    pdfTextProgress();
    text.promise = (async () => {
      try {
        const lib = await pdfLibrary(); if (!current()) return;
        const content = await boundedPdf(page.getTextContent(), "Reading selectable PDF text", () => text.task?.cancel());
        if (!current()) return;
        const container = text.container = node("div", "takeoff-text-layer"); container.setAttribute("aria-label", "Original PDF text");
        const task = text.task = new lib.TextLayer({ textContentSource: content, container, viewport: page.getViewport({ scale: 1, rotation: 0 }) });
        await boundedPdf(task.render(), "Preparing selectable PDF text", () => task.cancel());
        if (!current()) { task.cancel(); return; }
        text.status = content.items.some(item => item.str?.trim()) ? "ready" : "empty";
        container.dataset.textState = text.status; positionPdfTextLayer(); state.ui.pageWrap.append(container); pdfTextProgress();
      } catch (error) {
        if (!current()) return;
        text.task?.cancel(); text.container?.remove(); text.container = null; text.status = "error"; pdfTextProgress();
      }
    })();
    return text.promise;
  }
  async function renderPage(anchor = null, { refine = false } = {}) {
    cancelQueuedZoom();
    if (!state.ui || !state.document) { clearPdfTextLayer(); ++state.renderId; state.pending?.cancel?.(); state.pending = null; state.displayPage = null; state.displayKey = null; state.viewport = null; if (state.ui) { state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false; } return; }
    const contextKey = JSON.stringify([state.session?.session_id, state.document, state.page, state.mode]);
    if (state.planContextKey !== contextKey) { resetPlanInteraction(); state.planContextKey = contextKey; }
    const renderId = ++state.renderId, docId = state.document, pageNumber = state.page, sessionId = state.session.session_id, displayKey = pageDisplayKey(), zoom = state.zoom;
    const retainDisplay = refine && state.displayKey === displayKey && !!state.viewport;
    state.ui.page.value = String(pageNumber); state.ui.pageCount.textContent = `/ ${currentDocument().pages.length}`; setProgress(`Rendering ${currentDocument().name}, page ${pageNumber}…`);
    state.zoomAnchor = anchor;
    if (!retainDisplay) { clearPdfTextLayer(); state.viewport = null; state.displayPage = null; state.displayKey = null; if (!anchor) state.ui.pageWrap.hidden = true; state.ui.overlay.replaceChildren(); }
    state.ui.empty.hidden = true;
    state.pending?.cancel?.(); state.pending = null;
    for (const task of state.thumbnailTasks.values()) task.cancel(); state.thumbnailTasks.clear();
    try {
      const pdf = await pdfDocument(docId), page = await pdfPage(pdf, docId, pageNumber, sessionId);
      if (renderId !== state.renderId) return;
      const viewport = page.getViewport({ scale: zoom });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 16384 / Math.max(viewport.width, viewport.height), Math.sqrt(16000000 / (viewport.width * viewport.height)));
      if (!(ratio > 0) || viewport.width > 40000 || viewport.height > 40000) throw new Error("This zoom is too large to display safely. Use Fit page.");
      const canvas = node("canvas"); canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio)); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute("aria-label", "Original PDF page");
      const render = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }); state.pending = render;
      await boundedPdf(render.promise, `Rendering PDF page ${pageNumber}`, () => { render.cancel(); discardPdf(docId, sessionId, pdf); }); if (renderId !== state.renderId || sessionId !== state.session?.session_id) return;
      state.ui.canvas.replaceWith(canvas); state.ui.canvas = canvas; state.viewport = viewport; state.displayPage = page; state.displayKey = displayKey; state.ui.overlay.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`); state.ui.overlay.setAttribute("width", String(viewport.width)); state.ui.overlay.setAttribute("height", String(viewport.height));
      state.ui.pageWrap.hidden = false;
      positionPdfTextLayer(viewport);
      if (retainDisplay) {
        // Panning/scrolling while the new bitmap renders must not snap back to
        // the position at which that render started. Its CSS size is unchanged.
      } else if (anchor) {
        const position = G.transform(anchor.point, viewport.transform);
        positionPage(anchor.offset[0] - position[0], anchor.offset[1] - position[1]);
      } else positionPage(Math.max(24, (state.ui.viewport.clientWidth - viewport.width) / 2), Math.max(24, (state.ui.viewport.clientHeight - viewport.height) / 2));
      state.ui.zoom.textContent = `${Math.round(state.zoom * 100)}%`; setProgress(`${currentDocument().name} · Page ${pageNumber} · Original source`); renderOverlay();
      const warnings = documentWarnings(docId);
      const previous = snapshot()?.render_checks?.find(check => check.document_id === docId && check.page === pageNumber);
      const alreadyVerified = retainDisplay && !warnings.length && previous?.success === true && !previous.warnings.length && previous.sha256 === documentById(docId)?.sha256;
      if (!alreadyVerified) await command("record_render", { document_id: docId, page: pageNumber, success: warnings.length === 0, warnings }, () => renderId === state.renderId);
      if (warnings.length) message(`PDF content could not be verified. Review and confirmation are blocked. ${warnings.join(" ")}`, true);
      else if (state.pageError?.document_id === docId && state.pageError.page === pageNumber) { if (state.ui.message.textContent === state.pageError.notice) message(); state.pageError = null; }
      if (!warnings.length) await autoCalibratePage(docId, pageNumber, sessionId, renderId);
      if (renderId === state.renderId && state.tool === "text") void ensurePdfTextLayer();
      void renderThumbnails(pdf, renderId, docId);
    } catch (error) {
      if (renderId !== state.renderId || error.name === "RenderingCancelledException") return;
      await recordPdfFailure(docId, pageNumber, error, sessionId, true, () => renderId === state.renderId);
    } finally { if (renderId === state.renderId) { state.pending = null; state.zoomAnchor = null; } }
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
  async function fitPage(snapToHeader = false) {
    if (state.gesture) throw new Error("Finish or cancel the current selection or move before fitting the page.");
    // Only the explicit Fit page action scrolls the browser. Automatic fits
    // after uploads keep the user's current position in the workspace.
    if (snapToHeader) revealDrawingPanel(state.ui.viewport, false, 0);
    if (!state.document) return; const docId = state.document, pageNumber = state.page, sessionId = state.session?.session_id, renderId = state.renderId, fitId = state.fitId = (state.fitId || 0) + 1;
    const current = () => fitId === state.fitId && renderId === state.renderId;
    try {
      const pdf = await pdfDocument(docId), page = await pdfPage(pdf, docId, pageNumber, sessionId), viewport = page.getViewport({ scale: 1 });
      if (!current() || docId !== state.document || pageNumber !== state.page || sessionId !== state.session?.session_id) return;
      const gutter = Math.max(25, (state.ui.viewerTop?.offsetHeight || 0) + 20, (state.ui.pageControls?.offsetHeight || 0) + 20);
      state.zoom = Math.max(0.05, Math.min((state.ui.viewport.clientWidth - 50) / viewport.width, Math.max(50, state.ui.viewport.clientHeight - gutter * 2) / viewport.height));
      if (state.displayKey === pageDisplayKey() && state.viewport) { cancelQueuedZoom(); displayViewport(page.getViewport({ scale: state.zoom }), null); await renderPage(null, { refine: true }); }
      else await renderPage();
    } catch (error) { await recordPdfFailure(docId, pageNumber, error, sessionId, true, current); }
  }
  async function zoomBy(factor, cursor) {
    if (state.gesture) return;
    if (!state.document || !Number.isFinite(factor) || factor <= 0) return;
    let anchor = state.zoomAnchor;
    if (state.viewport) {
      const frame = state.ui.viewport.getBoundingClientRect();
      const screen = cursor || [frame.left + state.ui.viewport.clientWidth / 2, frame.top + state.ui.viewport.clientHeight / 2];
      anchor = { point: drawingPoint({ clientX: screen[0], clientY: screen[1] }), offset: [screen[0] - frame.left - (state.ui.viewport.clientLeft || 0), screen[1] - frame.top - (state.ui.viewport.clientTop || 0)] };
    }
    if (!anchor) return;
    const zoom = Math.max(0.05, Math.min(8, state.zoom * factor));
    if (zoom === state.zoom) return;
    state.panCleanup?.();
    if (!state.displayPage || state.displayKey !== pageDisplayKey()) { state.zoom = zoom; await renderPage(anchor); return; }
    const viewport = state.displayPage.getViewport({ scale: zoom });
    if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0 && value <= 40000)) return;
    state.zoom = zoom; state.zoomAnchor = anchor;
    // Invalidate an older refinement immediately, before the next animation
    // frame. Rapid wheel/pinch events share one preview and one settled render.
    ++state.renderId; state.pending?.cancel?.(); state.pending = null; clearTimeout(state.zoomTimer);
    if (state.zoomFrame != null) return;
    const key = state.displayKey;
    const preview = () => {
      state.zoomFrame = null;
      if (key !== pageDisplayKey() || key !== state.displayKey || !state.displayPage) return;
      displayViewport(state.displayPage.getViewport({ scale: state.zoom }), state.zoomAnchor); state.zoomAnchor = null;
      state.zoomTimer = setTimeout(() => { state.zoomTimer = null; if (key === pageDisplayKey() && key === state.displayKey) void safely(() => renderPage(null, { refine: true })); }, 120);
    };
    state.zoomFrame = window.requestAnimationFrame ? window.requestAnimationFrame(preview) : setTimeout(preview, 0);
  }
  function setTool(tool, target = {}) {
    if (state.busy) return;
    if (state.modal || state.countFinishing || state.physicalPlacing) throw new Error("Finish the current count or dialog first.");
    if (tool === "count-only" && !["steel", "duct"].includes(state.mode)) throw new Error("Count-only items belong to Steel or Duct.");
    if (tool === "measure" && !isArea()) throw new Error("Length measurements belong to Walls or Slabs.");
    if (tool === "count" && !["steel", "physical"].includes(state.mode)) throw new Error("Count is available for steel members and penetration barriers.");
    if (tool === "count" && state.mode === "physical") { if (physicalGraph()?.version === 1) throw new Error("Legacy physical records remain read-only. Use Service Plans for new barrier markers."); if (physicalUnfinished()) throw new Error("Apply or discard unfinished physical edits before placing a marker."); }
    if (state.gesture) throw new Error("Finish or cancel the current selection or move first.");
    if (!state.viewport && tool !== "select" && tool !== "pan") throw new Error("Open a successfully rendered page first.");
    if (state.points.length) throw new Error("Finish or cancel the current trace first.");
    if (state.mode === "physical" && !["select", "pan", "text", "calibrate", "viewport", "count"].includes(tool)) throw new Error("Physical drafts use count markers and retained source regions. Length and area measurement tools belong to the other takeoff modes.");
    if (isArea() && ["trace", "cite"].includes(tool) || !isArea() && ["polygon", "exclusion"].includes(tool)) throw new Error("Choose a drawing tool for the current takeoff mode.");
    if (!["select", "pan", "text"].includes(tool) && (state.formDirty || state.settingsDirty)) throw new Error("Apply or discard the unfinished item edits or settings before using a drawing tool.");
    if (["trace", "measure", "polygon"].includes(tool) && !state.calibration && !activePageCalibrations().length) throw new Error("Choose or create the applicable calibration before tracing.");
    if (state.pendingViewport && tool !== "calibrate") throw new Error("Calibrate or cancel the unfinished viewport first.");
    if (tool === "exclusion" && !target.exclusionItemId) throw new Error("Select one surface before adding an exclusion.");
    state.controlPoint = null; state.controlMenu = false; state.markupMenu = null; state.traceCursor = null; state.retraceId = target.retraceId || null; state.exclusionItemId = target.exclusionItemId || null; state.calibrationTarget = target.viewportId || null;
    if (tool !== "text") clearPdfTextSelection();
    state.physicalPlacementTarget = null; state.tool = tool; state.doubleClickEndpointValid = false; state.ui.viewport.dataset.tool = tool;
    if (tool === "calibrate" && state.ui.scaleControls) toggleScaleControls(false);
    if (["count", "count-only"].includes(tool)) { resetCountDraft(); state.settingsOpen = false; state.settingsEditor = null; state.viewportsOpen = false; renderSettingsPanel(); renderViewportPanel(); }
    for (const el of state.ui.root.querySelectorAll("[data-tool]")) if (el.tagName === "BUTTON") el.classList.toggle("takeoff-tool-active", el.dataset.tool === tool);
    // Select-only handles must not intercept the first pan or trace pointer.
    renderOverlay();
    state.ui.viewport.focus();
    setProgress(({ "count-only": "Click once for each item. Double-click or Enter finishes the count. These counts stay in this register.", measure: "Click along the length, then double-click or Enter to finish the measurement.", count: "Click once for each steel member and enter its length manually. Double-click or Enter finishes without adding a marker. All members in this count share the same details; start another Count for different details. Right-click cancels the unfinished count.", viewport: "Click the first corner, then double-click the opposite corner to finish a rectangular viewport and choose its scale. A single click adjusts the opposite corner; Enter finishes two chosen corners. Right-click cancels; Backspace removes the last corner.", calibrate: state.pendingViewport || state.calibrationTarget ? "Click both endpoints of a known dimension inside the selected viewport." : "Click the two endpoints of a known distance on this drawing.", trace: "Click each vertex along one object. Double-click or Enter completes it. Right-click cancels; Backspace removes the last point.", polygon: `${surfaceHelp} Click each boundary vertex, then double-click or Enter. The final edge closes automatically.`, exclusion: "Trace the excluded opening strictly inside the selected surface. Double-click or Enter closes the boundary.", cite: "Click opposite corners around the source dimension or schedule entry. Enter its stated length next.", pan: "Drag the drawing to pan.", select: "Select a markup or register row to view its source and edit it in the register." })[tool] || "");
    if (tool === "count" && state.mode === "physical") setProgress("Click the drawing to place one barrier marker. Enter or select its substrate details, then add its services in Item Details. Each marker's callout updates from those records; drawing scale does not change service quantities.");
    if (tool === "text") void ensurePdfTextLayer();
  }
  function cancelTrace() { clearPdfTextSelection(); state.physicalPlacementTarget = null; cancelSelectionGesture(); resetCountDraft(); state.pendingViewport = null; state.calibrationTarget = null; state.retraceId = null; state.exclusionItemId = null; state.points = []; state.traceCursor = null; state.markupMenu = null; state.doubleClickEndpointValid = false; state.tool = "select"; if (state.ui) { state.ui.viewport.dataset.tool = "select"; for (const el of state.ui.root?.querySelectorAll("button[data-tool]") || []) el.classList.toggle("takeoff-tool-active", el.dataset.tool === "select"); renderOverlay(); } window.CeasefireProject?.changed?.(); }
  function resetCountDraft() {
    for (const entry of state.countEntries) clearTimeout(entry.timer);
    state.countGeneration++; state.countEntries = []; state.countDefaultLength = null; state.countLastClick = null; state.countFinishing = false; state.countQueue = Promise.resolve(); state.countContinuation = null;
  }
  function refreshCountDraft() { state.points = state.countEntries.map(entry => entry.point); renderOverlay(); window.CeasefireProject?.changed?.(); }
  function removePendingCount(entry) {
    clearTimeout(entry?.timer); state.countEntries = state.countEntries.filter(value => value !== entry);
    if (state.tool === "count-only") { state.countLastClick = null; state.traceCursor = null; state.doubleClickEndpointValid = false; }
    refreshCountDraft();
  }
  function currentCountEntry(entry) { return entry.generation === state.countGeneration && state.tool === "count" && entry.sessionId === state.session?.session_id && entry.documentId === state.document && entry.page === state.page && state.countEntries.includes(entry); }
  function queueCountLength(entry) {
    clearTimeout(entry.timer);
    const task = state.countQueue.then(async () => {
      if (!currentCountEntry(entry) || entry.length_m != null) return;
      if (state.countDefaultLength != null) { entry.length_m = state.countDefaultLength; refreshCountDraft(); return; }
      const revision = state.session?.revision;
      const data = await ask("Counted member length", [["length_m", "Length per member (m)", "number", "", true], ["reuse", "Use this length for additional counts", "checkbox", false]], "Enter the real member length. Marker positions and drawing scale never calculate this length.", "Place marker", controls => { controls[0].control.min = "0.000000001"; controls[0].control.max = "1000000000000"; });
      if (!currentCountEntry(entry)) return;
      if (revision !== state.session?.revision) throw new Error("The count changed during length entry. Cancel and restart this count.");
      if (!data) { removePendingCount(entry); return; }
      if (!(data.length_m > 0) || data.length_m > 1e12) throw new Error("Enter a positive finite length no greater than 1,000,000,000,000 metres.");
      entry.length_m = data.length_m; state.countDefaultLength = data.reuse ? data.length_m : null; refreshCountDraft();
    });
    state.countQueue = task.catch(error => { message(error.message, true); }); return task;
  }
  function stageCountMarker(point, event) {
    if (state.countFinishing) return;
    if (state.countEntries.length >= 10000) throw new Error("A count supports at most 10,000 markers.");
    const entry = { point: [...point], length_m: state.countDefaultLength, generation: state.countGeneration, sessionId: state.session?.session_id, documentId: state.document, page: state.page, timeStamp: event.timeStamp, client: [event.clientX, event.clientY] };
    state.countEntries.push(entry); state.countLastClick = entry; refreshCountDraft();
    // A double-click finishes the count. Defer its first click's length dialog
    // so it can be removed without an extra marker or a modal stealing focus.
    entry.timer = setTimeout(() => { if (currentCountEntry(entry)) void safely(() => queueCountLength(entry)); }, 500);
  }
  async function finishCount() {
    if (state.countFinishing || state.busy || state.modal || state.tool !== "count") return;
    const generation = state.countGeneration; state.countFinishing = true;
    try {
      for (const entry of [...state.countEntries]) await queueCountLength(entry);
      if (generation !== state.countGeneration || state.tool !== "count") return;
      if (!state.countEntries.length) { cancelTrace(); return; }
      const markers = state.countEntries.map(entry => ({ point: [...entry.point], length_m: entry.length_m }));
      if (markers.some(entry => !(entry.length_m > 0) || !Number.isFinite(entry.length_m))) throw new Error("Every count marker requires a positive manual length.");
      const continuation = state.countContinuation;
      if (continuation) continuationTarget(continuation);
      const reply = continuation
        ? await command("continue_count", { item_id: continuation.itemId, markers }, () => { if (state.formDirty || state.settingsDirty || generation !== state.countGeneration) throw new Error("The count changed before it could finish."); continuationTarget(continuation); return true; })
        : await command("add_count_items", { document_id: state.document, page: state.page, markers, fields: {}, appearance: {} });
      cancelTrace(); state.countSelection.clear(); state.selected = new Set(reply.regrouped_item_ids || reply.created_item_ids); state.settingsOpen = true; state.settingsEditor = null; state.viewportsOpen = false; renderViewportPanel(); renderSelection();
      message(continuation ? "Count continued with the same details. Added markers are grouped by their manually entered lengths. Confirm changed rows before updating their linked schedules." : "Count recorded. Set the shared steel and fire-protection details in the panel. Different lengths have separate rows; marker quantity cannot be typed.");
    } finally { if (generation === state.countGeneration) state.countFinishing = false; }
  }
  function drawingPointer(event) {
    if (state.mode === "physical" && state.tool === "count" && event.detail > 1) return;
    // Re-rendering a hit shape after the first click can suppress the browser's
    // dblclick event. Its second click still carries detail=2 on the overlay.
    if (["count", "count-only", "viewport"].includes(state.tool) && event.detail === 2) { void safely(() => finishTraceFromDoubleClick(event)); return; }
    if (event.detail > 1) return;
    state.doubleClickEndpointValid = false;
    if (state.busy || state.modal || state.countFinishing || state.physicalPlacing || !state.viewport || !["calibrate", "trace", "measure", "count-only", "count", "cite", "polygon", "exclusion", "viewport"].includes(state.tool) || event.button !== 0) return;
    if (state.formDirty || state.settingsDirty) { message("Apply or discard the unfinished item edits or settings before continuing the drawing tool.", true); return; }
    if (["polygon", "exclusion"].includes(state.tool) && state.points.length >= areaTraceLimit()) { message("A surface supports at most 1,000 total vertices across its outer boundary and all exclusions. Finish or cancel this trace.", true); return; }
    event.preventDefault(); const rect = state.ui.overlay.getBoundingClientRect(); const p = G.inverse([(event.clientX - rect.left) * state.viewport.width / rect.width, (event.clientY - rect.top) * state.viewport.height / rect.height], state.viewport.transform);
    const view = pageMetadata()?.view; if (view && (p[0] < view[0] || p[1] < view[1] || p[0] > view[2] || p[1] > view[3])) return;
    if (state.tool === "count-only") { state.points.push(p); state.countEntries.push({ point: [...p] }); state.countLastClick = { timeStamp: event.timeStamp, client: [event.clientX, event.clientY] }; renderOverlay(); window.CeasefireProject?.changed?.(); return; }
    if (state.tool === "count") { void safely(() => state.mode === "physical" ? placePhysicalMarker(p) : stageCountMarker(p, event)); return; }
    if (state.pendingViewport && !inViewport(p, state.pendingViewport.region)) { message("Both calibration points must be inside the viewport.", true); return; }
    if (state.calibrationTarget) { const target = activePageCalibrations().find(value => value.id === state.calibrationTarget); if (!target?.region || !inViewport(p, target.region)) { message("Both calibration points must be inside the selected viewport.", true); return; } }
    if (state.tool === "viewport") {
      state.points = state.points.length ? [state.points[0], p] : [p];
      state.doubleClickEndpointValid = true; state.traceCursor = null;
      renderOverlay(); window.CeasefireProject?.changed?.(); return;
    }
    if (["trace", "measure", "polygon"].includes(state.tool) && !state.points.length && !state.retraceId) {
      const calibrations = activePageCalibrations(), scoped = calibrations.filter(value => value.region && inViewport(p, value.region));
      if (scoped.length > 1) { message("This point is on more than one viewport boundary. Start clearly inside one viewport.", true); return; }
      if (scoped.length) state.calibration = scoped[0].id;
      else if (!calibrations.some(value => value.id === state.calibration && !value.region)) {
        const pageScales = calibrations.filter(value => !value.region);
        if (pageScales.length !== 1) { message("Select the applicable page calibration before starting outside a viewport.", true); return; }
        state.calibration = pageScales[0].id;
      }
      renderCalibrations();
    }
    if (["trace", "measure", "polygon", "exclusion"].includes(state.tool)) {
      const calibration = (snapshot()?.calibrations || []).find(value => value.id === state.calibration);
      if (calibration?.region && !inViewport(p, calibration.region)) { message("This trace cannot leave its viewport. Split the object at the scale boundary.", true); return; }
      state.doubleClickEndpointValid = true;
      if (state.points.length && Math.hypot(p[0] - state.points.at(-1)[0], p[1] - state.points.at(-1)[1]) < 1e-8) return;
    }
    state.points.push(p); state.traceCursor = null; renderOverlay(); window.CeasefireProject?.changed?.();
    if (state.points.length === 2 && state.tool === "calibrate") void safely(addCalibration);
    else if (state.points.length === 2 && state.tool === "cite") void safely(finishCitation);
  }
  async function finishTraceFromDoubleClick(event) {
    if (state.mode === "physical" && state.tool === "count") return;
    if (state.tool === "count-only") {
      event.preventDefault(); if (state.busy || state.modal || state.countFinishing) return;
      const entry = state.countLastClick; if (entry && event.timeStamp - entry.timeStamp <= 700 && Math.hypot(event.clientX - entry.client[0], event.clientY - entry.client[1]) < 5) { state.points.pop(); state.countEntries.pop(); }
      state.countLastClick = null; await finishStandaloneCount(); return;
    }
    if (state.tool === "count") {
      event.preventDefault(); if (state.busy || state.modal || state.countFinishing) return;
      const entry = state.countLastClick;
      if (entry && currentCountEntry(entry) && event.timeStamp - entry.timeStamp <= 700 && Math.hypot(event.clientX - entry.client[0], event.clientY - entry.client[1]) < 5) removePendingCount(entry);
      state.countLastClick = null; await finishCount(); return;
    }
    if (!["trace", "measure", "polygon", "exclusion", "viewport"].includes(state.tool)) return;
    event.preventDefault();
    if (!state.doubleClickEndpointValid || state.busy || state.modal || !state.viewport) return;
    state.doubleClickEndpointValid = false;
    await finishTrace();
  }
  function positionPage(left, top) {
    if (!state.viewport || ![left, top].every(Number.isFinite)) return;
    const { viewport: frame, panSpace, pageWrap } = state.ui;
    // Rebase the scrollable workspace around the requested screen position.
    // Page coordinates and PDF transforms never change when the paper is panned.
    const x = Math.max(frame.clientWidth, left + frame.clientWidth), y = Math.max(frame.clientHeight, top + frame.clientHeight);
    panSpace.style.width = `${Math.max(x + state.viewport.width + frame.clientWidth, x - left + frame.clientWidth * 2)}px`;
    panSpace.style.height = `${Math.max(y + state.viewport.height + frame.clientHeight, y - top + frame.clientHeight * 2)}px`;
    pageWrap.style.left = `${x}px`; pageWrap.style.top = `${y}px`;
    frame.scrollLeft = x - left; frame.scrollTop = y - top;
    // Browsers can quantize scroll offsets. Absorb the actual scroll remainder
    // in the paper position so sequential zoom frames retain the cursor anchor.
    pageWrap.style.left = `${left + frame.scrollLeft}px`; pageWrap.style.top = `${top + frame.scrollTop}px`;
  }
  function beginPan(event) {
    if (state.tool !== "pan" || event.button !== 0 || !state.viewport) return;
    state.panCleanup?.();
    event.preventDefault(); const element = state.ui.viewport, frame = element.getBoundingClientRect(), page = state.ui.pageWrap.getBoundingClientRect();
    const initial = [event.clientX, event.clientY, page.left - frame.left - element.clientLeft, page.top - frame.top - element.clientTop], displayKey = pageDisplayKey(), transform = JSON.stringify(state.viewport.transform);
    const move = next => { if (next.pointerId !== event.pointerId || displayKey !== pageDisplayKey() || transform !== JSON.stringify(state.viewport?.transform) || state.tool !== "pan") return; next.preventDefault(); positionPage(initial[2] + next.clientX - initial[0], initial[3] + next.clientY - initial[1]); };
    const done = next => { if (next && next.pointerId !== event.pointerId) return; element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", done); element.removeEventListener("pointercancel", done); element.removeEventListener("lostpointercapture", done); state.panCleanup = null; if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); };
    state.panCleanup = done; element.addEventListener("pointermove", move); element.addEventListener("pointerup", done); element.addEventListener("pointercancel", done); element.addEventListener("lostpointercapture", done); element.setPointerCapture(event.pointerId);
  }
  function drawableItems() {
    return visibleItems().filter(item => item.geometry && (item.measurement || item.purpose === "count-only") && !state.hidden.has(item.id) && item.geometry.document_id === state.document && item.geometry.page === state.page);
  }
  async function clearDrawingSelection() {
    const savingSurfaceSettings = isArea() && state.settingsEditor?.applying;
    if (state.tool !== "select" || state.busy && !savingSurfaceSettings || state.modal || state.gesture || state.physicalPlacing || !(state.selected.size || state.physicalSelected.size)) return;
    if (!await discardEditor()) return;
    state.selected.clear(); state.countSelection.clear(); state.controlPoint = null; state.controlMenu = false; state.markupMenu = null; state.hovered = null;
    if (state.mode === "physical") { await state.physicalUI?.clearSelection(); state.physicalHovered = null; }
    renderSelection();
  }
  function drawingPoint(event) {
    const rect = state.ui.overlay.getBoundingClientRect();
    return G.inverse([(event.clientX - rect.left) * state.viewport.width / rect.width, (event.clientY - rect.top) * state.viewport.height / rect.height], state.viewport.transform);
  }
  function tracePointerMove(event) {
    if (!state.viewport || state.busy || state.modal || state.gesture || !state.points.length || !["polygon", "exclusion", "trace", "measure", "viewport"].includes(state.tool)) return;
    const point = drawingPoint(event), view = pageMetadata()?.view;
    if (view && (point[0] < view[0] || point[1] < view[1] || point[0] > view[2] || point[1] > view[3])) { if (state.tool === "viewport") { state.traceCursor = null; renderOverlay(); } return; }
    const calibration = (snapshot()?.calibrations || []).find(value => value.id === state.calibration);
    if (state.tool !== "viewport" && calibration?.region && !inViewport(point, calibration.region)) { state.traceCursor = null; renderOverlay(); return; }
    state.traceCursor = point; renderOverlay();
  }
  function handoffPlanWheel(event) {
    if (!state.planActive || !event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.target?.isContentEditable || event.target?.closest?.("input,textarea,select,[contenteditable=true]")) return false;
    const viewport = state.ui?.viewport, outer = document.scrollingElement;
    const deltaY = Number(event.deltaY), deltaX = Number(event.deltaX || 0);
    if (!viewport || !outer || !Number.isFinite(deltaY) || !Number.isFinite(deltaX) || !deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return false;
    const innerMax = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (deltaY < 0 ? viewport.scrollTop > 1 : viewport.scrollTop < innerMax - 1) return false;
    const outerMax = Math.max(0, outer.scrollHeight - outer.clientHeight);
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const next = Math.max(0, Math.min(outerMax, outer.scrollTop + deltaY * units));
    if (next === outer.scrollTop) return false;
    // Chromium may keep its wheel target latched to the plan at its edge.
    // Cancel only this explicit handoff; ordinary internal scrolling stays native.
    event.preventDefault(); outer.scrollTop = next; return true;
  }
  function deactivatePlan() {
    state.planActive = false; state.planController?.abort(); state.planController = null;
    if (state.ui?.viewport?.dataset) state.ui.viewport.dataset.scrollActive = "false";
  }
  function activatePlan(event) {
    if (!state.ui?.viewport || event?.target?.isContentEditable || event?.target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    state.planActive = true; state.ui.viewport.dataset.scrollActive = "true";
    if (event?.type === "pointerdown" && !event.target?.closest?.("button,a")) state.ui.viewport.focus({ preventScroll: true });
    if (state.planController) return;
    const controller = state.planController = new AbortController();
    const outside = next => { if (!state.ui?.viewport.contains(next.target)) { deactivatePlan(); if (state.controlMenu || state.markupMenu) { state.controlMenu = false; state.markupMenu = null; renderOverlay(); } } };
    document.addEventListener("pointerdown", outside, { capture: true, signal: controller.signal });
    document.addEventListener("focusin", outside, { signal: controller.signal });
  }
  function resetPlanInteraction() {
    state.physicalPlacementTarget = null;
    state.panCleanup?.();
    if (state.countContinuation) cancelTrace();
    deactivatePlan(); state.controlPoint = null; state.controlMenu = false; state.markupMenu = null; state.traceCursor = null;
    state.planContextKey = JSON.stringify([state.session?.session_id, state.document, state.page, state.mode]);
    if (state.ui?.controlStatus) { state.ui.controlStatus.hidden = true; state.ui.controlStatus.textContent = ""; }
  }
  function pointReference(item, index, exclusionId = null) {
    return { sessionId: state.session?.session_id, revision: state.session?.revision, itemId: item.id, mode: item.mode,
      documentId: item.geometry.document_id, page: item.geometry.page, geometry: JSON.stringify(item.geometry), index, exclusionId };
  }
  function pointTarget(reference) {
    if (!reference || reference.sessionId !== state.session?.session_id || reference.revision !== state.session?.revision || reference.mode !== state.mode || reference.documentId !== state.document || reference.page !== state.page || !state.selected.has(reference.itemId) || state.hidden.has(reference.itemId)) throw new Error("The control point selection changed. Select the point again on the current drawing.");
    const item = items().find(value => value.id === reference.itemId);
    if (!item?.geometry || !item.measurement || JSON.stringify(item.geometry) !== reference.geometry || !visibleItems().some(value => value.id === item.id)) throw new Error("The source geometry or visible selection changed. Select the control point again.");
    const ring = reference.exclusionId ? item.geometry.exclusions?.find(value => value.id === reference.exclusionId) : item.geometry;
    if (!ring || !Number.isInteger(reference.index) || reference.index < 0 || reference.index >= ring.points.length) throw new Error("This control point is no longer available.");
    return { item, ring, minimum: item.geometry.kind === "polygon" ? 3 : 2 };
  }
  function pointRemovalReason(reference) {
    try {
      const { item, ring, minimum } = pointTarget(reference);
      if (!reference.exclusionId && item.length_additions?.some(addition => addition.anchor?.point_index === reference.index)) return "Remove the Rise/Drop at this point before deleting the control point. Its additional length must not be lost.";
      if (item.measurement.method === "cited") return "A cited source region retains its dimension markers; its cited length is not inferred from control points.";
      if (ring.points.length <= minimum) return `This ${minimum === 3 ? "closed boundary" : "length trace"} needs at least ${minimum} control points. The markup will not be deleted.`;
      return "";
    } catch (error) { return error.message; }
  }
  async function removeControlPoint(reference) {
    if (state.busy || state.modal) throw new Error("Finish the current operation before deleting a control point.");
    requireFinishedEdits(); const { item } = pointTarget(reference), reason = pointRemovalReason(reference);
    if (reason) throw new Error(reason);
    const geometry = clone(item.geometry), ring = reference.exclusionId ? geometry.exclusions.find(value => value.id === reference.exclusionId) : geometry;
    ring.points.splice(reference.index, 1);
    await command("update_item", { item_id: item.id, changes: { geometry } }, () => { requireFinishedEdits(); pointTarget(reference); return true; });
    state.controlPoint = null; state.controlMenu = false; renderOverlay(); state.ui?.viewport.focus({ preventScroll: true });
    message("Control point deleted. The revised quantity requires confirmation. Undo last edit restores the previous geometry.");
  }
  function selectControlPoint(reference, menu = false) {
    pointTarget(reference); state.markupMenu = null; state.controlPoint = reference; state.controlMenu = menu; renderOverlay();
    const selector = `[data-control-item-id="${reference.itemId}"][data-point-index="${reference.index}"][data-exclusion-id="${reference.exclusionId || ""}"]`;
    const menuItem = menu && state.ui.overlay.querySelector(".takeoff-control-menu button:not(:disabled)");
    (menuItem || state.ui.overlay.querySelector(selector))?.focus({ preventScroll: true });
  }
  function pointGeometry(reference, point) {
    const { item } = pointTarget(reference), geometry = clone(item.geometry);
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new Error("Choose a finite point on the drawing.");
    const ring = reference.exclusionId ? geometry.exclusions.find(value => value.id === reference.exclusionId) : geometry;
    ring.points[reference.index] = [...point]; return geometry;
  }
  async function moveControlPoint(reference, point) {
    if (state.busy || state.modal) throw new Error("Finish the current operation before moving a control point.");
    requireFinishedEdits(); const { item, ring } = pointTarget(reference), geometry = pointGeometry(reference, point);
    if (ring.points[reference.index].every((value, axis) => value === point[axis])) return;
    await command("update_item", { item_id: item.id, changes: { geometry } }, () => { requireFinishedEdits(); pointTarget(reference); return true; });
    state.controlPoint = null; state.controlMenu = false;
    message(isCount(item) ? "Count marker moved. Its manually entered length and quantity are unchanged. Confirm the revised source before transfer. Undo last edit restores its position." : item.measurement.method === "cited" ? "Source region updated. Its source-stated length is unchanged; confirm the revised source before transfer." : "Control point moved and measurements recalculated. Confirm the revised quantity before transfer. Undo last edit restores the previous geometry.");
  }
  function beginControlPointDrag(event, reference) {
    event.stopPropagation();
    if (event.button !== 0 || state.tool !== "select" || state.busy || state.modal || !state.viewport || state.gesture) return;
    requireFinishedEdits(); const { ring } = pointTarget(reference), initial = drawingPoint(event), origin = [...ring.points[reference.index]], element = state.ui.viewport;
    const gesture = { kind: "point", reference, initial, current: initial, origin, point: origin, geometry: pointGeometry(reference, origin), pointerId: event.pointerId, startClient: [event.clientX, event.clientY], moved: false };
    const current = () => { if (state.gesture !== gesture || state.tool !== "select") return false; try { pointTarget(reference); return true; } catch { return false; } };
    const move = next => {
      if (next.pointerId !== gesture.pointerId || !current()) return;
      if (!gesture.moved && Math.hypot(next.clientX - gesture.startClient[0], next.clientY - gesture.startClient[1]) < 4) return;
      const position = drawingPoint(next);
      gesture.current = position; gesture.point = origin.map((value, axis) => value + position[axis] - initial[axis]);
      gesture.geometry = pointGeometry(reference, gesture.point); gesture.moved = true; next.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
    };
    const finish = next => {
      if (next.pointerId !== gesture.pointerId) return;
      const valid = current();
      try { if (valid) move(next); } finally { state.gesture = null; gesture.cleanup(); }
      next.preventDefault(); state.suppressSelectionClickUntil = Date.now() + 500;
      if (!gesture.moved) {
        if (gesture.countSelectionBefore) {
          state.selected = gesture.countSelectionBefore;
          if (valid) void safely(() => selectItem(reference.itemId, event.ctrlKey || event.metaKey || event.shiftKey, false)); else renderOverlay();
        } else if (valid) selectControlPoint(reference); else renderOverlay();
        window.CeasefireProject?.changed?.(); return;
      }
      void safely(async () => {
        if (!valid) throw new Error("The drawing or item changed during the point drag. Select its current control point again.");
        await moveControlPoint(reference, gesture.point);
      }).finally(() => { if (gesture.countSelectionBefore) renderSelection(); else renderOverlay(); window.CeasefireProject?.changed?.(); });
    };
    const cancel = next => { if (next.pointerId === gesture.pointerId) cancelSelectionGesture(); };
    gesture.cleanup = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish); element.removeEventListener("pointercancel", cancel); element.removeEventListener("lostpointercapture", cancel); if (element.hasPointerCapture?.(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId); };
    state.controlPoint = reference; state.controlMenu = false; state.markupMenu = null; state.gesture = gesture;
    activatePlan(event); element.addEventListener("pointermove", move); element.addEventListener("pointerup", finish); element.addEventListener("pointercancel", cancel); element.addEventListener("lostpointercapture", cancel); element.setPointerCapture(event.pointerId);
    event.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
  }
  function markupTarget(reference) {
    const item = items().find(value => value.id === reference?.itemId);
    if (!item || reference.sessionId !== state.session?.session_id || reference.revision !== state.session?.revision || reference.mode !== state.mode || reference.documentId !== state.document || reference.page !== state.page || !drawableItems().some(value => value.id === item.id) || reference.geometry !== JSON.stringify(item.geometry)) throw new Error("The markup or drawing changed. Open its menu again.");
    return item;
  }
  function openMarkupMenu(item, event) {
    if (state.tool !== "select") return;
    event.preventDefault(); event.stopPropagation();
    if (state.busy || state.modal) return;
    requireFinishedEdits(); const reference = pointReference(item, 0);
    markupTarget(reference); state.controlPoint = null; state.controlMenu = false;
    state.selected = new Set([item.id]);
    state.markupMenu = { reference, point: event.type === "contextmenu" ? G.transform(drawingPoint(event), state.viewport.transform) : G.transform(item.geometry.points[0], state.viewport.transform) };
    activatePlan(event); renderSelection(); state.ui.overlay.querySelector('.takeoff-markup-menu button')?.focus({ preventScroll: true });
  }
  async function deleteMarkup(reference) {
    if (state.busy || state.modal) throw new Error("Finish the current operation before deleting a markup.");
    requireFinishedEdits(); const item = markupTarget(reference);
    return deleteItems([item.id], { title: "Delete markup?", action: "Delete markup", guard: () => !!markupTarget(reference) });
  }
  function appendPlanMenu(overlay, point, menu, requestedHeight = 58) {
    const bounds = overlay.getBoundingClientRect(), frame = state.ui.viewport.getBoundingClientRect(), scaleX = state.viewport.width / bounds.width, scaleY = state.viewport.height / bounds.height;
    const viewer = state.ui.viewport.parentElement, upper = viewer?.querySelector?.(".takeoff-viewer-top")?.getBoundingClientRect(), lower = viewer?.querySelector?.(".takeoff-page-controls")?.getBoundingClientRect();
    const visibleTop = Math.max(frame.top, upper?.height ? upper.bottom + 6 : frame.top), visibleBottom = Math.min(frame.top + state.ui.viewport.clientHeight, lower?.height ? lower.top - 6 : frame.top + state.ui.viewport.clientHeight);
    const left = Math.max(0, (frame.left - bounds.left) * scaleX), top = Math.max(0, (visibleTop - bounds.top) * scaleY), right = Math.min(state.viewport.width, (frame.left + state.ui.viewport.clientWidth - bounds.left) * scaleX), bottom = Math.min(state.viewport.height, (visibleBottom - bounds.top) * scaleY);
    const width = Math.min(245, Math.max(1, right - left)), height = Math.min(requestedHeight, Math.max(1, bottom - top));
    const container = svg("foreignObject", { x: Math.max(left, Math.min(point[0] + 9, right - width)), y: Math.max(top, Math.min(point[1] + 9, bottom - height)), width, height });
    menu.addEventListener("pointerdown", event => event.stopPropagation()); menu.addEventListener("click", event => event.stopPropagation()); container.append(menu); overlay.append(container);
  }
  function renderMarkupMenu(overlay) {
    if (!state.markupMenu || state.gesture) return;
    const { reference, point } = state.markupMenu;
    try { markupTarget(reference); } catch { state.markupMenu = null; return; }
    const menu = node("div", "takeoff-control-menu takeoff-markup-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Markup actions");
    const memberId = state.markupMenu.memberId;
    if (memberId) { const resume = button("Continue count", () => continueCount(reference, memberId)); resume.setAttribute("role", "menuitem"); menu.append(resume); }
    const remove = button(memberId ? "Delete count marker" : "Delete markup", () => memberId ? deleteCountMarker(reference, memberId) : deleteMarkup(reference)); remove.setAttribute("role", "menuitem"); menu.append(remove); appendPlanMenu(overlay, point, menu, memberId ? 104 : 58);
  }
  function continueCount(reference, memberId) {
    if (state.busy || state.modal) throw new Error("Finish the current operation before continuing a count.");
    requireFinishedEdits(); const item = markupTarget(reference);
    if (!isCount(item) || item.member_ids[reference.index] !== memberId) throw new Error("This marker changed. Open its menu again.");
    setTool(isStandalone(item) ? "count-only" : "count"); state.countContinuation = { ...reference, countId: item.count_id, batch: JSON.stringify(countBatchItems(item)) };
    message(isStandalone(item) ? "Continue this count by placing more markers. Double-click or Enter finishes; right-click cancels the new markers." : "Continue this Count by placing additional markers. Enter their lengths manually; the existing Count details apply. Double-click or Enter finishes; right-click cancels the new markers.");
  }
  function continuationTarget(reference) {
    // Re-rendering on zoom records render evidence and advances the revision.
    // Permit that without accepting changed Count members or technical details.
    const item = markupTarget({ ...reference, revision: state.session?.revision });
    if (!isCount(item) || item.count_id !== reference.countId || JSON.stringify(countBatchItems(item)) !== reference.batch) throw new Error("This Count changed. Cancel the new markers and choose Continue count again.");
    return item;
  }
  function copyLengthMarkups() {
    requireFinishedEdits();
    const selected = [...state.selected].map(id => items().find(item => item.id === id)).filter(Boolean);
    if (!selected.length || selected.length > 100 || selected.some(item => item.mode !== state.mode || !["steel", "duct"].includes(item.mode) || !item.geometry || item.geometry.kind != null || item.measurement?.method !== "calibrated")) throw new Error("Select up to 100 calibrated Steel or Duct Length markups to copy.");
    if (selected.some(item => item.geometry.document_id !== state.document || item.geometry.page !== state.page || state.hidden.has(item.id))) throw new Error("Copy only Length markups on the current drawing page.");
    state.lengthClipboard = { sessionId: state.session.session_id, mode: state.mode, sources: selected.map(item => ({ item_id: item.id, version: item.version })) };
    message(`Copied ${selected.length} Length markup${selected.length === 1 ? "" : "s"}. Move the pointer onto the drawing and press Ctrl+V to place the first point there.`);
  }
  async function pasteLengthMarkups() {
    requireFinishedEdits();
    const copied = state.lengthClipboard, key = pageDisplayKey(), pointer = state.pastePointer;
    if (!copied || copied.sessionId !== state.session?.session_id || copied.mode !== state.mode) throw new Error("Copy a Length markup in this project's current Steel or Duct tab first.");
    if (!state.viewport || !pointer || pointer.key !== key) throw new Error("Move the pointer onto the drawing before pasting.");
    const point = drawingPoint({ clientX: pointer.client[0], clientY: pointer.client[1] });
    const calibrations = activePageCalibrations(), scoped = calibrations.filter(value => value.region && inViewport(point, value.region));
    if (scoped.length > 1) throw new Error("Place the copy clearly inside one calibrated viewport.");
    const pageScales = calibrations.filter(value => !value.region), selectedScale = pageScales.find(value => value.id === state.calibration);
    const calibration = scoped[0] || selectedScale || (pageScales.length === 1 ? pageScales[0] : null);
    if (!calibration) throw new Error("Choose the drawing's applicable calibration before pasting.");
    const reply = await command("duplicate_items", { sources: copied.sources, document_id: state.document, page: state.page, point, calibration_id: calibration.id }, () => {
      requireFinishedEdits();
      if (copied !== state.lengthClipboard || key !== pageDisplayKey() || copied.mode !== state.mode) throw new Error("The drawing or copied selection changed before paste. Copy and paste again.");
      return true;
    });
    if (!reply) return;
    state.selected = new Set(reply.created_item_ids); state.countSelection.clear(); state.controlPoint = null; state.controlMenu = false; state.markupMenu = null; state.settingsEditor = null; renderSelection();
    message(`Pasted ${reply.created_item_ids.length} new unconfirmed Length markup${reply.created_item_ids.length === 1 ? "" : "s"}. The register now uses the destination drawing scale.`);
  }
  function planContextMenu(event) {
    if (state.points.length || !["select", "pan", "text"].includes(state.tool)) { event.preventDefault(); cancelTrace(); }
  }
  function planKeydown(event) {
    if (event.target?.isContentEditable || event.target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    if (event.key === "Escape") { event.preventDefault(); cancelTrace(); resetPlanInteraction(); renderOverlay(); return; }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && state.tool === "select" && ["steel", "duct"].includes(state.mode)) {
      const key = event.key.toLowerCase();
      if (key === "c" && state.selected.size) { event.preventDefault(); if (!state.busy && !state.modal) void safely(copyLengthMarkups); return; }
      if (key === "v" && state.lengthClipboard) { event.preventDefault(); if (!state.busy && !state.modal) void safely(pasteLengthMarkups); return; }
    }
    const undoPoint = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
    if (undoPoint) {
      // Native undo can restore an earlier page-number edit even while the
      // drawing has focus. Drawing undo never delegates to that input history.
      event.preventDefault();
      if (state.points.length) {
        if (state.busy || state.modal || state.countFinishing || state.formDirty || state.settingsDirty) { message("Apply or discard unfinished edits before changing the trace.", true); return; }
        if (["count", "count-only"].includes(state.tool)) { removePendingCount(state.countEntries.at(-1)); return; }
        state.points.pop(); state.traceCursor = null; state.doubleClickEndpointValid = false; renderOverlay(); window.CeasefireProject?.changed?.(); return;
      }
      if (state.tool !== "select" || state.mode === "physical") return;
      const selected = selectedItems(), item = selected.length === 1 && drawableItems().find(value => value.id === selected[0].id);
      if (isCount(item)) { void safely(undoLastEdit); return; }
      const reference = state.controlPoint || (item ? pointReference(item, item.geometry.points.length - 1) : null);
      if (!reference) { if (selected.length > 1) message("Choose one control point before deleting from multiple selected markups."); return; }
      void safely(() => removeControlPoint(reference)); return;
    }
    if (event.key === "Enter" && ["trace", "measure", "count-only", "count", "polygon", "exclusion", "viewport"].includes(state.tool)) { event.preventDefault(); void safely(finishTrace); }
    if (event.key === "Backspace" && state.points.length) { event.preventDefault(); if (state.busy || state.modal || state.countFinishing || state.formDirty || state.settingsDirty) return; if (["count", "count-only"].includes(state.tool)) { removePendingCount(state.countEntries.at(-1)); return; } state.points.pop(); state.traceCursor = null; state.doubleClickEndpointValid = false; renderOverlay(); window.CeasefireProject?.changed?.(); }
  }
  function cancelSelectionGesture() {
    const gesture = state.gesture; if (!gesture) return;
    state.gesture = null; gesture.cleanup();
    if (gesture.countSelectionBefore) state.selected = gesture.countSelectionBefore;
    if (gesture.countMarkerSelectionBefore) { state.selected = gesture.countMarkerSelectionBefore.items; state.countSelection = gesture.countMarkerSelectionBefore.members; }
    if (gesture.moved) state.suppressSelectionClickUntil = Date.now() + 500;
    renderOverlay(); window.CeasefireProject?.changed?.();
  }
  function beginSelectionGesture(event) {
    if (state.tool !== "select" || state.mode === "physical" || event.button !== 0 || state.busy || state.modal || !state.viewport || state.gesture) return;
    if (event.target.closest?.(".takeoff-control-point,.takeoff-control-menu,.takeoff-count-hit")) return;
    state.controlPoint = null; state.controlMenu = false; state.markupMenu = null;
    const hit = event.target.closest?.("[data-item-id]"), id = hit?.dataset.itemId;
    // An unselected markup retains ordinary click-to-select behavior.
    if (id && !state.selected.has(id)) return;
    // Let a surface click flush its pending auto-settings before changing selection.
    // A move cannot start until that edit has finished.
    if (isArea() && state.settingsDirty && !state.formDirty && !state.points.length && !state.pendingViewport) return;
    if (state.formDirty || state.settingsDirty || state.points.length || state.pendingViewport) {
      event.preventDefault(); state.suppressSelectionClickUntil = Date.now() + 500;
      throw new Error("Apply or discard unfinished item/settings edits before selecting or moving markups.");
    }
    const visible = drawableItems(), selected = selectedItems(), visibleIds = new Set(visible.map(item => item.id));
    if (id && selected.some(item => isCount(item) && state.countSelection.has(item.id))) throw new Error("Drag a selected Count marker to move the selected markers.");
    if (id && selected.some(item => !visibleIds.has(item.id))) throw new Error("Move only markups visible on this drawing page. Deselect hidden items or items on other pages first.");
    if (id && selected.length > 100) throw new Error("Move at most 100 selected markups in one operation.");
    const initial = drawingPoint(event), element = state.ui.viewport;
    const gesture = { kind: id ? "move" : "marquee", ids: id ? selected.map(item => item.id) : [], initial, current: initial, delta: [0, 0], startClient: [event.clientX, event.clientY], moved: false,
      additive: event.ctrlKey || event.metaKey || event.shiftKey, sessionId: state.session.session_id, revision: state.session.revision, documentId: state.document, page: state.page, mode: state.mode, pointerId: event.pointerId };
    const current = () => state.gesture === gesture && state.session?.session_id === gesture.sessionId && state.session.revision === gesture.revision && state.document === gesture.documentId && state.page === gesture.page && state.mode === gesture.mode;
    const move = next => {
      if (next.pointerId !== gesture.pointerId || !current()) return;
      const distance = Math.hypot(next.clientX - gesture.startClient[0], next.clientY - gesture.startClient[1]);
      if (!gesture.moved && distance < 4) return;
      gesture.moved = true; gesture.current = drawingPoint(next); gesture.delta = [gesture.current[0] - gesture.initial[0], gesture.current[1] - gesture.initial[1]];
      next.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
    };
    const finish = next => {
      if (next.pointerId !== gesture.pointerId) return;
      const valid = current(); move(next); state.gesture = null; gesture.cleanup();
      if (!gesture.moved) { renderOverlay(); window.CeasefireProject?.changed?.(); if (valid) { state.suppressSelectionClickUntil = Date.now() + 500; if (id) void safely(() => selectItem(id, gesture.additive, false, true)); else if (!gesture.additive) void safely(clearDrawingSelection); } return; }
      state.suppressSelectionClickUntil = Date.now() + 500; next.preventDefault();
      void safely(async () => {
        if (!valid || state.busy || state.formDirty || state.settingsDirty) throw new Error("The drawing or item state changed during the gesture. Repeat the selection or move.");
        if (gesture.kind === "marquee") {
          const box = G.bounds([gesture.initial, gesture.current]);
          if (!gesture.additive) { state.selected.clear(); state.countSelection.clear(); }
          let enclosed = 0, markers = 0;
          for (const item of drawableItems()) {
            if (isCount(item)) {
              const members = item.member_ids.filter((member, index) => G.enclosed([item.geometry.points[index]], box));
              if (!members.length) continue;
              state.countSelection.set(item.id, new Set([...selectedCountMemberIds(item), ...members])); state.selected.add(item.id); markers += members.length;
            } else if (G.enclosed(item.geometry.points, box)) { state.selected.add(item.id); enclosed++; }
          }
          renderSelection(); message(`${markers} Count marker${markers === 1 ? "" : "s"} and ${enclosed} other markup${enclosed === 1 ? "" : "s"} selected${gesture.additive ? " in addition to the existing selection" : ""}.`);
        } else {
          await command("move_items", { item_ids: gesture.ids, delta_pdf: gesture.delta }, () => { if (state.session?.session_id !== gesture.sessionId || state.session.revision !== gesture.revision) throw new Error("The takeoff changed before the move could apply. Repeat the move."); return true; });
          message(`Moved ${gesture.ids.length} markup${gesture.ids.length === 1 ? "" : "s"}. Source evidence references remain pinned; confirm the revised geometry before transfer.`);
        }
      }).finally(() => { renderOverlay(); window.CeasefireProject?.changed?.(); });
    };
    const cancel = next => { if (next.pointerId === gesture.pointerId) cancelSelectionGesture(); };
    gesture.cleanup = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish); element.removeEventListener("pointercancel", cancel); element.removeEventListener("lostpointercapture", cancel); if (element.hasPointerCapture?.(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId); };
    state.gesture = gesture; element.addEventListener("pointermove", move); element.addEventListener("pointerup", finish); element.addEventListener("pointercancel", cancel); element.addEventListener("lostpointercapture", cancel); element.setPointerCapture(event.pointerId);
    event.preventDefault(); window.CeasefireProject?.changed?.();
  }
  async function addCalibration() {
    const points = clone(state.points), docId = state.document, page = state.page;
    if (!G.length(points)) throw new Error("Choose two distinct calibration points.");
    const scoped = activePageCalibrations().filter(value => value.region && points.every(point => inViewport(point, value.region)));
    const existing = state.calibrationTarget ? currentViewport(state.calibrationTarget) : !state.pendingViewport && scoped.length === 1 ? scoped[0] : null;
    const scope = state.pendingViewport || existing;
    const result = await ask("Calibrate this drawing", [["name", "Calibration name", "text", scope?.name || `Page ${page} scale`, true], ["distance_m", "Known real distance (metres)", "number", "", true], ["uniform", "Uniform scale confirmed", ["Yes — the drawing has the same horizontal and vertical scale"], "", true]], "Use a stated dimension. This calibration belongs only to this page and this drawing scale. Distorted photographs and stretched scans cannot be calibrated with two points. Calibrating inside an existing viewport revises that viewport and invalidates its dependent confirmations.", "Create calibration");
    if (!result) return cancelTrace(); if (!(result.distance_m > 0)) throw new Error("Enter a known positive distance in metres.");
    if (existing) {
      const reply = await command("update_calibration", { calibration_id: existing.id, changes: { name: result.name, points, distance_m: result.distance_m, scale_denominator: null, uniform_scale: true } });
      state.calibration = reply.revised_calibration_id;
    } else {
      const id = uuid(); await command("add_calibration", { calibration: { id, document_id: docId, page, name: result.name, points, distance_m: result.distance_m, uniform_scale: true, ...(scope ? { region: scope.region } : {}) } }); state.calibration = id;
    }
    cancelTrace(); renderCalibrations();
  }
  async function finishStandaloneCount() {
    if (state.countFinishing || state.busy || state.modal || state.tool !== "count-only") return;
    if (!state.points.length) return cancelTrace();
    const markers = state.points.map(point => ({ point: [...point] })), continuation = state.countContinuation;
    if (continuation) continuationTarget(continuation);
    state.countFinishing = true;
    try {
      const details = continuation ? null : await ask("Add count", [...standaloneFields.map(def => [def[0], def[1], def[2] || "text", "", def[0] === "mark"])], "Count/QTY is the number of markers on this page.", "Add count", (controls, ready) => configureSteelCreation(controls, "ductwork", ready));
      if (!continuation && !details) return cancelTrace();
      const values = details ? { ...details, ...parseDuctSize(details.duct_size) } : null; if (values) delete values.duct_size;
      const reply = continuation ? await command("continue_standalone_count", { item_id: continuation.itemId, markers }, () => !!continuationTarget(continuation)) : await command("add_standalone_count", { mode: state.mode, document_id: state.document, page: state.page, markers, fields: values, appearance: {} });
      const ids = continuation ? [continuation.itemId] : reply.created_item_ids; cancelTrace(); state.selected = new Set(ids); state.settingsOpen = true; state.settingsEditor = null; renderSelection();
    } finally { state.countFinishing = false; }
  }
  function renderStandaloneRegister(list, container) {
    const table = node("table", "takeoff-standalone-register"), head = node("thead"), heading = node("tr"), body = node("tbody");
    for (const label of ["Select", "Hide", "View/Edit", "Confirmation", ...standaloneFields.map(def => def[1]), isArea() ? "Length (m)" : "Total Count/QTY"]) heading.append(node("th", "", label));
    head.append(heading); table.append(head, body);
    for (const item of list) {
      const row = node("tr", state.selected.has(item.id) ? "selected" : ""); row.dataset.itemId = item.id; row.dataset.purpose = item.purpose;
      for (const [label, set] of [["Select", state.selected], ["Hide", state.hidden]]) { const cell = node("td"), check = node("input"); check.type = "checkbox"; check.checked = set.has(item.id); check.setAttribute("aria-label", `${label} ${item.fields.mark || item.id}`); check.addEventListener("change", () => void safely(async () => { if (label === "Select") await selectItem(item.id, true, false); else { check.checked ? set.add(item.id) : set.delete(item.id); renderSelection(); } })); cell.append(check); row.append(cell); }
      const actions = node("td"); actions.append(button("View", () => viewItem(item), "takeoff-row-link"), button("Edit item", () => openItemSettings(item), "text-button")); row.append(actions, node("td", "", reviewStatus(item).label));
      const controls = [];
      for (const def of standaloneFields) { const field = formField(def, def[0] === "duct_size" ? formatDuctSize(item.fields) : item.fields[def[0]]); controls.push(field); field.control.addEventListener("change", () => void safely(async () => { await flushSettings(); requireFinishedEdits(); await command("update_item", { item_id: item.id, changes: { fields: def[0] === "duct_size" ? parseDuctSize(field.read()) : { [def[0]]: field.read() } } }); })); const cell = node("td"); cell.append(field.control); row.append(cell); }
      row.append(node("td", "", item.purpose === "count-only" ? String(item.quantity) : formatLength(itemResult(item).length_m))); body.append(row);
      const sessionId = state.session?.session_id; void loadCalculatorOptions("ductwork").then(choices => { if (table.isConnected && sessionId === state.session?.session_id) populateCalculatorOptions(controls, choices, "ductwork"); }).catch(error => { if (table.isConnected) message(error.message, true); });
    }
    container.append(node("h3", "", isArea() ? "Length measurements" : "Counts"), table);
  }
  async function createDrawnItem(measurement, geometry, evidence = []) {
    if (isArea()) {
      const mode = state.mode;
      const details = await ask(`Add ${mode === "wall" ? "wall" : "slab"} surface`, [...editableFields(mode).map(([key, label, type]) => [key, label, type || "text", "", ["mark", "surface_basis", "surface_citation"].includes(key)]), ["quantity", "Explicit physical quantity", [["1", "One physical treatment surface"]], "", true]], surfaceHelp, "Add surface");
      if (!details) return cancelTrace();
      if (details.quantity !== "1") throw new Error("Identify one physical treatment surface. Separate surfaces need separate items.");
      const { quantity, ...enteredFields } = details;
      const id = uuid();
      await command("create_item", { item: { id, mode, geometry, measurement, quantity: 1, fields: enteredFields, evidence } });
      state.selected = new Set([id]); cancelTrace(); renderSelection(); return;
    }
    const mode = state.mode, calculator = state.ui.target.value;
    const details = await ask(`Add ${labels[mode].toLowerCase()} object`, creationFields(mode), `One trace represents one physical object. A repeated quantity must be explicitly supported by the source. New items are unconfirmed. Choices come from ${calculatorName(calculator)}. Unknown properties may stay blank until confirmation; calculator transfer requires exact supported values.${mode === "duct" ? " New duct runs are rectangular." : ""}`, "Add item", (controls, ready) => configureSteelCreation(controls, calculator, ready));
    if (!details) return cancelTrace(); if (!Number.isInteger(details.quantity) || details.quantity < 1) throw new Error("Enter an explicit positive whole quantity.");
    const { quantity, duct_size, ...enteredFields } = details;
    if (mode === "duct") Object.assign(enteredFields, parseDuctSize(duct_size));
    const id = uuid(); await command("create_item", { item: { id, mode, geometry, measurement, quantity, fields: { ...enteredFields, ...(mode === "duct" ? { shape: "rectangular" } : {}) }, evidence } }); state.selected = new Set([id]); cancelTrace(); renderSelection();
  }
  function creationFields(mode) {
    if (mode === "duct") return [...editableFields(mode).map(([key, label, type]) => [key, label, type || "text", "", key === "mark"]), ["quantity", "Count/QTY", "number", "", true]];
    return [...["mark", "level", "member_type", "section", "fire_period_min", "exposure", "sides", "product", "critical_temperature"].filter(key => key !== "sides" || state.ui?.target?.value === "steel_board").map(key => {
      const [name, label, type] = fields.steel.find(field => field[0] === key);
      return [name, key === "product" ? "Product" : label, type || "text", "", key === "mark"];
    }), ["quantity", "Count/QTY", "number", "", true]];
  }
  const calculatorFieldColumns = { steel_vermiculite: { product: "B", exposure: "C", critical_temperature: "D", section: "F", fire_period_min: "H" }, steel_board: { product: "C", section: "D", sides: "G", fire_period_min: "H", member_type: "I", critical_temperature: "J" }, ductwork: { product: "C", frl: "E", exposure: "H", orientation: "I" } };
  async function loadCalculatorOptions(calculator, product = "", member = "") {
    const requested = api(`/options?calculator=${encodeURIComponent(calculator)}&product=${encodeURIComponent(product)}&member_type=${encodeURIComponent(member)}`);
    if (calculator !== "steel_board") return requested;
    // Physical steel exposure remains required by takeoff review. Board's
    // separate exposure_layout field is not a replacement for that property.
    const [choices, steel] = await Promise.all([requested, api("/options?calculator=steel_vermiculite")]);
    const exposure = steel.columns.find(column => column.column === "C");
    if (!Array.isArray(exposure?.options)) throw new Error("The steel Exposure choices are unavailable.");
    return { ...choices, physical_exposure_options: exposure.options };
  }
  function populateCalculatorOptions(controls, choices, calculator) {
    for (const field of controls) {
      const column = calculator === "steel_board" && field.control.name === "exposure" && choices.physical_exposure_options ? { options: choices.physical_exposure_options } : choices.columns.find(column => column.column === calculatorFieldColumns[calculator]?.[field.control.name]);
      if (!column || !field.control.isConnected) continue;
      const values = column.options || [];
      if (field.control.tagName === "SELECT") { const current = field.control.value; field.control.replaceChildren(option("", "Choose…"), ...values.map(value => option(value))); if (current && !values.map(String).includes(current)) field.control.append(option(current, `${current} (retained)`)); field.control.value = current; }
      else { let list = field.wrapper.querySelector("datalist"); if (!list) { list = node("datalist"); list.id = `takeoff-choices-${uuid()}`; field.wrapper.append(list); field.control.setAttribute("list", list.id); } list.replaceChildren(...values.map(value => option(value))); }
    }
  }
  async function configureSteelCreation(controls, calculator, ready = () => {}) {
    const sessionId = state.session?.session_id; let request = 0;
    const refresh = async () => {
      const id = ++request, product = controls.find(field => field.control.name === "product")?.control.value || "", member = controls.find(field => field.control.name === "member_type")?.control.value || "";
      ready(false);
      const choices = await loadCalculatorOptions(calculator, product, member);
      if (id !== request || sessionId !== state.session?.session_id) return;
      populateCalculatorOptions(controls, choices, calculator); ready(true);
    };
    for (const key of ["product", "member_type"]) controls.find(field => field.control.name === key)?.control.addEventListener("change", () => void safely(refresh));
    await refresh();
  }
  async function finishTrace() {
    if (state.mode === "physical" && state.tool === "count") { cancelTrace(); return; }
    if (state.formDirty || state.settingsDirty) throw new Error("Apply or discard the unfinished item edits or settings before completing the trace.");
    if (state.tool === "count-only") return finishStandaloneCount();
    if (state.tool === "count") return finishCount();
    if (state.tool === "viewport") return createViewport();
    if (["polygon", "exclusion"].includes(state.tool)) return finishAreaTrace();
    if (!["trace", "measure"].includes(state.tool) || state.points.length < 2 || !G.length(state.points)) throw new Error("Trace at least two distinct points along one object.");
    if (!state.calibration) throw new Error("Choose the correct calibration.");
    const measurement = { method: "calibrated", calibration_id: state.calibration }, geometry = { document_id: state.document, page: state.page, points: clone(state.points) };
    if (state.retraceId) { const id = state.retraceId; await command("update_item", { item_id: id, changes: { geometry, measurement } }); cancelTrace(); state.selected = new Set([id]); renderSelection(); }
    else if (state.tool === "measure") {
      const details = await ask("Add length measurement", [["mark", "Item", "text", "", true], ["level", "Level", "text", ""]], "Measured length follows this page's calibration.", "Add measurement");
      if (!details) return cancelTrace(); const id = uuid(); await command("create_item", { item: { id, mode: state.mode, purpose: "length-only", geometry, measurement, quantity: 1, fields: details } }); state.selected = new Set([id]); cancelTrace(); state.settingsOpen = true; renderSelection();
    } else await createDrawnItem(measurement, geometry);
  }
  async function finishAreaTrace() {
    G.ring(state.points);
    if (state.tool === "exclusion") {
      const item = items().find(value => value.id === state.exclusionItemId);
      if (!item || !isSurface(item) || !item.geometry || item.geometry.document_id !== state.document || item.geometry.page !== state.page) throw new Error("The surface changed. Cancel this trace and select the surface again.");
      const details = await ask("Add excluded opening", [["note", "Exclusion source / reason", "textarea", "", true]], "This opening is subtracted once from the selected treatment surface. The server checks its geometry. Review and confirmation will be invalidated.", "Add exclusion");
      if (!details) return cancelTrace();
      const geometry = clone(item.geometry); geometry.exclusions.push({ id: uuid(), points: clone(state.points), note: details.note });
      await command("update_item", { item_id: item.id, changes: { geometry } }); cancelTrace(); renderSelection(); return;
    }
    if (!state.calibration) throw new Error("Choose the applicable surface calibration.");
    const measurement = { method: "calibrated", calibration_id: state.calibration };
    const previous = state.retraceId ? items().find(item => item.id === state.retraceId) : null;
    if (previous && !isArea(previous.mode)) throw new Error("A linear item cannot become a surface.");
    const geometry = { kind: "polygon", document_id: state.document, page: state.page, points: clone(state.points), exclusions: previous?.geometry ? clone(previous.geometry.exclusions) : [] };
    if (previous?.geometry && (previous.geometry.document_id !== state.document || previous.geometry.page !== state.page) && geometry.exclusions.length) throw new Error("Remove existing exclusions before replacing the source page. Their coordinates cannot be moved to another drawing automatically.");
    if (previous) { await command("update_item", { item_id: previous.id, changes: { geometry, measurement } }); cancelTrace(); state.selected = new Set([previous.id]); renderSelection(); }
    else if (state.tool === "measure") {
      const details = await ask("Add length measurement", [["mark", "Item", "text", "", true], ["level", "Level", "text", ""]], "Measured length follows this page's calibration.", "Add measurement");
      if (!details) return cancelTrace(); const id = uuid(); await command("create_item", { item: { id, mode: state.mode, purpose: "length-only", geometry, measurement, quantity: 1, fields: details } }); state.selected = new Set([id]); cancelTrace(); state.settingsOpen = true; renderSelection();
    } else await createDrawnItem(measurement, geometry);
  }
  function areaTraceLimit() {
    const item = items().find(value => value.id === (state.tool === "exclusion" ? state.exclusionItemId : state.retraceId));
    if (!item?.geometry || !isSurface(item)) return 1000;
    return 1000 - item.geometry.exclusions.reduce((total, exclusion) => total + exclusion.points.length, 0) - (state.tool === "exclusion" ? item.geometry.points.length : 0);
  }
  async function startExclusion() {
    requireFinishedEdits(); const selected = selectedItems();
    if (selected.length !== 1 || !isSurface(selected[0])) throw new Error("Select one wall or slab surface to add an exclusion.");
    const item = selected[0];
    if (!item.geometry) throw new Error("This surface has no source boundary. Use Attach source on current page before adding exclusions.");
    if (item.geometry.exclusions.length >= 64) throw new Error("A surface supports up to 64 exclusions.");
    if (item.geometry.points.length + item.geometry.exclusions.reduce((total, exclusion) => total + exclusion.points.length, 0) > 997) throw new Error("An exclusion needs at least three vertices within the surface's 1,000 total-vertex limit.");
    await selectItem(item.id); setTool("exclusion", { exclusionItemId: item.id });
  }
  async function editAreaBoundary(item, exclusionId) {
    requireFinishedEdits(); if (!item.geometry) throw new Error("Attach source geometry before editing its vertices."); const exclusion = exclusionId ? item.geometry.exclusions.find(value => value.id === exclusionId) : null;
    if (exclusionId && !exclusion) throw new Error("This exclusion no longer exists.");
    const definitions = [["points", "Source vertices (x, y per line)", "textarea", (exclusion?.points || item.geometry.points).map(point => point.join(", ")).join("\n"), true]];
    if (exclusion) definitions.push(["note", "Exclusion source / reason", "textarea", exclusion.note, true]);
    const changed = await ask(exclusion ? "Edit excluded opening" : "Edit surface vertices", definitions, "Coordinates are original unrotated PDF coordinates, independent of zoom and screen pixels. Enter at least three distinct points in boundary order; closure is automatic. A surface has a maximum of 1,000 total vertices across all boundaries. The server rejects crossings, invalid holes and points outside the source page. Applying resets review and confirmation.", "Apply geometry");
    if (!changed) return;
    const geometry = clone(item.geometry), points = G.parseVertices(changed.points);
    if (exclusion) { const target = geometry.exclusions.find(value => value.id === exclusionId); target.points = points; target.note = changed.note; } else geometry.points = points;
    await command("update_item", { item_id: item.id, changes: { geometry } });
  }
  async function removeAreaExclusion(item, exclusion) {
    requireFinishedEdits(); if (!item.geometry) throw new Error("This surface has no source boundary or exclusions.");
    if (!await confirm("Remove excluded opening?", `The opening “${exclusion.note}” will no longer be subtracted from this surface. Review and confirmation are invalidated. Undo can restore it.`, "Remove exclusion")) return;
    const geometry = clone(item.geometry); geometry.exclusions = geometry.exclusions.filter(value => value.id !== exclusion.id);
    await command("update_item", { item_id: item.id, changes: { geometry } });
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
  function countSymbol(point, appearance, attributes = {}) {
    const scale = Math.hypot(state.viewport.transform[0], state.viewport.transform[1]) / (pageMetadata()?.user_unit || 1), radius = appearance.marker_size * scale / 2, [x, y] = point;
    if (appearance.marker_shape === "square") return svg("rect", { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2, ...attributes });
    if (["triangle", "diamond"].includes(appearance.marker_shape)) {
      const points = appearance.marker_shape === "triangle" ? [[x, y - radius], [x + radius, y + radius], [x - radius, y + radius]] : [[x, y - radius], [x + radius, y], [x, y + radius], [x - radius, y]];
      return svg("polygon", { points: points.map(value => value.join(",")).join(" "), ...attributes });
    }
    return svg("circle", { cx: x, cy: y, r: radius, ...attributes });
  }
  function setCountMarkerSelection(item, memberId, additive = false, toggle = true) {
    const members = new Set(additive ? selectedCountMemberIds(item) : []);
    if (!additive) { state.selected.clear(); state.countSelection.clear(); }
    if (additive && toggle && members.has(memberId)) members.delete(memberId); else members.add(memberId);
    if (members.size) { state.selected.add(item.id); state.countSelection.set(item.id, members); }
    else { state.selected.delete(item.id); state.countSelection.delete(item.id); }
    state.controlPoint = null; state.controlMenu = false; state.markupMenu = null;
  }
  async function selectCountMarker(itemId, memberId, additive = false) {
    if (state.busy || state.modal || state.gesture || !await discardEditor()) return;
    const item = drawableItems().find(value => value.id === itemId);
    if (!isCount(item) || !item.member_ids.includes(memberId)) throw new Error("This marker changed. Select its current position again.");
    setCountMarkerSelection(item, memberId, additive);
    state.settingsOpen = true; state.viewportsOpen = false; state.settingsEditor = null;
    renderViewportPanel(); renderSelection();
  }
  function beginCountMarkerDrag(event, item, index, memberId) {
    if (event.button !== 0 || state.tool !== "select") return;
    event.stopPropagation();
    if (state.busy || state.modal || !state.viewport || state.gesture) return;
    requireFinishedEdits(); const reference = pointReference(item, index), currentItem = markupTarget(reference);
    if (!isCount(currentItem) || currentItem.member_ids[index] !== memberId) throw new Error("This marker changed. Select its current position again.");
    const previous = { items: new Set(state.selected), members: new Map([...state.countSelection].map(([id, members]) => [id, new Set(members)])) };
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (!selectedCountMemberIds(item).includes(memberId)) setCountMarkerSelection(item, memberId, additive, false);
    const selected = selectedItems().filter(isCount), visibleIds = new Set(drawableItems().map(value => value.id));
    if (selected.some(value => !visibleIds.has(value.id))) { state.selected = previous.items; state.countSelection = previous.members; throw new Error("Move only Count markers visible on this drawing page. Deselect hidden markers or markers on other pages first."); }
    const markers = selected.flatMap(value => selectedCountMemberIds(value).map(member => ({ item_id: value.id, member_id: member })));
    if (markers.length > 10000) { state.selected = previous.items; state.countSelection = previous.members; throw new Error("Move at most 10,000 Count markers in one operation."); }
    const references = selected.map(value => pointReference(value, 0)), initial = drawingPoint(event), element = state.ui.viewport;
    const gesture = { kind: "count-markers", markers, references, membersByItem: new Map(selected.map(value => [value.id, new Set(selectedCountMemberIds(value))])), initial, current: initial, delta: [0, 0], pointerId: event.pointerId, startClient: [event.clientX, event.clientY], moved: false, countMarkerSelectionBefore: previous };
    const current = () => {
      if (state.gesture !== gesture || state.tool !== "select") return false;
      try { references.forEach(markupTarget); return true; } catch { return false; }
    };
    const move = next => {
      if (next.pointerId !== gesture.pointerId || !current()) return;
      if (!gesture.moved && Math.hypot(next.clientX - gesture.startClient[0], next.clientY - gesture.startClient[1]) < 4) return;
      const position = drawingPoint(next); gesture.current = position; gesture.delta = position.map((value, axis) => value - initial[axis]); gesture.moved = true;
      next.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
    };
    const finish = next => {
      if (next.pointerId !== gesture.pointerId) return;
      const valid = current();
      try { if (valid) move(next); } finally { state.gesture = null; gesture.cleanup(); }
      next.preventDefault(); state.suppressSelectionClickUntil = Date.now() + 500;
      if (!gesture.moved || !valid) {
        state.selected = previous.items; state.countSelection = previous.members;
        if (valid) void safely(() => selectCountMarker(item.id, memberId, additive)); else { renderSelection(); message("The drawing or count changed during the drag. Select the current markers and try again.", true); }
        window.CeasefireProject?.changed?.(); return;
      }
      void safely(async () => {
        requireFinishedEdits(); references.forEach(markupTarget);
        if (gesture.delta.some(value => value !== 0)) await command("move_count_markers", { markers, delta_pdf: gesture.delta }, () => { requireFinishedEdits(); references.forEach(markupTarget); return true; });
        message(`Moved ${markers.length} Count marker${markers.length === 1 ? "" : "s"}. Manual lengths and quantities are unchanged. Undo last edit restores their positions.`);
      }).finally(() => { renderSelection(); window.CeasefireProject?.changed?.(); });
    };
    const cancel = next => { if (next.pointerId === gesture.pointerId) cancelSelectionGesture(); };
    gesture.cleanup = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish); element.removeEventListener("pointercancel", cancel); element.removeEventListener("lostpointercapture", cancel); if (element.hasPointerCapture?.(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId); };
    state.controlPoint = null; state.controlMenu = false; state.markupMenu = null; state.gesture = gesture;
    activatePlan(event); element.addEventListener("pointermove", move); element.addEventListener("pointerup", finish); element.addEventListener("pointercancel", cancel); element.addEventListener("lostpointercapture", cancel); element.setPointerCapture(event.pointerId);
    event.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
  }
  function renderCountMarkers(overlay, item, geometry) {
    const appearance = appearanceOf(item), scale = Math.hypot(state.viewport.transform[0], state.viewport.transform[1]) / (pageMetadata()?.user_unit || 1), selectedMembers = new Set(selectedCountMemberIds(item));
    geometry.points.forEach((source, index) => {
      const point = G.transform(source, state.viewport.transform), memberId = item.member_ids[index];
      const chosen = selectedMembers.has(memberId);
      const shape = countSymbol(point, appearance, { class: `takeoff-markup takeoff-count-marker${chosen ? " selected" : ""}${state.hovered === item.id ? " hovered" : ""}`, stroke: appearance.stroke_color, "stroke-width": appearance.stroke_width * scale, fill: appearance.fill_enabled ? appearance.fill_color : "none", opacity: appearance.opacity });
      if (chosen) {
        const radius = Math.max(6, appearance.marker_size * scale / 2) + 5;
        const attrs = { x: point[0] - radius, y: point[1] - radius, width: radius * 2, height: radius * 2, rx: 3, "pointer-events": "none", "aria-hidden": "true" };
        overlay.append(svg("rect", { ...attrs, class: "takeoff-count-selection-underlay" }), svg("rect", { ...attrs, class: "takeoff-count-selection", "data-selected-member-id": memberId }));
      }
      const hit = countSymbol(point, appearance, { class: "takeoff-hit takeoff-count-hit", fill: "transparent", stroke: "transparent", "stroke-width": Math.max(8, appearance.stroke_width * scale), tabindex: 0, role: "button", "aria-pressed": String(chosen), "aria-label": `Count marker ${index + 1} · ${item.fields.mark || item.id}${isStandalone(item) ? "" : ` · ${formatLength(item.measurement.length_m)} m`}` });
      hit.dataset.itemId = item.id; hit.dataset.countItemId = item.id; hit.dataset.countMemberId = memberId;
      hit.addEventListener("pointerdown", event => void safely(() => beginCountMarkerDrag(event, item, index, memberId)));
      hit.addEventListener("click", event => { if (state.tool !== "select" || Date.now() < (state.suppressSelectionClickUntil || 0)) return; event.stopPropagation(); void safely(() => selectCountMarker(item.id, memberId, event.ctrlKey || event.metaKey || event.shiftKey)); });
      const menu = event => { if (state.tool !== "select" || state.busy || state.modal) return; event.preventDefault(); event.stopPropagation(); void safely(() => { requireFinishedEdits(); const reference = pointReference(item, index); markupTarget(reference); if (!selectedCountMemberIds(item).includes(memberId)) setCountMarkerSelection(item, memberId); state.controlPoint = null; state.controlMenu = false; state.markupMenu = { reference, memberId, point }; renderSelection(); state.ui.overlay.querySelector('.takeoff-markup-menu button')?.focus({ preventScroll: true }); }); };
      hit.addEventListener("contextmenu", menu);
      hit.addEventListener("keydown", event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") menu(event); else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); void safely(() => selectCountMarker(item.id, memberId, event.ctrlKey || event.metaKey || event.shiftKey)); } });
      hit.addEventListener("pointerenter", () => hover(item.id)); hit.addEventListener("pointerleave", () => hover(null));
      overlay.append(shape, hit);
    });
  }
  async function deleteCountMarker(reference, memberId) {
    requireFinishedEdits(); const item = markupTarget(reference);
    if (!isCount(item) || item.member_ids[reference.index] !== memberId) throw new Error("This marker changed. Open its menu again.");
    if (item.quantity === 1 && (snapshot().transfers || []).some(binding => binding.item_id === item.id)) {
      return deleteItems([item.id], { title: "Delete last count marker?", action: "Delete marker and linked rows", guard: () => {
        const current = markupTarget(reference);
        if (!isCount(current) || current.quantity !== 1 || current.member_ids[reference.index] !== memberId) throw new Error("This marker changed. Open its menu again.");
        return true;
      } });
    }
    await command("delete_count_marker", { item_id: item.id, member_id: memberId }, () => { requireFinishedEdits(); markupTarget(reference); return true; });
    state.markupMenu = null; state.settingsEditor = null; renderSelection();
    message("Marker removed and quantity recalculated. Undo last edit restores it. Existing calculator values are preserved until an explicit update.");
  }
  function surfaceScale(calibrationId, geometry) {
    const calibration = activePageCalibrations().find(value => value.id === calibrationId);
    if (!calibration || calibration.uniform_scale !== true || calibration.document_id !== geometry.document_id || calibration.page !== geometry.page) return null;
    const length = G.length(calibration.points), scale = calibration.distance_m / length;
    return scale > 0 && Number.isFinite(scale) ? scale : null;
  }
  function surfacePreview(geometry, calibrationId) {
    const metrics = G.surfaceMetrics(geometry), scale = surfaceScale(calibrationId, geometry);
    const area = scale == null ? null : metrics.area * scale * scale;
    return { ...metrics, area_m2: Number.isFinite(area) && area > 0 && area <= 1e16 ? area : null };
  }
  function renderSurfaceLabel(overlay, geometry, calibrationId, options = {}) {
    if (geometry.points.length < 3) return;
    let preview;
    try { preview = surfacePreview(geometry, calibrationId); } catch { return; }
    const area = options.preview ? preview.area_m2 : options.area;
    if (!Number.isFinite(area) || !preview.label) return;
    const point = G.transform(preview.label, state.viewport.transform), label = svg("text", { x: point[0], y: point[1], class: options.preview ? "takeoff-area-preview" : "takeoff-area-label" });
    if (options.itemId) label.dataset.areaItemId = options.itemId;
    label.textContent = `${units.format(area)} m²${options.excluded ? " excluded" : ""}${options.preview ? " · Preview" : ""}`;
    overlay.append(label);
  }
  function renderOverlay() {
    if (!state.ui || !state.viewport) return;
    const overlay = state.ui.overlay; overlay.replaceChildren(); const convert = p => G.transform(p, state.viewport.transform);
    renderViewportRegions(overlay);
    // Keep the existing hint and its exact height until pointer capture ends:
    // collapsing it mid-gesture moves the canvas under the pointer.
    if (state.ui.controlStatus && !state.gesture) state.ui.controlStatus.hidden = true;
    if (state.mode === "physical") { renderPhysicalOverlay(overlay); renderPendingTrace(overlay); return; }
    for (const item of drawableItems()) {
      const pointDrag = state.gesture?.kind === "point" && state.gesture.moved && state.gesture.reference.itemId === item.id;
      let geometry = pointDrag ? state.gesture.geometry : state.gesture?.kind === "move" && state.gesture.moved && state.gesture.ids.includes(item.id) ? G.translateGeometry(item.geometry, state.gesture.delta) : item.geometry;
      if (isCount(item) && state.gesture?.kind === "count-markers" && state.gesture.moved) {
        const moving = state.gesture.membersByItem.get(item.id);
        if (moving) geometry = { ...item.geometry, points: item.geometry.points.map((point, index) => moving.has(item.member_ids[index]) ? point.map((value, axis) => value + state.gesture.delta[axis]) : point) };
      }
      if (isCount(item)) { renderCountMarkers(overlay, item, geometry); continue; }
      const points = geometry.points.map(convert), className = `takeoff-markup ${reviewStatus(item).key}${state.selected.has(item.id) ? " selected" : ""}${state.hovered === item.id ? " hovered" : ""}`, appearance = appearanceOf(item);
      // PDF.js' transform includes UserUnit. Stored widths are physical PDF points.
      const pixelWidth = appearance.stroke_width * Math.hypot(state.viewport.transform[0], state.viewport.transform[1]) / (pageMetadata()?.user_unit || 1);
      const attributes = { class: className, stroke: appearance.stroke_color, "stroke-width": pixelWidth, opacity: appearance.opacity, fill: appearance.fill_enabled && (geometry.kind === "polygon" || item.measurement?.method === "cited") ? appearance.fill_color : "none", "fill-opacity": 0.12 };
      let shape, hit; if (geometry.kind === "polygon") { const path = pointDrag ? [geometry.points, ...geometry.exclusions.map(value => value.points)].map(ring => ring.map(convert).map((p, index) => `${index ? "L" : "M"}${p[0]},${p[1]}`).join(" ") + " Z").join(" ") : G.polygonPath(geometry, state.viewport.transform); const attrs = { d: path, "fill-rule": "evenodd", "clip-rule": "evenodd" }; shape = svg("path", { ...attrs, ...attributes }); hit = svg("path", { ...attrs, class: "takeoff-hit takeoff-area-hit" }); }
      else if (item.measurement?.method === "cited") { const box = G.region(points[0], points[points.length - 1]); const attrs = { x: box[0], y: box[1], width: box[2], height: box[3] }; shape = svg("rect", { ...attrs, ...attributes }); hit = svg("rect", { ...attrs, class: "takeoff-hit takeoff-area-hit" }); }
      else { const coords = points.map(p => p.join(",")).join(" "); shape = svg("polyline", { points: coords, ...attributes, class: `${className} takeoff-length-markup` }); hit = svg("polyline", { points: coords, class: "takeoff-hit" }); }
      hit.dataset.itemId = item.id; hit.setAttribute("aria-label", `${item.fields.mark || item.id} · ${reviewStatus(item).label}`); hit.setAttribute("tabindex", "0"); hit.setAttribute("role", "button"); hit.setAttribute("aria-pressed", String(state.selected.has(item.id)));
      hit.addEventListener("click", event => { if (state.tool !== "select" || Date.now() < (state.suppressSelectionClickUntil || 0)) return; event.stopPropagation(); void safely(() => selectItem(item.id, event.ctrlKey || event.metaKey || event.shiftKey, false, true)); });
      hit.addEventListener("keydown", event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); event.stopPropagation(); void safely(() => openMarkupMenu(item, event)); } else if (event.key === "Enter" || event.key === " " && isSurface(item)) { event.preventDefault(); event.stopPropagation(); void safely(() => selectItem(item.id, event.ctrlKey || event.metaKey || event.shiftKey, false, true)); } });
      hit.addEventListener("contextmenu", event => { if (state.tool === "select") { event.preventDefault(); event.stopPropagation(); void safely(() => openMarkupMenu(item, event)); } });
      hit.addEventListener("pointerenter", () => hover(item.id)); hit.addEventListener("pointerleave", () => hover(null));
      const label = svg("text", { x: points[0][0] + 6, y: points[0][1] - 7, class: "takeoff-label" }); label.textContent = item.fields.mark || item.id.slice(0, 8); overlay.append(shape, hit, label);
      renderLengthAdditionMarkers(overlay, item, geometry);
      if (geometry.kind === "polygon") renderSurfaceLabel(overlay, geometry, item.measurement?.calibration_id, { area: itemResult(item).net_area_m2, itemId: item.id, preview: pointDrag });
    }
    for (const hit of state.searchHits.filter(hit => hit.document_id === state.document && hit.page === state.page)) if (hit.points?.length) { const box = G.bounds(hit.points.map(convert)); overlay.append(svg("rect", { x: box[0], y: box[1], width: Math.max(4, box[2] - box[0]), height: Math.max(4, box[3] - box[1]), class: "takeoff-search-hit" })); }
    renderPendingTrace(overlay);
    if (state.gesture?.kind === "marquee" && state.gesture.moved) { const box = G.bounds([state.gesture.initial, state.gesture.current].map(convert)); overlay.append(svg("rect", { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], class: "takeoff-marquee" })); }
    renderControlPoints(overlay);
    renderMarkupMenu(overlay);
  }
  function renderLengthAdditionMarkers(overlay, item, geometry) {
    const stacks = new Map();
    for (const addition of item.length_additions || []) {
      const index = addition.anchor?.point_index, canonical = Number.isInteger(index) && geometry.points[index];
      if (!canonical) continue;
      const point = G.transform(canonical, state.viewport.transform), offset = stacks.get(index) || 0;
      stacks.set(index, offset + 1);
      const label = svg("text", { x: point[0] + 10, y: point[1] + 17 + offset * 16, class: "takeoff-label takeoff-rise-drop", "pointer-events": "none", "data-addition-id": addition.id });
      label.textContent = `${addition.kind === "riser" ? "↑ Rise" : "↓ Drop"} ${units.format(addition.length_mm)} mm`;
      const title = svg("title", {}); title.textContent = `${addition.kind === "riser" ? "Rise" : "Drop"} at control point ${index + 1}: ${addition.length_mm} mm per ${item.mode === "steel" ? "member" : "run"}`;
      label.append(title); overlay.append(label);
    }
  }
  function renderControlPoints(overlay) {
    if (state.tool !== "select" || state.gesture && state.gesture.kind !== "point" || !state.viewport) return;
    if (state.controlPoint) { try { pointTarget(state.controlPoint); } catch { state.controlPoint = null; state.controlMenu = false; } }
    const selected = drawableItems().filter(item => state.selected.has(item.id) && !isCount(item)), maximum = 10000;
    const total = selected.reduce((count, item) => count + item.geometry.points.length + (item.geometry.exclusions || []).reduce((sum, exclusion) => sum + exclusion.points.length, 0), 0);
    let shown = 0, menuPoint = null;
    for (const item of selected) {
      const geometry = state.gesture?.kind === "point" && state.gesture.reference.itemId === item.id ? state.gesture.geometry : item.geometry;
      const base = pointReference(item, 0), rings = [{ points: geometry.points, id: null, note: null }, ...(geometry.exclusions || [])];
      for (const ring of rings) for (const [index, point] of ring.points.entries()) {
        if (shown >= maximum) break;
        const reference = { ...base, index, exclusionId: ring.id }, position = G.transform(point, state.viewport.transform), active = state.controlPoint?.itemId === item.id && state.controlPoint.index === index && state.controlPoint.exclusionId === ring.id;
        const label = `Control point ${index + 1} for ${item.fields.mark || item.id}${ring.id ? `, excluded opening ${ring.note}` : ""}`;
        const handle = svg("circle", { cx: position[0], cy: position[1], r: 5, class: `takeoff-control-point${active ? " active" : ""}`, role: "button", tabindex: 0, "aria-label": label, "aria-pressed": String(active) });
        handle.dataset.controlItemId = item.id; handle.dataset.pointIndex = String(index); handle.dataset.exclusionId = ring.id || "";
        const title = svg("title", {}); title.textContent = `${label}. Drag to move and recalculate. Select, then Ctrl+Z deletes this point. Right-click for its menu.`; handle.append(title);
        handle.addEventListener("focus", () => {
          try { pointTarget(reference); } catch { return; }
          const prior = state.controlPoint;
          if (state.controlMenu && (prior?.itemId !== reference.itemId || prior.index !== reference.index || prior.exclusionId !== reference.exclusionId)) { state.controlMenu = false; overlay.querySelector(".takeoff-control-menu")?.parentElement?.remove(); }
          state.controlPoint = reference;
          for (const point of overlay.querySelectorAll(".takeoff-control-point")) { const chosen = point === handle; point.classList.toggle("active", chosen); point.setAttribute("aria-pressed", String(chosen)); }
        });
        handle.addEventListener("pointerdown", event => { event.stopPropagation(); void safely(() => beginControlPointDrag(event, reference)); });
        handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); if (Date.now() >= (state.suppressSelectionClickUntil || 0)) void safely(() => selectControlPoint(reference)); });
        handle.addEventListener("keydown", event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); event.stopPropagation(); void safely(() => selectControlPoint(reference, true)); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); void safely(() => selectControlPoint(reference)); } });
        handle.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); void safely(() => selectControlPoint(reference, true)); });
        overlay.append(handle); shown++; if (active) menuPoint = position;
      }
      if (shown >= maximum) break;
    }
    if (state.ui.controlStatus && total && !state.gesture) { state.ui.controlStatus.hidden = false; state.ui.controlStatus.textContent = total > maximum ? `Showing ${maximum} of ${total} control points. Select fewer markups to inspect every point. Drag a point to move it, or remove it with Ctrl+Z or its right-click menu.` : `${total} control points. Drag a point to update its measurement; Ctrl+Z or right-click deletes that point. Right-click the markup to delete the whole item. Undo last edit restores committed changes.`; }
    if (state.controlMenu && state.controlPoint && menuPoint) {
      const reference = state.controlPoint, reason = pointRemovalReason(reference), { item } = pointTarget(reference);
      const canAddLength = !reference.exclusionId && ["steel", "duct"].includes(item.mode) && (item.geometry.kind || "polyline") === "polyline" && item.measurement?.method === "calibrated";
      const menu = node("div", "takeoff-control-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Control point actions");
      if (canAddLength) { const insert = button("Insert Rise / Drop", () => editLengthAddition(item, null, reference)); insert.setAttribute("role", "menuitem"); menu.append(insert); }
      const remove = button("Delete control point", () => removeControlPoint(reference)); remove.setAttribute("role", "menuitem"); remove.disabled = !!reason; if (reason) remove.title = reason; menu.append(remove); if (reason) menu.append(node("p", "helper", reason));
      appendPlanMenu(overlay, menuPoint, menu, (reason ? 178 : 58) + (canAddLength ? 48 : 0));
    }
  }
  function renderViewportRegions(overlay) {
    const regions = activePageCalibrations().filter(value => value.region);
    if (state.pendingViewport) regions.push(state.pendingViewport);
    for (const calibration of regions) {
      const [x, y, w, h] = calibration.region, points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(point => G.transform(point, state.viewport.transform));
      const shape = svg("polygon", { points: points.map(point => point.join(",")).join(" "), class: `takeoff-viewport-region${calibration.id === state.calibration ? " active" : ""}` });
      shape.dataset.calibrationId = calibration.id || "pending";
      const box = G.bounds(points), label = svg("text", { x: box[0] + 5, y: box[1] + 15, class: "takeoff-viewport-label" });
      label.textContent = `${calibration.name}${calibration.scale_denominator ? ` · 1:${calibration.scale_denominator}` : " · calibrated"}`; overlay.append(shape, label);
    }
  }
  function renderPendingTrace(overlay) {
    if (state.mode === "physical" && state.physicalPlacementTarget?.pendingPoint) {
      const point = G.transform(state.physicalPlacementTarget.pendingPoint, state.viewport.transform);
      overlay.append(svg("circle", { cx: point[0], cy: point[1], r: 5, class: "takeoff-pending takeoff-defect-pending", "aria-label": "Pending defect source location" }));
      return;
    }
    if (!state.points.length) return;
    if (["count", "count-only"].includes(state.tool)) {
      const appearance = appearanceOf({ geometry: { kind: "count" } });
      for (const entry of state.countEntries) overlay.append(countSymbol(G.transform(entry.point, state.viewport.transform), appearance, { class: "takeoff-count-pending", stroke: state.tool !== "count-only" && entry.length_m == null ? "#b46812" : appearance.stroke_color, "stroke-width": 2, fill: state.tool !== "count-only" && entry.length_m == null ? "#fff" : appearance.fill_color, opacity: 0.65 }));
      return;
    }
    if (state.tool === "viewport") {
      const sourceCorners = [state.points[0], state.traceCursor || state.points[1]].filter(Boolean);
      if (sourceCorners.length === 2) {
        const [x, y, width, height] = G.region(...sourceCorners);
        const boundary = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(point => G.transform(point, state.viewport.transform));
        overlay.append(svg("polygon", { points: boundary.map(point => point.join(",")).join(" "), class: "takeoff-pending takeoff-viewport-preview" }));
      }
      for (const point of sourceCorners.map(point => G.transform(point, state.viewport.transform))) overlay.append(svg("circle", { cx: point[0], cy: point[1], r: 4, class: "takeoff-pending" }));
      return;
    }
    const sourcePoints = [...state.points];
    if (state.traceCursor && ["trace", "measure", "polygon", "exclusion"].includes(state.tool) && sourcePoints.length < (state.tool === "trace" ? 10000 : areaTraceLimit()) && Math.hypot(state.traceCursor[0] - sourcePoints.at(-1)[0], state.traceCursor[1] - sourcePoints.at(-1)[1]) > 1e-8) sourcePoints.push(state.traceCursor);
    const points = sourcePoints.map(point => G.transform(point, state.viewport.transform));
    if (state.tool === "cite" && points.length === 2) {
      const box = G.region(...points); overlay.append(svg("rect", { x: box[0], y: box[1], width: box[2], height: box[3], class: "takeoff-pending" }));
    } else overlay.append(svg(["polygon", "exclusion"].includes(state.tool) && points.length >= 3 ? "polygon" : "polyline", { points: points.map(point => point.join(",")).join(" "), class: "takeoff-pending" }));
    for (const point of state.points.map(point => G.transform(point, state.viewport.transform))) overlay.append(svg("circle", { cx: point[0], cy: point[1], r: 4, class: "takeoff-pending" }));
    if (["polygon", "exclusion"].includes(state.tool) && points.length >= 3) {
      const exclusions = state.tool === "polygon" && state.retraceId ? items().find(item => item.id === state.retraceId)?.geometry.exclusions || [] : [];
      renderSurfaceLabel(overlay, { points: sourcePoints, document_id: state.document, page: state.page, exclusions }, state.calibration, { preview: true, excluded: state.tool === "exclusion" });
    }
  }
  async function placePhysicalMarker(point) {
    requireFinishedEdits(); ensurePhysicalUI();
    const source = currentDocument(), sessionId = state.session?.session_id, revision = state.session?.revision, scope = state.physicalScope, controller = state.physicalUI;
    if (!source || !state.viewport) throw new Error("Open the original PDF before placing a barrier marker.");
    const marker = { document_id: source.id, document_sha256: source.sha256, page: state.page, point: [...point] };
    const current = () => { if (sessionId !== state.session?.session_id || revision !== state.session?.revision || scope !== state.physicalScope || controller !== state.physicalUI || state.mode !== "physical" || state.document !== marker.document_id || state.page !== marker.page || documentById(marker.document_id)?.sha256 !== marker.document_sha256) throw new Error("The drawing or physical draft changed. Place the marker again."); };
    state.physicalPlacing = true; working(state.busy);
    try {
      const selected = controller.selectedBarrier(), selectedDefect = physicalGraph()?.defects?.find(entity => state.physicalSelected.has(entity.id) && !entity.deleted);
      const placement = state.physicalPlacementTarget;
      if (placement?.kind === "defect") {
        if (scope !== "defect_reports" || placement.controller !== controller || placement.sessionId !== sessionId || placement.documentId !== marker.document_id || placement.page !== marker.page) throw new Error("The defect placement belongs to a previous drawing. Select Count again.");
        const evidence = defectLocationEvidence(marker); placement.pendingPoint = [...point]; renderOverlay(); current();
        const id = await controller.create("defect", undefined, undefined, evidence, current);
        if (id && controller === state.physicalUI && scope === state.physicalScope) { cancelTrace(); setPhysicalDetailsOpen(true); renderOverlay(); }
        return;
      }
      const explicitTarget = placement?.controller === controller && placement.sessionId === sessionId && placement.documentId === state.document && placement.page === state.page && selected?.id === placement.id && !selected.marker;
      let reuse = explicitTarget;
      if (!explicitTarget && selected && !selected.marker) {
        const choice = await ask("Place barrier marker", [["barrier", "Barrier", [["existing", `Use selected ${selected.display_id}`], ["new", "Create a new substrate"]], "existing", true]], "One marker locates one barrier and its services. Reusing a barrier does not create additional services or quantities.", "Continue");
        if (!choice) return; current(); reuse = choice.barrier === "existing";
      }
      current();
      const id = reuse ? await controller.setMarker(selected.id, marker) && selected.id : await controller.create("barrier", selected?.defect_id || selectedDefect?.id, marker);
      if (id && controller === state.physicalUI && scope === state.physicalScope) { cancelTrace(); await controller.selectDrawing(id, false, false); setPhysicalDetailsOpen(true); renderOverlay(); }
    } finally {
      if (state.physicalPlacementTarget?.kind === "defect") { delete state.physicalPlacementTarget.pendingPoint; renderOverlay(); }
      state.physicalPlacing = false; working(state.busy); window.CeasefireProject?.changed?.();
    }
  }
  function defectLocationEvidence(marker) {
    const view = pageMetadata()?.view, point = marker.point;
    if (!view || view.length !== 4 || !view.every(Number.isFinite) || view[2] <= view[0] || view[3] <= view[1] || point.length !== 2 || !point.every(Number.isFinite) || point.some((value, axis) => value < view[axis] || value > view[axis + 2])) throw new Error("Place the defect inside its original PDF page.");
    // This small source-location annotation is never a measured physical area.
    // Its size follows the marker on screen and remains inside the page crop.
    const radius = 5 / Math.hypot(state.viewport.transform[0], state.viewport.transform[1]);
    const [left, bottom, right, top] = [Math.max(view[0], point[0] - radius), Math.max(view[1], point[1] - radius), Math.min(view[2], point[0] + radius), Math.min(view[3], point[1] + radius)];
    if (!(radius > 0) || !Number.isFinite(radius) || right <= left || top <= bottom) throw new Error("The drawing transform cannot locate this defect.");
    return { document_id: marker.document_id, document_sha256: marker.document_sha256, page: marker.page, region: [[left, bottom], [right, bottom], [right, top], [left, top]], note: `Defect source-location annotation at PDF point ${JSON.stringify(point)}. Annotation size does not represent physical size or quantity.` };
  }
  function physicalMarkerReference(entity) {
    return { id: entity.id, sessionId: state.session?.session_id, scope: state.physicalScope, documentId: state.document, page: state.page, revision: entity.revision, marker: JSON.stringify(entity.marker) };
  }
  function physicalMarkerTarget(reference) {
    const entity = physicalGraph()?.barriers?.find(value => value.id === reference.id && !value.deleted);
    if (!entity?.marker || state.mode !== "physical" || reference.sessionId !== state.session?.session_id || reference.scope !== state.physicalScope || reference.documentId !== state.document || reference.page !== state.page || reference.revision !== entity.revision || reference.marker !== JSON.stringify(entity.marker)) throw new Error("The barrier marker or drawing changed. Select the current marker again.");
    return entity;
  }
  async function choosePhysicalDrawing(entity, event, callout = false) {
    await state.physicalUI?.completePendingEdits?.();
    const multiple = event.ctrlKey || event.metaKey || event.shiftKey;
    if (!callout && state.physicalSelected.has(entity.id) && state.physicalDetailsOpen && !multiple) {
      await state.physicalUI.clearSelection(); setPhysicalDetailsOpen(false);
    } else {
      await state.physicalUI.selectDrawing(entity.id, multiple, false, !callout);
      if (!callout) setPhysicalDetailsOpen(state.physicalSelected.size > 0);
    }
    renderOverlay();
  }
  function physicalCalloutLines(summary, width, fontSize = 9) {
    const context = (state.calloutMeasure ||= document.createElement("canvas").getContext("2d")), lines = [];
    for (const paragraph of String(summary).split(/\r?\n/).filter(Boolean)) {
      let line = ""; context.font = `${lines.length ? "400" : "700"} ${fontSize}px Arial`;
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && context.measureText(candidate).width > width) { lines.push(line); line = ""; context.font = `400 ${fontSize}px Arial`; }
        let part = "";
        for (const character of word) {
          if (part && context.measureText(part + character).width > width) { if (line) { lines.push(line); line = ""; } lines.push(part); part = ""; }
          part += character;
        }
        line += `${line ? " " : ""}${part}`;
      }
      if (line) lines.push(line);
    }
    return lines;
  }
  function physicalCalloutBox(entity, point, scale, markerScale) {
    const stored = entity.marker.callout;
    if (stored) {
      const anchor = G.transform(entity.marker.point.map((value, axis) => value + stored.offset[axis]), state.viewport.transform);
      return { x: anchor[0], y: anchor[1], width: stored.width * markerScale, height: stored.height * markerScale };
    }
    const width = 238 * scale, lines = physicalCalloutLines(state.physicalUI.summary(entity.id), width - 12 * scale, 9 * scale), height = (Math.min(lines.length, 30) * 12 + 12) * scale;
    const x = Math.max(0, Math.min(point[0] + 17 * scale, state.viewport.width - width)), below = point[1] + 18 * scale;
    return { x, y: below + height <= state.viewport.height ? below : Math.max(0, point[1] - 18 * scale - height), width, height };
  }
  async function beginPhysicalDrag(event, entity, kind, box, corner) {
    if (event.button !== 0 || state.tool !== "select") return;
    event.stopPropagation(); if (state.busy && !state.physicalUI?.isAutoApplying?.() || state.modal || state.gesture || !state.viewport) return;
    entity = physicalGraph()?.barriers?.find(value => value.id === entity.id && !value.deleted);
    if (!entity?.marker) return;
    let reference = physicalMarkerReference(entity), preparing = true, ready;
    const controller = state.physicalUI, initial = drawingPoint(event), element = state.ui.viewport, viewport = JSON.stringify([state.viewport.width, state.viewport.height, state.viewport.transform]);
    physicalMarkerTarget(reference);
    const gesture = { kind, id: entity.id, reference, initial, current: initial, delta: [0, 0], box: box && { ...box }, originalBox: box && { ...box }, corner, startClient: [event.clientX, event.clientY], pointerId: event.pointerId, moved: false };
    const current = () => {
      if (state.gesture !== gesture || state.tool !== "select" || state.physicalUI !== controller || !state.viewport || viewport !== JSON.stringify([state.viewport.width, state.viewport.height, state.viewport.transform])) return false;
      try {
        // Routine field saves may advance the barrier revision, but must never
        // replace this gesture's source identity or original marker geometry.
        const revision = preparing ? physicalGraph()?.barriers?.find(value => value.id === entity.id)?.revision : reference.revision;
        physicalMarkerTarget({ ...reference, revision }); return true;
      } catch { return false; }
    };
    const move = next => {
      if (gesture.released || next.pointerId !== gesture.pointerId || !current()) return;
      if (!gesture.moved && Math.hypot(next.clientX - gesture.startClient[0], next.clientY - gesture.startClient[1]) < 4) return;
      gesture.current = drawingPoint(next); gesture.delta = gesture.current.map((value, axis) => value - initial[axis]); gesture.moved = true;
      if (box) {
        const start = G.transform(initial, state.viewport.transform), end = G.transform(gesture.current, state.viewport.transform), dx = end[0] - start[0], dy = end[1] - start[1];
        if (kind === "physical-callout") gesture.box = { ...box, x: box.x + dx, y: box.y + dy };
        else {
          const left = corner.includes("w") ? Math.min(box.x + dx, box.x + box.width - 48) : box.x, right = corner.includes("e") ? Math.max(box.x + box.width + dx, box.x + 48) : box.x + box.width;
          const top = corner.includes("n") ? Math.min(box.y + dy, box.y + box.height - 28) : box.y, bottom = corner.includes("s") ? Math.max(box.y + box.height + dy, box.y + 28) : box.y + box.height;
          gesture.box = { x: left, y: top, width: right - left, height: bottom - top };
        }
      }
      next.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
    };
    const finish = next => {
      if (next.pointerId !== gesture.pointerId) return;
      const valid = current(); try { if (valid) move(next); } finally { gesture.released = true; gesture.cleanup(); }
      next.preventDefault(); state.suppressSelectionClickUntil = Date.now() + 500;
      if (!valid) { cancelSelectionGesture(); message("The barrier or drawing changed during the drag. Select it again.", true); return; }
      void safely(async () => {
        // Preserve an already released pointer's intent until the field save
        // finishes. The gesture preview never changes canonical marker data.
        if (!await ready.catch(() => false) || state.gesture !== gesture) return;
        if (!current()) throw new Error("The barrier or drawing changed during the drag. Select it again.");
        state.gesture = null;
        requireFinishedEdits(); const currentEntity = physicalMarkerTarget(reference), marker = clone(currentEntity.marker);
        if (!gesture.moved) { await choosePhysicalDrawing(currentEntity, next, kind !== "physical-marker"); return; }
        if (kind === "physical-marker") {
          marker.point = marker.point.map((value, axis) => value + gesture.delta[axis]); const view = pageMetadata()?.view;
          if (!view || marker.point[0] < view[0] || marker.point[1] < view[1] || marker.point[0] > view[2] || marker.point[1] > view[3]) throw new Error("Keep the barrier marker inside its original PDF page.");
        } else {
          const anchor = G.inverse([gesture.box.x, gesture.box.y], state.viewport.transform), pdfScale = Math.hypot(state.viewport.transform[0], state.viewport.transform[1]);
          marker.callout = { offset: anchor.map((value, axis) => value - marker.point[axis]), width: gesture.box.width / pdfScale, height: gesture.box.height / pdfScale };
        }
        await controller.setMarker(entity.id, marker);
        await controller.selectDrawing(entity.id, false, false, kind === "physical-marker");
        if (kind === "physical-marker") setPhysicalDetailsOpen(true);
      }).finally(() => { if (state.gesture === gesture) cancelSelectionGesture(); renderOverlay(); window.CeasefireProject?.changed?.(); });
    };
    const cancel = next => { if (next.pointerId === gesture.pointerId) cancelSelectionGesture(); };
    gesture.cleanup = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish); element.removeEventListener("pointercancel", cancel); element.removeEventListener("lostpointercapture", cancel); if (element.hasPointerCapture?.(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId); };
    // Capture and subscribe before any await: a fast release must not disappear
    // while a blur-triggered or already running automatic save is in flight.
    state.gesture = gesture; element.addEventListener("pointermove", move); element.addEventListener("pointerup", finish); element.addEventListener("pointercancel", cancel); element.addEventListener("lostpointercapture", cancel); event.preventDefault();
    try { element.setPointerCapture(event.pointerId); } catch { cancelSelectionGesture(); return; }
    ready = (async () => {
      await controller.completePendingEdits();
      if (state.gesture !== gesture) return false;
      if (!current()) throw new Error("The barrier or drawing changed during the drag. Select it again.");
      // Check other unfinished work without mistaking this reserved gesture
      // for an unrelated drawing operation; this guard is synchronous.
      state.gesture = null; try { requireFinishedEdits(); } finally { state.gesture = gesture; }
      entity = physicalGraph().barriers.find(value => value.id === entity.id && !value.deleted);
      reference = physicalMarkerReference(entity); gesture.reference = reference; preparing = false; return true;
    })();
    try { await ready; } catch (error) { if (state.gesture === gesture) cancelSelectionGesture(); throw error; }
  }
  function renderPhysicalMarker(overlay, entity, selectedIds) {
    const selected = selectedIds.has(entity.id), gesture = state.gesture?.id === entity.id ? state.gesture : null, moved = gesture?.kind === "physical-marker" && gesture.moved;
    const sourcePoint = entity.marker.point.map((value, axis) => value + (moved ? gesture.delta[axis] : 0)), point = G.transform(sourcePoint, state.viewport.transform);
    const pdfScale = Math.hypot(state.viewport.transform[0], state.viewport.transform[1]), markerScale = pdfScale / (pageMetadata()?.user_unit || 1), radius = Math.max(4, 6 * markerScale), scale = Math.max(markerScale, 1.2);
    const summary = state.physicalUI.summary(entity.id);
    let box = physicalCalloutBox(entity, point, scale, pdfScale);
    if (moved && entity.marker.callout) { const old = G.transform(entity.marker.point, state.viewport.transform); box.x += point[0] - old[0]; box.y += point[1] - old[1]; }
    if (gesture?.box && gesture.moved) box = gesture.box;
    const { x, y, width, height } = box, padding = Math.min(6 * scale, width / 12, height / 8);
    let fontSize = 9 * scale, lines = physicalCalloutLines(summary, width - 2 * padding, fontSize);
    for (let step = 0; step < 30 && lines.length * fontSize * 1.3 > height - 2 * padding; step++) { fontSize *= 0.9; lines = physicalCalloutLines(summary, width - 2 * padding, fontSize); }
    const lineHeight = fontSize * 1.3;
    const leader = svg("path", { d: `M${point[0]} ${point[1]}L${Math.max(x, Math.min(point[0], x + width))} ${Math.max(y, Math.min(point[1], y + height))}`, stroke: "#b90a15", "stroke-width": scale, fill: "none", "pointer-events": "none" });
    const callout = svg("g", { class: `takeoff-physical-callout${selected ? " selected" : ""}`, "data-physical-id": entity.id, role: "button", tabindex: 0, "aria-pressed": String(selected), "aria-label": `Callout ${entity.display_id} · ${summary}` });
    callout.append(svg("rect", { class: "takeoff-physical-callout-frame", x, y, width, height, rx: 3 * scale, fill: "#fff", "fill-opacity": 0.94, stroke: selected ? "#b90a15" : "#696166", "stroke-width": scale }));
    const text = svg("text", { fill: "#30282b", "font-family": "Arial, sans-serif", "font-size": fontSize });
    lines.forEach((line, index) => { const span = svg("tspan", { x: x + padding, y: y + padding + fontSize + index * lineHeight, "font-weight": index === 0 ? "700" : "400" }); span.textContent = line; text.append(span); }); callout.append(text);
    const shape = svg("circle", { cx: point[0], cy: point[1], r: radius, class: `takeoff-physical-marker${selected ? " selected" : ""}`, fill: "#b90a15", stroke: selected ? "#fff" : "#b90a15", "stroke-width": Math.max(1, 2 * markerScale), "pointer-events": "none" });
    const hit = svg("circle", { cx: point[0], cy: point[1], r: Math.max(radius, 9), class: "takeoff-physical-marker-hit", fill: "transparent", stroke: "none", "pointer-events": "all", role: "button", tabindex: 0, "aria-label": `Count marker ${entity.display_id} · ${summary}`, "aria-pressed": String(selected), "data-physical-id": entity.id });
    for (const target of [hit, callout]) {
      const choose = event => { if (state.tool !== "select") return; event.stopPropagation(); if (event.type === "click" && Date.now() < (state.suppressSelectionClickUntil || 0)) return; void safely(() => choosePhysicalDrawing(entity, event, target === callout)); };
      target.addEventListener("click", choose);
      target.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(event); } });
      target.addEventListener("contextmenu", event => { if (state.tool !== "select") return; event.preventDefault(); event.stopPropagation(); void safely(() => { requireFinishedEdits(); const reference = physicalMarkerReference(entity); physicalMarkerTarget(reference); state.markupMenu = { physical: true, reference, point }; renderOverlay(); }); });
    }
    hit.addEventListener("pointerdown", event => void safely(() => beginPhysicalDrag(event, entity, "physical-marker")));
    callout.addEventListener("pointerdown", event => void safely(() => beginPhysicalDrag(event, entity, "physical-callout", box)));
    overlay.append(leader, callout, shape, hit);
    if (selected && state.tool === "select") for (const [corner, cx, cy] of [["nw", x, y], ["ne", x + width, y], ["sw", x, y + height], ["se", x + width, y + height]]) {
      const handle = svg("rect", { x: cx - 5, y: cy - 5, width: 10, height: 10, class: "takeoff-physical-callout-handle", "data-corner": corner, role: "button", tabindex: 0, "aria-label": `Resize callout ${corner}` });
      handle.addEventListener("pointerdown", event => void safely(() => beginPhysicalDrag(event, entity, "physical-resize", box, corner))); overlay.append(handle);
    }
  }
  function renderPhysicalMarkerMenu(overlay) {
    if (!state.markupMenu?.physical || state.gesture) return;
    const { reference, point } = state.markupMenu;
    try { physicalMarkerTarget(reference); } catch { state.markupMenu = null; return; }
    const menu = node("div", "takeoff-control-menu takeoff-markup-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Barrier marker actions");
    const remove = button("Remove count marker", async () => { requireFinishedEdits(); physicalMarkerTarget(reference); state.markupMenu = null; await state.physicalUI.setMarker(reference.id, null); renderOverlay(); }); remove.setAttribute("role", "menuitem"); menu.append(remove); appendPlanMenu(overlay, point, menu);
  }
  function renderPhysicalOverlay(overlay) {
    if (!state.physicalUI) return;
    const seen = new Set(), regions = [];
    for (const [kind, collection] of [["Barrier", "barriers"], ["Defect", "defects"], ["Opening", "openings"], ["Service", "services"]]) for (const entity of physicalGraph()?.[collection] || []) {
      if (entity.deleted || !state.physicalVisible.has(entity.id) && !state.physicalSelected.has(entity.id)) continue;
      for (const reference of entity.evidence || []) {
        if (reference.document_id !== state.document || reference.page !== state.page || !Array.isArray(reference.region) || !reference.region.every(point => Array.isArray(point)) || reference.region.length < 3) continue;
        const key = `${entity.id}/${JSON.stringify(reference.region)}`; if (seen.has(key)) continue; seen.add(key); regions.push({ entity, kind, reference });
      }
    }
    regions.sort((a, b) => Number(state.physicalSelected.has(b.entity.id)) - Number(state.physicalSelected.has(a.entity.id)));
    for (const { entity, kind, reference } of regions.slice(0, 500)) {
      const path = G.polygonPath({ kind: "polygon", points: reference.region, exclusions: [] }, state.viewport.transform), first = G.transform(reference.region[0], state.viewport.transform);
      const shape = svg("path", { d: path, class: `takeoff-shape takeoff-physical-shape${state.physicalSelected.has(entity.id) ? " selected" : ""}${state.physicalHovered === entity.id ? " hovered" : ""}` });
      const hit = svg("path", { d: path, class: "takeoff-hit takeoff-area-hit", role: "button", tabindex: 0, "aria-label": `${kind}: ${entity.fields.label || entity.id} · unapproved draft evidence` }); hit.dataset.physicalId = entity.id;
      hit.addEventListener("click", event => { if (state.tool !== "select") return; event.stopPropagation(); void safely(() => state.physicalUI.selectDrawing(entity.id, event.ctrlKey || event.metaKey || event.shiftKey, false)); });
      hit.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void safely(() => state.physicalUI.selectDrawing(entity.id, event.ctrlKey || event.metaKey, false)); } });
      hit.addEventListener("pointerenter", () => state.physicalUI?.hover(entity.id)); hit.addEventListener("pointerleave", () => state.physicalUI?.hover(null));
      const label = svg("text", { x: first[0] + 6, y: first[1] - 7, class: "takeoff-label" }); label.textContent = `${kind}: ${entity.fields.label || entity.id.slice(0, 8)}`; overlay.append(shape, hit, label);
    }
    const markers = (physicalGraph()?.barriers || []).filter(entity => !entity.deleted && entity.marker?.document_id === state.document && entity.marker.page === state.page);
    const selectedIds = new Set(state.physicalSelected); for (const service of physicalGraph()?.services || []) if (state.physicalSelected.has(service.id)) selectedIds.add(service.barrier_id);
    markers.sort((a, b) => Number(selectedIds.has(a.id)) - Number(selectedIds.has(b.id)));
    for (const entity of markers) renderPhysicalMarker(overlay, entity, selectedIds);
    renderPhysicalMarkerMenu(overlay);
    state.ui.physicalOverlayStatus.textContent = `${markers.length} barrier count markers on this page. ` + (regions.length > 500 ? `Showing 500 of ${regions.length} linked source regions. Select a register record to prioritize its evidence.` : `${regions.length} linked physical source regions.`) + " These are unapproved draft associations; markers do not multiply service quantities.";
  }
  function itemResult(item) { return state.resultMap.get(item.id) || {}; }
  function reviewStatus(item) {
    const issues = itemResult(item).issues || [];
    return item.state === "confirmed" && !issues.length ? { key: "confirmed", label: "Confirmed" } : { key: "unconfirmed", label: "Unconfirmed" };
  }
  function issueText(value) { return typeof value === "string" ? value : value?.message || value?.detail || value?.code || JSON.stringify(value); }
  const registerFilterColumns = {
    steel: { confirmation: "Confirmation", mark: "Member mark", level: "Level", member_type: "Member type", section: "Steel section", fire_period_min: "Fire period (min)" },
    duct: { confirmation: "Confirmation", mark: "Item", level: "Level", duct_size: "WxH (mm)", frl: "FRL", orientation: "Orientation" },
    wall: { confirmation: "Confirmation", mark: "Wall ID", level: "Level", surface_basis: "Surface basis", substrate: "Substrate", treatment: "Treatment", system: "Protection system", product: "Protection product", frl: "FRL / fire rating" },
    slab: { confirmation: "Confirmation", mark: "Slab / zone ID", level: "Level", surface_basis: "Surface basis", substrate: "Substrate", treatment: "Treatment", system: "Protection system", product: "Protection product", frl: "FRL / fire rating" },
  };
  const usesColumnFilters = () => Object.hasOwn(registerFilterColumns, state.mode);
  function registerFilters() {
    const sessionId = state.session?.session_id || null;
    if (state.registerFilterSession !== sessionId) { state.registerColumnFilters.clear(); state.registerFilterSession = sessionId; }
    if (!state.registerColumnFilters.has(state.mode)) state.registerColumnFilters.set(state.mode, new Map());
    return state.registerColumnFilters.get(state.mode);
  }
  function registerFilterValue(item, key) {
    if (key === "surface_basis") {
      const value = String(item.fields?.[key] ?? "").trim(), choices = fields[item.mode]?.find(field => field[0] === key)?.[2];
      return Array.isArray(choices) ? choices.find(choice => choice[0] === value)?.[1] || value : value;
    }
    return String(key === "confirmation" ? reviewStatus(item).label : key === "duct_size" ? formatDuctSize(item.fields || {}) : item.fields?.[key] ?? "").trim();
  }
  function registerColumnValues(key) {
    // Stable choices across other column filters and register searches; selected
    // values remain available to clear even after an item is edited or deleted.
    return [...new Set([...items().filter(item => item.mode === state.mode).map(item => registerFilterValue(item, key)), ...(registerFilters().get(key) || [])])]
      .sort((a, b) => a.localeCompare(b, "en-AU", { numeric: true }));
  }
  function setRegisterColumnFilter(key, selected, allValues = registerColumnValues(key)) {
    if (!usesColumnFilters() || !Object.hasOwn(registerFilterColumns[state.mode], key)) return;
    const filters = registerFilters();
    if (selected === null || allValues.length > 0 && allValues.every(value => selected.has(value))) filters.delete(key);
    else filters.set(key, new Set(selected));
    state.offset = 0; renderRegister(); renderOverlay();
  }
  async function openRegisterColumnFilter(key, anchor) {
    if (state.modal || !usesColumnFilters() || !Object.hasOwn(registerFilterColumns[state.mode], key)) return;
    const sessionId = state.session?.session_id, mode = state.mode, values = registerColumnValues(key), selected = new Set(registerFilters().get(key) ?? values);
    const label = registerFilterColumns[mode][key], dialog = node("dialog", "takeoff-column-filter"), heading = node("h2", "", `Filter ${label}`);
    heading.id = `takeoff-column-filter-${uuid()}`; dialog.setAttribute("aria-labelledby", heading.id);
    const search = node("input"); search.type = "search"; search.placeholder = "Search values…"; search.setAttribute("aria-label", `Search ${label} values`);
    const allLabel = node("label", "takeoff-column-filter-choice"), all = node("input"); all.type = "checkbox"; all.setAttribute("aria-label", "Select all values"); allLabel.append(all, node("span", "", "Select all"));
    const choices = node("div", "takeoff-column-filter-values"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", `${label} values`);
    let matching = values;
    const updateAll = () => { const count = matching.filter(value => selected.has(value)).length; all.checked = !!matching.length && count === matching.length; all.indeterminate = count > 0 && count < matching.length; all.disabled = !matching.length; };
    const renderChoices = () => {
      const query = search.value.trim().toLowerCase(); matching = values.filter(value => (value || "(Blanks)").toLowerCase().includes(query)); choices.replaceChildren();
      for (const value of matching) {
        const choice = node("label", "takeoff-column-filter-choice"), check = node("input"); check.type = "checkbox"; check.checked = selected.has(value); check.setAttribute("aria-label", value || "(Blanks)");
        check.addEventListener("change", () => { check.checked ? selected.add(value) : selected.delete(value); updateAll(); });
        choice.append(check, node("span", "", value || "(Blanks)")); choices.append(choice);
      }
      if (!matching.length) choices.append(node("p", "takeoff-column-filter-empty", "No matching values"));
      updateAll();
    };
    search.addEventListener("input", renderChoices);
    all.addEventListener("change", () => { for (const value of matching) all.checked ? selected.add(value) : selected.delete(value); renderChoices(); });
    const actions = node("div", "takeoff-column-filter-actions");
    actions.append(button("Apply filter", () => dialog.close("apply"), "button primary"), button("Reset filter", () => dialog.close("reset")), button("Cancel", () => dialog.close("cancel")));
    dialog.append(heading, search, allLabel, choices, actions); renderChoices();
    state.modal = true; anchor.setAttribute("aria-expanded", "true"); document.body.append(dialog);
    try {
      const result = await new Promise(resolve => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }); dialog.showModal();
        const bounds = anchor.getBoundingClientRect(), box = dialog.getBoundingClientRect();
        dialog.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - box.width - 8))}px`;
        dialog.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - box.height - 8))}px`;
        search.focus();
      });
      if (["apply", "reset"].includes(result) && sessionId === state.session?.session_id && state.mode === mode) setRegisterColumnFilter(key, result === "reset" ? null : selected, values);
    } finally { state.modal = false; anchor.setAttribute("aria-expanded", "false"); dialog.remove(); }
  }
  function registerColumnFilterButton(key) {
    const active = registerFilters().has(key), label = registerFilterColumns[state.mode][key];
    const control = button(`Filter ${label}`, () => openRegisterColumnFilter(key, control), `takeoff-column-filter-button${active ? " active" : ""}`);
    const icon = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: "takeoff-column-filter-icon" }); icon.append(svg("path", { d: "M3 5h18l-7 8v6l-4 2v-8z", fill: active ? "currentColor" : "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linejoin": "round" }));
    control.replaceChildren(icon); control.setAttribute("aria-label", `Filter ${label}`); control.setAttribute("aria-haspopup", "dialog"); control.setAttribute("aria-expanded", "false"); control.setAttribute("aria-pressed", String(active)); control.title = active ? `${label}: filter applied` : `Filter ${label}`;
    return control;
  }
  function visibleItems() {
    const result = items().filter(item => item.mode === state.mode && (!state.filter || [item.id, ...Object.values(item.fields || {})].join(" ").toLowerCase().includes(state.filter)));
    if (usesColumnFilters()) {
      const filters = registerFilters();
      return result.filter(item => [...filters].every(([key, values]) => values.has(registerFilterValue(item, key))))
        .sort((a, b) => String(a.fields?.mark || "").localeCompare(String(b.fields?.mark || ""), "en-AU", { numeric: true }));
    }
    const filter = state.ui?.statusFilter.value;
    return result.filter(item => !filter || reviewStatus(item).key === filter).sort((a, b) => ["length", "area"].includes(state.sort) ? (itemResult(a)[state.sort === "area" ? "net_area_m2" : "length_m"] || 0) - (itemResult(b)[state.sort === "area" ? "net_area_m2" : "length_m"] || 0) : String(state.sort === "state" ? reviewStatus(a).label : a.fields[state.sort] || "").localeCompare(String(state.sort === "state" ? reviewStatus(b).label : b.fields[state.sort] || ""), "en-AU", { numeric: true }));
  }
  function itemGroup(item) { if (isStandalone(item)) return null; return !usesColumnFilters() && state.group ? (state.group === "state" ? reviewStatus(item).label : item.fields[state.group] || "Ungrouped") : null; }
  function groupedItems(list = visibleItems()) { const standard = list.filter(item => !isStandalone(item)), standalone = list.filter(isStandalone); return [...(!usesColumnFilters() && state.group ? standard.sort((a, b) => String(itemGroup(a)).localeCompare(String(itemGroup(b)))) : standard), ...standalone]; }
  function syncSurfaceDetailsSelection() {
    if (!isArea()) return;
    state.settingsOpen = selectedItems().length > 0;
    if (state.settingsOpen) state.viewportsOpen = false;
    else { if (state.settingsEditor) clearTimeout(state.settingsEditor.timer); state.settingsEditor = null; }
    renderViewportPanel();
  }
  async function selectItem(id, multiple = false, focus = true, fromDrawing = false) {
    if (!await discardEditor()) return;
    state.controlPoint = null; state.controlMenu = false; state.markupMenu = null;
    const item = items().find(value => value.id === id); if (!item) return;
    if (isCount(item) || isStandalone(item)) { state.settingsOpen = true; state.viewportsOpen = false; state.settingsEditor = null; renderViewportPanel(); }
    const modeChanged = state.mode !== item.mode;
    const deselectSurface = fromDrawing && isSurface(item) && !multiple && state.selected.size === 1 && state.selected.has(id);
    state.mode = item.mode; state.offset = Math.floor(Math.max(0, groupedItems().findIndex(candidate => candidate.id === id)) / 100) * 100; if (!multiple) { state.selected.clear(); state.countSelection.clear(); } state.countSelection.delete(id); if (deselectSurface || multiple && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    syncSurfaceDetailsSelection();
    if (state.selected.has(id) && state.group) state.collapsed.delete(itemGroup(item));
    if (focus && !item.geometry) message("This draft has no source markup yet. Inspect its fields, then attach source geometry before review or confirmation.", true);
    if (focus && item.geometry) { const changed = state.document !== item.geometry.document_id || state.page !== item.geometry.page; state.document = item.geometry.document_id; state.page = item.geometry.page; state.hidden.delete(id); if (changed) { renderRail(); renderCalibrations(); await renderPage(); } await focusGeometry(item); }
    if (modeChanged) renderData(); else renderSelection();
  }
  async function focusGeometry(item) {
    if (!state.viewport || !item.geometry) return;
    const viewport = state.ui.viewport, firstBox = G.bounds(item.geometry.points.map(p => G.transform(p, state.viewport.transform)));
    const desired = Math.max(0.05, Math.min(4, state.zoom * Math.min((viewport.clientWidth - 90) / Math.max(40, firstBox[2] - firstBox[0]), (viewport.clientHeight - 90) / Math.max(40, firstBox[3] - firstBox[1]))));
    if (Math.abs(desired - state.zoom) > 0.05) { state.zoom = desired; await renderPage(); }
    if (!state.viewport) return;
    const box = G.bounds(item.geometry.points.map(p => G.transform(p, state.viewport.transform)));
    positionPage(viewport.clientWidth / 2 - (box[0] + box[2]) / 2, viewport.clientHeight / 2 - (box[1] + box[3]) / 2);
  }
  function hover(id) { state.hovered = id; for (const row of state.ui?.tableWrap.querySelectorAll("[data-item-id]") || []) row.classList.toggle("hovered", row.dataset.itemId === id); for (const hit of state.ui?.overlay.querySelectorAll("[data-item-id]") || []) hit.previousElementSibling?.classList.toggle("hovered", hit.dataset.itemId === id); }
  function renderSelection() { syncSurfaceDetailsSelection(); renderRegister(); renderSettingsPanel(); renderOverlay(); }
  function revealDrawingPanel(panel, focus, gap = 12) {
    if (!panel || panel.hidden) return;
    const bounds = panel.getBoundingClientRect?.(), header = document.querySelector?.(".app-header")?.getBoundingClientRect?.();
    if (bounds && window.scrollBy) window.scrollBy({ top: bounds.top - Math.max(0, header?.bottom || 0) - gap, behavior: "auto" });
    if (focus) panel.focus?.({ preventScroll: true });
  }
  async function viewItem(item) {
    const sessionId = state.session?.session_id;
    if (!await discardEditor()) return;
    if (sessionId !== state.session?.session_id) throw new Error("The project changed. Choose the item again.");
    await selectItem(item.id, false, true);
    if (!state.selected.has(item.id) || !item.geometry) return;
    await focusGeometry(item);
    revealDrawingPanel(state.ui.viewport, true);
  }
  async function openItemSettings(item) {
    const sessionId = state.session?.session_id;
    if (!await discardEditor()) return;
    if (sessionId !== state.session?.session_id) throw new Error("The project changed. Choose the item again.");
    await selectItem(item.id, false, false);
    if (!state.selected.has(item.id)) return;
    state.settingsOpen = true; state.viewportsOpen = false; state.settingsEditor = null;
    renderViewportPanel(); renderSettingsPanel(); renderRegister();
    state.ui.settingsPanel.scrollTop = 0;
    state.ui.settingsPanel.setAttribute("tabindex", "-1");
    revealDrawingPanel(state.ui.settingsPanel, true);
  }
  function renderRegister() {
    if (!state.ui || state.mode === "physical") return;
    const list = visibleItems(), selected = selectedItems();
    syncBulkFields();
    const individualMeasuredDuct = selected.length && selected.every(item => item.mode === "duct" && item.quantity === 1 && item.measurement?.method === "calibrated" && !item.length_additions?.length);
    const steelGroups = selected.length && selected.every(item => item.mode === "steel" && !isCount(item) && Number.isInteger(item.quantity) && item.quantity > 0);
    const quantityOption = state.ui.bulkField.querySelector('option[value="quantity"]');
    if (quantityOption) { quantityOption.disabled = selected.some(isCount); if (quantityOption.disabled && state.ui.bulkField.value === "quantity") state.ui.bulkField.value = "mark"; }
    state.ui.split.disabled = !(selected.length === 1 && (individualMeasuredDuct || steelGroups && selected[0].quantity > 1));
    state.ui.merge.disabled = !(individualMeasuredDuct && selected.length === 2 || steelGroups && selected.length >= 2);
    state.ui.split.title = isArea() ? "Surface splitting is unavailable. Group separate physical surfaces without changing their identities." : state.mode === "steel" ? "Partition an explicit repeated-member quantity without changing individual member lengths." : "Split measured segments of one individual duct run.";
    state.ui.merge.title = isArea() ? "Surface merging is unavailable. Group separate physical surfaces without changing their identities." : state.mode === "steel" ? "Combine compatible repeated-member groups while retaining every physical member identity." : "Merge adjoining measured segments of one individual duct run.";
    state.ui.bulk.hidden = !selected.length; state.ui.selectionCount.textContent = `${selected.length} selected`;
    const table = node("table"), head = node("thead"), header = node("tr"), body = node("tbody"); table.setAttribute("aria-label", `${labels[state.mode]} editable takeoff register`);
    const area = isArea(), columns = area ? ["mark", "level", "surface_basis", "substrate", "treatment", "system", "product", "frl"] : state.mode === "steel" ? ["mark", "level", "member_type", "section", "fire_period_min", ...(state.ui.target?.value === "steel_board" ? ["sides"] : [])] : ["mark", "level", "duct_size", "frl", "orientation"];
    const headings = ["Select", "Hide", "View/Edit", "Confirmation", ...columns.map(key => fields[state.mode].find(field => field[0] === key)?.[1] || key), ...(area ? ["Gross (m²)", "Excluded (m²)", "Net (m²)"] : ["Qty", "Length each (m)", "Total (m)"]), "Evidence / issues"];
    for (const title of headings) {
      const cell = node("th", "", title);
      if (usesColumnFilters()) { const filterColumns = registerFilterColumns[state.mode], key = Object.keys(filterColumns).find(key => filterColumns[key] === title); if (key) cell.append(registerColumnFilterButton(key)); }
      if (title === "Select" || title === "Hide") {
        const input = node("input"), set = title === "Select" ? state.selected : state.hidden, count = list.filter(item => set.has(item.id)).length; input.type = "checkbox"; input.checked = !!list.length && count === list.length; input.indeterminate = count > 0 && count < list.length; input.disabled = !list.length || state.busy; input.setAttribute("aria-label", title === "Select" ? "Select all matching items" : "Hide all matching items"); input.title = `${title} all ${list.length} matching items across register pages`;
        input.addEventListener("change", () => void safely(async () => { const checked = input.checked; if (title === "Select" && !await discardEditor()) { renderRegister(); return; } for (const item of list) { checked ? set.add(item.id) : set.delete(item.id); if (title === "Select") state.countSelection.delete(item.id); } renderSelection(); })); cell.append(input);
      }
      header.append(cell);
    }
    head.append(header); table.append(head, body);
    let lastGroup = null;
    const optionRequests = new Map(), calculator = state.ui.target?.value, sessionId = state.session?.session_id;
    const grouped = groupedItems(list);
    state.offset = Math.max(0, Math.min(state.offset, Math.max(0, Math.floor((grouped.length - 1) / 100) * 100)));
    for (const item of grouped.slice(state.offset, state.offset + 100).filter(item => !isStandalone(item))) {
      const group = itemGroup(item);
      if (group !== null && group !== lastGroup) { const row = node("tr", "takeoff-group-row"), cell = node("td"); cell.colSpan = headings.length; cell.append(button(`${state.collapsed.has(group) ? "▸" : "▾"} ${group}`, () => { state.collapsed.has(group) ? state.collapsed.delete(group) : state.collapsed.add(group); renderRegister(); }, "takeoff-group-toggle")); row.append(cell); body.append(row); lastGroup = group; }
      if (group && state.collapsed.has(group)) continue;
      const row = node("tr", state.selected.has(item.id) ? "selected" : ""); row.dataset.itemId = item.id; row.addEventListener("pointerenter", () => hover(item.id)); row.addEventListener("pointerleave", () => hover(null));
      const checkCell = node("td"), check = node("input"); check.type = "checkbox"; check.checked = state.selected.has(item.id); check.setAttribute("aria-label", `Select ${item.fields.mark || item.id}`); check.addEventListener("change", () => void safely(async () => { await selectItem(item.id, true, false); check.checked = state.selected.has(item.id); })); checkCell.append(check);
      const showCell = node("td"), show = node("input"); show.type = "checkbox"; show.checked = state.hidden.has(item.id); show.setAttribute("aria-label", `Hide ${item.fields.mark || item.id} on drawing`); show.addEventListener("change", () => { show.checked ? state.hidden.add(item.id) : state.hidden.delete(item.id); renderRegister(); renderOverlay(); }); showCell.append(show);
      const linkCell = node("td"), edit = button("Edit item", () => openItemSettings(item), "text-button"); edit.setAttribute("aria-controls", "takeoff-markup-settings");
      linkCell.append(button("View", () => viewItem(item), "takeoff-row-link"), edit); const reviewCell = node("td"); reviewCell.append(node("span", `takeoff-state ${reviewStatus(item).key}`, reviewStatus(item).label)); row.append(checkCell, showCell, linkCell, reviewCell);
      const rowFields = [];
      for (const key of [...columns, ...(area ? [] : ["quantity"])]) {
        const initial = key === "quantity" ? item.quantity : key === "duct_size" ? formatDuctSize(item.fields) : item.fields[key];
        const def = key === "quantity" ? [key, "Quantity", "number"] : fields[state.mode].find(field => field[0] === key), field = formField(def, initial); rowFields.push(field);
        if (isCount(item)) { field.control.readOnly = true; field.control.disabled = true; field.control.dataset.countReadOnly = "true"; field.control.title = key === "quantity" ? "Quantity is derived from count markers." : "Edit shared Count details using Edit item."; }
        else field.control.addEventListener("change", () => void safely(async () => { try { await flushSettings(); requireFinishedEdits(); if (sessionId !== state.session?.session_id) throw new Error("The project changed. Choose the item again."); } catch (error) { field.control.value = initial ?? ""; throw error; } if (field.control.value === String(initial ?? "")) return; const value = field.read(); if (def[2] === "number" && value !== null && !Number.isFinite(value)) throw new Error("Enter a finite number."); await command("update_item", { item_id: item.id, changes: key === "quantity" ? { quantity: value } : { fields: key === "duct_size" ? parseDuctSize(field.control.value) : { [key]: value } } }); }));
        const cell = node("td"); cell.append(field.control); row.append(cell);
      }
      const result = itemResult(item);
      for (const key of area ? ["gross_area_m2", "excluded_area_m2", "net_area_m2"] : ["length_m", "total_length_m"]) row.append(node("td", "", area ? Number.isFinite(result[key]) ? units.format(result[key]) : "—" : formatLength(result[key])));
      const evidence = node("td"); evidence.append(node("span", "", item.geometry ? `${documentById(item.geometry.document_id)?.name || "Missing document"} · p${item.geometry.page}` : "Source markup missing")); if (item.mode === "duct" && item.fields.shape !== "rectangular") evidence.append(node("span", "takeoff-row-issue", "Retained non-rectangular duct; calculator transfer unavailable.")); for (const issue of result.issues || []) evidence.append(node("span", "takeoff-row-issue", issueText(issue))); row.append(evidence); body.append(row);
      if (!area && calculator && rowFields.some(field => field.control.tagName === "SELECT" && ["frl", "fire_period_min"].includes(field.control.name))) {
        const url = `/options?calculator=${encodeURIComponent(calculator)}&product=${encodeURIComponent(item.fields.product || "")}&member_type=${encodeURIComponent(item.fields.member_type || "")}`;
        if (!optionRequests.has(url)) optionRequests.set(url, loadCalculatorOptions(calculator, item.fields.product || "", item.fields.member_type || ""));
        void optionRequests.get(url).then(choices => { if (table.isConnected && sessionId === state.session?.session_id && calculator === state.ui.target.value) populateCalculatorOptions(rowFields, choices, calculator); }).catch(error => { if (table.isConnected) message(`Calculator choices could not be loaded. ${error.message}`, true); });
      }
    }
    state.ui.pagination.replaceChildren(button("Previous 100", () => { state.offset = Math.max(0, state.offset - 100); renderRegister(); }), node("span", "helper", `${list.length ? state.offset + 1 : 0}–${Math.min(state.offset + 100, list.length)} of ${list.length} matching items`), button("Next 100", () => { if (state.offset + 100 < list.length) state.offset += 100; renderRegister(); }));
    state.ui.tableWrap.replaceChildren(table);
    const standaloneRows = grouped.slice(state.offset, state.offset + 100).filter(isStandalone);
    if (standaloneRows.length) renderStandaloneRegister(standaloneRows, state.ui.tableWrap);
    if (!list.length) state.ui.tableWrap.append(node("p", "takeoff-register-empty", area ? `No matching surfaces. Calibrate the applicable drawing scale, then Trace surface. ${surfaceHelp}` : "No matching items. Calibrate and trace a member/run, or cite a source-stated length."));
  }
  function renderItemSettingsTools(content, item, editor) {
    editor.tools = node("section", "takeoff-settings-tools"); content.append(editor.tools);
    refreshItemSettingsTools(editor);
  }
  function refreshItemSettingsTools(editor) {
    if (!editor.tools || editor.toolsRevision === state.session.revision) return;
    const selected = settingsSelectedItems(); if (selected.length !== 1 || isCount(selected[0])) return;
    renderItemSettingsActions(editor.tools, selected[0]); editor.toolsRevision = state.session.revision;
  }
  function renderItemSettingsActions(panel, item) {
    const result = itemResult(item), area = isSurface(item);
    panel.replaceChildren(node("h3", "", `ITEM DETAILS · ${item.fields.mark || item.id.slice(0, 8)}`), node("p", "takeoff-identity", item.id), node("p", "helper", `${reviewStatus(item).label.toUpperCase()} · Version ${item.version} · ${item.measurement?.method === "cited" ? "Source-stated" : "Calibrated"} ${area ? "surface area" : "length"}`));
    const sessionId = state.session?.session_id;
    const currentAction = action => async () => { await flushSettings(); requireFinishedEdits(); if (sessionId !== state.session?.session_id) throw new Error("The project changed. Choose the item again."); const current = items().find(value => value.id === item.id); if (!current) throw new Error("This item is no longer available."); return action(current); };
    if (item.purpose === "length-only") {
      panel.append(node("p", "takeoff-calibration-summary", `Length: ${formatLength(result.length_m)} m · ${snapshot().calibrations.find(value => value.id === item.measurement?.calibration_id)?.name || "Missing calibration"}`),
        button(item.measurement ? "Change length calibration" : "Attach length calibration", currentAction(changeLength)));
      for (const issue of result.issues || []) panel.append(node("p", "takeoff-warning", issueText(issue)));
      return;
    }
    if (!item.geometry) panel.append(node("p", "takeoff-warning", "Source markup is missing. You can inspect and edit this draft, but review and confirmation remain blocked."));
    if (area) panel.append(node("p", "helper takeoff-surface-help", surfaceHelp), node("p", "helper", "Quantity: one physical treatment surface. Other faces or levels require separate evidenced items."));
    if (item.mode === "steel") panel.append(button("Find steel section", currentAction(findProfile), "text-button"));
    if (item.mode === "duct") {
      panel.append(node("p", "helper", "New duct records are rectangular. Calculator transfer requires one actual run per item (quantity 1)."));
      if (item.fields.shape !== "rectangular") panel.append(node("p", "takeoff-warning", `Retained ${item.fields.shape || "unspecified-shape"} duct. ${item.fields.diameter_mm != null ? `Original diameter: ${item.fields.diameter_mm} mm. ` : ""}Its original shape and dimensions are preserved; this record cannot transfer to the rectangular duct calculator.`));
      if (item.fields.shape == null || item.fields.shape === "") panel.append(button("Use rectangular duct", currentAction(useRectangularDuct)));
    }
    if (item.member_ids?.length) { const members = node("details"); members.append(node("summary", "helper", `${item.member_ids.length} persistent physical member identities`)); for (const id of item.member_ids) members.append(node("p", "takeoff-identity", id)); panel.append(members); }
    const formatArea = key => Number.isFinite(result[key]) ? `${units.format(result[key])} m²` : "Unresolved";
    panel.append(node("p", "takeoff-calibration-summary", `${area ? `Gross: ${formatArea("gross_area_m2")} · Excluded: ${formatArea("excluded_area_m2")} · Net: ${formatArea("net_area_m2")}` : lengthSummary(item, result)}${item.measurement?.method === "cited" ? ` · ${item.measurement?.citation}` : ` · ${snapshot().calibrations.find(value => value.id === item.measurement?.calibration_id)?.name || "Missing calibration"}`}`));
    const actions = node("div", "actions"); actions.append(button("Delete item", currentAction(current => deleteItems([current.id]))));
    panel.append(actions); for (const issue of result.issues || []) panel.append(node("p", "takeoff-warning", issueText(issue)));
    if (!area) renderLengthAdditions(panel, item, currentAction);
    if (area) {
      const entries = item.geometry?.exclusions || [], exclusions = node("div", "takeoff-exclusions"); exclusions.append(node("h3", "", `${entries.length} EXCLUDED OPENINGS`));
      for (const exclusion of entries) { const entry = node("div", "takeoff-exclusion"), act = action => currentAction(current => { const retained = current.geometry?.exclusions?.find(value => value.id === exclusion.id); if (!retained) throw new Error("This exclusion is no longer available."); return action(current, retained); }); entry.append(node("p", "helper", exclusion.note), node("p", "takeoff-identity", exclusion.id), button("Edit exclusion", act((current, retained) => editAreaBoundary(current, retained.id)), "text-button"), button("Remove exclusion", act(removeAreaExclusion), "text-button")); exclusions.append(entry); }
      panel.append(exclusions);
    }
    for (const evidence of item.evidence || []) panel.append(button(`${documentById(evidence.document_id)?.name || "Missing source"} · p${evidence.page}${evidence.fields?.length ? " · " + evidence.fields.join(", ") : ""}: ${evidence.note}`, () => navigateDocument(evidence.document_id, evidence.page), "text-button"));
  }
  async function useRectangularDuct(item) {
    requireFinishedEdits(); const current = currentLengthItem(item);
    if (current.mode !== "duct" || current.fields.shape != null && current.fields.shape !== "") throw new Error("Only an older duct with no recorded shape can be explicitly set to rectangular. Existing shapes are preserved.");
    await command("update_item", { item_id: current.id, changes: { fields: { shape: "rectangular" } } }, () => !!currentLengthItem(item));
  }
  function lengthSummary(item, result) {
    const format = value => Number.isFinite(value) ? `${formatLength(value)} m` : "—";
    const additions = item.length_additions || [], base = result.base_length_m ?? (additions.length ? null : result.length_m), added = result.additions_length_m ?? (additions.length ? null : 0);
    return `Base: ${format(base)} + riser/drop: ${format(added)} = ${format(result.length_m)} per ${item.mode === "steel" ? "member" : "run"} · Quantity ${item.quantity} · Total: ${format(result.total_length_m)}`;
  }
  function renderLengthAdditions(panel, item, currentAction) {
    const additions = item.length_additions || [], section = node("section", "takeoff-length-additions");
    section.append(node("h3", "", "RISES / DROPS"), node("p", "helper", `Each addition applies to each ${item.mode === "steel" ? "member" : "run"}. The total includes quantity × (base length + all additions). Right-click a control point to insert a manually entered Rise or Drop.`));
    for (const addition of additions) {
      const card = node("div", "takeoff-exclusion");
      card.append(node("strong", "", `${addition.kind === "riser" ? "Rise" : "Drop"} · ${formatLength(addition.length_mm)} mm each`));
      if (addition.note) card.append(node("p", "helper", addition.note));
      if (addition.anchor) card.append(node("p", "helper", `Control point ${addition.anchor.point_index + 1}`));
      const act = action => currentAction(current => { const retained = current.length_additions?.find(value => value.id === addition.id); if (!retained) throw new Error("This rise or drop is no longer available."); return action(current, retained); });
      card.append(button("Edit addition", act(editLengthAddition), "text-button"), button("Remove addition", act(removeLengthAddition), "text-button"));
      section.append(card);
    }
    if (!additions.length) section.append(node("p", "helper", "No riser or drop lengths added."));
    panel.append(section);
  }
  function currentLengthItem(item) {
    const current = items().find(value => value.id === item.id);
    if (!current || current.version !== item.version) throw new Error("This item changed. Inspect the current item and repeat the length edit.");
    if (isArea(current.mode) || !["steel", "duct"].includes(current.mode)) throw new Error("Riser/drop additions belong to length items only.");
    return current;
  }
  function parsedLengthAddition(values, id) {
    if (!["riser", "drop"].includes(values.kind)) throw new Error("Choose Rise or Drop.");
    if (!Number.isFinite(values.length_mm) || values.length_mm <= 0) throw new Error("Enter a positive finite additional length in millimetres.");
    const doc = documentById(values.document_id);
    if (!doc || !Number.isInteger(values.page) || values.page < 1 || values.page > doc.pages.length) throw new Error("Choose an existing source document and page.");
    return { id, kind: values.kind, length_mm: values.length_mm, ...(values.note !== undefined ? { note: values.note } : {}), document_id: doc.id, page: values.page, ...(values.anchor ? { anchor: clone(values.anchor) } : {}) };
  }
  async function editLengthAddition(item, addition, reference) {
    requireFinishedEdits(); const current = currentLengthItem(item), entries = current.length_additions || [];
    if (!addition && entries.length >= 100) throw new Error("An item supports at most 100 riser/drop additions.");
    let anchor = addition?.anchor;
    if (!addition) {
      const target = pointTarget(reference);
      if (target.item.id !== current.id || reference.exclusionId || (current.geometry.kind || "polyline") !== "polyline" || current.measurement.method !== "calibrated") throw new Error("Choose a control point on a traced steel member or duct run.");
      anchor = { point_index: reference.index, point: [...target.ring.points[reference.index]] };
    }
    const values = await ask(addition ? "Edit rise / drop" : "Insert Rise / Drop", [["kind", "Type", [["riser", "Rise"], ["drop", "Drop"]], addition?.kind || "", true], ["length_mm", "Additional length (mm)", "number", addition?.length_mm ?? "", true]], `Enter the additional length for each ${item.mode === "steel" ? "member" : "run"} (quantity ${item.quantity}). The drawing reference is retained automatically. This makes the item unconfirmed; Undo restores the previous edit.`, addition ? "Apply length" : "Add length");
    if (!values) return; currentLengthItem(item);
    if (reference) pointTarget(reference);
    const next = parsedLengthAddition({ ...values, document_id: addition?.document_id || current.geometry.document_id, page: addition?.page || current.geometry.page, ...(addition?.note !== undefined ? { note: addition.note } : {}), anchor }, addition?.id || uuid());
    await command("update_item", { item_id: item.id, changes: { length_additions: addition ? entries.map(value => value.id === addition.id ? next : value) : [...entries, next] } }, () => { currentLengthItem(item); if (reference) pointTarget(reference); return true; });
    state.controlPoint = null; state.controlMenu = false; renderOverlay();
  }
  async function removeLengthAddition(item, addition) {
    requireFinishedEdits(); const current = currentLengthItem(item);
    if (!await confirm("Remove riser / drop?", `${addition.kind === "riser" ? "Riser" : "Drop"}: ${addition.length_mm} mm per ${item.mode === "steel" ? "member" : "run"}. The item becomes unconfirmed and its calculated length decreases. Undo can restore this addition.`, "Remove addition")) return;
    await command("update_item", { item_id: item.id, changes: { length_additions: (current.length_additions || []).filter(value => value.id !== addition.id) } }, () => !!currentLengthItem(item));
  }
  async function findProfile(item) {
    await flushSettings();
    const editor = state.settingsEditor, calculator = state.ui.target.value;
    if (editor?.ids.length !== 1 || editor.ids[0] !== item.id || editor.sessionId !== state.session?.session_id) throw new Error("Open this item's Settings before changing its section.");
    const control = editor.fields.find(field => field.control.name === "section")?.control;
    const data = await ask("Find steel section", [["search", "Section designation", "text", control?.value || item.fields.section || "", true]], "Select an exact section from the existing calculator database.", "Search"); if (!data) return;
    const result = await api(`/profiles?calculator=${encodeURIComponent(calculator)}&search=${encodeURIComponent(data.search)}`); if (!result.items?.length) throw new Error("No exact database candidates. Refine the section search.");
    const choice = await ask("Choose a database section", [["section", "Steel section", result.items.map(row => row.id), "", true]], `${result.total} matches. ${result.items.length} shown.`, "Use section");
    if (choice) { if (state.settingsEditor !== editor || !control?.isConnected || state.ui.target.value !== calculator) throw new Error("Settings or the calculator destination changed. Repeat the section search."); control.value = choice.section; markSettingsEdited(editor, "fields:section"); await applySettings(editor); }
  }
  function itemCalibrations(item) {
    if (!item.geometry) throw new Error("Attach source geometry before selecting its calibration.");
    const all = snapshot().calibrations, superseded = new Set(all.map(value => value.supersedes_id).filter(Boolean));
    return all.filter(value => value.document_id === item.geometry.document_id && value.page === item.geometry.page && !value.deleted && !superseded.has(value.id));
  }
  async function changeLength(item) {
    if (item.purpose === "count-only") throw new Error("Count-only items derive their quantity from markers and have no length basis.");
    if (isCount(item)) return changeCountLength(item);
    if (item.purpose === "length-only") {
      const sessionId = state.session?.session_id, geometry = JSON.stringify(item.geometry), version = item.version;
      const current = () => {
        requireFinishedEdits();
        if (sessionId !== state.session?.session_id) throw new Error("The project changed. Choose the measurement again.");
        const retained = items().find(value => value.id === item.id);
        if (!retained || retained.purpose !== "length-only" || retained.version !== version || JSON.stringify(retained.geometry) !== geometry) throw new Error("This measurement changed. Inspect it and choose its calibration again.");
        return retained;
      };
      const retained = current(), calibrations = itemCalibrations(retained);
      if (!calibrations.length) throw new Error("Create a current calibration on this measurement's source page first.");
      const selected = calibrations.some(value => value.id === retained.measurement?.calibration_id) ? retained.measurement.calibration_id : "";
      const data = await ask("Change length calibration", [["calibration_id", "Source page calibration", calibrations.map(value => [value.id, value.name]), selected, true]], "The existing source line and item identity are retained. Its length is recalculated from this source-page scale and confirmation is cleared.", "Apply calibration");
      if (!data) return;
      const validate = () => { if (!itemCalibrations(current()).some(value => value.id === data.calibration_id)) throw new Error("Choose a current calibration on this measurement's source page."); return true; };
      validate();
      await command("update_item", { item_id: retained.id, changes: { measurement: { method: "calibrated", calibration_id: data.calibration_id } } }, validate);
      return;
    }
    requireFinishedEdits(); const calibrations = itemCalibrations(item), current = calibrations.some(value => value.id === item.measurement?.calibration_id) ? item.measurement.calibration_id : "";
    const data = await ask("Change length basis", [["method", "Length basis", ["calibrated", "cited"], item.measurement?.method, true], ["calibration_id", "Page calibration (for measured geometry)", calibrations.map(value => [value.id, value.name]), current], ["length_m", "Cited length (metres)", "number", item.measurement?.length_m || ""], ["citation", "Source citation", "textarea", item.measurement?.citation || ""]], "This makes the item unconfirmed. Only current calibrations on this item's source page are available. A cited region cannot become a measured run: re-trace its geometry first.");
    if (!data) return;
    if (data.method === "calibrated" && item.measurement?.method === "cited") throw new Error("Re-trace this object's actual geometry before using a calibration.");
    if (data.method === "calibrated" && !calibrations.some(value => value.id === data.calibration_id)) throw new Error("Choose a current calibration on this item's source page.");
    const measurement = data.method === "calibrated" ? { method: "calibrated", calibration_id: data.calibration_id } : { method: "cited", length_m: data.length_m, citation: data.citation };
    await command("update_item", { item_id: item.id, changes: { measurement } });
  }
  async function changeAreaCalibration(item) {
    requireFinishedEdits(); const calibrations = itemCalibrations(item), current = calibrations.some(value => value.id === item.measurement?.calibration_id) ? item.measurement.calibration_id : "";
    const changed = await ask("Change surface calibration", [["calibration_id", "Surface page calibration", calibrations.map(value => [value.id, value.name]), current, true]], "This applies one current source-page scale to the complete surface and all its exclusions. Areas are recalculated by the server and the item becomes unconfirmed. Historical calibration revisions remain retained in project evidence.", "Apply calibration");
    if (!changed) return;
    if (!calibrations.some(value => value.id === changed.calibration_id)) throw new Error("Choose a current calibration on this item's source page.");
    await command("update_item", { item_id: item.id, changes: { measurement: { method: "calibrated", calibration_id: changed.calibration_id } } });
  }
  async function retrace(item) { if (isCount(item)) throw new Error("Count markers retain manually entered lengths. Start a new count for different source evidence."); if (!await discardEditor()) return; await selectItem(item.id); if (!state.calibration) { state.calibration = item.measurement?.calibration_id || ""; renderCalibrations(); } if (!state.calibration) throw new Error("Choose a calibration before re-tracing this item."); setTool(isSurface(item) ? "polygon" : "trace", { retraceId: item.id }); message(`Trace the replacement geometry, then double-click the final point or press Enter. The same item ID is retained and its confirmation is invalidated.${isSurface(item) ? " Existing exclusions keep their source coordinates and must still lie strictly inside the new boundary." : ""}`); }
  async function replaceSource(item) {
    if (isCount(item)) throw new Error("Start a new count on the replacement source page.");
    requireFinishedEdits(); if (!state.viewport) throw new Error("Open the revised source document page first.");
    if (isSurface(item) && item.geometry?.exclusions.length && (item.geometry.document_id !== state.document || item.geometry.page !== state.page)) throw new Error("Remove the existing exclusions before moving this surface to a revised source page. Exclusion coordinates cannot be mapped between drawings automatically; the old boundaries remain in audit history.");
    const choice = await ask("Replace this object's primary source", [["method", isSurface(item) ? "Replacement surface basis" : "Replacement length basis", isSurface(item) ? ["calibrated"] : ["calibrated", "cited"], "", true]], `The current page is ${currentDocument().name}, page ${state.page}. The same physical item ID is retained; its old references remain in evidence and history. The new geometry and measurement will invalidate review, confirmation and linked transfers. Upload revised drawings as new documents first.`, "Mark replacement source");
    if (!choice) return; if (choice.method === "calibrated" && !state.calibration) throw new Error("Select a calibration on the replacement page first.");
    setTool(isSurface(item) ? "polygon" : choice.method === "calibrated" ? "trace" : "cite", { retraceId: item.id });
  }
  async function addEvidence(item) { requireFinishedEdits(); const data = await ask("Link supporting source evidence", [["document_id", "Source document", documents().map(value => [value.id, value.name]), state.document, true], ["page", "Page", "number", state.page, true], ["field", "Source field (blank applies to the whole object)", [["quantity", "Physical quantity"], ...(isSurface(item) ? [["net_area_m2", "Surface area basis"]] : [["length_m", "Length basis"]]), ...fields[item.mode].map(value => [value[0], value[1]])], ""], ["note", "Evidence note / exact reference", "textarea", "", true]], "Supporting evidence does not create another physical object or add quantities. Use the cited page to corroborate this object's fields."); if (data) await command("update_item", { item_id: item.id, changes: { evidence: [...item.evidence, { document_id: data.document_id, page: data.page, note: data.note, ...(data.field ? { fields: data.field === "duct_size" ? ["width_mm", "height_mm"] : [data.field] } : {}) }] } }); }
  async function bulkEdit() { requireFinishedEdits(); const selected = settingsSelectedItems(); if (!selected.length) return; const key = state.ui.bulkField.value; if (key === "quantity" && selected.some(isCount)) throw new Error("Count quantities come from markers and cannot be edited manually."); if (isArea() && key === "quantity") throw new Error("Each surface is one physical object. Create separate evidenced items for other surfaces."); const definition = bulkSelectionFields(selected).find(value => value[0] === key); if (!definition) throw new Error("Choose a bulk edit field supported by every selected item."); const raw = state.ui.bulkValue.value.trim(), dimensions = key === "duct_size" ? parseDuctSize(raw) : null, value = definition[2] === "number" || numericOptionFields.has(key) ? raw === "" ? null : Number(raw) : raw; if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Enter a finite number."); if (!await confirm(`Change ${selected.length} items?`, `${definition[1]} will become ${raw || "blank"} for all selected items, including filtered-out selections. Review and confirmation are invalidated. Undo can restore this edit.`, "Apply bulk change")) return; await command("bulk_update", { item_ids: selected.map(item => item.id), changes: key === "quantity" ? { quantity: value } : { fields: dimensions || { [key]: value } } }); }
  async function selectedCommand(op) { await flushSettings(); requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select at least one item."); await command(op, { item_ids: selected.map(item => item.id) }); }
  async function confirmSelected() { await flushSettings(); requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select items to confirm."); const areaDetail = "Inspect the original true-surface view, every boundary and excluded opening, calibration, gross/excluded/net m², substrate, treatment and fire rating. A wall footprint never establishes wall-face area; no second face or height is inferred. Confirmation permits register export only and does not certify technical suitability."; if (!await confirm(`Confirm ${selected.length} items?`, isArea() ? areaDetail : "Confirm only after inspecting the original drawings, physical quantities, base length, every riser/drop addition, dimensions, fire requirements and source references. Additions apply to each member/run. Deterministic checks must pass. Confirmation does not certify technical suitability.", "Confirm items")) return; await selectedCommand("confirm_items"); }
  async function deleteSelected() { requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) return; return deleteItems(selected.map(item => item.id), { title: `Delete ${selected.length} objects?`, action: "Delete objects" }); }
  function uncertainLinkedOutcome(error) { return error instanceof TypeError || error.uncertainOutcome === true; }
  function finishLinkedOperation(pending, reply) {
    if (pending.sessionId !== state.session?.session_id) throw new Error("The project changed while applying the linked operation.");
    const restored = reply?.snapshot;
    if (!restored || reply.session_id !== pending.sessionId || reply.revision !== pending.payload.expected_revision + 1 ||
        restored.revision !== reply.revision || restored.project_id !== snapshot().project_id || restored.version !== snapshot().version ||
        ![1, 2].includes(restored.version) || typeof restored.audit_head !== "string" ||
        !["items", "documents", "calibrations", "transfers"].every(key => Array.isArray(restored[key])) ||
        !Array.isArray(reply.item_results) || !Array.isArray(reply.issues) ||
        restored.items.some(item => !item?.id || !item.fields || !Array.isArray(item.evidence)) ||
        restored.documents.some(doc => !doc?.id || !Array.isArray(doc.pages)) ||
        reply.item_results.some(result => !result?.id)) throw new Error("The linked edit response is incomplete.");
    if (!pending.calculatorsApplied) {
      window.CeasefireCalculators.applyTakeoffTargets(reply.calculators, pending.reservation);
      pending.calculatorsApplied = true;
    }
    accept(reply); renderData();
  }
  function releaseLinkedOperation(pending) {
    if (pending.reservation) window.CeasefireCalculators.releaseTakeoffTarget(pending.reservation);
    for (const [control, disabled] of pending.lockedControls) if (control.isConnected !== false) control.disabled = disabled;
    working(false);
  }
  async function recoverLinkedOperation() {
    const pending = state.linkedRecovery;
    if (!pending || pending.retrying) return;
    pending.retrying = true;
    try {
      const reply = await api(`/sessions/${pending.sessionId}/${pending.endpoint}`, pending.payload);
      finishLinkedOperation(pending, reply); state.linkedRecovery = null; releaseLinkedOperation(pending);
      message("The linked change is complete. The takeoff and its schedule rows are in sync.");
    } catch (error) {
      message(`The linked change still needs a response. Keep this page open and retry when the connection is available. ${error.message}`, true);
    } finally { pending.retrying = false; }
  }
  function linkedCalculatorOperation(endpoint, calculatorIds, values = {}, guard) {
    const sessionId = state.session?.session_id, revision = state.session?.revision;
    const task = state.queue.then(async () => {
      requireFinishedEdits();
      if (sessionId !== state.session?.session_id || revision !== state.session?.revision) throw new Error("The takeoff changed. Review the current item and repeat this action.");
      if (guard && !guard()) return null;
      working(true); let reservation;
      const lockedControls = [...(state.ui.root.querySelectorAll?.("input,select,textarea,button") || [])].map(control => [control, control.disabled]);
      for (const [control] of lockedControls) control.disabled = true;
      let pending;
      try {
        const bridge = window.CeasefireCalculators, captured = await bridge.captureTakeoffTargets(calculatorIds);
        if (sessionId !== state.session?.session_id || revision !== state.session?.revision) throw new Error("The project changed before linked deletion. No calculator rows were changed.");
        requireFinishedEdits();
        if (guard && !guard()) return null;
        reservation = bridge.reserveTakeoffTargets(calculatorIds, captured.fingerprint);
        const payload = { expected_revision: revision, request_id: uuid(), calculators: captured.calculators, ...values };
        pending = { sessionId, endpoint, payload, reservation, lockedControls };
        let reply;
        try { reply = await api(`/sessions/${sessionId}/${endpoint}`, payload); }
        catch (error) {
          // The same request identity recovers a committed response after a
          // connection failure. It cannot perform the deletion twice.
          if (!uncertainLinkedOutcome(error)) throw error;
          try { reply = await api(`/sessions/${sessionId}/${endpoint}`, payload); }
          catch (retryError) {
            // Keep the exact request and calculator lease until its outcome is
            // recovered. Neither side may be edited or saved independently.
            state.linkedRecovery = pending;
            throw new Error("The linked change needs a response. Keep this page open and choose Retry linked change when the connection is available.");
          }
        }
        try { finishLinkedOperation(pending, reply); }
        catch (error) {
          state.linkedRecovery = pending;
          throw new Error(`The linked response could not be applied. Keep this page open and choose Retry linked change. ${error.message}`);
        }
        return reply;
      } finally {
        if (!state.linkedRecovery) releaseLinkedOperation({ reservation, lockedControls });
      }
    });
    state.queue = task.catch(() => {}); return task;
  }
  async function deleteItems(ids, options = {}) {
    await flushSettings();
    requireFinishedEdits();
    if (state.busy || state.modal) throw new Error("Finish the current operation before deleting an item.");
    const selected = ids.map(id => items().find(item => item.id === id));
    if (!selected.length || selected.some(item => !item)) throw new Error("Choose existing takeoff items to delete.");
    const sessionId = state.session.session_id, revision = state.session.revision;
    const bindings = (snapshot().transfers || []).filter(binding => ids.includes(binding.item_id));
    const calculators = [...new Set(bindings.map(binding => binding.calculator_id))];
    const detail = `Delete ${selected.map(item => item.fields.mark || item.id).join(", ")}? ${bindings.length ? `This also removes ${bindings.length} linked schedule row${bindings.length === 1 ? "" : "s"}. A manually changed linked row blocks deletion so it can be reviewed first.` : "There are no linked schedule rows."} Source documents are retained. Undo last edit restores the item${bindings.length ? " and linked rows" : ""}.`;
    if (!await confirm(options.title || (selected.length === 1 ? "Delete item?" : `Delete ${selected.length} items?`), detail, options.action || "Delete item")) return;
    const guard = () => {
      requireFinishedEdits();
      if (sessionId !== state.session?.session_id || revision !== state.session.revision) throw new Error("The takeoff changed during deletion review. Review it again.");
      return options.guard ? options.guard() : true;
    };
    guard();
    if (calculators.length) await linkedCalculatorOperation("linked-delete", calculators, { item_ids: ids }, guard);
    else await command("delete_items", { item_ids: ids }, guard);
    state.markupMenu = null; state.controlPoint = null; state.controlMenu = false; renderSelection();
    message(`Item${selected.length === 1 ? "" : "s"} deleted${bindings.length ? " with the linked schedule rows" : ""}. Undo last edit restores ${bindings.length ? "both" : "the takeoff"}.`);
  }
  async function undoLastEdit() {
    await flushSettings();
    requireFinishedEdits();
    if (state.busy || state.modal) throw new Error("Finish the current operation before undoing an edit.");
    const linked = state.session?.linked_undo;
    if (!linked) return command("undo");
    const reply = await linkedCalculatorOperation("linked-undo", linked.calculator_ids);
    message("Deleted takeoff items and their linked schedule rows restored. Unrelated calculator edits were preserved."); return reply;
  }
  async function splitSelected() {
    if (isArea()) throw new Error("Surface splitting is unavailable. Group separate physical surfaces without changing their identities.");
    requireFinishedEdits(); const selected = selectedItems(); if (selected.length !== 1) throw new Error("Select one repeated steel group or calibrated duct run to split.");
    const item = selected[0];
    if (item.mode === "steel") {
      if (!Number.isInteger(item.quantity) || item.quantity < 2) throw new Error("A steel split requires at least two explicitly counted physical members.");
      const data = await ask("Partition repeated steel members", [["first_quantity", "Physical members in the first group", "number", 1, true]], `${item.quantity} physical members will be divided into two groups. Each member keeps its original identity, per-member length, drawing geometry and evidence. This does not cut a member or infer new quantities. Both groups require review again.`, "Partition members");
      if (!data) return;
      if (!Number.isInteger(data.first_quantity) || data.first_quantity <= 0 || data.first_quantity >= item.quantity) throw new Error(`Enter a whole number from 1 to ${item.quantity - 1}.`);
      await command("split_steel_group", { item_id: item.id, quantities: [data.first_quantity, item.quantity - data.first_quantity] }); return;
    }
    if (item.quantity !== 1 || item.measurement?.method !== "calibrated") throw new Error("Duct splitting requires one individually traced run. Cited source lengths need individually evidenced replacements.");
    const data = await ask("Split this physical run", [["percentage", "Split position (% of traced length)", "number", 50, true]], "Use a real branch or change of dimensions, orientation or system. Two new IDs replace this item and require review.", "Split run"); if (!data) return;
    const parts = G.split(item.geometry.points, data.percentage / 100).map(points => ({ mode: item.mode, geometry: { ...item.geometry, points }, measurement: clone(item.measurement), quantity: item.quantity, fields: clone(item.fields), evidence: clone(item.evidence) })); await command("split_item", { item_id: item.id, parts });
  }
  async function mergeSelected() {
    if (isArea()) throw new Error("Surface merging is unavailable. Group separate physical surfaces without changing their identities.");
    requireFinishedEdits(); const selected = selectedItems();
    if (selected.length >= 2 && selected.every(item => item.mode === "steel")) {
      if (await confirm("Merge repeated-member groups?", "Only groups with identical fields, per-member length basis and source geometry can be combined. Every physical member identity and evidence reference is retained. This does not join geometric segments. The combined group requires review again.", "Merge steel groups")) await command("merge_steel_groups", { item_ids: selected.map(item => item.id) });
      return;
    }
    if (selected.length !== 2) throw new Error("Select compatible steel groups or exactly two adjoining segments of one duct run.");
    const [a, b] = selected; if (a.mode !== "duct" || a.quantity !== 1 || b.quantity !== 1) throw new Error("Duct merging applies only to segments of one individual run. Use Group for separate objects.");
    if (a.measurement.method !== "calibrated" || b.measurement.method !== "calibrated" || a.measurement.calibration_id !== b.measurement.calibration_id || a.geometry.document_id !== b.geometry.document_id || a.geometry.page !== b.geometry.page) throw new Error("Merge requires two calibrated segments on the same page and calibration.");
    const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.001; let left = clone(a.geometry.points), right = clone(b.geometry.points); if (same(left[0], right[0])) left.reverse(); else if (same(left[0], right[right.length - 1])) { left.reverse(); right.reverse(); } else if (same(left[left.length - 1], right[right.length - 1])) right.reverse();
    if (!same(left[left.length - 1], right[0])) throw new Error("Segments must share an endpoint; merging must not invent connecting geometry.");
    if (!await confirm("Merge one physical object?", "Only use this when both segments are genuinely the same object with matching size, system and physical quantity. Grouping is the correct choice for separate objects. The replacement gets a new ID and requires review.", "Merge segments")) return;
    await command("merge_items", { item_ids: selected.map(item => item.id), item: { mode: a.mode, geometry: { ...a.geometry, points: [...left, ...right.slice(1)] }, measurement: clone(a.measurement), quantity: a.quantity, fields: clone(a.fields), evidence: [...a.evidence, ...b.evidence] } });
  }
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
          setProgress(`Uploading ${file.name}: ${Math.round(offset / file.size * 100)}% (${done + 1}/${files.length})`);
          const response = await fetch(`/api/takeoffs/sessions/${sessionId}/uploads/${uploadId}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + 8 * 1024 * 1024) });
          if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Upload chunk failed."); }
        }
        setProgress(`Checking original PDF and page metadata: ${file.name}…`);
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
        setProgress(`Text search: ${checked}/${total} pages inspected · ${state.searchHits.length} matches · ${empty} without searchable text · ${failed} failed`);
        if (timedOut) break;
        if (state.searchHits.length >= 500) { setProgress(state.ui.progress.textContent + " · Stopped at 500 matches; coverage is incomplete."); renderOverlay(); return; }
      }
    }
    setProgress(`Text search complete: ${checked}/${total} pages inspected · ${state.searchHits.length} matches · ${empty} without searchable text · ${failed} failed. Scanned pages require visual inspection.`); renderOverlay();
  }
  async function transfer(updateLinked) {
    await flushSettings();
    if (isArea() && !selectedItems().some(isStandalone)) throw new Error("Area records export as m² and cannot transfer to the existing steel or duct calculators.");
    requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select confirmed items to transfer.");
    if (selected.some(isStandalone)) throw new Error("Count-only and length-only measurements cannot transfer to any calculator. Select calculator items separately.");
    const calculatorId = state.ui.target.value, sessionId = state.session.session_id, revision = state.session.revision;
    const current = () => { requireFinishedEdits(); if (sessionId !== state.session?.session_id || revision !== state.session.revision || calculatorId !== state.ui.target.value) throw new Error("Takeoffs or the destination changed during transfer review. Preview again."); };
    const target = await window.CeasefireCalculators.captureTakeoffTarget(calculatorId); current();
    const preview = await api(`/sessions/${sessionId}/transfer-preview`, { expected_revision: revision, calculator_id: calculatorId, inputs: target.inputs, schedule_rows: target.schedule_rows, item_ids: selected.map(item => item.id), update_linked: updateLinked }); current();
    const skipped = preview.skipped?.length || 0, actionable = new Set(preview.changes.map(change => change.item_id)), transferring = selected.filter(item => actionable.has(item.id));
    if (!transferring.length) { message(`All ${skipped} selected item${skipped === 1 ? " is" : "s are"} already linked to ${calculatorName(calculatorId)}. No rows were added or changed.`); return; }
    const sourceResults = transferring.map(item => clone(itemResult(item)));
    const choices = await api(`/options?calculator=${encodeURIComponent(calculatorId)}`);
    current(); const accepted = await confirm(`${updateLinked ? "Update" : "Transfer"} ${transferring.length} confirmed items?`, transferSummary(preview, selected, sourceResults, choices.columns), updateLinked ? "Update linked rows" : "Add to schedule"); if (!accepted) return;
    current();
    if (sessionId !== state.session?.session_id || preview.revision !== state.session.revision) throw new Error("Takeoffs changed during transfer review. Preview again.");
    const reservation = window.CeasefireCalculators.reserveTakeoffTarget(calculatorId, target.fingerprint); working(true);
    try { const result = await api(`/sessions/${sessionId}/transfer-apply`, { expected_revision: state.session.revision, request_id: uuid(), preview_id: preview.preview_id, inputs: target.inputs, schedule_rows: target.schedule_rows }); window.CeasefireCalculators.applyTakeoffTarget(calculatorId, result.transfer, reservation); accept(result); renderData(); message(`Confirmed quantities applied to the calculator draft.${skipped ? ` Skipped ${skipped} already-linked item${skipped === 1 ? "" : "s"}; their rows were unchanged.` : ""} Save the project to retain both the schedule and its source links.`); }
    finally { window.CeasefireCalculators.releaseTakeoffTarget(reservation); working(false); }
  }
  function calculatorName(id) { return { steel_vermiculite: "Steel Spray", steel_board: "Steel Board", ductwork: "Ductwork" }[id] || id; }
  function boundInputDetails(binding, columns) {
    const labels = new Map(columns.map(column => [column.column, column.label]));
    return Object.entries(binding.values || {}).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([address, value]) => { const label = labels.get(address.replace(/\d+$/, "")) || address; return `${label}: ${typeof value === "number" && /\b(length|lineal|girth)\b/i.test(label) ? formatLength(value) : String(value)}`; }).join("\n");
  }
  function transferSummary(preview, selected, results, columns) {
    const objects = new Map(selected.map(item => [item.id, item])), quantities = new Map(results.map(result => [result.id, result]));
    const sections = preview.changes.map(change => {
      const item = objects.get(change.item_id), result = quantities.get(change.item_id), binding = preview.bindings.find(value => value.item_id === change.item_id);
      const action = { append: "Add", update: "Update", unchanged: "Keep unchanged" }[change.action] || change.action;
      return `${action}: ${item.fields.mark || item.id}\nSource ID: ${item.id}\nDestination: ${calculatorName(preview.calculator_id)} · ${binding.sheet} row ${binding.row}\nPhysical quantity: ${item.quantity}\n${item.mode === "steel" ? "Per-member" : "Per-run"} length: ${formatLength(result.length_m)} m\nTotal length: ${formatLength(result.total_length_m)} m\n\nDestination inputs:\n${boundInputDetails(binding, columns)}`;
    });
    if (preview.skipped?.length) sections.unshift(`Skipped ${preview.skipped.length} already-linked item${preview.skipped.length === 1 ? "" : "s"} in ${calculatorName(preview.calculator_id)}: ${preview.skipped.map(entry => objects.get(entry.item_id)?.fields.mark || entry.item_id).join(", ")}. Their existing rows will remain unchanged.`);
    for (const change of preview.normalizations || []) {
      const item = objects.get(change.item_id), label = fields[item?.mode]?.find(field => field[0] === change.field)?.[1] || change.field;
      sections.push(`Existing calculator adjustment for ${item?.fields.mark || change.item_id}: ${label}\n${change.before} → ${change.after}\nReason: ${change.reason}`);
    }
    for (const warning of preview.warnings || []) sections.push(typeof warning === "string" ? warning : `${warning.status || "Calculator note"}${warning.item_id ? ` · ${objects.get(warning.item_id)?.fields.mark || warning.item_id}` : ""}\n${warning.message || warning.reason || "Review the calculator notes before applying."}`);
    return sections.join("\n\n────────────────────\n\n");
  }
  async function detachSelected() { if (isArea()) throw new Error("Area records have no calculator transfer links."); requireFinishedEdits(); const selected = selectedItems(); if (!selected.length) throw new Error("Select linked items to detach."); if (await confirm(`Detach links for ${selected.length} items?`, "The existing calculator values remain as manual schedule entries and remain in totals. Review or remove those manual rows before adding successor items. Future takeoff edits will no longer update detached rows.", "Detach links")) await command("detach_transfers", { item_ids: selected.map(item => item.id), calculator_id: state.ui.target.value }); }
  function linkedRowLabel(binding) {
    const calculator = calculatorName(binding.calculator_id);
    const current = items().find(item => item.id === binding.item_id), mark = current?.fields.mark || binding.values?.[`A${binding.row}`] || `Source ${binding.item_id.slice(0, 8)}`;
    return `${calculator} · ${binding.sheet} row ${binding.row} · ${mark} · ${current ? "retained source link" : "source replaced or deleted"}`;
  }
  async function manageLinkedRows(itemId) {
    if (isArea() && !itemId) throw new Error("Area records have no calculator transfer links.");
    requireFinishedEdits();
    const bindings = (snapshot()?.transfers || []).filter(binding => itemId ? binding.item_id === itemId : binding.calculator_id === state.ui.target.value).sort((a, b) => a.row - b.row);
    if (!bindings.length) { message("There are no retained links for this destination or source."); return; }
    let offset = 0;
    for (;;) {
      const choices = bindings.slice(offset, offset + 100).map(binding => [binding.id, linkedRowLabel(binding)]);
      if (offset) choices.unshift(["previous", "Previous 100 linked rows"]);
      if (offset + 100 < bindings.length) choices.push(["next", "Next 100 linked rows"]);
      const chosen = await ask("Linked calculator rows", [["link_id", "Linked row or page", choices, "", true]], `Showing ${offset + 1}–${Math.min(offset + 100, bindings.length)} of ${bindings.length} retained links. This includes sources that were replaced or deleted. Select a row to review its link, or another page. Detaching leaves its manual quantities in calculator totals.`, "Review selected link");
      if (!chosen) return;
      if (chosen.link_id === "previous") { offset -= 100; continue; }
      if (chosen.link_id === "next") { offset += 100; continue; }
      const binding = bindings.find(value => value.id === chosen.link_id); if (!binding) throw new Error("Choose an existing linked row.");
      const calculatorOptions = await api(`/options?calculator=${encodeURIComponent(binding.calculator_id)}`);
      const detail = `${linkedRowLabel(binding)}\nOriginal source ID: ${binding.item_id}\n\nDetaching keeps every calculator value unchanged. Its manual quantities remain in totals and must be reviewed or removed in the calculator before adding successor items. No row or quantity is deleted by this action.\n\nRetained input values:\n${boundInputDetails(binding, calculatorOptions.columns)}`;
      if (await confirm(`Detach workbook row ${binding.row}?`, detail, "Detach link")) { await command("detach_transfers", { item_ids: [binding.item_id], calculator_id: binding.calculator_id }); message("Link detached. Its manual calculator quantities remain in totals; review or remove that row before adding successor items."); }
      return;
    }
  }
  async function exportRegister(format) { requireFinishedEdits();
    const ids = selectedItems().map(item => item.id); if (!ids.length) throw new Error("Select confirmed register items to export. All selected items must be eligible.");
    const response = await fetch(`/api/takeoffs/sessions/${state.session.session_id}/export/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selected_ids: ids }) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Register export failed."); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = `CEASEFIRE-${labels[state.mode]}-Takeoff.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); message(`Exported ${ids.length} selected confirmed items with their source identities.`);
  }
  async function downloadTakeoff(format) {
    requireFinishedEdits();
    if (state.busy || state.modal || !state.session) throw new Error("Finish the current takeoff operation before downloading.");
    const mode = state.mode, scope = state.physicalScope, sessionId = state.session.session_id, revision = state.session.revision, documentId = state.document;
    if (mode === "physical" && format !== "marked-pdf") throw new Error("Use the physical draft CSV/XLSX export controls for penetration records.");
    const pdf = format === "marked-pdf", list = mode === "physical" ? (physicalGraph()?.barriers || []).filter(entity => !entity.deleted && entity.marker?.document_id === documentId) : pdf ? visibleItems().filter(item => item.measurement && !state.hidden.has(item.id) && item.geometry?.document_id === documentId) : items().filter(item => item.mode === mode);
    if (pdf && !documentId) throw new Error("Open the PDF to download its visible markups.");
    if (!list.length && !pdf) throw new Error("There are no items in this takeoff type to download.");
    working(true);
    try {
      const calculatorDrafts = {}, calculatorFingerprints = [], destinations = mode === "steel" ? ["steel_vermiculite", "steel_board"] : mode === "duct" ? ["ductwork"] : [];
      for (const id of destinations) {
        try { const draft = await window.CeasefireCalculators?.captureTakeoffTarget?.(id); if (draft) { calculatorDrafts[id] = { inputs: draft.inputs, schedule_rows: draft.schedule_rows }; calculatorFingerprints.push(draft.fingerprint); } }
        catch { /* An unavailable/invalid calculator cannot supply coating or layer values. */ }
      }
      const assertCalculatorDrafts = () => { if (calculatorFingerprints.length && calculatorFingerprints.some(fingerprint => typeof fingerprint !== "string" || fingerprint !== window.CeasefireCalculators?.projectFingerprint?.())) throw new Error("The calculator draft changed during export. Download again from the current draft."); };
      assertCalculatorDrafts();
      if (state.session?.session_id !== sessionId || state.session.revision !== revision || mode === "physical" && scope !== state.physicalScope) throw new Error("The project changed while preparing the download. Export the current draft again.");
      const response = await fetch(`/api/takeoffs/sessions/${sessionId}/export/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: revision, mode: mode === "physical" ? "penetrations" : mode, item_ids: list.map(item => item.id), ...(pdf ? { document_id: documentId } : {}), ...(mode === "physical" ? { physical_scope: scope } : { calculator_drafts: calculatorDrafts }) }) });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Takeoff download failed."); }
      const blob = await response.blob();
      if (state.session?.session_id !== sessionId || state.session.revision !== revision || mode === "physical" && scope !== state.physicalScope) throw new Error("The project changed during the download. Export the current draft again.");
      assertCalculatorDrafts();
      const url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = `CEASEFIRE-${mode === "physical" ? scope === "service_plans" ? "Service-Plans" : "Defect-Reports" : labels[mode]}-${pdf ? "Marked-drawing.pdf" : "Takeoff-schedule.xlsx"}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      message(mode === "physical" ? `Downloaded the original PDF with ${list.length} barrier markers and current Barrier/Services callouts. The exported records remain an unapproved draft.` : pdf ? `Downloaded the current PDF with ${list.length} visible ${labels[mode].toLowerCase()} markups across its pages. Unavailable calculator coating/layers are labelled explicitly.` : `Downloaded all ${list.length} ${labels[mode].toLowerCase()} items, including hidden and unconfirmed records, with confirmation status.`);
    } finally { working(false); }
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
    const data = await ask("Revise page calibration", [["name", "Calibration name", "text", calibration.name, true], ["distance_m", "Known real distance (metres)", "number", calibration.distance_m, true]], `This creates a new manual calibration revision and invalidates confirmation and transfer links for ${affected} dependent items. The original calibration is retained. To set a printed ratio instead, choose its 1:N preset from the calibration dropdown. To change the baseline of a viewport, use Calibrate inside its boundary.`, "Revise calibration");
    if (!data) return; if (!(data.distance_m > 0)) throw new Error("Enter a positive known distance.");
    const result = await command("update_calibration", { calibration_id: calibration.id, changes: { ...data, scale_denominator: null, uniform_scale: true } });
    state.calibration = result.revised_calibration_id || ""; renderCalibrations();
  }
  function projectSnapshot() { if (state.busy || state.modal || state.countFinishing || state.physicalPlacing) throw new Error("Finish the current takeoff operation before saving."); if (state.formDirty || state.settingsDirty || state.gesture || state.points.length || state.pendingViewport || physicalUnfinished()) throw new Error("Apply or discard the unfinished takeoff settings, drawing or physical edits before saving."); if (!state.session || !snapshot().documents.length && !snapshot().items.length && !snapshot().calibrations.length && !snapshot().transfers.length && !snapshot().physical && !snapshot().service_plans && !snapshot().image_extractions?.length) return undefined; return clone(snapshot()); }
  function projectFingerprint() { return JSON.stringify({ session_id: state.session?.session_id, snapshot: snapshot(), busy: state.busy, formDirty: state.formDirty, formRevision: state.formRevision || 0, settingsDirty: state.settingsDirty, settingsRevision: state.settingsRevision || 0, gesture: state.gesture ? { kind: state.gesture.kind, initial: state.gesture.initial, current: state.gesture.current } : null, physicalUnfinished: physicalUnfinished(), physicalEditRevision: state.physicalUI?.editRevision?.() || 0, points: state.points, countEntries: state.countEntries.map(({ point, length_m }) => ({ point, length_m })), countDefaultLength: state.countDefaultLength, countFinishing: state.countFinishing, pendingViewport: state.pendingViewport, modal: state.modal }); }
  function hasUnsavedChanges() { return state.busy || state.countFinishing || state.physicalPlacing || state.formDirty || state.settingsDirty || !!state.gesture || !!state.pendingViewport || physicalUnfinished() || state.points.length > 0 || !!state.session && snapshotKey(snapshot()) !== state.saved; }
  async function prepareDefaults() { if (state.busy) throw new Error("Wait for the takeoff operation to finish."); return { session: null, saved: null }; }
  async function prepareProject(value, sessionId) { if (state.busy) throw new Error("Wait for the takeoff operation to finish."); if (!value) return prepareDefaults(); if (!sessionId) throw new Error("This project has takeoffs but no authorised evidence session. Reopen the project from its companion folder."); const session = await api(`/sessions/${sessionId}`); return { session, saved: snapshotKey(session.snapshot) }; }
  function applyProject(prepared) {
    const prior = state.session?.session_id;
    resetCountDraft();
    state.lengthClipboard = null; state.pastePointer = null;
    resetPlanInteraction();
    cancelSelectionGesture(); state.autoScalePages?.clear(); if (state.settingsEditor) clearTimeout(state.settingsEditor.timer); state.settingsOpen = false; state.settingsDirty = false; state.settingsEditor = null;
    const physical = state.physicalUI; state.physicalUI = null; physical?.destroy(); state.physicalSelected.clear(); state.physicalVisible.clear(); state.physicalHovered = null; state.physicalPreviews.clear(); state.physicalScope = "defect_reports"; state.physicalDetailsOpen = false; state.physicalPlacing = false;
    state.generation = (state.generation || 0) + 1; state.opening = null; ++state.renderId; ++state.searchId; state.pending?.cancel?.(); void releaseDocuments();
    state.session = null; state.railKey = null; state.pageError = null; state.saved = prepared.saved; state.document = null; state.page = 1; state.calibration = ""; state.viewportSelection = ""; state.calibrationTarget = null; state.viewportsOpen = false; state.selected.clear(); state.hidden.clear(); state.points = []; state.pendingViewport = null; state.zoomAnchor = null; state.retraceId = null; state.exclusionItemId = null; state.formDirty = false; state.tool = "select"; state.viewport = null; state.searchHits = []; state.resultMap.clear();
    if (prepared.session) accept(prepared.session);
    if (prior && prior !== state.session?.session_id) void discardPreparedSession(prior);
    if (state.ui) { renderData(); state.ui.pageWrap.hidden = true; state.ui.empty.hidden = false; state.ui.searchResults.replaceChildren(); }
  }
  async function discardPreparedSession(sessionId) { if (sessionId && sessionId !== state.session?.session_id) await api(`/sessions/${sessionId}/close`, {}).catch(() => {}); }
  function markProjectSaved(value, captured) { if (!value) return; if (snapshotKey(snapshot()) === snapshotKey(captured || value)) { state.saved = snapshotKey(value); if (state.session) state.session.snapshot = clone(value); } else state.saved = snapshotKey(captured || value); window.CeasefireProject?.changed?.(); }

  async function completeProjectSnapshot() {
    await flushSettings();
    await state.queue;
    await state.physicalUI?.completePendingEdits?.();
    await state.queue;
    return projectSnapshot();
  }
  function scheduleBindings(calculatorId, row) { return (snapshot()?.transfers || []).filter(binding => binding.calculator_id === calculatorId && binding.row === row && binding.status !== "detached"); }
  async function showSource(itemId) { build(); await window.CeasefireTakeoffNavigation?.show?.(); if (!items().some(item => item.id === itemId)) { await safely(() => manageLinkedRows(itemId)); return; } await selectItem(itemId); }
  window.CeasefireTakeoffs = { open, projectSnapshot, projectFingerprint, prepareProject, applyProject, prepareDefaults, markProjectSaved, hasUnsavedChanges, completeProjectSnapshot,
    sessionId: () => state.session?.session_id, scheduleBindings, showSource, discardPreparedSession };
})();
