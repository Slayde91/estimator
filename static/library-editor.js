(() => {
  "use strict";
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const state = { record: null, draft: null, definition: null, result: null, group: null, baseline: null,
    invalid: new Map(), session: 0, version: 0, busy: false, pendingFields: false, open: false, requestRevision: 0, opening: 0, timer: null };
  let actions = {};
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const shiftDecimal = (value, places) => { const [coefficient, exponent = "0"] = String(value).split(/e/i); return Number(`${coefficient}e${Number(exponent) + places}`); };
  const keyFor = (global, column) => `${global ? "global" : "row"}:${column}`;
  const fieldLabel = field => field.label === "Item(s)" ? "Items/Services" : ["System", "System/Install"].includes(field.label) ? "System/Install Details" : field.label;
  const values = global => global ? state.draft.globals : state.draft.rows[0].inputs;
  const fieldGroups = () => state.definition.groups || [...new Set(state.definition.row_fields.map(field => field.group))];
  const stamp = (draft = state.draft, token = state.record?.pricing_token) => JSON.stringify({ draft, pricing_token: token });
  const hasUnsavedChanges = () => state.open && !!state.record && (stamp() !== state.baseline || state.invalid.size > 0);
  async function request(id, action, payload) {
    const response = await fetch(`/api/libraries/penetration/${encodeURIComponent(id)}/${action}`, payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `The library item request failed (${response.status}).`);
    return data;
  }
  function node(tag, className = "", text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; }
  function display(value, format = "number") {
    if (value === null || value === undefined || value === "") return "—";
    if (!numeric(value)) return String(value);
    return format === "currency" ? money.format(value) : format === "percent" ? `${number.format(shiftDecimal(value, 2))}%` : number.format(value);
  }
  function controlText(field, value, precise = false) {
    if (value === null || value === undefined || value === "") return "";
    if (field.type !== "number" || !numeric(value)) return String(value);
    const adjusted = field.format === "percent" ? shiftDecimal(value, 2) : value;
    return precise ? String(adjusted) : number.format(adjusted).replace(/,/g, "");
  }
  function message(text = "", error = false) { const element = $("library-editor-message"); element.textContent = text; element.hidden = !text; element.className = `message${error ? " error" : ""}`; }
  function status(text) {
    $("library-editor-status").textContent = text || (state.busy ? "Working…" : state.invalid.size ? "Check input" : state.result?.errors?.length ? "Review calculation" : hasUnsavedChanges() ? "Unsaved library changes" : "Saved library item");
    for (const id of ["library-editor-save", "library-editor-recalculate", "library-editor-refresh-pricing"]) $(id).disabled = !state.record || state.busy || state.invalid.size > 0;
    $("library-editor-cancel").disabled = state.busy;
  }
  function changed() {
    state.version++; state.result = null; renderOutputs(); status(); actions.changed?.();
  }
  function makeControl(field, global) {
    const session = state.session, key = keyFor(global, field.column), raw = values(global)[field.column] ?? null;
    const long = field.type === "text" && ["T", "U"].includes(field.column);
    const wrapper = node("label", `field${long ? " library-editor-long-text" : ""}`), label = fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : "");
    const control = node(field.type === "select" ? "select" : long ? "textarea" : "input"), problem = node("small", "penetration-field-error");
    control.dataset.libraryEditorField = field.column; control.dataset.libraryEditorGlobal = String(global); control.setAttribute("aria-label", `${global ? "Item allowance" : "Library item"}: ${label}`);
    if (field.type === "select") {
      const empty = node("option", "", "Choose…"); empty.value = ""; control.append(empty);
      for (const value of field.options || []) { const option = node("option", "", value); option.value = String(value); control.append(option); }
      if (raw !== null && raw !== "" && !(field.options || []).some(value => String(value) === String(raw))) { const saved = node("option", "", `Saved value: ${raw} (choose a listed value)`); saved.value = String(raw); saved.disabled = true; control.append(saved); }
    } else {
      control.maxLength = 2000;
      if (long) control.rows = 3; else control.type = "text";
      if (field.type === "number") { control.inputMode = "decimal"; control.autocomplete = "off"; }
    }
    const pending = state.invalid.get(key); control.value = pending ? pending.value : controlText(field, raw);
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    showProblem(pending?.error);
    control.addEventListener("focus", () => { if (session === state.session && field.type === "number" && !state.invalid.has(key)) { control.value = controlText(field, values(global)[field.column], true); control.select?.(); } });
    control.addEventListener(field.type === "select" ? "change" : "input", () => {
      if (session !== state.session || !state.open) return;
      let value = control.value, error = "";
      if (field.type === "number") {
        const text = value.trim();
        if (!text) value = null;
        else if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) error = "Enter a finite number or leave this field blank.";
        else { value = field.format === "percent" ? shiftDecimal(text, -2) : Number(text); if (!Number.isFinite(value) || Math.abs(value) > 1e12) error = "Enter a value between -1,000,000,000,000 and 1,000,000,000,000."; }
      } else if (field.type === "select") {
        value = value === "" ? null : (field.options || []).find(option => String(option) === value);
        if (value === undefined) error = "Choose a listed value.";
      }
      if (error) state.invalid.set(key, { value: control.value, error }); else { state.invalid.delete(key); values(global)[field.column] = value; }
      showProblem(error); changed();
    });
    control.addEventListener("blur", () => {
      if (session !== state.session) return;
      if (!state.invalid.has(key)) control.value = controlText(field, values(global)[field.column]);
      if (state.pendingFields) { state.pendingFields = false; renderFields(); }
    });
    wrapper.append(node("span", "", label), control, problem); return wrapper;
  }
  function renderFields() {
    const groups = fieldGroups(); if (!groups.includes(state.group)) state.group = groups[0];
    $("library-editor-groups").replaceChildren(...groups.map(group => {
      const button = node("button", "penetration-group", group); button.type = "button"; button.dataset.libraryEditorGroup = group; button.setAttribute("aria-pressed", String(group === state.group));
      button.addEventListener("click", () => { state.group = group; renderFields(); }); return button;
    }));
    const fields = node("div", "library-editor-fields"); fields.append(...state.definition.row_fields.filter(field => field.group === state.group).map(field => makeControl(field, false))); $("library-editor-fields").replaceChildren(fields);
    const globals = node("div", "library-editor-fields"); globals.append(...state.definition.global_fields.map(field => makeControl(field, true))); $("library-editor-globals").replaceChildren(globals);
  }
  function renderOutputs() {
    const price = state.result?.rows?.[0]?.outputs?.H ?? (!hasUnsavedChanges() ? state.record.price?.amount ?? state.record.source_price?.amount : null);
    $("library-editor-price").textContent = display(price, "currency");
    $("library-editor-pricing-basis").textContent = state.record.pricing_label || "Workbook prices";
    const labels = { materials: "Materials", labour: "Labour", access: "Access", travel_lafha: "Travel / accommodation", other_allowances: "Other allowances", grand_total: "Grand total", total_days: "Total days", labour_hours: "Labour hours" };
    $("library-editor-summary").replaceChildren(...Object.entries(labels).map(([key, label]) => { const line = node("div", key === "grand_total" ? "subtotal" : ""); line.append(node("dt", "", label), node("dd", "", display(state.result?.summary?.[key], ["total_days", "labour_hours"].includes(key) ? "number" : "currency"))); return line; }));
    const errors = state.result?.errors || [];
    $("library-editor-summary-notes").textContent = errors.length ? errors.map(error => `${error.cell}: ${error.message}`).join("\n") : "Calculated from this library item's inputs and selected pricing basis.";
    const row = state.result?.rows?.[0], breakdown = $("library-editor-breakdown");
    if (!row) { breakdown.replaceChildren(node("p", "helper", "Recalculate to see this item's output.")); return; }
    const groups = new Map(); for (const field of state.definition.output_fields) { if (!groups.has(field.group)) groups.set(field.group, []); groups.get(field.group).push(field); }
    breakdown.replaceChildren(...[...groups].map(([group, fields]) => { const section = node("details", "penetration-output-group"), list = node("dl", "cost-list"); section.open = group === "Summary"; section.append(node("summary", "", group)); for (const field of fields) { const line = node("div"); line.append(node("dt", "", fieldLabel(field) + (field.units ? ` (${field.units})` : "")), node("dd", "", display(row.outputs[field.column], field.format))); list.append(line); } section.append(list); return section; }));
  }
  function present(record, handlers = {}) {
    if (!record?.draft || !record.definition || record.draft.rows?.length !== 1) throw new Error("The library item does not contain one editable source row.");
    state.session++; Object.assign(state, { record: clone(record), draft: clone(record.draft), definition: clone(record.definition), result: clone(record.result || null),
      group: record.definition.groups?.[0], baseline: stamp(record.draft, record.pricing_token), invalid: new Map(), version: 0, busy: false, pendingFields: false, open: true });
    clearTimeout(state.timer); state.requestRevision++;
    actions = { changed: scheduleCalculation, calculate, refreshPricing, save, cancel, ...handlers };
    $("library-editor-identity").textContent = record.title || record.library_id || record.id;
    $("firestopping-project-workspace").hidden = true; $("firestopping-library-editor").hidden = false;
    renderFields(); renderOutputs(); status(); message();
  }
  function close() {
    state.session++; state.requestRevision++; state.opening++; clearTimeout(state.timer);
    Object.assign(state, { open: false, record: null, draft: null, result: null, baseline: null, busy: false, invalid: new Map() });
    $("firestopping-library-editor").hidden = true; $("firestopping-project-workspace").hidden = false;
  }
  function inputProblem() { return state.invalid.size ? "Correct the library item input marked invalid before continuing." : ""; }
  function snapshot() { return { id: state.record.id, session: state.session, version: state.version, payload: { draft: clone(state.draft), revision: state.record.revision, pricing_token: state.record.pricing_token } }; }
  function current(captured) { return state.open && state.session === captured.session && state.record.id === captured.id; }
  function refreshFields() {
    if (document.activeElement?.dataset?.libraryEditorField) { state.pendingFields = true; return; }
    renderFields();
  }
  function adopt(record, keepDraft = false) {
    state.record = clone(record); state.definition = clone(record.definition);
    if (!keepDraft) state.draft = clone(record.draft);
    state.result = keepDraft ? null : clone(record.result || null);
    $("library-editor-identity").textContent = record.title || record.library_id || record.id;
    refreshFields(); renderOutputs(); status();
  }
  async function open(id) {
    if (state.open) {
      if (state.record.id !== id) message(`Finish editing ${state.record.library_id || state.record.title} or cancel it before opening another library item.`, true);
      window.CeasefireLibraryEditorNavigation?.show(); return;
    }
    const opening = ++state.opening, record = await request(id, "edit");
    if (opening !== state.opening) return;
    present(record); window.CeasefireLibraryEditorNavigation?.show();
  }
  function scheduleCalculation() {
    clearTimeout(state.timer);
    if (!state.busy && !state.invalid.size) state.timer = setTimeout(calculate, 350);
  }
  async function calculate() {
    clearTimeout(state.timer);
    if (!state.open || state.busy || state.invalid.size) return;
    const captured = snapshot(), revision = ++state.requestRevision;
    state.busy = true; status("Calculating…");
    try {
      const record = await request(captured.id, "calculate", captured.payload);
      if (!current(captured) || revision !== state.requestRevision || state.version !== captured.version || state.invalid.size) return;
      adopt(record); message();
    } catch (error) { if (current(captured) && revision === state.requestRevision) message(error.message, true); }
    finally {
      if (current(captured) && revision === state.requestRevision) { state.busy = false; status(); if (state.version !== captured.version) scheduleCalculation(); }
    }
  }
  async function refreshPricing() {
    document.activeElement?.blur?.(); clearTimeout(state.timer);
    if (!state.open || state.busy || state.invalid.size) return;
    const captured = snapshot(), revision = ++state.requestRevision;
    let reschedule = false; state.busy = true; status("Refreshing pricing…");
    try {
      const record = await request(captured.id, "refresh-pricing", captured.payload);
      if (!current(captured) || revision !== state.requestRevision) return;
      const later = state.version !== captured.version || state.invalid.size > 0;
      adopt(record, later); state.version++; reschedule = later;
      message("Current saved Pricing Library rates are ready to review. Save Library Item to retain them.");
    } catch (error) { if (current(captured) && revision === state.requestRevision) message(error.message, true); }
    finally { if (current(captured) && revision === state.requestRevision) { state.busy = false; status(); if (reschedule) scheduleCalculation(); } }
  }
  async function save() {
    document.activeElement?.blur?.(); clearTimeout(state.timer);
    if (!state.open || state.busy || state.invalid.size) return;
    const captured = snapshot(), revision = ++state.requestRevision;
    let reschedule = false; state.busy = true; status("Saving library item…");
    try {
      const record = await request(captured.id, "save", captured.payload);
      if (!current(captured) || revision !== state.requestRevision) return;
      const later = state.version !== captured.version || state.invalid.size > 0;
      adopt(record, later); state.baseline = stamp(record.draft, record.pricing_token);
      window.CeasefireLibraries?.invalidate?.();
      if (later) { reschedule = true; message("The captured library item was saved. Your later edits are still here and have not been saved."); }
      else { close(); window.CeasefireLibraryEditorNavigation?.returnToLibrary(captured.id); }
    } catch (error) { if (current(captured) && revision === state.requestRevision) message(`Library item was not saved. ${error.message}`, true); }
    finally { if (current(captured) && revision === state.requestRevision) { state.busy = false; status(); if (reschedule) scheduleCalculation(); } }
  }
  function cancel() {
    if (!state.open || state.busy) return;
    const id = state.record.id; close(); window.CeasefireLibraryEditorNavigation?.returnToLibrary(id);
  }
  $("library-editor-recalculate").addEventListener("click", () => actions.calculate?.());
  $("library-editor-refresh-pricing").addEventListener("click", () => actions.refreshPricing?.());
  $("library-editor-save").addEventListener("click", () => actions.save?.());
  $("library-editor-cancel").addEventListener("click", () => actions.cancel?.());
  window.CeasefireLibraryEditor = { open, present, close, isOpen: () => state.open, hasUnsavedChanges, inputProblem };
})();
