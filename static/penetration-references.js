"use strict";

((root) => {
  const validId = value => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(value);
  const maximum = 128;
  const labels = { report: "Report", document: "Report", category: "Category", services: "Service Type", type: "Penetration Type", orientation: "Orientation", substrate: "Substrate", frl: "FRL", manufacturer: "Manufacturer" };
  const text = value => value == null ? "" : String(value);
  const displayTitle = item => root.LibraryDetailText?.displayTitle(item) || item.title || item.id;
  const displaySubtitle = item => root.LibraryDetailText?.displaySubtitle(item) ?? item.subtitle;
  let reportOptionsRequest;
  async function reportOptions() {
    if (!reportOptionsRequest) {
      reportOptionsRequest = (async () => {
        const response = await root.fetch("/api/libraries/technical?limit=1", { headers: { Accept: "application/json" } });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "Technical records unavailable.");
        const filters = data.filters || [];
        return filters.find(item => item.key === "report") || filters.find(item => item.key === "document") || { key: "report", options: [] };
      })().finally(() => { reportOptionsRequest = null; });
    }
    return reportOptionsRequest;
  }
  function appendReportOptions(control, definition) {
    root.CeasefireLibraries.appendFilterOptions(control, definition.options, definition.key || "report");
  }
  function node(document, tag, className, value) {
    const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = text(value); return result;
  }
  function ui(element, source, args = []) {
    if (root.CeasefireI18n?.text) return root.CeasefireI18n.text(element, source, args);
    element.textContent = source.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ""); return element;
  }
  function uiAttr(element, attribute, source, args = []) {
    if (root.CeasefireI18n?.attr) return root.CeasefireI18n.attr(element, attribute, source, args);
    element.setAttribute(attribute, source.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? "")); return element;
  }
  function validateIds(values) {
    if (!Array.isArray(values) || values.length > maximum || values.some(value => !validId(value)) || new Set(values).size !== values.length) throw new Error("Choose up to 128 different Technical Library records.");
    return [...values];
  }
  function renderSystems(reference, options = {}) {
    const document = options.document || root.document, result = node(document, "span", "register-system-references");
    const systems = (reference?.systems || []).filter(item => validId(item?.id));
    for (const [index, item] of systems.entries()) {
      if (index) result.append(node(document, "span", "", " | "));
      const control = node(document, "button", "text-button", index + 1); control.type = "button";
      control.dataset.technicalReference = item.id; control.title = text(displayTitle(item));
      uiAttr(control, "aria-label", "System {0}: {1}", [index + 1, displayTitle(item)]);
      control.addEventListener("click", async () => {
        if (options.isCurrent && !options.isCurrent()) return;
        try { await root.CeasefireLibraryNavigation?.open("technical", item.id); } catch (error) { options.notify?.(error.message, true); }
      }); result.append(control);
    }
    if (!systems.length) result.textContent = "—";
    return result;
  }
  function filterOptions(definition) {
    return (definition.options || []).map(option => typeof option === "string" ? { value: option, label: option } : option).filter(option => option && typeof option.value === "string").map(option => ({ value: option.value, label: text(option.label || option.value) }));
  }
  function open(options) {
    const document = options.document || root.document;
    const known = new Map((options.reference?.systems || []).filter(item => validId(item?.id)).map(item => [item.id, { id: item.id, title: displayTitle(item) }]));
    const selected = new Map((options.selectedIds || [...known.keys()]).map(id => [id, known.get(id) || { id, title: id }]));
    validateIds([...selected.keys()]);
    const dialog = node(document, "dialog", "penetration-reference-picker"); uiAttr(dialog, "aria-label", "Choose Technical Library references");
    const heading = ui(node(document, "h2"), "Choose reports and systems"), note = ui(node(document, "p", "helper"), "Filters start with this item's recorded details. Review each Technical Library item before choosing it.");
    const controls = node(document, "div", "penetration-reference-search"), searchLabel = node(document, "label", "field"), search = node(document, "input"); search.type = "search"; search.maxLength = 400; search.dataset.penetrationReferenceSearch = "";
    searchLabel.append(ui(node(document, "span"), "Search Technical Library"), search);
    const message = node(document, "p", "message"), count = node(document, "p", "helper"), filterHost = node(document, "div", "penetration-reference-filters"), resultHost = node(document, "div", "penetration-reference-results"), selectionHost = node(document, "div", "penetration-reference-selection");
    message.hidden = true; message.setAttribute("role", "status"); count.setAttribute("role", "status");
    const state = { closed: false, revision: 0, timer: null, abort: null, offset: 0, limit: 20, total: 0, filters: { ...(options.reference?.initial_filters || {}) }, busy: false, saving: false, available: false, definitions: [] };
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    function button(label, action, className = "button secondary") { const value = ui(node(document, "button", className), label); value.type = "button"; value.addEventListener("click", action); return value; }
    function current() { if (state.closed) return false; if (options.isCurrent && !options.isCurrent()) throw new Error("This schedule item changed. Close this window and review its current references."); return true; }
    function inform(value, error = false) { ui(message, value); message.hidden = !value; message.className = `message${error ? " error" : ""}`; }
    function close(value) { if (state.closed) return; state.closed = true; state.abort?.abort(); clearTimeout(state.timer); dialog.close(); dialog.remove(); finish(value); options.opener?.isConnected && options.opener.focus?.({ preventScroll: true }); }
    const cancel = button("Cancel", () => { if (!state.saving) close(undefined); });
    const apply = button("Use selected references", () => save(false), "button"); apply.dataset.penetrationReferenceApply = "";
    const inherit = button("Use linked references", () => save(true)); inherit.dataset.penetrationReferenceInherit = "";
    const run = button("Search", () => { state.offset = 0; void load(); });
    const clear = button("Clear filters", () => { if (state.saving) return; state.filters = {}; search.value = ""; state.offset = 0; void load(); }); clear.dataset.penetrationReferenceClear = "";
    const previous = button("Previous", () => { state.offset = Math.max(0, state.offset - state.limit); void load(); });
    const next = button("Next", () => { state.offset += state.limit; void load(); });
    function status() {
      apply.disabled = state.busy || state.saving || !state.available;
      inherit.disabled = state.saving; cancel.disabled = state.saving; search.disabled = run.disabled = clear.disabled = state.saving;
      previous.disabled = state.busy || state.saving || state.offset === 0; next.disabled = state.busy || state.saving || state.offset + state.limit >= state.total;
      resultHost.setAttribute("aria-busy", String(state.busy));
      for (const control of [...filterHost.querySelectorAll("select"), ...resultHost.querySelectorAll("input"), ...selectionHost.querySelectorAll("button")]) control.disabled = state.saving;
    }
    function selections() {
      selectionHost.replaceChildren(ui(node(document, "h3"), "Selected systems ({0})", [selected.size]));
      for (const [index, item] of [...selected.values()].entries()) {
        const row = node(document, "div", "penetration-reference-selection-row");
        const remove = button("Remove", () => { if (state.saving) return; selected.delete(item.id); selections(); for (const input of resultHost.querySelectorAll("input")) if (input.value === item.id) input.checked = false; });
        uiAttr(remove, "aria-label", "Remove system {0}: {1}", [index + 1, item.title]);
        row.append(node(document, "span", "", `${index + 1}. ${item.title}`), remove); selectionHost.append(row);
      }
      if (!selected.size) selectionHost.append(ui(node(document, "p", "helper"), "No systems selected."));
      status();
    }
    function filters(definitions) {
      state.definitions = (Array.isArray(definitions) ? definitions : []).filter(item => item && Object.hasOwn(labels, item.key) && Array.isArray(item.options));
      filterHost.replaceChildren(...state.definitions.map(definition => {
        const label = node(document, "label", "field"), control = node(document, "select"), any = ui(node(document, "option"), "Any"); any.value = ""; control.append(any); control.dataset.penetrationReferenceFilter = definition.key;
        const values = filterOptions(definition);
        root.CeasefireLibraries.appendFilterOptions(control, definition.options, definition.key);
        const saved = state.filters[definition.key] || "";
        if (saved && !values.some(value => value.value === saved)) { const value = node(document, "option", "", saved); value.value = saved; control.append(value); }
        control.value = saved;
        control.addEventListener("change", () => { if (state.saving) return; state.filters[definition.key] = control.value; state.offset = 0; void load(); });
        label.append(ui(node(document, "span"), labels[definition.key]), control); return label;
      }));
    }
    async function load() {
      try { if (!current() || state.saving) return; } catch (error) { inform(error.message, true); state.available = false; status(); return; }
      clearTimeout(state.timer); state.abort?.abort(); state.abort = new AbortController(); const revision = ++state.revision;
      state.busy = true; state.available = false; resultHost.replaceChildren(); ui(count, "Searching…"); inform(""); status();
      const query = new URLSearchParams({ search: search.value.trim(), offset: String(state.offset), limit: String(state.limit) });
      for (const key of Object.keys(labels)) if (state.filters[key]) query.set(key, state.filters[key]);
      try {
        const response = await (options.fetch || root.fetch)(`/api/libraries/technical?${query}`, { signal: state.abort.signal, headers: { Accept: "application/json" } });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "Technical records unavailable.");
        if (revision !== state.revision || !current()) return;
        if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.offset !== state.offset || data.items.length > state.limit || data.items.some(item => !validId(item?.id)) || new Set(data.items.map(item => item.id)).size !== data.items.length || data.offset + data.items.length > data.total) throw new Error("The Technical Library returned an invalid result page.");
        state.total = data.total; state.available = true; filters(data.filters);
        ui(count, data.items.length ? "Showing {0}–{1} of {2} technical records" : "No matching technical records.", [data.offset + 1, data.offset + data.items.length, data.total]);
        for (const item of data.items) {
          const row = node(document, "div", "penetration-reference-choice"), label = node(document, "label"), checkbox = node(document, "input"), caption = node(document, "span");
          checkbox.type = "checkbox"; checkbox.value = item.id; checkbox.checked = selected.has(item.id); checkbox.dataset.penetrationReferenceChoice = item.id;
          caption.append(node(document, "strong", "", displayTitle(item))); if (displaySubtitle(item)) caption.append(node(document, "span", "helper", displaySubtitle(item)));
          checkbox.addEventListener("change", () => {
            try { if (!current() || state.saving || revision !== state.revision) return; if (checkbox.checked) { validateIds([...selected.keys(), ...(selected.has(item.id) ? [] : [item.id])]); selected.set(item.id, { id: item.id, title: displayTitle(item) }); } else selected.delete(item.id); selections(); }
            catch (error) { checkbox.checked = selected.has(item.id); inform(error.message, true); }
          });
          const preview = node(document, "section", "penetration-reference-preview"); preview.hidden = true;
          let previewLoaded = false, previewLoading = false;
          const inspect = button("View item", async () => {
            if (state.saving || previewLoading) return;
            try {
              if (!current() || revision !== state.revision) return;
              if (previewLoaded) { preview.hidden = !preview.hidden; inspect.setAttribute("aria-expanded", String(!preview.hidden)); return; }
              previewLoading = true; inspect.disabled = true; preview.hidden = false; ui(preview, "Loading…");
              const response = await (options.fetch || root.fetch)(`/api/libraries/technical/${encodeURIComponent(item.id)}`, { signal: state.abort.signal, headers: { Accept: "application/json" } });
              const detail = await response.json(); if (!response.ok) throw new Error(detail.error || "Technical records unavailable.");
              if (revision !== state.revision || !current()) return;
              if (detail.id !== item.id || !Array.isArray(detail.fields)) throw new Error("The Technical Library returned an invalid item.");
              const fields = node(document, "dl", "library-record-fields");
              for (const field of detail.fields.filter(field => root.LibraryDetailText?.visibleField?.(detail, field, "technical") ?? true)) { const entry = node(document, "div", "library-record-field"); entry.append(node(document, "dt", "", field.label), node(document, "dd", "", field.value)); fields.append(entry); }
              preview.replaceChildren(node(document, "h4", "", displayTitle(detail)), fields); previewLoaded = true; inspect.setAttribute("aria-expanded", "true");
            } catch (error) { if (!state.closed && revision === state.revision && error.name !== "AbortError") { preview.replaceChildren(node(document, "p", "message error", error.message)); } }
            finally { previewLoading = false; inspect.disabled = state.saving; }
          }); inspect.setAttribute("aria-expanded", "false");
          label.append(checkbox, caption); row.append(label, inspect, preview); resultHost.append(row);
        }
      } catch (error) { if (!state.closed && revision === state.revision && error.name !== "AbortError") { state.available = false; inform(error.message, true); ui(count, "Technical records unavailable."); } }
      finally { if (!state.closed && revision === state.revision) { state.busy = false; status(); } }
    }
    async function save(useInherited) {
      if (state.saving || !useInherited && (!state.available || state.busy)) return;
      try {
        if (!current()) return; const ids = useInherited ? undefined : validateIds([...selected.keys()]);
        state.saving = true; status(); inform("Checking selected references…");
        await options.apply(ids); if (!state.closed) close({ applied: true });
      } catch (error) { if (!state.closed) { state.saving = false; inform(error.message, true); status(); } }
    }
    search.addEventListener("input", () => { if (state.saving) return; state.offset = 0; state.abort?.abort(); ++state.revision; state.busy = true; state.available = false; clearTimeout(state.timer); status(); state.timer = setTimeout(load, 250); });
    search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); state.offset = 0; void load(); } });
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (!state.saving) close(undefined); });
    controls.append(searchLabel, run, clear); const pages = node(document, "div", "actions"); pages.append(previous, next);
    const actions = node(document, "div", "actions"); actions.append(inherit, apply, cancel);
    dialog.append(heading, note, controls, filterHost, message, count, resultHost, pages, selectionHost, actions); document.body.append(dialog);
    dialog.showModal(); selections(); void load(); return promise;
  }
  const api = { open, renderSystems, validateIds, validId, filterOptions, reportOptions, appendReportOptions };
  root.CeasefirePenetrationReferences = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" ? window : globalThis);
