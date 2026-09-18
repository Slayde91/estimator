(() => {
  "use strict";
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const state = { definition: null, draft: null, saved: null, selected: null, group: null, result: null,
    revision: 0, context: 0, requestRevision: 0, invalid: new Map(), removed: [], timer: null,
    loading: false, calculating: false, downloading: false, page: 0, pendingFields: false,
    creatingLibrary: false, addingLibrary: false, libraryCapture: null };
  const definitions = new Map(), pageSize = 50;
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const configuration = () => clone(window.CeasefireProject?.configuration?.() || { inventory: {}, rates: {} });
  const configStamp = () => JSON.stringify(configuration());
  const keyFor = (rowId, column) => JSON.stringify([rowId, column]);
  const fieldLabel = field => field.label === "Item(s)" ? "Items/Services" : ["System", "System/Install"].includes(field.label) ? "System/Install Details" : field.label;
  const rowById = id => state.draft?.rows.find(row => row.id === id);
  const selected = () => rowById(state.selected);
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
  function shiftDecimal(value, places) { const [coefficient, exponent = "0"] = String(value).split(/e/i); return Number(`${coefficient}e${Number(exponent) + places}`); }
  function display(value, format = "number") {
    if (value === null || value === undefined || value === "") return "—";
    if (!numeric(value)) return String(value);
    return format === "currency" ? currency.format(value) : format === "percent" ? `${number.format(shiftDecimal(value, 2))}%` : number.format(value);
  }
  async function request(path, payload) {
    const response = await fetch(path, payload === undefined ? { headers: { Accept: "application/json" } } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`); return data;
  }
  function message(text = "", error = false) { const el = $("penetration-message"); el.textContent = text; el.hidden = !text; el.className = `message${error ? " error" : ""}`; }
  function hasUnsavedChanges() { return !!state.draft && (JSON.stringify(state.draft) !== state.saved || state.invalid.size > 0); }
  function status(text) {
    $("penetration-status").textContent = text || (state.invalid.size ? "Check input" : state.calculating ? "Calculating…" : state.result?.errors?.length ? "Review calculation" : hasUnsavedChanges() ? "Unsaved changes" : "Calculated");
    const blocked = !state.draft || state.invalid.size > 0;
    for (const id of ["penetration-recalculate", "penetration-pdf", "penetration-excel"]) $(id).disabled = blocked || state.downloading;
    $("penetration-add").disabled = blocked || state.draft.rows.length >= (state.definition.capacity || 1000);
    $("penetration-undo").disabled = blocked || !state.removed.length;
    $("penetration-add-to-library").disabled = blocked || state.creatingLibrary;
    for (const button of $("penetration-schedule-body").querySelectorAll("[data-penetration-remove]")) button.disabled = blocked;
    window.CeasefireProject?.changed?.();
  }
  async function definitionFor(pricing) {
    const key = JSON.stringify(pricing);
    if (!definitions.has(key)) {
      const pending = request("/api/penetration/definition", { configuration: pricing }).catch(error => { definitions.delete(key); throw error; });
      definitions.set(key, pending);
      if (definitions.size > 4) definitions.delete(definitions.keys().next().value);
    }
    return definitions.get(key);
  }
  function checkDraft(draft, definition) {
    if (!draft || typeof draft.globals !== "object" || !draft.globals || Array.isArray(draft.globals) || !Array.isArray(draft.rows) || !draft.rows.length || draft.rows.length > definition.capacity) throw new Error("The penetration schedule is incomplete or exceeds its row capacity.");
    const ids = new Set();
    for (const row of draft.rows) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || !row.inputs || typeof row.inputs !== "object" || Array.isArray(row.inputs)) throw new Error("The penetration schedule contains an invalid or repeated row.");
      ids.add(row.id);
    }
  }
  async function prepareProject(snapshot, pricing = configuration()) {
    const definition = await definitionFor(clone(pricing));
    if (snapshot?.source_sha256 && snapshot.source_sha256 !== definition.source_sha256) throw new Error("The penetration schedule uses a different source workbook version. Its inputs have been retained.");
    const draft = clone(snapshot?.draft || definition.defaults); checkDraft(draft, definition);
    return { definition, draft, saved: JSON.stringify(draft) };
  }
  function prepareDefaults(pricing = configuration()) { return prepareProject(null, pricing); }
  function applyProject(prepared) {
    ++state.context; ++state.requestRevision; clearTimeout(state.timer);
    Object.assign(state, { definition: prepared.definition, draft: clone(prepared.draft), saved: prepared.saved,
      selected: prepared.draft.rows[0].id, group: prepared.definition.groups[0], result: null,
      revision: 0, invalid: new Map(), removed: [], page: 0, pendingFields: false, calculating: false });
    render(); message();
  }
  async function initialize() {
    if (state.draft) return;
    const context = state.context, prepared = await prepareDefaults();
    if (state.draft) return;
    if (context !== state.context) throw new Error("The project changed while loading penetration inputs. Try again.");
    applyProject(prepared);
  }
  function projectSnapshot() { return state.draft ? { draft: clone(state.draft) } : undefined; }
  function inputProblem() { return state.invalid.size ? "Correct the penetration input marked invalid before saving." : ""; }
  function projectFingerprint() { return JSON.stringify({ context: state.context, draft: state.draft, invalid: [...state.invalid] }); }
  async function completeProjectSnapshot() { await initialize(); if (inputProblem()) throw new Error(inputProblem()); return projectSnapshot(); }
  function markProjectSaved(receipt, captured) {
    if (!receipt?.draft || !state.draft) return;
    const saved = JSON.stringify(receipt.draft);
    if (captured && !state.invalid.size && JSON.stringify(state.draft) === JSON.stringify(captured.draft) && JSON.stringify(state.draft) !== saved) {
      state.draft = clone(receipt.draft); state.revision++; state.result = null;
      if (!rowById(state.selected)) state.selected = state.draft.rows[0].id;
      render();
    }
    state.saved = saved; status();
  }
  function inputValue(field, rowId) { return (rowId === null ? state.draft.globals : rowById(rowId)?.inputs)?.[field.column] ?? null; }
  function controlText(field, value, precise = false) {
    if (value === null || value === undefined || value === "") return "";
    if (field.type !== "number" || !numeric(value)) return String(value);
    const adjusted = field.format === "percent" ? shiftDecimal(value, 2) : value;
    return precise ? String(adjusted) : number.format(adjusted).replace(/,/g, "");
  }
  function changed(rowId) {
    state.removed = state.removed.filter(item => item.placeholder !== rowId && item.row.id !== rowId);
    state.revision++; state.result = null;
    renderSchedule(); renderSummary(); renderBreakdown(); status(); clearTimeout(state.timer);
    state.timer = setTimeout(calculate, 350);
  }
  function makeControl(field, rowId, compact = false) {
    const context = state.context;
    const key = keyFor(rowId, field.column), wrapper = node("label", "field"), label = node("span", "", fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : ""));
    const control = node(field.type === "select" ? "select" : "input"), problem = node("small", "penetration-field-error");
    if (compact) { wrapper.className += " penetration-schedule-quantity"; label.className = "sr-only"; control.dataset.penetrationScheduleQuantity = rowId; }
    const line = rowId === null ? "Project" : `Line ${state.draft.rows.findIndex(row => row.id === rowId) + 1}`;
    control.dataset.penetrationField = field.column; control.dataset.penetrationRow = rowId === null ? "" : rowId;
    control.setAttribute("aria-label", `${line}: ${label.textContent}`);
    const pending = state.invalid.get(key), raw = inputValue(field, rowId);
    if (field.type === "select") {
      const empty = node("option", "", "Choose…"); empty.value = ""; control.append(empty);
      const options = field.options || [];
      for (const value of options) { const option = node("option", "", value); option.value = String(value); control.append(option); }
      if (raw !== null && raw !== "" && !options.some(value => String(value) === String(raw))) {
        const option = node("option", "", `Saved value: ${raw} (choose a listed value)`); option.value = String(raw); option.disabled = true; control.append(option);
      }
    } else {
      control.type = "text"; control.maxLength = 2000;
      if (field.type === "number") { control.inputMode = "decimal"; control.autocomplete = "off"; }
    }
    control.value = pending ? pending.value : controlText(field, raw);
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    showProblem(pending?.error);
    control.addEventListener("focus", () => {
      if (context !== state.context) return;
      if (field.type !== "number" || state.invalid.has(key)) return;
      control.value = controlText(field, inputValue(field, rowId), true);
      // Replacing the rounded display resets the browser's selection. Select
      // the precise value so keyboard and accessibility replacements stay whole.
      control.select?.();
    });
    const apply = () => {
      if (context !== state.context) return;
      if (rowId !== null && !rowById(rowId)) return;
      let value = control.value, error = "";
      if (field.type === "number") {
        const text = value.trim();
        if (!text) value = null;
        else if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) error = "Enter a finite number or leave this field blank.";
        else {
          value = field.format === "percent" ? shiftDecimal(text, -2) : Number(text);
          if (!Number.isFinite(value) || Math.abs(value) > 1e12) error = "Enter a value between -1,000,000,000,000 and 1,000,000,000,000.";
        }
      } else if (field.type === "select") {
        value = value === "" ? null : (field.options || []).find(item => String(item) === value);
        if (value === undefined) error = "Choose a listed value.";
      }
      if (error) state.invalid.set(key, { value: control.value, error });
      else { state.invalid.delete(key); (rowId === null ? state.draft.globals : rowById(rowId).inputs)[field.column] = value; }
      showProblem(error); changed(rowId);
    };
    control.addEventListener(field.type === "select" ? "change" : "input", apply);
    control.addEventListener("blur", () => {
      if (context !== state.context) return;
      if (!state.invalid.has(key)) control.value = controlText(field, inputValue(field, rowId));
      refreshControls();
      if (state.pendingFields) { state.pendingFields = false; renderFields(); }
    });
    wrapper.append(label, control, problem); return wrapper;
  }
  function fieldsActive() { return !!document.activeElement?.dataset?.penetrationField; }
  function renderFields() {
    if (!state.draft) return;
    const row = selected(), groups = state.definition.groups;
    if (!groups.includes(state.group)) state.group = groups[0];
    const buttons = groups.map(group => {
      const button = node("button", "penetration-group", group); button.type = "button"; button.dataset.penetrationGroup = group;
      button.setAttribute("aria-pressed", String(group === state.group));
      button.addEventListener("click", () => { state.group = group; renderFields(); }); return button;
    });
    $("penetration-input-groups").replaceChildren(...buttons);
    $("penetration-row-heading").textContent = `Line ${state.draft.rows.findIndex(item => item.id === row.id) + 1} · ${row.inputs.T || "Item details"}`;
    const fields = node("div", "penetration-fields");
    for (const field of state.definition.row_fields.filter(field => field.group === state.group)) fields.append(makeControl(field, row.id));
    $("penetration-row-fields").replaceChildren(fields);
    const globals = node("div", "penetration-fields");
    for (const field of state.definition.global_fields) globals.append(makeControl(field, null));
    $("penetration-global-fields").replaceChildren(globals);
    $("penetration-project-allowances").hidden = !["Additional Allowances", "Additional materials and labour"].includes(state.group);
  }
  function refreshControls() {
    for (const parent of [$("penetration-row-fields"), $("penetration-global-fields"), $("penetration-schedule-body")]) for (const control of parent.querySelectorAll("[data-penetration-field]")) {
      const rowId = control.dataset.penetrationRow || null, key = keyFor(rowId, control.dataset.penetrationField);
      const pending = state.invalid.get(key), problem = control.parentNode.children[2];
      control.setAttribute("aria-invalid", String(!!pending)); problem.textContent = pending?.error || ""; problem.hidden = !pending;
      if (control === document.activeElement) continue;
      const field = (rowId === null ? state.definition.global_fields : state.definition.row_fields).find(field => field.column === control.dataset.penetrationField);
      if (field) control.value = pending ? pending.value : controlText(field, inputValue(field, rowId));
    }
  }
  function selectRow(id) {
    if (!rowById(id)) return; state.selected = id;
    state.page = Math.floor(state.draft.rows.findIndex(row => row.id === id) / pageSize);
    renderSchedule(); renderFields(); renderBreakdown();
  }
  function newRow() {
    let index = 1; while (rowById(`line-${index}`)) index++;
    const inputs = Object.fromEntries(state.definition.row_fields.filter(field => field.default !== null && field.default !== undefined).map(field => [field.column, clone(field.default)]));
    return { id: `line-${index}`, inputs };
  }
  function libraryDraft(row) {
    const normalized = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? null : value]));
    return { globals: normalized({ ...state.definition.defaults.globals, ...clone(state.draft.globals) }),
      rows: row ? [{ id: row.id, inputs: normalized(clone(row.inputs)) }] : [] };
  }
  function librarySignature(context, payload) {
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return JSON.stringify(ordered({ context, ...payload }));
  }
  async function addToLibrary() {
    document.activeElement?.blur?.();
    if (!state.draft || state.invalid.size || state.creatingLibrary) return;
    const context = state.context, row = selected();
    const payload = { draft: libraryDraft(row), configuration: configuration() };
    const signature = librarySignature(context, payload);
    // Reuse the key after an uncertain response or a second click on this capture.
    if (state.libraryCapture?.signature !== signature) state.libraryCapture = { signature, key: globalThis.crypto.randomUUID() };
    payload.idempotency_key = state.libraryCapture.key;
    state.creatingLibrary = true; status();
    try {
      const record = await request("/api/libraries/penetration", payload);
      if (!record.id || !record.library_id || !record.draft || !record.price) throw new Error("The library did not confirm the saved item. Retry to check the same capture.");
      window.CeasefireLibraries?.invalidate?.(); definitions.clear();
      if (context === state.context) {
        const later = signature !== librarySignature(context, { draft: libraryDraft(rowById(row.id)), configuration: configuration() });
        message(`${record.library_id} ${record.created === false ? "is already in" : "was added to"} the Firestopping Library at ${display(record.price.amount, "currency")}.${later ? " It contains the inputs captured when you clicked Add to Library; later edits are not included." : ""}`);
      }
    } catch (error) { if (context === state.context) message(`Add to Library was not confirmed. ${error.message}`, true); }
    finally { state.creatingLibrary = false; status(); }
  }
  async function addLibraryItem(id) {
    if (state.addingLibrary) throw new Error("A library item is already being added to the schedule.");
    if (window.CeasefireLibraryEditor?.isOpen()) throw new Error("Save or cancel the open library edit before adding an item to the schedule.");
    document.activeElement?.blur?.();
    const context = state.context;
    state.addingLibrary = true;
    try {
      if (!state.draft) {
        const prepared = await prepareDefaults();
        if (context !== state.context) throw new Error("The project changed. Add the library item again when ready.");
        if (window.CeasefireLibraryEditor?.isOpen()) throw new Error("Save or cancel the open library edit before adding an item to the schedule.");
        applyProject(prepared);
      }
      const targetContext = state.context;
      if (state.invalid.size) throw new Error(inputProblem());
      const record = await request(`/api/libraries/penetration/${encodeURIComponent(id)}/edit`);
      if (targetContext !== state.context) throw new Error("The project changed while opening the library item. Nothing was added.");
      if (window.CeasefireLibraryEditor?.isOpen()) throw new Error("Save or cancel the open library edit before adding an item to the schedule.");
      if (state.invalid.size) throw new Error(inputProblem());
      checkDraft(record.draft, state.definition);
      if (record.draft.rows.length !== 1 || record.definition?.source_sha256 !== state.definition.source_sha256) throw new Error("This library item does not match the current Firestopping Estimator calculation source.");
      const empty = state.draft.rows.length === 1 && Object.entries(state.draft.rows[0].inputs).every(([column, value]) => value === null || value === "" || (["Q", "R"].includes(column) && value === "Standard"));
      if (!empty && state.draft.rows.length >= state.definition.capacity) throw new Error("The current schedule is full. Remove a row before adding another item.");
      const row = newRow(); row.inputs = clone(record.draft.rows[0].inputs);
      if (empty) state.draft.rows = [row]; else state.draft.rows.push(row);
      state.removed = []; changed(row.id); selectRow(row.id); clearTimeout(state.timer);
      const addedRevision = state.revision;
      if (window.CeasefirePenetrationNavigation?.show) await window.CeasefirePenetrationNavigation.show(); else await calculate();
      if (targetContext === state.context && rowById(row.id)) {
        const output = state.result?.rows?.find(item => item.id === row.id);
        const total = output?.outputs?.H;
        const priceText = numeric(total) && !output?.errors?.length ? `Recalculated item price: ${display(total, "currency")}.` : "Review the calculation before using its price.";
        message(`${record.library_id} added using the current schedule prices and project allowances. ${priceText}${state.revision !== addedRevision ? " The schedule also contains your later edits." : ""}`);
      }
      return { added: true, id: row.id };
    } finally { state.addingLibrary = false; }
  }
  function addRow() {
    if (!state.draft || state.invalid.size || state.draft.rows.length >= state.definition.capacity) return;
    const row = newRow(); state.draft.rows.push(row); state.removed = []; changed(row.id); selectRow(row.id); calculate();
  }
  function removeRow(id) {
    if (state.invalid.size || !rowById(id)) return;
    const index = state.draft.rows.findIndex(row => row.id === id), row = clone(rowById(id));
    state.draft.rows.splice(index, 1); let placeholder = null;
    if (!state.draft.rows.length) { const blank = newRow(); state.draft.rows.push(blank); placeholder = blank.id; }
    state.removed.push({ row, index, placeholder }); if (state.removed.length > 20) state.removed.shift();
    state.revision++; state.result = null; renderSummary(); selectRow(state.draft.rows[Math.min(index, state.draft.rows.length - 1)].id); status(); calculate();
  }
  function undoRemove() {
    if (state.invalid.size || !state.removed.length) return;
    const removed = state.removed.pop();
    if (removed.placeholder) state.draft.rows = state.draft.rows.filter(row => row.id !== removed.placeholder);
    state.draft.rows.splice(Math.min(removed.index, state.draft.rows.length), 0, removed.row);
    state.revision++; state.result = null; renderSummary(); selectRow(removed.row.id); status(); calculate();
  }
  function renderSchedule() {
    if (!state.draft) return;
    const body = $("penetration-schedule-body"), previous = [...body.children];
    const existing = new Map(previous.filter(row => row.dataset.penetrationContext === String(state.context)).map(row => [row.dataset.penetrationId, row]));
    const quantityField = state.definition.row_fields.find(field => field.column === "O");
    const results = new Map((state.result?.rows || []).map(row => [row.id, row]));
    const rows = state.draft.rows.slice(state.page * pageSize, (state.page + 1) * pageSize).map((row, index) => {
      const line = state.page * pageSize + index + 1, result = results.get(row.id), tr = existing.get(row.id) || node("tr"); tr.dataset.penetrationId = row.id; tr.dataset.penetrationContext = String(state.context);
      tr.className = row.id === state.selected ? "penetration-selected-row" : "";
      const invalid = [...state.invalid.keys()].some(key => JSON.parse(key)[0] === row.id);
      if (!tr.children.length) {
        for (let column = 0; column < 6; column++) tr.append(node("td"));
        if (quantityField) tr.children[3].append(makeControl(quantityField, row.id, true));
      }
      const values = [line, row.inputs.T || "—", row.inputs.U || "—", null, display(result?.outputs.H, "currency"), invalid ? "Check input" : result?.errors?.length ? "Review calculation" : state.calculating ? "Calculating…" : result ? "Calculated" : "—"];
      values.forEach((value, column) => { if (column !== 3) tr.children[column].textContent = String(value); });
      if (!quantityField) tr.children[3].textContent = display(row.inputs.O);
      for (const control of tr.children[3].querySelectorAll("[data-penetration-field]")) control.setAttribute("aria-label", `Line ${line}: ${fieldLabel(quantityField)}`);
      const actions = node("td", "penetration-item-actions"), edit = node("button", "button secondary", "Edit"); edit.type = "button"; edit.setAttribute("aria-label", `Edit penetration line ${line}`); edit.addEventListener("click", () => selectRow(row.id));
      const remove = node("button", "button secondary penetration-remove"), icon = node("span"); icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
      remove.append(icon); remove.type = "button"; remove.dataset.penetrationRemove = row.id; remove.title = `Remove line ${line}`; remove.setAttribute("aria-label", `Remove penetration line ${line}`); remove.disabled = state.invalid.size > 0; remove.addEventListener("click", () => removeRow(row.id));
      actions.append(edit, remove);
      if (tr.children[6]) tr.children[6].replaceChildren(edit, remove); else tr.append(actions);
      return tr;
    });
    // Keeping unchanged rows attached preserves the active quantity editor and
    // its selection while inputs and server results update around it.
    if (rows.length !== previous.length || rows.some((row, index) => row !== previous[index])) body.replaceChildren(...rows);
    refreshControls();
    const count = $("penetration-row-count"); count.replaceChildren(node("span", "", `${state.draft.rows.length} ${state.draft.rows.length === 1 ? "row" : "rows"} · Capacity ${state.definition.capacity}`));
    if (state.draft.rows.length > pageSize) {
      const previous = node("button", "button secondary", "Previous rows"), next = node("button", "button secondary", "Next rows"); previous.type = next.type = "button";
      previous.disabled = state.page === 0; next.disabled = (state.page + 1) * pageSize >= state.draft.rows.length;
      previous.addEventListener("click", () => { state.page--; renderSchedule(); }); next.addEventListener("click", () => { state.page++; renderSchedule(); });
      count.append(previous, node("span", "", `Showing ${state.page * pageSize + 1}–${Math.min((state.page + 1) * pageSize, state.draft.rows.length)} · All rows calculated`), next);
    }
  }
  function renderSummary() {
    const labels = { materials: "Materials", labour: "Labour", access: "Access", travel_lafha: "Travel / accommodation", other_allowances: "Other allowances", grand_total: "Grand total", total_days: "Total days", labour_hours: "Task Hours" };
    $("penetration-summary").replaceChildren(...Object.entries(labels).map(([key, label]) => {
      const line = node("div", key === "grand_total" ? "subtotal" : ""); line.append(node("dt", "", label), node("dd", "", display(state.result?.summary?.[key], ["total_days", "labour_hours"].includes(key) ? "number" : "currency"))); return line;
    }));
    const errors = state.result?.errors || [];
    const globalErrors = errors.filter(error => !error.row_id).map(error => `${error.cell}: ${error.message}`);
    $("penetration-summary-notes").textContent = errors.length
      ? [`${errors.length} calculation ${errors.length === 1 ? "issue" : "issues"}. Review the affected schedule items and totals.`, ...globalErrors].join("\n")
      : "Totals include every schedule row. Pricing follows the current project.";
  }
  function renderBreakdown() {
    const result = state.result?.rows.find(row => row.id === state.selected), container = $("penetration-breakdown");
    container.replaceChildren(window.CeasefirePenetrationBreakdown.render(state.definition, result));
  }
  function render() {
    if (!state.draft) return;
    $("penetration-loading").hidden = true; $("penetration-workspace").hidden = false;
    $("penetration-source").textContent = state.definition.source?.filename || "Firestopping Estimator workbook";
    renderSchedule(); renderFields(); renderSummary(); renderBreakdown(); status("Ready");
  }
  async function calculate() {
    clearTimeout(state.timer);
    try { await initialize(); } catch (error) { message(error.message, true); return; }
    if (state.invalid.size) { status(); return; }
    const context = state.context, revision = state.revision, requestRevision = ++state.requestRevision;
    const pricing = configuration(), pricingKey = JSON.stringify(pricing), draft = clone(state.draft);
    state.calculating = true; status();
    try {
      const data = await request("/api/penetration/calculate", { draft, configuration: pricing });
      if (context !== state.context || revision !== state.revision || requestRevision !== state.requestRevision || pricingKey !== configStamp() || state.invalid.size) return;
      const fieldsChanged = JSON.stringify([state.definition.row_fields, state.definition.global_fields]) !== JSON.stringify([data.definition?.row_fields || state.definition.row_fields, data.definition?.global_fields || state.definition.global_fields]);
      if (data.draft) state.draft = clone(data.draft);
      state.definition = data.definition || state.definition; state.result = data; state.calculating = false;
      renderSchedule(); renderSummary(); renderBreakdown();
      if (fieldsChanged && fieldsActive()) state.pendingFields = true; else if (fieldsChanged) renderFields(); else refreshControls();
      status(); message();
    } catch (error) {
      if (context === state.context && revision === state.revision && requestRevision === state.requestRevision) { state.result = null; renderSchedule(); renderSummary(); renderBreakdown(); message(error.message, true); }
    } finally { if (context === state.context && requestRevision === state.requestRevision) { state.calculating = false; status(); } }
  }
  async function pricingChanged() {
    if (!state.draft) return;
    const context = state.context, pricing = configuration(), key = JSON.stringify(pricing); ++state.requestRevision;
    state.result = null; renderSummary(); renderBreakdown(); renderSchedule();
    try {
      const definition = await definitionFor(pricing);
      if (context !== state.context || key !== configStamp()) return;
      state.definition = definition;
      if (fieldsActive()) state.pendingFields = true; else renderFields();
      await calculate();
    } catch (error) { if (context === state.context && key === configStamp()) message(error.message, true); }
  }
  async function open() {
    state.loading = true;
    try { await initialize(); render(); await pricingChanged(); }
    catch (error) { $("penetration-loading").textContent = "The penetration workspace could not be loaded. Reopen it to try again."; message(error.message, true); }
    finally { state.loading = false; }
  }
  async function download(kind) {
    if (state.downloading) return;
    document.activeElement?.blur?.();
    try {
      if (!state.draft || state.invalid.size) throw new Error("Correct the penetration input marked invalid before downloading.");
      const snapshot = projectSnapshot();
      const pricing = configuration(), details = clone(window.CeasefireProject?.details?.() || {}), captured = projectFingerprint(), pricingKey = JSON.stringify(pricing);
      state.downloading = true; status();
      const saved = await window.CeasefireDownloads.save(`/api/penetration/${kind === "pdf" ? "report.pdf" : "register.xlsx"}`, { draft: snapshot.draft, configuration: pricing, project_details: details });
      const changed = captured !== projectFingerprint() || pricingKey !== configStamp() || JSON.stringify(details) !== JSON.stringify(window.CeasefireProject?.details?.() || {});
      message(`File saved to ${saved.path}.${changed ? " It uses the inputs and prices captured when you clicked Download; later changes are not included." : ""}`);
    } catch (error) { message(`The penetration file was not saved. ${error.message}`, true); }
    finally { state.downloading = false; status(); }
  }
  $("penetration-add").addEventListener("click", addRow); $("penetration-undo").addEventListener("click", undoRemove);
  $("penetration-add-to-library").addEventListener("click", addToLibrary);
  $("penetration-recalculate").addEventListener("click", calculate);
  $("penetration-pdf").addEventListener("click", () => download("pdf")); $("penetration-excel").addEventListener("click", () => download("xlsx"));
  window.CeasefirePenetrations = { open, projectSnapshot, projectFingerprint, completeProjectSnapshot, prepareProject, prepareDefaults, applyProject, markProjectSaved, hasUnsavedChanges, pricingChanged, inputProblem, addLibraryItem };
})();
