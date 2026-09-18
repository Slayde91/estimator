(() => {
  "use strict";
  const kinds = ["penetration", "technical"], titles = { penetration: "Firestopping Library", technical: "Technical Library" };
  const state = { current: null, metadata: null, metadataRequest: null, panes: new Map(), history: [] };
  const $ = id => document.getElementById(id);
  const node = (tag, className = "", text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const priceText = price => typeof price?.amount === "number" && Number.isFinite(price.amount) ? money.format(price.amount) : "Price unavailable";
  const validId = value => typeof value === "string" && value.length > 0;
  const validAssetId = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const integer = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const valueText = value => value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const button = (text, action, className = "button secondary") => { const el = node("button", className, text); el.type = "button"; el.addEventListener("click", action); return el; };
  async function request(path, signal) {
    const response = await fetch(path, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
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
      listRevision: 0, detailRevision: 0, openRevision: 0, listAbort: null, detailAbort: null, timer: null, filterStamp: null, busy: false };
    const root = $(kind + "-library-workspace");
    pane.message = node("div", "message"); pane.message.hidden = true; pane.message.setAttribute("role", "status");
    pane.notice = node("p", "helper library-notice"); pane.notice.hidden = true;
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
    root.replaceChildren(pane.message, pane.notice, pane.list, pane.detailPanel);
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
    const safeFilters = (Array.isArray(filters) ? filters : []).filter(filter => typeof filter.key === "string" && !["search", "offset", "limit"].includes(filter.key));
    const stamp = JSON.stringify([safeFilters, pane.filters]); if (stamp === pane.filterStamp) return;
    pane.filterStamp = stamp;
    pane.filterControls.replaceChildren(...safeFilters.map(filter => {
      const label = node("label", "field"), control = node("select"), all = node("option", "", `All ${filter.label || filter.key}`); all.value = "";
      control.dataset.libraryFilter = filter.key; control.append(all);
      for (const option of filter.options || []) {
        const value = typeof option === "object" ? option.value : option, text = typeof option === "object" ? option.label : option;
        const el = node("option", "", text ?? value); el.value = String(value); control.append(el);
      }
      const selected = pane.filters[filter.key] || "";
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
    pane.results.replaceChildren(...(items.length ? items.map(item => {
      const card = node("article", "library-result"), title = button(item.title || item.id, () => navigate(pane.kind, item.id), "library-record-link");
      title.dataset.libraryRecord = item.id; card.append(title);
      if (item.subtitle) card.append(node("p", "library-subtitle", item.subtitle));
      if (item.price) card.append(node("p", "library-record-price", `${item.price.label || "Library price"}: ${priceText(item.price)}`));
      if (item.summary) card.append(node("p", "library-excerpt", valueText(item.summary)));
      if (item.source_label) card.append(node("p", "helper", item.source_label));
      if (Number.isSafeInteger(item.related_count)) card.append(node("p", "helper", `${item.related_count} related ${pane.kind === "penetration" ? "technical references" : "firestopping records"}`));
      if (pane.kind === "penetration" && item.editable) { const edit = button("Edit Library Item", () => editItem(pane, item.id)); edit.dataset.libraryEdit = item.id; card.append(edit); }
      return card;
    }) : [node("p", "empty-state", "Try a different search or filter.")]));
    renderFilters(pane, data.filters || libraryInfo(pane)?.filters || []); setBusy(pane, false);
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
    ++pane.detailRevision; pane.detailAbort?.abort(); pane.selected = null; pane.detail = null;
    pane.detailPanel.hidden = true; pane.list.hidden = false; message(pane); updateNotice(pane);
    if (!pane.data || pane.dataQuery !== queryFor(pane)) return loadList(pane);
    renderFilters(pane, pane.data.filters || libraryInfo(pane)?.filters || []); setBusy(pane, false);
  }
  function sourceNode(source) {
    const box = node("article", "library-source"), heading = source.label || source.filename || "Source reference";
    box.append(node("h4", "", heading));
    const fields = [["File", source.filename], ["Revision", source.revision], ["Sheet", source.sheet], ["Row", source.row], ["Page", source.page]].filter(([,value]) => value !== undefined && value !== null && value !== "");
    const dl = node("dl", "library-source-fields");
    for (const [label, value] of fields) { const line = node("div"); line.append(node("dt", "", label), node("dd", "", valueText(value))); dl.append(line); }
    box.append(dl);
    if (validAssetId(source.document_id)) {
      const page = Number.isSafeInteger(source.page) && source.page > 0 ? source.page : null;
      const link = node("a", "button secondary", page ? `Open PDF at page ${page}` : "Open source PDF");
      link.href = `/api/libraries/documents/${encodeURIComponent(source.document_id)}.pdf${page ? `#page=${page}` : ""}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${page ? `Open page ${page} of` : "Open"} ${source.filename || heading} (new tab)`); box.append(link);
    }
    if (source.sha256) { const audit = node("details", "library-source-audit"); audit.append(node("summary", "", "Source fingerprint"), node("code", "", source.sha256)); box.append(audit); }
    return box;
  }
  function imageNode(item) {
    const figure = node("figure", "library-image"), link = node("a"), image = node("img");
    const caption = item.caption || "Source diagram";
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
    if (data.price || pane.kind === "penetration" && data.editable) {
      const commercial = node("div", "library-record-commercial");
      if (data.price) commercial.append(node("p", "library-record-price", `${data.price.label || "Library price"}: ${priceText(data.price)}`));
      if (pane.kind === "penetration" && data.editable) { const edit = button("Edit Library Item", () => editItem(pane, data.id)); edit.dataset.libraryEdit = data.id; commercial.append(edit); }
      content.push(commercial);
    }
    if (data.notice) content.push(node("p", "library-record-notice", data.notice));
    const fields = node("dl", "library-record-fields");
    for (const field of data.fields || []) {
      const pair = node("div", "library-record-field"), value = node("dd");
      const images = (field.images || []).filter(item => validAssetId(item.id));
      const table = field.table && Array.isArray(field.table.columns) && Array.isArray(field.table.rows);
      if (!images.length && !table || field.value !== null && field.value !== undefined && field.value !== "") value.textContent = valueText(field.value);
      if (table) { pair.className += " library-record-field-table"; value.append(fieldTable(field)); }
      if (images.length) { const gallery = node("div", "library-images library-field-images"); gallery.append(...images.map(imageNode)); value.append(gallery); }
      pair.append(node("dt", "", field.label || "Field"), value); fields.append(pair);
    }
    const sources = node("section", "library-detail-section"); sources.append(node("h4", "", "Source information"));
    sources.append(...(data.sources?.length ? data.sources.map(sourceNode) : [node("p", "helper", "No source reference is recorded for this item.")]));
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
    content.push(related, sources, fields);
    const images = (data.images || []).filter(item => validAssetId(item.id));
    if (images.length) { const gallery = node("section", "library-images"); gallery.setAttribute("aria-label", "Source diagrams"); gallery.append(...images.map(imageNode)); content.push(gallery); }
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
    state.current = kind; const pane = paneFor(kind), revision = ++pane.openRevision;
    try {
      pane.count.textContent ||= "Loading library…";
      const data = await metadata();
      if (revision !== pane.openRevision) return;
      const info = data.libraries?.find(library => library.id === kind); updateNotice(pane);
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
    for (const pane of state.panes.values()) { invalidateList(pane); ++pane.detailRevision; pane.detailAbort?.abort(); pane.data = null; pane.dataQuery = null; pane.detail = null; }
  }
  window.CeasefireLibraries = { open, invalidate };
})();
