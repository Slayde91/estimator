(() => {
  "use strict";
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const state = { definition: null, draft: null, saved: null, selected: null, group: null, result: null,
    revision: 0, context: 0, requestRevision: 0, invalid: new Map(), removed: [], timer: null,
    loading: false, calculating: false, downloading: false, page: 0, pendingFields: false,
    creatingLibrary: false, addingLibrary: false, addingSchedule: false, updatingSchedule: false, libraryCapture: null, edit: null, composerEpoch: 0,
    schedule: { draft: null, result: null, revision: 0, requestRevision: 0, invalid: new Map(), timer: null, calculating: false }, rowEpochs: new Map(), nextEpoch: 0 };
  const definitions = new Map(), diagramVersions = new Map(), pageSize = 50;
  let controlSequence = 0;
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const configuration = () => clone(window.CeasefireProject?.configuration?.() || { inventory: {}, rates: {} });
  const configStamp = () => JSON.stringify(configuration());
  const keyFor = (rowId, column) => JSON.stringify([rowId, column]);
  const fieldLabel = field => field.label === "Item(s)" ? "Items/Services" : ["System", "System/Install"].includes(field.label) ? "System/Install Details" : field.label;
  const manufacturerLabel = (field, value) => field.column === "V" ? String(value).toLowerCase() === "firefly" ? "Firefly" : String(value).toLowerCase() === "trafalgar" ? "Trafalgar" : undefined : undefined;
  const rowById = (id, scope = state) => scope.draft?.rows.find(row => row.id === id);
  const scheduleRow = id => rowById(id, state.schedule);
  const selected = () => rowById(state.selected);
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const stable = value => JSON.stringify(ordered(value));
  const canonicalValues = values => ordered(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? null : value])));
  const canonicalRow = row => row && ({ id: row.id, inputs: canonicalValues(row.inputs), ...(row.library_item_id ? { library_item_id: row.library_item_id } : {}) });
  function canonicalDraft(draft, definition = state.definition) {
    return draft && { globals: canonicalValues({ ...definition.defaults.globals, ...draft.globals }), rows: draft.rows.map(canonicalRow) };
  }
  const draftStamp = (draft, definition = state.definition) => stable(canonicalDraft(draft, definition));
  const rowStamp = row => stable(canonicalRow(row));
  function canonicalSnapshot(snapshot, definition = state.definition) {
    return { draft: canonicalDraft(snapshot.draft, definition), composer: canonicalDraft(snapshot.composer, definition), library_tracking_version: 1 };
  }
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
  function message(text = "", error = false, scope = state) { const el = $(scope === state ? "penetration-message" : "penetration-schedule-message"); el.textContent = text; el.hidden = !text; el.className = `message${error ? " error" : ""}`; }
  const persisted = () => ({ draft: state.schedule.draft, composer: state.draft });
  function hasUnsavedChanges() { return !!state.draft && (stable(canonicalSnapshot(persisted())) !== state.saved || state.invalid.size > 0 || state.schedule.invalid.size > 0); }
  function status(text) {
    $("penetration-status").textContent = text || (state.schedule.invalid.size ? "Check input" : state.schedule.calculating ? "Calculating…" : state.schedule.result?.errors?.length ? "Review calculation" : hasUnsavedChanges() ? "Unsaved changes" : "Calculated");
    const blocked = !state.draft || state.invalid.size > 0, scheduleBlocked = !state.schedule.draft || state.schedule.invalid.size > 0;
    $("penetration-recalculate").disabled = blocked;
    $("penetration-add").disabled = !state.draft;
    $("penetration-add-to-library").disabled = blocked || state.creatingLibrary;
    $("penetration-add-to-schedule").disabled = blocked || scheduleBlocked || state.addingSchedule || state.schedule.draft.rows.length >= state.definition.capacity;
    $("penetration-update-schedule").hidden = !state.edit;
    $("penetration-update-schedule").disabled = blocked || scheduleBlocked || state.updatingSchedule || !validEdit();
    $("penetration-cancel-edit").hidden = !state.edit;
    for (const id of ["penetration-schedule-recalculate", "penetration-pdf", "penetration-excel"]) $(id).disabled = scheduleBlocked || state.downloading;
    $("penetration-undo").disabled = scheduleBlocked || !state.removed.length;
    for (const button of $("penetration-schedule-body").querySelectorAll("[data-penetration-remove]")) button.disabled = scheduleBlocked;
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
  function checkDraft(draft, definition, composer = false) {
    if (!draft || typeof draft.globals !== "object" || !draft.globals || Array.isArray(draft.globals) || !Array.isArray(draft.rows) || (composer && draft.rows.length !== 1) || draft.rows.length > definition.capacity) throw new Error("The firestopping inputs are incomplete or exceed their row capacity.");
    const ids = new Set(), libraryIds = new Set();
    for (const row of draft.rows) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || !row.inputs || typeof row.inputs !== "object" || Array.isArray(row.inputs)) throw new Error("The firestopping schedule contains an invalid or repeated row.");
      if (Object.hasOwn(row, "library_item_id") && (typeof row.library_item_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(row.library_item_id))) throw new Error("The schedule contains an invalid library item ID.");
      if (row.library_item_id && libraryIds.has(row.library_item_id)) throw new Error("The schedule contains a repeated library item ID.");
      if (row.library_item_id) libraryIds.add(row.library_item_id);
      ids.add(row.id);
    }
  }
  async function prepareProject(snapshot, pricing = configuration()) {
    const definition = await definitionFor(clone(pricing));
    if (snapshot?.source_sha256 && snapshot.source_sha256 !== definition.source_sha256) throw new Error("The firestopping inputs use a different source workbook version. Their inputs have been retained.");
    const draft = clone(snapshot?.draft || definition.schedule_defaults || { globals: definition.defaults.globals, rows: [] });
    const composer = clone(snapshot?.composer || definition.defaults);
    for (const field of (definition.global_fields || []).filter(field => field.group === "SETTINGS")) {
      const legacy = field.legacy_column && [...draft.rows, ...composer.rows]
        .map(row => row.inputs?.[field.legacy_column]).find(value => value !== null && value !== undefined && value !== "");
      draft.globals[field.column] = draft.globals[field.column] ?? legacy ?? field.default;
      composer.globals[field.column] = draft.globals[field.column];
    }
    checkDraft(draft, definition); checkDraft(composer, definition, true);
    return { definition, draft, composer, saved: stable(canonicalSnapshot({ draft, composer }, definition)) };
  }
  function prepareDefaults(pricing = configuration()) { return prepareProject(null, pricing); }
  function applyProject(prepared) {
    ++state.context; ++state.requestRevision; ++state.composerEpoch; clearTimeout(state.timer); clearTimeout(state.schedule.timer);
    const composer = clone(prepared.composer || prepared.definition.defaults);
    Object.assign(state, { definition: prepared.definition, draft: composer, saved: prepared.saved || stable(canonicalSnapshot({ draft: prepared.draft, composer }, prepared.definition)),
      selected: composer.rows[0].id, group: prepared.definition.groups[0], result: null, edit: null,
      revision: 0, invalid: new Map(), removed: [], page: 0, pendingFields: false, calculating: false, rowEpochs: new Map() });
    Object.assign(state.schedule, { draft: clone(prepared.draft), result: null, revision: 0, requestRevision: state.schedule.requestRevision + 1, invalid: new Map(), calculating: false });
    for (const row of state.schedule.draft.rows) state.rowEpochs.set(row.id, ++state.nextEpoch);
    render(); message(); message("", false, state.schedule);
  }
  async function initialize() {
    if (state.draft) return;
    const context = state.context, prepared = await prepareDefaults();
    if (state.draft) return;
    if (context !== state.context) throw new Error("The project changed while loading firestopping inputs. Try again.");
    applyProject(prepared);
  }
  function projectSnapshot() { return state.draft ? canonicalSnapshot(persisted()) : undefined; }
  function quoteSnapshot() { return state.schedule.draft ? { draft: canonicalDraft(state.schedule.draft) } : undefined; }
  function quoteFingerprint() { return stable({ context: state.context, ...quoteSnapshot(), invalid: [...state.schedule.invalid] }); }
  function scheduleProblem() { return state.schedule.invalid.size ? "Correct the firestopping schedule input marked invalid before calculating the quote." : ""; }
  function inputProblem() { return state.invalid.size || state.schedule.invalid.size ? "Correct the firestopping input marked invalid before saving." : ""; }
  function projectFingerprint() { return stable({ context: state.context, ...canonicalSnapshot(persisted()), invalid: [...state.invalid].sort(([a], [b]) => a.localeCompare(b)), scheduleInvalid: [...state.schedule.invalid].sort(([a], [b]) => a.localeCompare(b)), edit: state.edit && { id: state.edit.id, epoch: state.edit.epoch }, composerEpoch: state.composerEpoch }); }
  async function completeProjectSnapshot() { await initialize(); if (inputProblem()) throw new Error(inputProblem()); return projectSnapshot(); }
  function acceptDraft(scope, draft, captured) {
    // An accepted receipt can normalize blanks without changing the edited row.
    // Advance its comparison value only while the original row and capture match.
    const edit = scope === state.schedule && validEdit() && draftStamp(scope.draft) === draftStamp(captured)
      && rowStamp(captured?.rows.find(row => row.id === state.edit.id)) === state.edit.target ? state.edit : null;
    scope.draft = clone(draft);
    if (edit && scheduleRow(edit.id)) edit.target = rowStamp(scheduleRow(edit.id));
  }
  function markProjectSaved(receipt, captured) {
    if (!receipt?.draft || !state.draft) return;
    const saved = { draft: receipt.draft, composer: receipt.composer || captured?.composer || state.definition.defaults };
    for (const [key, scope] of [["draft", state.schedule], ["composer", state]]) {
      if (captured && !scope.invalid.size && draftStamp(scope.draft) === draftStamp(captured[key]) && JSON.stringify(scope.draft) !== JSON.stringify(saved[key])) {
        acceptDraft(scope, saved[key], captured[key]); scope.revision++; scope.result = null;
      }
    }
    state.saved = stable(canonicalSnapshot(saved)); state.selected = state.draft.rows[0].id; render();
  }
  function inputValue(field, rowId, scope = state) { return (rowId === null ? scope.draft.globals : rowById(rowId, scope)?.inputs)?.[field.column] ?? null; }
  function displayedInput(field, rowId, scope = state) {
    const raw = inputValue(field, rowId, scope);
    return field.automatic_default && (raw === null || raw === "")
      ? scope.result?.rows.find(row => row.id === rowId)?.input_defaults?.[field.column] ?? null : raw;
  }
  function controlText(field, value, precise = false) {
    if (value === null || value === undefined || value === "") return "";
    if (field.type !== "number" || !numeric(value)) return String(value);
    const adjusted = field.format === "percent" ? shiftDecimal(value, 2) : value;
    return precise ? String(adjusted) : number.format(adjusted).replace(/,/g, "");
  }
  function changed(rowId, scope = state) {
    if (scope === state.schedule && rowId) state.removed = state.removed.filter(item => item.row.id !== rowId);
    scope.revision++; scope.result = null;
    if (scope === state.schedule) renderSchedule();
    renderSummary(scope); renderBreakdown(scope); status(); clearTimeout(scope.timer);
    for (const control of $("penetration-row-fields").querySelectorAll("[data-penetration-field]")) control.refreshAutomatic?.();
    scope.timer = setTimeout(() => calculate(scope), 350);
  }
  function makeControl(field, rowId, compact = false, scope = state) {
    const context = state.context, epoch = scope === state ? state.composerEpoch : state.rowEpochs.get(rowId);
    const current = () => context === state.context && (scope === state ? epoch === state.composerEpoch : rowId === null || epoch === state.rowEpochs.get(rowId));
    const key = keyFor(rowId, field.column), wrapper = node(field.automatic_default ? "div" : "label", "field"), label = node("span", "", fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : ""));
    const control = node(field.type === "select" ? "select" : "input"), problem = node("small", "penetration-field-error");
    const help = field.help || "";
    if (help) { wrapper.title = help; label.title = help; control.title = help; }
    if (compact) { wrapper.className += " penetration-schedule-quantity"; label.className = "sr-only"; control.dataset.penetrationScheduleQuantity = rowId; }
    const line = rowId === null ? (scope === state ? "Current item" : "Schedule") : `Item ${scope.draft.rows.findIndex(row => row.id === rowId) + 1}`;
    control.dataset.penetrationScope = scope === state ? "composer" : "schedule";
    control.dataset.penetrationField = field.column; control.dataset.penetrationRow = rowId === null ? "" : rowId;
    control.setAttribute("aria-label", `${line}: ${label.textContent}`);
    const pending = scope.invalid.get(key), raw = inputValue(field, rowId, scope);
    const manufacturer = rowId !== null && manufacturerLabel(field, raw);
    const options = [...new Set((field.options || []).map(value => manufacturer && manufacturerLabel(field, value) === manufacturer ? raw : value))];
    if (field.type === "select") {
      const empty = node("option", "", "Choose…"); empty.value = ""; control.append(empty);
      for (const value of options) { const option = node("option", "", manufacturerLabel(field, value) || value); option.value = String(value); control.append(option); }
      if (raw !== null && raw !== "" && !options.some(value => String(value) === String(raw))) {
        const option = node("option", "", manufacturer || `Saved value: ${raw} (choose a listed value)`); option.value = String(raw); option.disabled = true; control.append(option);
      }
    } else {
      if (field.type === "number") {
        control.type = "number"; control.step = String(field.step ?? "any");
        control.inputMode = "decimal"; control.autocomplete = "off";
      } else { control.type = "text"; control.maxLength = 2000; }
    }
    control.value = pending ? pending.value : controlText(field, displayedInput(field, rowId, scope));
    if (field.enabled_when) {
      const inputs = rowById(rowId, scope)?.inputs || {};
      control.disabled = field.enabled_when.nonblank && [null, undefined, ""].includes(inputs[field.enabled_when.column]);
    }
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    showProblem(pending?.error);
    control.addEventListener("focus", () => {
      if (!current()) return;
      if (field.type !== "number" || scope.invalid.has(key)) return;
      control.value = controlText(field, displayedInput(field, rowId, scope), true);
      // Replacing the rounded display resets the browser's selection. Select
      // the precise value so keyboard and accessibility replacements stay whole.
      control.select?.();
    });
    const apply = () => {
      if (!current()) return;
      if (rowId !== null && !rowById(rowId, scope)) return;
      let value = control.value, error = "";
      if (field.type === "number") {
        const text = value.trim();
        if (!text) value = null;
        else if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) error = "Enter a finite number or leave this field blank.";
        else {
          value = field.format === "percent" ? shiftDecimal(text, -2) : Number(text);
          if (!Number.isFinite(value) || Math.abs(value) > 1e12) error = "Enter a value between -1,000,000,000,000 and 1,000,000,000,000.";
          else if (numeric(field.min) && value < field.min) error = `Enter a value of at least ${field.min}.`;
        }
      } else if (field.type === "select") {
        value = value === "" ? null : options.find(item => String(item) === value);
        if (value === undefined) error = "Choose a listed value.";
      }
      if (error) scope.invalid.set(key, { value: control.value, error });
      else { scope.invalid.delete(key); (rowId === null ? scope.draft.globals : rowById(rowId, scope).inputs)[field.column] = value; }
      showProblem(error); changed(rowId, scope);
      if (!error && rowId === null && field.group === "SETTINGS" && scope === state.schedule) {
        state.draft.globals[field.column] = value; changed(null, state);
      }
      if (scope === state && !error && ["J", "K", "Y"].includes(field.column)) renderFields();
    };
    control.addEventListener(field.type === "select" ? "change" : "input", apply);
    control.addEventListener("blur", () => {
      if (!current()) return;
      if (!scope.invalid.has(key)) control.value = controlText(field, displayedInput(field, rowId, scope));
      refreshControls();
      if (state.pendingFields) { state.pendingFields = false; renderFields(); renderScheduleGlobals(); }
    });
    wrapper.append(label, control, problem);
    if (field.automatic_default) {
      const tools = node("div", "penetration-automatic-tools"), hint = node("small", "helper"), reset = node("button", "button secondary", "Use automatic");
      hint.id = `penetration-default-${++controlSequence}`; control.setAttribute("aria-describedby", hint.id);
      reset.type = "button"; reset.setAttribute("aria-label", `Use automatic ${fieldLabel(field)}`);
      control.refreshAutomatic = () => {
        const value = inputValue(field, rowId, scope), automatic = value === null || value === "";
        const defaults = scope.result?.rows.find(row => row.id === rowId)?.input_defaults;
        hint.textContent = !automatic ? "Manual allowance." : !defaults ? "Automatic value updates after calculation." : numeric(defaults[field.column]) ? `Automatic: ${controlText(field, defaults[field.column])}${field.units ? ` ${field.units}` : ""}.` : "No automatic value for this item. Enter hours if required.";
        reset.disabled = automatic && !scope.invalid.has(key);
        if (control !== document.activeElement && !scope.invalid.has(key)) control.value = controlText(field, displayedInput(field, rowId, scope));
      };
      reset.addEventListener("click", () => {
        if (!current() || !rowById(rowId, scope)) return;
        rowById(rowId, scope).inputs[field.column] = null; scope.invalid.delete(key); showProblem("");
        changed(rowId, scope); control.value = ""; refreshControls();
      });
      control.refreshAutomatic(); tools.append(hint, reset); wrapper.append(tools);
    }
    return wrapper;
  }
  function fieldsActive() { return !!document.activeElement?.dataset?.penetrationField; }
  function visibleGroups(inputs) {
    return state.definition.groups.filter(group => {
      const rule = state.definition.group_visibility?.[group];
      return !rule || (rule.values || []).includes(inputs?.[rule.column]);
    });
  }
  function fieldInGroup(field, group) {
    return !field.hidden && (field.display_groups || [field.group]).includes(group);
  }
  function renderFields() {
    if (!state.draft) return;
    const row = selected(), groups = visibleGroups(row.inputs);
    if (!groups.includes(state.group)) state.group = groups[0];
    const buttons = groups.map(group => {
      const button = node("button", "penetration-group", group); button.type = "button"; button.dataset.penetrationGroup = group;
      button.setAttribute("aria-pressed", String(group === state.group));
      button.addEventListener("click", () => { state.group = group; renderFields(); }); return button;
    });
    $("penetration-input-groups").replaceChildren(...buttons);
    const identity = [row.inputs.J, row.inputs.K].filter(value => value !== null && value !== undefined && String(value).trim()).join(" · ");
    $("penetration-row-heading").textContent = `${state.edit ? "Editing schedule item" : "Current item"} · ${identity || "Item details"}`;
    const fields = node("div", "penetration-fields");
    const settings = state.group === "SETTINGS";
    const visible = settings ? state.definition.global_fields || [] : state.definition.row_fields.filter(field => fieldInGroup(field, state.group));
    for (const field of visible) fields.append(makeControl(field, settings ? null : row.id, false, settings ? state.schedule : state));
    $("penetration-row-fields").replaceChildren(fields);
  }
  function refreshControls() {
    for (const parent of [$("penetration-row-fields"), $("penetration-schedule-body")]) for (const control of parent.querySelectorAll("[data-penetration-field]")) {
      const rowId = control.dataset.penetrationRow || null, key = keyFor(rowId, control.dataset.penetrationField);
      const scope = control.dataset.penetrationScope === "schedule" ? state.schedule : state;
      const pending = scope.invalid.get(key), problem = control.parentNode.children[2];
      control.setAttribute("aria-invalid", String(!!pending)); problem.textContent = pending?.error || ""; problem.hidden = !pending;
      control.refreshAutomatic?.();
      if (control === document.activeElement) continue;
      const field = (rowId === null ? state.definition.global_fields : state.definition.row_fields).find(field => field.column === control.dataset.penetrationField);
      if (field) control.value = pending ? pending.value : controlText(field, displayedInput(field, rowId, scope));
    }
  }
  function composerStamp() { return stable({ draft: canonicalDraft(state.draft), invalid: [...state.invalid], epoch: state.composerEpoch }); }
  function validEdit() { return !!state.edit && !!scheduleRow(state.edit.id) && state.rowEpochs.get(state.edit.id) === state.edit.epoch && rowStamp(scheduleRow(state.edit.id)) === state.edit.target; }
  async function confirmReplace(title, detail, action, required) {
    if (!required) return true;
    if (!window.CeasefirePenetrationNavigation?.confirm) { message("Finish the current item before replacing it.", true); return false; }
    return window.CeasefirePenetrationNavigation.confirm(title, detail, action);
  }
  function defaultComposer() {
    const draft = clone(state.definition.defaults);
    for (const field of (state.definition.global_fields || []).filter(field => field.group === "SETTINGS")) draft.globals[field.column] = state.schedule.draft?.globals?.[field.column] ?? field.default;
    draft.rows[0].inputs = { ...newRow(state).inputs, ...draft.rows[0].inputs }; return draft;
  }
  function composerChanged() { return state.invalid.size > 0 || draftStamp(state.draft) !== draftStamp(defaultComposer()); }
  function replaceComposer(draft, invalid = new Map()) {
    ++state.composerEpoch; ++state.requestRevision; clearTimeout(state.timer);
    state.draft = clone(draft); state.invalid = new Map(invalid); state.selected = draft.rows[0].id;
    state.revision++; state.result = null; state.calculating = false;
    renderFields(); renderSummary(); renderBreakdown(); renderSchedule(); status();
  }
  async function selectRow(id) {
    document.activeElement?.blur?.();
    if (!scheduleRow(id) || state.schedule.invalid.size) return;
    const context = state.context, stamp = composerStamp(), epoch = state.rowEpochs.get(id), target = rowStamp(scheduleRow(id));
    const confirmed = await confirmReplace("Edit schedule item?", "Your current item will be kept so Cancel edit can restore it.", "Edit item", composerChanged());
    if (!confirmed || context !== state.context || stamp !== composerStamp() || epoch !== state.rowEpochs.get(id) || target !== rowStamp(scheduleRow(id))) return;
    const before = state.edit?.before || { draft: clone(state.draft), invalid: [...state.invalid] };
    const draft = { globals: clone(state.schedule.draft.globals), rows: [clone(scheduleRow(id))] };
    state.edit = { id, epoch, before, baseline: draftStamp(draft), target };
    replaceComposer(draft); window.CeasefirePenetrationNavigation?.show?.(); await calculate();
  }
  function newRow(scope = state.schedule) {
    let index = 1; while (rowById(`line-${index}`, scope)) index++;
    const inputs = Object.fromEntries(state.definition.row_fields.filter(field => field.default !== null && field.default !== undefined).map(field => [field.column, clone(field.default)]));
    return { id: `line-${index}`, inputs };
  }
  async function addRow() {
    document.activeElement?.blur?.(); if (!state.draft) return;
    const context = state.context, stamp = composerStamp();
    if (!await confirmReplace("Start a new item?", "The current item will be replaced. Items already in the schedule are kept.", "New item", composerChanged())) return;
    if (context !== state.context || stamp !== composerStamp()) return;
    state.edit = null; replaceComposer(defaultComposer()); message(); window.CeasefirePenetrationNavigation?.show?.(); await calculate();
  }
  async function cancelEdit() {
    document.activeElement?.blur?.(); if (!state.edit) return;
    const context = state.context, stamp = composerStamp(), edit = state.edit;
    if (!await confirmReplace("Cancel schedule edit?", "Changes to this copy will be discarded and your previous current item restored.", "Cancel edit", state.invalid.size > 0 || draftStamp(state.draft) !== edit.baseline)) return;
    if (context !== state.context || stamp !== composerStamp() || edit !== state.edit) return;
    state.edit = null; replaceComposer(edit.before.draft, edit.before.invalid); message(); await calculate();
  }
  function renderScheduleGlobals() {
    // Old saved global inputs remain portable; the current policy excludes them.
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
  function appendSchedule(inputs, libraryId) {
    if (state.schedule.invalid.size) throw new Error("Correct the schedule input marked invalid before adding an item.");
    if (state.schedule.draft.rows.length >= state.definition.capacity) throw new Error("The current schedule is full. Remove a row before adding another item.");
    const row = newRow(); row.inputs = clone(inputs); if (libraryId) row.library_item_id = libraryId; state.schedule.draft.rows.push(row);
    state.rowEpochs.set(row.id, ++state.nextEpoch); state.removed = []; state.page = Math.floor((state.schedule.draft.rows.length - 1) / pageSize);
    changed(row.id, state.schedule); return row;
  }
  function libraryQuantity(id) {
    const rows = state.schedule.draft?.rows.filter(row => row.library_item_id === id) || [];
    if (!rows.length) return undefined;
    if (rows.some(row => state.schedule.invalid.has(keyFor(row.id, "O")))) return null;
    return rows.reduce((sum, row) => sum + (row.inputs.O ?? 0), 0);
  }
  function libraryDiagramChanged(id) {
    if (typeof id !== "string" || !id) return;
    diagramVersions.set(id, (diagramVersions.get(id) || 0) + 1);
    renderSchedule();
  }
  const libraryInputs = inputs => stable(Object.fromEntries(Object.entries(inputs).filter(([column, value]) => column !== "O" && value !== null && value !== "")));
  function addLibraryQuantity(id, inputs) {
    if (state.schedule.invalid.size) throw new Error("Correct the schedule input marked invalid before adding an item.");
    const linked = state.schedule.draft.rows.find(row => row.library_item_id === id);
    // Older projects did not record library identity. Adopt one exact match
    // only. Combining old rows can remove fixed per-row charges such as AJ.
    const row = linked || state.schedule.draft.rows.find(item => !item.library_item_id && libraryInputs(item.inputs) === libraryInputs(inputs));
    const quantity = (row?.inputs.O ?? 0) + 1;
    if (!numeric(quantity) || Math.abs(quantity) > 1e12) throw new Error("The resulting schedule quantity exceeds the supported range.");
    if (!row) {
      return appendSchedule({ ...inputs, O: 1 }, id);
    }
    row.library_item_id = id; row.inputs.O = quantity;
    state.page = Math.floor(state.schedule.draft.rows.indexOf(row) / pageSize);
    changed(row.id, state.schedule); return row;
  }
  async function scheduleReceipt(row, label, context) {
    const epoch = state.rowEpochs.get(row.id);
    await calculate(state.schedule);
    if (context !== state.context || !scheduleRow(row.id) || epoch !== state.rowEpochs.get(row.id)) return { added: true, id: row.id, total: null, message: "The item was added, but its schedule or row has since changed. Review the current schedule." };
    const output = state.schedule.result?.rows?.find(item => item.id === row.id), value = output?.outputs?.H;
    const total = numeric(value) && !output.errors?.length ? value : null;
    const quantity = scheduleRow(row.id).inputs.O;
    const text = `${label} added using the current schedule prices.${row.library_item_id ? ` Quantity: ${quantity ?? 0}.` : ""} ${total === null ? "Recalculated price is unavailable. Review the schedule calculation." : `Recalculated item price: ${display(total, "currency")}.`}`;
    message(text, total === null, state.schedule); return { added: true, id: row.id, quantity, total, message: text };
  }
  async function addToSchedule() {
    document.activeElement?.blur?.(); if (!state.draft || state.invalid.size || state.addingSchedule) return;
    const context = state.context, epoch = state.composerEpoch, revision = state.revision;
    state.addingSchedule = true; status();
    try {
      const row = appendSchedule(selected().inputs), receipt = await scheduleReceipt(row, "Current item", context);
      if (context === state.context && epoch === state.composerEpoch) message(receipt.message + (revision !== state.revision ? " Later edits to the current item are not included." : ""), receipt.total === null);
      return receipt;
    }
    catch (error) { message(error.message, true); }
    finally { state.addingSchedule = false; status(); }
  }
  async function updateSchedule() {
    document.activeElement?.blur?.(); if (!validEdit() || state.invalid.size || state.schedule.invalid.size || state.updatingSchedule) return;
    const context = state.context, epoch = state.composerEpoch, edit = state.edit, row = scheduleRow(edit.id); row.inputs = clone(selected().inputs);
    state.updatingSchedule = true;
    state.edit = null;
    try { changed(row.id, state.schedule); renderFields(); await calculate(state.schedule);
      if (context === state.context && epoch === state.composerEpoch) message("Schedule item updated using the schedule prices.");
    } finally { state.updatingSchedule = false; status(); }
  }
  async function addLibraryItem(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id)) throw new Error("The library item ID is invalid.");
    if (state.addingLibrary) throw new Error("A library item is already being added to the schedule.");
    if (window.CeasefireLibraryEditor?.isOpen()) throw new Error("Save or cancel the open library edit before adding an item to the schedule.");
    document.activeElement?.blur?.(); const context = state.context; state.addingLibrary = true;
    try {
      if (!state.draft) {
        const prepared = await prepareDefaults();
        if (context !== state.context) throw new Error("The project changed. Add the library item again when ready.");
        applyProject(prepared);
      }
      const targetContext = state.context;
      if (state.schedule.invalid.size) throw new Error("Correct the schedule input marked invalid before adding an item.");
      const linked = state.schedule.draft.rows.find(row => row.library_item_id === id);
      if (linked) {
        const row = addLibraryQuantity(id, linked.inputs);
        return await scheduleReceipt(row, "Library item", targetContext);
      }
      const record = await request(`/api/libraries/penetration/${encodeURIComponent(id)}/edit`);
      if (targetContext !== state.context) throw new Error("The project changed while opening the library item. Nothing was added.");
      if (window.CeasefireLibraryEditor?.isOpen()) throw new Error("Save or cancel the open library edit before adding an item to the schedule.");
      checkDraft(record.draft, state.definition, true);
      if (record.definition?.source_sha256 !== state.definition.source_sha256) throw new Error("This library item does not match the current Firestopping Estimator calculation source.");
      const row = addLibraryQuantity(id, record.draft.rows[0].inputs);
      return await scheduleReceipt(row, record.library_id, targetContext);
    } finally { state.addingLibrary = false; }
  }
  function removeRow(id) {
    const scope = state.schedule;
    if (scope.invalid.size || !scheduleRow(id)) return;
    const index = scope.draft.rows.findIndex(row => row.id === id), row = clone(scheduleRow(id));
    scope.draft.rows.splice(index, 1); state.rowEpochs.delete(id);
    state.removed.push({ row, index }); if (state.removed.length > 20) state.removed.shift();
    state.page = Math.min(state.page, Math.max(0, Math.ceil(scope.draft.rows.length / pageSize) - 1));
    changed(null, scope); calculate(scope);
  }
  function undoRemove() {
    const scope = state.schedule;
    if (scope.invalid.size || !state.removed.length) return;
    const removed = state.removed.pop(); if (scheduleRow(removed.row.id)) return;
    scope.draft.rows.splice(Math.min(removed.index, scope.draft.rows.length), 0, removed.row);
    state.rowEpochs.set(removed.row.id, ++state.nextEpoch); state.page = Math.floor(removed.index / pageSize);
    changed(null, scope); calculate(scope);
  }
  function renderSchedule() {
    if (!state.schedule.draft) return;
    window.CeasefireLibraries?.scheduleChanged?.();
    window.CeasefireProject?.scheduleChanged?.();
    const body = $("penetration-schedule-body"), previous = [...body.children];
    const existing = new Map(previous.filter(row => row.dataset.penetrationContext === String(state.context)).map(row => [row.dataset.penetrationId, row]));
    const quantityField = state.definition.row_fields.find(field => field.column === "O");
    const results = new Map((state.schedule.result?.rows || []).map(row => [row.id, row]));
    const rows = state.schedule.draft.rows.slice(state.page * pageSize, (state.page + 1) * pageSize).map((row, index) => {
      const line = state.page * pageSize + index + 1, result = results.get(row.id), tr = existing.get(row.id) || node("tr"); tr.dataset.penetrationId = row.id; tr.dataset.penetrationContext = String(state.context);
      tr.className = row.id === state.edit?.id ? "penetration-selected-row" : "";
      const invalid = [...state.schedule.invalid.keys()].some(key => JSON.parse(key)[0] === row.id);
      if (!tr.children.length) {
        for (let column = 0; column < 9; column++) tr.append(node("td"));
        tr.children[8].className = "penetration-schedule-diagram";
        if (quantityField) tr.children[5].append(makeControl(quantityField, row.id, true, state.schedule));
      }
      const diagramCell = tr.children[8], diagramId = row.library_item_id, diagramVersion = diagramId ? diagramVersions.get(diagramId) || 0 : 0;
      const diagramStamp = diagramId ? `${diagramId}:${diagramVersion}` : "";
      if (diagramCell.dataset.libraryDiagram !== diagramStamp) {
        diagramCell.dataset.libraryDiagram = diagramStamp;
        if (diagramId) {
          const image = node("img"); image.src = `/api/libraries/penetration/${encodeURIComponent(diagramId)}/thumbnail${diagramVersion ? `?v=${diagramVersion}` : ""}`; image.alt = `${row.inputs.T || row.inputs.K || "Firestopping item"} source diagram`; image.loading = "lazy"; image.decoding = "async";
          image.addEventListener("error", () => { if (diagramCell.dataset.libraryDiagram === diagramStamp) diagramCell.replaceChildren(node("span", "helper", "No diagram")); });
          diagramCell.replaceChildren(image);
        } else diagramCell.replaceChildren(node("span", "helper", "—"));
      }
      const values = [line, row.inputs.K || "—", row.inputs.L || "—", row.inputs.M || "—", row.inputs.N || "—", null, display(result?.outputs.H, "currency"), invalid ? "Check input" : result?.errors?.length ? "Review calculation" : state.schedule.calculating ? "Calculating…" : result ? "Calculated" : "—", null];
      values.forEach((value, column) => { if (column !== 5 && column !== 8) tr.children[column].textContent = String(value); });
      if (!quantityField) tr.children[5].textContent = display(row.inputs.O);
      for (const control of tr.children[5].querySelectorAll("[data-penetration-field]")) control.setAttribute("aria-label", `Item ${line}: ${fieldLabel(quantityField)}`);
      const actions = node("td", "penetration-item-actions"), edit = node("button", "button secondary", "Edit"); edit.type = "button"; edit.setAttribute("aria-label", `Edit firestopping item ${line}`); edit.addEventListener("click", () => selectRow(row.id));
      const remove = node("button", "button secondary penetration-remove"), icon = node("span"); icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
      remove.append(icon); remove.type = "button"; remove.dataset.penetrationRemove = row.id; remove.title = `Remove item ${line}`; remove.setAttribute("aria-label", `Remove firestopping item ${line}`); remove.disabled = state.schedule.invalid.size > 0; remove.addEventListener("click", () => removeRow(row.id));
      actions.append(edit, remove);
      if (tr.children[9]) tr.children[9].replaceChildren(edit, remove); else tr.append(actions);
      return tr;
    });
    // Keeping unchanged rows attached preserves the active quantity editor and
    // its selection while inputs and server results update around it.
    if (rows.length !== previous.length || rows.some((row, index) => row !== previous[index])) body.replaceChildren(...rows);
    refreshControls();
    const count = $("penetration-row-count"); count.replaceChildren(node("span", "", `${state.schedule.draft.rows.length} ${state.schedule.draft.rows.length === 1 ? "item" : "items"} · Capacity ${state.definition.capacity}`));
    if (state.schedule.draft.rows.length > pageSize) {
      const previous = node("button", "button secondary", "Previous rows"), next = node("button", "button secondary", "Next rows"); previous.type = next.type = "button";
      previous.disabled = state.page === 0; next.disabled = (state.page + 1) * pageSize >= state.schedule.draft.rows.length;
      previous.addEventListener("click", () => { state.page--; renderSchedule(); }); next.addEventListener("click", () => { state.page++; renderSchedule(); });
      count.append(previous, node("span", "", `Showing ${state.page * pageSize + 1}–${Math.min((state.page + 1) * pageSize, state.schedule.draft.rows.length)} · All rows calculated`), next);
    }
  }
  function renderSummary(scope = state) {
    const prefix = scope === state ? "penetration" : "penetration-schedule";
    const labels = { materials: "Materials", labour: "Labour", grand_total: "Grand total", total_days: "Total days", labour_hours: "Task Hours" };
    $(`${prefix}-summary`).replaceChildren(...Object.entries(labels).map(([key, label]) => {
      const line = node("div", key === "grand_total" ? "subtotal" : ""); line.append(node("dt", "", label), node("dd", "", display(scope.result?.summary?.[key], ["total_days", "labour_hours"].includes(key) ? "number" : "currency"))); return line;
    }));
    const errors = scope.result?.errors || [], globalErrors = errors.filter(error => !error.row_id).map(error => `${state.definition.row_fields.find(field => field.column === error.cell)?.label || error.cell}: ${error.message}`);
    $(`${prefix}-summary-notes`).textContent = errors.length
      ? [`${errors.length} calculation ${errors.length === 1 ? "issue" : "issues"}. Review the affected inputs and totals.`, ...globalErrors].join("\n")
      : scope === state ? "Current item only. Add it to the schedule to include it in the quote." : "Totals include every schedule item and are included once in the quote.";
  }
  function renderBreakdown(scope = state) {
    if (scope === state.schedule) $("penetration-schedule-breakdown").replaceChildren(window.CeasefirePenetrationBreakdown.renderSchedule(state.definition, scope.result));
    else $("penetration-breakdown").replaceChildren(window.CeasefirePenetrationBreakdown.render(state.definition, state.result?.rows.find(row => row.id === state.selected)));
  }
  function render() {
    if (!state.draft) return;
    $("penetration-loading").hidden = true; $("penetration-workspace").hidden = false; $("penetration-schedule-workspace").hidden = false;
    $("penetration-source").textContent = state.definition.source?.filename || "Firestopping Estimator workbook";
    renderSchedule(); renderFields(); renderScheduleGlobals();
    for (const scope of [state, state.schedule]) { renderSummary(scope); renderBreakdown(scope); }
    status();
  }
  async function calculate(scope = state) {
    clearTimeout(scope.timer);
    try { await initialize(); } catch (error) { message(error.message, true, scope); return; }
    if (scope.invalid.size) { status(); return; }
    const context = state.context, revision = scope.revision, requestRevision = ++scope.requestRevision;
    const pricing = configuration(), pricingKey = JSON.stringify(pricing), draft = clone(scope.draft);
    scope.calculating = true; status();
    try {
      const data = await request("/api/penetration/calculate", { draft, configuration: pricing });
      if (context !== state.context || revision !== scope.revision || requestRevision !== scope.requestRevision || pricingKey !== configStamp() || scope.invalid.size) return;
      const fieldsChanged = JSON.stringify([state.definition.row_fields, state.definition.global_fields]) !== JSON.stringify([data.definition?.row_fields || state.definition.row_fields, data.definition?.global_fields || state.definition.global_fields]);
      if (data.draft) acceptDraft(scope, data.draft, draft);
      state.definition = data.definition || state.definition; scope.result = data; scope.calculating = false;
      renderSchedule(); renderSummary(scope); renderBreakdown(scope);
      if (fieldsChanged && fieldsActive()) state.pendingFields = true; else if (fieldsChanged) { renderFields(); renderScheduleGlobals(); } else refreshControls();
      status(); message("", false, scope);
    } catch (error) {
      if (context === state.context && revision === scope.revision && requestRevision === scope.requestRevision) { scope.result = null; renderSchedule(); renderSummary(scope); renderBreakdown(scope); message(error.message, true, scope); }
    } finally { if (context === state.context && requestRevision === scope.requestRevision) { scope.calculating = false; status(); } }
  }
  async function calculateSchedule() { return calculate(state.schedule); }
  async function pricingChanged() {
    if (!state.draft) return;
    const context = state.context, pricing = configuration(), key = JSON.stringify(pricing);
    for (const scope of [state, state.schedule]) { ++scope.requestRevision; scope.result = null; renderSummary(scope); renderBreakdown(scope); }
    renderSchedule();
    try {
      const definition = await definitionFor(pricing);
      if (context !== state.context || key !== configStamp()) return;
      state.definition = definition;
      if (fieldsActive()) state.pendingFields = true; else { renderFields(); renderScheduleGlobals(); }
      await Promise.all([calculate(), calculateSchedule()]);
    } catch (error) { if (context === state.context && key === configStamp()) message(error.message, true); }
  }
  async function openScope(scope) {
    state.loading = true;
    try { await initialize(); render(); await calculate(scope); }
    catch (error) {
      $("penetration-loading").textContent = "The firestopping workspace could not be loaded. Reopen it to try again.";
      if (scope === state.schedule) $("penetration-schedule-workspace").hidden = false;
      message(error.message, true, scope);
    }
    finally { state.loading = false; }
  }
  function open() { return openScope(state); }
  function openSchedule() { return openScope(state.schedule); }
  async function download(kind) {
    if (state.downloading) return;
    document.activeElement?.blur?.();
    try {
      if (!state.schedule.draft || state.schedule.invalid.size) throw new Error("Correct the schedule input marked invalid before downloading.");
      const snapshot = projectSnapshot();
      const pricing = configuration(), details = clone(window.CeasefireProject?.details?.() || {}), captured = projectFingerprint(), pricingKey = JSON.stringify(pricing);
      state.downloading = true; status();
      const saved = await window.CeasefireDownloads.save(`/api/penetration/${kind === "pdf" ? "report.pdf" : "register.xlsx"}`, { draft: snapshot.draft, configuration: pricing, project_details: details });
      const changed = captured !== projectFingerprint() || pricingKey !== configStamp() || JSON.stringify(details) !== JSON.stringify(window.CeasefireProject?.details?.() || {});
      message(`File saved to ${saved.path}.${changed ? " It uses the inputs and prices captured when you clicked Download; later changes are not included." : ""}`, false, state.schedule);
    } catch (error) { message(`The schedule file was not saved. ${error.message}`, true, state.schedule); }
    finally { state.downloading = false; status(); }
  }
  $("penetration-add").addEventListener("click", addRow); $("penetration-undo").addEventListener("click", undoRemove);
  $("penetration-add-to-library").addEventListener("click", addToLibrary);
  $("penetration-recalculate").addEventListener("click", () => calculate());
  $("penetration-schedule-recalculate").addEventListener("click", calculateSchedule);
  $("penetration-add-to-schedule").addEventListener("click", addToSchedule);
  $("penetration-update-schedule").addEventListener("click", updateSchedule);
  $("penetration-cancel-edit").addEventListener("click", cancelEdit);
  $("penetration-pdf").addEventListener("click", () => download("pdf")); $("penetration-excel").addEventListener("click", () => download("xlsx"));
  window.CeasefirePenetrations = { open, openSchedule, projectSnapshot, projectFingerprint, quoteSnapshot, quoteFingerprint, scheduleProblem, completeProjectSnapshot, prepareProject, prepareDefaults, applyProject, markProjectSaved, hasUnsavedChanges, pricingChanged, inputProblem, addLibraryItem, libraryQuantity, libraryDiagramChanged };
})();
