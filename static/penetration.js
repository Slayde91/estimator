(() => {
  "use strict";
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const cloneOptional = value => value === undefined ? undefined : clone(value);
  const state = { definition: null, draft: null, saved: null, selected: null, group: null, result: null,
    revision: 0, context: 0, requestRevision: 0, invalid: new Map(), removed: [], timer: null,
    loading: false, calculating: false, downloading: false, downloadKind: null, page: 0, pendingFields: false,
    creatingLibrary: false, addingLibrary: false, addingSchedule: false, updatingSchedule: false, libraryCapture: null, edit: null, composerEpoch: 0,
    tabAdvisoryAcknowledgement: null, additionalLabourAdvisory: false, openSettingsBand: "pipe",
    diagramChange: undefined, diagramRead: 0, diagramVersion: 0,
    schedule: { draft: null, result: null, revision: 0, requestRevision: 0, invalid: new Map(), timer: null, calculating: false }, rowEpochs: new Map(), nextEpoch: 0 };
  const definitions = new Map(), diagramVersions = new Map(), pageSize = 50;
  let controlSequence = 0;
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const configuration = () => clone(window.CeasefireProject?.configuration?.() || { inventory: {}, rates: {} });
  const configStamp = () => JSON.stringify(configuration());
  const keyFor = (rowId, column) => JSON.stringify([rowId, column]);
  const fieldLabel = field => field.column === "J" || field.label === "Type" ? "Category"
    : field.column === "T" || ["Item(s)", "Items/Services"].includes(field.label) ? "Description"
    : ["System", "System/Install"].includes(field.label) ? "System/Install Details"
    : field.column === "AN" && field.label === "Multiplier" ? "Wrap Multiplier"
    : field.column === "X" && field.label === "Board or Batt Type" ? "Board/Batt Type"
    : field.column === "Z" && field.label === "Frame Type" ? "Framing Type" : field.label;
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
  function buttonBusy(id, value) { $(id).setAttribute("aria-busy", String(value)); }
  const persisted = () => ({ draft: state.schedule.draft, composer: state.draft });
  function hasUnsavedChanges() { return !!state.draft && (stable(canonicalSnapshot(persisted())) !== state.saved || state.invalid.size > 0 || state.schedule.invalid.size > 0 || state.diagramChange !== undefined); }
  function status(text) {
    $("penetration-status").textContent = text || (state.schedule.invalid.size ? "Check input" : state.schedule.calculating ? "Calculating…" : state.schedule.result?.errors?.length ? "Review calculation" : hasUnsavedChanges() ? "Unsaved changes" : "Calculated");
    const blocked = !state.draft || state.invalid.size > 0, scheduleBlocked = !state.schedule.draft || state.schedule.invalid.size > 0;
    $("penetration-recalculate").disabled = blocked || state.calculating;
    $("penetration-add").disabled = !state.draft;
    $("penetration-add-to-library").disabled = blocked || state.creatingLibrary;
    $("penetration-add-to-schedule").disabled = blocked || scheduleBlocked || state.diagramChange !== undefined || state.addingSchedule || state.schedule.draft.rows.length >= state.definition.capacity;
    $("penetration-update-schedule").hidden = !state.edit;
    $("penetration-update-schedule").disabled = blocked || scheduleBlocked || state.diagramChange !== undefined || state.updatingSchedule || !validEdit();
    $("penetration-cancel-edit").hidden = !state.edit;
    $("penetration-schedule-recalculate").disabled = scheduleBlocked || state.schedule.calculating || state.downloading;
    for (const id of ["penetration-pdf", "penetration-excel"]) $(id).disabled = scheduleBlocked || state.downloading;
    buttonBusy("penetration-recalculate", state.calculating);
    buttonBusy("penetration-add-to-library", state.creatingLibrary);
    buttonBusy("penetration-add-to-schedule", state.addingSchedule);
    buttonBusy("penetration-update-schedule", state.updatingSchedule);
    buttonBusy("penetration-schedule-recalculate", state.schedule.calculating);
    buttonBusy("penetration-pdf", state.downloading && state.downloadKind === "pdf");
    buttonBusy("penetration-excel", state.downloading && state.downloadKind === "xlsx");
    $("penetration-undo").disabled = scheduleBlocked || !state.removed.length;
    for (const button of $("penetration-schedule-body").querySelectorAll("[data-penetration-remove]")) button.disabled = scheduleBlocked;
    if ($("penetration-diagram-file")) $("penetration-diagram-file").disabled = state.creatingLibrary;
    if ($("penetration-diagram-remove")) $("penetration-diagram-remove").disabled = state.creatingLibrary;
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
    for (const key of definition.settings?.structured_global_keys || []) {
      draft.globals[key] = clone(draft.globals[key] ?? definition.schedule_defaults.globals[key]);
      composer.globals[key] = clone(draft.globals[key]);
    }
    checkDraft(draft, definition); checkDraft(composer, definition, true);
    return { definition, draft, composer, saved: stable(canonicalSnapshot({ draft, composer }, definition)) };
  }
  function prepareDefaults(pricing = configuration()) { return prepareProject(null, pricing); }
  function applyProject(prepared) {
    ++state.context; ++state.requestRevision; ++state.composerEpoch; clearTimeout(state.timer); clearTimeout(state.schedule.timer);
    const composer = clone(prepared.composer || prepared.definition.defaults);
    Object.assign(state, { definition: prepared.definition, draft: composer, saved: prepared.saved || stable(canonicalSnapshot({ draft: prepared.draft, composer }, prepared.definition)),
      selected: composer.rows[0].id, group: prepared.definition.groups[0], result: null, edit: null, diagramChange: undefined, diagramRead: state.diagramRead + 1, diagramVersion: 0,
      revision: 0, invalid: new Map(), removed: [], page: 0, pendingFields: false, calculating: false, rowEpochs: new Map(), tabAdvisoryAcknowledgement: null, additionalLabourAdvisory: false });
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
  function inputProblem() { return state.diagramChange !== undefined ? "Add the selected source diagram to the Firestopping Library or discard it before saving the project." : state.invalid.size || state.schedule.invalid.size ? "Correct the firestopping input marked invalid before saving." : ""; }
  function projectFingerprint() { return stable({ context: state.context, ...canonicalSnapshot(persisted()), invalid: [...state.invalid].sort(([a], [b]) => a.localeCompare(b)), scheduleInvalid: [...state.schedule.invalid].sort(([a], [b]) => a.localeCompare(b)), edit: state.edit && { id: state.edit.id, epoch: state.edit.epoch }, composerEpoch: state.composerEpoch, pendingDiagram: state.diagramChange === undefined ? null : { filename: state.diagramChange.filename, version: state.diagramVersion } }); }
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
    if (scope === state) state.tabAdvisoryAcknowledgement = null;
    if (scope === state.schedule) renderSchedule();
    renderSummary(scope); renderBreakdown(scope); status(); clearTimeout(scope.timer);
    for (const control of $("penetration-row-fields").querySelectorAll("[data-penetration-field]")) control.refreshAutomatic?.();
    scope.timer = setTimeout(() => calculate(scope), 350);
  }
  function dimensionText(inputs, first, second) {
    const a = inputs?.[first], b = inputs?.[second];
    if ([a, b].every(value => value === null || value === undefined || value === "")) return "";
    return `${a ?? ""} x ${b ?? ""}`;
  }
  function parseDimensions(text) {
    if (!text.trim()) return { values: [null, null] };
    const match = text.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*[x×]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i);
    if (!match) return { error: "Enter two finite dimensions separated by x, for example 300 x 50." };
    const values = [Number(match[1]), Number(match[2])];
    if (values.some(value => !Number.isFinite(value) || Math.abs(value) > 1e12)) return { error: "Each dimension must be between -1,000,000,000,000 and 1,000,000,000,000." };
    return { values };
  }
  function makeDimensionControl(field, paired, rowId, scope = state) {
    const context = state.context, epoch = scope === state ? state.composerEpoch : state.rowEpochs.get(rowId);
    const current = () => context === state.context && (scope === state ? epoch === state.composerEpoch : epoch === state.rowEpochs.get(rowId));
    const key = keyFor(rowId, `${field.column}:${paired.column}`), wrapper = node("label", "field");
    const label = node("span", "", `${fieldLabel(field)}${field.units ? ` (${field.units})` : ""}`), control = node("input"), problem = node("small", "penetration-field-error");
    const inputs = () => rowById(rowId, scope)?.inputs || {};
    control.type = "text"; control.inputMode = "decimal"; control.autocomplete = "off"; control.maxLength = 100;
    control.placeholder = field.placeholder || "e.g. 300 x 50";
    control.dataset.penetrationScope = scope === state ? "composer" : "schedule";
    control.dataset.penetrationField = field.column; control.dataset.penetrationPaired = paired.column; control.dataset.penetrationRow = rowId;
    control.setAttribute("aria-label", `${scope === state ? "Current item" : "Schedule item"}: ${label.textContent}`);
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    control.refreshDimension = () => {
      const pending = scope.invalid.get(key); showProblem(pending?.error);
      if (control !== document.activeElement) control.value = pending ? pending.value : dimensionText(inputs(), field.column, paired.column);
    };
    control.addEventListener("input", () => {
      if (!current() || !rowById(rowId, scope)) return;
      const parsed = parseDimensions(control.value);
      if (parsed.error) scope.invalid.set(key, { value: control.value, error: parsed.error });
      else {
        scope.invalid.delete(key);
        [inputs()[field.column], inputs()[paired.column]] = parsed.values;
      }
      showProblem(parsed.error); changed(rowId, scope);
    });
    control.addEventListener("blur", () => { if (current()) control.refreshDimension(); });
    wrapper.append(label, control, problem); control.refreshDimension(); return wrapper;
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
      if (!error && scope === state && ["AH", "W"].includes(field.column)) warnAdditionalLabour(rowId, scope);
      if (!error && rowId === null && field.group === "SETTINGS" && scope === state.schedule) {
        state.draft.globals[field.column] = value; changed(null, state);
      }
      if (scope === state && !error && ["J", "K", "L", "Y"].includes(field.column)) renderFields();
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
  const diagramMime = filename => /\.png$/i.test(filename) ? "image/png" : /\.webp$/i.test(filename) ? "image/webp" : "image/jpeg";
  function renderDiagram() {
    const section = $("penetration-diagram"); if (!section) return;
    section.hidden = !state.draft || state.group !== "Penetration";
    if (section.hidden) return;
    const preview = $("penetration-diagram-preview"), image = $("penetration-diagram-image"), caption = $("penetration-diagram-caption"), empty = $("penetration-diagram-empty"), remove = $("penetration-diagram-remove");
    const pending = state.diagramChange, libraryId = selected()?.library_item_id;
    let source = "", text = "";
    if (pending && typeof pending === "object") {
      source = `data:${diagramMime(pending.filename)};base64,${pending.content_base64}`;
      text = `${pending.filename} — ready to compress and save to the Firestopping Library.`;
    } else if (libraryId) {
      const version = diagramVersions.get(libraryId) || 0;
      source = `/api/libraries/penetration/${encodeURIComponent(libraryId)}/image${version ? `?v=${version}` : ""}`;
      text = "Saved Firestopping Library source diagram.";
    }
    preview.hidden = !source; empty.hidden = !!source;
    image.onerror = null;
    if (source) {
      image.src = source; caption.textContent = text;
      if (libraryId && pending === undefined) image.onerror = () => { preview.hidden = true; empty.hidden = false; empty.textContent = "No source diagram is saved for this library item."; };
    } else { image.removeAttribute?.("src"); caption.textContent = ""; empty.textContent = "No source diagram is attached to this item."; }
    remove.hidden = !(pending && typeof pending === "object");
    $("penetration-diagram-file").disabled = state.creatingLibrary;
  }
  function queueDiagram(filename, content) {
    if (!state.draft || typeof filename !== "string" || !/\.(?:png|jpe?g|webp)$/i.test(filename)) throw new Error("Choose a PNG, JPEG or WebP source diagram.");
    if (typeof content !== "string" || !content || content.length > 20 * 1_048_576) throw new Error("The source diagram must be no larger than 15 MB.");
    state.diagramChange = { filename, content_base64: content }; state.diagramVersion++; renderDiagram(); status();
  }
  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("The source diagram could not be read."));
      reader.onload = () => { const value = String(reader.result || ""), comma = value.indexOf(","); comma < 0 ? reject(new Error("The source diagram could not be read.")) : resolve(value.slice(comma + 1)); };
      reader.readAsDataURL(file);
    });
  }
  async function chooseDiagram(file) {
    if (!file) return;
    if (file.size > 15 * 1_048_576) throw new Error("The source diagram must be no larger than 15 MB.");
    const context = state.context, read = ++state.diagramRead, content = await fileBase64(file);
    if (!state.draft || context !== state.context || read !== state.diagramRead) return;
    queueDiagram(file.name, content); message("The source diagram is ready. Add this item to the Firestopping Library to save it.");
  }
  function fieldsActive() { return !!document.activeElement?.dataset?.penetrationField; }
  function visibleGroups(inputs) {
    return state.definition.groups.filter(group => {
      const rule = state.definition.group_visibility?.[group];
      const matches = condition => {
        const configured = condition.route_key && state.schedule.draft?.globals?.service_routes?.[condition.route_key];
        return (configured || condition.values || []).includes(inputs?.[condition.column]);
      };
      return !rule || (rule.any ? rule.any.some(matches) : matches(rule));
    });
  }
  function fieldInGroup(field, group) {
    return !field.hidden && (field.display_groups || [field.group]).includes(group);
  }
  const entered = value => value !== null && value !== undefined && value !== "";
  function warnAdditionalLabour(rowId, scope = state) {
    if (scope !== state || !rowId) return;
    const inputs = rowById(rowId, scope)?.inputs || {};
    if (!entered(inputs.AH) || entered(inputs.W)) { state.additionalLabourAdvisory = false; return; }
    if (state.additionalLabourAdvisory) return;
    state.additionalLabourAdvisory = true;
    if (window.CeasefirePenetrationNavigation?.notify) {
      void window.CeasefirePenetrationNavigation.notify("Selection required", "Please select Teams/Crews under Products and Labour", "OK");
    } else message("Please select Teams/Crews under Products and Labour", true);
  }
  function tabExitWarning(targetGroup) {
    if (!state.group || targetGroup === state.group) return null;
    const inputs = selected()?.inputs || {};
    if (state.group === "Bulkhead" && ["BB", "BC", "BD", "BE"].some(column => entered(inputs[column]))) {
      const missing = [["W", "Teams/Crews"], ["X", "Board/Batt Type"], ["Z", "Framing Type"]]
        .filter(([column]) => !entered(inputs[column])).map(([, label]) => `[${label}]`);
      if (missing.length) return { message: `Please select ${missing.join("; ")} under Products and Labour.`, blocking: true };
    }
    if (state.group === "Plastic Pipes" && entered(inputs.Y) && (!entered(inputs.AL) || !entered(inputs.AN))) {
      return { message: "Please enter collar Diameter and Multiplier", blocking: true };
    }
    if (state.group === "Additional Allowances" && entered(inputs.AH) && !entered(inputs.W) && !state.additionalLabourAdvisory) {
      return { message: "Please select Teams/Crews under Products and Labour", key: stable(["additional-labour", inputs.AH]) };
    }
    const materialSelected = ["X", "Y", "Z", "AA", "AB", "AE"].some(column => entered(inputs[column]));
    if (targetGroup !== "Products and labour" && materialSelected && !entered(inputs.W)) {
      return { message: "Please select Teams/Crews", key: stable(["materials", ...["X", "Y", "Z", "AA", "AB", "AE"].map(column => inputs[column] ?? null)]) };
    }
    return null;
  }
  async function selectGroup(group) {
    const warning = tabExitWarning(group);
    if (warning && (warning.blocking || state.tabAdvisoryAcknowledgement !== warning.key)) {
      const context = state.context, stamp = composerStamp(), current = state.group;
      if (window.CeasefirePenetrationNavigation?.notify) {
        await window.CeasefirePenetrationNavigation.notify("Selection required", warning.message, "OK");
      } else message(warning.message, true);
      if (context === state.context && stamp === composerStamp() && current === state.group && !warning.blocking) {
        state.tabAdvisoryAcknowledgement = warning.key;
      }
      return;
    }
    state.tabAdvisoryAcknowledgement = null; state.group = group; renderFields();
  }
  function settingCategory(field) {
    return field.column === "register_allowance_hours" ? "Labour allowances" : field.column.startsWith("pipe_labour_") ? "Pipe labour" : "Material waste";
  }
  function settingContext(field) {
    if (field.column === "register_allowance_hours") return "Every Firestopping item";
    const maximum = field.label.match(/up to\s+([\d.]+\s*mm)/i)?.[1];
    if (maximum) return `Collars for pipes up to ${maximum}`;
    return String(field.help || "").replace(/^Applies to\s+/i, "").replace(/\.$/, "") || "Firestopping estimate";
  }
  const structuredSettingKey = name => keyFor(null, `settings.${name}`);
  function clearStructuredProblems(prefix) {
    for (const scope of [state, state.schedule]) for (const key of [...scope.invalid.keys()]) {
      const [, name] = JSON.parse(key);
      if (String(name).startsWith(`settings.${prefix}`)) scope.invalid.delete(key);
    }
  }
  function structuredProblem(name, value, error, control, problem) {
    const key = structuredSettingKey(name);
    for (const scope of [state, state.schedule]) {
      if (error) scope.invalid.set(key, { value, error }); else scope.invalid.delete(key);
    }
    control.setAttribute("aria-invalid", String(!!error)); problem.textContent = error || ""; problem.hidden = !error;
    if (error) { changed(null, state.schedule); changed(null, state); }
  }
  function updateStructuredSetting(key, value) {
    state.schedule.draft.globals[key] = clone(value); state.draft.globals[key] = clone(value);
    changed(null, state.schedule); changed(null, state);
  }
  function renderServiceRoutes() {
    const section = node("section", "penetration-settings-section"), heading = node("div", "section-heading");
    heading.append(node("h4", "", "Service-tab routing"), node("p", "helper", "Separate service types with semicolons. Matching is exact, so Lagged Pipes and Unlagged Pipes remain independent."));
    const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table penetration-route-table"), head = node("thead"), header = node("tr");
    for (const label of ["Tab", "Service types"] ) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
    head.append(header); table.append(head); const body = node("tbody"), routes = state.schedule.draft.globals.service_routes || {};
    for (const route of state.definition.settings?.service_routes || []) {
      const row = node("tr"), label = node("th", "", route.label); label.scope = "row";
      const value = node("td"), editor = node("textarea"), problem = node("small", "penetration-field-error");
      editor.rows = 2; editor.maxLength = 10000; editor.value = (routes[route.key] || []).join("; ");
      editor.dataset.penetrationServiceRoute = route.key; editor.setAttribute("aria-label", `${route.label} service types`);
      const name = `service_routes.${route.key}`;
      editor.addEventListener("input", () => {
        const services = editor.value.split(";").map(item => item.trim()).filter(Boolean), seen = new Set();
        const unique = services.filter(item => { const key = item.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
        const error = unique.length > 1000 ? "Enter at most 1,000 service types." : unique.some(item => item.length > 200) ? "Each service type must contain at most 200 characters." : "";
        structuredProblem(name, editor.value, error, editor, problem);
        if (!error) { const next = clone(state.schedule.draft.globals.service_routes); next[route.key] = unique; updateStructuredSetting("service_routes", next); }
      });
      editor.addEventListener("blur", () => { if (!state.schedule.invalid.has(structuredSettingKey(name))) renderFields(); });
      problem.hidden = true; value.append(editor, problem); row.append(label, value); body.append(row);
    }
    table.append(body); scroll.append(table); section.append(heading, scroll); return section;
  }
  function bandNumber(text, minimum, label, exclusive = false) {
    const value = String(text).trim();
    if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) return { error: `Enter a finite ${label}.` };
    const number = Number(value);
    if ((exclusive ? number <= minimum : number < minimum) || number > 1e12) {
      return { error: exclusive ? `Enter a ${label} above ${minimum}.` : `Enter a ${label} between ${minimum} and 1,000,000,000,000.` };
    }
    return { value: number };
  }
  function renderLabourBands() {
    const section = node("section", "penetration-settings-section"), heading = node("div", "section-heading");
    heading.append(node("h4", "", "Precalculated task-hour bands"), node("p", "helper", "Edit both thresholds and hours. Bands use the next larger matching threshold; Board, Mastic, Framing and Wrap use the final row above the last threshold.")); section.append(heading);
    for (const definition of state.definition.settings?.labour_bands || []) {
      const rows = state.schedule.draft.globals.labour_bands?.[definition.key] || [], details = node("details", "penetration-band-settings");
      details.open = state.openSettingsBand === definition.key; details.addEventListener("toggle", () => { if (details.open) state.openSettingsBand = definition.key; });
      const summary = node("summary"); summary.append(node("strong", "", definition.label), node("span", "status-label", `${rows.length} ${rows.length === 1 ? "band" : "bands"}`)); details.append(summary);
      const context = node("p", "helper", `${definition.basis}. ${definition.overflow === "manual" ? "Values above the final band require manual Pipe Labour hours." : "Values above the final band use its hours."}`); details.append(context);
      const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table penetration-band-table"), head = node("thead"), header = node("tr");
      for (const label of [`Up to (${definition.units})`, "Hours", "Action"]) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
      head.append(header); table.append(head); const body = node("tbody");
      rows.forEach((band, index) => {
        const row = node("tr");
        for (const property of ["maximum", "hours"]) {
          const cell = node("td"), control = node("input"), problem = node("small", "penetration-field-error"), name = `labour_bands.${definition.key}.${index}.${property}`;
          control.type = "number"; control.step = "any"; control.inputMode = "decimal"; control.value = String(band[property]); control.dataset.penetrationBand = name;
          control.setAttribute("aria-label", `${definition.label} band ${index + 1} ${property === "maximum" ? `maximum ${definition.units}` : "hours"}`);
          control.addEventListener("input", () => {
            const parsed = bandNumber(control.value, 0, property === "maximum" ? "band maximum" : "hours", property === "maximum");
            let error = parsed.error || "";
            if (!error && property === "maximum") {
              const currentRows = state.schedule.draft.globals.labour_bands[definition.key], previous = currentRows[index - 1]?.maximum, next = currentRows[index + 1]?.maximum;
              if (previous !== undefined && parsed.value <= previous) error = `Enter a maximum above ${previous}.`;
              else if (next !== undefined && parsed.value >= next) error = `Enter a maximum below ${next}.`;
            }
            structuredProblem(name, control.value, error, control, problem);
            if (!error) { const bands = clone(state.schedule.draft.globals.labour_bands); bands[definition.key][index][property] = parsed.value; updateStructuredSetting("labour_bands", bands); }
          });
          control.addEventListener("blur", () => { if (!state.schedule.invalid.has(structuredSettingKey(name))) control.value = String(state.schedule.draft.globals.labour_bands[definition.key][index][property]); });
          problem.hidden = true; cell.append(control, problem); row.append(cell);
        }
        const action = node("td"), remove = node("button", "button secondary", "Remove"); remove.type = "button"; remove.disabled = rows.length === 1;
        remove.setAttribute("aria-label", `Remove ${definition.label} band ${index + 1}`); remove.addEventListener("click", () => {
          const bands = clone(state.schedule.draft.globals.labour_bands); if (bands[definition.key].length === 1) return;
          bands[definition.key].splice(index, 1); clearStructuredProblems(`labour_bands.${definition.key}.`); state.openSettingsBand = definition.key; updateStructuredSetting("labour_bands", bands); renderFields();
        });
        action.append(remove); row.append(action); body.append(row);
      });
      table.append(body); scroll.append(table); details.append(scroll);
      const add = node("button", "button secondary penetration-add-band", "+ Add band"); add.type = "button"; add.addEventListener("click", () => {
        const bands = clone(state.schedule.draft.globals.labour_bands), current = bands[definition.key], last = current.at(-1), previous = current.at(-2);
        const increment = previous ? last.maximum - previous.maximum : Math.max(last.maximum * .1, 1);
        if (!(increment > 0) || last.maximum + increment > 1e12) return;
        current.push({ maximum: last.maximum + increment, hours: last.hours }); clearStructuredProblems(`labour_bands.${definition.key}.`); state.openSettingsBand = definition.key; updateStructuredSetting("labour_bands", bands); renderFields();
      });
      details.append(add); section.append(details);
    }
    return section;
  }
  function renderSettings(fields) {
    const root = node("div", "penetration-settings"), intro = node("p", "message info", "These project settings are shared by the current item and the Firestopping Schedule. Calculations retain the source workbook formulas unless you change a band table.");
    const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table"), head = node("thead"), header = node("tr");
    for (const label of ["Setting", "Applies to", "Value"]) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
    head.append(header); table.append(head);
    for (const category of ["Labour allowances", "Pipe labour", "Material waste"]) {
      const matching = fields.filter(field => settingCategory(field) === category); if (!matching.length) continue;
      const body = node("tbody"), groupRow = node("tr", "settings-group-heading"), groupCell = node("th", "", category); groupCell.scope = "rowgroup"; groupCell.colSpan = 3; groupRow.append(groupCell); body.append(groupRow);
      for (const field of matching) {
        const row = node("tr"), label = node("th", "", fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : "")); label.scope = "row";
        const context = node("td", "", settingContext(field)), value = node("td", "penetration-settings-control"); value.append(makeControl(field, null, false, state.schedule)); row.append(label, context, value); body.append(row);
      }
      table.append(body);
    }
    scroll.append(table); root.append(intro, scroll, renderServiceRoutes(), renderLabourBands()); return root;
  }
  function renderFields() {
    if (!state.draft) return;
    const row = selected(), groups = visibleGroups(row.inputs);
    if (!groups.includes(state.group)) state.group = groups[0];
    const buttons = groups.filter(group => group !== "SETTINGS").map(group => {
      const button = node("button", "penetration-group", state.definition.group_labels?.[group] || group); button.type = "button"; button.dataset.penetrationGroup = group;
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(group === state.group));
      button.addEventListener("click", () => selectGroup(group)); return button;
    });
    $("penetration-input-groups").replaceChildren(...buttons);
    $("penetration-settings").setAttribute("aria-pressed", String(state.group === "SETTINGS"));
    const identity = [row.inputs.J, row.inputs.K].filter(value => value !== null && value !== undefined && String(value).trim()).join(" · ");
    $("penetration-row-heading").textContent = `${state.edit ? "Editing schedule item" : "Current item"} · ${identity || "Item details"}`;
    const settings = state.group === "SETTINGS";
    const visible = settings ? state.definition.global_fields || [] : state.definition.row_fields.filter(field => fieldInGroup(field, state.group));
    if (settings) $("penetration-row-fields").replaceChildren(renderSettings(visible));
    else {
      const fields = node("div", "penetration-fields");
      for (const field of visible) {
        const paired = field.paired_column && state.definition.row_fields.find(candidate => candidate.column === field.paired_column);
        fields.append(paired ? makeDimensionControl(field, paired, row.id) : makeControl(field, row.id));
      }
      $("penetration-row-fields").replaceChildren(fields);
    }
    renderDiagram();
  }
  function refreshControls() {
    for (const parent of [$("penetration-row-fields"), $("penetration-schedule-body")]) for (const control of parent.querySelectorAll("[data-penetration-field]")) {
      if (control.dataset.penetrationPaired) { control.refreshDimension?.(); continue; }
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
  async function confirmReplace(title, detail, action, required, cancel = "Keep editing") {
    if (!required) return true;
    if (!window.CeasefirePenetrationNavigation?.confirm) { message("Finish the current item before replacing it.", true); return false; }
    return window.CeasefirePenetrationNavigation.confirm(title, detail, action, cancel);
  }
  function defaultComposer() {
    const draft = clone(state.definition.defaults);
    for (const field of (state.definition.global_fields || []).filter(field => field.group === "SETTINGS")) draft.globals[field.column] = state.schedule.draft?.globals?.[field.column] ?? field.default;
    for (const key of state.definition.settings?.structured_global_keys || []) draft.globals[key] = clone(state.schedule.draft?.globals?.[key] ?? draft.globals[key]);
    draft.rows[0].inputs = { ...newRow(state).inputs, ...draft.rows[0].inputs }; return draft;
  }
  function composerChanged() { return state.invalid.size > 0 || state.diagramChange !== undefined || draftStamp(state.draft) !== draftStamp(defaultComposer()); }
  function replaceComposer(draft, invalid = new Map(), diagramChange = undefined) {
    ++state.composerEpoch; ++state.requestRevision; clearTimeout(state.timer);
    state.draft = clone(draft); state.invalid = new Map(invalid); state.selected = draft.rows[0].id; state.diagramChange = cloneOptional(diagramChange); state.diagramRead++; state.diagramVersion++;
    state.revision++; state.result = null; state.calculating = false; state.additionalLabourAdvisory = false;
    renderFields(); renderSummary(); renderBreakdown(); renderSchedule(); status();
  }
  async function selectRow(id) {
    document.activeElement?.blur?.();
    if (!scheduleRow(id) || state.schedule.invalid.size) return;
    const context = state.context, stamp = composerStamp(), epoch = state.rowEpochs.get(id), target = rowStamp(scheduleRow(id));
    const confirmed = await confirmReplace("Edit schedule item?", "Your current item will be kept so Cancel edit can restore it.", "Edit item", composerChanged());
    if (!confirmed || context !== state.context || stamp !== composerStamp() || epoch !== state.rowEpochs.get(id) || target !== rowStamp(scheduleRow(id))) return;
    const before = state.edit?.before || { draft: clone(state.draft), invalid: [...state.invalid], diagramChange: cloneOptional(state.diagramChange) };
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
    state.edit = null; replaceComposer(edit.before.draft, edit.before.invalid, edit.before.diagramChange); message(); await calculate();
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
    const context = state.context, stamp = composerStamp();
    state.creatingLibrary = true; status();
    try {
      const confirmed = await confirmReplace("Are you sure you want to add this item to the Firestopping Library?", "The current item and its captured price will be saved in the Firestopping Library.", "Yes", true, "Cancel");
      if (!confirmed || context !== state.context || stamp !== composerStamp()) return;
      const row = selected();
      const payload = { draft: libraryDraft(row), configuration: configuration(), ...(state.diagramChange === undefined ? {} : { diagram: clone(state.diagramChange) }) };
      const signature = librarySignature(context, payload);
      // Reuse the key after an uncertain response or a second click on this capture.
      if (state.libraryCapture?.signature !== signature) state.libraryCapture = { signature, key: globalThis.crypto.randomUUID() };
      payload.idempotency_key = state.libraryCapture.key;
      const record = await request("/api/libraries/penetration", payload);
      if (!record.id || !record.library_id || !record.draft || !record.price) throw new Error("The library did not confirm the saved item. Retry to check the same capture.");
      window.CeasefireLibraries?.invalidate?.(); definitions.clear();
      if (context === state.context) {
        const currentPayload = { draft: libraryDraft(rowById(row.id)), configuration: configuration(), ...(state.diagramChange === undefined ? {} : { diagram: clone(state.diagramChange) }) };
        const later = signature !== librarySignature(context, currentPayload);
        if (!later && rowById(row.id)) {
          rowById(row.id).library_item_id = record.id;
          state.diagramChange = undefined; state.diagramRead++; state.diagramVersion++; diagramVersions.set(record.id, (diagramVersions.get(record.id) || 0) + 1);
          state.revision++; state.libraryCapture = null; renderDiagram(); status();
        }
        message(`${record.library_id} ${record.created === false ? "is already in" : "was added to"} the Firestopping Library at ${display(record.price.amount, "currency")}.${later ? " It contains the inputs captured when you clicked Add to Library; later edits are not included." : ""}`);
      }
    } catch (error) { if (context === state.context) message(`Add to Library was not confirmed. ${error.message}`, true); }
    finally { state.creatingLibrary = false; renderDiagram(); status(); }
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
    document.activeElement?.blur?.(); if (!state.draft || state.invalid.size || state.diagramChange !== undefined || state.addingSchedule) return;
    const context = state.context, epoch = state.composerEpoch, revision = state.revision, edit = state.edit;
    const independentCopy = !!edit && !!selected().library_item_id;
    state.addingSchedule = true; status();
    try {
      if (independentCopy) {
        const stamp = composerStamp();
        const confirmed = await confirmReplace("Add a new schedule item?", "A new item will be added to the schedule and the original will also be retained. Do you want to proceed?", "OK", true, "Cancel");
        if (!confirmed || context !== state.context || epoch !== state.composerEpoch || stamp !== composerStamp() || edit !== state.edit || !validEdit()) return;
      }
      const row = appendSchedule(selected().inputs, independentCopy ? null : selected().library_item_id), receipt = await scheduleReceipt(row, "Current item", context);
      if (context === state.context && epoch === state.composerEpoch) message(receipt.message + (revision !== state.revision ? " Later edits to the current item are not included." : ""), receipt.total === null);
      return receipt;
    }
    catch (error) { message(error.message, true); }
    finally { state.addingSchedule = false; status(); }
  }
  async function updateSchedule() {
    document.activeElement?.blur?.(); if (!validEdit() || state.invalid.size || state.schedule.invalid.size || state.updatingSchedule) return;
    const context = state.context, epoch = state.composerEpoch, edit = state.edit, row = scheduleRow(edit.id); row.inputs = clone(selected().inputs);
    if (selected().library_item_id) row.library_item_id = selected().library_item_id; else delete row.library_item_id;
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
        for (let column = 0; column < 8; column++) tr.append(node("td"));
        tr.children[7].className = "penetration-schedule-diagram";
        if (quantityField) tr.children[5].append(makeControl(quantityField, row.id, true, state.schedule));
      }
      const diagramCell = tr.children[7], diagramId = row.library_item_id, diagramVersion = diagramId ? diagramVersions.get(diagramId) || 0 : 0;
      const diagramStamp = diagramId ? `${diagramId}:${diagramVersion}` : "";
      if (diagramCell.dataset.libraryDiagram !== diagramStamp) {
        diagramCell.dataset.libraryDiagram = diagramStamp;
        if (diagramId) {
          const image = node("img"); image.src = `/api/libraries/penetration/${encodeURIComponent(diagramId)}/thumbnail${diagramVersion ? `?v=${diagramVersion}` : ""}`; image.alt = `${row.inputs.T || row.inputs.K || "Firestopping item"} source diagram`; image.loading = "lazy"; image.decoding = "async";
          image.addEventListener("error", () => { if (diagramCell.dataset.libraryDiagram === diagramStamp) diagramCell.replaceChildren(node("span", "helper", "No diagram")); });
          diagramCell.replaceChildren(image);
        } else diagramCell.replaceChildren(node("span", "helper", "—"));
      }
      const values = [line, row.inputs.K || "—", row.inputs.L || "—", row.inputs.M || "—", row.inputs.N || "—", null, display(result?.outputs.H, "currency"), null];
      values.forEach((value, column) => { if (column !== 5 && column !== 7) tr.children[column].textContent = String(value); });
      if (!quantityField) tr.children[5].textContent = display(row.inputs.O);
      for (const control of tr.children[5].querySelectorAll("[data-penetration-field]")) control.setAttribute("aria-label", `Item ${line}: ${fieldLabel(quantityField)}`);
      const actions = node("td", "penetration-item-actions"), edit = node("button", "button secondary", "Edit"); edit.type = "button"; edit.setAttribute("aria-label", `Edit firestopping item ${line}`); edit.addEventListener("click", () => selectRow(row.id));
      const remove = node("button", "button secondary penetration-remove"), icon = node("span"); icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
      remove.append(icon); remove.type = "button"; remove.dataset.penetrationRemove = row.id; remove.title = `Remove item ${line}`; remove.setAttribute("aria-label", `Remove firestopping item ${line}`); remove.disabled = state.schedule.invalid.size > 0; remove.addEventListener("click", () => removeRow(row.id));
      actions.append(edit, remove);
      if (tr.children[8]) tr.children[8].replaceChildren(edit, remove); else tr.append(actions);
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
    $("penetration-loading").hidden = true; $("penetration-workspace").hidden = false; $("penetration-schedule-workspace").hidden = false; $("penetration-schedule-breakdown-card").hidden = false;
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
      const fieldsChanged = JSON.stringify([state.definition.row_fields, state.definition.global_fields, state.definition.settings]) !== JSON.stringify([data.definition?.row_fields || state.definition.row_fields, data.definition?.global_fields || state.definition.global_fields, data.definition?.settings || state.definition.settings]);
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
      if (scope === state.schedule) { $("penetration-schedule-workspace").hidden = false; $("penetration-schedule-breakdown-card").hidden = false; }
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
      state.downloading = true; state.downloadKind = kind; status();
      const saved = await window.CeasefireDownloads.save(`/api/penetration/${kind === "pdf" ? "report.pdf" : "register.xlsx"}`, { draft: snapshot.draft, configuration: pricing, project_details: details });
      const changed = captured !== projectFingerprint() || pricingKey !== configStamp() || JSON.stringify(details) !== JSON.stringify(window.CeasefireProject?.details?.() || {});
      message(`File saved to ${saved.path}.${changed ? " It uses the inputs and prices captured when you clicked Download; later changes are not included." : ""}`, false, state.schedule);
    } catch (error) { message(`The schedule file was not saved. ${error.message}`, true, state.schedule); }
    finally { state.downloading = false; state.downloadKind = null; status(); }
  }
  $("penetration-add").addEventListener("click", addRow); $("penetration-undo").addEventListener("click", undoRemove);
  $("penetration-add-to-library").addEventListener("click", addToLibrary);
  $("penetration-recalculate").addEventListener("click", () => calculate());
  $("penetration-settings").addEventListener("click", () => selectGroup("SETTINGS"));
  $("penetration-diagram-file").addEventListener("change", async event => {
    const input = event.target, file = input.files?.[0]; input.value = "";
    try { await chooseDiagram(file); } catch (error) { message(error.message, true); }
  });
  $("penetration-diagram-remove").addEventListener("click", () => {
    if (state.diagramChange === undefined) return;
    state.diagramChange = undefined; state.diagramRead++; state.diagramVersion++; renderDiagram(); message("The pending source diagram was discarded."); status();
  });
  $("penetration-schedule-recalculate").addEventListener("click", calculateSchedule);
  $("penetration-add-to-schedule").addEventListener("click", addToSchedule);
  $("penetration-update-schedule").addEventListener("click", updateSchedule);
  $("penetration-cancel-edit").addEventListener("click", cancelEdit);
  $("penetration-pdf").addEventListener("click", () => download("pdf")); $("penetration-excel").addEventListener("click", () => download("xlsx"));
  window.CeasefirePenetrations = { open, openSchedule, projectSnapshot, projectFingerprint, quoteSnapshot, quoteFingerprint, scheduleProblem, completeProjectSnapshot, prepareProject, prepareDefaults, applyProject, markProjectSaved, hasUnsavedChanges, pricingChanged, inputProblem, addLibraryItem, libraryQuantity, libraryDiagramChanged };
})();
