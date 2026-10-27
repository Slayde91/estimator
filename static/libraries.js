(() => {
  "use strict";
  // Bind application-owned copy only; node() remains safe for user and source text.
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index])); return element;
  };
  const uiAttr = (element, name, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.attr(element, name, source, args);
    const value = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
    element.setAttribute(name, value); if (["title", "placeholder"].includes(name)) element[name] = value; return element;
  };
  const uiNode = (tag, cls, source, args = []) => { const element = node(tag, cls); return window.CeasefireI18n?.nodeText ? window.CeasefireI18n.nodeText(element, source, args) : uiText(element, source, args); };
  const uiButton = (source, action, cls = "button secondary", args = []) => { const element = button("", action, cls); return window.CeasefireI18n?.nodeText ? window.CeasefireI18n.nodeText(element, source, args) : uiText(element, source, args); };

  const kinds = ["penetration", "technical"], titles = { penetration: "Firestopping Library", technical: "Technical Library" };
  const state = { current: null, metadata: null, metadataRequest: null, panes: new Map(), history: [] };
  const $ = id => document.getElementById(id);
  const node = (tag, className = "", text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
  const uiTerm = (source, args = []) => window.CeasefireI18n?.term ? window.CeasefireI18n.term(source, args) : String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const priceText = price => typeof price?.amount === "number" && Number.isFinite(price.amount) ? money.format(price.amount) : "Price unavailable";
  const priceLabel = price => String(price?.label || "").trim().toLowerCase() === "workbook price" ? "Library price" : price?.label || "Library price";
  const fieldLabel = (kind, label, column) => kind !== "penetration" ? label
    : label === "Type" && column === "J" ? "Category"
    : ["Item(s)", "Items/Services"].includes(label) ? "Description"
    : ["System", "System Install", "System/Install"].includes(label) ? "System/Install Details" : label;
  const diagramCaption = (kind, caption) => (kind === "penetration" ? String(caption || "").replace(/(?:^|\s+|\s*[·|—–-]\s*)(?:'?CALC'?!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|CALC\s+row\s+\d+)\s*$/i, "").trim() : caption) || "Source diagram";
  const validId = value => typeof value === "string" && value.length > 0;
  const validAssetId = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const linkFacets = [["report", "Report"], ["substrate", "Substrate"], ["orientation", "Orientation"], ["manufacturer", "Manufacturer"], ["type", "Type"], ["category", "Category"], ["services", "Services"], ["frl", "FRL"]];
  const validDiagramUrl = value => typeof value === "string" && /^\/api\/libraries\/penetration\/[a-z0-9][a-z0-9_-]{0,119}\/image$/.test(value);
  const integer = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const valueText = value => value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const button = (text, action, className = "button secondary") => { const el = node("button", className, text); el.type = "button"; el.addEventListener("click", action); return el; };
  const symbolButton = (symbol, label, action) => {
    const el = button("", action, "button secondary icon-only");
    const icon = node("span", "button-symbol", symbol); icon.setAttribute("aria-hidden", "true");
    el.append(icon); uiAttr(el, "title", label); uiAttr(el, "aria-label", label); return el;
  };
  async function request(path, signal, payload) {
    const endActivity = window.CeasefireActivity?.begin();
    try {
    const response = await fetch(path, { headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(signal ? { signal } : {}), ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `The library could not be read (${response.status}).`);
    return data;
    } finally { endActivity?.(); }
  }
  async function metadata(refresh = false) {
    if (refresh) { state.metadata = null; state.metadataRequest = null; }
    if (state.metadata) return state.metadata;
    if (!state.metadataRequest) {
      const pending = request("/api/libraries"); state.metadataRequest = pending;
      try {
        const data = await pending;
        if (state.metadataRequest === pending) state.metadata = data;
        return data;
      } finally { if (state.metadataRequest === pending) state.metadataRequest = null; }
    }
    return state.metadataRequest;
  }
  function message(pane, text = "", error = false, args = []) {
    uiText(pane.message, text, args); pane.message.hidden = !text;
    pane.message.className = `message${error ? " error" : " info"}`;
  }
  function paneFor(kind) {
    if (state.panes.has(kind)) return state.panes.get(kind);
    const pane = { kind, search: "", filters: {}, offset: 0, limit: 50, data: null, dataQuery: null, detail: null, selected: null,
      listRevision: 0, detailRevision: 0, openRevision: 0, listAbort: null, detailAbort: null, timer: null, filterStamp: null, busy: false,
      linkSession: null, addPending: new Map(), addErrors: new Map(), deletePending: new Set(), deleteButtons: new Map(), unlinkPending: new Set(), unlinkButtons: new Map(),
      scheduleButtons: new Map(), actionMessages: new Map(), quantityBadges: new Map(), documentCleanup: null, documentPending: null, documentControls: [] };
    const root = $(kind + "-library-workspace");
    pane.message = node("div", "message"); pane.message.hidden = true; pane.message.setAttribute("role", "status");
    pane.notice = node("p", "helper library-notice"); pane.notice.hidden = true;
    pane.projectDrafts = node("section", "card library-project-drafts"); pane.projectDrafts.hidden = true; uiAttr(pane.projectDrafts, "aria-label", "Project library drafts");
    pane.summary = node("section", "card library-summary"); pane.summary.hidden = true; pane.summary.dataset.librarySummary = kind;
    pane.linkPanel = node("section", "card library-link-picker"); pane.linkPanel.hidden = true; pane.linkPanel.dataset.libraryLinkPicker = kind;
    pane.list = node("section", "card library-browser"); uiAttr(pane.list, "aria-label", "{0} records", [() => window.CeasefireI18n?.translate(titles[kind]) || titles[kind]]);
    const controls = node("div", "library-controls"), label = node("label", "field library-search");
    pane.searchInput = node("input"); pane.searchInput.type = "search"; pane.searchInput.maxLength = 400;
    uiAttr(pane.searchInput, "placeholder", kind === "penetration" ? "Search firestopping records…" : "Search systems and technical references…");
    pane.searchInput.dataset.librarySearch = kind;
    label.append(uiNode("span", "", "Search {0}", [uiTerm(titles[kind])]), pane.searchInput);
    pane.refresh = symbolButton("↻", "Refresh", () => refresh(pane)); pane.refresh.className += " refresh-button"; pane.refresh.dataset.libraryRefresh = kind;
    controls.append(label, pane.refresh); pane.filterControls = node("div", "library-filters");
    pane.count = node("p", "helper library-count"); pane.count.setAttribute("role", "status"); pane.count.dataset.libraryCount = kind;
    pane.results = node("div", "library-results"); pane.results.dataset.libraryResults = kind;
    pane.results.setAttribute("aria-busy", "false");
    pane.previous = uiButton("Previous", () => changePage(pane, Math.max(0, pane.offset - pane.limit)), "button secondary");
    pane.next = uiButton("Next", () => changePage(pane, pane.offset + pane.limit), "button secondary");
    pane.previous.dataset.libraryPrevious = kind; pane.next.dataset.libraryNext = kind;
    pane.previous.disabled = pane.next.disabled = true;
    const pagination = node("nav", "library-pagination"); uiAttr(pagination, "aria-label", "{0} result pages", [() => window.CeasefireI18n?.translate(titles[kind]) || titles[kind]]); pagination.append(pane.previous, pane.next);
    pane.list.append(controls, pane.filterControls, pane.count, pane.results, pagination);
    pane.detailPanel = node("section", "card library-detail"); pane.detailPanel.hidden = true; pane.detailPanel.dataset.libraryDetail = kind;
    root.replaceChildren(pane.message, pane.projectDrafts, pane.summary, ...(kind === "technical" ? [] : [pane.notice]), pane.linkPanel, pane.list, pane.detailPanel);
    pane.searchInput.addEventListener("input", () => {
      pane.search = pane.searchInput.value.trim(); pane.offset = 0;
      invalidateList(pane); uiText(pane.count, "Searching…");
      pane.timer = setTimeout(() => loadList(pane), 250);
    });
    state.panes.set(kind, pane); return pane;
  }
  function invalidateList(pane) { clearTimeout(pane.timer); ++pane.listRevision; pane.listAbort?.abort(); }
  function setBusy(pane, busy) {
    pane.busy = busy; pane.results.setAttribute("aria-busy", String(busy));
    pane.previous.disabled = busy || pane.offset === 0;
    pane.next.disabled = busy || !pane.data || pane.offset + pane.limit >= integer(pane.data.total);
  }
  function queryFor(pane) {
    const query = new URLSearchParams();
    if (pane.search) query.set("search", pane.search);
    for (const [key, value] of Object.entries(pane.filters)) if (value) query.set(key, value);
    query.set("offset", String(pane.offset)); query.set("limit", String(pane.limit));
    return query.toString();
  }
  const filterOptions = control => [...control.children].flatMap(child => String(child.tagName).toLowerCase() === "optgroup" ? [...child.children] : [child]);
  function appendFilterOptions(control, options, key) {
    const groups = new Map(), seen = new Set(filterOptions(control).map(option => option.value));
    for (const option of options || []) {
      const value = option && typeof option === "object" ? option.value : option, text = option && typeof option === "object" ? option.label : option;
      if (typeof value !== "string" || !value.trim() || !["string", "undefined"].includes(typeof text) || seen.has(value)) continue;
      const entry = key === "type" ? uiNode("option", "", text ?? value) : node("option", "", window.CeasefirePenetrationPresentation?.serviceLabel(text ?? value) ?? text ?? value);
      entry.value = value; seen.add(value);
      const name = typeof option?.group === "string" && option.group.trim() && (
        key === "substrate" && ["Walls", "Floors", "Ceilings", "Other"].includes(option.group) ||
        ["services", "service_type", "report", "document"].includes(key) || key === "frl" && /^\d+$/.test(option.group)) ? option.group : null;
      if (name) {
        if (!groups.has(name)) {
          const group = node("optgroup");
          if (["report", "document"].includes(key)) group.setAttribute("label", name);
          else if (key === "frl") uiAttr(group, "label", "{0} minutes", [name]);
          else uiAttr(group, "label", name);
          groups.set(name, group); control.append(group);
        }
        groups.get(name).append(entry);
      } else control.append(entry);
    }
  }
  function renderFilters(pane, filters) {
    const safeFilters = (Array.isArray(filters) ? filters : []).filter(filter => typeof filter.key === "string" && !["search", "offset", "limit", "technical_reference"].includes(filter.key));
    if (pane.kind === "penetration") safeFilters.push({ key: "technical_reference", label: "Technical Reference", options: [{ value: "linked", label: "Linked Technical References" }, { value: "unlinked", label: "No Linked Technical References" }] });
    const stamp = JSON.stringify([safeFilters, pane.filters]); if (stamp === pane.filterStamp) return;
    pane.filterStamp = stamp;
    pane.filterControls.replaceChildren(...safeFilters.map(filter => {
      const reference = filter.key === "technical_reference", label = node("label", "field"), control = node("select"), all = uiNode("option", "", ...(reference ? ["Any", []] : ["All {0}", [uiTerm(filter.label || filter.key)]])); all.value = reference ? "any" : "";
      control.dataset.libraryFilter = filter.key; control.append(all);
      if (reference) for (const option of filter.options || []) { const el = uiNode("option", "", option.label ?? option.value); el.value = option.value; control.append(el); }
      else appendFilterOptions(control, filter.options, filter.key);
      const selected = pane.filters[filter.key] || (reference ? "any" : "");
      if (selected && !filterOptions(control).some(option => option.value === selected)) { const el = node("option", "", selected); el.value = selected; control.append(el); }
      control.value = selected;
      control.addEventListener("change", () => { pane.filters[filter.key] = control.value; pane.offset = 0; loadList(pane); });
      label.append(uiNode("span", "", filter.label || filter.key), control); return label;
    }));
  }
  function renderList(pane) {
    const data = pane.data, items = Array.isArray(data.items) ? data.items : [];
    const display = compactTechnical;
    pane.offset = integer(data.offset, pane.offset); pane.limit = integer(data.limit, pane.limit) || 50;
    const total = integer(data.total);
    uiText(pane.count, ...(total ? ["Showing {0}–{1} of {2} records", [pane.offset + 1, Math.min(pane.offset + items.length, total), total]] : ["No matching records.", []]));
    for (const key of pane.scheduleButtons.keys()) if (key.startsWith("list:")) { pane.scheduleButtons.delete(key); pane.actionMessages.delete(key); }
    for (const key of pane.deleteButtons.keys()) if (key.startsWith("list:")) pane.deleteButtons.delete(key);
    for (const key of pane.quantityBadges.keys()) if (key.startsWith("list:")) pane.quantityBadges.delete(key);
    pane.results.replaceChildren(...(items.length ? items.map(item => {
      const card = node("article", "library-result"), title = button(display(window.LibraryDetailText.displayTitle(item)), () => navigate(pane.kind, item.id), "library-record-link");
      title.dataset.libraryRecord = item.id;
      if (pane.kind === "penetration") { const heading = node("div", "library-record-heading"); heading.append(title, quantityBadge(pane, item.id, "list")); card.append(heading); }
      else { title.classList.add("library-frl-value"); card.append(title); }
      const subtitle = window.LibraryDetailText.displaySubtitle(item);
      if (subtitle) card.append(node("p", "library-subtitle library-frl-value", display(subtitle)));
      if (item.price) card.append(node("p", "library-record-price", `${priceLabel(item.price)}: ${priceText(item.price)}`));
      if (item.summary) card.append(node("p", "library-excerpt", display(item.summary)));
      if (Number.isSafeInteger(item.related_count)) card.append(uiNode("p", "helper", "{0} related {1}", [item.related_count, () => window.CeasefireI18n?.translate(pane.kind === "penetration" ? "technical references" : "firestopping records") || (pane.kind === "penetration" ? "technical references" : "firestopping records")]));
      if (pane.kind === "penetration") card.append(itemActions(pane, item, "list"));
      return card;
    }) : [uiNode("p", "empty-state", "Try a different search or filter.")]));
    renderFilters(pane, data.filters || libraryInfo(pane)?.filters || []); renderSummary(pane); setBusy(pane, false);
  }
  function renderSummary(pane) {
    const info = libraryInfo(pane), counts = pane.data?.counts;
    const table = node("table", "library-summary-table"), head = node("thead"), row = node("tr"), body = node("tbody");
    table.append(uiNode("caption", "", "{0} summary", [uiTerm(titles[pane.kind])]));
    for (const label of ["Breakdown", "Records"]) { const cell = uiNode("th", "", label); cell.setAttribute("scope", "col"); row.append(cell); }
    const addRow = (label, value, className = "", owned = false) => {
      const line = node("tr", className), heading = (owned ? uiNode : node)("th", "", label); heading.setAttribute("scope", "row");
      line.append(heading, node("td", "", Number.isSafeInteger(value) && value >= 0 ? value : "—")); body.append(line);
    };
    addRow("Total records", counts?.total ?? info?.count, "library-summary-total", true);
    for (const entry of Array.isArray(counts?.manufacturers) ? counts.manufacturers : []) addRow(entry.name, entry.count, "library-summary-manufacturer");
    addRow(pane.kind === "technical" ? "No related firestopping records" : "No related technical references", counts?.unlinked ?? info?.unlinked_count, "library-summary-related", true);
    head.append(row); table.append(head, body); pane.summary.replaceChildren(table); pane.summary.hidden = false;
  }
  function actionContext(pane) { return JSON.stringify([state.current, pane.openRevision, pane.selected, pane.search, pane.filters, pane.offset]); }
  function updateQuantity(badge, id) {
    const quantity = window.CeasefirePenetrations?.libraryQuantity?.(id);
    const available = typeof quantity === "number" && Number.isFinite(quantity);
    badge.hidden = quantity === undefined;
    uiText(badge, ...(available ? ["Quantity: {0}", [quantity]] : ["Quantity unavailable", []]));
    uiAttr(badge, "aria-label", available ? "Current schedule quantity: {0}" : "Current schedule quantity unavailable", available ? [quantity] : []);
  }
  function quantityBadge(pane, id, place) {
    const badge = node("span", "library-schedule-quantity"); badge.dataset.libraryQuantity = id; badge.setAttribute("role", "status");
    pane.quantityBadges.set(`${place}:${id}`, badge); updateQuantity(badge, id); return badge;
  }
  function scheduleChanged() {
    const pane = state.panes.get("penetration"); if (!pane) return;
    for (const badge of pane.quantityBadges.values()) updateQuantity(badge, badge.dataset.libraryQuantity);
  }
  function itemActions(pane, item, place) {
    const actions = node("div", "library-item-actions");
    if (item.editable) { const edit = uiButton("Edit", () => editItem(pane, item.id), "button library-edit-button"); edit.dataset.libraryEdit = item.id; actions.append(edit); }
    const link = symbolButton("🔗︎", "Link Library Item", () => openLinkPicker(pane, item, link)); link.className += " link-action-button"; link.dataset.libraryLink = item.id;
    const add = button("", () => addToSchedule(pane, item.id), "button secondary takeoff-physical-icon-action library-add-transfer");
    const transfer = node("img", "takeoff-transfer-icon"); transfer.src = "/icons/takeoff-transfer.png"; transfer.alt = ""; transfer.width = transfer.height = 24; transfer.setAttribute("aria-hidden", "true");
    add.append(transfer, uiNode("span", "sr-only", "Add to Schedule"));
    add.dataset.libraryAdd = item.id; uiAttr(add, "title", "Add to Schedule"); uiAttr(add, "aria-label", "Add to Schedule");
    const status = node("p", "message error library-action-message", pane.addErrors.get(item.id) || ""); status.hidden = !status.textContent; status.setAttribute("role", "status");
    const remove = button("", () => deleteItem(pane, item), "button library-delete library-delete-button");
    const icon = node("span", "library-trash-icon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 10.5v6M14 10.5v6"></path></svg>';
    icon.setAttribute("aria-hidden", "true"); remove.append(icon);
    uiAttr(remove, "title", "Remove {0} from the Firestopping Library", [item.title || item.id]);
    uiAttr(remove, "aria-label", "Remove {0} from the Firestopping Library", [item.title || item.id]); remove.dataset.libraryDelete = item.id;
    remove.disabled = pane.deletePending.has(item.id); pane.deleteButtons.set(`${place}:${item.id}`, remove);
    add.disabled = pane.addPending.has(item.id); pane.scheduleButtons.set(`${place}:${item.id}`, add); pane.actionMessages.set(`${place}:${item.id}`, status); actions.append(remove, link, add, status); return actions;
  }
  async function deleteItem(pane, item) {
    const id = item.id;
    if (pane.deletePending.has(id)) return;
    const confirm = window.CeasefirePenetrationNavigation?.confirm;
    if (!confirm) { message(pane, "The deletion confirmation is unavailable. Reload the application and try again.", true); return; }
    if (!await confirm("Remove Firestopping Library item?", uiTerm("{0} will be removed from the Firestopping Library.", [item.title || id]), "Remove item")) return;
    pane.deletePending.add(id);
    for (const control of pane.deleteButtons.values()) if (control.dataset.libraryDelete === id) control.disabled = true;
    try {
      const receipt = await request(`/api/libraries/penetration/${encodeURIComponent(id)}/delete`, null, {});
      if (receipt.deleted !== true || receipt.id !== id) throw new Error("The server did not confirm the deletion.");
      const stillViewingDeletedItem = state.current === "penetration" && (pane.selected === id || pane.selected === null);
      invalidate();
      if (stillViewingDeletedItem) {
        pane.selected = null; pane.detail = null; state.history = [];
        await open("penetration", { list: true });
        message(pane, "{0} was removed from the Firestopping Library.", false, [item.title || id]);
      }
    } catch (error) {
      message(pane, "The library item was not removed. {0}", true, [() => window.CeasefireI18n?.translate(error.message) || error.message]);
    } finally {
      pane.deletePending.delete(id);
      for (const control of pane.deleteButtons.values()) if (control.dataset.libraryDelete === id) control.disabled = false;
    }
  }
  async function addToSchedule(pane, id) {
    if (pane.addPending.has(id)) return;
    const token = {}, context = actionContext(pane); pane.addPending.set(id, token); pane.addErrors.delete(id); message(pane);
    for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { uiText(status, "", []); status.hidden = true; }
    for (const control of pane.scheduleButtons.values()) if (control.dataset.libraryAdd === id) control.disabled = true;
    try {
      const receipt = await window.CeasefirePenetrations.addLibraryItem(id);
      scheduleChanged();
      if (context === actionContext(pane) && receipt?.added) {
        const text = receipt.message || "Added to the Firestopping Schedule using its current prices and allowances.";
        for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) {
          uiText(status, text); status.hidden = false; status.className = "message library-action-message";
        }
      }
    }
    catch (error) {
      if (context === actionContext(pane)) {
        const text = `The library item could not be added to the schedule. ${error.message}`; pane.addErrors.set(id, text);
        for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { uiText(status, text); status.hidden = false; status.className = "message error library-action-message"; }
      }
    }
    finally {
      if (pane.addPending.get(id) === token) pane.addPending.delete(id);
      for (const control of pane.scheduleButtons.values()) if (control.dataset.libraryAdd === id) control.disabled = false;
    }
  }
  function closeLinkPicker(pane) {
    const session = pane.linkSession; if (!session) return;
    clearTimeout(session.timer); session.abort?.abort(); ++session.revision; pane.linkSession = null; pane.linkPanel.hidden = true;
    pane.list.hidden = !!pane.selected; pane.detailPanel.hidden = !pane.selected;
  }
  function linkMessage(session, text = "", error = false) {
    uiText(session.message, text); session.message.hidden = !text; session.message.className = `message${error ? " error" : " info"}`;
  }
  function updateLinkSave(session) {
    const count = session.selected.size;
    uiText(session.save, ...(count ? ["Save links ({0})", [count]] : ["Save links", []]));
    session.save.disabled = !count || session.busy || session.saving || !session.available;
    uiText(session.selectionCount, "{0} selected {1}. Selections are kept across search, filters and pages.", [count, () => window.CeasefireI18n?.translate(count === 1 ? "reference" : "references") || (count === 1 ? "reference" : "references")]);
  }
  function renderLinkFilters(pane, session, filters) {
    // Use the same server-owned definitions as Technical Library discovery.
    // A missing/malformed facet stays unavailable; no fact or rating is inferred.
    session.filterDefinitions = filters;
    const definitions = new Map();
    for (const filter of Array.isArray(filters) ? filters : []) {
      if (!filter || ![...linkFacets.map(([key]) => key), "document"].includes(filter.key) || !Array.isArray(filter.options)) continue;
      const facet = filter.key === "document" ? "report" : filter.key;
      if (definitions.has(facet)) { definitions.set(facet, null); continue; }
      definitions.set(facet, filter);
    }
    session.filterInputs = [];
    session.filterControls.replaceChildren(...linkFacets.map(([key, title]) => {
      const definition = definitions.get(key), queryKey = definition?.key || key, label = node("label", "field"), control = node("select"), all = uiNode("option", "", ...(definition ? ["All {0}", [uiTerm(title)]] : ["{0} unavailable", [uiTerm(title)]])); all.value = "";
      control.dataset.libraryLinkFilter = queryKey; control.append(all); control.disabled = !definition || session.saving;
      appendFilterOptions(control, definition?.options, queryKey);
      const selected = session.filters[queryKey] || "";
      if (selected && !filterOptions(control).some(item => item.value === selected)) { const retained = node("option", "", selected); retained.value = selected; control.append(retained); }
      control.value = selected;
      control.addEventListener("change", () => {
        if (pane.linkSession !== session || session.saving || control.disabled) return;
        session.filters[queryKey] = control.value; session.offset = 0; loadLinkResults(pane, session);
      });
      session.filterInputs.push(control); label.append(uiNode("span", "", title), control); return label;
    }));
  }
  function openLinkPicker(pane, item, opener) {
    closeLinkPicker(pane); invalidateList(pane); message(pane);
    const session = { id: item.id, search: "", filters: {}, offset: 0, limit: 20, total: 0, selected: new Set(), revision: 0, abort: null, timer: null, busy: false, saving: false, available: false, choices: [], filterInputs: [] };
    pane.linkSession = session; pane.list.hidden = pane.detailPanel.hidden = true; pane.linkPanel.hidden = false;
    const heading = uiNode("h3", "", "Link Library Item"); heading.id = "library-link-heading"; heading.tabIndex = -1; pane.linkPanel.setAttribute("aria-labelledby", heading.id);
    const cancel = uiButton("Cancel", async () => {
      if (pane.linkSession !== session || session.saving) return;
      closeLinkPicker(pane); const revision = pane.openRevision + 1; await open(pane.kind, pane.selected || { list: true });
      if (state.current === pane.kind && pane.openRevision === revision && !pane.linkSession) (opener.isConnected === false ? pane.searchInput : opener).focus({ preventScroll: true });
    }, "button secondary"); cancel.dataset.libraryLinkCancel = ""; session.cancel = cancel;
    const controls = node("div", "library-controls"), label = node("label", "field library-search"); session.searchInput = node("input"); session.searchInput.type = "search"; session.searchInput.maxLength = 400; session.searchInput.dataset.libraryLinkSearch = "";
    label.append(uiNode("span", "", "Search Technical Library"), session.searchInput);
    session.refresh = uiButton("Search", () => loadLinkResults(pane, session), "button secondary"); controls.append(label, session.refresh);
    session.clear = uiButton("Clear filters", () => { if (pane.linkSession !== session || session.saving) return; session.search = ""; session.searchInput.value = ""; session.filters = {}; session.offset = 0; loadLinkResults(pane, session); }, "button secondary"); session.clear.dataset.libraryLinkClear = ""; controls.append(session.clear);
    session.filterControls = node("div", "library-filters library-link-filters");
    session.message = node("div", "message"); session.message.hidden = true; session.message.setAttribute("role", "status");
    session.count = node("p", "helper"); session.count.setAttribute("role", "status"); session.results = node("div", "library-link-results");
    session.selectionCount = node("p", "helper library-link-selection"); session.selectionCount.setAttribute("role", "status");
    session.previous = uiButton("Previous", () => { if (session.busy || session.saving || pane.linkSession !== session) return; session.offset = Math.max(0, session.offset - session.limit); loadLinkResults(pane, session); }, "button secondary");
    session.next = uiButton("Next", () => { if (session.busy || session.saving || pane.linkSession !== session) return; session.offset += session.limit; loadLinkResults(pane, session); }, "button secondary");
    session.save = uiButton("Save links", () => saveLink(pane, session), "button link-action-button"); session.save.dataset.libraryLinkSave = ""; session.save.disabled = true;
    const pages = node("nav", "library-pagination"); uiAttr(pages, "aria-label", "Technical reference choices"); pages.append(session.previous, session.next);
    const actions = node("div", "library-item-actions"); actions.append(session.save, cancel);
    pane.linkPanel.replaceChildren(heading, node("p", "library-subtitle", item.title || item.id), uiNode("p", "helper", "Choose one or more Technical Library items to link."), controls, session.filterControls, session.message, session.count, session.selectionCount, session.results, pages, actions);
    renderLinkFilters(pane, session, state.metadata?.libraries?.find(library => library.id === "technical")?.filters); updateLinkSave(session);
    session.searchInput.addEventListener("input", () => {
      if (session.saving || pane.linkSession !== session) return;
      session.search = session.searchInput.value.trim(); session.offset = 0; session.busy = true; ++session.revision; session.abort?.abort(); clearTimeout(session.timer); session.save.disabled = session.previous.disabled = session.next.disabled = true; uiText(session.count, "Searching…");
      session.timer = setTimeout(() => loadLinkResults(pane, session), 250);
    });
    heading.focus({ preventScroll: true }); pane.linkPanel.scrollIntoView?.({ block: "start" }); loadLinkResults(pane, session);
  }
  async function loadLinkResults(pane, session) {
    if (pane.linkSession !== session || session.saving) return;
    clearTimeout(session.timer); session.abort?.abort(); session.abort = new AbortController(); const revision = ++session.revision;
    session.busy = true; session.available = false; session.save.disabled = session.previous.disabled = session.next.disabled = true;
    session.choices = []; session.results.replaceChildren(); session.results.setAttribute("aria-busy", "true"); uiText(session.count, "Searching…"); linkMessage(session);
    const query = new URLSearchParams({ search: session.search, offset: String(session.offset), limit: String(session.limit) });
    for (const key of [...linkFacets.map(([key]) => key), "document"]) if (session.filters[key]) query.set(key, session.filters[key]);
    try {
      const data = await request(`/api/libraries/technical?${query}`, session.abort.signal);
      if (pane.linkSession !== session || revision !== session.revision) return;
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.items.some(item => !item || !validId(item.id)) || new Set(data.items.map(item => item.id)).size !== data.items.length) throw new Error("The Technical Library returned an invalid result page.");
      if (data.offset !== session.offset || data.items.length > session.limit) throw new Error("The Technical Library returned an unexpected result page.");
      if (!data.items.length && data.total > 0 && session.offset >= data.total) { session.offset = Math.floor((data.total - 1) / session.limit) * session.limit; await loadLinkResults(pane, session); return; }
      if (data.items.length && data.offset + data.items.length > data.total) throw new Error("The Technical Library returned an inconsistent result count.");
      session.total = integer(data.total); session.offset = integer(data.offset, session.offset);
      session.available = true; renderLinkFilters(pane, session, data.filters);
      const items = Array.isArray(data.items) ? data.items : [];
      uiText(session.count, ...(session.total ? ["Showing {0}–{1} of {2} technical records", [session.offset + 1, session.offset + items.length, session.total]] : ["No matching technical records.", []]));
      session.results.replaceChildren(...items.map(item => {
        const choice = node("label", "library-link-choice"), input = node("input"), description = node("span"); input.type = "checkbox"; input.value = item.id; input.checked = session.selected.has(item.id); input.dataset.libraryLinkChoice = item.id;
        description.append(node("strong", "library-frl-value", compactTechnical(window.LibraryDetailText.displayTitle(item))));
        const subtitle = window.LibraryDetailText.displaySubtitle(item);
        if (subtitle) description.append(node("span", "helper library-frl-value", compactTechnical(subtitle)));
        input.addEventListener("change", () => { if (pane.linkSession !== session || revision !== session.revision || session.busy || session.saving) return; if (input.checked) session.selected.add(item.id); else session.selected.delete(item.id); updateLinkSave(session); }); session.choices.push(input); choice.append(input, description); return choice;
      }));
    } catch (error) { if (pane.linkSession === session && revision === session.revision && error.name !== "AbortError") { session.total = 0; uiText(session.count, "Technical records unavailable."); linkMessage(session, `${error.message} Use Search to retry.`, true); } }
    finally {
      if (pane.linkSession === session && revision === session.revision) { session.busy = false; session.results.setAttribute("aria-busy", "false"); updateLinkSave(session); session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
    }
  }
  async function saveLink(pane, session) {
    if (pane.linkSession !== session || session.saving || session.busy || !session.available || !session.selected.size) return;
    const technicalIds = [...session.selected]; session.saving = true; session.save.disabled = session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = session.clear.disabled = session.previous.disabled = session.next.disabled = true; linkMessage(session, "Saving links…");
    for (const control of session.filterInputs) control.disabled = true;
    for (const choice of session.choices) choice.disabled = true;
    try {
      const receipt = await request(`/api/libraries/penetration/${encodeURIComponent(session.id)}/links`, null, { technical_ids: technicalIds });
      if (receipt.linked !== true || receipt.penetration_id !== session.id || !Array.isArray(receipt.technical_ids) || receipt.technical_ids.length !== technicalIds.length || technicalIds.some(id => !receipt.technical_ids.includes(id))) throw new Error("The server did not confirm the saved reference links.");
      invalidate();
      if (pane.linkSession !== session || state.current !== pane.kind) return;
      closeLinkPicker(pane); const revision = pane.openRevision + 1; await open(pane.kind, pane.selected || { list: true });
      if (state.current === pane.kind && pane.openRevision === revision) {
        const created = Array.isArray(receipt.created_ids) ? receipt.created_ids.length : 0;
        message(pane, created ? `${created} technical ${created === 1 ? "reference" : "references"} linked.` : "The selected technical references are already linked.");
      }
    } catch (error) { if (pane.linkSession === session) linkMessage(session, `Saving the reference links was not confirmed. ${error.message} Retry to check the same links.`, true); }
    finally {
      if (pane.linkSession === session) { session.saving = false; session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = session.clear.disabled = false; renderLinkFilters(pane, session, session.filterDefinitions); for (const choice of session.choices) choice.disabled = false; updateLinkSave(session); session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
    }
  }
  async function unlinkReference(pane, item, link) {
    const penetrationId = pane.kind === "penetration" ? item.id : link.id;
    const technicalId = pane.kind === "technical" ? item.id : link.id;
    const key = `${penetrationId}:${technicalId}`;
    if (pane.unlinkPending.has(key)) return;
    const confirm = window.CeasefirePenetrationNavigation?.confirm;
    if (!confirm) { message(pane, "The unlink confirmation is unavailable. Reload the application and try again.", true); return; }
    const label = pane.kind === "penetration" ? "technical reference" : "firestopping record";
    if (!await confirm(uiTerm("Unlink {0}?", [() => window.CeasefireI18n?.translate(label) || label]), uiTerm("{0} will be unlinked from this library record.", [link.title || link.id]), "Unlink")) return;
    pane.unlinkPending.add(key);
    for (const control of pane.unlinkButtons.values()) if (control.dataset.libraryUnlink === key) control.disabled = true;
    try {
      const receipt = await request(`/api/libraries/penetration/${encodeURIComponent(penetrationId)}/links/remove`, null, { technical_id: technicalId });
      if (receipt.unlinked !== true || receipt.penetration_id !== penetrationId || receipt.technical_id !== technicalId) throw new Error("The server did not confirm the removed reference link.");
      const sameRecord = state.current === pane.kind && pane.selected === item.id;
      invalidate();
      if (sameRecord) { await open(pane.kind, item.id); if (state.current === pane.kind && pane.selected === item.id) message(pane, "{0}{1} unlinked.", false, [label[0].toUpperCase(), label.slice(1)]); }
    } catch (error) { message(pane, "The {0} was not unlinked. {1}", true, [label, () => window.CeasefireI18n?.translate(error.message) || error.message]); }
    finally {
      pane.unlinkPending.delete(key);
      for (const control of pane.unlinkButtons.values()) if (control.dataset.libraryUnlink === key) control.disabled = false;
    }
  }
  async function editItem(pane, id) {
    message(pane);
    try { await window.CeasefireLibraryEditor.open(id); }
    catch (error) { message(pane, "The library item could not be opened for editing. {0}", true, [() => window.CeasefireI18n?.translate(error.message) || error.message]); }
  }
  function libraryInfo(pane) { return state.metadata?.libraries?.find(library => library.id === pane.kind); }
  function updateNotice(pane, data = pane.data) {
    const info = libraryInfo(pane), notes = [state.metadata?.notice, info?.notice, data?.notice].filter(Boolean);
    pane.notice.textContent = [...new Set(notes)].join("\n"); pane.notice.hidden = !pane.notice.textContent;
  }
  async function loadList(pane) {
    invalidateList(pane); const revision = pane.listRevision, query = queryFor(pane);
    pane.listAbort = new AbortController(); setBusy(pane, true); message(pane);
    try {
      const data = await request(`/api/libraries/${pane.kind}?${query}`, pane.listAbort.signal);
      if (revision !== pane.listRevision || query !== queryFor(pane)) return;
      if (Array.isArray(data.items) && !data.items.length && integer(data.total) > 0 && pane.offset >= data.total) {
        pane.offset = Math.floor((data.total - 1) / pane.limit) * pane.limit;
        await loadList(pane); return;
      }
      pane.data = data; renderList(pane); pane.dataQuery = queryFor(pane); updateNotice(pane, data);
    } catch (error) {
      if (revision !== pane.listRevision || error.name === "AbortError") return;
      pane.data = null;
      pane.results.replaceChildren(uiNode("p", "empty-state", "The records could not be loaded.")); uiText(pane.count, "Records unavailable.");
      message(pane, "{0} Use Refresh to try again.", true, [() => window.CeasefireI18n?.translate(error.message) || error.message]);
    } finally { if (revision === pane.listRevision) setBusy(pane, false); }
  }
  function changePage(pane, offset) { pane.offset = offset; loadList(pane); pane.list.scrollIntoView?.({ block: "start" }); }
  function snapshot(pane) { return { kind: pane.kind, id: pane.selected, search: pane.search, filters: clone(pane.filters), offset: pane.offset }; }
  function navigate(kind, id) {
    if (!kinds.includes(kind) || !validId(id)) return;
    if (state.current) state.history.push(snapshot(paneFor(state.current)));
    if (state.history.length > 40) state.history.shift();
    window.CeasefireLibraryNavigation.open(kind, id);
  }
  function back() {
    const target = state.history.pop(); if (!target) return;
    const pane = paneFor(target.kind), changed = pane.search !== target.search || pane.offset !== target.offset || JSON.stringify(pane.filters) !== JSON.stringify(target.filters);
    pane.search = target.search; pane.searchInput.value = target.search; pane.offset = target.offset; pane.filters = clone(target.filters);
    if (changed) { pane.data = null; pane.filterStamp = null; }
    window.CeasefireLibraryNavigation.open(target.kind, target.id || { list: true });
  }
  function showList(pane) {
    pane.documentCleanup?.();
    closeLinkPicker(pane);
    ++pane.detailRevision; pane.detailAbort?.abort(); pane.selected = null; pane.detail = null;
    pane.detailPanel.hidden = true; pane.list.hidden = false; message(pane); updateNotice(pane);
    if (!pane.data || pane.dataQuery !== queryFor(pane)) return loadList(pane);
    renderFilters(pane, pane.data.filters || libraryInfo(pane)?.filters || []); setBusy(pane, false);
  }
  const compactTechnical = value => window.LibraryDetailText.compact(valueText(value));
  function imageNode(item, kind, imageOnly = false, replicas = {}) {
    const figure = node("figure", "library-image"), link = node("a"), image = node("img");
    const captionText = kind === "technical" ? compactTechnical(diagramCaption(kind, item.caption)) : diagramCaption(kind, item.caption);
    const caption = kind === "technical" && item.role ? compactTechnical(`${item.role} — ${captionText}`) : captionText;
    const savedUrl = kind === "penetration" && validDiagramUrl(item.url) ? item.url : null;
    const replica = replicas[item.id], expected = `/api/libraries/replicas/${encodeURIComponent(item.id)}`;
    const useReplica = !savedUrl && replica === expected;
    // Resolve the final asset before assigning src; even a detached image can
    // start a request, so AI blocks must never briefly load the original.
    link.href = savedUrl || (useReplica ? replica : `/api/libraries/images/${encodeURIComponent(item.id)}`);
    link.target = "_blank"; link.rel = "noopener noreferrer";
    if (useReplica) uiAttr(link, "aria-label", "Open AI replica at full size (new tab)");
    else uiAttr(link, "aria-label", "Open {0} at full size (new tab)", [caption]);
    image.src = link.href; image.alt = useReplica ? `${caption} — AI replica` : caption;
    image.loading = "lazy"; image.decoding = "async";
    link.append(image); figure.append(link);
    if (useReplica) {
      // A missing replica must never silently substitute an original image
      // underneath an AI caption. Originals remain in the retained record.
      figure.append(uiNode("figcaption", "helper", "Illustrative AI generated asset only. Confirm installation details with the manufacturer."));
      return figure;
    }
    if (!imageOnly) figure.append(node("figcaption", "helper", caption));
    return figure;
  }
  const configurationField = "Service Size / Configuration";
  const tableTargetLabels = new Map([[configurationField, "configuration"], ["Barrier Construction", "barrier construction"]]);
  const fieldTables = field => [...(field.table ? [field.table] : []), ...(Array.isArray(field.tables) ? field.tables : [])];
  const frlKey = value => String(value).trim().replace(/\s+/g, " ").replace(/[‐‑‒–—−]/g, "-").toLowerCase();
  function bareFrlRatings(value) {
    const found = [], expression = frlKey(value).replace(/^frl\s*:?\s*/, "").replace(/(?:-|\d+)\s*\/\s*(?:-|\d+)\s*\/\s*(?:-|\d+)/g, rating => {
      const parts = rating.split("/").map(part => part.trim() === "-" ? null : Number(part.trim()));
      if (!parts.some(part => part !== null) || parts.some(part => part !== null && !Number.isSafeInteger(part))) return rating;
      found.push(parts); return "R";
    });
    return /^R(?:\s*(?:to|and|or|[-,;|&])\s*R)*\.?$/.test(expression) ? found : null;
  }
  function frlDisplayValue(field, fields) {
    // Hide only generated explanations whose exact table/column/row remains
    // available through a valid link. Authored qualifications remain verbatim.
    const original = String(field.value ?? ""), paragraphs = original.split(/\r?\n[ \t]*\r?\n/);
    const linkedCells = (owner, ordinal, qualifier) => {
      const index = Number(ordinal) - 1, matches = fields.filter(item => item.label === owner);
      if (matches.length !== 1 || !Number.isSafeInteger(index) || !Array.isArray(field.table_links) || !field.table_links.some(link => link && typeof link === "object" && !Array.isArray(link) && Object.keys(link).length === 2 && link.field === owner && link.table_index === index)) return null;
      const table = fieldTables(matches[0])[index];
      if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows) || !table.rows.every(Array.isArray)) return null;
      let rows = table.rows, columns = table.columns.map((name, index) => ({ name, index })).filter(column => /^(?:source )?frl(?:\b|_)/.test(frlKey(column.name)));
      const condition = qualifier.trim();
      if (condition.startsWith("(") && condition.endsWith(")")) columns = columns.filter(column => frlKey(column.name) === frlKey(condition.slice(1, -1)));
      else if (condition.startsWith("; ")) {
        const scope = condition.slice(2);
        if (/^frl(?:\b|_)/.test(frlKey(scope))) columns = columns.filter(column => frlKey(column.name) === frlKey(scope));
        else {
          const requirements = scope.split("; ").map(part => { const split = part.indexOf(": "); return split > 0 ? [part.slice(0, split), part.slice(split + 2)] : null; });
          if (requirements.some(part => !part)) return null;
          const conditions = requirements.map(([name, value]) => ({ index: table.columns.findIndex(column => frlKey(column) === frlKey(name)), value }));
          if (conditions.some(item => item.index < 0)) return null;
          rows = rows.filter(row => conditions.every(item => frlKey(row[item.index]) === frlKey(item.value)));
        }
      } else if (condition) return null;
      return columns.length && rows.length ? rows.flatMap(row => columns.map(column => String(row[column.index] ?? ""))) : null;
    };
    const generated = /^(.+?) — (?:observed source service ratings|matched source barrier row|source substrate alternatives) \((Service Size \/ Configuration|Barrier Construction) table ([1-9]\d*)(.*?)\)\.(?: The entry selection remains separate\.)?$/;
    const unresolved = /^(?:Observed source service ratings|Matched source barrier row|Source substrate alternatives) \((Service Size \/ Configuration|Barrier Construction) table ([1-9]\d*)(.*?)\): (?:refer to the complete source cells; blank, qualified or unresolved ratings are not reduced to a range|retain the qualified source ratings as shown; no range is inferred)\.$/;
    let changed = false;
    const cleaned = paragraphs.map(paragraph => {
      const match = generated.exec(paragraph.trim());
      if (match) {
        const ratings = bareFrlRatings(match[1]), cells = linkedCells(match[2], match[3], match[4]);
        const sourceRatings = cells?.flatMap(cell => bareFrlRatings(cell) || []);
        if (ratings && sourceRatings?.length && ratings.every(rating => sourceRatings.some(source => source.every((part, index) => part === rating[index])))) {
          changed = true; return match[1].trim();
        }
      }
      const reference = unresolved.exec(paragraph.trim());
      if (reference && linkedCells(reference[1], reference[2], reference[3])?.some(cell => cell.trim())) { changed = true; return ""; }
      return paragraph;
    });
    if (!changed) return original;
    const boilerplate = "Source configuration ratings remain subject to the stated barrier construction and installation conditions.";
    const kept = cleaned.filter(paragraph => paragraph.trim() && paragraph.trim() !== boilerplate);
    const rated = kept.map((paragraph, index) => ({ index, ratings: bareFrlRatings(paragraph) })).filter(item => item.ratings);
    if (!rated.length) return kept.join("\n\n");
    const unique = [...new Map(rated.flatMap(item => item.ratings).map(rating => [JSON.stringify(rating), rating])).values()];
    const format = rating => rating.map(part => part === null ? "-" : part).join("/");
    let summary = unique.map(format).join("; ");
    const sameMask = unique.every(rating => rating.every((part, index) => (part === null) === (unique[0][index] === null)));
    if (sameMask && unique.length > 1) {
      const ordered = [...unique].sort((a, b) => { for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]; return 0; });
      if (ordered.every((rating, index) => !index || rating.every((part, component) => part === null || ordered[index - 1][component] <= part))) summary = `${format(ordered[0])} to ${format(ordered.at(-1))}`;
    }
    const first = rated[0].index, numeric = new Set(rated.map(item => item.index));
    return kept.flatMap((paragraph, index) => index === first ? [summary] : numeric.has(index) ? [] : [paragraph]).join("\n\n");
  }
  const displayedColumns = table => table.columns.map((label, index) => ({ label, index })).filter(column => !["id", "configuration", "source configuration"].includes(String(column.label).trim().replace(/\s+/g, " ").toLowerCase()));
  const frlLabel = label => /\bfrl\b/i.test(String(label).replace(/_/g, " "));
  const validFieldTable = table => table && Array.isArray(table.columns) && Array.isArray(table.rows) && table.rows.every(Array.isArray);
  // Encode every code point so imported labels/IDs cannot create selectors or fragment URLs.
  const anchorPart = value => Array.from(String(value), char => char.codePointAt(0).toString(16)).join("-");
  const tableAnchor = (kind, id, label, index) => `library-table-${kind}-${anchorPart(id)}-${anchorPart(label)}-${index}`;
  function fieldTable(field, index = 0, total = 1, kind = "technical") {
    const display = ["technical", "penetration"].includes(kind) ? compactTechnical : valueText;
    const scroll = node("div", "library-field-table-scroll"), table = node("table", "library-field-table"), head = node("thead"), headings = node("tr"), body = node("tbody");
    const caption = Array.isArray(field.table_captions) ? field.table_captions[index] : null;
    // Technical-table captions are retained as source/audit metadata, not UI copy.
    // Keep the table's field and position as its concise accessible name.
    const hasCaption = kind !== "technical" && typeof caption === "string" && caption.trim();
    const label = `${field.label || "Source"} table${total > 1 ? ` ${index + 1}` : ""}${hasCaption ? `: ${caption}` : ""}`;
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", label);
    table.setAttribute("aria-label", label);
    if (hasCaption) table.append(node("caption", "", caption));
    // Generated configuration labels stay in the source evidence, not the UI.
    // Map retained columns by their original index so row values stay aligned.
    const columns = displayedColumns(field.table);
    for (const { label } of columns) { const cell = node("th", frlLabel(label) ? "library-frl-value" : "", display(label)); cell.setAttribute("scope", "col"); headings.append(cell); }
    head.append(headings);
    for (const values of field.table.rows) { const row = node("tr"); row.append(...columns.map(column => node("td", frlLabel(column.label) ? "library-frl-value" : "", display(values[column.index])))); body.append(row); }
    table.append(head, body); scroll.append(table); return scroll;
  }
  function configurationLinks(field, targets) {
    if (!Array.isArray(field.table_links)) return [];
    const seen = new Set();
    return field.table_links.flatMap(reference => {
      if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).length !== 2 || !tableTargetLabels.has(reference.field) || field.label === reference.field || !Number.isSafeInteger(reference.table_index) || reference.table_index < 0) return [];
      const key = `${reference.field}:${reference.table_index}`, fieldTargets = targets.get(reference.field) || [];
      if (seen.has(key)) return [];
      const target = fieldTargets[reference.table_index];
      if (!target) return [];
      seen.add(key);
      const label = `View ${tableTargetLabels.get(reference.field)} table${fieldTargets.length > 1 ? ` ${reference.table_index + 1}` : ""}`;
      const link = node("a", "library-configuration-link", label); link.href = `#${target.id}`;
      link.addEventListener("click", event => {
        event.preventDefault();
        const headerBottom = document.querySelector(".app-header")?.getBoundingClientRect().bottom;
        target.style.scrollMarginTop = `${Number.isFinite(headerBottom) ? Math.max(0, headerBottom) + 16 : 16}px`;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start", inline: "nearest" });
      });
      return [link];
    });
  }
  function detailNavigation(pane) {
    const nav = node("nav", "library-detail-navigation"); uiAttr(nav, "aria-label", "Library record navigation");
    const results = symbolButton("←", "Back to results", () => { state.history = []; showList(pane); pane.searchInput.focus(); }); results.dataset.libraryBackToResults = pane.kind; nav.append(results);
    if (state.history.length) { const previous = uiButton("Back to previous item", back, "button secondary"); previous.dataset.libraryBack = pane.kind; nav.append(previous); }
    return nav;
  }
  function technicalDocumentMenu(pane, data) {
    const wrapper = node("div", "calculator-document-menu library-document-menu");
    const toggle = button("", () => { if (!toggle.disabled) setOpen(list.hidden); }, "button secondary calculator-document-toggle");
    const icon = node("img", "calculator-document-icon"); icon.src = "/icons/document.png"; icon.alt = ""; icon.width = icon.height = 24;
    const chevron = node("span", "calculator-document-chevron"); chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>';
    toggle.append(icon, uiNode("span", "", "Document"), chevron);
    const list = node("div", "calculator-document-actions"); list.id = "technical-item-document-actions"; list.hidden = true;
    list.setAttribute("role", "group"); uiAttr(list, "aria-label", "Technical item downloads");
    toggle.setAttribute("aria-controls", list.id); toggle.setAttribute("aria-expanded", "false");
    const revision = pane.detailRevision, id = data.id, actions = [];
    const current = () => state.current === "technical" && pane.selected === id && pane.detailRevision === revision && !pane.detailPanel.hidden;
    function setOpen(open, focus = false) {
      list.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
      if (focus) toggle.focus();
    }
    async function download(format, button) {
      if (!current() || pane.documentPending) return;
      setOpen(false);
      const token = { id, revision }; pane.documentPending = token;
      for (const control of pane.documentControls) control.disabled = true;
      try {
        if (!window.CeasefireDownloads?.save) throw new Error("Document downloads are unavailable. Reopen the application and try again.");
        const result = await window.CeasefireDownloads.save(`/api/technical/item.${format}`, { id }, { button });
        if (current()) message(pane, "Item Details saved: {0}", false, [result.filename]);
      } catch (error) {
        if (current()) message(pane, "Item Details were not downloaded. {0}", true, [() => window.CeasefireI18n?.translate(error.message) || error.message]);
      } finally {
        if (pane.documentPending === token) {
          pane.documentPending = null;
          for (const control of pane.documentControls) control.disabled = false;
        }
      }
    }
    for (const format of ["pdf", "xlsx"]) {
      const action = button("", () => download(format, action), `button ${format === "pdf" ? "pdf" : "excel"}-button calculator-document-action`);
      uiAttr(action, "aria-label", "Download Item Details {0}", [format.toUpperCase()]);
      const mark = node("span", "download-format-icon"); mark.setAttribute("aria-hidden", "true");
      mark.append(node("span", "download-arrow", "⇩"), node("span", "download-format", format.toUpperCase()));
      action.append(mark, uiNode("span", "", "Item Details")); actions.push(action); list.append(action);
    }
    pane.documentControls = [toggle, ...actions];
    for (const control of pane.documentControls) control.disabled = !!pane.documentPending;
    wrapper.append(toggle, list);
    wrapper.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key) || toggle.disabled) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { setOpen(false, true); return; }
      const index = actions.indexOf(document.activeElement);
      setOpen(true);
      const next = event.key === "Home" ? 0 : event.key === "End" ? actions.length - 1
        : event.key === "ArrowDown" ? (index + 1) % actions.length : index < 0 ? actions.length - 1 : (index + actions.length - 1) % actions.length;
      actions[next].focus();
    });
    const outside = event => { if (!wrapper.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside);
    pane.documentCleanup = () => {
      setOpen(false); document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      pane.documentCleanup = null;
    };
    return wrapper;
  }
  function relatedTechnicalSection(data, display) {
    if (!Array.isArray(data.related_technical_records)) return null;
    if (data.related_technical_records.length > 5000) return null;
    const seen = new Set(), records = data.related_technical_records.filter(link => {
      if (link?.kind !== "technical" || typeof link.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(link.id) || seen.has(link.id)) return false;
      seen.add(link.id); return true;
    });
    if (!records.length) return null;
    const section = node("section", "library-detail-section library-technical-related");
    section.append(uiNode("h4", "", "Related Technical records"));
    const list = node("div", "library-technical-related-list"); section.append(list);
    let shown = 0;
    const more = uiButton("Show more related records", () => appendPage(true), "button secondary");
    function appendPage(focus = false) {
      let first = null;
      for (const link of records.slice(shown, shown + 50)) {
        const row = node("div", "library-related-record"), details = node("div", "library-related-content");
        const title = window.LibraryDetailText.displayTitle(link) || "Reference unavailable";
        const action = button(display(title), () => navigate("technical", link.id), "library-record-link");
        action.dataset.libraryTechnicalTarget = link.id;
        first ||= action;
        details.append(action); row.append(details); list.append(row);
      }
      shown = Math.min(records.length, shown + 50); more.hidden = shown >= records.length;
      if (focus) first?.focus({ preventScroll: true });
    }
    appendPage();
    if (records.length > 50) section.append(more);
    return section;
  }
  function renderDetail(pane) {
    pane.documentCleanup?.();
    const display = ["technical", "penetration"].includes(pane.kind) ? compactTechnical : valueText;
    const data = pane.detail, heading = node("h3", "", display(window.LibraryDetailText.displayTitle(data)));
    if (pane.kind === "technical") heading.classList.add("library-frl-value");
    // Legacy Firefly report imports predate the Manufacturer field.
    const firefly = /^fas19023[456]-/i.test(String(data.id)) || (data.fields || []).some(field => String(field.label).trim().toLowerCase() === "manufacturer" && /\bfirefly\b/i.test(String(field.value)));
    heading.id = `${pane.kind}-library-detail-heading`; heading.tabIndex = -1; pane.detailPanel.setAttribute("aria-labelledby", heading.id);
    for (const key of pane.quantityBadges.keys()) if (key.startsWith("detail:")) pane.quantityBadges.delete(key);
    const title = node("div", `library-record-heading${pane.kind === "technical" ? " library-technical-heading" : ""}`);
    title.append(heading, pane.kind === "penetration" ? quantityBadge(pane, data.id, "detail") : technicalDocumentMenu(pane, data));
    const content = [detailNavigation(pane), title];
    const subtitle = window.LibraryDetailText.displaySubtitle(data);
    if (subtitle) content.push(node("p", "library-subtitle library-frl-value", display(subtitle)));
    for (const key of pane.scheduleButtons.keys()) if (key.startsWith("detail:")) { pane.scheduleButtons.delete(key); pane.actionMessages.delete(key); }
    for (const key of pane.deleteButtons.keys()) if (key.startsWith("detail:")) pane.deleteButtons.delete(key);
    pane.unlinkButtons.clear();
    if (data.price || pane.kind === "penetration") {
      const commercial = node("div", "library-record-commercial");
      if (data.price) commercial.append(node("p", "library-record-price", `${priceLabel(data.price)}: ${priceText(data.price)}`));
      if (pane.kind === "penetration") commercial.append(itemActions(pane, data, "detail"));
      content.push(commercial);
    }
    if (data.notice) content.push(node("p", "library-record-notice", display(data.notice)));
    const fields = node("dl", "library-record-fields");
    // Omit only supplier selector numbers. Real technical IDs remain visible;
    // all original fields and durable reference targets retain their exact IDs.
    const visibleFields = (data.fields || []).filter(field => window.LibraryDetailText.visibleField(data, field, pane.kind));
    const tablesByField = new Map(visibleFields.map(field => [field, fieldTables(field).map((table, index, tables) => {
      if (!validFieldTable(table) || !displayedColumns(table).length) return null;
      const target = fieldTable({ ...field, table }, index, tables.length, pane.kind);
      target.id = tableAnchor(pane.kind, data.id, field.label, index);
      return target;
    })]));
    const configurationTargets = new Map();
    if (pane.kind === "technical") for (const label of tableTargetLabels.keys()) {
      const matches = visibleFields.filter(field => field.label === label);
      if (matches.length === 1) configurationTargets.set(label, tablesByField.get(matches[0]));
    }
    let diagramStatusShown = false;
    for (const field of visibleFields) {
      const pair = node("div", "library-record-field"), value = node("dd");
      if (frlLabel(field.label)) value.classList.add("library-frl-value");
      const images = (field.images || []).filter(item => validAssetId(item.id));
      const tables = tablesByField.get(field).filter(Boolean), links = configurationLinks(field, configurationTargets);
      const imageOnly = firefly && field.label === "Diagrams & Figures";
      if (imageOnly && !images.length) continue;
      const boss = (data.fields || []).some(f => f.label === "Manufacturer" && f.value === "BOSS");
      const formatted = ["Installation Details", "Local Protection"].includes(field.label) || boss && field.label === "Barrier Construction" || firefly && ["Service Wrap", configurationField].includes(field.label);
      if (pane.kind === "technical" && !images.length && !tables.length && !links.length && String(field.value ?? "").trim() === "") continue;
      const reportLinks = pane.kind === "technical" && field.label === "Report Number" && Array.isArray(field.report_links) ? field.report_links : [];
      const reportLabels = String(field.value ?? "").split(/\n/).map(x => x.trim()).filter(Boolean);
      const reportPositions = reportLinks.map(link => reportLabels.indexOf(link?.label));
      const validReports = reportLinks.length > 0 && reportLinks.length <= 20 && new Set(reportLabels).size === reportLabels.length && reportLinks.every((link, i) => {
        if (reportPositions[i] < 0 || i > 0 && reportPositions[i] <= reportPositions[i - 1] || typeof link.url !== "string" || /[\s<>"\\\x00-\x1f\x7f]/.test(link.url)) return false;
        if (link.url === "https://systems.tbafirefly.com.au/reports") return true;
        try { const u = new URL(link.url); return u.protocol === "https:" && !u.username && !u.password && (
          ["media.promat.com", "etex.azureedge.net"].includes(u.host) && /\.pdf$/i.test(u.pathname) ||
          u.host === "tfire.com.au" && /^https:\/\/tfire\.com\.au\/documents\/[A-Za-z0-9][A-Za-z0-9_.()=-]*$/.test(link.url) ||
          u.host === "bossfire.com" && /^https:\/\/bossfire\.com\/documents\/test-reports\/[A-Za-z0-9][A-Za-z0-9_.()-]*\.pdf$/i.test(link.url)
        ); } catch { return false; }
      });
      if (validReports) {
        // Captions retain separate canonical lines for every API/export parser.
        // Only the reviewed display requests a safe literal inline separator.
        const inline = field.report_separator === " | ", paragraph = inline ? node("p") : null;
        for (const [index, label] of reportLabels.entries()) {
          const p = paragraph || node("p"), report = reportLinks.find(link => link.label === label);
          if (inline && index) p.append(node("span", "", " | "));
          if (report) { const a = node("a", "", display(label)); a.href = report.url; a.target = "_blank"; a.rel = "noopener noreferrer"; p.append(a); }
          else if (inline) p.append(node("span", "", display(label)));
          else p.textContent = display(label);
          if (!inline) value.append(p);
        }
        if (paragraph) value.append(paragraph);
      } else if (formatted) {
        const blocks = window.LibraryDetailText.render(document, field.value ?? "", { sourceMarkers: firefly, compact: ["technical", "penetration"].includes(pane.kind) });
        if (blocks.length) { const prose = node("div", "library-detail-text"); prose.append(...blocks); value.append(prose); }
        else if (!images.length && !tables.length && !links.length) continue;
      } else if (!imageOnly && (!images.length && !tables.length && !links.length || field.value !== null && field.value !== undefined && field.value !== "")) value.textContent = display(pane.kind === "technical" && field.label === "FRL" ? frlDisplayValue(field, visibleFields) : field.value);
      if (pane.kind === "technical" && field.label === "Diagrams & Figures" && data.diagram_status) {
        value.append(node("p", "helper library-diagram-status", display(data.diagram_status))); diagramStatusShown = true;
      }
      if (tables.length) { pair.className += " library-record-field-table"; value.append(...tables); }
      if (links.length) { const navigation = node("div", "library-table-links"); navigation.append(...links); value.append(navigation); }
      if (images.length) { const gallery = node("div", "library-images library-field-images"); gallery.append(...images.map(item => imageNode(item, pane.kind, imageOnly, pane.detail.image_replicas))); value.append(gallery); }
      pair.append(uiNode("dt", "", display(fieldLabel(pane.kind, field.label, field.column) || "Field")), value); fields.append(pair);
    }
    content.push(fields);
    if (pane.kind === "technical" && data.diagram_status && !diagramStatusShown) content.push(node("p", "helper library-diagram-status", display(data.diagram_status)));
    const images = data.diagram?.custom && validDiagramUrl(data.diagram.url)
      ? [{ url: data.diagram.url, caption: "Source diagram" }]
      : (data.images || []).filter(item => validAssetId(item.id));
    if (images.length) { const gallery = node("section", "library-images"); uiAttr(gallery, "aria-label", "Source diagrams"); gallery.append(...images.map(item => imageNode(item, pane.kind, false, pane.detail.image_replicas))); content.push(gallery); }
    const technicalRelated = pane.kind === "technical" ? relatedTechnicalSection(data, display) : null;
    if (technicalRelated) content.push(technicalRelated);
    const related = node("section", "library-detail-section"), links = data.links || [];
    related.append(uiNode("h4", "", pane.kind === "penetration" ? "Related technical references" : "Related firestopping records"));
    if (!links.length) related.append(uiNode("p", "helper", "No related records are recorded."));
    for (const link of links) {
      const box = node("div", "library-related-record"), details = node("div", "library-related-content");
      const relatedTitle = window.LibraryDetailText.displayTitle(link) || "Reference unavailable";
      if (kinds.includes(link.kind) && validId(link.id)) { const action = button(display(relatedTitle), () => navigate(link.kind, link.id), "library-record-link"); action.dataset.libraryRelated = link.id; details.append(action); }
      else details.append(node("p", "", display(relatedTitle)));
      if (link.notice) details.append(node("p", "library-related-notice", display(link.notice)));
      const penetrationId = pane.kind === "penetration" ? data.id : link.id, technicalId = pane.kind === "technical" ? data.id : link.id, key = `${penetrationId}:${technicalId}`;
      const label = pane.kind === "penetration" ? `Unlink technical reference ${relatedTitle}` : `Unlink firestopping record ${relatedTitle}`;
      const remove = symbolButton("🗑", label, () => unlinkReference(pane, data, link)); remove.className += " library-unlink"; remove.dataset.libraryUnlink = key; remove.disabled = pane.unlinkPending.has(key); pane.unlinkButtons.set(`${data.id}:${key}`, remove);
      box.append(details, remove);
      related.append(box);
    }
    content.push(related);
    // Item qualifications belong in the card that receives navigation focus;
    // keep only the general library notices above that card.
    pane.detailPanel.replaceChildren(...content); updateNotice(pane, {});
    if (state.current === pane.kind && $("library-" + pane.kind)?.hidden === false && $("view-pricing")?.hidden === false) {
      heading.focus({ preventScroll: true }); pane.detailPanel.scrollIntoView?.({ block: "start" });
    }
  }
  async function loadDetail(pane, id) {
    pane.documentCleanup?.();
    clearTimeout(pane.timer); invalidateList(pane);
    pane.selected = id; pane.detailAbort?.abort(); const revision = ++pane.detailRevision;
    pane.detailAbort = new AbortController(); pane.list.hidden = true; pane.detailPanel.hidden = false; message(pane);
    pane.detailPanel.replaceChildren(detailNavigation(pane), uiNode("p", "empty-state", "Loading record…")); pane.detailPanel.setAttribute("aria-busy", "true");
    try {
      const data = await request(`/api/libraries/${pane.kind}/${encodeURIComponent(id)}`, pane.detailAbort.signal);
      if (revision !== pane.detailRevision || id !== pane.selected) return;
      pane.detail = data; renderDetail(pane);
    } catch (error) {
      if (revision !== pane.detailRevision || error.name === "AbortError") return;
      pane.detailPanel.replaceChildren(detailNavigation(pane), node("p", "message error", error.message), uiButton("Retry record", () => loadDetail(pane, id), "button secondary"));
    } finally { if (revision === pane.detailRevision) pane.detailPanel.setAttribute("aria-busy", "false"); }
  }
  async function open(kind, selection) {
    if (!kinds.includes(kind)) return;
    for (const existing of state.panes.values()) { closeLinkPicker(existing); existing.documentCleanup?.(); }
    state.current = kind; const pane = paneFor(kind), revision = ++pane.openRevision;
    renderProjectDrafts(pane);
    if (kind === "penetration" && validId(selection) && window.CeasefireLibraryEditor?.projectRecords?.().some(record => record.id === selection)) {
      pane.list.hidden = false; pane.detailPanel.hidden = true; return;
    }
    try {
      if (!pane.count.textContent) uiText(pane.count, "Loading library…");
      const data = await metadata();
      if (revision !== pane.openRevision) return;
      const info = data.libraries?.find(library => library.id === kind); updateNotice(pane); renderSummary(pane);
      if (info?.available === false) {
        pane.data = null;
        pane.list.hidden = false; pane.detailPanel.hidden = true; uiText(pane.count, "Library unavailable.");
        pane.results.replaceChildren(node("p", "empty-state", info.notice || "The local source library is unavailable.")); setBusy(pane, false); return;
      }
      if (selection?.list) await showList(pane);
      else if (validId(selection)) await loadDetail(pane, selection);
      else if (pane.selected) { if (pane.detail) renderDetail(pane); else await loadDetail(pane, pane.selected); }
      else { pane.list.hidden = false; pane.detailPanel.hidden = true; if (!pane.data || pane.dataQuery !== queryFor(pane)) await loadList(pane); }
    } catch (error) {
      if (revision !== pane.openRevision) return;
      uiText(pane.count, "Library unavailable."); message(pane, "{0} Use Refresh to try again.", true, [() => window.CeasefireI18n?.translate(error.message) || error.message]);
    }
  }
  async function refresh(pane) {
    invalidateList(pane); pane.data = null; pane.detail = null; pane.filterStamp = null;
    state.metadata = null; state.metadataRequest = null; await open(pane.kind, pane.selected || { list: true });
  }
  function invalidate() {
    state.metadata = null; state.metadataRequest = null;
    for (const pane of state.panes.values()) pane.documentCleanup?.();
    for (const pane of state.panes.values()) { invalidateList(pane); ++pane.detailRevision; pane.detailAbort?.abort(); pane.data = null; pane.dataQuery = null; pane.detail = null; }
  }
  function renderProjectDrafts(pane) {
    const records = pane.kind === "penetration" ? window.CeasefireLibraryEditor?.projectRecords?.() || [] : [];
    pane.projectDrafts.hidden = !records.length; pane.projectDrafts.replaceChildren();
    if (!records.length) return;
    pane.projectDrafts.append(uiNode("h3", "", "Project library drafts"), uiNode("p", "helper", "These item details and diagrams belong to this project. Save stores them with the project file."));
    const choices = node("div", "actions");
    for (const record of records) { const edit = button(record.title || record.library_id || record.id, () => editItem(pane, record.id)); edit.dataset.projectLibraryDraft = record.id; choices.append(edit); }
    pane.projectDrafts.append(choices);
  }
  function projectChanged() { for (const pane of state.panes.values()) renderProjectDrafts(pane); }
  window.CeasefireLibraries = { open, invalidate, scheduleChanged, projectChanged, appendFilterOptions };
})();
