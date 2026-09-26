(() => {
  "use strict";
  const kinds = ["penetration", "technical"], titles = { penetration: "Firestopping Library", technical: "Technical Library" };
  const state = { current: null, metadata: null, metadataRequest: null, panes: new Map(), history: [] };
  const $ = id => document.getElementById(id);
  const node = (tag, className = "", text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const priceText = price => typeof price?.amount === "number" && Number.isFinite(price.amount) ? money.format(price.amount) : "Price unavailable";
  const priceLabel = price => String(price?.label || "").trim().toLowerCase() === "workbook price" ? "Library price" : price?.label || "Library price";
  const hiddenFields = new Set(["diagram captions (visually checked)", "workbook report revision", "reference review"]);
  const hiddenTechnicalFields = new Set(["source table notes", "source option alignment", "technical basis", "lead time"]);
  const visibleField = (kind, field) => {
    const label = String(field.label || "").trim().toLowerCase();
    if (hiddenFields.has(label) || kind === "technical" && hiddenTechnicalFields.has(label)) return false;
    return kind !== "technical" || String(field.value ?? "").trim() !== "" || field.images?.length || field.table || field.tables?.length || field.table_links?.length;
  };
  const fieldLabel = (kind, label) => kind !== "penetration" ? label
    : label === "Type" ? "Category"
    : ["Item(s)", "Items/Services"].includes(label) ? "Description"
    : ["System", "System Install", "System/Install"].includes(label) ? "System/Install Details" : label;
  const diagramCaption = (kind, caption) => (kind === "penetration" ? String(caption || "").replace(/(?:^|\s+|\s*[·|—–-]\s*)(?:'?CALC'?!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|CALC\s+row\s+\d+)\s*$/i, "").trim() : caption) || "Source diagram";
  const validId = value => typeof value === "string" && value.length > 0;
  const validAssetId = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const validDiagramUrl = value => typeof value === "string" && /^\/api\/libraries\/penetration\/[a-z0-9][a-z0-9_-]{0,119}\/image$/.test(value);
  const integer = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const valueText = value => value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const button = (text, action, className = "button secondary") => { const el = node("button", className, text); el.type = "button"; el.addEventListener("click", action); return el; };
  const symbolButton = (symbol, label, action) => {
    const el = button("", action, "button secondary icon-only");
    const icon = node("span", "button-symbol", symbol); icon.setAttribute("aria-hidden", "true");
    el.append(icon); el.title = label; el.setAttribute("aria-label", label); return el;
  };
  async function request(path, signal, payload) {
    const response = await fetch(path, { headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(signal ? { signal } : {}), ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `The library could not be read (${response.status}).`);
    return data;
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
  function message(pane, text = "", error = false) {
    pane.message.textContent = text; pane.message.hidden = !text;
    pane.message.className = `message${error ? " error" : " info"}`;
  }
  function paneFor(kind) {
    if (state.panes.has(kind)) return state.panes.get(kind);
    const pane = { kind, search: "", filters: {}, offset: 0, limit: 50, data: null, dataQuery: null, detail: null, selected: null,
      listRevision: 0, detailRevision: 0, openRevision: 0, listAbort: null, detailAbort: null, timer: null, filterStamp: null, busy: false,
      linkSession: null, addPending: new Map(), addErrors: new Map(), deletePending: new Set(), deleteButtons: new Map(), unlinkPending: new Set(), unlinkButtons: new Map(),
      scheduleButtons: new Map(), actionMessages: new Map(), quantityBadges: new Map() };
    const root = $(kind + "-library-workspace");
    pane.message = node("div", "message"); pane.message.hidden = true; pane.message.setAttribute("role", "status");
    pane.notice = node("p", "helper library-notice"); pane.notice.hidden = true;
    pane.summary = node("section", "card library-summary"); pane.summary.hidden = true; pane.summary.dataset.librarySummary = kind;
    pane.linkPanel = node("section", "card library-link-picker"); pane.linkPanel.hidden = true; pane.linkPanel.dataset.libraryLinkPicker = kind;
    pane.list = node("section", "card library-browser"); pane.list.setAttribute("aria-label", titles[kind] + " records");
    const controls = node("div", "library-controls"), label = node("label", "field library-search");
    pane.searchInput = node("input"); pane.searchInput.type = "search"; pane.searchInput.maxLength = 400;
    pane.searchInput.placeholder = kind === "penetration" ? "Search firestopping records…" : "Search systems and technical references…";
    pane.searchInput.dataset.librarySearch = kind;
    label.append(node("span", "", `Search ${titles[kind]}`), pane.searchInput);
    pane.refresh = symbolButton("↻", "Refresh", () => refresh(pane)); pane.refresh.className += " refresh-button"; pane.refresh.dataset.libraryRefresh = kind;
    controls.append(label, pane.refresh); pane.filterControls = node("div", "library-filters");
    pane.count = node("p", "helper library-count"); pane.count.setAttribute("role", "status"); pane.count.dataset.libraryCount = kind;
    pane.results = node("div", "library-results"); pane.results.dataset.libraryResults = kind;
    pane.results.setAttribute("aria-busy", "false");
    pane.previous = button("Previous", () => changePage(pane, Math.max(0, pane.offset - pane.limit)));
    pane.next = button("Next", () => changePage(pane, pane.offset + pane.limit));
    pane.previous.dataset.libraryPrevious = kind; pane.next.dataset.libraryNext = kind;
    pane.previous.disabled = pane.next.disabled = true;
    const pagination = node("nav", "library-pagination"); pagination.setAttribute("aria-label", titles[kind] + " result pages"); pagination.append(pane.previous, pane.next);
    pane.list.append(controls, pane.filterControls, pane.count, pane.results, pagination);
    pane.detailPanel = node("section", "card library-detail"); pane.detailPanel.hidden = true; pane.detailPanel.dataset.libraryDetail = kind;
    root.replaceChildren(pane.message, pane.summary, pane.notice, pane.linkPanel, pane.list, pane.detailPanel);
    pane.searchInput.addEventListener("input", () => {
      pane.search = pane.searchInput.value.trim(); pane.offset = 0;
      invalidateList(pane); pane.count.textContent = "Searching…";
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
  function renderFilters(pane, filters) {
    const safeFilters = (Array.isArray(filters) ? filters : []).filter(filter => typeof filter.key === "string" && !["search", "offset", "limit", "technical_reference"].includes(filter.key));
    if (pane.kind === "penetration") safeFilters.push({ key: "technical_reference", label: "Technical Reference", options: [{ value: "linked", label: "Linked Technical References" }, { value: "unlinked", label: "No Linked Technical References" }] });
    const stamp = JSON.stringify([safeFilters, pane.filters]); if (stamp === pane.filterStamp) return;
    pane.filterStamp = stamp;
    pane.filterControls.replaceChildren(...safeFilters.map(filter => {
      const reference = filter.key === "technical_reference", label = node("label", "field"), control = node("select"), all = node("option", "", reference ? "Any" : `All ${filter.label || filter.key}`); all.value = reference ? "any" : "";
      control.dataset.libraryFilter = filter.key; control.append(all);
      for (const option of filter.options || []) {
        const value = typeof option === "object" ? option.value : option, text = typeof option === "object" ? option.label : option;
        const el = node("option", "", text ?? value); el.value = String(value); control.append(el);
      }
      const selected = pane.filters[filter.key] || (reference ? "any" : "");
      if (selected && ![...control.children].some(option => option.value === selected)) { const el = node("option", "", selected); el.value = selected; control.append(el); }
      control.value = selected;
      control.addEventListener("change", () => { pane.filters[filter.key] = control.value; pane.offset = 0; loadList(pane); });
      label.append(node("span", "", filter.label || filter.key), control); return label;
    }));
  }
  function renderList(pane) {
    const data = pane.data, items = Array.isArray(data.items) ? data.items : [];
    pane.offset = integer(data.offset, pane.offset); pane.limit = integer(data.limit, pane.limit) || 50;
    const total = integer(data.total);
    pane.count.textContent = total ? `Showing ${pane.offset + 1}–${Math.min(pane.offset + items.length, total)} of ${total} records` : "No matching records.";
    for (const key of pane.scheduleButtons.keys()) if (key.startsWith("list:")) { pane.scheduleButtons.delete(key); pane.actionMessages.delete(key); }
    for (const key of pane.deleteButtons.keys()) if (key.startsWith("list:")) pane.deleteButtons.delete(key);
    for (const key of pane.quantityBadges.keys()) if (key.startsWith("list:")) pane.quantityBadges.delete(key);
    pane.results.replaceChildren(...(items.length ? items.map(item => {
      const card = node("article", "library-result"), title = button(item.title || item.id, () => navigate(pane.kind, item.id), "library-record-link");
      title.dataset.libraryRecord = item.id;
      if (pane.kind === "penetration") { const heading = node("div", "library-record-heading"); heading.append(title, quantityBadge(pane, item.id, "list")); card.append(heading); }
      else card.append(title);
      if (item.subtitle) card.append(node("p", "library-subtitle", item.subtitle));
      if (item.price) card.append(node("p", "library-record-price", `${priceLabel(item.price)}: ${priceText(item.price)}`));
      if (item.summary) card.append(node("p", "library-excerpt", valueText(item.summary)));
      if (pane.kind !== "penetration" && item.source_label) card.append(node("p", "helper", item.source_label));
      if (Number.isSafeInteger(item.related_count)) card.append(node("p", "helper", `${item.related_count} related ${pane.kind === "penetration" ? "technical references" : "firestopping records"}`));
      if (pane.kind === "penetration") card.append(itemActions(pane, item, "list"));
      return card;
    }) : [node("p", "empty-state", "Try a different search or filter.")]));
    renderFilters(pane, data.filters || libraryInfo(pane)?.filters || []); renderSummary(pane); setBusy(pane, false);
  }
  function renderSummary(pane) {
    if (pane.kind !== "penetration") return;
    const info = libraryInfo(pane), counts = pane.data?.counts;
    const table = node("table", "library-summary-table"), head = node("thead"), row = node("tr"), body = node("tbody");
    table.append(node("caption", "", "Firestopping Library summary"));
    for (const label of ["Breakdown", "Records"]) { const cell = node("th", "", label); cell.setAttribute("scope", "col"); row.append(cell); }
    const addRow = (label, value, className = "") => {
      const line = node("tr", className), heading = node("th", "", label); heading.setAttribute("scope", "row");
      line.append(heading, node("td", "", Number.isSafeInteger(value) && value >= 0 ? value : "—")); body.append(line);
    };
    addRow("Total records", counts?.total ?? info?.count, "library-summary-total");
    for (const entry of Array.isArray(counts?.manufacturers) ? counts.manufacturers : []) addRow(entry.name, entry.count, "library-summary-manufacturer");
    addRow("No related technical references", counts?.unlinked ?? info?.unlinked_count, "library-summary-related");
    head.append(row); table.append(head, body); pane.summary.replaceChildren(table); pane.summary.hidden = false;
  }
  function actionContext(pane) { return JSON.stringify([state.current, pane.openRevision, pane.selected, pane.search, pane.filters, pane.offset]); }
  function updateQuantity(badge, id) {
    const quantity = window.CeasefirePenetrations?.libraryQuantity?.(id);
    const available = typeof quantity === "number" && Number.isFinite(quantity);
    badge.hidden = quantity === undefined;
    badge.textContent = available ? `Quantity: ${quantity}` : "Quantity unavailable";
    badge.setAttribute("aria-label", available ? `Current schedule quantity: ${quantity}` : "Current schedule quantity unavailable");
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
    if (item.editable) { const edit = button("Edit", () => editItem(pane, item.id), "button library-edit-button"); edit.dataset.libraryEdit = item.id; actions.append(edit); }
    const link = symbolButton("🔗︎", "Link Library Item", () => openLinkPicker(pane, item, link)); link.className += " link-action-button"; link.dataset.libraryLink = item.id;
    const add = button("", () => addToSchedule(pane, item.id), "button primary penetration-add-action");
    const plus = node("span", "", "+"); plus.setAttribute("aria-hidden", "true");
    add.append(plus, node("span", "sr-only", "Add to Schedule"));
    add.dataset.libraryAdd = item.id; add.title = "Add to Schedule"; add.setAttribute("aria-label", "Add to Schedule");
    const status = node("p", "message error library-action-message", pane.addErrors.get(item.id) || ""); status.hidden = !status.textContent; status.setAttribute("role", "status");
    const remove = button("", () => deleteItem(pane, item), "button library-delete library-delete-button");
    const icon = node("span", "library-trash-icon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 10.5v6M14 10.5v6"></path></svg>';
    icon.setAttribute("aria-hidden", "true"); remove.append(icon);
    remove.title = `Remove ${item.title || item.id} from the Firestopping Library`;
    remove.setAttribute("aria-label", remove.title); remove.dataset.libraryDelete = item.id;
    remove.disabled = pane.deletePending.has(item.id); pane.deleteButtons.set(`${place}:${item.id}`, remove);
    add.disabled = pane.addPending.has(item.id); pane.scheduleButtons.set(`${place}:${item.id}`, add); pane.actionMessages.set(`${place}:${item.id}`, status); actions.append(link, add, remove, status); return actions;
  }
  async function deleteItem(pane, item) {
    const id = item.id;
    if (pane.deletePending.has(id)) return;
    const confirm = window.CeasefirePenetrationNavigation?.confirm;
    if (!confirm) { message(pane, "The deletion confirmation is unavailable. Reload the application and try again.", true); return; }
    if (!await confirm("Remove Firestopping Library item?", `${item.title || id} will be removed from the Firestopping Library.`, "Remove item")) return;
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
        message(pane, `${item.title || id} was removed from the Firestopping Library.`);
      }
    } catch (error) {
      message(pane, `The library item was not removed. ${error.message}`, true);
    } finally {
      pane.deletePending.delete(id);
      for (const control of pane.deleteButtons.values()) if (control.dataset.libraryDelete === id) control.disabled = false;
    }
  }
  async function addToSchedule(pane, id) {
    if (pane.addPending.has(id)) return;
    const token = {}, context = actionContext(pane); pane.addPending.set(id, token); pane.addErrors.delete(id); message(pane);
    for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { status.textContent = ""; status.hidden = true; }
    for (const control of pane.scheduleButtons.values()) if (control.dataset.libraryAdd === id) control.disabled = true;
    try {
      const receipt = await window.CeasefirePenetrations.addLibraryItem(id);
      scheduleChanged();
      if (context === actionContext(pane) && receipt?.added) {
        const text = receipt.message || "Added to the Firestopping Schedule using its current prices and allowances.";
        for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) {
          status.textContent = text; status.hidden = false; status.className = "message library-action-message";
        }
      }
    }
    catch (error) {
      if (context === actionContext(pane)) {
        const text = `The library item could not be added to the schedule. ${error.message}`; pane.addErrors.set(id, text);
        for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { status.textContent = text; status.hidden = false; status.className = "message error library-action-message"; }
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
    session.message.textContent = text; session.message.hidden = !text; session.message.className = `message${error ? " error" : " info"}`;
  }
  function updateLinkSave(session) {
    const count = session.selected.size;
    session.save.textContent = count ? `Save links (${count})` : "Save links";
    session.save.disabled = !count || session.busy || session.saving;
  }
  function openLinkPicker(pane, item, opener) {
    closeLinkPicker(pane); invalidateList(pane); message(pane);
    const session = { id: item.id, search: "", offset: 0, limit: 20, total: 0, selected: new Set(), revision: 0, abort: null, timer: null, busy: false, saving: false, choices: [] };
    pane.linkSession = session; pane.list.hidden = pane.detailPanel.hidden = true; pane.linkPanel.hidden = false;
    const heading = node("h3", "", "Link Library Item"); heading.id = "library-link-heading"; heading.tabIndex = -1; pane.linkPanel.setAttribute("aria-labelledby", heading.id);
    const cancel = button("Cancel", async () => {
      if (pane.linkSession !== session || session.saving) return;
      closeLinkPicker(pane); const revision = pane.openRevision + 1; await open(pane.kind, pane.selected || { list: true });
      if (state.current === pane.kind && pane.openRevision === revision && !pane.linkSession) (opener.isConnected === false ? pane.searchInput : opener).focus({ preventScroll: true });
    }); cancel.dataset.libraryLinkCancel = ""; session.cancel = cancel;
    const controls = node("div", "library-controls"), label = node("label", "field library-search"); session.searchInput = node("input"); session.searchInput.type = "search"; session.searchInput.maxLength = 400; session.searchInput.dataset.libraryLinkSearch = "";
    label.append(node("span", "", "Search Technical Library"), session.searchInput);
    session.refresh = button("Search", () => loadLinkResults(pane, session)); controls.append(label, session.refresh);
    session.message = node("div", "message"); session.message.hidden = true; session.message.setAttribute("role", "status");
    session.count = node("p", "helper"); session.count.setAttribute("role", "status"); session.results = node("div", "library-link-results");
    session.previous = button("Previous", () => { session.offset = Math.max(0, session.offset - session.limit); loadLinkResults(pane, session); });
    session.next = button("Next", () => { session.offset += session.limit; loadLinkResults(pane, session); });
    session.save = button("Save links", () => saveLink(pane, session), "button link-action-button"); session.save.dataset.libraryLinkSave = ""; session.save.disabled = true;
    const pages = node("nav", "library-pagination"); pages.setAttribute("aria-label", "Technical reference choices"); pages.append(session.previous, session.next);
    const actions = node("div", "library-item-actions"); actions.append(session.save, cancel);
    pane.linkPanel.replaceChildren(heading, node("p", "library-subtitle", item.title || item.id), node("p", "helper", "Choose one or more Technical Library items to link."), controls, session.message, session.count, session.results, pages, actions);
    session.searchInput.addEventListener("input", () => {
      if (session.saving || pane.linkSession !== session) return;
      session.search = session.searchInput.value.trim(); session.offset = 0; session.busy = true; ++session.revision; session.abort?.abort(); clearTimeout(session.timer); session.save.disabled = session.previous.disabled = session.next.disabled = true; session.count.textContent = "Searching…";
      session.timer = setTimeout(() => loadLinkResults(pane, session), 250);
    });
    heading.focus({ preventScroll: true }); pane.linkPanel.scrollIntoView?.({ block: "start" }); loadLinkResults(pane, session);
  }
  async function loadLinkResults(pane, session) {
    if (pane.linkSession !== session || session.saving) return;
    clearTimeout(session.timer); session.abort?.abort(); session.abort = new AbortController(); const revision = ++session.revision;
    session.busy = true; session.save.disabled = session.previous.disabled = session.next.disabled = true;
    session.choices = []; session.results.replaceChildren(); session.results.setAttribute("aria-busy", "true"); session.count.textContent = "Searching…"; linkMessage(session);
    const query = new URLSearchParams({ search: session.search, offset: String(session.offset), limit: String(session.limit) });
    try {
      const data = await request(`/api/libraries/technical?${query}`, session.abort.signal);
      if (pane.linkSession !== session || revision !== session.revision) return;
      session.total = integer(data.total); session.offset = integer(data.offset, session.offset);
      const items = Array.isArray(data.items) ? data.items : [];
      session.count.textContent = session.total ? `Showing ${session.offset + 1}–${session.offset + items.length} of ${session.total} technical records` : "No matching technical records.";
      session.results.replaceChildren(...items.map(item => {
        const choice = node("label", "library-link-choice"), input = node("input"), description = node("span"); input.type = "checkbox"; input.value = item.id; input.checked = session.selected.has(item.id); input.dataset.libraryLinkChoice = item.id;
        description.append(node("strong", "", item.title || item.id)); if (item.subtitle) description.append(node("span", "helper", item.subtitle)); if (item.source_label) description.append(node("span", "helper", item.source_label));
        input.addEventListener("change", () => { if (pane.linkSession !== session || session.busy || session.saving) return; if (input.checked) session.selected.add(item.id); else session.selected.delete(item.id); updateLinkSave(session); }); session.choices.push(input); choice.append(input, description); return choice;
      }));
    } catch (error) { if (pane.linkSession === session && revision === session.revision && error.name !== "AbortError") { session.total = 0; session.count.textContent = "Technical records unavailable."; linkMessage(session, `${error.message} Use Search to retry.`, true); } }
    finally {
      if (pane.linkSession === session && revision === session.revision) { session.busy = false; session.results.setAttribute("aria-busy", "false"); updateLinkSave(session); session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
    }
  }
  async function saveLink(pane, session) {
    if (pane.linkSession !== session || session.saving || session.busy || !session.selected.size) return;
    const technicalIds = [...session.selected]; session.saving = true; session.save.disabled = session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = session.previous.disabled = session.next.disabled = true; linkMessage(session, "Saving links…");
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
      if (pane.linkSession === session) { session.saving = false; session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = false; for (const choice of session.choices) choice.disabled = false; updateLinkSave(session); session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
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
    if (!await confirm(`Unlink ${label}?`, `${link.title || link.id} will be unlinked from this library record.`, "Unlink")) return;
    pane.unlinkPending.add(key);
    for (const control of pane.unlinkButtons.values()) if (control.dataset.libraryUnlink === key) control.disabled = true;
    try {
      const receipt = await request(`/api/libraries/penetration/${encodeURIComponent(penetrationId)}/links/remove`, null, { technical_id: technicalId });
      if (receipt.unlinked !== true || receipt.penetration_id !== penetrationId || receipt.technical_id !== technicalId) throw new Error("The server did not confirm the removed reference link.");
      const sameRecord = state.current === pane.kind && pane.selected === item.id;
      invalidate();
      if (sameRecord) { await open(pane.kind, item.id); if (state.current === pane.kind && pane.selected === item.id) message(pane, `${label[0].toUpperCase()}${label.slice(1)} unlinked.`); }
    } catch (error) { message(pane, `The ${label} was not unlinked. ${error.message}`, true); }
    finally {
      pane.unlinkPending.delete(key);
      for (const control of pane.unlinkButtons.values()) if (control.dataset.libraryUnlink === key) control.disabled = false;
    }
  }
  async function editItem(pane, id) {
    message(pane);
    try { await window.CeasefireLibraryEditor.open(id); }
    catch (error) { message(pane, `The library item could not be opened for editing. ${error.message}`, true); }
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
      pane.results.replaceChildren(node("p", "empty-state", "The records could not be loaded.")); pane.count.textContent = "Records unavailable.";
      message(pane, `${error.message} Use Refresh to try again.`, true);
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
    closeLinkPicker(pane);
    ++pane.detailRevision; pane.detailAbort?.abort(); pane.selected = null; pane.detail = null;
    pane.detailPanel.hidden = true; pane.list.hidden = false; message(pane); updateNotice(pane);
    if (!pane.data || pane.dataQuery !== queryFor(pane)) return loadList(pane);
    renderFilters(pane, pane.data.filters || libraryInfo(pane)?.filters || []); setBusy(pane, false);
  }
  function sourceNode(source) {
    const box = node("article", "library-source"), heading = source.label || source.filename || "Source reference";
    if (validAssetId(source.document_id)) {
      const page = Number.isSafeInteger(source.page) && source.page > 0 ? source.page : null;
      const link = node("a", "library-record-link", heading);
      link.href = `/api/libraries/documents/${encodeURIComponent(source.document_id)}.pdf${page ? `#page=${page}` : ""}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${heading} — ${page ? `open PDF page ${page}` : "open PDF"} (new tab)`); box.append(link);
    } else box.append(node("span", "", heading));
    return box;
  }
  function imageNode(item, kind, imageOnly = false) {
    const figure = node("figure", "library-image"), link = node("a"), image = node("img");
    const captionText = diagramCaption(kind, item.caption);
    const caption = kind === "technical" && item.role ? `${item.role} — ${captionText}` : captionText;
    const savedUrl = kind === "penetration" && validDiagramUrl(item.url) ? item.url : null;
    link.href = savedUrl || `/api/libraries/images/${encodeURIComponent(item.id)}`; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open ${caption} at full size (new tab)`);
    image.src = link.href; image.alt = caption; image.loading = "lazy"; image.decoding = "async";
    link.append(image); figure.append(link);
    if (!imageOnly) figure.append(node("figcaption", "helper", caption));
    return figure;
  }
  const configurationField = "Service Size / Configuration";
  const tableTargetLabels = new Map([[configurationField, "configuration"], ["Barrier Construction", "barrier construction"]]);
  const fieldTables = field => [...(field.table ? [field.table] : []), ...(Array.isArray(field.tables) ? field.tables : [])];
  const displayedColumns = table => table.columns.map((label, index) => ({ label, index })).filter(column => !["configuration", "source configuration"].includes(String(column.label).trim().replace(/\s+/g, " ").toLowerCase()));
  const validFieldTable = table => table && Array.isArray(table.columns) && Array.isArray(table.rows) && table.rows.every(Array.isArray);
  // Encode every code point so imported labels/IDs cannot create selectors or fragment URLs.
  const anchorPart = value => Array.from(String(value), char => char.codePointAt(0).toString(16)).join("-");
  const tableAnchor = (kind, id, label, index) => `library-table-${kind}-${anchorPart(id)}-${anchorPart(label)}-${index}`;
  function fieldTable(field, index = 0, total = 1, kind = "technical") {
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
    for (const { label } of columns) { const cell = node("th", "", label); cell.setAttribute("scope", "col"); headings.append(cell); }
    head.append(headings);
    for (const values of field.table.rows) { const row = node("tr"); row.append(...columns.map(column => node("td", "", values[column.index]))); body.append(row); }
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
    const nav = node("nav", "library-detail-navigation"); nav.setAttribute("aria-label", "Library record navigation");
    const results = symbolButton("←", "Back to results", () => { state.history = []; showList(pane); pane.searchInput.focus(); }); results.dataset.libraryBackToResults = pane.kind; nav.append(results);
    if (state.history.length) { const previous = button("Back to previous item", back); previous.dataset.libraryBack = pane.kind; nav.append(previous); }
    return nav;
  }
  function renderDetail(pane) {
    const data = pane.detail, heading = node("h3", "", data.title || data.id);
    // Legacy Firefly report imports predate the Manufacturer field.
    const firefly = /^fas19023[456]-/i.test(String(data.id)) || (data.fields || []).some(field => String(field.label).trim().toLowerCase() === "manufacturer" && /\bfirefly\b/i.test(String(field.value)));
    heading.id = `${pane.kind}-library-detail-heading`; heading.tabIndex = -1; pane.detailPanel.setAttribute("aria-labelledby", heading.id);
    for (const key of pane.quantityBadges.keys()) if (key.startsWith("detail:")) pane.quantityBadges.delete(key);
    const title = pane.kind === "penetration" ? node("div", "library-record-heading") : heading;
    if (pane.kind === "penetration") title.append(heading, quantityBadge(pane, data.id, "detail"));
    const content = [detailNavigation(pane), title];
    if (data.subtitle) content.push(node("p", "library-subtitle", data.subtitle));
    for (const key of pane.scheduleButtons.keys()) if (key.startsWith("detail:")) { pane.scheduleButtons.delete(key); pane.actionMessages.delete(key); }
    for (const key of pane.deleteButtons.keys()) if (key.startsWith("detail:")) pane.deleteButtons.delete(key);
    pane.unlinkButtons.clear();
    if (data.price || pane.kind === "penetration") {
      const commercial = node("div", "library-record-commercial");
      if (data.price) commercial.append(node("p", "library-record-price", `${priceLabel(data.price)}: ${priceText(data.price)}`));
      if (pane.kind === "penetration") commercial.append(itemActions(pane, data, "detail"));
      content.push(commercial);
    }
    if (data.notice) content.push(node("p", "library-record-notice", data.notice));
    const fields = node("dl", "library-record-fields");
    const visibleFields = (data.fields || []).filter(field => visibleField(pane.kind, field));
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
      const images = (field.images || []).filter(item => validAssetId(item.id));
      const tables = tablesByField.get(field).filter(Boolean), links = configurationLinks(field, configurationTargets);
      const imageOnly = firefly && field.label === "Diagrams & Figures";
      if (imageOnly && !images.length) continue;
      const formatted = field.label === "Installation Details" || firefly && ["Service Wrap", configurationField].includes(field.label);
      if (pane.kind === "technical" && !images.length && !tables.length && !links.length && String(field.value ?? "").trim() === "") continue;
      if (formatted) {
        const blocks = window.LibraryDetailText.render(document, field.value ?? "");
        if (blocks.length) { const prose = node("div", "library-detail-text"); prose.append(...blocks); value.append(prose); }
        else if (!images.length && !tables.length && !links.length) continue;
      } else if (!imageOnly && (!images.length && !tables.length && !links.length || field.value !== null && field.value !== undefined && field.value !== "")) value.textContent = valueText(field.value);
      if (pane.kind === "technical" && field.label === "Diagrams & Figures" && data.diagram_status) {
        value.append(node("p", "helper library-diagram-status", data.diagram_status)); diagramStatusShown = true;
      }
      if (tables.length) { pair.className += " library-record-field-table"; value.append(...tables); }
      if (links.length) { const navigation = node("div", "library-table-links"); navigation.append(...links); value.append(navigation); }
      if (images.length) { const gallery = node("div", "library-images library-field-images"); gallery.append(...images.map(item => imageNode(item, pane.kind, imageOnly))); value.append(gallery); }
      pair.append(node("dt", "", fieldLabel(pane.kind, field.label) || "Field"), value); fields.append(pair);
    }
    content.push(fields);
    if (pane.kind === "technical" && data.diagram_status && !diagramStatusShown) content.push(node("p", "helper library-diagram-status", data.diagram_status));
    const images = data.diagram?.custom && validDiagramUrl(data.diagram.url)
      ? [{ url: data.diagram.url, caption: "Source diagram" }]
      : (data.images || []).filter(item => validAssetId(item.id));
    if (images.length) { const gallery = node("section", "library-images"); gallery.setAttribute("aria-label", "Source diagrams"); gallery.append(...images.map(item => imageNode(item, pane.kind))); content.push(gallery); }
    const related = node("section", "library-detail-section"), links = data.links || [];
    related.append(node("h4", "", pane.kind === "penetration" ? "Related technical references" : "Related firestopping records"));
    if (!links.length) related.append(node("p", "helper", "No related records are recorded."));
    for (const link of links) {
      const box = node("div", "library-related-record"), details = node("div", "library-related-content");
      if (kinds.includes(link.kind) && validId(link.id)) { const action = button(link.title || link.id, () => navigate(link.kind, link.id), "library-record-link"); action.dataset.libraryRelated = link.id; details.append(action); }
      else details.append(node("p", "", link.title || "Reference unavailable"));
      if (link.relationship) details.append(node("p", "helper", link.relationship));
      if (link.notice) details.append(node("p", "library-related-notice", link.notice));
      const penetrationId = pane.kind === "penetration" ? data.id : link.id, technicalId = pane.kind === "technical" ? data.id : link.id, key = `${penetrationId}:${technicalId}`;
      const label = pane.kind === "penetration" ? `Unlink technical reference ${link.title || link.id}` : `Unlink firestopping record ${link.title || link.id}`;
      const remove = symbolButton("🗑", label, () => unlinkReference(pane, data, link)); remove.className += " library-unlink"; remove.dataset.libraryUnlink = key; remove.disabled = pane.unlinkPending.has(key); pane.unlinkButtons.set(`${data.id}:${key}`, remove);
      box.append(details, remove);
      related.append(box);
    }
    content.push(related);
    if (pane.kind === "technical") {
      const sources = node("section", "library-detail-section"); sources.append(node("h4", "", "Source information"));
      sources.append(...(data.sources?.length ? data.sources.map(sourceNode) : [node("p", "helper", "No source reference is recorded for this item.")])); content.push(sources);
    }
    // Item qualifications belong in the card that receives navigation focus;
    // keep only the general library notices above that card.
    pane.detailPanel.replaceChildren(...content); updateNotice(pane, {});
    if (state.current === pane.kind && $("library-" + pane.kind)?.hidden === false && $("view-pricing")?.hidden === false) {
      heading.focus({ preventScroll: true }); pane.detailPanel.scrollIntoView?.({ block: "start" });
    }
  }
  async function loadDetail(pane, id) {
    clearTimeout(pane.timer); invalidateList(pane);
    pane.selected = id; pane.detailAbort?.abort(); const revision = ++pane.detailRevision;
    pane.detailAbort = new AbortController(); pane.list.hidden = true; pane.detailPanel.hidden = false; message(pane);
    pane.detailPanel.replaceChildren(detailNavigation(pane), node("p", "empty-state", "Loading record…")); pane.detailPanel.setAttribute("aria-busy", "true");
    try {
      const data = await request(`/api/libraries/${pane.kind}/${encodeURIComponent(id)}`, pane.detailAbort.signal);
      if (revision !== pane.detailRevision || id !== pane.selected) return;
      pane.detail = data; renderDetail(pane);
    } catch (error) {
      if (revision !== pane.detailRevision || error.name === "AbortError") return;
      pane.detailPanel.replaceChildren(detailNavigation(pane), node("p", "message error", error.message), button("Retry record", () => loadDetail(pane, id)));
    } finally { if (revision === pane.detailRevision) pane.detailPanel.setAttribute("aria-busy", "false"); }
  }
  async function open(kind, selection) {
    if (!kinds.includes(kind)) return;
    for (const existing of state.panes.values()) closeLinkPicker(existing);
    state.current = kind; const pane = paneFor(kind), revision = ++pane.openRevision;
    try {
      pane.count.textContent ||= "Loading library…";
      const data = await metadata();
      if (revision !== pane.openRevision) return;
      const info = data.libraries?.find(library => library.id === kind); updateNotice(pane); renderSummary(pane);
      if (info?.available === false) {
        pane.data = null;
        pane.list.hidden = false; pane.detailPanel.hidden = true; pane.count.textContent = "Library unavailable.";
        pane.results.replaceChildren(node("p", "empty-state", info.notice || "The local source library is unavailable.")); setBusy(pane, false); return;
      }
      if (selection?.list) await showList(pane);
      else if (validId(selection)) await loadDetail(pane, selection);
      else if (pane.selected) { if (pane.detail) renderDetail(pane); else await loadDetail(pane, pane.selected); }
      else { pane.list.hidden = false; pane.detailPanel.hidden = true; if (!pane.data || pane.dataQuery !== queryFor(pane)) await loadList(pane); }
    } catch (error) {
      if (revision !== pane.openRevision) return;
      pane.count.textContent = "Library unavailable."; message(pane, `${error.message} Use Refresh to try again.`, true);
    }
  }
  async function refresh(pane) {
    invalidateList(pane); pane.data = null; pane.detail = null; pane.filterStamp = null;
    state.metadata = null; state.metadataRequest = null; await open(pane.kind, pane.selected || { list: true });
  }
  function invalidate() {
    state.metadata = null; state.metadataRequest = null;
    for (const pane of state.panes.values()) { invalidateList(pane); ++pane.detailRevision; pane.detailAbort?.abort(); pane.data = null; pane.dataQuery = null; pane.detail = null; }
  }
  window.CeasefireLibraries = { open, invalidate, scheduleChanged };
})();
