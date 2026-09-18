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
  const hiddenTechnicalFields = new Set(["source table notes", "source option alignment"]);
  const visibleField = (kind, field) => { const label = String(field.label || "").trim().toLowerCase(); return !hiddenFields.has(label) && !(kind === "technical" && hiddenTechnicalFields.has(label)); };
  const fieldLabel = (kind, label) => kind !== "penetration" ? label : label === "Item(s)" ? "Items/Services" : ["System", "System Install", "System/Install"].includes(label) ? "System/Install Details" : label;
  const diagramCaption = (kind, caption) => (kind === "penetration" ? String(caption || "").replace(/(?:^|\s+|\s*[·|—–-]\s*)(?:'?CALC'?!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|CALC\s+row\s+\d+)\s*$/i, "").trim() : caption) || "Source diagram";
  const validId = value => typeof value === "string" && value.length > 0;
  const validAssetId = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const integer = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const valueText = value => value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const button = (text, action, className = "button secondary") => { const el = node("button", className, text); el.type = "button"; el.addEventListener("click", action); return el; };
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
      linkSession: null, addPending: new Map(), addErrors: new Map(), scheduleButtons: new Map(), actionMessages: new Map() };
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
    pane.refresh = button("Refresh", () => refresh(pane)); pane.refresh.dataset.libraryRefresh = kind;
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
    pane.results.replaceChildren(...(items.length ? items.map(item => {
      const card = node("article", "library-result"), title = button(item.title || item.id, () => navigate(pane.kind, item.id), "library-record-link");
      title.dataset.libraryRecord = item.id; card.append(title);
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
    const info = libraryInfo(pane), counts = pane.data?.counts, values = [counts?.total ?? info?.count, counts?.unlinked ?? info?.unlinked_count];
    const table = node("table", "library-summary-table"), head = node("thead"), row = node("tr"), body = node("tbody"), totals = node("tr");
    table.append(node("caption", "", "Firestopping Library summary"));
    for (const label of ["Total records", "No related technical references"]) { const cell = node("th", "", label); cell.setAttribute("scope", "col"); row.append(cell); }
    for (const value of values) totals.append(node("td", "", Number.isSafeInteger(value) && value >= 0 ? value : "—"));
    head.append(row); body.append(totals); table.append(head, body); pane.summary.replaceChildren(table); pane.summary.hidden = false;
  }
  function actionContext(pane) { return JSON.stringify([state.current, pane.openRevision, pane.selected, pane.search, pane.filters, pane.offset]); }
  function itemActions(pane, item, place) {
    const actions = node("div", "library-item-actions");
    if (item.editable) { const edit = button("Edit Library Item", () => editItem(pane, item.id)); edit.dataset.libraryEdit = item.id; actions.append(edit); }
    const link = button("Link Library Item", () => openLinkPicker(pane, item, link)); link.dataset.libraryLink = item.id;
    const add = button("Add to Schedule", () => addToSchedule(pane, item.id), "button primary"); add.dataset.libraryAdd = item.id; add.title = "Uses current schedule prices and allowances.";
    const status = node("p", "message error library-action-message", pane.addErrors.get(item.id) || ""); status.hidden = !status.textContent; status.setAttribute("role", "status");
    add.disabled = pane.addPending.has(item.id); pane.scheduleButtons.set(`${place}:${item.id}`, add); pane.actionMessages.set(`${place}:${item.id}`, status); actions.append(link, add, status); return actions;
  }
  async function addToSchedule(pane, id) {
    if (pane.addPending.has(id)) return;
    const token = {}, context = actionContext(pane); pane.addPending.set(id, token); pane.addErrors.delete(id); message(pane);
    for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { status.textContent = ""; status.hidden = true; }
    for (const control of pane.scheduleButtons.values()) if (control.dataset.libraryAdd === id) control.disabled = true;
    try { await window.CeasefirePenetrations.addLibraryItem(id); }
    catch (error) {
      if (context === actionContext(pane)) {
        const text = `The library item could not be added to the schedule. ${error.message}`; pane.addErrors.set(id, text);
        for (const [key, status] of pane.actionMessages) if (key === `list:${id}` || key === `detail:${id}`) { status.textContent = text; status.hidden = false; }
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
  function openLinkPicker(pane, item, opener) {
    closeLinkPicker(pane); invalidateList(pane); message(pane);
    const session = { id: item.id, search: "", offset: 0, limit: 20, total: 0, selected: null, revision: 0, abort: null, timer: null, busy: false, saving: false, choices: [] };
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
    session.save = button("Save link", () => saveLink(pane, session), "button primary"); session.save.dataset.libraryLinkSave = ""; session.save.disabled = true;
    const pages = node("nav", "library-pagination"); pages.setAttribute("aria-label", "Technical reference choices"); pages.append(session.previous, session.next);
    const actions = node("div", "library-item-actions"); actions.append(session.save, cancel);
    pane.linkPanel.replaceChildren(heading, node("p", "library-subtitle", item.title || item.id), node("p", "helper", "Choose a Technical Library item to link."), controls, session.message, session.count, session.results, pages, actions);
    session.searchInput.addEventListener("input", () => {
      if (session.saving || pane.linkSession !== session) return;
      session.search = session.searchInput.value.trim(); session.offset = 0; session.selected = null; session.busy = true; ++session.revision; session.abort?.abort(); clearTimeout(session.timer); session.save.disabled = session.previous.disabled = session.next.disabled = true; session.count.textContent = "Searching…";
      session.timer = setTimeout(() => loadLinkResults(pane, session), 250);
    });
    heading.focus({ preventScroll: true }); pane.linkPanel.scrollIntoView?.({ block: "start" }); loadLinkResults(pane, session);
  }
  async function loadLinkResults(pane, session) {
    if (pane.linkSession !== session || session.saving) return;
    clearTimeout(session.timer); session.abort?.abort(); session.abort = new AbortController(); const revision = ++session.revision;
    session.busy = true; session.selected = null; session.save.disabled = session.previous.disabled = session.next.disabled = true;
    session.choices = []; session.results.replaceChildren(); session.results.setAttribute("aria-busy", "true"); session.count.textContent = "Searching…"; linkMessage(session);
    const query = new URLSearchParams({ search: session.search, offset: String(session.offset), limit: String(session.limit) });
    try {
      const data = await request(`/api/libraries/technical?${query}`, session.abort.signal);
      if (pane.linkSession !== session || revision !== session.revision) return;
      session.total = integer(data.total); session.offset = integer(data.offset, session.offset);
      const items = Array.isArray(data.items) ? data.items : [];
      session.count.textContent = session.total ? `Showing ${session.offset + 1}–${session.offset + items.length} of ${session.total} technical records` : "No matching technical records.";
      session.results.replaceChildren(...items.map(item => {
        const choice = node("label", "library-link-choice"), input = node("input"), description = node("span"); input.type = "radio"; input.name = "library-technical-choice"; input.value = item.id; input.dataset.libraryLinkChoice = item.id;
        description.append(node("strong", "", item.title || item.id)); if (item.subtitle) description.append(node("span", "helper", item.subtitle)); if (item.source_label) description.append(node("span", "helper", item.source_label));
        input.addEventListener("change", () => { if (pane.linkSession !== session || session.busy || session.saving) return; session.selected = item.id; session.save.disabled = false; }); session.choices.push(input); choice.append(input, description); return choice;
      }));
    } catch (error) { if (pane.linkSession === session && revision === session.revision && error.name !== "AbortError") { session.total = 0; session.count.textContent = "Technical records unavailable."; linkMessage(session, `${error.message} Use Search to retry.`, true); } }
    finally {
      if (pane.linkSession === session && revision === session.revision) { session.busy = false; session.results.setAttribute("aria-busy", "false"); session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
    }
  }
  async function saveLink(pane, session) {
    if (pane.linkSession !== session || session.saving || session.busy || !session.selected) return;
    const technicalId = session.selected; session.saving = true; session.save.disabled = session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = session.previous.disabled = session.next.disabled = true; linkMessage(session, "Saving link…");
    for (const choice of session.choices) choice.disabled = true;
    try {
      const receipt = await request(`/api/libraries/penetration/${encodeURIComponent(session.id)}/links`, null, { technical_id: technicalId });
      if (receipt.linked !== true || receipt.penetration_id !== session.id || receipt.technical_id !== technicalId) throw new Error("The server did not confirm the saved reference link.");
      invalidate();
      if (pane.linkSession !== session || state.current !== pane.kind) return;
      closeLinkPicker(pane); const revision = pane.openRevision + 1; await open(pane.kind, pane.selected || { list: true });
      if (state.current === pane.kind && pane.openRevision === revision) message(pane, receipt.created === false ? "This technical reference is already linked." : "Technical reference linked.");
    } catch (error) { if (pane.linkSession === session) linkMessage(session, `Saving the reference link was not confirmed. ${error.message} Retry to check the same link.`, true); }
    finally {
      if (pane.linkSession === session) { session.saving = false; session.save.disabled = !session.selected; session.cancel.disabled = session.searchInput.disabled = session.refresh.disabled = false; for (const choice of session.choices) choice.disabled = false; session.previous.disabled = session.offset === 0; session.next.disabled = session.offset + session.limit >= session.total; }
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
  function imageNode(item, kind) {
    const figure = node("figure", "library-image"), link = node("a"), image = node("img");
    const caption = diagramCaption(kind, item.caption);
    link.href = `/api/libraries/images/${encodeURIComponent(item.id)}`; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open ${caption} at full size (new tab)`);
    image.src = link.href; image.alt = caption; image.loading = "lazy"; image.decoding = "async";
    link.append(image); figure.append(link, node("figcaption", "helper", caption)); return figure;
  }
  function fieldTable(field) {
    const scroll = node("div", "library-field-table-scroll"), table = node("table", "library-field-table"), head = node("thead"), headings = node("tr"), body = node("tbody");
    scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", `${field.label || "Source"} table`);
    table.setAttribute("aria-label", field.label || "Source table");
    for (const label of field.table.columns) { const cell = node("th", "", label); cell.setAttribute("scope", "col"); headings.append(cell); }
    head.append(headings);
    for (const values of field.table.rows) { const row = node("tr"); row.append(...values.map(value => node("td", "", value))); body.append(row); }
    table.append(head, body); scroll.append(table); return scroll;
  }
  function detailNavigation(pane) {
    const nav = node("nav", "library-detail-navigation"); nav.setAttribute("aria-label", "Library record navigation");
    const results = button("Back to results", () => { state.history = []; showList(pane); pane.searchInput.focus(); }); results.dataset.libraryBackToResults = pane.kind; nav.append(results);
    if (state.history.length) { const previous = button("Back to previous item", back); previous.dataset.libraryBack = pane.kind; nav.append(previous); }
    return nav;
  }
  function renderDetail(pane) {
    const data = pane.detail, heading = node("h3", "", data.title || data.id);
    heading.id = `${pane.kind}-library-detail-heading`; heading.tabIndex = -1; pane.detailPanel.setAttribute("aria-labelledby", heading.id);
    const content = [detailNavigation(pane), heading];
    if (data.subtitle) content.push(node("p", "library-subtitle", data.subtitle));
    for (const key of pane.scheduleButtons.keys()) if (key.startsWith("detail:")) { pane.scheduleButtons.delete(key); pane.actionMessages.delete(key); }
    if (data.price || pane.kind === "penetration") {
      const commercial = node("div", "library-record-commercial");
      if (data.price) commercial.append(node("p", "library-record-price", `${priceLabel(data.price)}: ${priceText(data.price)}`));
      if (pane.kind === "penetration") commercial.append(itemActions(pane, data, "detail"));
      content.push(commercial);
    }
    if (data.notice) content.push(node("p", "library-record-notice", data.notice));
    const fields = node("dl", "library-record-fields");
    for (const field of data.fields || []) {
      if (!visibleField(pane.kind, field)) continue;
      const pair = node("div", "library-record-field"), value = node("dd");
      const images = (field.images || []).filter(item => validAssetId(item.id));
      const table = field.table && Array.isArray(field.table.columns) && Array.isArray(field.table.rows);
      if (!images.length && !table || field.value !== null && field.value !== undefined && field.value !== "") value.textContent = valueText(field.value);
      if (table) { pair.className += " library-record-field-table"; value.append(fieldTable(field)); }
      if (images.length) { const gallery = node("div", "library-images library-field-images"); gallery.append(...images.map(item => imageNode(item, pane.kind))); value.append(gallery); }
      pair.append(node("dt", "", fieldLabel(pane.kind, field.label) || "Field"), value); fields.append(pair);
    }
    const related = node("section", "library-detail-section"), links = data.links || [];
    related.append(node("h4", "", pane.kind === "penetration" ? "Related technical references" : "Related firestopping records"));
    if (!links.length) related.append(node("p", "helper", "No related records are recorded."));
    for (const link of links) {
      const box = node("div", "library-related-record");
      if (kinds.includes(link.kind) && validId(link.id)) { const action = button(link.title || link.id, () => navigate(link.kind, link.id), "library-record-link"); action.dataset.libraryRelated = link.id; box.append(action); }
      else box.append(node("p", "", link.title || "Reference unavailable"));
      if (link.relationship) box.append(node("p", "helper", link.relationship));
      if (link.notice) box.append(node("p", "library-related-notice", link.notice));
      related.append(box);
    }
    content.push(related);
    if (pane.kind === "technical") {
      const sources = node("section", "library-detail-section"); sources.append(node("h4", "", "Source information"));
      sources.append(...(data.sources?.length ? data.sources.map(sourceNode) : [node("p", "helper", "No source reference is recorded for this item.")])); content.push(sources);
    }
    content.push(fields);
    const images = (data.images || []).filter(item => validAssetId(item.id));
    if (images.length) { const gallery = node("section", "library-images"); gallery.setAttribute("aria-label", "Source diagrams"); gallery.append(...images.map(item => imageNode(item, pane.kind))); content.push(gallery); }
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
  window.CeasefireLibraries = { open, invalidate };
})();
