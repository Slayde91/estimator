(() => {
  "use strict";
  const $ = id => document.getElementById(id), clone = value => JSON.parse(JSON.stringify(value));
  const state = { record: null, draft: null, definition: null, result: null, group: null, baseline: null,
    invalid: new Map(), session: 0, version: 0, busy: false, pendingFields: false, open: false, requestRevision: 0, opening: 0, timer: null,
    diagramChange: undefined, diagramRead: 0, openSettingsBand: null, tabAdvisoryAcknowledgement: null, additionalLabourAdvisory: false };
  let actions = {};
  let controlSequence = 0;
  const number = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const shiftDecimal = (value, places) => { const [coefficient, exponent = "0"] = String(value).split(/e/i); return Number(`${coefficient}e${Number(exponent) + places}`); };
  const keyFor = (global, column) => `${global ? "global" : "row"}:${column}`;
  const fieldLabel = field => field.column === "J" || field.label === "Type" ? "Category"
    : field.column === "T" || ["Item(s)", "Items/Services"].includes(field.label) ? "Description"
    : ["System", "System/Install"].includes(field.label) ? "System/Install Details"
    : field.column === "AN" && field.label === "Multiplier" ? "Wrap Multiplier"
    : field.column === "X" && field.label === "Board or Batt Type" ? "Board/Batt Type"
    : field.column === "Z" && field.label === "Frame Type" ? "Framing Type" : field.label;
  const manufacturerLabel = (field, value) => field.column === "V" ? String(value).toLowerCase() === "firefly" ? "Firefly" : String(value).toLowerCase() === "trafalgar" ? "Trafalgar" : undefined : undefined;
  const values = global => global ? state.draft.globals : state.draft.rows[0].inputs;
  const fieldGroups = () => (state.definition.groups || [...new Set(state.definition.row_fields.map(field => field.group))]).filter(group => {
    const rule = state.definition.group_visibility?.[group];
    const inputs = state.draft?.rows?.[0]?.inputs, matches = condition => {
      const configured = condition.route_key && state.draft?.globals?.service_routes?.[condition.route_key];
      return (configured || condition.values || []).includes(inputs?.[condition.column]);
    };
    return !rule || (rule.any ? rule.any.some(matches) : matches(rule));
  });
  const fieldInGroup = (field, group) => !field.hidden && (field.display_groups || [field.group]).includes(group);
  const stamp = (draft = state.draft, token = state.record?.pricing_token) => JSON.stringify({ draft, pricing_token: token });
  const hasUnsavedChanges = () => state.open && !!state.record && (stamp() !== state.baseline || state.invalid.size > 0 || state.diagramChange !== undefined);
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
  const diagramMime = filename => /\.png$/i.test(filename) ? "image/png" : /\.webp$/i.test(filename) ? "image/webp" : "image/jpeg";
  function renderDiagram() {
    const preview = $("library-editor-diagram-preview"), image = $("library-editor-diagram-image"), caption = $("library-editor-diagram-caption"), empty = $("library-editor-diagram-empty"), remove = $("library-editor-diagram-remove");
    const pending = state.diagramChange, saved = state.record?.diagram || {};
    let source = "", text = "";
    if (pending && typeof pending === "object") {
      source = `data:${diagramMime(pending.filename)};base64,${pending.content_base64}`;
      text = `${pending.filename} — ready to compress and save.`;
    } else if (pending === undefined && saved.available && saved.url) {
      source = saved.url; text = saved.custom ? "Saved source diagram." : "Original source diagram. Choose an image to replace it for this library item.";
    } else if (pending === null && saved.available && !saved.custom) {
      source = saved.url; text = "The original source diagram will remain after saving.";
    }
    preview.hidden = !source; empty.hidden = !!source;
    if (source) { image.src = source; caption.textContent = text; } else { image.removeAttribute?.("src"); caption.textContent = ""; }
    remove.hidden = !(pending !== undefined || saved.custom);
    remove.textContent = pending === null ? "Undo image change" : pending && typeof pending === "object" ? "Discard selected image" : "Remove saved image";
  }
  function queueDiagram(filename, content) {
    if (!state.open || typeof filename !== "string" || !/\.(?:png|jpe?g|webp)$/i.test(filename)) throw new Error("Choose a PNG, JPEG or WebP source diagram.");
    if (typeof content !== "string" || !content || content.length > 20 * 1_048_576) throw new Error("The source diagram must be no larger than 15 MB.");
    state.diagramChange = { filename, content_base64: content }; state.version++; renderDiagram(); status();
  }
  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The source diagram could not be read."));
      reader.onload = () => { const value = String(reader.result || ""), comma = value.indexOf(","); comma < 0 ? reject(new Error("The source diagram could not be read.")) : resolve(value.slice(comma + 1)); };
      reader.readAsDataURL(file);
    });
  }
  async function chooseDiagram(file) {
    if (!file) return;
    if (file.size > 15 * 1_048_576) throw new Error("The source diagram must be no larger than 15 MB.");
    const session = state.session, read = ++state.diagramRead, content = await fileBase64(file);
    if (!state.open || session !== state.session || read !== state.diagramRead) return;
    queueDiagram(file.name, content); message("The source diagram is ready. Save Library Item to retain the compressed image and thumbnail.");
  }
  function status(text) {
    $("library-editor-status").textContent = text || (state.busy ? "Working…" : state.invalid.size ? "Check input" : state.result?.errors?.length ? "Review calculation" : hasUnsavedChanges() ? "Unsaved library changes" : "Saved library item");
    for (const id of ["library-editor-save", "library-editor-recalculate", "library-editor-refresh-pricing"]) $(id).disabled = !state.record || state.busy || state.invalid.size > 0;
    $("library-editor-cancel").disabled = state.busy;
    $("library-editor-diagram-file").disabled = state.busy;
    $("library-editor-diagram-remove").disabled = state.busy;
    $("library-editor-settings").disabled = !state.record || state.busy;
  }
  function changed() {
    state.version++; state.result = null; renderOutputs(); status(); actions.changed?.();
    for (const control of $("library-editor-fields").querySelectorAll("[data-library-editor-field]")) { control.refreshAutomatic?.(); control.refreshDimension?.(); }
  }
  function displayedInput(field, global) {
    const raw = values(global)[field.column] ?? null;
    return field.automatic_default && (raw === null || raw === "") ? state.result?.rows?.[0]?.input_defaults?.[field.column] ?? null : raw;
  }
  function dimensionText(first, second) {
    const a = values(false)[first], b = values(false)[second];
    if ([a, b].every(value => value === null || value === undefined || value === "")) return "";
    return `${a ?? ""} x ${b ?? ""}`;
  }
  function parseDimensions(text) {
    if (!text.trim()) return { values: [null, null] };
    const match = text.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*[x×]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i);
    if (!match) return { error: "Enter two finite dimensions separated by x, for example 300 x 50." };
    const parsed = [Number(match[1]), Number(match[2])];
    if (parsed.some(value => !Number.isFinite(value) || Math.abs(value) > 1e12)) return { error: "Each dimension must be between -1,000,000,000,000 and 1,000,000,000,000." };
    return { values: parsed };
  }
  function makeDimensionControl(field, paired) {
    const session = state.session, key = keyFor(false, `${field.column}:${paired.column}`), wrapper = node("label", "field");
    const label = `${fieldLabel(field)}${field.units ? ` (${field.units})` : ""}`, control = node("input"), problem = node("small", "penetration-field-error");
    control.type = "text"; control.inputMode = "decimal"; control.autocomplete = "off"; control.maxLength = 100;
    control.placeholder = field.placeholder || "e.g. 300 x 50";
    control.dataset.libraryEditorField = field.column; control.dataset.libraryEditorPaired = paired.column;
    control.dataset.libraryEditorGlobal = "false"; control.setAttribute("aria-label", `Library item: ${label}`);
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    control.refreshDimension = () => {
      const pending = state.invalid.get(key); showProblem(pending?.error);
      if (control !== document.activeElement) control.value = pending ? pending.value : dimensionText(field.column, paired.column);
    };
    control.addEventListener("input", () => {
      if (session !== state.session || !state.open) return;
      const parsed = parseDimensions(control.value);
      if (parsed.error) state.invalid.set(key, { value: control.value, error: parsed.error });
      else {
        state.invalid.delete(key);
        const target = values(false); [target[field.column], target[paired.column]] = parsed.values;
      }
      showProblem(parsed.error); changed();
    });
    control.addEventListener("blur", () => { if (session === state.session) control.refreshDimension(); });
    wrapper.append(node("span", "", label), control, problem); control.refreshDimension(); return wrapper;
  }
  function makeControl(field, global) {
    const session = state.session, key = keyFor(global, field.column), raw = values(global)[field.column] ?? null;
    const manufacturer = !global && manufacturerLabel(field, raw);
    // Match known casing variants without changing the stored manufacturer's value.
    const options = [...new Set((field.options || []).map(value => manufacturer && manufacturerLabel(field, value) === manufacturer ? raw : value))];
    const long = field.type === "text" && ["T", "U"].includes(field.column);
    const wrapper = node(field.automatic_default ? "div" : "label", `field${long ? " library-editor-long-text" : ""}`), label = fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : "");
    const control = node(field.type === "select" ? "select" : long ? "textarea" : "input"), problem = node("small", "penetration-field-error");
    if (field.help) { wrapper.title = field.help; control.title = field.help; }
    control.dataset.libraryEditorField = field.column; control.dataset.libraryEditorGlobal = String(global); control.setAttribute("aria-label", `${global ? "Item allowance" : "Library item"}: ${label}`);
    if (field.type === "select") {
      const empty = node("option", "", "Choose…"); empty.value = ""; control.append(empty);
      for (const value of options) { const option = node("option", "", manufacturerLabel(field, value) || value); option.value = String(value); control.append(option); }
      if (raw !== null && raw !== "" && !options.some(value => String(value) === String(raw))) { const saved = node("option", "", manufacturer || `Saved value: ${raw} (choose a listed value)`); saved.value = String(raw); saved.disabled = true; control.append(saved); }
    } else {
      if (long) { control.rows = 3; control.maxLength = 2000; }
      else if (field.type === "number") {
        control.type = "number"; control.step = String(field.step ?? "any");
        control.inputMode = "decimal"; control.autocomplete = "off";
      } else { control.type = "text"; control.maxLength = 2000; }
    }
    const pending = state.invalid.get(key); control.value = pending ? pending.value : controlText(field, displayedInput(field, global));
    if (field.enabled_when) control.disabled = field.enabled_when.nonblank && [null, undefined, ""].includes(state.draft.rows[0].inputs[field.enabled_when.column]);
    const showProblem = text => { control.setAttribute("aria-invalid", String(!!text)); problem.textContent = text || ""; problem.hidden = !text; };
    showProblem(pending?.error);
    control.addEventListener("focus", () => { if (session === state.session && field.type === "number" && !state.invalid.has(key)) { control.value = controlText(field, displayedInput(field, global), true); control.select?.(); } });
    control.addEventListener(field.type === "select" ? "change" : "input", () => {
      if (session !== state.session || !state.open) return;
      let value = control.value, error = "";
      if (field.type === "number") {
        const text = value.trim();
        if (!text) value = null;
        else if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) error = "Enter a finite number or leave this field blank.";
        else { value = field.format === "percent" ? shiftDecimal(text, -2) : Number(text); if (!Number.isFinite(value) || Math.abs(value) > 1e12) error = "Enter a value between -1,000,000,000,000 and 1,000,000,000,000."; else if (numeric(field.min) && value < field.min) error = `Enter a value of at least ${field.min}.`; }
      } else if (field.type === "select") {
        value = value === "" ? null : options.find(option => String(option) === value);
        if (value === undefined) error = "Choose a listed value.";
      }
      if (error) state.invalid.set(key, { value: control.value, error }); else { state.invalid.delete(key); values(global)[field.column] = value; }
      showProblem(error); changed();
      if (!error && !global && ["AH", "W"].includes(field.column)) warnAdditionalLabour();
      if (!error && ["J", "K", "Y"].includes(field.column)) renderFields();
    });
    control.addEventListener("blur", () => {
      if (session !== state.session) return;
      if (!state.invalid.has(key)) control.value = controlText(field, displayedInput(field, global));
      if (state.pendingFields) { state.pendingFields = false; renderFields(); }
    });
    wrapper.append(node("span", "", label), control, problem);
    if (field.automatic_default) {
      const tools = node("div", "penetration-automatic-tools"), hint = node("small", "helper"), reset = node("button", "button secondary", "Use automatic");
      hint.id = `library-editor-default-${++controlSequence}`; control.setAttribute("aria-describedby", hint.id);
      reset.type = "button"; reset.setAttribute("aria-label", `Use automatic ${fieldLabel(field)}`);
      control.refreshAutomatic = () => {
        const value = values(global)[field.column], automatic = value === null || value === undefined || value === "";
        const defaults = state.result?.rows?.[0]?.input_defaults;
        hint.textContent = !automatic ? "Manual allowance." : !defaults ? "Automatic value updates after calculation." : numeric(defaults[field.column]) ? `Automatic: ${controlText(field, defaults[field.column])}${field.units ? ` ${field.units}` : ""}.` : "No automatic value for this item. Enter hours if required.";
        reset.disabled = automatic && !state.invalid.has(key);
        if (control !== document.activeElement && !state.invalid.has(key)) control.value = controlText(field, displayedInput(field, global));
      };
      reset.addEventListener("click", () => {
        if (session !== state.session || !state.open) return;
        values(global)[field.column] = null; state.invalid.delete(key); showProblem(""); changed(); control.value = "";
      });
      control.refreshAutomatic(); tools.append(hint, reset); wrapper.append(tools);
    }
    return wrapper;
  }
  const entered = value => value !== null && value !== undefined && value !== "";
  function warnAdditionalLabour() {
    const inputs = state.draft?.rows?.[0]?.inputs || {};
    if (!entered(inputs.AH) || entered(inputs.W)) { state.additionalLabourAdvisory = false; return; }
    if (state.additionalLabourAdvisory) return;
    state.additionalLabourAdvisory = true;
    if (window.CeasefirePenetrationNavigation?.notify) void window.CeasefirePenetrationNavigation.notify("Selection required", "Please select Teams/Crews under Products and Labour", "OK");
    else message("Please select Teams/Crews under Products and Labour", true);
  }
  function tabExitWarning(targetGroup) {
    if (!state.group || targetGroup === state.group) return null;
    const inputs = state.draft?.rows?.[0]?.inputs || {};
    if (state.group === "Bulkhead" && ["BB", "BC", "BD", "BE"].some(column => entered(inputs[column]))) {
      const missing = [["W", "Teams/Crews"], ["X", "Board/Batt Type"], ["Z", "Framing Type"]]
        .filter(([column]) => !entered(inputs[column])).map(([, label]) => `[${label}]`);
      if (missing.length) return { message: `Please select ${missing.join("; ")} under Products and Labour.`, blocking: true };
    }
    if (state.group === "Plastic Pipes" && entered(inputs.Y) && (!entered(inputs.AL) || !entered(inputs.AN))) {
      return { message: "Please enter collar Diameter and Multiplier", blocking: true };
    }
    if (state.group === "Additional Allowances" && entered(inputs.AH) && !entered(inputs.W) && !state.additionalLabourAdvisory) {
      return { message: "Please select Teams/Crews under Products and Labour", key: JSON.stringify(["additional-labour", inputs.AH]) };
    }
    const materialSelected = ["X", "Y", "Z", "AA", "AB", "AE"].some(column => entered(inputs[column]));
    if (targetGroup !== "Products and labour" && materialSelected && !entered(inputs.W)) {
      return { message: "Please select Teams/Crews", key: JSON.stringify(["materials", ...["X", "Y", "Z", "AA", "AB", "AE"].map(column => inputs[column] ?? null)]) };
    }
    return null;
  }
  async function selectGroup(group) {
    const warning = tabExitWarning(group);
    if (warning && (warning.blocking || state.tabAdvisoryAcknowledgement !== warning.key)) {
      const session = state.session, version = state.version, current = state.group;
      if (window.CeasefirePenetrationNavigation?.notify) await window.CeasefirePenetrationNavigation.notify("Selection required", warning.message, "OK");
      else message(warning.message, true);
      if (state.open && session === state.session && version === state.version && current === state.group && !warning.blocking) state.tabAdvisoryAcknowledgement = warning.key;
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
    return String(field.help || "").replace(/^Applies to\s+/i, "").replace(/\.$/, "") || "Firestopping library item";
  }
  const structuredSettingKey = name => `structured:${name}`;
  function clearStructuredProblems(prefix) {
    for (const key of [...state.invalid.keys()]) if (key.startsWith(`structured:${prefix}`)) state.invalid.delete(key);
  }
  function structuredProblem(name, value, error, control, problem) {
    const key = structuredSettingKey(name);
    if (error) state.invalid.set(key, { value, error }); else state.invalid.delete(key);
    control.setAttribute("aria-invalid", String(!!error)); problem.textContent = error || ""; problem.hidden = !error;
    if (error) changed();
  }
  function updateStructuredSetting(key, value) {
    state.draft.globals[key] = clone(value); changed();
  }
  function renderServiceRoutes() {
    const section = node("section", "penetration-settings-section"), heading = node("h4", "penetration-settings-subheading", "SERVICE-TAB ROUTING");
    const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table penetration-route-table"), head = node("thead"), header = node("tr");
    for (const label of ["Tab", "Service types"]) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
    head.append(header); table.append(head); const body = node("tbody"), routes = state.draft.globals.service_routes || {};
    for (const route of state.definition.settings?.service_routes || []) {
      const row = node("tr"), label = node("th", "", route.label); label.scope = "row";
      const value = node("td"), editor = node("textarea"), problem = node("small", "penetration-field-error");
      editor.rows = 2; editor.maxLength = 10000; editor.value = (routes[route.key] || []).join("; ");
      editor.dataset.libraryEditorServiceRoute = route.key; editor.setAttribute("aria-label", `${route.label} service types`);
      const name = `service_routes.${route.key}`;
      editor.addEventListener("input", () => {
        const services = editor.value.split(";").map(item => item.trim()).filter(Boolean), seen = new Set();
        const unique = services.filter(item => { const key = item.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
        const error = unique.length > 1000 ? "Enter at most 1,000 service types." : unique.some(item => item.length > 200) ? "Each service type must contain at most 200 characters." : "";
        structuredProblem(name, editor.value, error, editor, problem);
        if (!error) { const next = clone(state.draft.globals.service_routes); next[route.key] = unique; updateStructuredSetting("service_routes", next); }
      });
      editor.addEventListener("blur", () => { if (!state.invalid.has(structuredSettingKey(name))) renderFields(); });
      problem.hidden = true; value.append(editor, problem); row.append(label, value); body.append(row);
    }
    table.append(body); scroll.append(table); section.append(heading, scroll); return section;
  }
  function bandNumber(text, minimum, label, exclusive = false) {
    const value = String(text).trim();
    if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) return { error: `Enter a finite ${label}.` };
    const parsed = Number(value);
    if ((exclusive ? parsed <= minimum : parsed < minimum) || parsed > 1e12) return { error: exclusive ? `Enter a ${label} above ${minimum}.` : `Enter a ${label} between ${minimum} and 1,000,000,000,000.` };
    return { value: parsed };
  }
  function renderLabourBands() {
    const section = node("section", "penetration-settings-section"), heading = node("h4", "penetration-settings-subheading", "PRECALCULATED TASK-HOUR BANDS");
    section.append(heading);
    for (const definition of state.definition.settings?.labour_bands || []) {
      const rows = state.draft.globals.labour_bands?.[definition.key] || [], details = node("details", "penetration-band-settings");
      details.open = state.openSettingsBand === definition.key; details.addEventListener("toggle", () => { if (details.open) state.openSettingsBand = definition.key; });
      const summary = node("summary"); summary.append(node("strong", "", definition.label), node("span", "status-label", `${rows.length} ${rows.length === 1 ? "band" : "bands"}`)); details.append(summary);
      details.append(node("p", "helper", `${definition.basis}. ${definition.overflow === "manual" ? "Values above the final band require manual Pipe Labour hours." : "Values above the final band use its hours."}`));
      const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table penetration-band-table"), head = node("thead"), header = node("tr");
      for (const label of [`Up to (${definition.units})`, "Hours", "Action"]) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
      head.append(header); table.append(head); const body = node("tbody");
      rows.forEach((band, index) => {
        const row = node("tr");
        for (const property of ["maximum", "hours"]) {
          const cell = node("td"), control = node("input"), problem = node("small", "penetration-field-error"), name = `labour_bands.${definition.key}.${index}.${property}`;
          control.type = "number"; control.step = "any"; control.inputMode = "decimal"; control.value = String(band[property]); control.dataset.libraryEditorBand = name;
          control.setAttribute("aria-label", `${definition.label} band ${index + 1} ${property === "maximum" ? `maximum ${definition.units}` : "hours"}`);
          control.addEventListener("input", () => {
            const parsed = bandNumber(control.value, 0, property === "maximum" ? "band maximum" : "hours", property === "maximum");
            let error = parsed.error || "";
            if (!error && property === "maximum") {
              const currentRows = state.draft.globals.labour_bands[definition.key], previous = currentRows[index - 1]?.maximum, next = currentRows[index + 1]?.maximum;
              if (previous !== undefined && parsed.value <= previous) error = `Enter a maximum above ${previous}.`;
              else if (next !== undefined && parsed.value >= next) error = `Enter a maximum below ${next}.`;
            }
            structuredProblem(name, control.value, error, control, problem);
            if (!error) { const bands = clone(state.draft.globals.labour_bands); bands[definition.key][index][property] = parsed.value; updateStructuredSetting("labour_bands", bands); }
          });
          control.addEventListener("blur", () => { if (!state.invalid.has(structuredSettingKey(name))) control.value = String(state.draft.globals.labour_bands[definition.key][index][property]); });
          problem.hidden = true; cell.append(control, problem); row.append(cell);
        }
        const action = node("td"), remove = node("button", "button secondary", "Remove"); remove.type = "button"; remove.disabled = rows.length === 1;
        remove.setAttribute("aria-label", `Remove ${definition.label} band ${index + 1}`); remove.addEventListener("click", () => {
          const bands = clone(state.draft.globals.labour_bands); if (bands[definition.key].length === 1) return;
          bands[definition.key].splice(index, 1); clearStructuredProblems(`labour_bands.${definition.key}.`); state.openSettingsBand = definition.key; updateStructuredSetting("labour_bands", bands); renderFields();
        });
        action.append(remove); row.append(action); body.append(row);
      });
      table.append(body); scroll.append(table); details.append(scroll);
      const add = node("button", "button secondary penetration-add-band", "+ Add band"); add.type = "button"; add.addEventListener("click", () => {
        const bands = clone(state.draft.globals.labour_bands), current = bands[definition.key], last = current.at(-1), previous = current.at(-2);
        const increment = previous ? last.maximum - previous.maximum : Math.max(last.maximum * .1, 1);
        if (!(increment > 0) || last.maximum + increment > 1e12) return;
        current.push({ maximum: last.maximum + increment, hours: last.hours }); clearStructuredProblems(`labour_bands.${definition.key}.`); state.openSettingsBand = definition.key; updateStructuredSetting("labour_bands", bands); renderFields();
      });
      details.append(add); section.append(details);
    }
    return section;
  }
  function renderSettings(fields) {
    const root = node("div", "penetration-settings"), intro = node("p", "message info", "These settings are saved with this Firestopping Library item. Calculations retain the source workbook formulas unless you change a band table.");
    const scroll = node("div", "table-scroll"), table = node("table", "penetration-settings-table"), head = node("thead"), header = node("tr");
    for (const label of ["Setting", "Applies to", "Value"]) { const cell = node("th", "", label); cell.scope = "col"; header.append(cell); }
    head.append(header); table.append(head);
    for (const category of ["Labour allowances", "Pipe labour", "Material waste"]) {
      const matching = fields.filter(field => settingCategory(field) === category); if (!matching.length) continue;
      const body = node("tbody"), groupRow = node("tr", "settings-group-heading"), groupCell = node("th", "", category); groupCell.scope = "rowgroup"; groupCell.colSpan = 3; groupRow.append(groupCell); body.append(groupRow);
      for (const field of matching) {
        const row = node("tr"), label = node("th", "", fieldLabel(field) + (field.units ? ` (${field.units})` : field.format === "percent" ? " (%)" : "")); label.scope = "row";
        const context = node("td", "", settingContext(field)), value = node("td", "penetration-settings-control"); value.append(makeControl(field, true)); row.append(label, context, value); body.append(row);
      }
      table.append(body);
    }
    scroll.append(table); root.append(intro, scroll, renderServiceRoutes(), renderLabourBands()); return root;
  }
  function renderFields() {
    const groups = fieldGroups(); if (!groups.includes(state.group)) state.group = groups[0];
    $("library-editor-groups").replaceChildren(...groups.filter(group => group !== "SETTINGS").map(group => {
      const button = node("button", "penetration-group", state.definition.group_labels?.[group] || group); button.type = "button"; button.dataset.libraryEditorGroup = group; button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(group === state.group));
      button.addEventListener("click", () => selectGroup(group)); return button;
    }));
    $("library-editor-settings").setAttribute("aria-pressed", String(state.group === "SETTINGS"));
    const fields = node("div", "library-editor-fields"), settings = state.group === "SETTINGS";
    const visible = settings ? state.definition.global_fields || [] : state.definition.row_fields.filter(field => fieldInGroup(field, state.group));
    if (settings) $("library-editor-fields").replaceChildren(renderSettings(visible));
    else {
      fields.append(...visible.map(field => {
        const paired = field.paired_column && state.definition.row_fields.find(candidate => candidate.column === field.paired_column);
        return paired ? makeDimensionControl(field, paired) : makeControl(field, false);
      })); $("library-editor-fields").replaceChildren(fields);
    }
  }
  function renderOutputs() {
    const price = state.result ? state.result.rows?.[0]?.outputs?.H : (!hasUnsavedChanges() ? state.record.price?.amount : null);
    $("library-editor-price").textContent = display(price, "currency");
    $("library-editor-pricing-basis").textContent = state.record.pricing_label || "Workbook prices";
    const labels = { materials: "Materials", labour: "Labour", grand_total: "Grand total", total_days: "Total days", labour_hours: "Task Hours" };
    $("library-editor-summary").replaceChildren(...Object.entries(labels).map(([key, label]) => { const line = node("div", key === "grand_total" ? "subtotal" : ""); line.append(node("dt", "", label), node("dd", "", display(state.result?.summary?.[key], ["total_days", "labour_hours"].includes(key) ? "number" : "currency"))); return line; }));
    const errors = state.result?.errors || [];
    $("library-editor-summary-notes").textContent = errors.length ? errors.map(error => `${state.definition.row_fields.find(field => field.column === error.cell)?.label || error.cell}: ${error.message}`).join("\n") : "Calculated from this library item's inputs and selected pricing basis.";
    const row = state.result?.rows?.[0], breakdown = $("library-editor-breakdown");
    breakdown.replaceChildren(window.CeasefirePenetrationBreakdown.render(state.definition, row));
  }
  function present(record, handlers = {}) {
    if (!record?.draft || !record.definition || record.draft.rows?.length !== 1) throw new Error("The library item does not contain one editable source row.");
    state.session++; Object.assign(state, { record: clone(record), draft: clone(record.draft), definition: clone(record.definition), result: clone(record.result || null),
      group: record.definition.groups?.[0], baseline: stamp(record.draft, record.pricing_token), invalid: new Map(), version: 0, busy: false, pendingFields: false, open: true, diagramChange: undefined, openSettingsBand: null, tabAdvisoryAcknowledgement: null, additionalLabourAdvisory: false });
    clearTimeout(state.timer); state.requestRevision++;
    actions = { changed: scheduleCalculation, calculate, refreshPricing, save, cancel, ...handlers };
    $("library-editor-identity").textContent = record.title || record.library_id || record.id;
    $("firestopping-project-workspace").hidden = true; $("firestopping-library-editor").hidden = false;
    renderFields(); renderOutputs(); renderDiagram(); status(); message();
  }
  function close() {
    state.session++; state.requestRevision++; state.opening++; clearTimeout(state.timer);
    Object.assign(state, { open: false, record: null, draft: null, result: null, baseline: null, busy: false, invalid: new Map(), diagramChange: undefined, openSettingsBand: null, tabAdvisoryAcknowledgement: null, additionalLabourAdvisory: false });
    $("firestopping-library-editor").hidden = true; $("firestopping-project-workspace").hidden = false;
  }
  function inputProblem() { return state.invalid.size ? "Correct the library item input marked invalid before continuing." : ""; }
  function snapshot(includeDiagram = false) {
    const payload = { draft: clone(state.draft), revision: state.record.revision, pricing_token: state.record.pricing_token };
    if (includeDiagram && state.diagramChange !== undefined) payload.diagram = clone(state.diagramChange);
    return { id: state.record.id, session: state.session, version: state.version, payload };
  }
  function current(captured) { return state.open && state.session === captured.session && state.record.id === captured.id; }
  function refreshFields() {
    if (document.activeElement?.dataset?.libraryEditorField) {
      state.pendingFields = true;
      for (const control of $("library-editor-fields").querySelectorAll("[data-library-editor-field]")) control.refreshAutomatic?.();
      return;
    }
    renderFields();
  }
  function adopt(record, keepDraft = false) {
    state.record = clone(record); state.definition = clone(record.definition);
    if (!keepDraft) state.draft = clone(record.draft);
    state.result = keepDraft ? null : clone(record.result || null);
    $("library-editor-identity").textContent = record.title || record.library_id || record.id;
    refreshFields(); renderOutputs(); renderDiagram(); status();
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
    const captured = snapshot(true), revision = ++state.requestRevision;
    let reschedule = false; state.busy = true; status("Saving library item…");
    try {
      const record = await request(captured.id, "save", captured.payload);
      if (!current(captured) || revision !== state.requestRevision) return;
      const later = state.version !== captured.version || state.invalid.size > 0;
      if (Object.hasOwn(captured.payload, "diagram") && JSON.stringify(state.diagramChange) === JSON.stringify(captured.payload.diagram)) state.diagramChange = undefined;
      adopt(record, later); state.baseline = stamp(record.draft, record.pricing_token);
      window.CeasefireLibraries?.invalidate?.();
      if (Object.hasOwn(captured.payload, "diagram")) window.CeasefirePenetrations?.libraryDiagramChanged?.(captured.id);
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
  $("library-editor-settings").addEventListener("click", () => selectGroup("SETTINGS"));
  $("library-editor-save").addEventListener("click", () => actions.save?.());
  $("library-editor-cancel").addEventListener("click", () => actions.cancel?.());
  $("library-editor-diagram-file").addEventListener("change", async event => {
    try { await chooseDiagram(event.target.files?.[0]); }
    catch (error) { message(error.message, true); }
    finally { event.target.value = ""; }
  });
  $("library-editor-diagram-remove").addEventListener("click", () => {
    if (!state.open || state.busy) return;
    state.diagramChange = state.diagramChange !== undefined ? undefined : null;
    state.version++; renderDiagram(); status(); message(state.diagramChange === null ? "The saved image will be removed when you save this library item." : "The current saved image is retained.");
  });
  window.CeasefireLibraryEditor = { open, present, close, isOpen: () => state.open, hasUnsavedChanges, inputProblem };
})();
