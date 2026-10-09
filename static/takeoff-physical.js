"use strict";

// Manual record confirmation is a draft review marker, separate from technical
// approval and commercial links. This component derives no image quantities.
((root) => {
  const kinds = ["defect", "barrier", "service"];
  const legacyKinds = ["barrier", "defect", "opening", "service"];
  const collections = { barrier: "barriers", defect: "defects", opening: "openings", service: "services" };
  const parents = { barrier: ["defect", "defect_id"], service: ["barrier", "barrier_id"] };
  const servicePlanParents = { service: ["barrier", "barrier_id"] };
  const legacyParents = { defect: ["barrier", "barrier_id"], opening: ["defect", "defect_id"], service: ["opening", "opening_id"] };
  const titles = { barrier: "Barrier", defect: "Defect", opening: "Opening", service: "Service" };
  const dimensions = new Set(["thickness_mm", "width_mm", "height_mm", "diameter_mm", "depth_mm", "insulation_mm"]);
  const uncertainty = [
    ["not_assessed", "Not assessed"], ["unresolved", "Unresolved"], ["missing", "Missing evidence"],
    ["conflicting", "Conflicting evidence"], ["insufficient_evidence", "Insufficient evidence"],
    ["human_review_required", "Needs review"], ["none_reported", "No uncertainty reported (unapproved draft)"],
  ];
  const confirmationOptions = [["unconfirmed", "Unconfirmed"], ["confirmed", "Confirmed"]];
  const recordConfirmation = entity => entity?.confirmation === "confirmed" ? "confirmed" : "unconfirmed";
  const confirmationLabel = entity => recordConfirmation(entity) === "confirmed" ? "Confirmed" : "Unconfirmed";
  function confirmationOwner(entry, index) {
    if (!entry) return null;
    if (entry.legacy) return entry;
    const ownerKind = entry.servicePlans ? "barrier" : "defect", relations = entry.servicePlans ? servicePlanParents : parents;
    let current = entry;
    for (let depth = 0; current && depth < 3; depth++) {
      if (current.entity.deleted) return null;
      if (current.kind === ownerKind) return current;
      const relation = relations[current.kind], parent = relation && index.get(current.entity[relation[1]]);
      if (!parent || parent.kind !== relation[0]) return null;
      current = parent;
    }
    return null;
  }
  const effectiveConfirmation = (entry, index) => recordConfirmation(confirmationOwner(entry, index)?.entity);
  const definitions = {
    barrier: [["location", "Location"], ["barrier_type", "Barrier type", ["Empty Opening", "Core hole", "Oversized"].map(value => [value, value])], ["substrate", "Substrate"], ["orientation", "Substrate orientation"], ["notes", "Notes", "textarea"]],
    defect: [["label", "Defect Ref."], ["location", "Location"], ["frl", "FRL"], ["notes", "Notes", "textarea"]],
    service: [["service", "Category"], ["service_type", "Service type"], ["size", "Service Size (mm)"], ["notes", "Notes", "textarea"]],
  };
  const fieldsFor = (kind, scope = "defect_reports") => kind !== "barrier" ? definitions[kind] : scope === "service_plans" ? [...definitions.barrier.slice(0, 1), ["frl", "FRL"], ...definitions.barrier.slice(1)] : definitions.barrier.filter(([key]) => key !== "location");
  const sharedOptionKeys = new Set(["substrate", "orientation", "service", "service_type", "frl"]);
  const retainedDefinitions = { barrier: [["label", "Barrier label"], ["thickness_mm", "Thickness (mm)"]], service: [["label", "Service label"]] };
  // Original four-level records remain readable, without editable opening fields.
  const legacyOpeningFields = [["label", "Opening label"], ["opening_type", "Opening type"], ["size", "Opening size / source designation"], ["shape", "Opening shape"], ["width_mm", "Width (mm)"], ["height_mm", "Height (mm)"], ["diameter_mm", "Diameter (mm)"], ["depth_mm", "Depth (mm)"], ["notes", "Notes"]];
  const copy = value => JSON.parse(JSON.stringify(value));
  const displayId = entry => entry?.entity.display_id || entry?.entity.id || "";
  const entityName = entry => entry.entity.fields.label || displayId(entry);
  const parentId = entry => { const relation = (entry.legacy ? legacyParents : entry.servicePlans ? servicePlanParents : parents)[entry.kind]; return relation ? entry.entity[relation[1]] : null; };
  const draftWarning = "UNAPPROVED DRAFT. These are recorded physical assertions, not validated or confirmed quantities. Images, repeated photographs and opposite-face views never create or multiply physical objects. Link each service to its actual barrier within a defect. A barrier without services has zero service quantity.";
  function formatDimensions(fields = {}) { return fields.width_mm == null && fields.height_mm == null ? "" : `${fields.width_mm ?? ""} x ${fields.height_mm ?? ""}`; }
  function parseDimensions(value) {
    const text = String(value ?? "").trim(); if (!text) return {};
    if (!/^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*[xX×]\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(text)) throw new Error("Width x Height (mm): enter two positive dimensions, for example 100x100, or clear both dimensions.");
    const [width_mm, height_mm] = text.split(/[xX×]/).map(Number);
    if (![width_mm, height_mm].every(value => Number.isFinite(value) && value > 0 && value <= 1e12)) throw new Error("Width x Height (mm): known dimensions must be positive finite numbers no greater than 1,000,000,000,000 mm.");
    return { width_mm, height_mm };
  }
  const fieldDisplay = (fields, key) => key === "width_height_mm" ? formatDimensions(fields) : fields?.[key];
  const recordedQuantity = (entity, value) => entity.library_quantity && (value === "" || value == null) ? null : fieldValue("service", "quantity", value);
  const evidenceFields = key => key === "width_height_mm" ? ["width_mm", "height_mm"] : [key];
  const markerDescription = marker => marker ? `${marker.document_id} · p${marker.page} · (${marker.point?.join(", ")})` : "none";

  function indexGraph(graph) {
    const index = new Map();
    const legacy = graph?.version === 1;
    const servicePlans = graph?.version === 3;
    for (const kind of legacy ? legacyKinds : servicePlans ? ["barrier", "service"] : kinds) for (const entity of graph?.[collections[kind]] || []) index.set(entity.id, { kind, entity, legacy, servicePlans });
    return index;
  }
  function ancestors(entry, index) {
    const result = []; let current = entry;
    for (let depth = 0; current && depth < 4; depth++) {
      const parent = index.get(parentId(current)); if (!parent) break; result.unshift(parent); current = parent;
    }
    return result;
  }
  const filterColumns = { state: "Confirmation", location: "Location", frl: "FRL", substrate: "Substrate", orientation: "Orientation", service: "Category", service_type: "Service type", size: "Service Size (mm)" };
  function columnValue(entry, key, index) {
    const lineage = [...ancestors(entry, index), entry], find = kind => lineage.find(value => value.kind === kind), barrier = find("barrier"), defect = find("defect");
    const fields = entry.entity.fields;
    if (key === "state") return confirmationLabel(confirmationOwner(entry, index)?.entity);
    if (key === "location") return String((entry.legacy ? (entry.kind === "barrier" || entry.kind === "defect" ? fields.location : defect?.entity.fields.location ?? barrier?.entity.fields.location) : (entry.servicePlans ? barrier : defect)?.entity.fields.location) ?? "").trim();
    if (key === "frl") return String((entry.servicePlans ? barrier : defect)?.entity.fields.frl ?? "").trim();
    if (key === "substrate" || key === "orientation") return String(barrier?.entity.fields[key] ?? "").trim();
    return String(entry.kind === "service" ? fields[key] ?? "" : "").trim();
  }
  function hierarchyRows(graph, { filter = "", collapsed = new Set(), showDeleted = false, columnFilters = new Map() } = {}) {
    const index = indexGraph(graph), included = new Set(), matching = new Set(), query = filter.toLocaleLowerCase().trim();
    for (const [id, entry] of index) {
      if (entry.entity.deleted && !showDeleted) continue;
      const searchable = [entry.kind, id, entry.entity.display_id, ...Object.values(entry.entity.fields), ...Object.keys(filterColumns).map(key => columnValue(entry, key, index)), entry.entity.uncertainty?.state, entry.entity.uncertainty?.note].join(" ").toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
      if (![...columnFilters].every(([key, values]) => values.has(columnValue(entry, key, index)))) continue;
      included.add(id); matching.add(id);
      for (const parent of ancestors(entry, index)) included.add(parent.entity.id);
    }
    const children = new Map();
    for (const [id, entry] of index) if (included.has(id)) {
      const key = parentId(entry); if (!children.has(key)) children.set(key, []); children.get(key).push(entry);
    }
    for (const entries of children.values()) entries.sort((a, b) => (a.legacy ? entityName(a) : displayId(a)).localeCompare(b.legacy ? entityName(b) : displayId(b), "en-AU", { numeric: true }) || a.entity.id.localeCompare(b.entity.id));
    const rows = [];
    function visit(entry, depth) {
      rows.push({ ...entry, depth, context: !matching.has(entry.entity.id), hasChildren: !!children.get(entry.entity.id)?.length });
      if (query || columnFilters.size || !collapsed.has(entry.entity.id)) for (const child of children.get(entry.entity.id) || []) visit(child, depth + 1);
    }
    for (const entry of children.get(null) || []) visit(entry, 0);
    return rows;
  }
  function hierarchyPage(rows, index, offset, limit = 100) {
    const selected = rows.slice(offset, offset + limit), seen = new Set(), output = [];
    for (const row of selected) {
      for (const parent of ancestors(row, index)) if (!seen.has(parent.entity.id)) {
        output.push({ ...parent, depth: ancestors(parent, index).length, context: true, continued: true, hasChildren: true }); seen.add(parent.entity.id);
      }
      if (!seen.has(row.entity.id)) { output.push(row); seen.add(row.entity.id); }
    }
    return output;
  }
  function fieldValue(kind, key, value, scope = "defect_reports") {
    if (key === "quantity") {
      if (typeof value === "string" && !/^\d+(?:\.0+)?$/.test(value.trim())) throw new Error("Every service needs an explicit positive whole quantity.");
      const number = value === "" || value == null ? NaN : Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || number > 1e12) throw new Error("Every service needs an explicit positive whole quantity.");
      return number;
    }
    if (!fieldsFor(kind, scope)?.some(definition => definition[0] === key)) throw new Error("Choose a field belonging to this entity type.");
    if (key === "width_height_mm") return parseDimensions(value);
    if (value === "" || value == null) return undefined;
    if (dimensions.has(key)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number > 1e12 || number < 0 || number === 0 && key !== "insulation_mm") throw new Error("Known dimensions must be positive finite numbers. Clear an unknown dimension instead of entering zero.");
      return number;
    }
    const text = String(value).trim(), limit = key === "notes" ? 128000 : 2000;
    if ((key === "notes" ? Array.from(text).length : text.length) > limit) throw new Error(key === "notes" ? "Physical notes support at most 128,000 characters." : "Physical text fields support at most 2,000 characters.");
    return text || undefined;
  }
  function changedFields(entry, key, value) {
    const parsed = key === "quantity" ? recordedQuantity(entry.entity, value) : fieldValue(entry.kind, key, value, entry.servicePlans ? "service_plans" : "defect_reports");
    if (key === "quantity") return { quantity: parsed };
    const fields = { ...entry.entity.fields };
    if (key === "width_height_mm") { delete fields.width_mm; delete fields.height_mm; Object.assign(fields, parsed); }
    else if (parsed === undefined) delete fields[key]; else fields[key] = parsed;
    return { fields };
  }
  function fieldsFromValues(kind, values, retainedFields = {}, scope = "defect_reports") {
    const result = copy(retainedFields);
    for (const [key] of fieldsFor(kind, scope)) {
      if (key === "width_height_mm") {
        if (!Object.hasOwn(values, key) || String(values[key] ?? "") === formatDimensions(retainedFields)) continue;
        const dimensions = parseDimensions(values[key]); delete result.width_mm; delete result.height_mm; Object.assign(result, dimensions); continue;
      }
      if (Object.hasOwn(retainedFields, key) && String(values[key] ?? "") === String(retainedFields[key] ?? "")) continue;
      const value = fieldValue(kind, key, values[key], scope); if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  function sameValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
  }
  function bulkCommands(entries, field, value) {
    if (!entries.length || entries.some(entry => entry.entity.deleted) || entries.some(entry => entry.kind !== entries[0].kind)) throw new Error("Select active records of one entity type for a bulk edit.");
    if (entries.length > 100) throw new Error("A bulk operation supports at most 100 selected records. No changes have been applied.");
    const commands = [], unchanged = [];
    for (const entry of entries) {
      const changes = changedFields(entry, field, value);
      if (Object.entries(changes).every(([key, next]) => sameValue(entry.entity[key], next))) unchanged.push(entry.entity.id);
      else commands.push({ op: "update", entity_id: entry.entity.id, changes });
    }
    return { commands, unchanged };
  }
  function deletionPlan(entries, index, cascade = false) {
    if (!entries.length || entries.some(entry => entry.entity.deleted || entry.legacy)) throw new Error("Select active records from the current hierarchy to delete.");
    const ids = new Set(entries.map(entry => entry.entity.id)), additional = [...index.values()].filter(entry => !entry.entity.deleted && !ids.has(entry.entity.id) && ancestors(entry, index).some(parent => ids.has(parent.entity.id)));
    const targets = entries.filter(entry => !ancestors(entry, index).some(parent => ids.has(parent.entity.id)));
    if (targets.length > 100) throw new Error("A bulk deletion supports at most 100 independent selected records or subtrees. No records have been deleted.");
    if (additional.length && !cascade) return { additional, commands: [] };
    // Every active descendant is either selected already or included by the
    // explicit scope choice above. One command retains the entire subtree's
    // original identities and stays within the backend's 100-command limit.
    return { additional, commands: targets.map(entry => ({ op: "delete", entity_id: entry.entity.id,
      cascade: cascade || entries.some(child => ancestors(child, index).some(parent => parent.entity.id === entry.entity.id)) })) };
  }
  function commandText(commands, index, relationships = []) {
    return commands.map(command => {
      const entry = index.get(command.entity_id), entity = command.entity || entry?.entity;
      const id = entry ? displayId(entry) : relationships.find(change => change.id === entity?.id)?.display_id || entity?.display_id || "Assigned on apply";
      const title = `${command.op.toUpperCase()}: ${entry ? entityName(entry) : entity?.fields.label || titles[command.kind] || "Draft record"} · ${id}`;
      if (command.op === "update") {
        const lines = [];
        for (const [key, next] of Object.entries(command.changes)) {
          if (key === "fields") for (const field of new Set([...Object.keys(entry.entity.fields), ...Object.keys(next)])) {
            if (sameValue(entry.entity.fields[field], next[field])) continue;
            const label = fieldsFor(entry.kind, entry.servicePlans ? "service_plans" : "defect_reports").find(definition => definition[0] === field)?.[1] || field;
            lines.push(`${label}: ${entry.entity.fields[field] ?? "unknown"} → ${next[field] ?? "unknown"}`);
          }
          else if (key === "evidence") lines.push(`Source associations: ${entry.entity.evidence.length} → ${next.length}; exact retained locators are bound to this preview.`);
          else if (key === "marker") lines.push(`Count marker: ${markerDescription(entry.entity.marker)} → ${markerDescription(next)}`);
          else if (key === "uncertainty") lines.push(`Uncertainty: ${entry.entity.uncertainty.state} → ${next.state}\nExplanation: ${next.note || "none recorded"}`);
          else lines.push(`${key}: ${entry.entity[key] ?? "unknown"} → ${next}`);
        }
        return `${title}\n${lines.join("\n")}`;
      }
      if (command.op === "create") return `${title}\n${Object.entries(entity.fields).map(([field, value]) => `${definitions[command.kind].find(definition => definition[0] === field)?.[1] || (field === "frl" ? "FRL" : field)}: ${value}`).join("\n")}${command.kind === "service" ? `\nExplicit service quantity: ${entity.quantity == null ? "Unknown (selected library draft only)" : entity.quantity}` : ""}${entity.marker ? `\nCount marker: ${markerDescription(entity.marker)}` : ""}\nUncertainty: ${entity.uncertainty.state}`;
      return title;
    }).join("\n\n");
  }
  function imageEvidence(image, note = "", field) {
    const hash = /^[0-9a-f]{64}$/, id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!image || ![image.id, image.document_id, image.occurrence_id].every(value => id.test(value || "")) || ![image.sha256, image.document_sha256].every(value => hash.test(value || "")) || !Number.isInteger(image.page) || image.page < 1) throw new Error("The retained image is missing its exact source identity or hashes.");
    if (image.association_available === false || image.has_rendition === false) throw new Error("This retained image has no verified source rendition available for a draft association.");
    return { document_id: image.document_id, document_sha256: image.document_sha256, page: image.page, image_id: image.id, image_sha256: image.sha256, occurrence_id: image.occurrence_id, ...(image.region ? { region: copy(image.region) } : {}), ...(note ? { note } : {}), ...(field ? { fields: evidenceFields(field) } : {}) };
  }
  function previewText(preview, index, offset = 0, limit = 100) {
    if (!preview?.preview_id || !Array.isArray(preview.affected_ids) || !Array.isArray(preview.changed_ids) || !Array.isArray(preview.relationships)) throw new Error("The server did not return a complete physical edit preview.");
    const rows = preview.relationships.slice(offset, offset + limit).map(change => {
      const entry = index.get(change.id), id = change.display_id || displayId(entry) || change.id, label = entry ? entityName(entry) : `${titles[change.kind] || change.kind} ${id}`;
      const parentLabel = value => value ? displayId(index.get(value)) || value : "none";
      return `${label}\nID: ${id}\nParent: ${parentLabel(change.parent_before)} → ${parentLabel(change.parent_after)}\nDeleted: ${change.deleted_before === null ? "new entity" : change.deleted_before ? "yes" : "no"} → ${change.deleted_after ? "yes" : "no"}`;
    });
    return `${preview.affected_ids.length} affected physical IDs; ${preview.changed_ids.length} changed records. IDs are retained for updates, reparenting, deletion and restoration.\n\n${rows.join("\n\n")}\n\nShowing ${preview.relationships.length ? offset + 1 : 0}–${Math.min(offset + limit, preview.relationships.length)} of ${preview.relationships.length} relationship impacts. This operation changes only the unapproved draft. Undo restores the whole applied batch.`;
  }

  function mount(container, bridge) {
    if (!container || !bridge) throw new Error("A physical register container and application bridge are required.");
    const document = container.ownerDocument || root.document;
    const state = { snapshot: null, index: new Map(), servicesByBarrier: new Map(), selected: new Set(), hidden: new Set(), inspectedId: null, collapsed: new Set(), filter: "", columnFilters: new Map(), filterDialog: null, offset: 0, showDeleted: false, busy: false, destroyed: false, editRevision: 0, pending: new Map(), bindings: new WeakMap(), pendingApply: new WeakMap(), autoApplyPromise: null, autoRoutine: false, autoTimer: null, pointerAction: null, inspectorEdit: null, fieldOptions: null, fieldOptionsPromise: null, images: [], extractionId: "", imageOffset: 0, imageGeneration: 0, imageInventoryKey: "", imageState: "Not loaded", imageFailures: new Set() };
    const ui = {};
    let inspectorMenu;
    const changed = () => bridge.changed?.();
    const graph = () => state.snapshot?.physical || null;
    const scope = () => bridge.scope?.() || (graph()?.version === 3 ? "service_plans" : "defect_reports");
    const servicePlans = () => scope() === "service_plans";
    const parentRelations = () => servicePlans() ? servicePlanParents : parents;
    const warning = () => servicePlans() ? draftWarning.replace(" within a defect", "") : draftWarning;
    const legacyReadOnly = () => graph()?.version === 1;
    function ensureEditable() { if (legacyReadOnly()) throw new Error("This legacy hierarchy is read-only until its relationships are assigned. Its original records and evidence remain available for inspection and export."); }
    const graphKey = () => `${scope()}/${state.snapshot?.project_id || ""}/${graph()?.id || "new"}/${graph()?.revision ?? -1}`;
    const node = (tag, className = "", text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
    const choice = (value, label = value) => { const element = node("option", "", label); element.value = value; return element; };
    function report(error) { bridge.notify(error.message || String(error), true); }
    async function safe(action) { try { await action(); } catch (error) { if (!state.destroyed) report(error); } }
    function button(label, action, className = "button secondary") {
      const control = node("button", className, label); control.type = "button";
      control.addEventListener("pointerdown", () => { state.pointerAction = control; cancelAutomatic(); });
      for (const event of ["pointercancel", "pointerleave"]) control.addEventListener(event, () => { if (state.pointerAction === control) state.pointerAction = null; });
      control.addEventListener("click", () => void safe(async () => {
        const identity = `${scope()}/${state.snapshot?.project_id || ""}`;
        state.pointerAction = null;
        const flushed = control !== ui.discard && !!(state.pending.size || state.autoApplyPromise);
        if (flushed) await completePendingEdits();
        if (state.destroyed || identity !== `${scope()}/${state.snapshot?.project_id || ""}`) throw new Error("The physical workspace changed before this action. Use the current workspace.");
        return action(flushed);
      })); return control;
    }
    function mutationButton(label, action, className) { const control = button(label, flushed => { ensureEditable(); return action(flushed); }, className); control.dataset.physicalMutation = "true"; control.disabled = state.busy && !state.autoRoutine || legacyReadOnly(); return control; }
    const controlsInWorkspace = selector => [...ui.root.querySelectorAll(selector), ...(bridge.inspectorContainer ? ui.inspector.querySelectorAll(selector) : [])];
    function setBusy(value) { state.busy = value; ui.root.setAttribute("aria-busy", String(value)); ui.inspector?.setAttribute("aria-busy", String(value)); for (const control of controlsInWorkspace("button,input,select,textarea")) control.disabled = value && !state.autoRoutine || control.dataset.locked === "true" || legacyReadOnly() && control.dataset.physicalMutation === "true"; changed(); }
    function ensureAvailable(allowPending = false) { if (state.destroyed) throw new Error("The physical workspace was closed."); if (state.busy) throw new Error("Finish the current physical edit first."); if (!allowPending && state.pending.size) throw new Error("Apply or discard unfinished physical field edits first."); }
    function requireCurrent(entry) { const current = state.index.get(entry.entity.id); if (!current || current.kind !== entry.kind || current.entity.revision !== entry.entity.revision || current.entity.deleted !== entry.entity.deleted) throw new Error("This physical record changed. Discard the unfinished form and inspect the current draft."); }
    function selectEntries() { return [...state.selected].map(id => state.index.get(id)).filter(Boolean); }
    function inspectedEntry() {
      const selected = selectEntries(); if (selected.length !== 1) return null;
      return [...ancestors(selected[0], state.index), selected[0]].find(entry => entry.entity.id === state.inspectedId) || selected[0];
    }
    function matchingActiveRows() { return hierarchyRows(graph(), { ...state, collapsed: new Set() }).filter(row => !row.context && !row.entity.deleted); }
    function descendants(entry) { const found = []; for (const candidate of state.index.values()) if (ancestors(candidate, state.index).some(parent => parent.entity.id === entry.entity.id)) found.push(candidate); return found; }
    function cancelAutomatic() { if (state.autoTimer !== null) root.clearTimeout(state.autoTimer); state.autoTimer = null; }
    function scheduleAutomatic(delay = 0) { cancelAutomatic(); if (state.destroyed || state.pointerAction || !state.pending.size) return; state.autoTimer = root.setTimeout(() => { state.autoTimer = null; void safe(completePendingEdits); }, delay); }
    function resetPending() { cancelAutomatic(); for (const [control, original] of state.pending) control.value = original; state.pending.clear(); changed(); }
    function track(control, original, entry, key) {
      const binding = { original: String(original ?? ""), entry, key, revision: state.editRevision }; state.bindings.set(control, binding); control.dataset.physicalField = key;
      const update = () => { binding.revision = ++state.editRevision; String(control.value) === binding.original ? state.pending.delete(control) : state.pending.set(control, binding.original); changed(); };
      control.addEventListener("input", () => { update(); scheduleAutomatic(350); });
      control.addEventListener("change", () => { update(); scheduleAutomatic(); });
    }
    function displayReply(reply) { const value = reply?.snapshot || (reply?.documents && "physical" in reply ? reply : null); if (value) render(value); }
    function fieldType(kind, key) {
      if (sharedOptionKeys.has(key)) return (state.fieldOptions?.[key] || []).map(value => [value, value]);
      const type = key === "quantity" ? "number" : fieldsFor(kind, scope()).find(definition => definition[0] === key)?.[2] || "text";
      return Array.isArray(type) ? copy(type) : type;
    }
    function populateSelect(control, options, initial) {
      const value = String(initial ?? "");
      control.replaceChildren(choice("", "Choose…"));
      for (const [key, label] of options) control.append(choice(key, label));
      if (value && !options.some(([key]) => String(key) === value)) control.append(choice(value, `${value} (retained)`));
      control.value = value;
    }
    function bindSharedOptions(control, key) {
      control.dataset.physicalOptions = key;
      control.dataset.locked = String(!state.fieldOptions);
      control.disabled = state.busy || !state.fieldOptions;
    }
    async function loadFieldOptions() {
      if (state.fieldOptions) return;
      if (!state.fieldOptionsPromise) state.fieldOptionsPromise = (async () => {
        try {
          const options = await Promise.resolve().then(() => { if (typeof bridge.fieldOptions !== "function") throw new Error("Firestopping field choices are unavailable. Retry the physical edit to load them again."); return bridge.fieldOptions(); });
          if (state.destroyed) return;
          if ([...sharedOptionKeys].some(key => !Array.isArray(options?.[key]) || !options[key].length || options[key].some(value => typeof value !== "string" || !value.trim()))) throw new Error("Firestopping field choices are unavailable. Retry the physical edit to load them again.");
          state.fieldOptions = copy(options);
          // Refresh only dropdowns: a slow choices request must never replace a pending text edit.
          for (const control of controlsInWorkspace("[data-physical-options]")) {
            populateSelect(control, state.fieldOptions[control.dataset.physicalOptions].map(value => [value, value]), control.value);
            control.dataset.locked = "false"; control.disabled = state.busy;
          }
        } finally { state.fieldOptionsPromise = null; }
      })();
      await state.fieldOptionsPromise;
    }
    async function ensureFieldOptions(kind, allowPending = false) {
      if (state.fieldOptions) return;
      ensureAvailable(allowPending); const key = graphKey(); setBusy(true);
      try { await loadFieldOptions(); if (state.destroyed || graphKey() !== key) throw new Error("The physical draft changed while its field choices loaded. Retry the edit."); }
      finally { if (!state.destroyed) setBusy(false); }
    }
    async function reviewPreview(title, preview, commands) {
      let offset = 0;
      const changes = commandText(commands, state.index, preview.relationships);
      if (preview.relationships.length <= 100) return bridge.confirm(title, `${changes}\n\n${previewText(preview, state.index)}`, "Apply draft change");
      for (;;) {
        const options = [...(offset ? [["previous", "Previous 100 impacts"]] : []), ...(offset + 100 < preview.relationships.length ? [["next", "Next 100 impacts"]] : []), ["apply", `Apply all ${preview.changed_ids.length} draft changes`]];
        const answer = await bridge.ask(title, [["action", "Review navigation", options, "", true]], `${changes}\n\n${previewText(preview, state.index, offset)}`, "Continue");
        if (!answer) return false; if (answer.action === "apply") return true;
        offset = Math.max(0, Math.min(Math.max(0, preview.relationships.length - 1), offset + (answer.action === "previous" ? -100 : 100)));
      }
    }
    async function perform(commands, title, allowPending = false, review = true, requireSource) {
      ensureEditable(); ensureAvailable(allowPending); const key = graphKey(), identity = `${scope()}/${state.snapshot?.project_id || ""}`, captured = new Map(controlsInWorkspace("[data-physical-field]").map(control => [control, { value: String(control.value), revision: state.bindings.get(control)?.revision }])); setBusy(true);
      try {
        requireSource?.();
        const preview = await bridge.preview(commands);
        if (state.destroyed || graphKey() !== key) throw new Error("The physical draft changed before review. Preview the edit again.");
        requireSource?.();
        previewText(preview, state.index);
        if (review && !await reviewPreview(title, preview, commands)) return false;
        if (state.destroyed || graphKey() !== key) throw new Error("The physical draft changed during review. Preview the edit again.");
        requireSource?.();
        const reply = await bridge.apply(preview.preview_id);
        if (state.destroyed || identity !== `${scope()}/${state.snapshot?.project_id || ""}`) throw new Error("The physical workspace changed while the validated change was applying. The new workspace has been preserved.");
        if (!state.destroyed) {
          displayReply(reply);
          if (allowPending && !review) rebaseInputs(captured); else resetPending();
          bridge.notify("Draft physical change applied. The physical model remains unapproved.", false);
        }
        return true;
      } finally { if (!state.destroyed) { setBusy(false); if (!state.pending.size) renderData(); } }
    }
    function rebaseInputs(captured) {
      for (const control of controlsInWorkspace("[data-physical-field]")) {
        const binding = state.bindings.get(control), current = binding && state.index.get(binding.entry.entity.id); if (!current) continue;
        const { key } = binding, canonical = key === "confirmation" ? recordConfirmation(current.entity) : key === "quantity" ? current.entity.quantity : fieldDisplay(current.entity.fields, key);
        const original = String(canonical ?? ""); binding.entry = current; binding.original = original;
        if (!captured.has(control) || binding.revision === captured.get(control).revision) { if (String(control.value) !== original) control.value = canonical ?? ""; state.pending.delete(control); }
        else if (String(control.value) === original) state.pending.delete(control); else state.pending.set(control, original);
      }
      if (state.inspectorEdit) { state.inspectorEdit.entry = state.index.get(state.inspectorEdit.entry.entity.id); state.inspectorEdit.key = graphKey(); }
      changed();
    }
    async function ask(title, fields, explanation, submit) {
      ensureAvailable(); const key = graphKey(); setBusy(true);
      try { const answer = await bridge.ask(title, fields, explanation, submit); if (answer && (state.destroyed || graphKey() !== key)) throw new Error("The physical draft changed while this form was open. Repeat the edit."); return answer; }
      finally { if (!state.destroyed) setBusy(false); }
    }
    function fieldDefinitions(entry, createKind) {
      const kind = entry?.kind || createKind, entity = entry?.entity;
      const fields = fieldsFor(kind, scope()).flatMap(([key, label]) => [[key, label, fieldType(kind, key), fieldDisplay(entity?.fields, key) ?? ""], ...(kind === "service" && key === "service_type" ? [["quantity", "Explicit service quantity", "number", entity?.quantity ?? "", !entity?.library_quantity]] : [])]);
      if (kind === (servicePlans() ? "barrier" : "defect")) {
        const notes = fields.findIndex(([key]) => key === "notes");
        fields.splice(notes < 0 ? fields.length : notes, 0, ["confirmation", "Confirmation", confirmationOptions, recordConfirmation(entity), true]);
      }
      return fields;
    }
    async function chooseEntity(kind, title, candidates) {
      const filter = await ask(title, [["search", `Find ${titles[kind].toLowerCase()} by label, location or ID`, "text", ""]], "Choose an existing physical parent by its persistent identity. A similar label does not establish that two objects are the same.", "Find parents");
      if (!filter) return null;
      const query = filter.search.trim().toLowerCase(), entries = candidates.filter(entry => [entry.entity.id, entry.entity.display_id, ...Object.values(entry.entity.fields)].join(" ").toLowerCase().includes(query));
      if (!entries.length) throw new Error("No matching active parent exists. Create or restore the required parent first.");
      let offset = 0;
      for (;;) {
        const options = entries.slice(offset, offset + 100).map(entry => [entry.entity.id, `${entityName(entry)} · ${displayId(entry)}`]);
        if (offset) options.unshift(["previous", "Previous 100 parents"]); if (offset + 100 < entries.length) options.push(["next", "Next 100 parents"]);
        const answer = await ask(title, [["parent_id", "Physical parent", options, "", true]], `Showing ${offset + 1}–${Math.min(offset + 100, entries.length)} of ${entries.length} matching parents.`, "Use parent");
        if (!answer) return null; if (answer.parent_id === "previous") offset -= 100; else if (answer.parent_id === "next") offset += 100; else return answer.parent_id;
      }
    }
    async function create(kind, chosenParent, marker, sourceEvidence, requirePlacement, annotation) {
      if (!kinds.includes(kind) || servicePlans() && kind === "defect") throw new Error("Choose a record type belonging to this workspace.");
      if (marker !== undefined && kind !== "barrier") throw new Error("A count marker belongs to a barrier.");
      if (annotation !== undefined && kind !== "defect") throw new Error("A source annotation belongs to a defect.");
      if (annotation !== undefined) annotation = copy(annotation);
      const evidence = sourceEvidence === undefined ? [] : [copy(sourceEvidence)];
      const requireSource = () => {
        requirePlacement?.();
        if (!evidence.length) return;
        const reference = evidence[0], source = state.snapshot?.documents?.find(value => value.id === reference.document_id), context = bridge.imageContext?.();
        if (kind !== "defect" || !source || source.sha256 !== reference.document_sha256 || !Number.isInteger(reference.page) || reference.page < 1 || reference.page > source.pages.length || context && (context.document_id !== source.id || context.page !== reference.page)) throw new Error("The defect source location changed. Select Call-out on the current drawing again.");
        if (annotation && (annotation.document_id !== reference.document_id || annotation.document_sha256 !== reference.document_sha256 || annotation.page !== reference.page)) throw new Error("The defect annotation belongs to a different source page.");
      };
      ensureEditable(); ensureAvailable(); requireSource(); const key = graphKey(); await ensureFieldOptions(kind); ensureAvailable(); requireSource();
      if (graphKey() !== key) throw new Error("The physical draft changed before this form opened. Repeat the edit.");
      if (kind === "defect" || servicePlans() && kind === "barrier") {
        const title = kind === "defect" ? "Add Defect" : "Add Barrier";
        const libraryLinks = root.CeasefireTakeoffLibraryLinks || (typeof module !== "undefined" && module.exports ? require("./takeoff-library-links.js") : null);
        if (!libraryLinks) throw new Error(`The ${title} item chooser is unavailable. Reload after preserving your project.`);
        const choice = await libraryLinks.choose(bridge, false, { title });
        if (!choice) return;
        requireSource(); if (graphKey() !== key) throw new Error(`The physical draft changed during library selection. Repeat ${title}.`);
        if (choice.kind === "library") return createLibraryDraft(choice.record, evidence, annotation, requireSource, choice.details, marker);
      }
      let parent = chosenParent;
      if (parentRelations()[kind]) {
        const parentKind = parentRelations()[kind][0], selected = selectEntries();
        if (!parent && selected.length === 1 && selected[0].kind === parentKind && !selected[0].entity.deleted) parent = selected[0].entity.id;
        if (!parent) parent = await chooseEntity(parentKind, `Choose parent ${parentKind}`, [...state.index.values()].filter(entry => entry.kind === parentKind && !entry.entity.deleted));
        if (!parent) return;
        const entry = state.index.get(parent); if (!entry || entry.kind !== parentKind || entry.entity.deleted) throw new Error("The selected physical parent is unavailable.");
      } else parent = null;
      const answer = await ask(evidence.length ? "Add Defect" : `Create draft ${kind}`, fieldDefinitions(null, kind), `${warning()}${parent ? `\n\nParent ID: ${displayId(state.index.get(parent))}` : ""}\n\nUnknown properties stay blank.${evidence.length ? `\n\nSource page ${evidence[0].page}: ${evidence[0].note}` : " Link retained source evidence after creating the draft."}`, "Preview new draft");
      if (!answer) return;
      requireSource();
      const entity = { id: root.crypto.randomUUID(), fields: fieldsFromValues(kind, answer, {}, scope()), evidence, uncertainty: { state: "not_assessed", note: "" }, ...(kind === (servicePlans() ? "barrier" : "defect") && answer.confirmation === "confirmed" ? { confirmation: "confirmed" } : {}), ...(parent ? { [parentRelations()[kind][1]]: parent } : {}), ...(kind === "service" ? { quantity: fieldValue(kind, "quantity", answer.quantity) } : {}), ...(marker !== undefined ? { marker: copy(marker) } : {}), ...(annotation !== undefined ? { annotation: copy(annotation) } : {}) };
      if (await perform([{ op: "create", kind, entity }], `Create one draft ${kind}?`, false, true, requireSource)) { await selectEntity(entity.id, false, marker === undefined && !evidence.length); return entity.id; }
    }
    async function createLibraryDraft(library, evidence, annotation, guard, details = {}, marker) {
      if (typeof bridge.libraryCommand !== "function") throw new Error("The project-owned library link bridge is unavailable.");
      const initial = copy(library.import_fields.defect); if (details.draft_location && !initial.location) initial.location = details.draft_location;
      guard?.();
      const defectId = root.crypto.randomUUID(), barrierId = root.crypto.randomUUID(), serviceId = root.crypto.randomUUID();
      const assertion = fields => ({fields,evidence:[],uncertainty:{state:"human_review_required",note:"Manually selected library fields; verify the actual installation and technical applicability."}});
      const barrierFields = copy(library.import_fields.barrier);
      if (servicePlans()) { if (initial.frl) barrierFields.frl = initial.frl; if (!barrierFields.location && initial.location) barrierFields.location = initial.location; }
      const commands=[...(!servicePlans() ? [{op:"create",kind:"defect",entity:{id:defectId,...assertion(copy(initial)),evidence:copy(evidence),...(annotation!==undefined?{annotation:copy(annotation)}:{})}}] : []),
        {op:"create",kind:"barrier",entity:{id:barrierId,...(!servicePlans()?{defect_id:defectId}:{}),...assertion(barrierFields),...(marker!==undefined?{marker:copy(marker)}:{})}}];
      const memberIds=servicePlans()?[barrierId]:[defectId,barrierId];
      if (library.import_fields.service) {
        const known = details.item_quantity !== undefined;
        const quantity = known ? fieldValue("service", "quantity", details.item_quantity, scope()) : null;
        commands.push({op:"create",kind:"service",entity:{id:serviceId,barrier_id:barrierId,...assertion(copy(library.import_fields.service)),quantity,...(!known ? {library_quantity:{version:1,state:"unknown",library_id:library.id,metadata_sha256:library.metadata_sha256}} : {})}}); memberIds.push(serviceId);
      }
      if (!await perform(commands,"Import selected library draft",false,false,guard)) return;
      const links=root.CeasefireTakeoffLibraryLinks || require("./takeoff-library-links.js");
      displayReply(await bridge.libraryCommand("draft_library_assignment",{assignment:links.assignment(scope(),library,memberIds,null,details)}));
      const selectedId = servicePlans() ? barrierId : defectId;
      await selectEntity(selectedId,false,false); return selectedId;
    }
    async function confirmLibraryLink(value) {
      await completePendingEdits(); ensureAvailable(); ensureEditable();
      if (!bridge.libraryPreview || !bridge.libraryApply) throw new Error("The reviewed Firestopping Schedule link bridge is unavailable.");
      const key=graphKey(), services=value.members.filter(member=>member.kind==="service").map(member=>state.index.get(member.id));
      let source=value.quantity_source;
      if (!source) {
        if (services.length) source={version:1,kind:"services"};
        else {
          const links=root.CeasefireTakeoffLibraryLinks || require("./takeoff-library-links.js"), library=await links.record(value.library.id);
          if (graphKey()!==key) throw new Error("The physical draft changed during quantity review.");
          if (library.import_fields.service) throw new Error("This association has no explicit service members. Select the service records and choose a library item before transfer.");
          source={version:1,kind:"blank_seals",quantity:value.confirmation?.quantity ?? value.draft_quantity ?? 1};
        }
      }
      let derived;
      if (source.kind==="services") {
        if (!services.length || services.some(entry=>!entry || entry.entity.deleted || !Number.isSafeInteger(entry.entity.quantity) || entry.entity.quantity<1)) throw new Error("Enter an Explicit service quantity for every associated service in Item Details, then use Transfer or Update again.");
        derived=value.installation.mode==="combined_installation"?1:services.reduce((total,entry)=>total+entry.entity.quantity,0);
      } else derived=value.installation.mode==="combined_installation"?1:source.quantity;
      const legacyCombinedSeal=!value.quantity_source && source.kind==="blank_seals" && value.installation.mode==="combined_installation";
      const quantityFields=[["quantity","Explicit installation quantity","number",derived,true]];
      if (legacyCombinedSeal) quantityFields.push(["seal_quantity","Explicit blank seal quantity","number",Number.isSafeInteger(source.quantity)?source.quantity:"",true]);
      const answer=await ask("Confirm link and quantity",quantityFields,
        `${value.library.library_id}\n${source.kind==="services" ? `Current explicit service counts: ${services.map(entry=>`${displayId(entry)} = ${entry.entity.quantity}`).join("; ")}. ${value.installation.mode === "combined_installation" ? "One combined installation contributes once." : "Separate installation quantities are added."}` : "Review the explicit blank seal count; no physical service is created."}\n\nExisting schedule inputs, manual quantity and frozen project prices remain intact. Review and confirmation are required before the schedule changes.`,"Review schedule change");
      if (!answer) return false; if (graphKey()!==key) throw new Error("The physical draft changed during commercial review.");
      const quantity=fieldValue("service","quantity",answer.quantity,scope());
      if (legacyCombinedSeal) source.quantity=fieldValue("service","quantity",answer.seal_quantity,scope());
      if (source.kind==="services" && quantity!==derived) throw new Error("The transfer quantity must match the current explicit service counts. Change the service quantity in Item Details, then review Transfer or Update again.");
      if (value.installation.mode === "combined_installation" && quantity !== 1) throw new Error("One explicitly combined installation has Item QTY 1. Review separate repeated installations for a larger quantity.");
      const preview=await bridge.libraryPreview({assignment_id:value.id,quantity,...(!value.quantity_source ? {quantity_source:source.kind==="blank_seals"?{...source,quantity:value.installation.mode==="combined_installation"?source.quantity:quantity}:source} : {})});
      if (graphKey()!==key) throw new Error("The physical draft changed before schedule confirmation.");
      const change=preview.change,fields=preview.library.import_fields;
      const confirmed=await bridge.confirm("Confirm link and quantity",`${preview.notice}\n\n${preview.library.library_id}: ${preview.library.title}\nCurrent library revision ${preview.library.revision}\nLibrary FRL: ${fields.defect.frl || "Unknown"}\nSubstrate: ${fields.barrier.substrate || "Unknown"}\nOrientation: ${fields.barrier.orientation || "Unknown"}\nService: ${fields.service?.service_type || "Not specified"}\nDiameter: ${fields.service?.diameter_mm ?? "Unknown"}; width: ${fields.service?.width_mm ?? "Unknown"}; height: ${fields.service?.height_mm ?? "Unknown"}\n\n${preview.overlapping_assignment_ids?.length ? "Warning: this explicit group shares physical members with another retained association. Review separate versus combined installations; no opening is inferred.\n" : ""}Explicit contribution: ${change.confirmed_contribution}\nSchedule row: ${change.row_id}\nQuantity: ${change.previous_quantity} → ${change.next_quantity}\nPrior contribution: ${change.prior_contribution}\nAll other existing row inputs and fixed charges remain unchanged.`,"Confirm link and quantity");
      if (!confirmed) return false; if (graphKey()!==key) throw new Error("The physical draft changed during final commercial confirmation.");
      displayReply(await bridge.libraryApply(preview.preview_id)); return true;
    }
    async function unlinkLibrary(value) {
      await completePendingEdits();ensureAvailable();ensureEditable();
      if(!value.schedule_binding)throw new Error("This association has no schedule contribution to remove.");
      const key=graphKey(),preview=await bridge.libraryPreview({assignment_id:value.id,quantity:0,operation:"unlink"}),change=preview.change;
      const confirmed=await bridge.confirm("Remove schedule link",`${value.library.library_id}: ${value.library.title}\n\nRemoving this link subtracts only its contribution (${change.prior_contribution}). The schedule row and manual inputs remain; remove the row in Firestopping Estimator if no longer needed.\n\nQuantity: ${change.previous_quantity} → ${change.next_quantity}\nOther confirmed links, manual quantity, fixed charges and frozen prices remain intact. The retained physical draft and association IDs remain available for later review. This action does not approve the physical model.`,"Remove schedule link");
      if(!confirmed)return false;if(graphKey()!==key)throw new Error("The physical draft changed during unlink review.");
      displayReply(await bridge.libraryApply(preview.preview_id)); return true;
    }
    function selectedLibraryAssignments(operation) {
      const entries = selectEntries(), ids = new Set(entries.map(entry => entry.entity.id));
      if (!entries.length || entries.some(entry => entry.entity.deleted)) throw new Error("Select active physical records with retained library associations first.");
      return (state.snapshot?.library_assignments?.records || []).filter(value => value.scope === scope() && value.members.some(member => ids.has(member.id)) && (operation === "transfer" ? !value.schedule_binding : !!value.schedule_binding));
    }
    async function selectedLibraryAction(operation) {
      await completePendingEdits(); ensureAvailable(); ensureEditable();
      const assignments = selectedLibraryAssignments(operation), title = operation === "transfer" ? "Transfer to Firestopping Schedule" : operation === "update" ? "Update linked rows" : "Unlink from Firestopping Schedule";
      if (!assignments.length) throw new Error(operation === "transfer" ? "No unlinked library association belongs to the selection. Choose a library item for the selected records first, or use Update linked rows for existing contributions." : "No linked library association belongs to the selection.");
      const identity = `${scope()}/${state.snapshot?.project_id || ""}`, selection = [...state.selected].sort().join(","), ids = assignments.map(value => value.id);
      if (assignments.length > 1 && !await ask(title, [], `${assignments.length} retained library associations will be reviewed separately:\n\n${assignments.map(value => `${value.library.library_id}: ${value.library.title}\n${value.members.length} explicitly recorded physical members · ${value.installation.mode === "combined_installation" ? "one combined installation" : "separate repeated installations"}`).join("\n\n")}\n\nEvery association keeps its existing membership. Each schedule change requires its own current preview and confirmation. Cancel stops the remaining reviews; already applied changes remain. Physical record confirmation does not approve technical applicability.`, "Review associations")) return;
      for (const id of ids) {
        ensureAvailable();
        if (identity !== `${scope()}/${state.snapshot?.project_id || ""}` || selection !== [...state.selected].sort().join(",")) throw new Error("The physical selection changed during schedule review. Review the current selection again.");
        const value = selectedLibraryAssignments(operation).find(entry => entry.id === id);
        if (!value) throw new Error("A retained library association changed during schedule review. Review its current contribution again.");
        if (!await (operation === "unlink" ? unlinkLibrary(value) : confirmLibraryLink(value))) break;
      }
    }
    async function transferConfirmedRegister() {
      await completePendingEdits(); ensureAvailable(); ensureEditable();
      if (!bridge.transferConfirmedLibraryRegister) throw new Error("The confirmed register transfer is unavailable.");
      const reply = await bridge.transferConfirmedLibraryRegister(scope());
      displayReply(reply);
      const summary = reply.library_link;
      bridge.notify(`${summary.transferred} confirmed library item${summary.transferred === 1 ? "" : "s"} transferred. ${summary.skipped?.unconfirmed || 0} unconfirmed associations skipped; confirm their records before transfer. ${summary.skipped?.already_linked || 0} already linked. ${summary.skipped?.unassociated || 0} confirmed records need a library item.`, false);
    }
    async function attachLibraryToSelected() {
      await completePendingEdits();ensureAvailable();ensureEditable();
      const entries=selectEntries();if(!entries.length||entries.some(entry=>entry.entity.deleted))throw new Error("Select active physical members to associate explicitly.");
      const key=graphKey(),links=root.CeasefireTakeoffLibraryLinks || require("./takeoff-library-links.js");
      if(!servicePlans()){
        const owners=entries.map(entry=>[...ancestors(entry,state.index),entry].find(value=>value.kind==="defect"&&!value.entity.deleted));
        if(owners.some(value=>!value)||new Set(owners.map(value=>value.entity.id)).size!==1)throw new Error("Select records under one Defect before adding another library item; cross-Defect selection is ambiguous.");
        const defect=owners[0].entity,guard=()=>{ensureAvailable();if(graphKey()!==key)throw new Error("The selected physical context changed during library import. Select its current records again.");};
        const context={scope:scope(),defect:copy(defect),selectedIds:entries.map(entry=>entry.entity.id),barriers:[...state.index.values()].filter(value=>value.kind==="barrier"&&!value.entity.deleted&&value.entity.defect_id===defect.id).map(value=>copy(value.entity))};
        const result=await links.addUnderDefect(bridge,context,guard);if(!result)return;
        displayReply(result.reply);await selectEntity(result.selected_id,false,false);return;
      }
      const owners=entries.map(entry=>[...ancestors(entry,state.index),entry].find(value=>value.kind==="barrier"&&!value.entity.deleted));
      if(owners.some(value=>!value)||new Set(owners.map(value=>value.entity.id)).size!==1)throw new Error("Select records under one Barrier before adding another library item; cross-Barrier selection is ambiguous.");
      const barrier=copy(owners[0].entity),guard=()=>{ensureAvailable();if(graphKey()!==key)throw new Error("The selected physical context changed during library import. Select its current records again.");};
      const result=await links.addUnderServicePlans(bridge,{scope:scope(),barrier,selectedIds:entries.map(entry=>entry.entity.id),barriers:[copy(barrier)]},guard);if(!result)return;
      displayReply(result.reply);await selectEntity(result.selected_id,false,false);
    }
    async function associateLibraryWithSelected() {
      await completePendingEdits();ensureAvailable();ensureEditable();
      if(!servicePlans())throw new Error("Explicit existing-record associations belong to Service Plans.");
      const entries=selectEntries();if(!entries.length||entries.some(entry=>entry.entity.deleted))throw new Error("Select active physical members to associate explicitly.");
      const key=graphKey(),links=root.CeasefireTakeoffLibraryLinks || require("./takeoff-library-links.js");
      const locations = [...new Set(entries.map(entry => columnValue(entry,"location",state.index)).filter(Boolean))];
      const selected=await links.choose(bridge,true,{location:locations.length === 1 ? locations[0] : ""});
      if(!selected)return;if(graphKey()!==key)throw new Error("The selected physical context changed during library search.");
      const answer=await ask("Define installation membership",[["mode","Installation grouping",[["repeated_installations","Separate repeated installations"],["combined_installation","One explicitly combined installation"]],"repeated_installations",true],["note","Explicit installation/grouping description","textarea",""]],
        `${entries.length} selected physical members will retain their own IDs. A shared barrier never proves a common opening. Describe any combined installation explicitly; confirm its quantity separately. This association does not approve technical applicability.`,"Create draft association");
      if(!answer)return;if(graphKey()!==key)throw new Error("The physical draft changed while defining the installation group.");
      const installation={id:root.crypto.randomUUID(),mode:answer.mode,note:answer.note||""};
      const proposal=links.assignment(scope(),selected.record,entries.map(entry=>entry.entity.id),installation,selected.details);
      if (selected.record.import_fields.service) {
        const services=entries.filter(entry=>entry.kind==="service");
        if (!services.length) throw new Error("Select explicit service records before associating this service item. Item QTY cannot be assigned to a substrate.");
        let quantities;
        if (services.length===1) quantities=[fieldValue("service","quantity",selected.details.item_quantity,scope())];
        else {
          const counts=await ask("Review selected service quantities",services.map((entry,index)=>[`quantity_${index}`,`${displayId(entry)} quantity`,"number",entry.entity.quantity??"",true]),`Item QTY ${selected.details.item_quantity} is the total explicit service count. Enter the quantity for each selected service. A combined installation contributes once to the schedule.`,"Use service quantities");
          if (!counts) return;
          if (graphKey()!==key) throw new Error("The physical draft changed during service quantity review.");
          quantities=services.map((_entry,index)=>fieldValue("service","quantity",counts[`quantity_${index}`],scope()));
          if (quantities.reduce((total,count)=>total+count,0)!==selected.details.item_quantity) throw new Error("The selected service quantities must add up to Item QTY. Review the individual counts and choose the item again.");
        }
        proposal.service_quantities=services.map((entry,index)=>({id:entry.entity.id,revision:entry.entity.revision,quantity:quantities[index]}));
      }
      displayReply(await bridge.libraryCommand("draft_library_assignment",{assignment:proposal}));
    }
    const libraryRecords = new Map();
    const librarySummaryNodes = new Map();
    const librarySummaryPending = new Set();
    function librarySummaryRecord(value, links) {
      if (!links?.record) return null;
      const key = `${value.library.id}/${value.library.metadata_sha256}`;
      if (!libraryRecords.has(key)) {
        libraryRecords.set(key, null);
        librarySummaryPending.add(key);
        void links.record(value.library.id).then(record => {
          libraryRecords.set(key, links.matchingRecord(value, record) ? record : null);
          if (!state.destroyed) for (const summary of librarySummaryNodes.get(key) || []) {
            if (ui.inspector.contains(summary)) summary.textContent = links.description(value, libraryRecords.get(key)).split("\n").slice(1).join("\n");
          }
          librarySummaryNodes.delete(key);
          librarySummaryPending.delete(key);
        }).catch(() => { libraryRecords.delete(key); librarySummaryNodes.delete(key); librarySummaryPending.delete(key); /* A later explicit selection can retry unavailable metadata. */ });
      }
      return libraryRecords.get(key);
    }
    function canChooseLibrary(entries) { return !!bridge.libraryCommand && !legacyReadOnly() && entries.length > 0 && entries.every(entry => !entry.entity.deleted); }
    function renderLibraryAssignments(entries) {
      if(!canChooseLibrary(entries))return;
      const ids=new Set(entries.map(entry=>entry.entity.id)),links=root.CeasefireTakeoffLibraryLinks;
      for(const value of state.snapshot?.library_assignments?.records||[]){
        if(value.scope!==scope()||!value.members.some(member=>ids.has(member.id)))continue;
        const card=node("section","takeoff-exclusion takeoff-library-summary"),record=librarySummaryRecord(value,links);
        const description=links?.description(value,record) || `${value.library.library_id}\nService Type: Unknown\nPenetration Type: Unknown\nSubstrate: Unknown\nOrientation: Unknown\nService size: Unknown`;
        const summary=node("p","helper",description.split("\n").slice(1).join("\n")),key=`${value.library.id}/${value.library.metadata_sha256}`;
        if (librarySummaryPending.has(key)) {
          if (!librarySummaryNodes.has(key)) librarySummaryNodes.set(key,new Set());
          const waiting=librarySummaryNodes.get(key);
          for (const old of waiting) if (!ui.inspector.contains(old)) waiting.delete(old);
          waiting.add(summary);
        }
        card.append(node("h4","",value.library.library_id),summary);
        ui.inspector.append(card);
      }
    }
    function createFromSelection(kind, marker) {
      ensureEditable(); ensureAvailable();
      const parentKind = parentRelations()[kind]?.[0], selected = selectEntries();
      const lineage = selected.length === 1 && !selected[0].entity.deleted ? [...ancestors(selected[0], state.index), selected[0]] : [];
      const parent = lineage.find(entry => entry.kind === parentKind && !entry.entity.deleted);
      return create(kind, parent?.entity.id, marker);
    }
    function selectEntity(id, multiple = false, focus = !multiple, inspectDefect = false, openDetails = true) {
      if (state.pending.size || state.autoApplyPromise) return completePendingEdits().then(() => selectEntity(id, multiple, focus, inspectDefect, openDetails));
      ensureAvailable(); const entry = state.index.get(id); if (!entry) return;
      if (!multiple) state.selected.clear(); if (multiple && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      const selected = selectEntries(); let inspected = selected.length === 1 ? selected[0] : null;
      if (inspected && inspectDefect && !servicePlans()) inspected = [...ancestors(inspected, state.index), inspected].find(value => value.kind === "defect") || inspected;
      state.inspectedId = inspected?.entity.id || null;
      for (const parent of ancestors(entry, state.index)) state.collapsed.delete(parent.entity.id);
      const rows = hierarchyRows(graph(), state); state.offset = Math.floor(Math.max(0, rows.findIndex(row => row.entity.id === id)) / 100) * 100; renderData();
      bridge.selectionChanged?.({ selected: [...state.selected], barrierId: selectedBarrier()?.id || null, entry: copy(entry), inspectedId: state.inspectedId, focus, openDetails });
      return bridge.selection?.([...state.selected], entry.entity.evidence[0] || selectedBarrier()?.marker || null, focus, openDetails);
    }
    function selectDrawing(id, multiple = false, focus = false, openDetails = true) {
      if (state.pending.size || state.autoApplyPromise) return completePendingEdits().then(() => selectDrawing(id, multiple, focus, openDetails));
      ensureAvailable(); const entry = state.index.get(id);
      if (!entry || entry.entity.deleted) throw new Error("This drawing record is no longer available. Select a current record.");
      return selectEntity(id, multiple, focus, true, openDetails);
    }
    async function editEntity(id) {
      await selectEntity(id, false, false, false, true); ensureAvailable();
      if (state.selected.size === 1 && state.selected.has(id)) bridge.revealDrawing?.();
    }
    async function viewEntity(id) {
      await selectEntity(id, false, false, false, true); ensureAvailable();
      const entry = state.index.get(id); if (!entry || state.selected.size !== 1 || !state.selected.has(id)) throw new Error("The selected physical record changed before opening its source.");
      const lineage = [entry, ...ancestors(entry,state.index).reverse()];
      const reference = lineage.map(value => value.entity.annotation || value.entity.marker || value.entity.evidence?.[0]).find(Boolean);
      if (!reference) { bridge.revealDrawing?.(); bridge.notify("No original source is linked to this record or its recorded physical parents.", false); return; }
      await bridge.source(copy(reference));
      if (state.selected.size === 1 && state.selected.has(id)) bridge.revealDrawing?.();
    }
    function selectedBarrier() {
      const selected = selectEntries(); if (selected.length !== 1 || selected[0].entity.deleted) return null;
      const entry = selected[0], barrier = entry.kind === "barrier" ? entry : ancestors(entry, state.index).find(parent => parent.kind === "barrier");
      return barrier && !barrier.entity.deleted ? copy(barrier.entity) : null;
    }
    function summary(id) {
      const entry = state.index.get(id); if (!entry || entry.entity.deleted) return "";
      const line = (values) => values.filter(value => value !== undefined && value !== null && value !== "").map(value => String(value).replace(/[\r\n\t]+/g, " ")).join(" · ");
      const defectLine = value => { const f = value.entity.fields; return line([displayId(value), f.label, f.location, f.frl ? `FRL ${f.frl}` : ""]); };
      const serviceLine = child => { const value = child.entity.fields; return line([displayId(child), child.entity.quantity == null ? "Quantity unknown" : `${child.entity.quantity} ×`, value.label, value.service, value.service_type || "Service type not recorded", value.size, value.width_height_mm, value.width_mm != null || value.height_mm != null ? `${formatDimensions(value)} mm` : "", value.diameter_mm != null ? `Ø ${value.diameter_mm} mm` : "", value.insulation_mm != null ? `Insulation ${value.insulation_mm} mm` : ""]); };
      const barrierLines = barrier => {
        const f = barrier.entity.fields, defect = ancestors(barrier, state.index).find(parent => parent.kind === "defect"), frl = servicePlans() ? f.frl : defect?.entity.fields.frl;
        const services = state.servicesByBarrier.get(barrier.entity.id) || [];
        return [line([displayId(barrier), f.label, barrier.legacy || barrier.servicePlans ? f.location : undefined, f.barrier_type, f.substrate || "Substrate not recorded", f.orientation, f.thickness_mm != null ? `${f.thickness_mm} mm thick` : "", frl ? `FRL ${frl}` : ""]), ...services.map(serviceLine), ...(!services.length ? ["0 services"] : [])];
      };
      if (entry.kind === "defect" && graph().version === 2) {
        const barriers = [...state.index.values()].filter(value => value.kind === "barrier" && !value.entity.deleted && value.entity.defect_id === id);
        return [defectLine(entry), ...barriers.flatMap(barrierLines), ...(!barriers.length ? ["0 substrates · 0 services"] : [])].join("\n");
      }
      const barrier = entry.kind === "barrier" ? entry : ancestors(entry, state.index).find(parent => parent.kind === "barrier"); if (!barrier || barrier.entity.deleted) return "";
      const defect = ancestors(barrier, state.index).find(parent => parent.kind === "defect");
      return [...(defect ? [defectLine(defect)] : []), ...barrierLines(barrier)].join("\n");
    }
    async function setMarker(id, marker) {
      await completePendingEdits();
      ensureEditable(); ensureAvailable(); const entry = state.index.get(id);
      if (!entry || entry.kind !== "barrier" || entry.entity.deleted) throw new Error("Select an active barrier for this count marker.");
      requireCurrent(entry); if (sameValue(entry.entity.marker ?? null, marker)) return false;
      return perform([{ op: "update", entity_id: id, changes: { marker: copy(marker) } }], marker ? "Move barrier count marker" : "Remove barrier count marker?", false, marker === null);
    }
    async function setAnnotation(id, annotation) {
      await completePendingEdits();
      ensureEditable(); ensureAvailable(); const entry = state.index.get(id);
      if (!entry || entry.kind !== "defect" || graph().version !== 2 || entry.entity.deleted) throw new Error("Select an active defect for this source annotation.");
      requireCurrent(entry); if (Object.hasOwn(entry.entity, "annotation") && sameValue(entry.entity.annotation, annotation)) return false;
      return perform([{ op: "update", entity_id: id, changes: { annotation: copy(annotation) } }], annotation ? "Move defect source annotation" : "Remove defect source annotation?", false, annotation === null);
    }
    async function editField(entry, key, control) {
      ensureAvailable(true); requireCurrent(entry);
      if ([...state.pending.keys()].some(pending => pending !== control)) {
        control.value = state.pending.get(control) ?? control.value; state.pending.delete(control); changed();
        throw new Error("Apply or discard the other unfinished physical field edits before changing a table cell. Those edits have been preserved.");
      }
      try { const batch = bulkCommands([entry], key, control.value); if (!batch.commands.length) { control.value = state.bindings.get(control).original; state.pending.delete(control); } else await perform(batch.commands, `Change ${titles[entry.kind].toLowerCase()} ${key}`, true, false); }
      finally { changed(); if (!state.destroyed && !state.pending.size) renderData(); }
    }
    async function applyBulkValue() {
      ensureAvailable(); const selected = selectEntries();
      if (!selected.length || selected.some(entry => entry.entity.deleted) || selected.some(entry => entry.kind !== selected[0].kind)) throw new Error("Select active records of one entity type for a bulk edit.");
      const kind = selected[0].kind, field = ui.bulkField.value, value = ui.bulkValue.value;
      if (!fieldsFor(kind, scope()).some(([key]) => key === field) && !(kind === "service" && field === "quantity")) throw new Error("Choose a field belonging to every selected record.");
      selected.forEach(requireCurrent); const batch = bulkCommands(selected, field, value);
      if (!batch.commands.length) { bridge.notify(`All ${selected.length} selected records already have this value. No physical changes were applied.`, false); return; }
      await perform(batch.commands, `Change ${batch.commands.length} of ${selected.length} selected records? ${batch.unchanged.length} already match and stay unchanged.`);
    }
    function renderBulkSelection() {
      const selected = selectEntries(), sameKind = selected.length > 0 && selected.every(entry => !entry.entity.deleted && entry.kind === selected[0].kind), current = ui.bulkField.value;
      ui.bulk.hidden = !selected.length; ui.selection.textContent = `${selected.length} selected`;
      ui.associate.hidden = !servicePlans() || legacyReadOnly(); ui.associate.dataset.locked = String(!canChooseLibrary(selected));
      const options = sameKind ? [...(selected[0].kind === "service" ? [["quantity", "Quantity"]] : []), ...fieldsFor(selected[0].kind, scope()).map(([key, label]) => [key, label])] : [];
      ui.bulkField.replaceChildren(...options.map(([key, label]) => choice(key, label)));
      ui.bulkField.value = options.some(([key]) => key === current) ? current : options[0]?.[0] || "";
      for (const control of [ui.bulkField, ui.bulkValue, ui.bulkApply]) control.dataset.locked = String(!sameKind);
      ui.bulkField.setAttribute("aria-label", "Bulk physical edit field");
      ui.bulkValue.title = sameKind ? "New value for every selected record; blank clears an optional property." : "Select active records of one entity type to edit a shared field.";
      for (const control of [ui.bulkConfirm, ui.bulkUnconfirm]) control.dataset.locked = String(selected.some(entry => entry.entity.deleted) || selected.length > 100 || !selected.length);
    }
    async function confirmSelectedRecords(confirmation) {
      ensureAvailable(); const selected = selectEntries();
      if (!selected.length || selected.some(entry => entry.entity.deleted)) throw new Error("Select active current draft records to review.");
      if (selected.length > 100) throw new Error("A bulk confirmation supports at most 100 selected records. No changes have been applied.");
      selected.forEach(requireCurrent);
      const resolved = selected.map(entry => confirmationOwner(entry, state.index));
      if (resolved.some(entry => !entry)) throw new Error("Select records with an active current confirmation parent to review.");
      const owners = [...new Map(resolved.map(entry => [entry.entity.id, entry])).values()]; owners.forEach(requireCurrent);
      const commands = owners.filter(entry => recordConfirmation(entry.entity) !== confirmation).map(entry => ({ op: "update", entity_id: entry.entity.id, changes: { confirmation } }));
      if (!commands.length) { bridge.notify(`All ${owners.length} owning ${servicePlans() ? "Barriers" : "Defects"} are already ${confirmation === "confirmed" ? "Confirmed" : "Unconfirmed"}. No changes were applied.`, false); return; }
      await perform(commands, `${confirmation === "confirmed" ? "Confirm" : "Unconfirm"} ${commands.length} owning ${servicePlans() ? "Barriers" : "Defects"} and their descendants?`);
    }
    async function reparent(entry) {
      ensureAvailable(); requireCurrent(entry); const [kind] = parentRelations()[entry.kind] || [];
      if (!kind) throw new Error("This record has no physical parent.");
      const parent = await chooseEntity(kind, `Change ${entry.kind} parent`, [...state.index.values()].filter(candidate => candidate.kind === kind && !candidate.entity.deleted && candidate.entity.id !== parentId(entry)));
      if (parent) { requireCurrent(entry); await perform([{ op: "reparent", entity_id: entry.entity.id, parent_id: parent }], "Review parent and descendant relationships"); }
    }
    async function deleteEntity(entry) {
      ensureAvailable(); requireCurrent(entry); const active = descendants(entry).filter(child => !child.entity.deleted);
      const answer = await ask(`Delete draft ${entry.kind}`, [["scope", "Deletion scope", [["only", "Only this entity (requires no active descendants)"], ["cascade", `This entity and ${active.length} active descendants`]], "", true]], `ID: ${displayId(entry)}\n${active.length} active descendants are linked below this entity. Reparent them first or explicitly include them. Tombstones and original identities are retained.`, "Preview deletion");
      if (answer) { requireCurrent(entry); await perform([{ op: "delete", entity_id: entry.entity.id, cascade: answer.scope === "cascade" }], "Review recoverable deletion"); }
    }
    async function deleteDrawing(id) {
      await completePendingEdits(); ensureEditable(); ensureAvailable(); const entry = state.index.get(id); requireCurrent(entry);
      return perform([{ op: "delete", entity_id: id, cascade: true }], "Delete this record and its linked barriers/services?");
    }
    function copyDrawing(id) {
      ensureEditable(); ensureAvailable(); const entry = state.index.get(id); requireCurrent(entry);
      if (!["defect", "barrier"].includes(entry.kind)) throw new Error("Select a defect or barrier callout to copy.");
      const entries = [entry, ...descendants(entry).filter(child => !child.entity.deleted)]; entries.forEach(requireCurrent);
      if (entries.length > 100) throw new Error("This callout exceeds the 100-record atomic copy limit.");
      return { graphId: graph().id, scope: scope(), records: entries.map(value => copy(value)) };
    }
    async function pasteDrawing(copied, destination) {
      await completePendingEdits(); ensureEditable(); ensureAvailable();
      if (copied.graphId !== graph().id || copied.scope !== scope()) throw new Error("Copy a callout in this workspace first.");
      for (const entry of copied.records) requireCurrent(entry);
      const source = copied.records[0].entity, locator = source.annotation || source.marker;
      if (!locator) throw new Error("The copied callout has no retained source annotation.");
      const remap = new Map(copied.records.map(entry => [entry.entity.id, root.crypto.randomUUID()]));
      const delta = destination.point.map((value, axis) => value-locator.point[axis]);
      const commands = copied.records.map(entry => {
        const old = entry.entity, entity = { id: remap.get(old.id), fields: copy(old.fields), evidence: copy(old.evidence),
          uncertainty: { state: "not_assessed", note: `Copied from ${old.display_id || old.id}; verify this new location. ${old.uncertainty.note || ""}`.slice(0, 2000) }, copied_from: { entity_id: old.id, revision: old.revision } };
        const parent = parentRelations()[entry.kind]; if (parent) entity[parent[1]] = remap.get(old[parent[1]]) || old[parent[1]];
        if (entry.kind === "service") entity.quantity = old.quantity;
        if (old.library_quantity) entity.library_quantity = copy(old.library_quantity);
        for (const key of ["marker", "annotation"]) if (old[key]) entity[key] = { ...copy(old[key]), document_id: destination.document_id, document_sha256: destination.document_sha256, page: destination.page, point: old[key].point.map((value, axis) => value+delta[axis]) };
        return { op: "create", kind: entry.kind, entity };
      });
      if (await perform(commands, "Copy callout and linked physical records?")) { const id = remap.get(source.id); await selectDrawing(id, false, false, false); return id; }
    }
    async function deleteSelected() {
      ensureEditable(); ensureAvailable(); const selected = selectEntries(); selected.forEach(requireCurrent);
      let plan = deletionPlan(selected, state.index);
      if (plan.additional.length) {
        const answer = await ask(`Delete ${selected.length} selected records?`, [["scope", "Deletion scope", [["only", "Only selected records (requires no unselected active descendants)"], ["cascade", `Selected records and ${plan.additional.length} additional active descendants`]], "", true]], `${selected.length} selected records include parents of ${plan.additional.length} unselected active descendants. Reparent those descendants or explicitly include them. No records are permanently removed; original IDs and evidence remain available through Show deleted records and Restore draft record.`, "Preview deletion");
        if (!answer) return; selected.forEach(requireCurrent);
        if (answer.scope !== "cascade") throw new Error("Selected records have unselected active descendants. Select those descendants, reparent them, or explicitly include them in the deletion. No records have been deleted.");
        plan = deletionPlan(selected, state.index, true);
      }
      await perform(plan.commands, "Review recoverable deletion");
    }
    async function restore(entry) {
      ensureAvailable(); requireCurrent(entry);
      const answer = await ask(`Restore draft ${entry.kind}`, [["mode", "Restore scope", [["leaf", "Only this entity"], ["same_deletion", "This entity and descendants from the same deletion"], ["selected", "Only the explicit IDs listed below"]], "", true], ["entity_ids", "Explicit restore IDs (selected mode only; one ID per line)", "textarea", ""]], "Parents must already be active or included in the same restoration. For explicit IDs, include this entity's ID and only its deleted descendants. Older tombstones beneath this subtree remain deleted unless explicitly selected. No placeholder entities are created.", "Preview restoration");
      if (answer) {
        const extra = answer.mode === "selected" ? { entity_ids: answer.entity_ids.split(/[\s,]+/).filter(Boolean).map(id => [...state.index.values()].find(candidate => candidate.entity.display_id === id)?.entity.id || id) } : {};
        await perform([{ op: "restore", entity_id: entry.entity.id, mode: answer.mode, ...extra }], "Review retained identities to restore");
      }
    }
    function evidenceFieldOptions(kind) { return [["", "Whole entity"], ...fieldsFor(kind, scope()).map(([key, label]) => [key, label]), ...(kind === "service" ? [["quantity", "Service quantity"]] : []), ...(parentRelations()[kind] ? [[parentRelations()[kind][1], "Physical parent relationship"]] : []), ["uncertainty", "Uncertainty"]]; }
    async function linkImage(entry, image) {
      ensureAvailable(); requireCurrent(entry); imageEvidence(image);
      const issues = (image.issues || []).map(issue => typeof issue === "string" ? issue : issue.message || issue.code).join("\n");
      const answer = await ask("Associate retained image evidence", [["field", "Supported field", evidenceFieldOptions(entry.kind), ""], ["note", "Evidence note / source interpretation", "textarea", "", true]], `Source page ${image.page}\nRetained display rendition SHA-256: ${image.sha256}\nOccurrence ID: ${image.occurrence_id}\n\nAssociating an image does not create a physical object, increase a service quantity or approve topology.${issues ? `\n\nSource warnings remain unresolved by this draft association:\n${issues}` : ""}`, "Preview evidence link");
      if (!answer) return; requireCurrent(entry);
      await perform([{ op: "update", entity_id: entry.entity.id, changes: { evidence: [...entry.entity.evidence, imageEvidence(image, answer.note, answer.field)] } }], "Link retained image to draft record?");
    }
    async function linkDocument(entry) {
      ensureAvailable(); requireCurrent(entry); const documents = state.snapshot?.documents || [];
      if (!documents.length) throw new Error("Upload an original source PDF first.");
      const answer = await ask("Associate source page evidence", [["document_id", "Original document", documents.map(doc => [doc.id, doc.name]), "", true], ["page", "Source page", "number", "", true], ["field", "Supported field", evidenceFieldOptions(entry.kind), ""], ["note", "Evidence note / exact reference", "textarea", "", true]], "The source file's exact hash and page are retained. Page text and image captions do not replace retained image evidence for later visual analysis.", "Preview page link");
      if (!answer) return; requireCurrent(entry); const doc = documents.find(value => value.id === answer.document_id);
      if (!doc || !Number.isInteger(answer.page) || answer.page < 1 || answer.page > doc.pages.length) throw new Error("Choose an existing page in the source document.");
      const evidence = { document_id: doc.id, document_sha256: doc.sha256, page: answer.page, note: answer.note, ...(answer.field ? { fields: evidenceFields(answer.field) } : {}) };
      await perform([{ op: "update", entity_id: entry.entity.id, changes: { evidence: [...entry.entity.evidence, evidence] } }], "Link original source page to draft record?");
    }
    async function removeEvidence(entry, position) {
      ensureAvailable(); requireCurrent(entry);
      await perform([{ op: "update", entity_id: entry.entity.id, changes: { evidence: entry.entity.evidence.filter((_, index) => index !== position) } }], "Remove this draft evidence association?");
    }
    function textCell(value, explanation = "Unknown — no source value recorded.") { const cell = node("td", "", value === "" || value == null ? "—" : value); cell.title = explanation; return cell; }
    function editableCell(entry, key) {
      if (legacyReadOnly() || entry.entity.deleted) return textCell(key === "quantity" ? entry.entity.quantity : fieldDisplay(entry.entity.fields, key), legacyReadOnly() ? "Legacy record: read-only." : "Deleted draft record; restore before editing.");
      const type = fieldType(entry.kind, key), cell = node("td"), control = node(Array.isArray(type) ? "select" : "input"), value = key === "quantity" ? entry.entity.quantity : fieldDisplay(entry.entity.fields, key);
      if (Array.isArray(type)) { populateSelect(control, type, value); if (sharedOptionKeys.has(key)) bindSharedOptions(control, key); }
      else { control.type = type === "number" ? "number" : "text"; control.value = value ?? ""; if (control.type === "number") control.step = key === "quantity" ? "1" : "any"; }
      control.setAttribute("aria-label", `${fieldsFor(entry.kind, scope()).find(definition => definition[0] === key)?.[1] || "Service quantity"} for ${entityName(entry)}`); control.placeholder = "Unknown"; track(control, value, entry, key);
      state.pendingApply.set(control, () => editField(state.bindings.get(control).entry, key, control));
      cell.append(control); return cell;
    }
    function relationCells(entry) {
      const lineage = [...ancestors(entry, state.index), entry], find = kind => lineage.find(candidate => candidate.kind === kind);
      return { lineage, barrier: find("barrier"), defect: find("defect"), opening: find("opening"), service: find("service") };
    }
    function hover(id) { for (const row of ui.table.querySelectorAll("[data-physical-id]")) row.classList.toggle("hovered", row.dataset.physicalId === id); bridge.hover?.(id); }
    function columnValues(key) {
      return [...new Set([...state.index.values()].filter(entry => state.showDeleted || !entry.entity.deleted).map(entry => columnValue(entry, key, state.index)).concat([...(state.columnFilters.get(key) || [])]))].sort((a, b) => a.localeCompare(b, "en-AU", { numeric: true }));
    }
    async function openColumnFilter(key, anchor) {
      if (state.filterDialog || !Object.hasOwn(filterColumns, key)) return;
      await completePendingEdits(); ensureAvailable();
      const identity = `${scope()}/${state.snapshot?.project_id || ""}/${graph()?.id || "new"}`, values = columnValues(key), selected = new Set(state.columnFilters.get(key) ?? values), label = filterColumns[key];
      const dialog = node("dialog", "takeoff-column-filter"), heading = node("h2", "", `Filter ${label}`); heading.id = `takeoff-physical-filter-${root.crypto.randomUUID()}`; dialog.setAttribute("aria-labelledby", heading.id);
      const search = node("input"); search.type = "search"; search.placeholder = "Search values…"; search.setAttribute("aria-label", `Search ${label} values`);
      const allLabel = node("label", "takeoff-column-filter-choice"), all = node("input"); all.type = "checkbox"; all.setAttribute("aria-label", "Select all values"); allLabel.append(all, node("span", "", "Select all"));
      const choices = node("div", "takeoff-column-filter-values"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", `${label} values`);
      let matching = values;
      const updateAll = () => { const count = matching.filter(value => selected.has(value)).length; all.checked = !!matching.length && count === matching.length; all.indeterminate = count > 0 && count < matching.length; all.disabled = !matching.length; };
      const renderChoices = () => {
        const query = search.value.trim().toLowerCase(); matching = values.filter(value => (value || "(Blanks)").toLowerCase().includes(query)); choices.replaceChildren();
        for (const value of matching) {
          const wrapper = node("label", "takeoff-column-filter-choice"), check = node("input"); check.type = "checkbox"; check.checked = selected.has(value); check.setAttribute("aria-label", value || "(Blanks)");
          check.addEventListener("change", () => { check.checked ? selected.add(value) : selected.delete(value); updateAll(); }); wrapper.append(check, node("span", "", value || "(Blanks)")); choices.append(wrapper);
        }
        if (!matching.length) choices.append(node("p", "takeoff-column-filter-empty", "No matching values")); updateAll();
      };
      search.addEventListener("input", renderChoices); all.addEventListener("change", () => { for (const value of matching) all.checked ? selected.add(value) : selected.delete(value); renderChoices(); });
      const actions = node("div", "takeoff-column-filter-actions"); actions.append(button("Apply filter", () => dialog.close("apply"), "button primary"), button("Reset filter", () => dialog.close("reset")), button("Cancel", () => dialog.close("cancel"))); dialog.append(heading, search, allLabel, choices, actions); renderChoices();
      state.filterDialog = dialog; anchor.setAttribute("aria-expanded", "true"); document.body.append(dialog);
      try {
        const result = await new Promise(resolve => {
          dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }); dialog.showModal();
          const bounds = anchor.getBoundingClientRect(), box = dialog.getBoundingClientRect(); dialog.style.left = `${Math.max(8, Math.min(bounds.left, root.innerWidth - box.width - 8))}px`; dialog.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, root.innerHeight - box.height - 8))}px`; search.focus();
        });
        if (!state.destroyed && identity === `${scope()}/${state.snapshot?.project_id || ""}/${graph()?.id || "new"}` && ["apply", "reset"].includes(result)) {
          if (result === "reset" || values.length > 0 && values.every(value => selected.has(value))) state.columnFilters.delete(key); else state.columnFilters.set(key, selected);
          state.offset = 0; renderTable();
        }
      } finally { state.filterDialog = null; anchor.setAttribute("aria-expanded", "false"); dialog.remove(); }
    }
    function columnFilterButton(key) {
      const active = state.columnFilters.has(key), label = filterColumns[key], control = button(`Filter ${label}`, () => openColumnFilter(key, control), `takeoff-column-filter-button${active ? " active" : ""}`), icon = actionIcon(["M3 5h18l-7 8v6l-4 2v-8z"]);
      icon.classList.add?.("takeoff-column-filter-icon"); icon.setAttribute("class", "takeoff-column-filter-icon"); icon.setAttribute("fill", active ? "currentColor" : "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "1.8"); icon.setAttribute("stroke-linejoin", "round"); control.replaceChildren(icon); control.setAttribute("aria-label", `Filter ${label}`); control.setAttribute("aria-haspopup", "dialog"); control.setAttribute("aria-expanded", "false"); control.setAttribute("aria-pressed", String(active)); control.title = active ? `${label}: filter applied` : `Filter ${label}`; return control;
    }
    function renderTable() {
      const rows = hierarchyRows(graph(), state); state.offset = Math.max(0, Math.min(state.offset, Math.max(0, Math.floor((rows.length - 1) / 100) * 100)));
      const page = hierarchyPage(rows, state.index, state.offset), table = node("table"), head = node("thead"), header = node("tr"), body = node("tbody"); table.setAttribute("aria-label", "Draft penetration hierarchy register");
      const legacy = legacyReadOnly(), rowKinds = legacy ? legacyKinds : servicePlans() ? ["barrier", "service"] : kinds;
      const headings = ["Select", "Hide", "View/Edit", ...(legacy ? ["Legacy hierarchy / label"] : []), ...rowKinds.map(kind => `${titles[kind]} ID`), "Confirmation", "Location", "FRL", ...(legacy ? ["Opening type", "Opening size"] : []), "Substrate", "Orientation", "Category", "Service type", "Service quantity", "Service Size (mm)", "Source evidence"];
      for (const label of headings) {
        const cell = node("th", "", label), filterKey = Object.keys(filterColumns).find(key => filterColumns[key] === label);
        if (filterKey) cell.append(columnFilterButton(filterKey));
        if (label === "Select") {
          const matches = matchingActiveRows(), selected = matches.filter(row => state.selected.has(row.entity.id)).length, selectAll = node("input");
          selectAll.type = "checkbox"; selectAll.checked = !!matches.length && selected === matches.length; selectAll.indeterminate = selected > 0 && selected < matches.length;
          selectAll.dataset.locked = String(!matches.length); selectAll.disabled = state.busy || !matches.length;
          selectAll.setAttribute("aria-label", "Select all matching physical records"); selectAll.title = `Select all ${matches.length} matching active records across register pages`;
          selectAll.addEventListener("change", () => void safe(() => { try { ensureAvailable(); } catch (error) { selectAll.checked = !!matches.length && selected === matches.length; throw error; } for (const row of matches) selectAll.checked ? state.selected.add(row.entity.id) : state.selected.delete(row.entity.id); state.inspectedId = null; renderData(); })); cell.append(selectAll);
        }
        if (label === "Hide") {
          const matches = matchingActiveRows(), count = matches.filter(row => state.hidden.has(row.entity.id)).length, hideAll = node("input");
          hideAll.type = "checkbox"; hideAll.checked = !!matches.length && count === matches.length; hideAll.indeterminate = count > 0 && count < matches.length;
          hideAll.disabled = state.busy || !matches.length; hideAll.dataset.locked = String(!matches.length);
          hideAll.dataset.physicalHideAll = "true";
          hideAll.setAttribute("aria-label", "Hide all matching physical records"); hideAll.title = `Hide all ${matches.length} matching active records on drawing`;
          hideAll.addEventListener("change", () => void safe(() => { ensureAvailable(); for (const row of matches) hideAll.checked ? state.hidden.add(row.entity.id) : state.hidden.delete(row.entity.id); renderData(); })); cell.append(hideAll);
        }
        header.append(cell);
      }
      head.append(header); table.append(head, body);
      function disclosure(row) { const collapsed = state.collapsed.has(row.entity.id), control = button(collapsed ? ">" : "<", () => { ensureAvailable(); state.collapsed.has(row.entity.id) ? state.collapsed.delete(row.entity.id) : state.collapsed.add(row.entity.id); renderTable(); }, "text-button takeoff-physical-disclosure"); control.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${displayId(row)}`); control.setAttribute("aria-expanded", String(!collapsed)); return control; }
      function contextNote(row, cell) { if (row.context) cell.append(node("small", "helper", row.continued ? " Parent context (continued)" : " Ancestor context")); }
      for (const row of page) {
        const { entity, kind } = row, line = node("tr", state.selected.has(entity.id) ? "selected" : ""); line.dataset.physicalId = entity.id; line.dataset.physicalKind = kind; line.addEventListener("pointerenter", () => hover(entity.id)); line.addEventListener("pointerleave", () => hover(null));
        const checkbox = node("input"), selectCell = node("td"); checkbox.type = "checkbox"; checkbox.checked = state.selected.has(entity.id); checkbox.setAttribute("aria-label", `Select ${titles[kind]} ${entityName(row)}`); checkbox.addEventListener("change", () => void safe(() => selectEntity(entity.id, true))); selectCell.append(checkbox); line.append(selectCell);
        const hideCell = node("td"), hide = node("input"); hide.type = "checkbox"; hide.checked = state.hidden.has(entity.id); hide.setAttribute("aria-label", `Hide ${titles[kind]} ${entityName(row)} on drawing`);
        hide.dataset.physicalHide = entity.id;
        hide.addEventListener("change", () => void safe(() => { ensureAvailable(); hide.checked ? state.hidden.add(entity.id) : state.hidden.delete(entity.id); renderData(); })); hideCell.append(hide); line.append(hideCell);
        const viewCell = node("td", "takeoff-physical-view-edit"), view = button("View", () => viewEntity(entity.id), "text-button"), edit = button("Edit", () => editEntity(entity.id), "text-button");
        view.title = `View ${displayId(row)} on its source drawing`; edit.title = `${legacy || entity.deleted ? "Inspect" : "Edit"} ${displayId(row)} in Item Details`; edit.setAttribute("aria-controls", "takeoff-physical-details"); viewCell.append(view, edit); line.append(viewCell);
        if (legacy) {
          const label = node("td"); if (row.hasChildren) label.append(disclosure(row));
          label.append(button(`${"↳ ".repeat(row.depth)}${titles[kind]}: ${entityName(row)}`, () => selectEntity(entity.id), "takeoff-row-link")); contextNote(row, label); line.append(label);
        }
        const relation = relationCells(row);
        for (const relationKind of rowKinds) {
          const cell = textCell(relation[relationKind] ? displayId(relation[relationKind]) : null, `${titles[relationKind]} ID`); cell.className = "takeoff-physical-id-cell";
          if (!legacy && kind === relationKind) {
            cell.replaceChildren(); if (row.hasChildren) cell.append(disclosure(row));
            cell.append(button(displayId(row), () => selectEntity(entity.id), "takeoff-row-link"));
            if (entity.fields.label) cell.append(node("small", "takeoff-physical-row-label", entity.fields.label)); contextNote(row, cell);
            if (kind === "barrier" && !state.servicesByBarrier.get(entity.id)?.length) cell.append(node("small", "helper", "0 services"));
          }
          const childKind = !legacy && !entity.deleted && (kind === "defect" && relationKind === "barrier" ? "barrier" : kind === "barrier" && relationKind === "service" ? "service" : null);
          if (childKind) {
            const add = mutationButton("+", () => create(childKind, entity.id), "button secondary takeoff-physical-add-child"), label = `Add ${childKind} to ${displayId(row)}`;
            add.setAttribute("aria-label", label); add.title = label; cell.replaceChildren(add);
          }
          line.append(cell);
        }
        const status = node("td"); status.append(node("span", `takeoff-state ${effectiveConfirmation(row, state.index)}`, confirmationLabel(confirmationOwner(row, state.index)?.entity))); if (entity.deleted || legacy) status.append(node("p", "helper", entity.deleted ? "Deleted draft" : "Legacy read-only")); status.title = "Manual record review only. Technical approval and schedule confirmation remain separate."; line.append(status);
        const inheritedLocation = legacy ? relation.defect?.entity.fields.location ?? relation.barrier?.entity.fields.location : (servicePlans() ? relation.barrier : relation.defect)?.entity.fields.location;
        const location = kind === "defect" || kind === "barrier" && (legacy || servicePlans()) ? editableCell(row, "location") : textCell(inheritedLocation, "Inherited parent location.");
        line.append(location, kind === (servicePlans() ? "barrier" : "defect") ? editableCell(row, "frl") : textCell((servicePlans() ? relation.barrier : relation.defect)?.entity.fields.frl, `Recorded ${servicePlans() ? "barrier" : "defect"} FRL; not a technical approval.`));
        if (legacy) line.append(textCell(relation.opening?.entity.fields.opening_type), textCell(relation.opening?.entity.fields.size));
        line.append(kind === "barrier" ? editableCell(row, "substrate") : textCell(relation.barrier?.entity.fields.substrate), kind === "barrier" ? editableCell(row, "orientation") : textCell(relation.barrier?.entity.fields.orientation));
        for (const field of ["service", "service_type", "quantity", "size"]) line.append(kind === "service" ? editableCell(row, field) : textCell(null, "Only a service record has this property."));
        const evidence = node("td"); evidence.append(node("span", "helper", `${entity.evidence.length} source associations`)); if (entity.evidence[0]) evidence.append(button("Open source", () => bridge.source(copy(entity.evidence[0])), "text-button")); line.append(evidence); body.append(line);
      }
      ui.table.replaceChildren(table); if (!rows.length) ui.table.append(node("p", "takeoff-register-empty", graph() ? "No matching physical records. Adjust the filter or create an explicitly linked draft record." : `Create ${servicePlans() ? "a substrate" : "a defect"} to begin the physical hierarchy. Uploaded images never create physical records automatically.`));
      ui.pagination.replaceChildren(button("Previous 100 records", () => { ensureAvailable(); state.offset = Math.max(0, state.offset - 100); renderTable(); }), node("span", "helper", `${rows.length ? state.offset + 1 : 0}–${Math.min(state.offset + 100, rows.length)} of ${rows.length} visible hierarchy records. Ancestor context may repeat across pages.`), button("Next 100 records", () => { ensureAvailable(); if (state.offset + 100 < rows.length) state.offset += 100; renderTable(); }));
      bridge.viewChanged?.(rows.map(row => row.entity.id), [...state.selected], [...state.hidden]);
    }
    function defectFor(entry) {
      return entry?.kind === "defect" ? entry : entry && ancestors(entry, state.index).find(parent => parent.kind === "defect");
    }
    function renderDetailNavigation() {
      const table = node("table", "takeoff-physical-navigation"), head = node("thead"), headers = node("tr"), body = node("tbody"), cells = node("tr");
      table.setAttribute("aria-label", "Item Details navigation");
      const inspected = inspectedEntry(), lineage = inspected ? [...ancestors(inspected, state.index), inspected] : [];
      const editorKey = graphKey(), defect = defectFor(inspected);
      for (const kind of servicePlans() ? ["barrier", "service"] : kinds) {
        const header = node("th", "", titles[kind]); header.setAttribute("scope", "col"); headers.append(header);
        const cell = node("td"), control = node("select"); control.setAttribute("aria-label", `${titles[kind]} ID in Item Details`);
        // Legacy barriers precede defects. Keep their original read-only navigation
        // without interpreting that retained topology as the current hierarchy.
        const entries = [...state.index.values()].filter(entry => entry.kind === kind && !entry.entity.deleted && (legacyReadOnly() || servicePlans() || kind === "defect" || defect && !defect.entity.deleted && defectFor(entry)?.entity.id === defect.entity.id)).sort((a, b) => displayId(a).localeCompare(displayId(b), "en-AU", { numeric: true }) || a.entity.id.localeCompare(b.entity.id));
        const related = lineage.find(entry => entry.kind === kind && !entry.entity.deleted);
        const current = related && related.entity.id === inspected?.entity.id ? related.entity.id : "";
        populateSelect(control, entries.map(entry => [entry.entity.id, displayId(entry)]), current);
        if (related && !current) control.children[0].textContent = `View ${displayId(related)}`;
        control.dataset.locked = String(!entries.length); control.disabled = state.busy || !entries.length;
        control.addEventListener("change", () => void safe(async () => {
          const id = control.value; control.value = current;
          if (!id || id === current && inspectedEntry()?.entity.id === id) return;
          const hadPending = !!state.pending.size || !!state.autoApplyPromise;
          if (hadPending) await completePendingEdits();
          ensureAvailable();
          const entry = state.index.get(id);
          if (!hadPending && graphKey() !== editorKey || !entry || entry.kind !== kind || entry.entity.deleted || !entries.some(value => value.entity.id === id)) throw new Error("The physical draft changed. Choose a current record in Item Details.");
          await selectEntity(id);
        }));
        cell.append(control); cells.append(cell);
      }
      head.append(headers); body.append(cells); table.append(head, body); ui.inspector.append(table);
    }
    function renderInspector() {
      const matches = matchingActiveRows();
      ui.selectFiltered.setAttribute("aria-pressed", String(matches.length > 0 && matches.every(row => state.selected.has(row.entity.id))));
      state.inspectorEdit = null;
      inspectorMenu?.destroy(); inspectorMenu = null;
      ui.inspector.replaceChildren(); const selected = selectEntries(); ui.selection.textContent = `${selected.length} selected`;
      if (selected.length === 1) bridge.renderDrawingAppearance?.(ui.inspector, inspectedEntry().entity);
      const drawingOwner = selected.length === 1 && visibilityOwner(inspectedEntry());
      const visibility = drawingOwner ? visibilityButton(inspectedEntry(), drawingOwner) : null;
      ui.inspector.append(node("h3", "", "Item Details"));
      if (!servicePlans()) {
        const defects = [...new Map(selected.map(entry => defectFor(entry)).filter(Boolean).map(entry => [entry.entity.id, entry])).values()];
        const defect = defectFor(inspectedEntry()) || (defects.length === 1 ? defects[0] : null);
        ui.inspector.append(node("p", "takeoff-physical-defect-id", `Defect ID: ${defect ? displayId(defect) : defects.length > 1 ? "Multiple selected" : "—"}`));
      }
      const entry = inspectedEntry(), entity = entry?.entity, editorKey = graphKey();
      const itemActions = node("div", "takeoff-physical-item-actions");
      const addActions = [];
      if (entry?.kind === "defect" && !legacyReadOnly() && !entity.deleted) {
        const addBarrier = imageMutationButton("Add Barrier", () => create("barrier", entity.id), "/icons/takeoff-add-barrier.png", "takeoff-physical-add-barrier");
        addBarrier.setAttribute("aria-label", "Add barrier in Item Details"); addBarrier.title = `Add barrier to ${displayId(entry)}`; addActions.push(addBarrier);
      }
      if (!legacyReadOnly() && selected.length && selected.every(value => !value.entity.deleted)) {
        const addService = imageMutationButton("Add Service", () => createFromSelection("service"), "/icons/takeoff-add-service.png", "takeoff-physical-add-service");
        const barrier = entry && [...ancestors(entry, state.index), entry].find(value => value.kind === "barrier");
        addService.setAttribute("aria-label", "Add service in Item Details"); addService.title = barrier ? `Add service to ${displayId(barrier)}` : "Add service to an explicitly chosen barrier"; addActions.push(addService);
      }
      if (canChooseLibrary(selected)) {
        const library = mutationButton("Add Library Item", attachLibraryToSelected), icon = actionIcon(["M3 5.5c3.2-.9 6-.3 9 2v12c-3-2.3-5.8-2.9-9-2z", "M21 5.5c-3.2-.9-6-.3-9 2v12c3-2.3 5.8-2.9 9-2z"]);
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"), gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient"), id = `takeoff-library-${crypto.randomUUID()}`;
        gradient.id = id; gradient.setAttribute("x1", "0%"); gradient.setAttribute("y1", "0%"); gradient.setAttribute("x2", "100%"); gradient.setAttribute("y2", "100%");
        for (const [offset, color] of [["0%", "#ff0000"], ["50%", "#ff6600"], ["100%", "#ffa600"]]) { const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop"); stop.setAttribute("offset", offset); stop.setAttribute("stop-color", color); gradient.append(stop); }
        defs.append(gradient); icon.append(defs); for (const path of icon.querySelectorAll("path")) path.setAttribute("stroke", `url(#${id})`);
        library.setAttribute("aria-label", "Add Library Item"); library.title = "Add Library Item"; library.replaceChildren(icon); addActions.push(library);
      }
      if (addActions.length) {
        inspectorMenu = actionDisclosure("Add", "Add item actions", "takeoff-physical-add-menu");
        for (const action of addActions) {
          const label = action.className.includes("takeoff-physical-add-barrier") ? "Add Barrier" : action.className.includes("takeoff-physical-add-service") ? "Add Service" : "Add Library Item";
          action.className += " calculator-document-action"; action.append(node("span", "", label)); inspectorMenu.add(action);
        }
        itemActions.append(inspectorMenu.root);
      }
      if (visibility) { itemActions.className += " with-visibility"; itemActions.append(visibility); }
      let remove;
      if (entry && !legacyReadOnly() && !entity.deleted) {
        remove = button("Delete draft record", flushed => deleteEntity(flushed ? state.index.get(entity.id) : entry), "button secondary takeoff-physical-delete-selected"); remove.setAttribute("aria-label", "Delete draft record"); remove.title = "Delete draft record"; remove.replaceChildren(deleteIcon());
      }
      if (itemActions.children.length) ui.inspector.append(itemActions);
      ui.inspector.append(inspectorActions(remove));
      renderDetailNavigation();
      if (selected.length !== 1) { ui.inspector.append(node("p", "helper", selected.length ? "Select active records of one entity type for a counted, reversible bulk edit." : "Select a hierarchy row to inspect its parent, evidence and uncertainty.")); renderLibraryAssignments(selected); return; }
      if (legacyReadOnly() || entity.deleted) {
        if (!legacyReadOnly()) ui.inspector.append(mutationButton("Restore draft record", () => restore(entry)), node("p", "helper", "Original fields, evidence and parent IDs are retained. Restore previews disclose descendants and do not invent missing parents."));
        for (const [key, label] of (entry.kind === "opening" ? legacyOpeningFields : [...(retainedDefinitions[entry.kind] || []), ...(legacyReadOnly() ? definitions[entry.kind] : fieldsFor(entry.kind, scope()))])) ui.inspector.append(node("p", "helper", `${label}: ${fieldDisplay(entity.fields, key) ?? "Unknown"}`));
        if (entry.kind === "service") ui.inspector.append(node("p", "helper", entity.quantity == null ? "Service quantity unknown: enter an explicit physical count when reviewed. The commercial schedule contribution is separate." : `Explicit service quantity: ${entity.quantity}`));
        ui.inspector.append(node("p", "helper", `Uncertainty: ${entity.uncertainty.state} · ${entity.uncertainty.note || "No explanation recorded"}`)); return;
      }
      if (parentRelations()[entry.kind]) ui.inspector.append(button("Change Parent", flushed => reparent(flushed ? state.index.get(entity.id) : entry)));
      const controls = fieldDefinitions(entry).map(([key, label, type, initial, required]) => {
        const wrapper = node("label", "field"), control = node(Array.isArray(type) ? "select" : type === "textarea" ? "textarea" : "input"); wrapper.append(node("span", "", label));
        if (Array.isArray(type)) { if (key === "confirmation") control.replaceChildren(...type.map(([value, text]) => choice(value, text))); else populateSelect(control, type, initial); if (sharedOptionKeys.has(key)) bindSharedOptions(control, key); } else if (type !== "textarea") control.type = type === "number" ? "number" : "text";
        control.value = initial ?? ""; control.name = key; control.required = !!required; if (type === "number") control.step = key === "quantity" ? "1" : "any"; control.setAttribute("aria-label", label); track(control, initial, entry, key); wrapper.append(control); ui.inspector.append(wrapper); return control;
      });
      const editor = { controls, entry, key: editorKey };
      editor.submit = async () => { ensureAvailable(true); await ensureFieldOptions(editor.entry.kind, true); ensureAvailable(true); if (editor.key !== graphKey()) throw new Error("The physical draft changed before the unfinished edits could be validated. Inspect the current record and try again."); requireCurrent(editor.entry); const entity = editor.entry.entity, values = Object.fromEntries(controls.map(control => [control.name, control.value])); const changes = { fields: fieldsFromValues(editor.entry.kind, values, entity.fields, scope()), ...(Object.hasOwn(values, "confirmation") && recordConfirmation(entity) !== values.confirmation ? { confirmation: values.confirmation } : {}), ...(editor.entry.kind === "service" ? { quantity: recordedQuantity(entity, values.quantity) } : {}) }; if (Object.entries(changes).every(([key, value]) => sameValue(entity[key], value))) { resetPending(); renderData(); return true; } return perform([{ op: "update", entity_id: entity.id, changes }], "Apply physical field changes", true, false); };
      state.inspectorEdit = editor;
      const reviewOwner = confirmationOwner(entry, state.index);
      ui.inspector.append(node("p", "helper", reviewOwner && reviewOwner.entity.id !== entity.id ? `Confirmation: ${confirmationLabel(reviewOwner.entity)} — inherited from ${titles[reviewOwner.kind]} ${displayId(reviewOwner)}. Edit its details to review confirmation. This does not approve technical compliance or add schedule quantity.` : "Confirmation records your manual review of this draft's fields. It does not approve technical compliance or add schedule quantity."));
      if (entity.uncertainty?.state !== "not_assessed" || entity.uncertainty?.note) ui.inspector.append(node("p", "helper takeoff-retained-uncertainty", `Retained uncertainty: ${uncertainty.find(([key]) => key === entity.uncertainty.state)?.[1] || entity.uncertainty.state}. ${entity.uncertainty.note || ""}`));
      renderLibraryAssignments(selected);
    }
    function visibilityOwner(entry) {
      if (!entry || entry.entity.deleted) return null;
      const lineage = [entry, ...ancestors(entry, state.index).reverse()];
      if (bridge.drawingOwner) { const id = bridge.drawingOwner(entry.entity.id); return lineage.find(value => !value.entity.deleted && value.entity.id === id) || null; }
      return lineage.find(value => !value.entity.deleted && (value.entity.marker || value.entity.annotation)) || null;
    }
    function visibilityButton(entry, owner) {
      const control = node("button", "button secondary icon-only takeoff-icon-button takeoff-physical-visibility takeoff-current-visibility"), icon = node("img"), identity = `${scope()}/${state.snapshot?.project_id || ""}/${graph()?.id || "new"}`;
      control.type = "button"; control.setAttribute("aria-label", "Visibility"); icon.src = "/icons/takeoff-visibility.png"; icon.alt = ""; icon.width = 32; icon.height = 32; icon.setAttribute("aria-hidden", "true"); control.append(icon);
      const sync = () => { const hidden = state.hidden.has(owner.entity.id); control.setAttribute("aria-pressed", String(hidden)); control.title = `${hidden ? "Show" : "Hide"} callout ${displayId(owner)}`; };
      sync();
      control.addEventListener("click", () => void safe(() => {
        ensureAvailable(true);
        if (identity !== `${scope()}/${state.snapshot?.project_id || ""}/${graph()?.id || "new"}` || inspectedEntry()?.entity.id !== entry.entity.id || visibilityOwner(inspectedEntry())?.entity.id !== owner.entity.id) throw new Error("Select the current physical item again.");
        state.hidden.has(owner.entity.id) ? state.hidden.delete(owner.entity.id) : state.hidden.add(owner.entity.id); sync();
        for (const hide of controlsInWorkspace("[data-physical-hide]")) hide.checked = state.hidden.has(hide.dataset.physicalHide);
        const matches = matchingActiveRows(), count = matches.filter(row => state.hidden.has(row.entity.id)).length;
        for (const hideAll of controlsInWorkspace("[data-physical-hide-all]")) { hideAll.checked = !!matches.length && count === matches.length; hideAll.indeterminate = count > 0 && count < matches.length; }
        bridge.viewChanged?.(hierarchyRows(graph(), state).map(row => row.entity.id), [...state.selected], [...state.hidden]);
      }));
      return control;
    }
    function imageMutationButton(label, action, src, className) {
      const control = mutationButton(label, action, `button secondary takeoff-physical-icon-action ${className}`), icon = node("img");
      control.setAttribute("aria-label", label); control.title = label; icon.src = src; icon.alt = ""; icon.width = 32; icon.height = 32; icon.setAttribute("aria-hidden", "true"); control.replaceChildren(icon); return control;
    }
    function inspectorActions(remove) { const actions = node("div", "takeoff-physical-inspector-actions"); if (remove) actions.append(remove); actions.append(ui.discard); return actions; }
    function renderAssociations(entry) {
      const entity = entry.entity;
      ui.inspector.append(node("h3", "", "SOURCE ASSOCIATIONS"));
      for (const [position, evidence] of entity.evidence.entries()) {
        const card = node("div", "takeoff-exclusion"), doc = (state.snapshot?.documents || []).find(value => value.id === evidence.document_id);
        card.append(button(`${doc?.name || evidence.document_id} · p${evidence.page}`, () => bridge.source(copy(evidence)), "text-button"), node("p", "helper", evidence.note || "No interpretation note recorded."), node("p", "takeoff-identity", `Document SHA-256: ${evidence.document_sha256}`));
        if (evidence.image_id) card.append(node("p", "takeoff-identity", `Image ID: ${evidence.image_id}\nRetained display rendition SHA-256: ${evidence.image_sha256}\nOccurrence: ${evidence.occurrence_id}`));
        if (!legacyReadOnly() && !entity.deleted) card.append(button("Remove source association", () => removeEvidence(entry, position), "text-button")); ui.inspector.append(card);
      }
      if (!entity.evidence.length) ui.inspector.append(node("p", "takeoff-warning", "No source evidence is linked. Select a retained image below or link an original page. This draft is not approved."));
    }
    async function refreshImages(automatic = false) {
      if (!automatic) ensureAvailable(); const run = ++state.imageGeneration, project = state.snapshot?.project_id; state.imageState = "Loading retained image evidence…"; renderGallery();
      try { const images = state.extractionId ? await bridge.images(state.extractionId) : []; if (state.destroyed || run !== state.imageGeneration || project !== state.snapshot?.project_id) return; if (!Array.isArray(images) || images.filter(image => !image.coverage_only).length > 512) throw new Error("The retained image inventory is incomplete or exceeds the 512-occurrence extraction limit."); state.images = images; state.imageFailures.clear(); state.imageState = state.extractionId ? imageInventorySummary(images) : "No retained extraction. Open a source PDF page and extract its embedded images."; renderGallery(); }
      catch (error) { if (!state.destroyed && run === state.imageGeneration && project === state.snapshot?.project_id) { state.imageState = `Retained image inventory failed: ${error.message}`; renderGallery(); report(error); } }
    }
    function renderGallery() {
      ui.gallery.replaceChildren(node("h3", "", "RETAINED SOURCE IMAGES"), node("p", "helper", state.imageState));
      const selector = node("select"); selector.setAttribute("aria-label", "Retained image extraction");
      selector.append(choice("", "Choose a retained extraction"));
      for (const extraction of [...(state.snapshot?.image_extractions || [])].reverse()) {
        const source = (state.snapshot?.documents || []).find(doc => doc.id === extraction.document_id), pages = extraction.pages || [];
        selector.append(choice(extraction.id, `${source?.name || "Source PDF"} · pages ${pages.join(", ") || "unknown"} · ${extraction.id.slice(0, 8)}`));
      }
      selector.value = state.extractionId; selector.disabled = state.busy;
      selector.addEventListener("change", () => void safe(async () => { ensureAvailable(); state.extractionId = selector.value; state.images = []; state.imageOffset = 0; await refreshImages(true); }));
      ui.gallery.append(selector, node("p", "helper", "One extraction is loaded at a time (up to 25 pages and 512 image occurrences); 12 image and coverage records are displayed per page. Other retained extractions remain available in this selector."));
      state.imageOffset = Math.max(0, Math.min(state.imageOffset, Math.max(0, Math.floor((state.images.length - 1) / 12) * 12)));
      for (const image of state.images.slice(state.imageOffset, state.imageOffset + 12)) {
        if (image.coverage_only) {
          const card = node("details", "takeoff-exclusion"); card.append(node("summary", "", image.name || "Source extraction coverage"), node("p", "helper", image.coverage || "Coverage is unavailable."));
          for (const issue of image.issues || []) card.append(node("p", "takeoff-warning", typeof issue === "string" ? issue : issue.message || issue.code || JSON.stringify(issue)));
          if (image.document_id && image.page) card.append(button("Open original source page", () => bridge.source({ document_id: image.document_id, document_sha256: image.document_sha256, page: image.page }), "text-button"));
          ui.gallery.append(card); continue;
        }
        const card = node("details", "takeoff-exclusion"), name = image.name || `${image.document_id} · p${image.page}`; card.dataset.imageOccurrence = image.occurrence_id || "unavailable"; card.append(node("summary", "", `${name} · occurrence ${image.occurrence_id || "unavailable"}`));
        card.append(node("p", "takeoff-identity", `Image ID: ${image.id || "unavailable"}\nRetained display rendition SHA-256: ${image.sha256 || "unavailable"}\nDocument SHA-256: ${image.document_sha256 || "unavailable"}`));
        if (image.original_sha256) card.append(node("p", "takeoff-identity", `Retained original image stream SHA-256: ${image.original_sha256}`));
        if (image.quad_pdf) card.append(node("p", "helper", `Original PDF image placement: ${JSON.stringify(image.quad_pdf)}`));
        if (image.region) card.append(node("p", "helper", `${image.region_clipped ? "Clipped source marker" : "Display source marker"}: ${JSON.stringify(image.region)}`));
        for (const issue of image.issues || []) card.append(node("p", "takeoff-warning", typeof issue === "string" ? issue : issue.message || issue.code || JSON.stringify(issue)));
        let loaded = false; card.addEventListener("toggle", () => {
          if (!card.open || loaded) return; loaded = true;
          try {
            const value = bridge.imageUrl(image), url = new URL(value, root.location.href);
            if (url.origin !== root.location.origin || !/^https?:$/.test(url.protocol)) throw new Error("Retained images must use the application's same-origin evidence route.");
            const picture = node("img"); picture.src = url.href; picture.alt = `${name}. Retained display rendition; no inferred physical quantity.`; picture.loading = "lazy"; picture.width = 420;
            picture.addEventListener("error", () => { state.imageFailures.add(image.occurrence_id); card.append(node("p", "takeoff-warning", "This retained image could not be displayed. Inspect the original source and resolve the evidence failure; do not rely on the missing image.")); }); card.append(picture);
          } catch (error) { state.imageFailures.add(image.occurrence_id); card.append(node("p", "takeoff-warning", error.message)); }
        });
        card.append(button("Open original source page", () => bridge.source({ document_id: image.document_id, document_sha256: image.document_sha256, page: image.page, ...(image.region ? { region: image.region } : {}) }), "text-button"));
        card.append(mutationButton("Link image to selected record", () => { const selected = selectEntries(); if (selected.length !== 1 || selected[0].entity.deleted) throw new Error("Select one active physical record to associate this image."); if (state.imageFailures.has(image.occurrence_id)) throw new Error("The retained image could not be inspected. Retry loading its evidence first."); return linkImage(selected[0], image); }, "text-button"));
        ui.gallery.append(card);
      }
      ui.gallery.append(button("Previous 12 image records", () => { state.imageOffset = Math.max(0, state.imageOffset - 12); renderGallery(); }), node("span", "helper", ` ${state.images.length ? state.imageOffset + 1 : 0}–${Math.min(state.imageOffset + 12, state.images.length)} of ${state.images.length} image and coverage records `), button("Next 12 image records", () => { if (state.imageOffset + 12 < state.images.length) state.imageOffset += 12; renderGallery(); }));
    }
    function renderData() { if (state.destroyed) return; const focused = state.autoRoutine && state.bindings.has(document.activeElement); if (!focused || !ui.table.contains(document.activeElement)) renderTable(); if (!focused || !ui.inspector.contains(document.activeElement)) renderInspector(); renderBulkSelection(); ui.readOnlyNotice.hidden = !legacyReadOnly(); ui.heading.textContent = `${servicePlans() ? "SERVICE PLANS" : "DEFECT REPORTS"} — PHYSICAL DRAFT`; ui.add.setAttribute("aria-label", servicePlans() ? "Add substrate" : "Add defect"); ui.add.title = servicePlans() ? "Add substrate" : "Add defect"; ui.status.textContent = `Physical revision ${graph()?.revision ?? 0} · ${state.index.size} retained identities · ${legacyReadOnly() ? "Legacy read-only" : "Unapproved draft"}`; setBusy(state.busy); }
    function render(snapshot) {
      if (state.destroyed) return; const oldKey = graphKey(), oldProject = state.snapshot?.project_id, oldScope = state.scope; state.snapshot = snapshot; state.scope = scope(); state.index = indexGraph(snapshot?.physical); state.selected = new Set([...state.selected].filter(id => state.index.has(id)));
      state.servicesByBarrier = new Map();
      for (const entry of state.index.values()) if (entry.kind === "service" && !entry.entity.deleted) {
        const id = entry.entity.barrier_id || ancestors(entry, state.index).find(parent => parent.kind === "barrier")?.entity.id;
        if (!state.servicesByBarrier.has(id)) state.servicesByBarrier.set(id, []); state.servicesByBarrier.get(id).push(entry);
      }
      for (const entries of state.servicesByBarrier.values()) entries.sort((a, b) => displayId(a).localeCompare(displayId(b), "en-AU", { numeric: true }));
      const context = bridge.imageContext?.() || {}, descriptors = snapshot?.image_extractions || [];
      const inventoryKey = `${snapshot?.project_id || ""}/${context.document_id || ""}/${context.page || ""}/${JSON.stringify(descriptors)}`;
      if (oldProject !== snapshot?.project_id || oldScope !== state.scope) { ++state.imageGeneration; state.selected.clear(); state.inspectedId = null; state.collapsed.clear(); state.columnFilters.clear(); state.filterDialog?.close("cancel"); state.offset = 0; state.images = []; state.imageFailures.clear(); state.imageOffset = 0; state.imageInventoryKey = ""; state.imageState = "Not loaded"; resetPending(); }
      if (state.imageInventoryKey !== inventoryKey) { state.imageInventoryKey = inventoryKey; const newest = [...descriptors].reverse(); state.extractionId = (newest.find(value => value.document_id === context.document_id && value.pages?.includes(context.page)) || newest[0])?.id || ""; state.images = []; state.imageOffset = 0; void refreshImages(true); }
      if (state.pending.size && !state.busy && oldKey !== graphKey()) { bridge.notify("The physical draft changed while fields were unfinished. Applying will recheck the record revision; discard unfinished edits to show the current draft.", true); return; }
      if (!state.pending.size && !state.autoRoutine) renderData();
    }
    async function runBridge(action, confirmation) {
      ensureAvailable(); if (confirmation && !await ask(confirmation.title, [], confirmation.text, confirmation.button)) return; setBusy(true);
      try { const reply = await action(); if (!state.destroyed) displayReply(reply); }
      finally { if (!state.destroyed) { setBusy(false); renderData(); } }
    }
    async function completePendingEdits() {
      cancelAutomatic();
      if (state.autoApplyPromise) return state.autoApplyPromise;
      ensureAvailable(true); if (!state.pending.size) return;
      const initialKey = graphKey(); state.autoRoutine = true;
      const applying = Promise.resolve().then(async () => {
        if (state.destroyed || initialKey !== graphKey()) throw new Error("The physical draft changed before the unfinished edits could be validated. Your input is preserved.");
        while (state.pending.size) {
          ensureAvailable(true); const pending = [...state.pending.keys()], inspector = state.inspectorEdit;
          if (inspector && pending.every(control => inspector.controls.includes(control))) await inspector.submit();
          else if (pending.length === 1 && state.pendingApply.has(pending[0])) await state.pendingApply.get(pending[0])();
          else throw new Error("Finish the separate physical field edits before saving. Your unfinished input is preserved.");
          if (state.destroyed) throw new Error("The physical workspace changed before saving. Review the unfinished physical edits and save again.");
        }
      });
      state.autoApplyPromise = applying;
      try { await applying; } finally { if (state.autoApplyPromise === applying) { state.autoApplyPromise = null; state.autoRoutine = false; } changed(); }
    }
    async function clearSelection() { await completePendingEdits(); ensureAvailable(); state.selected.clear(); state.inspectedId = null; renderData(); bridge.selectionChanged?.({ selected: [], barrierId: null, entry: null, inspectedId: null, focus: false }); await bridge.selection?.([], null, false); }
    function discardIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle"); circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "9");
      const cross = document.createElementNS("http://www.w3.org/2000/svg", "path"); cross.setAttribute("d", "m9 9 6 6m0-6-6 6"); svg.append(circle, cross); return svg;
    }
    function deleteIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"); svg.append(path); return svg;
    }
    function actionIcon(paths) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      for (const value of paths) { const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", value); svg.append(path); } return svg;
    }
    function iconAction(label, action, paths, mutation = false) {
      const control = (mutation ? mutationButton : button)(label, action, "button secondary takeoff-physical-icon-action"); control.setAttribute("aria-label", label); control.title = label; control.replaceChildren(actionIcon(paths)); return control;
    }
    // Document and Add disclosures share view-only keyboard/dismissal behavior.
    // Existing action buttons still own pending-edit flushes and draft commands.
    function actionDisclosure(label, accessibleName, className) {
      const menu = node("div", `calculator-document-menu ${className}`), list = node("div", "calculator-document-actions"), toggle = node("button", "button secondary calculator-document-toggle", label), actions = [];
      list.setAttribute("role", "group"); list.setAttribute("aria-label", accessibleName); list.id = `takeoff-actions-${crypto.randomUUID()}`;
      toggle.type = "button"; toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", list.id);
      const chevron = node("span", "calculator-document-chevron"); chevron.setAttribute("aria-hidden", "true"); chevron.append(actionIcon(["m6 9 6 6 6-6"])); toggle.append(chevron);
      const close = (restoreFocus = false) => { list.hidden = true; toggle.setAttribute("aria-expanded", "false"); if (restoreFocus) toggle.focus(); };
      const open = () => { list.hidden = false; toggle.setAttribute("aria-expanded", "true"); };
      toggle.addEventListener("click", () => list.hidden ? open() : close());
      menu.addEventListener("keydown", event => {
        if (event.key === "Escape" && !list.hidden) { event.preventDefault(); close(true); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); open(); const choices = actions.filter(control => !control.disabled && !control.hidden), index = choices.indexOf(document.activeElement);
        if (choices.length) choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : event.key === "ArrowDown" ? (index + 1) % choices.length : (index < 0 ? choices.length - 1 : (index + choices.length - 1) % choices.length)].focus();
      });
      menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget)) close(); });
      const outside = event => { if (!menu.contains(event.target)) close(); }; document.body.addEventListener("pointerdown", outside);
      close(); menu.append(toggle, list);
      return { root: menu, toggle, list, close, add(control) { actions.push(control); list.append(control); control.addEventListener("click", () => close(true), { capture: true }); }, destroy() { document.body.removeEventListener("pointerdown", outside); close(); } };
    }
    ui.root = node("section", "takeoff-register takeoff-physical-register"); ui.root.setAttribute("aria-label", "Manual draft penetration workspace");
    const heading = node("div", "section-heading"); ui.heading = node("h2"); heading.append(ui.heading); ui.status = node("span", "status-label"); heading.append(ui.status); ui.root.append(heading);
    ui.readOnlyNotice = node("p", "takeoff-warning takeoff-physical-legacy-notice", "Legacy hierarchy — read-only until its relationships are assigned. Original records, fields and evidence are preserved for inspection and export."); ui.root.append(ui.readOnlyNotice);
    const tools = node("div", "takeoff-register-controls");
    tools.append(mutationButton("Extract images from selected PDF page", () => runBridge(async () => { const reply = await bridge.extract(); displayReply(reply); await refreshImagesAfterExtraction(); return reply; })), button("Refresh retained images", refreshImages));
    const documents = actionDisclosure("Document", "Document actions", "takeoff-document-menu");
    for (const [format, confirmation, label] of [["xlsx", "confirmed", "Download confirmed items"], ["xlsx", "unconfirmed", "Download unconfirmed items"], ["xlsx", "all", "Download all items"], ["pdf", null, "Download Passive Fire Matrix PDF"]]) {
      const control = button(label, () => runBridge(() => bridge.export(format, confirmation)), "button secondary calculator-document-action");
      control.setAttribute("aria-label", label); const icon = node("span", "download-format-icon"); icon.setAttribute("aria-hidden", "true"); icon.append(node("span", "download-arrow", "↓"), node("span", "download-format", format.toUpperCase())); control.replaceChildren(icon, node("span", "", label));
      documents.add(control);
    }
    tools.append(documents.root);
    ui.root.append(tools); const filters = node("div", "takeoff-register-controls"), search = node("input"); search.type = "search"; search.placeholder = "Filter physical records…"; search.setAttribute("aria-label", "Filter physical hierarchy"); search.addEventListener("input", () => { if (state.pending.size || state.busy) return; state.filter = search.value; state.offset = 0; renderTable(); });
    const deleted = node("label", "takeoff-check"), show = node("input"); show.type = "checkbox"; show.addEventListener("change", () => void safe(() => { ensureAvailable(); state.showDeleted = show.checked; state.offset = 0; renderTable(); })); deleted.append(show, node("span", "", "Show deleted records"));
    ui.discard = button("Discard unfinished physical edits", () => { if (state.busy) throw new Error("Finish the current review first."); resetPending(); renderData(); bridge.notify("Unfinished physical field edits discarded. Recorded draft values are unchanged.", false); }, "button secondary takeoff-physical-discard"); ui.discard.setAttribute("aria-label", "Discard unfinished physical edits"); ui.discard.title = "Discard unfinished physical edits"; ui.discard.replaceChildren(discardIcon());
    const deleteSelection = mutationButton("Delete", deleteSelected); deleteSelection.setAttribute("aria-label", "Delete selected records"); deleteSelection.title = "Delete selected records";
    ui.selection = node("strong"); filters.append(search, deleted,
      ui.selectFiltered = iconAction("Select filtered records", () => { ensureAvailable(); const rows = matchingActiveRows(), deselect = rows.length > 0 && rows.every(row => state.selected.has(row.entity.id)); for (const row of rows) deselect ? state.selected.delete(row.entity.id) : state.selected.add(row.entity.id); state.inspectedId = null; renderData(); }, ["M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "m7 12 3 3 7-7"]),
      iconAction("Transfer to Firestopping Schedule", transferConfirmedRegister, ["M12 4v16M4 12h16"], true),
      iconAction("Update linked rows", () => selectedLibraryAction("update"), ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 6v6h6"], true),
      iconAction("Unlink from Firestopping Schedule", () => selectedLibraryAction("unlink"), ["M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2"], true)); ui.root.append(filters);
    ui.bulk = node("div", "takeoff-register-controls takeoff-bulk takeoff-physical-bulk"); ui.bulkField = node("select"); ui.bulkField.dataset.physicalMutation = "true"; ui.bulkValue = node("input"); ui.bulkValue.dataset.physicalMutation = "true"; ui.bulkValue.type = "text"; ui.bulkValue.placeholder = "New value (blank clears)"; ui.bulkValue.setAttribute("aria-label", "Bulk physical edit value");
    ui.associate = mutationButton("Associate Existing Records", associateLibraryWithSelected);
    ui.bulkApply = mutationButton("Apply to selected", applyBulkValue); ui.bulkConfirm = mutationButton("Confirm", () => confirmSelectedRecords("confirmed")); ui.bulkUnconfirm = mutationButton("Unconfirm", () => confirmSelectedRecords("unconfirmed")); ui.bulk.append(ui.selection, ui.associate, ui.bulkField, ui.bulkValue, ui.bulkApply, ui.bulkConfirm, ui.bulkUnconfirm, deleteSelection); ui.root.append(ui.bulk);
    ui.table = node("div", "takeoff-register-table"); const addRow = node("div", "takeoff-physical-add-row"); ui.add = mutationButton("+", () => create(servicePlans() ? "barrier" : "defect"), "button secondary takeoff-physical-add-child takeoff-physical-add-defect"); addRow.append(ui.add); addRow.hidden = !servicePlans();
    ui.pagination = node("div", "takeoff-register-controls"); ui.inspector = node("aside", "takeoff-inspector takeoff-physical-inspector"); ui.inspector.setAttribute("aria-label", "Item Details"); ui.gallery = node("section", "takeoff-physical-gallery"); ui.gallery.setAttribute("aria-label", "Retained image gallery"); ui.root.append(ui.table, addRow, ui.pagination); if (bridge.inspectorContainer) bridge.inspectorContainer.append(ui.inspector); else ui.root.append(ui.inspector); ui.root.append(ui.gallery); container.replaceChildren(ui.root); renderData(); renderGallery(); void safe(loadFieldOptions);
    function imageInventorySummary(images) { const count = images.filter(image => !image.coverage_only).length; return `${count} retained image occurrences; ${images.length - count} source coverage records. Image count is not physical quantity.`; }
    async function refreshImagesAfterExtraction() { await refreshImages(true); }
    return { render, select: selectEntity, selectDrawing, clearSelection, create, createFromSelection, setMarker, setAnnotation, deleteDrawing, copyDrawing, pasteDrawing, selectedBarrier, selection: () => [...state.selected], inspectedId: () => inspectedEntry()?.entity.id || null, summary, hover, completePendingEdits, isAutoApplying: () => state.autoRoutine, editRevision: () => state.editRevision, hasUnfinishedChanges: () => !state.destroyed && (state.busy || state.pending.size > 0), destroy() { state.destroyed = true; state.busy = false; cancelAutomatic(); documents.destroy(); inspectorMenu?.destroy(); state.filterDialog?.close("cancel"); ++state.imageGeneration; container.replaceChildren(); if (bridge.inspectorContainer) ui.inspector.remove(); state.pending.clear(); changed(); } };
  }

  const api = { mount, confirmationOwner, effectiveConfirmation, indexGraph, hierarchyRows, hierarchyPage, columnValue, fieldValue, fieldsFromValues, changedFields, bulkCommands, deletionPlan, formatDimensions, parseDimensions, imageEvidence, previewText, commandText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CeasefireTakeoffPhysical = api;
})(globalThis);
