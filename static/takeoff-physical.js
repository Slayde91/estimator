"use strict";

// Manual physical assertions remain a draft. This component does not confirm,
// lock, derive quantities from images, or write directly to project state.
((root) => {
  const kinds = ["defect", "barrier", "service"];
  const legacyKinds = ["barrier", "defect", "opening", "service"];
  const collections = { barrier: "barriers", defect: "defects", opening: "openings", service: "services" };
  const parents = { barrier: ["defect", "defect_id"], service: ["barrier", "barrier_id"] };
  const legacyParents = { defect: ["barrier", "barrier_id"], opening: ["defect", "defect_id"], service: ["opening", "opening_id"] };
  const titles = { barrier: "Barrier", defect: "Defect", opening: "Opening", service: "Service" };
  const dimensions = new Set(["thickness_mm", "width_mm", "height_mm", "diameter_mm", "depth_mm", "insulation_mm"]);
  const uncertainty = [
    ["not_assessed", "Not assessed"], ["unresolved", "Unresolved"], ["missing", "Missing evidence"],
    ["conflicting", "Conflicting evidence"], ["insufficient_evidence", "Insufficient evidence"],
    ["human_review_required", "Needs review"], ["none_reported", "No uncertainty reported (unapproved draft)"],
  ];
  const definitions = {
    barrier: [["location", "Location"], ["barrier_type", "Barrier type", ["Empty Opening", "Core hole", "Oversized"].map(value => [value, value])], ["substrate", "Substrate"], ["orientation", "Substrate orientation"], ["notes", "Notes", "textarea"]],
    defect: [["label", "Defect Ref."], ["location", "Location"], ["frl", "FRL"], ["notes", "Notes", "textarea"]],
    service: [["service", "Category"], ["service_type", "Service type"], ["size", "Service Size (mm)"], ["width_height_mm", "Width x Height (mm)"], ["diameter_mm", "Overall Diameter (mm)", "number"], ["insulation_mm", "Insulation (mm)", "number"], ["notes", "Notes", "textarea"]],
  };
  const sharedOptionKeys = new Set(["substrate", "orientation", "service", "service_type", "frl"]);
  const retainedDefinitions = { barrier: [["label", "Barrier label"], ["thickness_mm", "Thickness (mm)"]], service: [["label", "Service label"]] };
  // Original four-level records remain readable, without editable opening fields.
  const legacyOpeningFields = [["label", "Opening label"], ["opening_type", "Opening type"], ["size", "Opening size / source designation"], ["shape", "Opening shape"], ["width_mm", "Width (mm)"], ["height_mm", "Height (mm)"], ["diameter_mm", "Diameter (mm)"], ["depth_mm", "Depth (mm)"], ["notes", "Notes"]];
  const copy = value => JSON.parse(JSON.stringify(value));
  const displayId = entry => entry?.entity.display_id || entry?.entity.id || "";
  const entityName = entry => entry.entity.fields.label || displayId(entry);
  const parentId = entry => { const relation = (entry.legacy ? legacyParents : parents)[entry.kind]; return relation ? entry.entity[relation[1]] : null; };
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
  const evidenceFields = key => key === "width_height_mm" ? ["width_mm", "height_mm"] : [key];

  function indexGraph(graph) {
    const index = new Map();
    const legacy = graph?.version === 1;
    for (const kind of legacy ? legacyKinds : kinds) for (const entity of graph?.[collections[kind]] || []) index.set(entity.id, { kind, entity, legacy });
    return index;
  }
  function ancestors(entry, index) {
    const result = []; let current = entry;
    for (let depth = 0; current && depth < 4; depth++) {
      const parent = index.get(parentId(current)); if (!parent) break; result.unshift(parent); current = parent;
    }
    return result;
  }
  function hierarchyRows(graph, { filter = "", collapsed = new Set(), showDeleted = false } = {}) {
    const index = indexGraph(graph), included = new Set(), matching = new Set(), query = filter.toLocaleLowerCase().trim();
    for (const [id, entry] of index) {
      if (entry.entity.deleted && !showDeleted) continue;
      const searchable = [entry.kind, id, entry.entity.display_id, ...Object.values(entry.entity.fields), entry.entity.uncertainty?.state, entry.entity.uncertainty?.note].join(" ").toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
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
      if (query || !collapsed.has(entry.entity.id)) for (const child of children.get(entry.entity.id) || []) visit(child, depth + 1);
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
  function fieldValue(kind, key, value) {
    if (key === "quantity") {
      const number = value === "" || value == null ? NaN : Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || number > 1e12) throw new Error("Every service needs an explicit positive whole quantity.");
      return number;
    }
    if (!definitions[kind]?.some(definition => definition[0] === key)) throw new Error("Choose a field belonging to this entity type.");
    if (key === "width_height_mm") return parseDimensions(value);
    if (value === "" || value == null) return undefined;
    if (dimensions.has(key)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number > 1e12 || number < 0 || number === 0 && key !== "insulation_mm") throw new Error("Known dimensions must be positive finite numbers. Clear an unknown dimension instead of entering zero.");
      return number;
    }
    const text = String(value).trim(); if (text.length > 2000) throw new Error("Physical text fields support at most 2,000 characters.");
    return text || undefined;
  }
  function changedFields(entry, key, value) {
    const parsed = fieldValue(entry.kind, key, value);
    if (key === "quantity") return { quantity: parsed };
    const fields = { ...entry.entity.fields };
    if (key === "width_height_mm") { delete fields.width_mm; delete fields.height_mm; Object.assign(fields, parsed); }
    else if (parsed === undefined) delete fields[key]; else fields[key] = parsed;
    return { fields };
  }
  function fieldsFromValues(kind, values, retainedFields = {}) {
    const result = copy(retainedFields);
    for (const [key] of definitions[kind]) {
      if (key === "width_height_mm") {
        if (!Object.hasOwn(values, key) || String(values[key] ?? "") === formatDimensions(retainedFields)) continue;
        const dimensions = parseDimensions(values[key]); delete result.width_mm; delete result.height_mm; Object.assign(result, dimensions); continue;
      }
      if (Object.hasOwn(retainedFields, key) && String(values[key] ?? "") === String(retainedFields[key] ?? "")) continue;
      const value = fieldValue(kind, key, values[key]); if (value === undefined) delete result[key]; else result[key] = value;
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
            const label = definitions[entry.kind].find(definition => definition[0] === field)?.[1] || field;
            lines.push(`${label}: ${entry.entity.fields[field] ?? "unknown"} → ${next[field] ?? "unknown"}`);
          }
          else if (key === "evidence") lines.push(`Source associations: ${entry.entity.evidence.length} → ${next.length}; exact retained locators are bound to this preview.`);
          else if (key === "uncertainty") lines.push(`Uncertainty: ${entry.entity.uncertainty.state} → ${next.state}\nExplanation: ${next.note || "none recorded"}`);
          else lines.push(`${key}: ${entry.entity[key] ?? "unknown"} → ${next}`);
        }
        return `${title}\n${lines.join("\n")}`;
      }
      if (command.op === "create") return `${title}\n${Object.entries(entity.fields).map(([field, value]) => `${definitions[command.kind].find(definition => definition[0] === field)?.[1] || field}: ${value}`).join("\n")}${command.kind === "service" ? `\nExplicit service quantity: ${entity.quantity}` : ""}\nUncertainty: ${entity.uncertainty.state}`;
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
    const state = { snapshot: null, index: new Map(), selected: new Set(), collapsed: new Set(), filter: "", offset: 0, showDeleted: false, busy: false, destroyed: false, editRevision: 0, pending: new Map(), pendingApply: new WeakMap(), inspectorEdit: null, fieldOptions: null, fieldOptionsPromise: null, images: [], extractionId: "", imageOffset: 0, imageGeneration: 0, imageInventoryKey: "", imageState: "Not loaded", imageFailures: new Set() };
    const ui = {};
    const changed = () => bridge.changed?.();
    const graph = () => state.snapshot?.physical || null;
    const legacyReadOnly = () => graph()?.version === 1;
    function ensureEditable() { if (legacyReadOnly()) throw new Error("This legacy hierarchy is read-only until its relationships are assigned. Its original records and evidence remain available for inspection and export."); }
    const graphKey = () => `${state.snapshot?.project_id || ""}/${graph()?.id || "new"}/${graph()?.revision ?? -1}`;
    const node = (tag, className = "", text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
    const choice = (value, label = value) => { const element = node("option", "", label); element.value = value; return element; };
    function report(error) { bridge.notify(error.message || String(error), true); }
    async function safe(action) { try { await action(); } catch (error) { if (!state.destroyed) report(error); } }
    function button(label, action, className = "button secondary") { const control = node("button", className, label); control.type = "button"; control.addEventListener("click", () => void safe(action)); return control; }
    function mutationButton(label, action, className) { const control = button(label, () => { ensureEditable(); return action(); }, className); control.dataset.physicalMutation = "true"; control.disabled = state.busy || legacyReadOnly(); return control; }
    function setBusy(value) { state.busy = value; ui.root.setAttribute("aria-busy", String(value)); for (const control of ui.root.querySelectorAll("button,input,select,textarea")) control.disabled = value || control.dataset.locked === "true" || legacyReadOnly() && control.dataset.physicalMutation === "true"; changed(); }
    function ensureAvailable(allowPending = false) { if (state.destroyed) throw new Error("The physical workspace was closed."); if (state.busy) throw new Error("Finish the current physical edit first."); if (!allowPending && state.pending.size) throw new Error("Apply or discard unfinished physical field edits first."); }
    function requireCurrent(entry) { const current = state.index.get(entry.entity.id); if (!current || current.kind !== entry.kind || current.entity.revision !== entry.entity.revision || current.entity.deleted !== entry.entity.deleted) throw new Error("This physical record changed. Discard the unfinished form and inspect the current draft."); }
    function selectEntries() { return [...state.selected].map(id => state.index.get(id)).filter(Boolean); }
    function matchingActiveRows() { return hierarchyRows(graph(), { ...state, collapsed: new Set() }).filter(row => !row.context && !row.entity.deleted); }
    function descendants(entry) { const found = []; for (const candidate of state.index.values()) if (ancestors(candidate, state.index).some(parent => parent.entity.id === entry.entity.id)) found.push(candidate); return found; }
    function resetPending() { for (const [control, original] of state.pending) control.value = original; state.pending.clear(); changed(); }
    function track(control, original) { control.addEventListener("input", () => { state.editRevision++; control.value === String(original ?? "") ? state.pending.delete(control) : state.pending.set(control, String(original ?? "")); changed(); }); }
    function displayReply(reply) { const value = reply?.snapshot || (reply?.documents && "physical" in reply ? reply : null); if (value) render(value); }
    function fieldType(kind, key) {
      if (sharedOptionKeys.has(key)) return (state.fieldOptions?.[key] || []).map(value => [value, value]);
      const type = key === "quantity" ? "number" : definitions[kind].find(definition => definition[0] === key)?.[2] || "text";
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
          for (const control of ui.root.querySelectorAll("[data-physical-options]")) {
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
    async function perform(commands, title, allowPending = false) {
      ensureEditable(); ensureAvailable(allowPending); const key = graphKey(); setBusy(true);
      try {
        const preview = await bridge.preview(commands);
        if (state.destroyed || graphKey() !== key) throw new Error("The physical draft changed before review. Preview the edit again.");
        previewText(preview, state.index);
        if (!await reviewPreview(title, preview, commands)) return false;
        if (state.destroyed || graphKey() !== key) throw new Error("The physical draft changed during review. Preview the edit again.");
        const reply = await bridge.apply(preview.preview_id); resetPending(); if (!state.destroyed) { displayReply(reply); bridge.notify("Draft physical change applied. The physical model remains unapproved.", false); }
        return true;
      } finally { if (!state.destroyed) { setBusy(false); if (!state.pending.size) renderData(); } }
    }
    async function ask(title, fields, explanation, submit) {
      ensureAvailable(); const key = graphKey(); setBusy(true);
      try { const answer = await bridge.ask(title, fields, explanation, submit); if (answer && (state.destroyed || graphKey() !== key)) throw new Error("The physical draft changed while this form was open. Repeat the edit."); return answer; }
      finally { if (!state.destroyed) setBusy(false); }
    }
    function fieldDefinitions(entry, createKind) {
      const kind = entry?.kind || createKind, entity = entry?.entity;
      return [...definitions[kind].flatMap(([key, label]) => [[key, label, fieldType(kind, key), fieldDisplay(entity?.fields, key) ?? ""], ...(kind === "service" && key === "service_type" ? [["quantity", "Explicit service quantity", "number", entity?.quantity ?? "", true]] : [])]), ["uncertainty_state", "Uncertainty / review state", uncertainty, entity?.uncertainty.state || "not_assessed", true], ["uncertainty_note", "Uncertainty explanation", "textarea", entity?.uncertainty.note || ""]];
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
    async function create(kind, chosenParent) {
      ensureEditable(); ensureAvailable(); await ensureFieldOptions(kind); ensureAvailable(); let parent = chosenParent;
      if (parents[kind]) {
        const parentKind = parents[kind][0], selected = selectEntries();
        if (!parent && selected.length === 1 && selected[0].kind === parentKind && !selected[0].entity.deleted) parent = selected[0].entity.id;
        if (!parent) parent = await chooseEntity(parentKind, `Choose parent ${parentKind}`, [...state.index.values()].filter(entry => entry.kind === parentKind && !entry.entity.deleted));
        if (!parent) return;
        const entry = state.index.get(parent); if (!entry || entry.kind !== parentKind || entry.entity.deleted) throw new Error("The selected physical parent is unavailable.");
      }
      const answer = await ask(`Create draft ${kind}`, fieldDefinitions(null, kind), `${draftWarning}${parent ? `\n\nParent ID: ${displayId(state.index.get(parent))}` : ""}\n\nUnknown properties stay blank. Link retained source evidence after creating the draft.`, "Preview new draft");
      if (!answer) return;
      const entity = { id: root.crypto.randomUUID(), fields: fieldsFromValues(kind, answer), evidence: [], uncertainty: { state: answer.uncertainty_state, note: answer.uncertainty_note || "" }, ...(parent ? { [parents[kind][1]]: parent } : {}), ...(kind === "service" ? { quantity: fieldValue(kind, "quantity", answer.quantity) } : {}) };
      if (await perform([{ op: "create", kind, entity }], `Create one draft ${kind}?`)) selectEntity(entity.id);
    }
    function selectEntity(id, multiple = false, focus = !multiple) {
      ensureAvailable(); const entry = state.index.get(id); if (!entry) return;
      if (!multiple) state.selected.clear(); if (multiple && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      for (const parent of ancestors(entry, state.index)) state.collapsed.delete(parent.entity.id);
      const rows = hierarchyRows(graph(), state); state.offset = Math.floor(Math.max(0, rows.findIndex(row => row.entity.id === id)) / 100) * 100; renderData();
      return bridge.selection?.([...state.selected], entry.entity.evidence[0] || null, focus);
    }
    async function editField(entry, key, control, preservePending = false) {
      ensureAvailable(true); requireCurrent(entry);
      if ([...state.pending.keys()].some(pending => pending !== control)) {
        control.value = state.pending.get(control) ?? control.value; state.pending.delete(control); changed();
        throw new Error("Apply or discard the other unfinished physical field edits before changing a table cell. Those edits have been preserved.");
      }
      let applied = false;
      try { const batch = bulkCommands([entry], key, control.value); applied = !batch.commands.length || await perform(batch.commands, `Change ${titles[entry.kind].toLowerCase()} ${key}?`, true); if (preservePending && !applied) throw new Error("Save stopped because the physical edit review was cancelled. Your unfinished input is preserved."); }
      finally { if (!preservePending || applied) state.pending.delete(control); changed(); if (!state.destroyed && !state.pending.size) renderData(); }
    }
    async function bulkEdit() {
      ensureAvailable(); const selected = selectEntries();
      if (!selected.length || selected.some(entry => entry.entity.deleted) || selected.some(entry => entry.kind !== selected[0].kind)) throw new Error("Select active records of one entity type for a bulk edit.");
      if (selected.length > 100) throw new Error("A bulk operation supports at most 100 selected records. No changes have been applied.");
      const kind = selected[0].kind; await ensureFieldOptions(kind); selected.forEach(requireCurrent);
      const options = fieldDefinitions(null, kind).filter(([key]) => !key.startsWith("uncertainty_")).map(([key, label]) => [key, label]);
      const selectedField = await ask(`Choose field for ${selected.length} draft records`, [["field", "Field to change", options, "", true]], "Choose the one property to change across the selected records.", "Continue");
      if (!selectedField) return;
      const definition = options.find(([key]) => key === selectedField.field); if (!definition) throw new Error("Choose a field belonging to this entity type.");
      const type = fieldType(kind, selectedField.field);
      if (Array.isArray(type)) for (const entry of selected) { const value = entry.entity.fields[selectedField.field]; if (value && !type.some(([key]) => key === value)) type.push([value, `${value} (retained)`]); }
      const answer = await ask(`Edit ${selected.length} draft ${kind} records`, [["value", definition[1], type, "", selectedField.field === "quantity"]], `All ${selected.length} selected IDs will be included, even when filtered out. Other properties and every parent link remain unchanged. Blank clears an optional property. Service quantities cannot be blank or zero. One applied batch can be undone together.`, "Preview bulk edit");
      if (!answer) return; selected.forEach(requireCurrent);
      const batch = bulkCommands(selected, selectedField.field, answer.value);
      if (!batch.commands.length) { bridge.notify(`All ${selected.length} selected records already have this value. No physical changes were applied.`, false); return; }
      await perform(batch.commands, `Change ${batch.commands.length} of ${selected.length} selected records? ${batch.unchanged.length} already match and stay unchanged.`);
    }
    async function reparent(entry) {
      ensureAvailable(); requireCurrent(entry); const [kind] = parents[entry.kind] || [];
      if (!kind) throw new Error("Defects have no physical parent.");
      const parent = await chooseEntity(kind, `Change ${entry.kind} parent`, [...state.index.values()].filter(candidate => candidate.kind === kind && !candidate.entity.deleted && candidate.entity.id !== parentId(entry)));
      if (parent) { requireCurrent(entry); await perform([{ op: "reparent", entity_id: entry.entity.id, parent_id: parent }], "Review parent and descendant relationships"); }
    }
    async function deleteEntity(entry) {
      ensureAvailable(); requireCurrent(entry); const active = descendants(entry).filter(child => !child.entity.deleted);
      const answer = await ask(`Delete draft ${entry.kind}`, [["scope", "Deletion scope", [["only", "Only this entity (requires no active descendants)"], ["cascade", `This entity and ${active.length} active descendants`]], "", true]], `ID: ${displayId(entry)}\n${active.length} active descendants are linked below this entity. Reparent them first or explicitly include them. Tombstones and original identities are retained.`, "Preview deletion");
      if (answer) { requireCurrent(entry); await perform([{ op: "delete", entity_id: entry.entity.id, cascade: answer.scope === "cascade" }], "Review recoverable deletion"); }
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
    function evidenceFieldOptions(kind) { return [["", "Whole entity"], ...definitions[kind].map(([key, label]) => [key, label]), ...(kind === "service" ? [["quantity", "Service quantity"]] : []), ...(parents[kind] ? [[parents[kind][1], "Physical parent relationship"]] : []), ["uncertainty", "Uncertainty"]]; }
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
      control.setAttribute("aria-label", `${definitions[entry.kind].find(definition => definition[0] === key)?.[1] || "Service quantity"} for ${entityName(entry)}`); control.placeholder = "Unknown"; track(control, value);
      state.pendingApply.set(control, () => editField(entry, key, control, true));
      control.addEventListener("change", () => { if (control.value === String(value ?? "")) return; void safe(() => editField(entry, key, control)); }); cell.append(control); return cell;
    }
    function relationCells(entry) {
      const lineage = [...ancestors(entry, state.index), entry], find = kind => lineage.find(candidate => candidate.kind === kind);
      return { lineage, barrier: find("barrier"), defect: find("defect"), opening: find("opening"), service: find("service") };
    }
    function hover(id) { for (const row of ui.table.querySelectorAll("[data-physical-id]")) row.classList.toggle("hovered", row.dataset.physicalId === id); bridge.hover?.(id); }
    function renderTable() {
      const rows = hierarchyRows(graph(), state); state.offset = Math.max(0, Math.min(state.offset, Math.max(0, Math.floor((rows.length - 1) / 100) * 100)));
      const page = hierarchyPage(rows, state.index, state.offset), table = node("table"), head = node("thead"), header = node("tr"), body = node("tbody"); table.setAttribute("aria-label", "Draft penetration hierarchy register");
      const legacy = legacyReadOnly(), rowKinds = legacy ? legacyKinds : kinds;
      const headings = ["Select", ...(legacy ? ["Legacy hierarchy / label"] : []), ...rowKinds.map(kind => `${titles[kind]} ID`), "State / uncertainty", "Location", "FRL", ...(legacy ? ["Opening type", "Opening size"] : []), "Substrate", "Orientation", "Category", "Service type", "Service quantity", "Service Size (mm)", "Source evidence"];
      for (const label of headings) {
        const cell = node("th", "", label);
        if (label === "Select") {
          const matches = matchingActiveRows(), selected = matches.filter(row => state.selected.has(row.entity.id)).length, selectAll = node("input");
          selectAll.type = "checkbox"; selectAll.checked = !!matches.length && selected === matches.length; selectAll.indeterminate = selected > 0 && selected < matches.length;
          selectAll.dataset.locked = String(!matches.length); selectAll.disabled = state.busy || !matches.length;
          selectAll.setAttribute("aria-label", "Select all matching physical records"); selectAll.title = `Select all ${matches.length} matching active records across register pages`;
          selectAll.addEventListener("change", () => void safe(() => { try { ensureAvailable(); } catch (error) { selectAll.checked = !!matches.length && selected === matches.length; throw error; } for (const row of matches) selectAll.checked ? state.selected.add(row.entity.id) : state.selected.delete(row.entity.id); renderData(); })); cell.append(selectAll);
        }
        header.append(cell);
      }
      head.append(header); table.append(head, body);
      function disclosure(row) { const collapsed = state.collapsed.has(row.entity.id), control = button(collapsed ? ">" : "<", () => { ensureAvailable(); state.collapsed.has(row.entity.id) ? state.collapsed.delete(row.entity.id) : state.collapsed.add(row.entity.id); renderTable(); }, "text-button takeoff-physical-disclosure"); control.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${displayId(row)}`); control.setAttribute("aria-expanded", String(!collapsed)); return control; }
      function contextNote(row, cell) { if (row.context) cell.append(node("small", "helper", row.continued ? " Parent context (continued)" : " Ancestor context")); }
      for (const row of page) {
        const { entity, kind } = row, line = node("tr", state.selected.has(entity.id) ? "selected" : ""); line.dataset.physicalId = entity.id; line.dataset.physicalKind = kind; line.addEventListener("pointerenter", () => hover(entity.id)); line.addEventListener("pointerleave", () => hover(null));
        const checkbox = node("input"), selectCell = node("td"); checkbox.type = "checkbox"; checkbox.checked = state.selected.has(entity.id); checkbox.setAttribute("aria-label", `Select ${titles[kind]} ${entityName(row)}`); checkbox.addEventListener("change", () => void safe(() => selectEntity(entity.id, true))); selectCell.append(checkbox); line.append(selectCell);
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
            if (kind === "barrier" && ![...state.index.values()].some(candidate => candidate.kind === "service" && parentId(candidate) === entity.id && !candidate.entity.deleted)) cell.append(node("small", "helper", "0 services"));
          }
          const childKind = !legacy && !entity.deleted && (kind === "defect" && relationKind === "barrier" ? "barrier" : kind === "barrier" && relationKind === "service" ? "service" : null);
          if (childKind) {
            const add = mutationButton("+", () => create(childKind, entity.id), "button secondary takeoff-physical-add-child"), label = `Add ${childKind} to ${displayId(row)}`;
            add.setAttribute("aria-label", label); add.title = label; cell.replaceChildren(add);
          }
          line.append(cell);
        }
        const status = node("td"); status.append(node("span", `takeoff-state ${entity.deleted ? "blocked" : "draft"}`, entity.deleted ? "Deleted draft" : legacy ? "Legacy read-only" : "Unapproved draft"), node("p", "helper", uncertainty.find(([key]) => key === entity.uncertainty.state)?.[1] || "Not assessed")); line.append(status);
        const inheritedLocation = legacy ? relation.defect?.entity.fields.location ?? relation.barrier?.entity.fields.location : relation.barrier?.entity.fields.location ?? relation.defect?.entity.fields.location;
        const location = kind === "barrier" || kind === "defect" ? editableCell(row, "location") : textCell(inheritedLocation, "Inherited parent location.");
        line.append(location, kind === "defect" ? editableCell(row, "frl") : textCell(relation.defect?.entity.fields.frl, "Recorded defect FRL; not a technical approval."));
        if (legacy) line.append(textCell(relation.opening?.entity.fields.opening_type), textCell(relation.opening?.entity.fields.size));
        line.append(kind === "barrier" ? editableCell(row, "substrate") : textCell(relation.barrier?.entity.fields.substrate), kind === "barrier" ? editableCell(row, "orientation") : textCell(relation.barrier?.entity.fields.orientation));
        for (const field of ["service", "service_type", "quantity", "size"]) line.append(kind === "service" ? editableCell(row, field) : textCell(null, "Only a service record has this property."));
        const evidence = node("td"); evidence.append(node("span", "helper", `${entity.evidence.length} source associations`)); if (entity.evidence[0]) evidence.append(button("Open source", () => bridge.source(copy(entity.evidence[0])), "text-button")); line.append(evidence); body.append(line);
      }
      ui.table.replaceChildren(table); if (!rows.length) ui.table.append(node("p", "takeoff-register-empty", graph() ? "No matching physical records. Adjust the filter or create an explicitly linked draft record." : "Create a defect to begin the physical hierarchy. Uploaded images never create physical records automatically."));
      ui.pagination.replaceChildren(button("Previous 100 records", () => { ensureAvailable(); state.offset = Math.max(0, state.offset - 100); renderTable(); }), node("span", "helper", `${rows.length ? state.offset + 1 : 0}–${Math.min(state.offset + 100, rows.length)} of ${rows.length} visible hierarchy records. Ancestor context may repeat across pages.`), button("Next 100 records", () => { ensureAvailable(); if (state.offset + 100 < rows.length) state.offset += 100; renderTable(); }));
      bridge.viewChanged?.(rows.map(row => row.entity.id), [...state.selected]);
    }
    function renderInspector() {
      state.inspectorEdit = null;
      ui.inspector.replaceChildren(node("h3", "", "PHYSICAL DRAFT INSPECTOR")); const selected = selectEntries(); ui.selection.textContent = `${selected.length} selected`;
      if (selected.length !== 1) { ui.inspector.append(node("p", "helper", selected.length ? "Select active records of one entity type for a counted, reversible bulk edit." : "Select a hierarchy row to inspect its parent, evidence and uncertainty.")); return; }
      const entry = selected[0], entity = entry.entity, editorKey = graphKey(); ui.inspector.append(node("p", "takeoff-identity", displayId(entry)), node("p", "helper", `${titles[entry.kind]} · Revision ${entity.revision} · ${entity.deleted ? "Deleted draft" : "Unapproved draft"}`));
      for (const parent of ancestors(entry, state.index)) ui.inspector.append(button(`${titles[parent.kind]}: ${entityName(parent)} · ${displayId(parent)}`, () => selectEntity(parent.entity.id), "text-button"));
      if (legacyReadOnly() || entity.deleted) {
        if (!legacyReadOnly()) ui.inspector.append(mutationButton("Restore draft record", () => restore(entry)), node("p", "helper", "Original fields, evidence and parent IDs are retained. Restore previews disclose descendants and do not invent missing parents."));
        for (const [key, label] of (entry.kind === "opening" ? legacyOpeningFields : [...(retainedDefinitions[entry.kind] || []), ...definitions[entry.kind]])) ui.inspector.append(node("p", "helper", `${label}: ${fieldDisplay(entity.fields, key) ?? "Unknown"}`));
        if (entry.kind === "service") ui.inspector.append(node("p", "helper", `Explicit service quantity: ${entity.quantity}`));
        ui.inspector.append(node("p", "helper", `Uncertainty: ${entity.uncertainty.state} · ${entity.uncertainty.note || "No explanation recorded"}`)); renderAssociations(entry); return;
      }
      const controls = fieldDefinitions(entry).map(([key, label, type, initial, required]) => {
        const wrapper = node("label", "field"), control = node(Array.isArray(type) ? "select" : type === "textarea" ? "textarea" : "input"); wrapper.append(node("span", "", label));
        if (Array.isArray(type)) { populateSelect(control, type, initial); if (sharedOptionKeys.has(key)) bindSharedOptions(control, key); } else if (type !== "textarea") control.type = type === "number" ? "number" : "text";
        control.value = initial ?? ""; control.name = key; control.required = !!required; if (type === "number") control.step = key === "quantity" ? "1" : "any"; control.setAttribute("aria-label", label); track(control, initial); wrapper.append(control); ui.inspector.append(wrapper); return control;
      });
      const submit = async () => { ensureAvailable(true); await ensureFieldOptions(entry.kind, true); ensureAvailable(true); if (editorKey !== graphKey()) throw new Error("The physical draft changed before the unfinished edits could be reviewed. Inspect the current record and try again."); requireCurrent(entry); const values = Object.fromEntries(controls.map(control => [control.name, control.value])); const changes = { fields: fieldsFromValues(entry.kind, values, entity.fields), uncertainty: { state: values.uncertainty_state, note: values.uncertainty_note }, ...(entry.kind === "service" ? { quantity: fieldValue(entry.kind, "quantity", values.quantity) } : {}) }; if (Object.entries(changes).every(([key, value]) => sameValue(entity[key], value))) { resetPending(); renderData(); bridge.notify("No physical values changed.", false); return true; } return perform([{ op: "update", entity_id: entity.id, changes }], "Review physical field changes", true); };
      state.inspectorEdit = { controls, submit };
      ui.inspector.append(button("Preview physical edits", submit, "button primary"));
      if (parents[entry.kind]) ui.inspector.append(button("Change physical parent", () => reparent(entry)));
      ui.inspector.append(button("Link original source page", () => linkDocument(entry)), button("Delete draft record", () => deleteEntity(entry)));
      renderAssociations(entry);
    }
    function renderAssociations(entry) {
      const entity = entry.entity;
      ui.inspector.append(node("h3", "", "SOURCE ASSOCIATIONS"));
      for (const [position, evidence] of entity.evidence.entries()) {
        const card = node("div", "takeoff-exclusion"), doc = state.snapshot.documents.find(value => value.id === evidence.document_id);
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
        const source = state.snapshot.documents.find(doc => doc.id === extraction.document_id), pages = extraction.pages || [];
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
    function renderData() { if (state.destroyed) return; renderTable(); renderInspector(); ui.readOnlyNotice.hidden = !legacyReadOnly(); ui.status.textContent = `Physical revision ${graph()?.revision ?? 0} · ${state.index.size} retained identities · ${legacyReadOnly() ? "Legacy read-only" : "Unapproved draft"}`; setBusy(state.busy); }
    function render(snapshot) {
      if (state.destroyed) return; const oldKey = graphKey(), oldProject = state.snapshot?.project_id; state.snapshot = snapshot; state.index = indexGraph(snapshot?.physical); state.selected = new Set([...state.selected].filter(id => state.index.has(id)));
      const context = bridge.imageContext?.() || {}, descriptors = snapshot?.image_extractions || [];
      const inventoryKey = `${snapshot?.project_id || ""}/${context.document_id || ""}/${context.page || ""}/${JSON.stringify(descriptors)}`;
      if (oldProject !== snapshot?.project_id) { ++state.imageGeneration; state.selected.clear(); state.collapsed.clear(); state.offset = 0; state.images = []; state.imageFailures.clear(); state.imageOffset = 0; state.imageState = "Not loaded"; resetPending(); }
      if (state.imageInventoryKey !== inventoryKey) { state.imageInventoryKey = inventoryKey; const newest = [...descriptors].reverse(); state.extractionId = (newest.find(value => value.document_id === context.document_id && value.pages?.includes(context.page)) || newest[0])?.id || ""; state.images = []; state.imageOffset = 0; void refreshImages(true); }
      if (state.pending.size && !state.busy && oldKey !== graphKey()) { bridge.notify("The physical draft changed while fields were unfinished. Applying will recheck the record revision; discard unfinished edits to show the current draft.", true); return; }
      if (!state.pending.size) renderData();
    }
    async function runBridge(action, confirmation) {
      ensureAvailable(); if (confirmation && !await ask(confirmation.title, [], confirmation.text, confirmation.button)) return; setBusy(true);
      try { const reply = await action(); if (!state.destroyed) displayReply(reply); }
      finally { if (!state.destroyed) { setBusy(false); renderData(); } }
    }
    async function completePendingEdits() {
      ensureAvailable(true); if (!state.pending.size) return;
      const pending = [...state.pending.keys()], inspector = state.inspectorEdit;
      if (inspector && pending.every(control => inspector.controls.includes(control))) {
        if (!await inspector.submit()) throw new Error("Save stopped because the physical edit review was cancelled. Your unfinished input is preserved.");
      } else if (pending.length === 1 && state.pendingApply.has(pending[0])) await state.pendingApply.get(pending[0])();
      else throw new Error("Finish the separate physical field edits before saving. Your unfinished input is preserved.");
      if (state.destroyed || state.pending.size) throw new Error("The physical workspace changed before saving. Review the unfinished physical edits and save again.");
    }
    function discardIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle"); circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "9");
      const cross = document.createElementNS("http://www.w3.org/2000/svg", "path"); cross.setAttribute("d", "m9 9 6 6m0-6-6 6"); svg.append(circle, cross); return svg;
    }
    function deleteIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"); svg.append(path); return svg;
    }
    ui.root = node("section", "takeoff-register takeoff-physical-register"); ui.root.setAttribute("aria-label", "Manual draft penetration workspace");
    const heading = node("div", "section-heading"); heading.append(node("h2", "", "PENETRATIONS — PHYSICAL DRAFT")); ui.status = node("span", "status-label"); heading.append(ui.status); ui.root.append(heading, node("p", "takeoff-warning", draftWarning));
    ui.readOnlyNotice = node("p", "takeoff-warning takeoff-physical-legacy-notice", "Legacy hierarchy — read-only until its relationships are assigned. Original records, fields and evidence are preserved for inspection and export."); ui.root.append(ui.readOnlyNotice);
    const tools = node("div", "takeoff-register-controls");
    tools.append(mutationButton("Extract images from selected PDF page", () => runBridge(async () => { const reply = await bridge.extract(); displayReply(reply); await refreshImagesAfterExtraction(); return reply; })), button("Refresh retained images", refreshImages));
    for (const format of ["csv", "xlsx"]) tools.append(button(`Export draft ${format.toUpperCase()}`, () => runBridge(() => bridge.export(format), { title: "Export unapproved physical draft?", text: "The export is explicitly UNAPPROVED DRAFT and retains every parent/child ID. It does not represent approved quantities, a Physical Model Lock, technical suitability or commercial authority.", button: "Export unapproved draft" })));
    ui.root.append(tools); const filters = node("div", "takeoff-register-controls"), search = node("input"); search.type = "search"; search.placeholder = "Filter physical records…"; search.setAttribute("aria-label", "Filter physical hierarchy"); search.addEventListener("input", () => { if (state.pending.size || state.busy) return; state.filter = search.value; state.offset = 0; renderTable(); });
    const deleted = node("label", "takeoff-check"), show = node("input"); show.type = "checkbox"; show.addEventListener("change", () => void safe(() => { ensureAvailable(); state.showDeleted = show.checked; state.offset = 0; renderTable(); })); deleted.append(show, node("span", "", "Show deleted records"));
    const discard = button("Discard unfinished physical edits", () => { if (state.busy) throw new Error("Finish the current review first."); resetPending(); renderData(); bridge.notify("Unfinished physical field edits discarded. Recorded draft values are unchanged.", false); }, "button secondary takeoff-physical-discard"); discard.setAttribute("aria-label", "Discard unfinished physical edits"); discard.title = "Discard unfinished physical edits"; discard.replaceChildren(discardIcon());
    const deleteSelection = mutationButton("Delete selected records", deleteSelected, "button secondary takeoff-physical-delete-selected"); deleteSelection.setAttribute("aria-label", "Delete selected records"); deleteSelection.title = "Delete selected records"; deleteSelection.replaceChildren(deleteIcon());
    ui.selection = node("strong"); filters.append(search, deleted, ui.selection, button("Select filtered records", () => { ensureAvailable(); for (const row of matchingActiveRows()) state.selected.add(row.entity.id); renderData(); }), button("Clear physical selection", () => { ensureAvailable(); state.selected.clear(); renderData(); }), mutationButton("Bulk edit same-type records", bulkEdit), deleteSelection, discard); ui.root.append(filters);
    ui.table = node("div", "takeoff-register-table"); const addRow = node("div", "takeoff-physical-add-row"), addDefect = mutationButton("+", () => create("defect"), "button secondary takeoff-physical-add-child takeoff-physical-add-defect"); addDefect.setAttribute("aria-label", "Add defect"); addDefect.title = "Add defect"; addRow.append(addDefect);
    ui.pagination = node("div", "takeoff-register-controls"); ui.inspector = node("aside", "takeoff-inspector takeoff-physical-inspector"); ui.inspector.setAttribute("aria-label", "Physical draft inspector"); ui.gallery = node("section", "takeoff-physical-gallery"); ui.gallery.setAttribute("aria-label", "Retained image gallery"); ui.root.append(ui.table, addRow, ui.pagination, ui.inspector, ui.gallery); container.replaceChildren(ui.root); renderData(); renderGallery(); void safe(loadFieldOptions);
    function imageInventorySummary(images) { const count = images.filter(image => !image.coverage_only).length; return `${count} retained image occurrences; ${images.length - count} source coverage records. Image count is not physical quantity.`; }
    async function refreshImagesAfterExtraction() { await refreshImages(true); }
    return { render, select: selectEntity, hover, completePendingEdits, editRevision: () => state.editRevision, hasUnfinishedChanges: () => !state.destroyed && (state.busy || state.pending.size > 0), destroy() { state.destroyed = true; state.busy = false; ++state.imageGeneration; container.replaceChildren(); state.pending.clear(); changed(); } };
  }

  const api = { mount, indexGraph, hierarchyRows, hierarchyPage, fieldValue, fieldsFromValues, changedFields, bulkCommands, deletionPlan, formatDimensions, parseDimensions, imageEvidence, previewText, commandText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CeasefireTakeoffPhysical = api;
})(globalThis);
